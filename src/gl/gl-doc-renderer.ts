// GLDocRenderer —— doc 图层树 → 屏幕的编排（docs/perf-webgl-memory-clip.md §5.5）。
// 持有：tile 池(GLTileBackend+TilePool)、合成器、每层 GL 资源(index+tileMap)、复用 scratch。
// 这是 board 接线时持有的顶层对象。脏跟踪（只重传变更层）是优化，先 correctness-first 全重传。
//
// 接 board 时：board 持一个 GLDocRenderer；内容变更 syncLayer(脏层)；每帧 renderToScreen(doc.layers)。
// 视口 pan/zoom 暂为整文档 1:1 fit；真视口变换 = 接 board 时加（present 带 view matrix）。

import { GLTileBackend } from "./tile-backend-gl.ts";
import { TilePool, TILE_BYTES } from "./tile-store.ts";
import { GLCompositor } from "./gl-compositor.ts";
import type { Background } from "./gl-compositor.ts";
import { uploadLayerToTiles, docTreeToComp, safeMode } from "./gl-doc-bridge.ts";
import { LayerPixels, replaceFromCanvas } from "./tile-pixels.ts";
import type { DocNode, DocLeaf, LayerTiles } from "./gl-doc-bridge.ts";
import type { OverlayDesc, FloatDesc } from "./gl-compose-plan.ts";
import { GLStampRasterizer } from "./gl-stamp.ts";
import type { Stamp, StrokeShape } from "./gl-stamp.ts";
import type { PooledFBO, FBOPrec, GLContext } from "./gl-context.ts";

// board 传入的自由变换浮层（**GPU warp 输入**）：未 warp 的源纹理 canvas（拖动中稳定，srcW×srcH）+ 逆单应性
//   Hinv（每帧更新）+ sampleMode + 落在哪个源层 z。源纹理按 srcCanvas 引用缓存，**只在内容变时重传**。
// 颜色调整 live preview 替身：活动层用这张 canvas（doc (bx,by) 起 w×h）当 GPU tiles 显示（非破坏）。
export interface SurrogateInput { layerId: number; canvas: CanvasImageSource; bx: number; by: number; w: number; h: number; }

export interface FloatInput {
  layerId: number;
  srcCanvas: CanvasImageSource;   // 未 warp 源像素（稳定引用 → 复用 GPU 纹理）
  srcW: number; srcH: number;
  hinv: number[];                 // 9，row-major，doc→源单位方格
  mode: number;                   // 0=nearest 1=bilinear 2=bicubic
}

// board 传入的 GPU brush stamp overlay（Stage 3：替 CPU overlayCanvas）。bx/by/bw/bh = stamp 包围盒 doc 坐标。
//   lockAlpha + selMask：在 GPU overlay shader 里裁剪（替代 CPU 的 _clipOverlayMasks dst-in）。
export interface StampOverlayInput {
  stamps: Stamp[]; shape: StrokeShape;
  bx: number; by: number; bw: number; bh: number;
  layerId: number; opacity: number; erase: boolean; blendMode: string;
  lockAlpha: boolean;
  selMask: { canvas: CanvasImageSource; ox: number; oy: number; ow: number; oh: number } | null;
}

export class GLDocRenderer {
  private _glctx: GLContext;
  private _backend: GLTileBackend;
  private _pool: TilePool;
  private _comp: GLCompositor;
  private _rasterizer: GLStampRasterizer;
  private _overlayOwnedFBO: PooledFBO | null = null;   // setStampOverlay 借的 straight FBO，合成后归还
  private _layerTiles = new Map<number, LayerTiles>();
  private _selTex: WebGLTexture | null = null;   // GPU overlay 选区蒙版（复用，每帧重传）
  private _overlay: { tex: WebGLTexture; layerId: number; opacity: number; erase: boolean; blendMode: string; ox: number; oy: number; ow: number; oh: number; lockAlpha: boolean; selMask: { tex: WebGLTexture; ox: number; oy: number; ow: number; oh: number } | null } | null = null;
  // 自由变换浮层：per-源层 id 一张复用纹理（warp 每帧变，重传）+ 当前帧描述。
  private _floatTex = new Map<number, { tex: WebGLTexture; canvas: CanvasImageSource | null }>();
  private _floats = new Map<number, FloatDesc>();

  constructor(glctx: GLContext, capacity: number, accumPrec: FBOPrec = "f16") {
    this._glctx = glctx;
    this._backend = new GLTileBackend(glctx, capacity);
    this._pool = new TilePool(this._backend);
    this._comp = new GLCompositor(glctx, accumPrec);
    this._rasterizer = new GLStampRasterizer(glctx);
  }

  // 内存核算（接 computeMaxLayers 软上限 / HUD）。committed = 池预分配；used = 实占 tile。
  get memory(): { usedTiles: number; capacity: number; usedBytes: number; committedBytes: number } {
    return { usedTiles: this._pool.allocatedCount, capacity: this._pool.capacity, usedBytes: this._pool.byteUsage, committedBytes: this._backend.committedBytes };
  }

