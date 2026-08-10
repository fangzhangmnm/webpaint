// RenderTree —— render-plan 的 GL 执行器，单一职责 = tree composite（T6 拆自 RenderTreeGL；
// 一次性算像素的兄弟 facade = raster-service.ts，两者共享同一 GlRoom——机房五件套 + 叶驻留 + 装置）。
//
// 帧算法：
//   1. frameMaintain（孤儿 gpu tile 回收）→ pseudo 装置（floats/overlay）→ updated 集。
//   2. 快路径：无 dirty 无动态且 display 缓存 + plan 签名没变 → 只 present（pan/zoom 帧）。
//   3. dirty → 段缓存全失效（undo/redo/commit → 重算树，spec:134）+ 删层对账 + bridge purge。
//   4. buildPlan → 缺的段：sync 成员 → 现算 → copyTexSubImage3D 切 tile 入池（零 readback）。
//   5. sync live 叶（bridge 按 tile 身份增量；surrogate 叶从替身 canvas 换源）→ 合成 rootSteps
//      → display FBO → presentAffine。
//   自愈：gpu tile 被 evict/context-loss = 日常事件（spec:156）——sync/段校验按 isAlive 走，
//   死了就地重建；**LAYER_NOT_SYNCED 异常从此不存在**（test-charter H2 病根，sync 是帧内保证）。
//
// pseudo-layer 统一（spec:127-129）：surrogate（换 tile 源）/ float（源层 z 上浮层 pass）/
//   overlay（烤进叶 pass）三个旧 ad-hoc 注入口 → planner 输入的三面旗。

import { IndexTexture } from "./gpu-tile-pool.ts";
import { TILE_SIZE, tilesAcross, tilesDown, tileCoord } from "../common/tile-geometry.ts";
import type { Background } from "./gl-compositor.ts";
import type { DocNode, DocLeaf } from "./gl-doc-bridge.ts";
import { buildPlan } from "../render/render-plan.ts";
import type { Plan, PlanStep, SegBuild, BgKind } from "../render/render-plan.ts";
import type { PooledFBO } from "../common/gl2-port.ts";
import type { GlRoom, FloatInput, OverlayInput, SurrogateInput } from "./gl-room.ts";

// 段缓存：合成结果切 tile + 寻址（内容 straight，与叶同一条 sampleTiled 路径）。
interface SegEntry { byKey: Map<number, number>; index: IndexTexture; gen: number }

export class RenderTree {
  private _room: GlRoom;

  private _segCache = new Map<string, SegEntry>();
  private _display: PooledFBO | null = null;      // 上帧合成结果（视口无关）→ pan/zoom 只 present
  private _displaySig: string | null = null;
  private _dirty = true;                          // markDirty（commit/undo/结构变）→ 段全失效
  private _lastDocW = -1; private _lastDocH = -1;
  private _lastPlan: Plan | null = null;

  // 帧统计（HUD）：segBuilds/segHits = 段现算/命中数；passes 从 compositor 读。
  readonly frameStats = { segBuilds: 0, segHits: 0, cachingDegraded: false };

  constructor(room: GlRoom) {
    this._room = room;
    // RasterService 落了新像素（bakeStamps）→ 重算树（room 信号，facade 互不知晓）。
    room.onInvalidate(() => { this._dirty = true; });
    // pin 两档：required = live 叶 + 现役段；preferred = 其余已驻留叶 tile（压力下才让位）。
    room.pool.registerPinProvider(() => {
      const required = new Set<number>();
      const preferred = new Set<number>();
      const live = this._lastPlan?.liveLeaves;
      for (const [id, rec] of room.leaves) {
        const tier = live?.has(id) ? required : preferred;
        for (const g of rec.byKey.values()) tier.add(g);
      }
      for (const [key, seg] of this._segCache) {
        if (!this._lastPlan || this._lastPlan.cacheKeys.has(key)) for (const g of seg.byKey.values()) required.add(g);
      }
      return { required, preferred };
    });
  }

  // ---- 外部信号 ----
  markDirty(): void { this._dirty = true; }

  handleContextRestored(): void {
    this._room.handleContextRestored();
    this._segCache.clear();        // GL 句柄已随 context 死，弃引用
    this._display = null; this._displaySig = null;
    this._dirty = true;
  }

