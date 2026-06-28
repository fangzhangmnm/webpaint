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
import { uploadLayerToTiles, docTreeToComp } from "./gl-doc-bridge.ts";
import type { DocNode, DocLeaf, LayerTiles } from "./gl-doc-bridge.ts";
import type { OverlayDesc, FloatDesc } from "./gl-compose-plan.ts";
import type { PooledFBO, FBOPrec, GLContext } from "./gl-context.ts";

// board 传入的 live 描边 overlay（bbox 裁剪 canvas + 落在哪个活动层）。erase = 橡皮（destination-out）。
export interface OverlayInput {
  canvas: CanvasImageSource;
  bboxX: number; bboxY: number; bboxW: number; bboxH: number;
  layerId: number;
  opacity: number;
  erase: boolean;
}

// board 传入的自由变换浮层（warp 后的内容 canvas + doc 坐标位置 + 落在哪个源层 z）。
export interface FloatInput {
  layerId: number;
  canvas: CanvasImageSource;
  dstX: number; dstY: number; w: number; h: number;
}

export class GLDocRenderer {
  private _glctx: GLContext;
  private _backend: GLTileBackend;
  private _pool: TilePool;
  private _comp: GLCompositor;
  private _layerTiles = new Map<number, LayerTiles>();
  // live 描边 overlay：只传**描边 bbox 尺寸**纹理（小），shader 按 bbox 映射。
  private _ovTex: WebGLTexture | null = null;
  private _overlay: { tex: WebGLTexture; layerId: number; opacity: number; erase: boolean; ox: number; oy: number; ow: number; oh: number } | null = null;
  // 自由变换浮层：per-源层 id 一张复用纹理（warp 每帧变，重传）+ 当前帧描述。
  private _floatTex = new Map<number, WebGLTexture>();
  private _floats = new Map<number, FloatDesc>();

  constructor(glctx: GLContext, capacity: number, accumPrec: FBOPrec = "f16") {
    this._glctx = glctx;
    this._backend = new GLTileBackend(glctx, capacity);
    this._pool = new TilePool(this._backend);
    this._comp = new GLCompositor(glctx, accumPrec);
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

  // 重传整棵树所有叶（correctness-first）。
  syncAll(nodes: DocNode[], docW: number, docH: number): void {
    this._eachLeaf(nodes, (l) => this.syncLayer(l, docW, docH));
  }

  // 删层时释放其资源。
  dropLayer(id: number): void {
    const r = this._layerTiles.get(id);
    if (r) { r.index.dispose(); r.tileMap.clear(); this._layerTiles.delete(id); }
  }

  // 设置/清除 live 描边 overlay（board 每帧调；null=无描边）。只传**描边 bbox 尺寸**纹理（小）。
  setOverlay(ov: OverlayInput | null, _docW: number, _docH: number): void {
    if (!ov || ov.bboxW <= 0 || ov.bboxH <= 0) { this._overlay = null; return; }
    const gl = this._glctx.gl;
    if (!this._ovTex) {
      this._ovTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this._ovTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, this._ovTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);   // 存直值（shader 自己处理）
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ov.canvas as TexImageSource);   // bbox 尺寸直传（overlay 是 canvas）
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._overlay = { tex: this._ovTex, layerId: ov.layerId, opacity: ov.opacity, erase: ov.erase, ox: ov.bboxX, oy: ov.bboxY, ow: ov.bboxW, oh: ov.bboxH };
  }

  // 设置/清除自由变换浮层（board 每帧调；空数组=无）。每个浮层=warp 后 canvas 直传 per-源层 id 纹理。
  setFloats(floats: FloatInput[], _docW: number, _docH: number): void {
    const gl = this._glctx.gl;
    this._floats.clear();
    const seen = new Set<number>();
    for (const f of floats) {
      if (f.w <= 0 || f.h <= 0) continue;
      seen.add(f.layerId);
      let tex = this._floatTex.get(f.layerId);
      if (!tex) {
        tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this._floatTex.set(f.layerId, tex);
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);   // 存直值（shader 自己处理）
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f.canvas as TexImageSource);
      this._floats.set(f.layerId, { tex, ox: f.dstX, oy: f.dstY, ow: f.w, oh: f.h });
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    // 回收不再用的源层纹理
    for (const [id, tex] of this._floatTex) if (!seen.has(id)) { gl.deleteTexture(tex); this._floatTex.delete(id); }
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
      ov ? (leaf): OverlayDesc | null => (leaf.id === ov.layerId ? { tex: ov.tex, opacity: ov.opacity, erase: ov.erase, ox: ov.ox, oy: ov.oy, ow: ov.ow, oh: ov.oh } : null) : undefined,
      this._floats.size ? (leaf): FloatDesc | null => this._floats.get(leaf.id) ?? null : undefined,
    );
    return this._comp.composite(this._backend.texture, tree, docW, docH, bg);
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
