// GLDocRenderer —— doc 图层树 → 屏幕的编排（docs/20260614-perf-webgl-memory-clip.md §5.5）。
// 持有：tile 池(GLTileBackend+TilePool)、合成器、每层 GL 资源(index+tileMap)、复用 scratch。
// 这是 board 接线时持有的顶层对象。脏跟踪（只重传变更层）是优化，先 correctness-first 全重传。
//
// 接 board 时：board 持一个 GLDocRenderer；内容变更 syncLayer(脏层)；每帧 renderToScreen(doc.layers)。
// 视口 pan/zoom 暂为整文档 1:1 fit；真视口变换 = 接 board 时加（present 带 view matrix）。

import { GpuTilePool, GLGpuTileBackend, IndexTexture, GPU_TILE_BYTES } from "./gpu-tile-pool.ts";
import { CpuGpuTileBridge } from "./tile-bridge.ts";
import { appTilePool } from "../tiles/app-tile-pool.ts";
import { tilesAcross, tilesDown } from "../tiles/tile-geometry.ts";
import { GLCompositor } from "./gl-compositor.ts";
import type { Background } from "./gl-compositor.ts";
import { docTreeToComp, safeMode } from "./gl-doc-bridge.ts";
import { LayerPixels, replaceFromCanvas } from "./tile-pixels.ts";
import type { DocNode, DocLeaf } from "./gl-doc-bridge.ts";
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
  // v0.4.6：选区 mask 直传 gray8 平面（Selection.bboxMask() 的缓存 buffer；R8 纹理，shader 采 .r）。
  //   S7 改走 cpu-gpu-tile-bridge（per-tile 上传 + 复用）。
  selMask: { data: Uint8Array; ox: number; oy: number; ow: number; oh: number } | null;
}

// 每叶的 GPU 侧驻留记录：tileKey → gpuId + 寻址纹理。
// 快路径三元组：(src 实例身份, contentVersion, pool 代) 全中 → 整层跳过（零遍历零上传）。
//   身份防「层被 setPixels 换了新 LayerPixels 但 version 撞号」；代防「pool recreate 后 id 全死」。
interface LeafTiles { index: IndexTexture; byKey: Map<number, number>; src: LayerPixels | null; cpuVersion: number; gen: number }

export class GLDocRenderer {
  private _glctx: GLContext;
  private _backend: GLGpuTileBackend;
  private _pool: GpuTilePool;
  private _bridge: CpuGpuTileBridge;
  private _comp: GLCompositor;
  private _rasterizer: GLStampRasterizer;
  private _overlayOwnedFBO: PooledFBO | null = null;   // setStampOverlay 借的 straight FBO，合成后归还
  private _layerTiles = new Map<number, LeafTiles>();
  private _selTex: WebGLTexture | null = null;   // GPU overlay 选区蒙版（复用；同一 buffer 不重传）
  private _selTexSrc: Uint8Array | null = null;  // 上次上传的 gray8 buffer 身份（Selection 不可变 → 身份即内容）
  private _overlay: { tex: WebGLTexture; layerId: number; opacity: number; erase: boolean; blendMode: string; ox: number; oy: number; ow: number; oh: number; lockAlpha: boolean; selMask: { tex: WebGLTexture; ox: number; oy: number; ow: number; oh: number } | null } | null = null;
  // 自由变换浮层：per-源层 id 一张复用纹理（warp 每帧变，重传）+ 当前帧描述。
  private _floatTex = new Map<number, { tex: WebGLTexture; canvas: CanvasImageSource | null }>();
  private _floats = new Map<number, FloatDesc>();

  constructor(glctx: GLContext, maxSlices: number, accumPrec: FBOPrec = "u8") {   // S7：直值 rgba8 累积器（spec:247，省一半显存）
    this._glctx = glctx;
    // 惰性容量（spec:170）：初始 64 slices（16MiB），reserve 时 quota 内翻倍 grow。
    this._backend = new GLGpuTileBackend(glctx, Math.min(64, maxSlices));
    this._pool = new GpuTilePool(this._backend, maxSlices);
    this._bridge = new CpuGpuTileBridge(this._pool);
    // 显示中的叶层 tile 全部 required（7b render-tree 化后细分为 plan 的 pinLeaves/段两档）。
    this._pool.registerPinProvider(() => {
      const required = new Set<number>();
      for (const rec of this._layerTiles.values()) for (const id of rec.byKey.values()) required.add(id);
      return { required, preferred: new Set<number>() };
    });
    this._comp = new GLCompositor(glctx, accumPrec);
    this._rasterizer = new GLStampRasterizer(glctx);
  }

