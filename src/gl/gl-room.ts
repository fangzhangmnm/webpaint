// GlRoom —— GL 机房引用包 + 双 facade 的共享基座（T6，ADR-0008 / 提案 .h「render 侧拆分」）。
// 机房五件套（GLContext / GpuTilePool / CpuGpuTileBridge / GLCompositor / GLStampRasterizer）
// **唯一实例**在此；RenderTree（tree composite）与 RasterService（一次性算像素）各拿同一个 room。
// 共享的不止五件套——还有两 facade 都要坐的「台面」：
//   - 叶 GPU 驻留台账（leaves + sync）：bakeStamps 搭 renderFrame 的 base-tile 便车
//     （拆成两套缓存 = 每笔整层重传，handoff §1 T6 硬约束）；
//   - pseudo 装置（overlay/float/选区 mask/fill 色纹理）：live 预览与吸管 WYSIWYG 用同一份状态；
//   - composeSteps 合成机：display 帧与一次性合成走同一条 pass 序（观感零漂移）。
// RenderTree 私有的仍在 RenderTree（段缓存/display/plan 签名/frameStats）；本类零策略、零帧决策。

import { GpuTilePool, GLGpuTileBackend, IndexTexture, GPU_TILE_BYTES } from "./gpu-tile-pool.ts";
import { CpuGpuTileBridge } from "./tile-bridge.ts";
import { appTilePool } from "../tiles/app-tile-pool.ts";
import { tilesAcross, tilesDown } from "../tiles/tile-geometry.ts";
import { GLCompositor } from "./gl-compositor.ts";
import type { Acc, OverlayDesc, FloatDesc } from "./gl-compositor.ts";
import { safeMode } from "./gl-doc-bridge.ts";
import type { DocNode, DocLeaf } from "./gl-doc-bridge.ts";
import { LayerPixels } from "../tiles/tile-layer.ts";
import { GLStampRasterizer } from "./gl-stamp.ts";
import type { Stamp, StrokeShape } from "./gl-stamp.ts";
import type { Plan, PlanNode, PlanStep, SegBuild } from "../render/render-plan.ts";
import type { PooledFBO, FBOPrec, GLContext } from "./gl-context.ts";
import type { BlendMode } from "./blend-glsl.ts";

// ---- board 输入（原 render-tree-gl 同名接口原样迁入） ----
// v0.6.39 去 canvas 化：替身 = straight 字节平面（filters-adjust 的预览 buffer 直传，就地更新）。
export interface SurrogateInput { layerId: number; bytes: { data: Uint8ClampedArray; w: number; h: number }; bx: number; by: number; w: number; h: number; }

// v0.6.38 全 typed array（零 canvas premult 往返）：u8Plane = straight 源字节（原尺寸，或 rotsprite
// 的 EPX 放大平面——此时 srcW/srcH 已是放大尺寸、mode=0）；mode 3 用 splinePlane（RGBA16F）。
export interface FloatInput {
  layerId: number;
  srcW: number; srcH: number;
  hinv: number[];                 // 9，row-major，doc→源单位方格
  mode: number;                   // 0=nearest 1=bilinear 2=bicubic 3=spline（预滤波 B 样条）
  splinePlane?: { data: Float32Array; w: number; h: number } | null;   // mode 3 的系数平面（PAD 边距，src/bspline.ts）
  u8Plane?: { data: Uint8ClampedArray; w: number; h: number } | null;  // 其余 mode 的 straight u8 源
}

export interface StampOverlayInput {
  stamps: Stamp[]; shape: StrokeShape;
  bx: number; by: number; bw: number; bh: number;
  layerId: number; opacity: number; erase: boolean; blendMode: string;
  lockAlpha: boolean;
  selMask: { data: Uint8Array; ox: number; oy: number; ow: number; oh: number } | null;
}