  // ---- 帧入口 ----
  renderFrame(
    nodes: DocNode[], docW: number, docH: number, bg: Background | undefined,
    affine6: number[], canvasW: number, canvasH: number, scale: number, voidRgb: [number, number, number],
    floats: FloatInput[], stampOverlay: OverlayInput | null, surrogate: SurrogateInput | null,
    liveSyncLeafId: number | null,
  ): void {
    const room = this._room;
    this.frameStats.segBuilds = 0; this.frameStats.segHits = 0; this.frameStats.cachingDegraded = false;
    // doc 尺寸变：FBO 池全清（旧尺寸永不再命中）+ 段/display/叶记录作废（index 尺寸不符会逐个重建，主动清更干净）。
    if (docW !== this._lastDocW || docH !== this._lastDocH) {
      if (this._display) { room.glctx.returnFBO(this._display); this._display = null; }
      room.glctx.clearPool();
      for (const rec of room.leaves.values()) rec.index.dispose();
      room.leaves.clear();
      this._invalidateSegs();
      this._displaySig = null;
      this._dirty = true;
      this._lastDocW = docW; this._lastDocH = docH;
    }
    room.pool.frameMaintain();

    // pseudo 装置
    room.setFloats(floats);
    if (stampOverlay) room.setStampOverlay(stampOverlay, docW, docH);
    else room.clearOverlay();

    const updated = new Set<number>();
    for (const f of floats) updated.add(f.layerId);
    if (stampOverlay) updated.add(stampOverlay.layerId);
    if (surrogate) updated.add(surrogate.layerId);
    if (liveSyncLeafId !== null) updated.add(liveSyncLeafId);

    const bgKind: BgKind = bg === "checker" ? "checker" : bg ? "color" : "none";
    const leafById = new Map<number, DocLeaf>();
    const planNodes = room.toPlanNodes(nodes, updated, stampOverlay?.layerId ?? null, leafById);
    const plan = buildPlan(planNodes, updated, bgKind);
    const sig = this._planSig(plan, docW, docH, bg);

    // 快路径：无 dirty 无动态、display 有效且签名没变 → 只 present（pan/zoom 帧）。
    if (!this._dirty && updated.size === 0 && this._display && this._displaySig === sig) {
      this._present(docW, docH, affine6, canvasW, canvasH, scale, voidRgb);
      return;
    }

    if (this._dirty) {
      this._invalidateSegs();                        // undo/redo/commit → 重算树（spec:134）
      // 删层对账：树上已不存在的叶丢记录（gpu tile 变孤儿，下帧 frameMaintain 回收）。
      for (const id of [...room.leaves.keys()]) if (!leafById.has(id)) { room.leaves.get(id)!.index.dispose(); room.leaves.delete(id); }
      room.bridge.purgeDead(room.cpuAlive());
      this._dirty = false;
    }
    this._lastPlan = plan;

    // 缺段判定 + 孤儿段回收（key 不在本分区 → 丢记录）。
    const missing: SegBuild[] = [];
    for (const key of plan.cacheKeys) {
      const seg = this._segCache.get(key);
      if (seg && this._segValid(seg)) { this.frameStats.segHits++; continue; }
      if (seg) { seg.index.dispose(); this._segCache.delete(key); }
      missing.push(plan.builds.get(key)!);
    }
    for (const key of [...this._segCache.keys()]) if (!plan.cacheKeys.has(key)) { this._segCache.get(key)!.index.dispose(); this._segCache.delete(key); }

    // 容量预检：live 叶 + 缺段覆盖（估算）。放不下 → 本帧不建段（segs 走临时 acc 直算，慢但对）。
    let needed = 0;
    for (const id of plan.liveLeaves) needed += leafById.get(id)?.pixels.tileCount ?? 0;
    const allTiles = tilesAcross(docW) * tilesDown(docH);
    for (const b of missing) needed += b.withBg ? allTiles : this._coverageEstimate(b, leafById);
    const cachingEnabled = room.pool.reserve(room.pool.allocatedCount + needed);
    this.frameStats.cachingDegraded = !cachingEnabled;

    // sync：live 叶 + （建段时）缺段成员。surrogate 叶从替身 canvas 换源。
    const toSync = new Set<number>(plan.liveLeaves);
    if (cachingEnabled) for (const b of missing) for (const id of b.members) toSync.add(id);
    for (const id of toSync) {
      if (surrogate && id === surrogate.layerId) { room.syncSurrogate(surrogate, docW, docH); continue; }
      const leaf = leafById.get(id);
      if (leaf) room.syncLeafSafe(id, leaf.pixels, docW, docH);
    }

    // 合成
    room.comp.begin(docW, docH);
    const transient = new Map<string, PooledFBO>();   // 建不了的段本帧的临时合成结果（复用，别重算）
    if (cachingEnabled) for (const b of missing) this._buildSeg(b, docW, docH, bg, transient);
    else for (const b of missing) transient.set(b.key, room.composeSegTransient(b, docW, docH, bg));
    const acc = room.comp.newAcc(docW, docH, plan.rootBgLive ? bg : undefined);
    room.composeSteps(plan.rootSteps, acc, docW, docH, transient, (key) => this._segCache.get(key)?.index);
    const fresh = room.comp.finishAcc(acc);
    for (const f of transient.values()) room.glctx.returnFBO(f);
    room.comp.end();
    room.releaseOverlayFBO();
    room.releaseLiveClip();

    if (this._display) room.glctx.returnFBO(this._display);
    this._display = fresh;
    this._displaySig = sig;
    this._present(docW, docH, affine6, canvasW, canvasH, scale, voidRgb);
  }