  // 内存核算（接 computeMaxLayers 软上限 / HUD）。committed = 当前已分配纹理（惰性增长）；
  //   quota = 增长上限（board 预算口径用它，别用 committed——初始才 16MiB）。
  get memory(): { usedTiles: number; capacity: number; usedBytes: number; committedBytes: number; quotaBytes: number } {
    return {
      usedTiles: this._pool.allocatedCount, capacity: this._pool.capacity,
      usedBytes: this._pool.allocatedCount * GPU_TILE_BYTES,
      committedBytes: this._pool.committedBytes, quotaBytes: this._pool.quotaBytes,
    };
  }

  // 上一次合成的 pass 计数（dev HUD；compositor 在 composite() 入口清零）。
  get stats(): { passes: number; floatPasses: number } { return this._comp.stats; }
  // FBO 池占用（dev HUD：确认有界）。
  get fboPoolStats(): { count: number; bytes: number } { return this._glctx.fboPoolStats; }

  // 同步一个叶层像素 → GPU tiles。**增量**：tile 不可变 + bridge 按 cpu id 去重 → 只有内容
  //   变了的 tile 真上传；(身份,版本,代) 三元组全中直接整层跳过。压缩驻留的 tile 若 GPU 副本
  //   还活着，连解压都不发生（bridge 惰性取 bytes）。
  syncLayer(leaf: DocLeaf, docW: number, docH: number): void {
    try { this._syncPixels(leaf.id, leaf.pixels, docW, docH); } catch (e) {
      // 池连驱逐后都塞不下（内容超显存 quota）：该层保持陈旧/部分显示，压力缓解后自愈。
      //   与旧「池满 tileAt 返 null 跳过」降级对齐；不让渲染循环崩。
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
    // 映射变没变（gpu id 集合逐格比对）→ 变了才重建 index 纹理。
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

  // 把一张 canvas（doc (bx,by) 起 w×h）当某层的 GPU tiles 上传（颜色调整 live preview 的替身 surrogate）。
  //   **非破坏**：不碰 layer.pixels（真 SoT），只覆盖该层 GPU tiles；surrogate 清除后 board markContentDirty →
  //   syncAll 从真像素重传恢复。临时 LayerPixels（preview 滑块驱动，非每帧热循环）。
  syncLayerFromCanvas(leafId: number, canvas: CanvasImageSource, bx: number, by: number, w: number, h: number, docW: number, docH: number): void {
    const tmp = new LayerPixels(docW, docH);
    replaceFromCanvas(tmp, canvas, bx, by, w, h);
    this._syncPixels(leafId, tmp, docW, docH);
    this._layerTiles.get(leafId)!.src = null;   // tmp 即将 dispose，快路径身份作废（下次必走慢路径）
    tmp.dispose();   // 上传已完成（ensureUploaded 同步读完）；映射里的死 cpu id 由 purge 清
    this._bridge.purgeDead(this._cpuAlive());
  }

  // 同步整棵树所有叶 + 对账已删层（陈旧 _layerTiles 丢记录，其 gpu tile 变孤儿由 frameMaintain 回收）。
  //   帧首 reserve：容量一次到位（grow 若发生，随后的逐层 sync 因 gen 变自动走全量重传）。
  syncAll(nodes: DocNode[], docW: number, docH: number): void {
    let total = 0;
    this._eachLeaf(nodes, (l) => { total += l.pixels.tileCount; });
    if (!this._pool.reserve(total)) {
      // quota 也放不下（层数×内容超显存预算）：尽力同步，塞不进的 tile 由 GPU_POOL_EXHAUSTED
      //   降级为该层部分缺 tile（缺格 index=-1=透明）。与旧「池满 tileAt 返 null 跳过」行为对齐。
    }
    const live = new Set<number>();
    this._eachLeaf(nodes, (l) => { live.add(l.id); this.syncLayer(l, docW, docH); });
    for (const id of [...this._layerTiles.keys()]) if (!live.has(id)) this.dropLayer(id);
    this._bridge.purgeDead(this._cpuAlive());
  }

  private _cpuAlive(): (id: number) => boolean {
    const alive = new Set<number>();
    appTilePool().forEachLiveId((id: number) => alive.add(id));
    return (id) => alive.has(id);
  }

  // context-loss 恢复：底层 array texture 随 context 失效 → 全部作废重建；bridge 映射清空；
  //   之后 syncAll 从各层 CPU SSoT 全新重传（CPU 恒驻留，池管压缩）。
  handleContextRestored(): void {
    this._pool.clearAll();      // recreate backend（旧纹理句柄已死，删除无害）+ 全 id 作废
    this._bridge.clear();
    this._layerTiles.clear();   // 旧 index 的 GL 句柄已随 context 失效，弃引用（死对象 GC；不 dispose）
    this._selTex = null;        // v0.4.6：选区纹理随 context 死 → 弃引用，下次 setStampOverlay 重建重传
    this._selTexSrc = null;
  }

  // 删层时丢弃记录；其 gpu tile 变孤儿，syncAll 尾部的 frameMaintain 回收。
  dropLayer(id: number): void {
    const r = this._layerTiles.get(id);
    if (r) { r.index.dispose(); this._layerTiles.delete(id); }
  }

  // 清掉上帧 live overlay（无 brush stamp overlay 的帧调；CPU canvas overlay 路径已删，brush live 走 setStampOverlay）。
  clearOverlay(): void { this._overlay = null; }

  // Stage 3：用 GPU stamp 栅格器把 brush stamp 列表栅格成 overlay（替 CPU overlayCanvas）。
  //   栅格器出**预乘** FBO → presentTo 解预乘成 straight FBO（overlay shader 吃 straight，与 CPU canvas overlay 同）。
  //   straight FBO 留到本帧合成后归还（_overlayOwnedFBO）。bx/by/bw/bh = stamp 包围盒 doc 坐标。
  setStampOverlay(ov: StampOverlayInput, docW: number, docH: number): void {
    if (ov.stamps.length === 0 || ov.bw <= 0 || ov.bh <= 0) { this._overlay = null; return; }
    const gl = this._glctx.gl;
    // **整屏 doc FBO + scissor**（避免每帧按 bbox 尺寸 malloc）：栅格器/straight 都按 doc 尺寸借 → 池每帧同尺寸命中、
    //   零重复 malloc、零泄露；着色靠 scissor 限回 stamp bbox（GPU 成本不变）。overlay 描述符随之变整屏（ox0/oy0/ow=docW）。
    const fboP = this._rasterizer.rasterize(ov.stamps, ov.shape, 0, 0, docW, docH, { x: ov.bx, y: ov.by, w: ov.bw, h: ov.bh });   // 预乘，整屏
    const fboS = this._glctx.borrowFBO(docW, docH, "u8");
    this._comp.presentTo(fboP.tex, fboS, docW, docH, true);                    // 栅格器预乘 → straight（整屏，bbox 外透明）
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
      if (this._selTexSrc !== ov.selMask.data) {   // 选区没换就不重传（Selection 不可变，buffer 身份稳定）
        gl.bindTexture(gl.TEXTURE_2D, this._selTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);    // gray8 行宽任意 → 必须 1 字节对齐（默认 4 会读歪）
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, ov.selMask.ow, ov.selMask.oh, 0, gl.RED, gl.UNSIGNED_BYTE, ov.selMask.data);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this._selTexSrc = ov.selMask.data;
      }
      selMask = { tex: this._selTex, ox: ov.selMask.ox, oy: ov.selMask.oy, ow: ov.selMask.ow, oh: ov.selMask.oh };
    }
    this._overlay = { tex: fboS.tex, layerId: ov.layerId, opacity: ov.opacity, erase: ov.erase, blendMode: ov.blendMode, ox: 0, oy: 0, ow: docW, oh: docH, lockAlpha: ov.lockAlpha, selMask };
  }