// v0.5.11 fill-mode：填色预览/commit 走同一 overlay 槽（journal「pseudoLayer 会有不同渲染模式」预留的路）。
//   内容 = 1×1 填色纹理拉伸到选区 bbox（shader overlay 分支 bbox 外自透明，:blend-glsl 越界检查）；
//   选区裁剪走既有 selMask 管道（此处必填——fill 只在有选区时存在）。语义钉死 source-over/opacity=1/无 erase；
//   lockAlpha 跟活动层（user 拍板：填色尊重锁α）。stamp 光栅器不参与（它只会圆/椭圆 dab）。
export interface FillOverlayInput {
  kind: "fill";
  color: [number, number, number];   // 0..255 直值（1×1 纹理字节）
  bx: number; by: number; bw: number; bh: number;   // = 选区 bbox（doc 坐标）
  layerId: number;
  lockAlpha: boolean;
  selMask: { data: Uint8Array; ox: number; oy: number; ow: number; oh: number };
}
export type OverlayInput = StampOverlayInput | FillOverlayInput;

// overlay 空判据（kind-aware——fill 没有 stamps，旧 stamps.length 守卫会把 fill 静默早退成 false）。
export function overlayEmpty(ov: OverlayInput): boolean {
  if (ov.bw <= 0 || ov.bh <= 0) return true;
  return "kind" in ov ? false : ov.stamps.length === 0;
}

// 每叶 GPU 驻留记录（7a 引入）。两 facade 共读共写：renderFrame sync 建，bakeStamps 命中即免重传。
export interface LeafRec { index: IndexTexture; byKey: Map<number, number>; src: LayerPixels | null; cpuVersion: number; gen: number }

export class GlRoom {
  readonly glctx: GLContext;
  readonly backend: GLGpuTileBackend;
  readonly pool: GpuTilePool;
  readonly bridge: CpuGpuTileBridge;
  readonly comp: GLCompositor;
  readonly rasterizer: GLStampRasterizer;

  // 叶 GPU 驻留台账（原 RenderTreeGL._layerTiles）。
  readonly leaves = new Map<number, LeafRec>();

  // pseudo 装置（overlay/float/选区 mask/fill 色）——live 预览与一次性合成（吸管 WYSIWYG）共用。
  private _overlay: { tex: WebGLTexture; layerId: number; opacity: number; erase: boolean; blendMode: string; ox: number; oy: number; ow: number; oh: number; lockAlpha: boolean; selMask: { tex: WebGLTexture; ox: number; oy: number; ow: number; oh: number } | null } | null = null;
  private _overlayOwnedFBO: PooledFBO | null = null;
  private _selTex: WebGLTexture | null = null;
  private _selTexSrc: Uint8Array | null = null;
  private _fillTex: WebGLTexture | null = null;    // fill-mode：1×1 填色纹理（颜色变才重传）
  private _fillTexColor = -1;
  private _floatTex = new Map<number, { tex: WebGLTexture; canvas: CanvasImageSource | null }>();
  private _floats = new Map<number, FloatDesc>();

  // v0.4.11：live 描边中给 clip-above 用的 merged(base⊕stroke) 整幅纹理（帧内缓存，帧末归还）。
  private _liveMergedClip: PooledFBO | null = null;

  // 内容失效信号：RasterService.bakeStamps 落了新像素 → RenderTree 置脏重算树（facade 互不知晓）。
  private _invalidateListeners: (() => void)[] = [];

  constructor(glctx: GLContext, maxSlices: number, accumPrec: FBOPrec = "u8") {
    this.glctx = glctx;
    this.backend = new GLGpuTileBackend(glctx, Math.min(64, maxSlices));
    this.pool = new GpuTilePool(this.backend, maxSlices);
    this.bridge = new CpuGpuTileBridge(this.pool);
    this.comp = new GLCompositor(glctx, accumPrec);
    this.rasterizer = new GLStampRasterizer(glctx);
  }