  // 重传一个叶层像素 → tiles（内容变更后调）。
  syncLayer(leaf: DocLeaf, docW: number, docH: number): void {
    const old = this._layerTiles.get(leaf.id);
    if (old) { old.index.dispose(); old.tileMap.clear(); }
    this._layerTiles.set(leaf.id, uploadLayerToTiles(this._glctx, this._backend, this._pool, leaf, docW, docH));
  }

  // 把一张 canvas（doc (bx,by) 起 w×h）当某层的 GPU tiles 上传（颜色调整 live preview 的替身 surrogate）。
  //   **非破坏**：不碰 layer.pixels（真 SoT），只覆盖该层 GPU tiles；surrogate 清除后 board markContentDirty →
  //   syncAll 从真像素重传恢复。临时 LayerPixels（preview 滑块驱动，非每帧热循环）。
  syncLayerFromCanvas(leafId: number, canvas: CanvasImageSource, bx: number, by: number, w: number, h: number, docW: number, docH: number): void {
    const tmp = new LayerPixels(docW, docH);
    replaceFromCanvas(tmp, canvas, bx, by, w, h);
    const old = this._layerTiles.get(leafId);
    if (old) { old.index.dispose(); old.tileMap.clear(); }
    this._layerTiles.set(leafId, uploadLayerToTiles(this._glctx, this._backend, this._pool, { pixels: tmp }, docW, docH));
  }

  // 重传整棵树所有叶（correctness-first）。
  syncAll(nodes: DocNode[], docW: number, docH: number): void {
    this._eachLeaf(nodes, (l) => this.syncLayer(l, docW, docH));
  }

  // 删层时释放其资源。
  dropLayer(id: number): void {
    const r = this._layerTiles.get(id);
    if (r) { r.index.dispose(); r.tileMap.clear(); this._layerTiles.delete(id); }
  }

  // 清掉上帧 live overlay（无 brush stamp overlay 的帧调；CPU canvas overlay 路径已删，brush live 走 setStampOverlay）。
  clearOverlay(): void { this._overlay = null; }