  // Stage 3：栅格化 stroke stamp 列表 → straight RGBA canvas（commit 用，readback→editRegion）。
  rasterizeStrokeToCanvas(stamps: Stamp[], shape: StrokeShape, bx: number, by: number, bw: number, bh: number): { canvas: HTMLCanvasElement; dstX: number; dstY: number } | null {
    if (stamps.length === 0 || bw <= 0 || bh <= 0) return null;
    const gl = this._glctx.gl;
    const fboP = this._rasterizer.rasterize(stamps, shape, bx, by, bw, bh);
    const fboS = this._glctx.borrowFBO(bw, bh, "u8");
    this._comp.presentTo(fboP.tex, fboS, bw, bh, true);                        // 栅格器预乘 → 解预乘
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
    // 每帧维护：孤儿 gpu tile（live-sync/CoW 换出的旧 tile、删层残留）回收（spec:174）。
    //   叶层现存 tile 全在 pin required（provider 见 ctor）→ 只清真孤儿，安全。
    this._pool.frameMaintain();
    const ov = this._overlay;
    const tree = docTreeToComp(
      nodes,
      (leaf) => {
        const r = this._layerTiles.get(leaf.id);
        if (!r) throw new Error(`LAYER_NOT_SYNCED:${leaf.id}`);   // syncAll 后每叶都在表（空层=空 index）
        return { index: r.index, hasContent: r.byKey.size > 0 };
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

// 给 quota 取整的便利：按显存预算（字节）算 tile 池深度上限（惰性增长的顶；Stage 0 真机校准）。
export function poolCapacityForBudget(budgetBytes: number): number {
  return Math.max(64, Math.floor(budgetBytes / GPU_TILE_BYTES));
}
