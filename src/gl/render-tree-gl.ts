// render-tree-gl —— render-plan 的 GL 执行器（S7b；spec :123-159 render-tree 的运行时）。
// 取代 GLDocRenderer（耦合结节，S7 亡）：doc 树 → PlanNode → buildPlan → 段缓存/直画 pass → present。
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

import { GpuTilePool, GLGpuTileBackend, IndexTexture, GPU_TILE_BYTES } from "./gpu-tile-pool.ts";
import { CpuGpuTileBridge } from "./tile-bridge.ts";
import { appTilePool } from "../tiles/app-tile-pool.ts";
import { TILE_SIZE, tilesAcross, tilesDown, tileCoord } from "../tiles/tile-geometry.ts";
import { GLCompositor } from "./gl-compositor.ts";
import type { Background, Acc, OverlayDesc, FloatDesc } from "./gl-compositor.ts";
import { safeMode } from "./gl-doc-bridge.ts";
import type { DocNode, DocLeaf } from "./gl-doc-bridge.ts";
import { LayerPixels, replaceFromCanvas } from "../tiles/tile-layer.ts";
import { GLStampRasterizer } from "./gl-stamp.ts";
import type { Stamp, StrokeShape } from "./gl-stamp.ts";
import { buildPlan } from "../render/render-plan.ts";
import type { Plan, PlanNode, PlanStep, SegBuild, BgKind } from "../render/render-plan.ts";
import type { PooledFBO, FBOPrec, GLContext } from "./gl-context.ts";
import type { BlendMode } from "./blend-glsl.ts";

// ---- board 输入（原 gl-doc-renderer 同名接口原样迁入） ----
export interface SurrogateInput { layerId: number; canvas: CanvasImageSource; bx: number; by: number; w: number; h: number; }

export interface FloatInput {
  layerId: number;
  srcCanvas: CanvasImageSource;   // 未 warp 源像素（稳定引用 → 复用 GPU 纹理）
  srcW: number; srcH: number;
  hinv: number[];                 // 9，row-major，doc→源单位方格
  mode: number;                   // 0=nearest 1=bilinear 2=bicubic
}

export interface StampOverlayInput {
  stamps: Stamp[]; shape: StrokeShape;
  bx: number; by: number; bw: number; bh: number;
  layerId: number; opacity: number; erase: boolean; blendMode: string;
  lockAlpha: boolean;
  selMask: { data: Uint8Array; ox: number; oy: number; ow: number; oh: number } | null;
}

// 每叶 GPU 驻留记录（7a 引入，原 gl-doc-renderer 迁入）。
interface LeafRec { index: IndexTexture; byKey: Map<number, number>; src: LayerPixels | null; cpuVersion: number; gen: number }
// 段缓存：合成结果切 tile + 寻址（内容 straight，与叶同一条 sampleTiled 路径）。
interface SegEntry { byKey: Map<number, number>; index: IndexTexture; gen: number }

export class RenderTreeGL {
  private _glctx: GLContext;
  private _backend: GLGpuTileBackend;
  private _pool: GpuTilePool;
  private _bridge: CpuGpuTileBridge;
  private _comp: GLCompositor;
  private _rasterizer: GLStampRasterizer;

  private _layerTiles = new Map<number, LeafRec>();
  private _segCache = new Map<string, SegEntry>();
  private _display: PooledFBO | null = null;      // 上帧合成结果（视口无关）→ pan/zoom 只 present
  private _displaySig: string | null = null;
  private _dirty = true;                          // markDirty（commit/undo/结构变）→ 段全失效
  private _lastDocW = -1; private _lastDocH = -1;
  private _lastPlan: Plan | null = null;