  // Stage 3：用 GPU stamp 栅格器把 brush stamp 列表栅格成 overlay（替 CPU overlayCanvas）。
  //   栅格器出**预乘** FBO → presentTo 解预乘成 straight FBO（overlay shader 吃 straight，与 CPU canvas overlay 同）。
  //   straight FBO 留到本帧合成后归还（_overlayOwnedFBO）。bx/by/bw/bh = stamp 包围盒 doc 坐标。
  setStampOverlay(ov: StampOverlayInput): void {
    if (ov.stamps.length === 0 || ov.bw <= 0 || ov.bh <= 0) { this._overlay = null; return; }
    const gl = this._glctx.gl;
    const fboP = this._rasterizer.rasterize(ov.stamps, ov.shape, ov.bx, ov.by, ov.bw, ov.bh);   // 预乘
    const fboS = this._glctx.borrowFBO(ov.bw, ov.bh, "u8");
    this._comp.presentTo(fboP.tex, fboS, ov.bw, ov.bh);                        // → straight
    this._glctx.returnFBO(fboP);
    if (this._overlayOwnedFBO) this._glctx.returnFBO(this._overlayOwnedFBO);   // 上帧残留（保险）
    this._overlayOwnedFBO = fboS;
    // 选区蒙版上传（lockAlpha 用 base.a，shader 内裁，不需纹理）。
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
      gl.bindTexture(gl.TEXTURE_2D, this._selTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ov.selMask.canvas as TexImageSource);
      gl.bindTexture(gl.TEXTURE_2D, null);
      selMask = { tex: this._selTex, ox: ov.selMask.ox, oy: ov.selMask.oy, ow: ov.selMask.ow, oh: ov.selMask.oh };
    }
    this._overlay = { tex: fboS.tex, layerId: ov.layerId, opacity: ov.opacity, erase: ov.erase, blendMode: ov.blendMode, ox: ov.bx, oy: ov.by, ow: ov.bw, oh: ov.bh, lockAlpha: ov.lockAlpha, selMask };
  }

  // Stage 3：栅格化 stroke stamp 列表 → straight RGBA canvas（commit 用，readback→editRegion）。
  rasterizeStrokeToCanvas(stamps: Stamp[], shape: StrokeShape, bx: number, by: number, bw: number, bh: number): { canvas: HTMLCanvasElement; dstX: number; dstY: number } | null {
    if (stamps.length === 0 || bw <= 0 || bh <= 0) return null;
    const gl = this._glctx.gl;
    const fboP = this._rasterizer.rasterize(stamps, shape, bx, by, bw, bh);
    const fboS = this._glctx.borrowFBO(bw, bh, "u8");
    this._comp.presentTo(fboP.tex, fboS, bw, bh);                              // 解预乘
    const px = new Uint8Array(bw * bh * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboS.fbo);
    gl.readPixels(0, 0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._glctx.returnFBO(fboP); this._glctx.returnFBO(fboS);
    const canvas = document.createElement("canvas"); canvas.width = bw; canvas.height = bh;
    canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), bw, bh), 0, 0);
    return { canvas, dstX: bx, dstY: by };
  }

  // commit 烤定：warp 源 → straight canvas（floating-transform._bakeDown 用，复用 live 同采样器）。
  warpToCanvas(srcCanvas: TexImageSource, srcW: number, srcH: number, hinv: number[], mode: number, bx: number, by: number, bw: number, bh: number) {
    return this._comp.warpToCanvas(srcCanvas, srcW, srcH, hinv, mode, bx, by, bw, bh);
  }

  // 设置/清除自由变换浮层（board 每帧调；空数组=无）。GPU warp：**源纹理只在 srcCanvas 引用变时重传**（拖动中
  //   源像素稳定 → 整条拖动只上传一次），每帧只更新 Hinv/mode（_floats 里）。这是把 warp 移上 GPU 的性能本质。
  setFloats(floats: FloatInput[], _docW: number, _docH: number): void {
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
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);   // 存直值（shader 自己处理）
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f.srcCanvas as TexImageSource);
        entry.canvas = f.srcCanvas;
      }
      this._floats.set(f.layerId, { tex: entry.tex, srcW: f.srcW, srcH: f.srcH, hinv: f.hinv, mode: f.mode });
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    // 回收不再用的源层纹理
    for (const [id, e] of this._floatTex) if (!seen.has(id)) { gl.deleteTexture(e.tex); this._floatTex.delete(id); }
  }

  // 合成整棵树 → 可见画布（视口仿射 = board _applyDocTransform 的 6 参；含 live overlay）。需先 sync。
  // bg = doc 背景色（预乘 [r,g,b,a]；缺省透明）。
  renderToScreenAffine(nodes: DocNode[], docW: number, docH: number, affine: number[], canvasW: number, canvasH: number, bg?: Background): void {
    const accum = this._composite(nodes, docW, docH, bg);
    this._comp.presentToScreenAffine(accum.tex, docW, docH, affine, canvasW, canvasH);
    this._glctx.returnFBO(accum);
  }

  // 整文档 1:1 铺满 present（预览页/无视口场景）。
  renderToScreen(nodes: DocNode[], docW: number, docH: number, canvasW: number, canvasH: number): void {
    const accum = this._composite(nodes, docW, docH);
    this._comp.presentToScreen(accum.tex, canvasW, canvasH);
    this._glctx.returnFBO(accum);
  }

  // 合成 → 预乘累积器 FBO（caller 负责 returnFBO/present/readback）。给 GLBoard 缓存 + 导出/缩略图/吸管复用。
  // bg = doc 背景色（预乘）。setOverlay 先调（描边时）。
  composite(nodes: DocNode[], docW: number, docH: number, bg?: Background): PooledFBO {
    return this._composite(nodes, docW, docH, bg);
  }
  // 把一张（缓存的）合成纹理按视口仿射 present 到屏（pan/zoom 只走这步，便宜）。smooth 见 compositor。
  presentAffine(tex: WebGLTexture, docW: number, docH: number, affine: number[], canvasW: number, canvasH: number, smooth: boolean): void {
    this._comp.presentToScreenAffine(tex, docW, docH, affine, canvasW, canvasH, smooth);
  }
  returnFBO(fbo: PooledFBO): void { this._glctx.returnFBO(fbo); }

  private _composite(nodes: DocNode[], docW: number, docH: number, bg?: Background): PooledFBO {
    const ov = this._overlay;
    const tree = docTreeToComp(
      nodes,
      (leaf) => {
        const r = this._layerTiles.get(leaf.id);
        if (!r) throw new Error(`LAYER_NOT_SYNCED:${leaf.id}`);   // syncAll 后每叶都在表（空层=空 index）
        return { index: r.index, hasContent: r.tileMap.tileCount > 0 };
      },
      ov ? (leaf): OverlayDesc | null => (leaf.id === ov.layerId ? { tex: ov.tex, opacity: ov.opacity, erase: ov.erase, blendMode: safeMode(ov.blendMode), ox: ov.ox, oy: ov.oy, ow: ov.ow, oh: ov.oh, lockAlpha: ov.lockAlpha, selMask: ov.selMask } : null) : undefined,
      this._floats.size ? (leaf): FloatDesc | null => this._floats.get(leaf.id) ?? null : undefined,
    );
    const result = this._comp.composite(this._backend.texture, tree, docW, docH, bg);
    if (this._overlayOwnedFBO) { this._glctx.returnFBO(this._overlayOwnedFBO); this._overlayOwnedFBO = null; }   // overlay tex 已烤进 accum
    return result;
  }

  private _eachLeaf(nodes: DocNode[], fn: (leaf: DocLeaf) => void): void {
    for (const n of nodes) {
      if (n.isGroup) this._eachLeaf(n.children, fn);
      else fn(n);
    }
  }
}

// 给 capacity 取整的便利：按显存预算（字节）算 tile 池深度（§4.2 软上限，Stage 0 真机校准）。
export function poolCapacityForBudget(budgetBytes: number): number {
  return Math.max(64, Math.floor(budgetBytes / TILE_BYTES));
}