  // ---- 机房观测口（HUD） ----
  get memory(): { usedTiles: number; capacity: number; usedBytes: number; committedBytes: number; quotaBytes: number } {
    return {
      usedTiles: this.pool.allocatedCount, capacity: this.pool.capacity,
      usedBytes: this.pool.allocatedCount * GPU_TILE_BYTES,
      committedBytes: this.pool.committedBytes, quotaBytes: this.pool.quotaBytes,
    };
  }
  get stats(): { passes: number; floatPasses: number } { return this.comp.stats; }
  get fboPoolStats(): { count: number; bytes: number } { return this.glctx.fboPoolStats; }

  // ---- 内容失效信号 ----
  onInvalidate(cb: () => void): void { this._invalidateListeners.push(cb); }
  invalidateTree(): void { for (const cb of this._invalidateListeners) cb(); }

  // ---- context-loss：机房侧全量作废（段缓存/display 归 RenderTree 自己清） ----
  handleContextRestored(): void {
    this.pool.clearAll();
    this.bridge.clear();
    this.leaves.clear();           // GL 句柄已随 context 死，弃引用
    this._selTex = null; this._selTexSrc = null;
    this._fillTex = null; this._fillTexColor = -1;
    this._floatTex.clear(); this._floats.clear();
    this._overlay = null; this._overlayOwnedFBO = null;
    this._liveMergedClip = null;   // GL 句柄已随 context 死
  }

  // ---- sync：CPU tile → GPU 驻留（原 RenderTreeGL._syncPixels 族） ----
  syncLeafSafe(leafId: number, pixels: LayerPixels, docW: number, docH: number): void {
    try { this._syncPixels(leafId, pixels, docW, docH); } catch (e) {
      // 池连驱逐后都塞不下（内容超显存 quota）：该层保持陈旧/部分显示，压力缓解后自愈。
      if (!(e instanceof Error) || !e.message.startsWith("GPU_POOL_EXHAUSTED")) throw e;
    }
  }

  private _syncPixels(leafId: number, pixels: LayerPixels, docW: number, docH: number): void {
    const across = tilesAcross(docW), down = tilesDown(docH);
    let rec = this.leaves.get(leafId);
    if (rec && (rec.index.across !== across || rec.index.down !== down)) {
      rec.index.dispose();
      this.leaves.delete(leafId);
      rec = undefined;
    }
    const gen = this.pool.generation;
    if (rec && rec.src === pixels && rec.cpuVersion === pixels.contentVersion && rec.gen === gen
        && this.recAlive(rec)) return;   // 快路径（isAlive 扫描防 LRU 驱逐后采到被重用的 slice）
    if (!rec) {
      rec = { index: new IndexTexture(this.glctx, docW, docH), byKey: new Map(), src: null, cpuVersion: -1, gen };
      this.leaves.set(leafId, rec);
    }
    const keys: number[] = [];
    const entries: { cpuId: number; bytes: () => Uint8Array }[] = [];
    pixels.forEachTileHandle((tx, ty, h) => {
      keys.push(ty * across + tx);
      entries.push({ cpuId: h.id, bytes: () => h.bytes() });
    });
    const gpuIds = this.bridge.ensureUploaded(entries);
    let changed = rec.byKey.size !== keys.length || rec.gen !== gen;
    if (!changed) for (let i = 0; i < keys.length; i++) if (rec.byKey.get(keys[i]) !== gpuIds[i]) { changed = true; break; }
    if (changed) {
      rec.byKey.clear();
      for (let i = 0; i < keys.length; i++) rec.byKey.set(keys[i], gpuIds[i]);
      rec.index.rebuild(rec.byKey, this.pool);
    }
    rec.src = pixels;
    rec.cpuVersion = pixels.contentVersion;
    rec.gen = gen;
  }

  syncSurrogate(s: SurrogateInput, docW: number, docH: number): void {
    const tmp = new LayerPixels(docW, docH);
    tmp.putRegion(s.bx, s.by, s.w, s.h, s.bytes.data);
    this.syncLeafSafe(s.layerId, tmp, docW, docH);
    const rec = this.leaves.get(s.layerId);
    if (rec) rec.src = null;   // tmp 即将 dispose → 快路径身份作废（surrogate 清除后必从真像素重传）
    tmp.dispose();
    this.bridge.purgeDead(this.cpuAlive());
  }