  // ---- 内部：签名 / 段有效性 ----
  private _planSig(plan: Plan, docW: number, docH: number, bg: Background | undefined): string {
    const steps = (ss: PlanStep[]): string => ss.map((s) =>
      s.t === "seg" ? `s(${s.key},${s.mode},${s.opacity},${s.clipBaseId})`
      : s.t === "leaf" ? `l(${s.id},${s.mode},${s.opacity},${s.clipBaseId},${s.overlay})`
      : s.t === "float" ? `f(${s.id})`
      : `g(${s.id},${s.mode},${s.opacity},${s.clipBaseId},[${steps(s.body)}])`).join("|");
    return `${docW}x${docH};bg=${JSON.stringify(bg)};${steps(plan.rootSteps)}`;
  }

  private _segValid(seg: SegEntry): boolean {
    if (seg.gen !== this._room.pool.generation) return false;
    for (const g of seg.byKey.values()) if (!this._room.pool.isAlive(g)) return false;
    return true;
  }

  private _invalidateSegs(): void {
    for (const seg of this._segCache.values()) seg.index.dispose();
    this._segCache.clear();
  }

  private _coverageEstimate(b: SegBuild, leafById: Map<number, DocLeaf>): number {
    let n = 0;
    for (const id of b.members) n += leafById.get(id)?.pixels.tileCount ?? 0;
    return n;
  }

  // ---- 内部：段建造 ----
  private _buildSeg(b: SegBuild, docW: number, docH: number, bg: Background | undefined, transient: Map<string, PooledFBO>): void {
    const room = this._room;
    const gl = room.glctx.gl;
    const res = room.composeSegTransient(b, docW, docH, bg);
    // coverage = 成员叶 tile 键并集；withBg（不透明底）= 全 doc tiles。
    const across = tilesAcross(docW), down = tilesDown(docH);
    const cover = new Set<number>();
    if (b.withBg) { for (let k = 0; k < across * down; k++) cover.add(k); }
    else for (const id of b.members) { const rec = room.leaves.get(id); if (rec) for (const k of rec.byKey.keys()) cover.add(k); }
    const keys = [...cover];
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, res.fbo);
      const gpuIds = room.pool.copyBatchFromFramebuffer(keys.map((k) => {
        const { tx, ty } = tileCoord(k, across);
        const x = tx * TILE_SIZE, y = ty * TILE_SIZE;
        return { srcX: x, srcY: y, w: Math.min(TILE_SIZE, docW - x), h: Math.min(TILE_SIZE, docH - y) };
      }));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const byKey = new Map<number, number>();
      keys.forEach((k, i) => byKey.set(k, gpuIds[i]));
      const index = new IndexTexture(room.glctx, docW, docH);
      index.rebuild(byKey, room.pool);
      this._segCache.set(b.key, { byKey, index, gen: room.pool.generation });
      this.frameStats.segBuilds++;
      room.glctx.returnFBO(res);
    } catch (e) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!(e instanceof Error) || !e.message.startsWith("GPU_POOL_EXHAUSTED")) { room.glctx.returnFBO(res); throw e; }
      transient.set(b.key, res);   // 入池失败 → 本帧当临时段用（compose 后归还），不缓存
    }
  }

  private _present(docW: number, docH: number, affine6: number[], canvasW: number, canvasH: number, scale: number, voidRgb: [number, number, number]): void {
    const gl = this._room.glctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.clearColor(voidRgb[0], voidRgb[1], voidRgb[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this._room.comp.presentToScreenAffine(this._display!.tex, docW, docH, affine6, canvasW, canvasH, scale < 1);
  }
}