  // pseudo 装置（原 gl-doc-renderer 迁入）
  private _overlayOwnedFBO: PooledFBO | null = null;
  private _selTex: WebGLTexture | null = null;
  private _selTexSrc: Uint8Array | null = null;
  private _overlay: { tex: WebGLTexture; layerId: number; opacity: number; erase: boolean; blendMode: string; ox: number; oy: number; ow: number; oh: number; lockAlpha: boolean; selMask: { tex: WebGLTexture; ox: number; oy: number; ow: number; oh: number } | null } | null = null;
  private _floatTex = new Map<number, { tex: WebGLTexture; canvas: CanvasImageSource | null }>();
  private _floats = new Map<number, FloatDesc>();

  // 帧统计（HUD）：segBuilds/segHits = 段现算/命中数；passes 从 compositor 读。
  readonly frameStats = { segBuilds: 0, segHits: 0, cachingDegraded: false };

  constructor(glctx: GLContext, maxSlices: number, accumPrec: FBOPrec = "u8") {
    this._glctx = glctx;
    this._backend = new GLGpuTileBackend(glctx, Math.min(64, maxSlices));
    this._pool = new GpuTilePool(this._backend, maxSlices);
    this._bridge = new CpuGpuTileBridge(this._pool);
    this._comp = new GLCompositor(glctx, accumPrec);
    this._rasterizer = new GLStampRasterizer(glctx);
    // pin 两档：required = live 叶 + 现役段；preferred = 其余已驻留叶 tile（压力下才让位）。
    this._pool.registerPinProvider(() => {
      const required = new Set<number>();
      const preferred = new Set<number>();
      const live = this._lastPlan?.liveLeaves;
      for (const [id, rec] of this._layerTiles) {
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

  get memory(): { usedTiles: number; capacity: number; usedBytes: number; committedBytes: number; quotaBytes: number } {
    return {
      usedTiles: this._pool.allocatedCount, capacity: this._pool.capacity,
      usedBytes: this._pool.allocatedCount * GPU_TILE_BYTES,
      committedBytes: this._pool.committedBytes, quotaBytes: this._pool.quotaBytes,
    };
  }
  get stats(): { passes: number; floatPasses: number } { return this._comp.stats; }
  get fboPoolStats(): { count: number; bytes: number } { return this._glctx.fboPoolStats; }

  handleContextRestored(): void {
    this._pool.clearAll();
    this._bridge.clear();
    this._layerTiles.clear();      // GL 句柄已随 context 死，弃引用
    this._segCache.clear();
    this._display = null; this._displaySig = null;
    this._selTex = null; this._selTexSrc = null;
    this._floatTex.clear(); this._floats.clear();
    this._overlay = null; this._overlayOwnedFBO = null;
    this._dirty = true;
  }

  // ---- S8 brush commit（spec:199-205）：merge(base tiles ⊕ stroke) 复用 live 同一 overlay shader
  //   （SSOT：mode=source-over、opacity=1、透明底 → 输出恰为合成好的新图层数据）→ bbox 一次 readPixels
  //   → apply 回调（Layer.applyRegionDiff，只封真变 tile）→ 变更 tile 从 merged FBO 直拷入池 +
  //   registerPair + 叶记录就地更新 —— activeLayer 的 GPU 驻留不再依赖「render-tree 会 pin
  //   updatedNodes」的隐式契约（spec:205），下一帧 sync 走快路径零上传。
  //   返回 false = GPU 侧无法保证 base 完整（池超 quota 等）→ 调用方按未提交处理（不落半拉笔）。
  commitBrushStroke(
    leafId: number, pixels: LayerPixels, ov: StampOverlayInput, docW: number, docH: number,
    apply: (px: Uint8ClampedArray, x: number, y: number, w: number, h: number) => { tx: number; ty: number }[],
  ): boolean {
    if (ov.stamps.length === 0 || ov.bw <= 0 || ov.bh <= 0) return false;
    const gl = this._glctx.gl;
    // ready：base tiles 搭 render-tree 便车（身份命中零上传）。cpuVersion 不齐 = sync 降级（超 quota）→ 放弃。
    this._syncLeafSafe(leafId, pixels, docW, docH);
    const rec = this._layerTiles.get(leafId);
    if (!rec || rec.src !== pixels || rec.cpuVersion !== pixels.contentVersion || rec.gen !== this._pool.generation) return false;
    // 先备 overlay 再 begin（_setStampOverlay 内部的 rasterize/present 会解绑 VAO——与 renderFrame 同序）。
    this._setStampOverlay(ov, docW, docH);
    const ovDesc = this._overlayDesc();
    if (!ovDesc) return false;
    this._comp.begin(docW, docH, false);
    const acc = this._comp.newAcc(docW, docH);   // 透明底：source-over/op=1 输出 = merged 层内容
    this._comp.pass(this._backend.texture, "overlay", rec.index, null, "source-over", 1, null, acc, docW, docH, ovDesc);
    const merged = this._comp.finishAcc(acc);
    if (this._overlayOwnedFBO) { this._glctx.returnFBO(this._overlayOwnedFBO); this._overlayOwnedFBO = null; }
    this._overlay = null;
    // bbox 一次 readPixels（merged FBO texel 行 0 = doc 行 0，无翻转——与栅格器/present 同约定）。
    const px = new Uint8Array(ov.bw * ov.bh * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, merged.fbo);
    gl.readPixels(ov.bx, ov.by, ov.bw, ov.bh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const changed = apply(new Uint8ClampedArray(px.buffer), ov.bx, ov.by, ov.bw, ov.bh);
    if (changed.length) {
      const across = tilesAcross(docW);
      const withHandle = changed.map(({ tx, ty }) => ({ tx, ty, h: pixels.getTileHandle(tx, ty) }));
      const toCopy = withHandle.filter((c) => c.h);   // 擦空回收的格不拷（byKey 直接删）
      try {
        const gpuIds = this._pool.copyBatchFromFramebuffer(toCopy.map(({ tx, ty }) => {
          const x = tx * TILE_SIZE, y = ty * TILE_SIZE;
          return { srcX: x, srcY: y, w: Math.min(TILE_SIZE, docW - x), h: Math.min(TILE_SIZE, docH - y) };
        }));
        toCopy.forEach((c, i) => {
          this._bridge.registerPair(c.h!.id, gpuIds[i]);
          rec.byKey.set(c.ty * across + c.tx, gpuIds[i]);
        });
        for (const c of withHandle) if (!c.h) rec.byKey.delete(c.ty * across + c.tx);
        rec.index.rebuild(rec.byKey, this._pool);
        rec.cpuVersion = pixels.contentVersion;
        rec.gen = this._pool.generation;
      } catch (e) {
        // 收养失败（池到顶）：不更新 rec 记账 → 下一帧 sync 走 bridge 慢路径重传，正确性无损。
        if (!(e instanceof Error) || !e.message.startsWith("GPU_POOL_EXHAUSTED")) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          this._glctx.returnFBO(merged); this._comp.end();
          throw e;
        }
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._glctx.returnFBO(merged);
    this._comp.end();
    this.markDirty();   // commit → 重算树（spec:134）
    return true;
  }

  warpToCanvas(srcCanvas: TexImageSource, srcW: number, srcH: number, hinv: number[], mode: number, bx: number, by: number, bw: number, bh: number) {
    return this._comp.warpToCanvas(srcCanvas, srcW, srcH, hinv, mode, bx, by, bw, bh);
  }

  // ---- 帧入口 ----
  renderFrame(
    nodes: DocNode[], docW: number, docH: number, bg: Background | undefined,
    affine6: number[], canvasW: number, canvasH: number, scale: number, voidRgb: [number, number, number],
    floats: FloatInput[], stampOverlay: StampOverlayInput | null, surrogate: SurrogateInput | null,
    liveSyncLeafId: number | null,
  ): void {
    const gl = this._glctx.gl;
    this.frameStats.segBuilds = 0; this.frameStats.segHits = 0; this.frameStats.cachingDegraded = false;
    // doc 尺寸变：FBO 池全清（旧尺寸永不再命中）+ 段/display/叶记录作废（index 尺寸不符会逐个重建，主动清更干净）。
    if (docW !== this._lastDocW || docH !== this._lastDocH) {
      if (this._display) { this._glctx.returnFBO(this._display); this._display = null; }
      this._glctx.clearPool();
      for (const rec of this._layerTiles.values()) rec.index.dispose();
      this._layerTiles.clear();
      this._invalidateSegs();
      this._displaySig = null;
      this._dirty = true;
      this._lastDocW = docW; this._lastDocH = docH;
    }
    this._pool.frameMaintain();

    // pseudo 装置
    this._setFloats(floats);
    if (stampOverlay) this._setStampOverlay(stampOverlay, docW, docH);
    else this._overlay = null;

    const updated = new Set<number>();
    for (const f of floats) updated.add(f.layerId);
    if (stampOverlay) updated.add(stampOverlay.layerId);
    if (surrogate) updated.add(surrogate.layerId);
    if (liveSyncLeafId !== null) updated.add(liveSyncLeafId);

    const bgKind: BgKind = bg === "checker" ? "checker" : bg ? "color" : "none";
    const leafById = new Map<number, DocLeaf>();
    const planNodes = this._toPlanNodes(nodes, updated, stampOverlay?.layerId ?? null, leafById);
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
      for (const id of [...this._layerTiles.keys()]) if (!leafById.has(id)) { this._layerTiles.get(id)!.index.dispose(); this._layerTiles.delete(id); }
      this._bridge.purgeDead(this._cpuAlive());
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
    const cachingEnabled = this._pool.reserve(this._pool.allocatedCount + needed);
    this.frameStats.cachingDegraded = !cachingEnabled;

    // sync：live 叶 + （建段时）缺段成员。surrogate 叶从替身 canvas 换源。
    const toSync = new Set<number>(plan.liveLeaves);
    if (cachingEnabled) for (const b of missing) for (const id of b.members) toSync.add(id);
    for (const id of toSync) {
      if (surrogate && id === surrogate.layerId) { this._syncSurrogate(surrogate, docW, docH); continue; }
      const leaf = leafById.get(id);
      if (leaf) this._syncLeafSafe(id, leaf.pixels, docW, docH);
    }

    // 合成
    this._comp.begin(docW, docH);
    const transient = new Map<string, PooledFBO>();   // 建不了的段本帧的临时合成结果（复用，别重算）
    if (cachingEnabled) for (const b of missing) this._buildSeg(b, docW, docH, bg, transient);
    else for (const b of missing) transient.set(b.key, this._composeSegTransient(b, docW, docH, bg));
    const acc = this._comp.newAcc(docW, docH, plan.rootBgLive ? bg : undefined);
    this._composeSteps(plan.rootSteps, acc, docW, docH, transient, plan);
    const fresh = this._comp.finishAcc(acc);
    for (const f of transient.values()) this._glctx.returnFBO(f);
    this._comp.end();
    if (this._overlayOwnedFBO) { this._glctx.returnFBO(this._overlayOwnedFBO); this._overlayOwnedFBO = null; }

    if (this._display) this._glctx.returnFBO(this._display);
    this._display = fresh;
    this._displaySig = sig;
    this._present(docW, docH, affine6, canvasW, canvasH, scale, voidRgb);
  }

  // export/吸管专用一次性合成（spec:157）：不建缓存、不失效、不碰 display。caller 负责 returnFBO。
  compositeOnce(nodes: DocNode[], docW: number, docH: number, bg?: Background): PooledFBO {
    const leafById = new Map<number, DocLeaf>();
    const planNodes = this._toPlanNodes(nodes, new Set(), null, leafById);
    const plan = buildPlan(planNodes, new Set(), bg === "checker" ? "checker" : bg ? "color" : "none");
    const all = new Set<number>(plan.liveLeaves);
    for (const b of plan.builds.values()) for (const id of b.members) all.add(id);
    for (const id of all) { const leaf = leafById.get(id); if (leaf) this._syncLeafSafe(id, leaf.pixels, docW, docH); }
    this._comp.begin(docW, docH);
    const transient = new Map<string, PooledFBO>();
    for (const b of plan.builds.values()) transient.set(b.key, this._composeSegTransient(b, docW, docH, bg));
    const acc = this._comp.newAcc(docW, docH, plan.rootBgLive ? bg : undefined);
    this._composeSteps(plan.rootSteps, acc, docW, docH, transient, plan);
    const out = this._comp.finishAcc(acc);
    for (const f of transient.values()) this._glctx.returnFBO(f);
    this._comp.end();
    return out;
  }

  // S9 导出/缩略图/mergedimage 合成面：compositeOnce → 整幅 readPixels → canvas（透明底，straight）。
  compositeToCanvas(nodes: DocNode[], docW: number, docH: number): HTMLCanvasElement {
    const gl = this._glctx.gl;
    const fbo = this.compositeOnce(nodes, docW, docH);
    const px = new Uint8Array(docW * docH * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    gl.readPixels(0, 0, docW, docH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._glctx.returnFBO(fbo);
    const canvas = document.createElement("canvas"); canvas.width = docW; canvas.height = docH;
    canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), docW, docH), 0, 0);
    return canvas;
  }

  // S8 吸管（spec:243-244）：一次性合成 + 单像素 readPixels（合成组无 CPU tile → 必须走 GPU 读）。
  pickColor(nodes: DocNode[], docW: number, docH: number, bg: Background | undefined, x: number, y: number): [number, number, number, number] {
    const gl = this._glctx.gl;
    const fbo = this.compositeOnce(nodes, docW, docH, bg);
    const px = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._glctx.returnFBO(fbo);
    return [px[0], px[1], px[2], px[3]];
  }

  // ---- 内部：plan 翻译 / 签名 ----
  private _toPlanNodes(nodes: DocNode[], updated: Set<number>, overlayLeafId: number | null, leafById: Map<number, DocLeaf>): PlanNode[] {
    return nodes.map((n): PlanNode => {
      if (!n.isGroup) {
        leafById.set(n.id, n);
        return {
          kind: "leaf", id: n.id, opacity: n.opacity, mode: safeMode(n.mode), clip: !!n.clippingMask,
          visible: !!n.visible, hasContent: n.pixels.tileCount > 0,
          float: this._floats.has(n.id), overlay: overlayLeafId === n.id && !!this._overlay,
        };
      }
      return {
        kind: "group", id: n.id, opacity: n.opacity,
        mode: n.mode === "pass-through" ? "pass-through" : safeMode(n.mode),
        clip: !!n.clippingMask, visible: !!n.visible,
        children: this._toPlanNodes(n.children, updated, overlayLeafId, leafById),
      };
    });
  }

  private _planSig(plan: Plan, docW: number, docH: number, bg: Background | undefined): string {
    const steps = (ss: PlanStep[]): string => ss.map((s) =>
      s.t === "seg" ? `s(${s.key},${s.mode},${s.opacity},${s.clipBaseId})`
      : s.t === "leaf" ? `l(${s.id},${s.mode},${s.opacity},${s.clipBaseId},${s.overlay})`
      : s.t === "float" ? `f(${s.id})`
      : `g(${s.id},${s.mode},${s.opacity},${s.clipBaseId},[${steps(s.body)}])`).join("|");
    return `${docW}x${docH};bg=${JSON.stringify(bg)};${steps(plan.rootSteps)}`;
  }

  private _segValid(seg: SegEntry): boolean {
    if (seg.gen !== this._pool.generation) return false;
    for (const g of seg.byKey.values()) if (!this._pool.isAlive(g)) return false;
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

  // ---- 内部：sync（原 gl-doc-renderer 的 _syncPixels 迁入） ----
  private _syncLeafSafe(leafId: number, pixels: LayerPixels, docW: number, docH: number): void {
    try { this._syncPixels(leafId, pixels, docW, docH); } catch (e) {
      // 池连驱逐后都塞不下（内容超显存 quota）：该层保持陈旧/部分显示，压力缓解后自愈。
      if (!(e instanceof Error) || !e.message.startsWith("GPU_POOL_EXHAUSTED")) throw e;
    }
  }

  private _syncPixels(leafId: number, pixels: LayerPixels, docW: number, docH: number): void {
    const across = tilesAcross(docW), down = tilesDown(docH);
    let rec = this._layerTiles.get(leafId);
    if (rec && (rec.index.across !== across || rec.index.down !== down)) {
      rec.index.dispose();
      this._layerTiles.delete(leafId);
      rec = undefined;
    }
    const gen = this._pool.generation;
    if (rec && rec.src === pixels && rec.cpuVersion === pixels.contentVersion && rec.gen === gen) return;   // 快路径
    if (!rec) {
      rec = { index: new IndexTexture(this._glctx, docW, docH), byKey: new Map(), src: null, cpuVersion: -1, gen };
      this._layerTiles.set(leafId, rec);
    }
    const keys: number[] = [];
    const entries: { cpuId: number; bytes: () => Uint8Array }[] = [];
    pixels.forEachTileHandle((tx, ty, h) => {
      keys.push(ty * across + tx);
      entries.push({ cpuId: h.id, bytes: () => h.bytes() });
    });
    const gpuIds = this._bridge.ensureUploaded(entries);
    let changed = rec.byKey.size !== keys.length || rec.gen !== gen;
    if (!changed) for (let i = 0; i < keys.length; i++) if (rec.byKey.get(keys[i]) !== gpuIds[i]) { changed = true; break; }
    if (changed) {
      rec.byKey.clear();
      for (let i = 0; i < keys.length; i++) rec.byKey.set(keys[i], gpuIds[i]);
      rec.index.rebuild(rec.byKey, this._pool);
    }
    rec.src = pixels;
    rec.cpuVersion = pixels.contentVersion;
    rec.gen = gen;
  }

  private _syncSurrogate(s: SurrogateInput, docW: number, docH: number): void {
    const tmp = new LayerPixels(docW, docH);
    replaceFromCanvas(tmp, s.canvas, s.bx, s.by, s.w, s.h);
    this._syncLeafSafe(s.layerId, tmp, docW, docH);
    const rec = this._layerTiles.get(s.layerId);
    if (rec) rec.src = null;   // tmp 即将 dispose → 快路径身份作废（surrogate 清除后必从真像素重传）
    tmp.dispose();
    this._bridge.purgeDead(this._cpuAlive());
  }

  private _cpuAlive(): (id: number) => boolean {
    const alive = new Set<number>();
    appTilePool().forEachLiveId((id: number) => alive.add(id));
    return (id) => alive.has(id);
  }

  // ---- 内部：段建造 / step 合成 ----
  private _buildSeg(b: SegBuild, docW: number, docH: number, bg: Background | undefined, transient: Map<string, PooledFBO>): void {
    const gl = this._glctx.gl;
    const res = this._composeSegTransient(b, docW, docH, bg);
    // coverage = 成员叶 tile 键并集；withBg（不透明底）= 全 doc tiles。
    const across = tilesAcross(docW), down = tilesDown(docH);
    const cover = new Set<number>();
    if (b.withBg) { for (let k = 0; k < across * down; k++) cover.add(k); }
    else for (const id of b.members) { const rec = this._layerTiles.get(id); if (rec) for (const k of rec.byKey.keys()) cover.add(k); }
    const keys = [...cover];
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, res.fbo);
      const gpuIds = this._pool.copyBatchFromFramebuffer(keys.map((k) => {
        const { tx, ty } = tileCoord(k, across);
        const x = tx * TILE_SIZE, y = ty * TILE_SIZE;
        return { srcX: x, srcY: y, w: Math.min(TILE_SIZE, docW - x), h: Math.min(TILE_SIZE, docH - y) };
      }));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const byKey = new Map<number, number>();
      keys.forEach((k, i) => byKey.set(k, gpuIds[i]));
      const index = new IndexTexture(this._glctx, docW, docH);
      index.rebuild(byKey, this._pool);
      this._segCache.set(b.key, { byKey, index, gen: this._pool.generation });
      this.frameStats.segBuilds++;
      this._glctx.returnFBO(res);
    } catch (e) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!(e instanceof Error) || !e.message.startsWith("GPU_POOL_EXHAUSTED")) { this._glctx.returnFBO(res); throw e; }
      transient.set(b.key, res);   // 入池失败 → 本帧当临时段用（compose 后归还），不缓存
    }
  }

  // 段的临时合成（不入池）：fresh acc（prefix 段带 bg）→ steps → FBO。
  private _composeSegTransient(b: SegBuild, docW: number, docH: number, bg: Background | undefined): PooledFBO {
    const acc = this._comp.newAcc(docW, docH, b.withBg ? bg : undefined);
    this._composeSteps(b.steps, acc, docW, docH, new Map(), null);
    return this._comp.finishAcc(acc);
  }

  private _composeSteps(steps: PlanStep[], acc: Acc, docW: number, docH: number, transient: Map<string, PooledFBO>, plan: Plan | null): void {
    const arrayTex = this._backend.texture;
    for (const step of steps) {
      if (step.t === "leaf") {
        const rec = this._layerTiles.get(step.id);
        if (!rec) continue;   // sync 降级（超 quota）→ 跳层（自愈后回来）
        const clipIdx = step.clipBaseId !== null ? this._layerTiles.get(step.clipBaseId)?.index ?? null : null;
        const ov = step.overlay && this._overlay && this._overlay.layerId === step.id ? this._overlayDesc() : null;
        this._comp.pass(arrayTex, ov ? "overlay" : "tiled", rec.index, null, step.mode as BlendMode, step.opacity, clipIdx, acc, docW, docH, ov);
      } else if (step.t === "seg") {
        const seg = this._segCache.get(step.key);
        const clipIdx = step.clipBaseId !== null ? this._layerTiles.get(step.clipBaseId)?.index ?? null : null;
        if (seg) {
          this._comp.pass(arrayTex, "tiled", seg.index, null, step.mode as BlendMode, step.opacity, clipIdx, acc, docW, docH);
        } else {
          const f = transient.get(step.key);
          if (!f) continue;   // 不可达（缺段必在 transient）；防御性跳过
          this._comp.pass(arrayTex, "group", null, f.tex, step.mode as BlendMode, step.opacity, clipIdx, acc, docW, docH);
        }
      } else if (step.t === "group") {
        const sub = this._comp.newAcc(docW, docH);
        this._composeSteps(step.body, sub, docW, docH, transient, plan);
        const res = this._comp.finishAcc(sub);
        const clipIdx = step.clipBaseId !== null ? this._layerTiles.get(step.clipBaseId)?.index ?? null : null;
        this._comp.pass(arrayTex, "group", null, res.tex, step.mode as BlendMode, step.opacity, clipIdx, acc, docW, docH);
        this._glctx.returnFBO(res);
      } else {   // float
        const desc = this._floats.get(step.id);
        if (!desc) continue;
        const base = step.clipBaseFloatId !== null ? this._floats.get(step.clipBaseFloatId) ?? null : null;
        this._comp.floatPass(desc, acc, docW, docH, base);
      }
    }
  }

  private _present(docW: number, docH: number, affine6: number[], canvasW: number, canvasH: number, scale: number, voidRgb: [number, number, number]): void {
    const gl = this._glctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.clearColor(voidRgb[0], voidRgb[1], voidRgb[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this._comp.presentToScreenAffine(this._display!.tex, docW, docH, affine6, canvasW, canvasH, scale < 1);
  }

  // ---- 内部：pseudo 装置（原 gl-doc-renderer 迁入，行为不变） ----
  private _overlayDesc(): OverlayDesc | null {
    const ov = this._overlay;
    if (!ov) return null;
    return { tex: ov.tex, opacity: ov.opacity, erase: ov.erase, blendMode: safeMode(ov.blendMode), ox: ov.ox, oy: ov.oy, ow: ov.ow, oh: ov.oh, lockAlpha: ov.lockAlpha, selMask: ov.selMask };
  }

  private _setStampOverlay(ov: StampOverlayInput, docW: number, docH: number): void {
    if (ov.stamps.length === 0 || ov.bw <= 0 || ov.bh <= 0) { this._overlay = null; return; }
    const gl = this._glctx.gl;
    // 整屏 doc FBO + scissor（池每帧同尺寸命中零 malloc）；着色靠 scissor 限回 stamp bbox。
    const fboP = this._rasterizer.rasterize(ov.stamps, ov.shape, 0, 0, docW, docH, { x: ov.bx, y: ov.by, w: ov.bw, h: ov.bh });
    const fboS = this._glctx.borrowFBO(docW, docH, "u8");
    this._comp.presentTo(fboP.tex, fboS, docW, docH, true);   // 栅格器预乘 → straight
    this._glctx.returnFBO(fboP);
    if (this._overlayOwnedFBO) this._glctx.returnFBO(this._overlayOwnedFBO);
    this._overlayOwnedFBO = fboS;
    let selMask: { tex: WebGLTexture; ox: number; oy: number; ow: number; oh: number } | null = null;
    if (ov.selMask) {
      if (!this._selTex) {
        this._selTex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, this._selTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      if (this._selTexSrc !== ov.selMask.data) {   // Selection 不可变 → buffer 身份即内容
        gl.bindTexture(gl.TEXTURE_2D, this._selTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, ov.selMask.ow, ov.selMask.oh, 0, gl.RED, gl.UNSIGNED_BYTE, ov.selMask.data);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this._selTexSrc = ov.selMask.data;
      }
      selMask = { tex: this._selTex, ox: ov.selMask.ox, oy: ov.selMask.oy, ow: ov.selMask.ow, oh: ov.selMask.oh };
    }
    this._overlay = { tex: fboS.tex, layerId: ov.layerId, opacity: ov.opacity, erase: ov.erase, blendMode: ov.blendMode, ox: 0, oy: 0, ow: docW, oh: docH, lockAlpha: ov.lockAlpha, selMask };
  }

  private _setFloats(floats: FloatInput[]): void {
    const gl = this._glctx.gl;
    this._floats.clear();
    const seen = new Set<number>();
    for (const f of floats) {
      if (f.srcW <= 0 || f.srcH <= 0) continue;
      seen.add(f.layerId);
      let entry = this._floatTex.get(f.layerId);
      if (!entry) {
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        entry = { tex, canvas: null };
        this._floatTex.set(f.layerId, entry);
      }
      if (entry.canvas !== f.srcCanvas) {   // 源内容变（首次/换浮层）才重传
        gl.bindTexture(gl.TEXTURE_2D, entry.tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f.srcCanvas as TexImageSource);
        entry.canvas = f.srcCanvas;
      }
      this._floats.set(f.layerId, { tex: entry.tex, srcW: f.srcW, srcH: f.srcH, hinv: f.hinv, mode: f.mode });
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    for (const [id, e] of this._floatTex) if (!seen.has(id)) { gl.deleteTexture(e.tex); this._floatTex.delete(id); }
  }
}

// 按显存预算（字节）算 gpu tile 池深度上限（惰性增长的顶）。
export function poolCapacityForBudget(budgetBytes: number): number {
  return Math.max(64, Math.floor(budgetBytes / GPU_TILE_BYTES));
}