  // v0.7.36 修 import 后串 tile：快路径必须含 isAlive 扫描（generation 不含 LRU 驱逐）。
  recAlive(rec: { byKey: Map<number, number> }): boolean {
    for (const g of rec.byKey.values()) if (!this.pool.isAlive(g)) return false;
    return true;
  }

  cpuAlive(): (id: number) => boolean {
    const alive = new Set<number>();
    appTilePool().forEachLiveId((id: number) => alive.add(id));
    return (id) => alive.has(id);
  }

  // ---- plan 翻译（读 pseudo 装置旗） ----
  toPlanNodes(nodes: DocNode[], updated: Set<number>, overlayLeafId: number | null, leafById: Map<number, DocLeaf>): PlanNode[] {
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
        children: this.toPlanNodes(n.children, updated, overlayLeafId, leafById),
      };
    });
  }

  // ---- step 合成机（display 帧与一次性合成同一条 pass 序） ----
  // segLookup = RenderTree 的段缓存读口（一次性合成传 null——所有段都在 transient）。
  composeSteps(steps: PlanStep[], acc: Acc, docW: number, docH: number, transient: Map<string, PooledFBO>, segLookup: ((key: string) => IndexTexture | undefined) | null): void {
    const arrayTex = this.backend.texture;
    for (const step of steps) {
      if (step.t === "leaf") {
        const rec = this.leaves.get(step.id);
        if (!rec) continue;   // sync 降级（超 quota）→ 跳层（自愈后回来）
        const clipIdx = step.clipBaseId !== null ? this.leaves.get(step.clipBaseId)?.index ?? null : null;
        const clipTex = this.liveClipTexFor(step.clipBaseId, docW, docH);
        const ov = step.overlay && this._overlay && this._overlay.layerId === step.id ? this.overlayDesc() : null;
        this.comp.pass(arrayTex, ov ? "overlay" : "tiled", rec.index, null, step.mode as BlendMode, step.opacity, clipIdx, acc, docW, docH, ov, clipTex);
      } else if (step.t === "seg") {
        // transient 优先（v0.4.11）：compositeOnce 把所有段都现算进 transient——若先查段缓存
        //   会命中上帧真内容、绕过替身换源（吸管 WYSIWYG 取不到替身的病根）。renderFrame 路径
        //   transient 只装建段失败的 key，先查它无副作用。
        const f = transient.get(step.key);
        const clipIdx = step.clipBaseId !== null ? this.leaves.get(step.clipBaseId)?.index ?? null : null;
        const clipTex = this.liveClipTexFor(step.clipBaseId, docW, docH);
        if (f) {
          this.comp.pass(arrayTex, "group", null, f.tex, step.mode as BlendMode, step.opacity, clipIdx, acc, docW, docH, null, clipTex);
        } else {
          const segIdx = segLookup?.(step.key);
          if (!segIdx) continue;   // 不可达（缺段必在 transient）；防御性跳过
          this.comp.pass(arrayTex, "tiled", segIdx, null, step.mode as BlendMode, step.opacity, clipIdx, acc, docW, docH, null, clipTex);
        }
      } else if (step.t === "group") {
        const sub = this.comp.newAcc(docW, docH);
        this.composeSteps(step.body, sub, docW, docH, transient, segLookup);
        const res = this.comp.finishAcc(sub);
        const clipIdx = step.clipBaseId !== null ? this.leaves.get(step.clipBaseId)?.index ?? null : null;
        const clipTex = this.liveClipTexFor(step.clipBaseId, docW, docH);
        this.comp.pass(arrayTex, "group", null, res.tex, step.mode as BlendMode, step.opacity, clipIdx, acc, docW, docH, null, clipTex);
        this.glctx.returnFBO(res);
      } else {   // float
        const desc = this._floats.get(step.id);
        if (!desc) continue;
        const base = step.clipBaseFloatId !== null ? this._floats.get(step.clipBaseFloatId) ?? null : null;
        this.comp.floatPass(desc, acc, docW, docH, base);
      }
    }
  }

  // 段的临时合成（不入池）：fresh acc（prefix 段带 bg）→ steps → FBO。
  composeSegTransient(b: SegBuild, docW: number, docH: number, bg: Parameters<GLCompositor["newAcc"]>[2]): PooledFBO {
    const acc = this.comp.newAcc(docW, docH, b.withBg ? bg : undefined);
    this.composeSteps(b.steps, acc, docW, docH, new Map(), null);
    return this.comp.finishAcc(acc);
  }

  // v0.4.11：clip 基底正被 live 描边（= 活动 overlay 叶）时，clip-above 的蒙版改采
  //   merged(base⊕stroke) 整幅 alpha——用 commit 同一配方（透明底 + overlay pass source-over/op1）
  //   现算一张、帧内缓存。修「clip 层不实时跟随基底 live 笔迹」（真机 2026-07-22）。
  //   基底非活动叶 / 无描边 → null（走原 tile-index 路径）。
  liveClipTexFor(clipBaseId: number | null, docW: number, docH: number): WebGLTexture | null {
    if (clipBaseId === null || !this._overlay || this._overlay.layerId !== clipBaseId) return null;
    if (!this._liveMergedClip) {
      const rec = this.leaves.get(clipBaseId);
      const ovDesc = this.overlayDesc();
      if (!rec || !ovDesc) return null;
      const acc = this.comp.newAcc(docW, docH);
      this.comp.pass(this.backend.texture, "overlay", rec.index, null, "source-over", 1, null, acc, docW, docH, ovDesc);
      this._liveMergedClip = this.comp.finishAcc(acc);
    }
    return this._liveMergedClip.tex;
  }

  // 帧末/一次性合成收尾：归还 liveMergedClip 帧内缓存。
  releaseLiveClip(): void {
    if (this._liveMergedClip) { this.glctx.returnFBO(this._liveMergedClip); this._liveMergedClip = null; }
  }

  // ---- pseudo 装置（原 RenderTreeGL 迁入，行为不变） ----
  get hasOverlay(): boolean { return !!this._overlay; }
  get overlayLayerId(): number | null { return this._overlay?.layerId ?? null; }

  overlayDesc(): OverlayDesc | null {
    const ov = this._overlay;
    if (!ov) return null;
    return { tex: ov.tex, opacity: ov.opacity, erase: ov.erase, blendMode: safeMode(ov.blendMode), ox: ov.ox, oy: ov.oy, ow: ov.ow, oh: ov.oh, lockAlpha: ov.lockAlpha, selMask: ov.selMask };
  }

  clearOverlay(): void { this._overlay = null; }
  // overlay 自有 FBO（stamp 分支借的 straight 转换结果）归还。commit/一次性合成用完即还；
  // renderFrame 帧末还（_overlay 引用下帧重灌）。
  releaseOverlayFBO(): void {
    if (this._overlayOwnedFBO) { this.glctx.returnFBO(this._overlayOwnedFBO); this._overlayOwnedFBO = null; }
  }

  setStampOverlay(ov: OverlayInput, docW: number, docH: number): void {
    if (overlayEmpty(ov)) { this._overlay = null; return; }
    const gl = this.glctx.gl;
    if ("kind" in ov) {
      // fill：1×1 填色纹理拉伸到选区 bbox。不碰 stamp 光栅器、不借 FBO；shader overlay 分支
      //   bbox 外自透明（uv 越界检查）+ selMask dst-in = 恰为「选区内 source-over 填色」。
      if (!this._fillTex) {
        this._fillTex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, this._fillTex);
        // 1×1 也必须给全采样参数（默认 MIN_FILTER 要 mip → 纹理不完整采黑），同 _selTex 参数块。
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      const colorKey = (ov.color[0] << 16) | (ov.color[1] << 8) | ov.color[2];
      if (this._fillTexColor !== colorKey) {
        gl.bindTexture(gl.TEXTURE_2D, this._fillTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array([ov.color[0], ov.color[1], ov.color[2], 255]));   // straight，alpha=1（裁剪全靠 selMask）
        gl.bindTexture(gl.TEXTURE_2D, null);
        this._fillTexColor = colorKey;
      }
      const selMask = this._uploadSelMask(ov.selMask);
      this._overlay = { tex: this._fillTex, layerId: ov.layerId, opacity: 1, erase: false, blendMode: "source-over", ox: ov.bx, oy: ov.by, ow: ov.bw, oh: ov.bh, lockAlpha: ov.lockAlpha, selMask };
      return;
    }
    // 整屏 doc FBO + scissor（池每帧同尺寸命中零 malloc)；着色靠 scissor 限回 stamp bbox。
    const fboP = this.rasterizer.rasterize(ov.stamps, ov.shape, 0, 0, docW, docH, { x: ov.bx, y: ov.by, w: ov.bw, h: ov.bh });
    const fboS = this.glctx.borrowFBO(docW, docH, "u8");
    this.comp.presentTo(fboP.tex, fboS, docW, docH, true);   // 栅格器预乘 → straight
    this.glctx.returnFBO(fboP);
    if (this._overlayOwnedFBO) this.glctx.returnFBO(this._overlayOwnedFBO);
    this._overlayOwnedFBO = fboS;
    const selMask = ov.selMask ? this._uploadSelMask(ov.selMask) : null;
    this._overlay = { tex: fboS.tex, layerId: ov.layerId, opacity: ov.opacity, erase: ov.erase, blendMode: ov.blendMode, ox: 0, oy: 0, ow: docW, oh: docH, lockAlpha: ov.lockAlpha, selMask };
  }

  // 选区 mask 上传（stamp/fill 两分支共用）：单张复用纹理，buffer 身份即内容（Selection 不可变）。
  //   ⚠ 若 mask buffer 未来被池化复用，这个身份缓存就是地雷（同 identity 不同内容）——届时换显式版本号。
  private _uploadSelMask(sm: { data: Uint8Array; ox: number; oy: number; ow: number; oh: number }): { tex: WebGLTexture; ox: number; oy: number; ow: number; oh: number } {
    const gl = this.glctx.gl;
    if (!this._selTex) {
      this._selTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this._selTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    if (this._selTexSrc !== sm.data) {   // Selection 不可变 → buffer 身份即内容
      gl.bindTexture(gl.TEXTURE_2D, this._selTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, sm.ow, sm.oh, 0, gl.RED, gl.UNSIGNED_BYTE, sm.data);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this._selTexSrc = sm.data;
    }
    return { tex: this._selTex, ox: sm.ox, oy: sm.oy, ow: sm.ow, oh: sm.oh };
  }

  get floats(): ReadonlyMap<number, FloatDesc> { return this._floats; }

  setFloats(floats: FloatInput[]): void {
    const gl = this.glctx.gl;
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
      // 内容 key = 平面身份（模式切换 spline↔u8 时 key 变 → 自动重传）。全 typed array 上传：
      // UNPACK_PREMULTIPLY flag 对 typed array 不适用，字节 verbatim 上卡——canvas 源上传在 Safari
      // 上的 premult 转换不可靠（柔边变黑），v0.6.38 起禁入浮层管线。
      const contentKey = ((f.mode === 3 && f.splinePlane) ? f.splinePlane.data : f.u8Plane?.data) as unknown as CanvasImageSource;
      if (!contentKey) continue;
      if (entry.canvas !== contentKey) {   // 源内容变（首次/换浮层/换采样族）才重传
        gl.bindTexture(gl.TEXTURE_2D, entry.tex);
        if (f.mode === 3 && f.splinePlane) {
          const p = f.splinePlane;
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, p.w + 16, p.h + 16, 0, gl.RGBA, gl.FLOAT, p.data);
        } else {
          const p = f.u8Plane!;
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, p.w, p.h, 0, gl.RGBA, gl.UNSIGNED_BYTE,
            new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength));
        }
        entry.canvas = contentKey;
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
