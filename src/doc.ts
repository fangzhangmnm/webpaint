// PaintDoc = 模型层（无 DOM）。
//
// 一张 doc 由若干 layer 组成。每个 layer 自带一个固定分辨率的 OffscreenCanvas
// （或退化到 <canvas>）。doc 不负责显示 —— 显示是 Board 的事。
//
// 一期约定（手感优先）：
// - 固定分辨率 2048×2048（DEFAULT_DOC_SIZE）。
// - 初始一个 "图层 1"。后续阶段才上多图层 UI。
// - 没有持久化（proposal："甚至没保存的情况下"）。但 doc 的 API 已经按"会被序列化"
//   去设计 —— 后期换 IndexedDB / OneDrive / 自定义文件格式时不需要重构模型。

import { smartResample } from "./resample.ts";
import { makeBitmap } from "./bitmap.ts";
import { LayerPixels, materialize, editRegion as editPixels, editRegionBytes as editPixelsBytes, replaceFromCanvas as replacePixels, disposePixelsSnapshot, type PixelsSnapshot } from "./tiles/tile-layer.ts";
import { renderNodesToBytes } from "./doc-render.ts";
import { resampleBytes } from "./resample-bytes.ts";

export const DEFAULT_DOC_SIZE = 2048;

let _layerIdCounter = 1;
let _contentRevCounter = 0;   // Layer.contentRev 全局取号（防删层→恢复后 (id,rev) 复用，见 Layer.contentRev 注释）

// 离屏位图 = OffscreenCanvas 或回退的 <canvas>（makeBitmap 返回二者之一）。
type Bitmap = OffscreenCanvas | HTMLCanvasElement;
// 2D 上下文：两种 canvas 的 ctx 形状不同但 API 一致，绘画路径只用共有成员。
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

// 树节点 = 叶（Layer）| 组（LayerGroup）。
type Node = Layer | LayerGroup;

// Layer.snapshot() / restoreFromSnapshot() 共用的像素快照：v0.4.5 起 = **tile 句柄共享**（零拷贝
// undo 包，池的压缩管管内存）。用完必须 disposeLayerSnap（js 无析构）。CPU 算法读者（液化/选区
// mask）要 ImageData 的走 Layer.snapshotImageData()——那是只读物化，不是 undo 包。
export interface LayerSnap { pixels: PixelsSnapshot }
export function disposeLayerSnap(snap: LayerSnap | null | undefined): void {
  if (snap) disposePixelsSnapshot(snap.pixels);
}

// layerSpec() 产物（undo 入栈 / insertLayerAt 复位用）。snap = 句柄快照（同上，需 dispose）。
export interface LayerSpecShape {
  id: number;
  name: string;
  visible?: boolean;
  opacity?: number;
  mode?: string;
  clippingMask?: boolean;
  lockAlpha?: boolean;
  snap?: LayerSnap | null;
}
export function disposeLayerSpec(spec: LayerSpecShape | null | undefined): void {
  if (spec?.snap) disposeLayerSnap(spec.snap);
}

// 深快照的句柄释放（DocTransformOp 驱逐/清栈时用；组递归，叶放 snap）。
export function disposeDeepSnapNodes(nodes: DeepSnapNode[]): void {
  for (const n of nodes) {
    if (n.isGroup) disposeDeepSnapNodes(n.children || []);
    else disposeLayerSnap(n.snap);
  }
}

// snapshotTree() / restoreTree() 的结构记录（叶存活引用，组存元信息 + children）。
type TreeSnapNode =
  | { isGroup: false; ref: Layer }
  | {
      isGroup: true;
      id: number;
      name: string;
      visible: boolean;
      opacity: number;
      mode: string;
      clippingMask: boolean;
      collapsed: boolean;
      children: TreeSnapNode[];
    };

// snapshotAll() / _nodeSnap() 的深快照记录（叶含像素 snap，组含 children specs）。
export type DeepSnapNode =
  | {
      isGroup: false;
      id: number;
      name: string;
      visible: boolean;
      opacity: number;
      mode: string;
      clippingMask: boolean;
      lockAlpha: boolean;
      snap: LayerSnap;
    }
  | {
      isGroup: true;
      id: number;
      name: string;
      visible: boolean;
      opacity: number;
      mode: string;
      clippingMask: boolean;
      collapsed: boolean;
      children: DeepSnapNode[];
    };

// 选区对象：selection.ts 拥有真类型（batch 14 起直接 import，替原本地 SelectionLike 镜像）。
import type { Selection } from "./selection.ts";

export class Layer {
  id: number;
  isGroup: false;
  name: string;
  visible: boolean;
  opacity: number;
  mode: string;
  clippingMask: boolean;
  lockAlpha: boolean;
  docW: number;
  docH: number;
  // 像素真源 = 稀疏 tile（bbox-free）。canvas/bbox 是派生视图（见 getter）。
  pixels: LayerPixels;
  private _mat: { canvas: Bitmap; ox: number; oy: number } | null = null;   // 物化视图缓存（读者用；写后失效）
  private _empty: Bitmap | null = null;                                      // 空层 1×1 占位
  // 内容版本：每次像素写换号（_invalidate 是所有写路径的汇拢点）。消费者=线稿分区缓存
  //   （lineart-oracle）这类「按层内容做贵预计算」的失效判据。releaseMaterialized 纯腾内存不换号。
  //   取号走**全局单调计数器**（构造时也取）：删层→undo 恢复会保留同一 layer id、若 rev 从 0
  //   重数则 (id,rev) 可能撞上旧缓存——全局计数让 (id,rev) 永不复用，同 (id,rev) ⟺ 同内容态。
  contentRev = ++_contentRevCounter;

  constructor({ width, height, name }: { width: number; height: number; name?: string; empty?: boolean } = {} as { width: number; height: number; name?: string; empty?: boolean }) {
    this.id = _layerIdCounter++;
    this.isGroup = false;            // 树节点判别：Layer=叶。LayerGroup 覆为 true。
    this.name = name || `图层 ${this.id}`;
    this.visible = true;
    this.opacity = 1;
    this.mode = "source-over";       // Canvas2D globalCompositeOperation
    this.clippingMask = false;       // true → 被剪裁到「下方第一颗非剪裁层」alpha；连续剪裁层链共基底（Procreate）
    this.lockAlpha = false;          // v242 锁定不透明度：true → 笔只改已有像素颜色（source-atop）
    this.docW = width;
    this.docH = height;
    // 初始无内容（旧 base 层也是透明全 doc canvas = 无内容）。tile 按需分配 → 新层 ≈ 0 内存。
    this.pixels = new LayerPixels(width, height);
  }

  // ---- 派生只读视图（读者：2D 合成器 / ora / psd / 导出 / board / 吸管）----
  // 物化整内容为一张**紧内容框**画布（缓存；任何写后 _invalidate 失效）。空层 → 1×1 占位。
  // tight=true：origin/尺寸 = 紧贴像素的 bbox（不是 tile 粒度），让 bboxX/Y/W/H 与旧系统语义一致——
  // ora/psd/导出读这层当 (canvas, bboxX, bboxY) 配对，紧框既省 PNG 体积又匹配旧 .ora 输出。
  private _ensureMat(): { canvas: Bitmap; ox: number; oy: number } {
    if (this._mat) return this._mat;
    const m = materialize(this.pixels, true);
    if (m) { this._mat = { canvas: m.canvas as Bitmap, ox: m.ox, oy: m.oy }; return this._mat; }
    if (!this._empty) this._empty = makeBitmap(1, 1);
    this._mat = { canvas: this._empty, ox: 0, oy: 0 };
    return this._mat;
  }
  private _invalidate() { this._mat = null; this.contentRev = ++_contentRevCounter; }

  // 释放物化 canvas 缓存（保留 tile SoT，下次 getter 访问按需重建）。切片②：GL 模式下合成直读 tile、
  //   不碰 layer.canvas → 非活动层的物化 canvas 是纯冗余（~docW·docH·4，2K≈16.8MB/层）。board 每帧 GL 渲染后
  //   （非 livePreview）对各层调此 → GL 模式不再常驻第二份像素拷贝（消除 tiling 迁移引入的内存翻倍）。
  //   _invalidate 是写后失效（语义=内容变），releaseMaterialized 是纯腾内存（语义=缓存可弃）——分名以免混淆。
  releaseMaterialized() { this._mat = null; }

  // 实占 RAM 字节：稀疏 tile + （countMat 且持有时）物化 canvas。GL 模式 countMat=false → 单份计费（多放层）；
  //   2D 模式 countMat=true → 双份计费（保守、防 OOM）。给 doc.maxLayers 动态字节预算。
  residentBytes(countMat: boolean): number {
    const mat = (countMat && this._mat) ? this._mat.canvas.width * this._mat.canvas.height * 4 : 0;
    return this.pixels.byteUsage + mat;
  }

  // canvas / ctx：旧读者照用（drawImage 源 / getImageData）。**写请走 editRegion，别写这个 ctx**（写丢）。
  get canvas(): Bitmap { return this._ensureMat().canvas; }
  get ctx(): Ctx { return this._ensureMat().canvas.getContext("2d", { willReadFrequently: true }) as Ctx; }
  // bbox = 物化视图的 doc 框（tile 粒度）。空层 = 0（对齐旧行为）。
  get bboxX(): number { return this.pixels.isEmpty() ? 0 : this._ensureMat().ox; }
  get bboxY(): number { return this.pixels.isEmpty() ? 0 : this._ensureMat().oy; }
  get bboxW(): number { return this.pixels.isEmpty() ? 0 : this._ensureMat().canvas.width; }
  get bboxH(): number { return this.pixels.isEmpty() ? 0 : this._ensureMat().canvas.height; }
  get width() { return this.bboxW; }
  get height() { return this.bboxH; }

  // ---- 写者入口 ----
  // 编辑 doc 矩形 [x0,y0,w,h]：fn(ctx, ox, oy) 在该区画（ctx 已含现有像素；doc 坐标 d 处画 = ctx 坐标 d-ox/d-oy）。
  //   blend/erase/lockAlpha 这类对已有像素合成的写法天然正确（fn 看到的就是现有像素）。
  editRegion(x0: number, y0: number, w: number, h: number, fn: (ctx: CanvasRenderingContext2D, ox: number, oy: number) => void) {
    editPixels(this.pixels, x0, y0, w, h, fn);
    this._invalidate();
  }
  // 字节版（v0.6.41）：fn 直改 straight RGBA 缓冲，零 canvas premult 往返（笔刷像素模式/选区填清用）。
  editRegionBytes(x0: number, y0: number, w: number, h: number, fn: (buf: Uint8ClampedArray, ox: number, oy: number) => void) {
    editPixelsBytes(this.pixels, x0, y0, w, h, fn);
    this._invalidate();
  }
  // 整体从一张 canvas 重建（变换 / 合并 / 导入 / ora）：srcCanvas 内容在 doc (ox,oy) 起、w×h。
  replaceFromCanvas(srcCanvas: CanvasImageSource, ox: number, oy: number, w: number, h: number) {
    replacePixels(this.pixels, srcCanvas, ox, oy, w, h);
    this._invalidate();
  }
  // 整层替换（字节版，v0.6.39 去 canvas 化）：清空 + putRegion，零 premult 往返。
  replaceFromBytes(data: Uint8ClampedArray, ox: number, oy: number, w: number, h: number) {
    this.pixels.clear();
    if (w > 0 && h > 0) this.pixels.putRegion(ox, oy, w, h, data);
    this._invalidate();
  }
  // 清空全层。
  clearAll() { this.pixels.clear(); this._invalidate(); }

  // 换一整套 pixels（纯变换 flip/rotate/offset/crop 用：变换返回新 LayerPixels）+ 新 doc 尺寸。
  setPixels(p: LayerPixels, newDocW: number, newDocH: number) {
    const old = this.pixels;
    this.pixels = p; this.docW = newDocW; this.docH = newDocH; this._invalidate();
    if (old && old !== p) old.dispose();   // v0.4：句柄显式释放（变换已把内容拷进新实例）
  }

  // 重置像素到**新 doc 尺寸** + 可选填入一张 canvas（crop / rotate / resample 等改 doc 尺寸的变换用——
  //   tile 几何依赖 docW，尺寸变必须重建 LayerPixels）。src=null → 空层。src 内容在 doc (ox,oy) 起、w×h。
  remapPixels(newDocW: number, newDocH: number, src: CanvasImageSource | null, ox = 0, oy = 0, w = 0, h = 0) {
    this.docW = newDocW;
    this.docH = newDocH;
    this.pixels.dispose();   // v0.4：句柄显式释放
    this.pixels = new LayerPixels(newDocW, newDocH);
    if (src && w > 0 && h > 0) replacePixels(this.pixels, src, ox, oy, w, h);
    this._invalidate();
  }
  // 字节版（v0.6.46）：resize/裁剪模板 commit 用，零 canvas。
  remapPixelsBytes(newDocW: number, newDocH: number, data: Uint8ClampedArray | null, ox: number, oy: number, w: number, h: number) {
    this.docW = newDocW;
    this.docH = newDocH;
    this.pixels.dispose();
    this.pixels = new LayerPixels(newDocW, newDocH);
    if (data && w > 0 && h > 0) this.pixels.putRegion(ox, oy, w, h, data);
    this._invalidate();
  }

  // doc 坐标采样（吸色）。tile 精确取点，bbox 外透明。
  sampleAt(docX: number, docY: number) { return this.pixels.sampleAt(Math.floor(docX), Math.floor(docY)); }

  // doc 坐标读/写整块像素（filters / liquify / selection 这类 read-process-write ImageData 用，绕开物化 canvas）。
  getImageData(docX: number, docY: number, w: number, h: number): ImageData {
    return new ImageData(this.pixels.getRegion(docX, docY, w, h), w, h);
  }
  putImageData(docX: number, docY: number, img: ImageData) {
    this.pixels.putRegion(docX, docY, img.width, img.height, img.data);
    this._invalidate();
  }

  // S8 brush GPU commit 落盘口：整块区域替换但只封真变 tile（见 LayerPixels.applyRegionDiff）。
  applyRegionDiff(docX: number, docY: number, w: number, h: number, src: Uint8ClampedArray): { tx: number; ty: number }[] {
    const changed = this.pixels.applyRegionDiff(docX, docY, w, h, src);
    if (changed.length) this._invalidate();
    return changed;
  }

  // S8 encode 冻结（freezeDocForEncode 用）：本叶的零拷贝快照 + 惰性物化视图。
  _freezeLeafView(): FrozenLeaf & { _snap: PixelsSnapshot } {
    const snap = this.pixels.snapshot();
    const docW = this.docW, docH = this.docH;
    const empty = snap.tiles.length === 0;
    let mat: { canvas: Bitmap; ox: number; oy: number } | null = null;
    let tmp: LayerPixels | null = null;
    const ensure = () => {
      if (mat) return mat;
      tmp = new LayerPixels(docW, docH);
      tmp.restore(snap);
      const m = materialize(tmp, true);
      tmp.dispose(); tmp = null;   // 物化后即弃（句柄仍由 snap 持有）
      mat = m ? { canvas: m.canvas as Bitmap, ox: m.ox, oy: m.oy } : { canvas: makeBitmap(1, 1), ox: 0, oy: 0 };
      return mat;
    };
    return {
      isGroup: false as const, id: this.id, name: this.name, opacity: this.opacity, mode: this.mode,
      visible: this.visible, clippingMask: this.clippingMask, lockAlpha: this.lockAlpha,
      docW, docH, _snap: snap,
      get canvas() { return ensure().canvas; },
      get bboxX() { return empty ? 0 : ensure().ox; },
      get bboxY() { return empty ? 0 : ensure().oy; },
      get bboxW() { return empty ? 0 : ensure().canvas.width; },
      get bboxH() { return empty ? 0 : ensure().canvas.height; },
      get width() { return this.bboxW; },
      get height() { return this.bboxH; },
      // v0.6.44 修真机「推送失败 getImageData is not a function」：v0.6.42 把 ora 存层改为
      // L.getImageData 字节直读，但 session push 走的是本冻结视图（session-state unsafe cast 躲过
      // tsc）——冻结视图没这方法。快照 tiles 直读补上（恰好零 canvas，比 ensure() 物化更纯）。
      getImageData(x: number, y: number, w: number, h: number): ImageData {
        const t = new LayerPixels(docW, docH);
        t.restore(snap);
        const d = t.getRegion(x, y, w, h);
        t.dispose();
        return new ImageData(d, w, h);
      },
    };
  }

  // undo 快照：句柄共享，零拷贝（v0.4.5）。归属交给 caller，用完 disposeLayerSnap。
  snapshot(): LayerSnap {
    return { pixels: this.pixels.snapshot() };
  }

  // 还原快照（装 acquire 副本；快照可反复用，最终仍由 owner dispose）。
  restoreFromSnapshot(snap: LayerSnap) {
    this.pixels.restore(snap.pixels);
    this._invalidate();
  }

  // CPU 算法读者的**只读物化**（液化 startSnap / 选区 applyMaskPostStroke）：紧 bbox + ImageData。
  //   不是 undo 包（别拿去 restore；undo 走 snapshot() 句柄）。空层 → imageData:null。
  //   v0.6.39 去 canvas 化：直接 getRegion 字节（旧 materialize→getImageData 走 canvas premult
  //   往返，液化源/选区 preSnap 吃量化损——字节进出不走 canvas 硬原则）。ImageData 只当容器。
  snapshotImageData(): { bboxX: number; bboxY: number; bboxW: number; bboxH: number; imageData: ImageData | null } {
    const b = this.pixels.contentBounds(true);   // tight
    if (!b) return { bboxX: 0, bboxY: 0, bboxW: 0, bboxH: 0, imageData: null };
    return { bboxX: b.x, bboxY: b.y, bboxW: b.w, bboxH: b.h, imageData: new ImageData(this.pixels.getRegion(b.x, b.y, b.w, b.h), b.w, b.h) };
  }
}

// 图层组（文件夹）。容器节点：无 canvas/bbox，持 children（节点数组，0=底）。
// 组也有 visible/opacity/mode/clippingMask —— 合成器对「隔离组」先把子树合到独立 buffer 再整体混
// （见 layer-composite._compositeGroup）。pass-through 组（normal+opacity1+非clip）摊进父级。
export class LayerGroup {
  id: number;
  isGroup: true;
  name: string;
  visible: boolean;
  opacity: number;
  mode: string;
  clippingMask: boolean;
  collapsed: boolean;
  children: Node[];
  constructor({ name, children = [] }: { name?: string; children?: Node[] } = {}) {
    this.id = _layerIdCounter++;
    this.isGroup = true;
    this.name = name || `组 ${this.id}`;
    this.visible = true;
    this.opacity = 1;
    // 默认 "pass-through"（穿透）= PS 组默认：纯收纳、子层和组下方背景混、不隔离。
    // 改成 "source-over"(正常) 或任意混合模式 = 隔离（拍平再混）。见 ADR-0002 + layer-composite.groupNeedsIsolation。
    this.mode = "pass-through";
    this.clippingMask = false;
    this.collapsed = false;         // UI 折叠态（不影响渲染）
    this.children = children;
  }
}

// ---- 树工具（doc / board / panel / ora / undo 复用；节点 = Layer|LayerGroup）----

// 叶序遍历（per-leaf 变换用：crop/flip/rotate/resample 等结构无关操作）。
export function eachLeaf(nodes: Node[], fn: (leaf: Layer) => void) {
  for (const n of nodes) {
    if (n.isGroup) eachLeaf(n.children, fn);
    else fn(n);
  }
}
export function flattenLeaves(nodes: Node[]) {
  const out: Layer[] = [];
  eachLeaf(nodes, (L) => out.push(L));
  return out;
}
// 递归按 id 找节点（叶或组）。
export function findNodeById(nodes: Node[], id: number | null): Node | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.isGroup) {
      const f = findNodeById(n.children, id);
      if (f) return f;
    }
  }
  return null;
}
// 递归找节点的父数组 + index。返回 { parent, parentNode, index, node } 或 null。
//   parent = 持有该节点的数组（根=doc.layers）；parentNode = 持有它的组节点（根层=null）。
export function findParentOf(
  nodes: Node[],
  id: number | null,
  parentNode: LayerGroup | null = null,
): { parent: Node[]; parentNode: LayerGroup | null; index: number; node: Node } | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { parent: nodes, parentNode, index: i, node: n };
    if (n.isGroup) {
      const f = findParentOf(n.children, id, n);
      if (f) return f;
    }
  }
  return null;
}
// 递归数叶子（容量/计数用；组不计）。
export function countLeaves(nodes: Node[]) {
  let n = 0;
  eachLeaf(nodes, () => n++);
  return n;
}
// 加载持久化 id 的树（ORA / snapshot）后，把模块级 id 计数器抬过树里最大 id，
// 防止后续 addLayer/groupSelection 复用一个已存在的 id。递归覆盖叶 + 组。
export function reseedLayerIdCounter(nodes: Node[]) {
  let max = 0;
  const walk = (ns: Node[]) => {
    for (const n of ns) {
      if (typeof n.id === "number" && n.id > max) max = n.id;
      if (n.isGroup) walk(n.children);
    }
  };
  walk(nodes);
  if (max >= _layerIdCounter) _layerIdCounter = max + 1;
}

export class PaintDoc {
  width: number;
  height: number;
  layers: Node[];
  activeId: number | null;
  backgroundColor: string;
  selection: Selection | null;
  referenceLayerId: number | null;
  // 内存预算档（maxLayers 用；board 在 setDoc/构造时按 GL/2D 模式 configureMemory）。
  //   null budget → 用 layerByteBudget() 默认（deviceMemory×0.15）。countMat：2D 模式 _mat 常驻须计费（默认 true，
  //   保守）；GL 模式 release 物化 canvas → false（单份 tile 计费 → 多放层）。
  _memBudgetBytes: number | null = null;
  _memCountMat = true;
  constructor({ width = DEFAULT_DOC_SIZE, height = DEFAULT_DOC_SIZE }: { width?: number; height?: number } = {}) {
    this.width = width;
    this.height = height;
    this.layers = [new Layer({ width, height, name: "图层 1" })];
    this.activeId = this.layers[0].id;   // active = 节点 id（可叶可组）。activeIndex 是扁平叶序兼容垫片。
    // 背景色：手感期固定白纸。后期开 doc.background 概念时再补。
    this.backgroundColor = "#ffffff";
    // 选区（一等公民）。null = 没选区 = 所有像素都可作用。详见 docs/20260528-lasso-and-selection.md。
    //   （v0.4.6：gray8 tile mask + 紧 bbox；类型/所有权纪律见 selection.ts 头注释）
    this.selection = null;
    // 参考层：unique。null = 用 active 层做魔棒 / 油漆桶的源。否则用这一层
    // （线稿在它上面、上色在 active 上的工作流）
    this.referenceLayerId = null;
  }
  // 从一个「已解码的 loaded doc」吸收**模型层**字段（layers / active / 尺寸 / 背景 / 参考层 id）。
  // 只碰模型——屏幕 / 工具 / 笔刷 / 视口 / 参考窗 / 调色板等是 app 编排的事，不进这里
  // （PaintDoc 不知道它们；见 CONTEXT.md）。跨 session 不沿用选区 → selection 清空。
  adoptState(loaded: {
    layers: Node[];
    activeId?: number | null;
    activeIndex?: number;
    width: number;
    height: number;
    backgroundColor: string;
    referenceLayerId?: number | null;
  }) {
    // v0.4：旧树的 tile 句柄显式释放（caller=adoptModel 随后 clearHistory，无人再引用旧树；
    //   loaded.layers 是解码出的新树，与旧树不共对象）。
    if (loaded.layers !== this.layers) eachLeaf(this.layers, (l) => l.pixels.dispose());
    this.layers = loaded.layers;
    if (loaded.activeId != null && findNodeById(this.layers, loaded.activeId)) {
      this.activeId = loaded.activeId;
    } else {
      this.activeIndex = loaded.activeIndex || 0;   // 兼容旧（扁平叶序 index）
    }
    this.width = loaded.width;
    this.height = loaded.height;
    this.backgroundColor = loaded.backgroundColor;
    this.referenceLayerId = loaded.referenceLayerId ?? null;
    if (this.selection && !this.selection.disposed) this.selection.dispose();   // v0.4.6：句柄释放
    this.selection = null;
  }

  // 取参考层 / 没有就返回 null（不是 active；调用方按需 fallback）
  getReferenceLayer() {
    if (this.referenceLayerId == null) return null;
    return findNodeById(this.layers, this.referenceLayerId) || null;
  }
  // 魔棒 / 油漆桶用的 source：reference 优先，否则 active（组不可作源 → null）
  getFloodSourceLayer() {
    const ref = this.getReferenceLayer();
    if (ref && !ref.isGroup) return ref;
    const a = this.activeLayer;
    return a && !a.isGroup ? a : null;
  }

  // active 节点（叶或组）。绘画路径需用 isGroup 护栏（组不可画）。
  get activeLayer() {
    return findNodeById(this.layers, this.activeId) || null;
  }
  // 「能否在当前 active 写像素」单谓词（CONTEXT「requireEditableLeaf」）。所有写/读单叶像素的命令穿它。
  //   返回 {leaf, reason}：reason = null(可写) | "none"(无 active) | "group"(组=硬拒) | "hidden"(隐藏叶=软拒)。
  //   allowHidden=true 放行隐藏叶。变换 / Ctrl+D 不走此谓词（组合法，本就是浮层变换的目的）。
  activeEditableLeaf({ allowHidden = false }: { allowHidden?: boolean } = {}): { leaf: Layer | null; reason: string | null } {
    const a = this.activeLayer;
    if (!a) return { leaf: null, reason: "none" };
    if (a.isGroup) return { leaf: null, reason: "group" };
    if (!a.visible && !allowHidden) return { leaf: null, reason: "hidden" };
    return { leaf: a, reason: null };
  }
  // #17：active 节点（叶或组）自身或任一祖先组隐藏？变换类操作的护栏——它们合法作用于组、
  //   不走 activeEditableLeaf，但对看不见的内容变换 = 盲改（commit 后无视觉反馈），须软拒。
  activeNodeHidden(): boolean {
    let n: Node | null = this.activeLayer;
    while (n) {
      if (!n.visible) return true;
      n = findParentOf(this.layers, n.id)?.parentNode ?? null;
    }
    return false;
  }
  // 兼容垫片：扁平**叶序** index ↔ activeId。旧 consumer（panel 高亮 / session-state 持久化 /
  //   undo 结构 entry）无组时照常用 index；树化后逐个迁到 id。
  get activeIndex() {
    return flattenLeaves(this.layers).findIndex((L) => L.id === this.activeId);
  }
  set activeIndex(i: number) {
    const leaves = flattenLeaves(this.layers);
    const L = leaves[i] || leaves[leaves.length - 1] || null;
    this.activeId = L ? L.id : null;
  }

  // 设内存预算档（board 按 GL/2D 模式调）。budgetBytes=该模式可用驻留字节；countMat=是否把物化 canvas 计入。
  configureMemory(budgetBytes: number, countMat: boolean) {
    this._memBudgetBytes = budgetBytes;
    this._memCountMat = countMat;
  }

  get maxLayers() {
    const leaves = flattenLeaves(this.layers);
    let resident = 0;
    for (const L of leaves) resident += L.residentBytes(this._memCountMat);
    return computeMaxLayers(leaves.length, resident, this._memBudgetBytes ?? layerByteBudget());
  }

  // 兼容：按扁平叶序 index 设 active（老 ORA state 存的是 index）。
  setActive(index: number) {
    const L = flattenLeaves(this.layers)[index];
    if (!L) return false;
    this.activeId = L.id;
    return true;
  }

  setActiveById(id: number) {
    if (!findNodeById(this.layers, id)) return false;
    this.activeId = id;
    return true;
  }

  // 新建 empty 层，插在 active 之上。返回新层 / null（封顶或非法）。
  // v97 命名 conflict-free（user：「图层和笔重命名数字总是很怪，而且反而会发生冲突」）：
  // 找现有「图层 N」最大 N，新层 = N+1。避免 _layerIdCounter 跨 session 重启导致碰撞
  // 新节点的落点：**active 是组 → 插进组内顶部**（子组同理）；否则 active 同级、active 之上。
  //   （user：选中图层组时新建的图层应进组里。）
  _insertAtActive(node: Node) {
    const active = findNodeById(this.layers, this.activeId);
    if (active && active.isGroup) {
      active.children.push(node);                       // 组内顶部（children 末尾 = 栈顶）
    } else {
      const loc = findParentOf(this.layers, this.activeId);
      if (loc) loc.parent.splice(loc.index + 1, 0, node);
      else this.layers.push(node);
    }
  }

  addLayer(name?: string) {
    if (countLeaves(this.layers) >= this.maxLayers) return null;
    const finalName = name || this._nextLayerName();
    const L = new Layer({
      width: this.width,
      height: this.height,
      name: finalName,
      empty: true,
    });
    this._insertAtActive(L);
    this.activeId = L.id;
    return L;
  }

  _nextLayerName() {
    const re = /^图层\s*(\d+)$/;
    let max = 0;
    for (const L of flattenLeaves(this.layers)) {
      const m = re.exec(L.name);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `图层 ${max + 1}`;
  }

  // 删除指定节点（id；叶或组——组连带 children）。默认 doc 至少留 1 个叶（守底）。
  //   allowEmpty=true：允许删到 0 叶（组删除用——清空后 caller 补一张空层，保证不卡在「非空组删不掉」）。
  removeLayer(id: number, allowEmpty = false) {
    const loc = findParentOf(this.layers, id);
    if (!loc) return false;
    const removingLeaves = countLeaves([loc.node]);
    if (!allowEmpty && countLeaves(this.layers) - removingLeaves < 1) return false;
    loc.parent.splice(loc.index, 1);
    // 像素句柄的释放归 caller/operator：RemoveLayerRecordOp 捕快照后显式 dispose；
    // treeStructure（删组）持**活引用**进 undo，绝不能在这里 dispose（会把 undo 恢复出空层）。
    if (!findNodeById(this.layers, this.activeId)) {   // active 被删（或在被删组内）→ 重选末叶
      const leaves = flattenLeaves(this.layers);
      this.activeId = leaves.length ? leaves[leaves.length - 1].id : null;
    }
    return true;
  }

  // 把一层序列化成 layerSpec（id/name/visible/opacity/mode/bbox + imageData）。
  // 模型层拥有「层 ↔ spec」的形状（undo 入栈、mergeDown、insertLayerAt 共用）。
  // blob 留 null：异步压缩是 undo 编排的事，由 caller 填。
  layerSpec(L: Layer): LayerSpecShape {
    return {
      id: L.id, name: L.name, visible: L.visible,
      opacity: L.opacity, mode: L.mode,
      clippingMask: L.clippingMask, lockAlpha: L.lockAlpha,
      snap: L.snapshot(),
    };
  }

  // v124b 向下合并（mode-aware）：用 active 的 mode×opacity 把 active 烤进下方层、删 active。
  // **视觉等价**：合并前后画面相同（active.mode×active.opacity 已烤进像素 → under 归一化 source-over/α=1）。
  // 纯模型操作（无 DOM / 无 history / 无 status）：成功返回 undo 所需数据，caller 负责入栈+刷新+压缩。
  //   成功 → { ok:true, underId, underBefore, underBeforeOpacity, underBeforeMode,
  //            underBeforeClipping, underAfter, activeSpec, activeIndex }
  //   不可合并 → { ok:false, reason }；reason ∈ bottom | clipping-under | empty-active
  //   （empty-active = active 无像素，caller 应改走「删 active」；语义不同，不在此处删）
  //
  // 剪裁层向下合并语义（Procreate 兼容，v258 起支持）：
  //   - active 是剪裁层（clippingMask=true），under 是它的剪裁基底（非剪裁层）：
  //       active 像素先 **dst-in 裁到 under 的 alpha**（剪裁层只在基底不透明处可见），
  //       再按 active.mode×opacity 烤进 under。结果 under 保持非剪裁，视觉与合并前一致。
  //   - 剪裁链边界（active 与 under 都 clippingMask=true，共用同一基底）：合并后结果保持
  //       clippingMask=true（仍剪到同一基底），不在此处对基底再裁（那是渲染时的事）。
  //   - 反向（under 是剪裁层、active 普通）= "clipping-under"：语义不清，拒绝并给中文提示。
  // #25（v0.5）：把组烤成单叶（同位替换）。merged = 组 children 的合成**字节**（调用方用 GL
  //   renderNodesToBytes 渲染——v0.6.39 去 canvas 化：readPixels 字节直落 tile，零 premult 往返，
  //   组自身 opacity/mode/clip/visible 保留到新叶上 → 视觉不变）；null = 空组 → 空叶。
  //   撤销走 snapshotTree/treeStructure（新叶是活引用，undo 即从树上摘掉）。
  collapseGroupToLayer(id: number, merged: { data: Uint8ClampedArray; w: number; h: number } | null) {
    const loc = findParentOf(this.layers, id);
    if (!loc || !loc.node.isGroup) return null;
    const g = loc.node as LayerGroup;
    const L = new Layer({ width: this.width, height: this.height, name: g.name, empty: true });
    L.visible = g.visible; L.opacity = g.opacity; L.mode = g.mode; L.clippingMask = !!g.clippingMask;
    if (merged) L.replaceFromBytes(merged.data, 0, 0, merged.w, merged.h);
    loc.parent.splice(loc.index, 1, L);
    this.activeId = L.id;
    return L;
  }

  // #25（v0.5）：盖印全部可见层 → 新叶**强制置顶**（根级数组尾 = 最顶）。merged = 全树合成位图。
  //   「其他图层自动隐藏」由调用方编排（组走 treeStructure 快照，叶 visible 走 layerProp op）。
  stampAllToTopLayer(merged: { data: Uint8ClampedArray; w: number; h: number }) {
    if (countLeaves(this.layers) >= this.maxLayers) return null;
    const L = new Layer({ width: this.width, height: this.height, name: `合并 ${this._nextLayerName().replace(/^图层\s*/, "")}`, empty: true });
    L.replaceFromBytes(merged.data, 0, 0, merged.w, merged.h);
    this.layers.push(L);
    this.activeId = L.id;
    return L;
  }

  mergeDownLayer(L: Layer) {
    if (!L || L.isGroup) return { ok: false, reason: "bottom" };
    const loc = findParentOf(this.layers, L.id);
    if (!loc || loc.index <= 0) return { ok: false, reason: "bottom" };
    // undo 复位用 active 的**同级**位置（组内合并也能精确插回）。
    const activeLoc = { parentId: loc.parentNode ? loc.parentNode.id : null, index: loc.index };
    const under = loc.parent[loc.index - 1];   // **同级**下方节点
    if (under.isGroup) return { ok: false, reason: "merge-into-group" };
    // under 是剪裁层而 active 不是 → 语义不清（active 会被 under 的基底裁掉一半）：拒绝。
    if (under.clippingMask && !L.clippingMask) return { ok: false, reason: "clipping-under" };

    const aHasPx = L.bboxW > 0 && L.bboxH > 0;
    const uHasPx = under.bboxW > 0 && under.bboxH > 0;
    if (!aHasPx) return { ok: false, reason: "empty-active" };

    // active 是剪裁层、under 是它的基底（under 非剪裁）→ 合并时把 active dst-in 裁到 under alpha。
    // active 与 under 都剪裁（剪裁链内部）→ 不裁（两者共用更下方的同一基底），合并后仍剪裁。
    const clipActiveToUnder = L.clippingMask && !under.clippingMask;
    // 合并结果是否仍是剪裁层：仅当 active 与 under 都剪裁（链内合并，仍剪到同一基底）。
    const resultClipping = L.clippingMask && under.clippingMask;

    // 合并后 bbox = active ∪ under。注意：active 裁到 under alpha 后实际可见区 ⊆ under，
    // 但 bbox 取并集是安全的上界（多出来的边角是透明像素，不影响视觉，bbox trim 是 P2）。
    const x0 = uHasPx ? Math.min(under.bboxX, L.bboxX) : L.bboxX;
    const y0 = uHasPx ? Math.min(under.bboxY, L.bboxY) : L.bboxY;
    const x1 = uHasPx ? Math.max(under.bboxX + under.bboxW, L.bboxX + L.bboxW) : L.bboxX + L.bboxW;
    const y1 = uHasPx ? Math.max(under.bboxY + under.bboxH, L.bboxY + L.bboxH) : L.bboxY + L.bboxH;
    const newW = x1 - x0, newH = y1 - y0;

    // v0.6.39 去 canvas 化 + 单引擎（user 拍板 ×2）：合并像素 = **GL render tree 的字节合成面**
    //   （doc-render.renderNodesToBytes → compositeOnce readback，与 display/导出同一套混合数学——
    //   旧 canvas globalCompositeOperation 版把混合交给浏览器 premult 空间，"严重违规"）。
    //   节点 = 结构化临时 2 叶（gl-doc-bridge 明说"结构兼容即可"；同 id+同 pixels → GPU tile 直接复用）：
    //   under 铺底（透明背景上 mode 退化为放置，opacity 原样）；active 按 clippingMask/mode/opacity 混上。
    const comp = renderNodesToBytes([
      { isGroup: false, id: under.id, opacity: under.opacity, mode: "source-over", clippingMask: false, visible: true, pixels: under.pixels },
      { isGroup: false, id: L.id, opacity: L.opacity, mode: L.mode || "source-over", clippingMask: clipActiveToUnder, visible: true, pixels: L.pixels },
    ], this.width, this.height);
    if (!comp) return { ok: false, reason: "no-gl" };
    // 全 doc 字节 → 并集 rect 切片
    const out = new Uint8ClampedArray(newW * newH * 4);
    for (let y = 0; y < newH; y++) {
      const srcOff = ((y0 + y) * this.width + x0) * 4;
      out.set(comp.data.subarray(srcOff, srcOff + newW * 4), y * newW * 4);
    }

    // 先抓「改前」状态再 mutate
    const underBefore = under.snapshot();
    const underBeforeOpacity = under.opacity;
    const underBeforeMode = under.mode;
    const underBeforeClipping = under.clippingMask;
    const activeSpec = this.layerSpec(L);
    activeSpec.clippingMask = L.clippingMask;   // redo 还原 active 的剪裁标志
    // 替换 under 像素 + 归一化（active.mode×active.opacity 已烤进 out）
    under.replaceFromBytes(out, x0, y0, newW, newH);
    under.opacity = 1;
    under.mode = "source-over";
    // 链内合并：结果仍剪裁到同一基底；基底 case：结果是普通基底层（非剪裁）。
    under.clippingMask = resultClipping;
    this.removeLayer(L.id);
    L.pixels.dispose();   // activeSpec.snap 已持句柄副本；被合并层对象就此退场，释放它自己那份
    const underAfter = under.snapshot();
    this.setActiveById(under.id);
    return {
      ok: true, underId: under.id,
      underBefore, underAfter, underBeforeOpacity, underBeforeMode, underBeforeClipping,
      resultClipping, activeSpec, activeLoc,
    };
  }

  // 按 layerSpec 在 (parentId 的同级数组的) index 处插入一层（**用 spec.id**，不走 auto-increment）。
  // 给 history undo "removeLayer" / redo "addLayer" 用。
  // layerSpec: { id, name, visible, opacity, mode, bboxX, bboxY, bboxW, bboxH,
  //   imageData?, bitmap? }   —— 像素数据走 Layer.restoreFromSnapshot 同形 snap
  // parentId = 目标父组 id（null = 根层级）；index = 该同级数组内的 index。撤销树化（batch 2）后
  //   caller 传 locateNode() 拿到的 {parentId, index}，组内删除/新建也能精确复位。active 不在此调整
  //   （所有 caller 插入后显式 setActiveById）。
  insertLayerAt(index: number, spec: LayerSpecShape, parentId: number | null = null) {
    if (countLeaves(this.layers) >= this.maxLayers) return false;
    const parentNode = parentId == null ? null : findNodeById(this.layers, parentId);
    const parent = parentNode && parentNode.isGroup ? parentNode.children : this.layers;
    const L = new Layer({
      width: this.width,
      height: this.height,
      name: spec.name,
      empty: true,
    });
    L.id = spec.id;         // 关键：保留原 id 让历史上的 stroke entry 仍能引用
    if (typeof spec.visible === "boolean") L.visible = spec.visible;
    if (typeof spec.opacity === "number") L.opacity = spec.opacity;
    if (typeof spec.mode === "string") L.mode = spec.mode;
    if (typeof spec.clippingMask === "boolean") L.clippingMask = spec.clippingMask;
    if (typeof spec.lockAlpha === "boolean") L.lockAlpha = spec.lockAlpha;
    if (spec.snap) L.restoreFromSnapshot(spec.snap);
    const i = Math.max(0, Math.min(index, parent.length));
    parent.splice(i, 0, L);
    // 防止 _layerIdCounter 撞到一个 spec.id（避免后续 addLayer 复用 id）
    if (spec.id >= _layerIdCounter) _layerIdCounter = spec.id + 1;
    return true;
  }

  // 节点（id）的同级位置 → { parentId, index }（parentId=null 表根）。撤销结构 entry 用。
  locateNode(id: number) {
    const loc = findParentOf(this.layers, id);
    if (!loc) return null;
    return { parentId: loc.parentNode ? loc.parentNode.id : null, index: loc.index };
  }

  // active 能否在**同级**内沿 toward（+1 上 / -1 下）移动（给上下移按钮禁用判定）。
  canMoveLayer(id: number, toward: number) {
    const loc = findParentOf(this.layers, id);
    if (!loc) return false;
    const j = loc.index + toward;
    return j >= 0 && j < loc.parent.length;
  }

  // 给 setLayerProp / renameLayer 用：按 id 查节点（递归，叶或组）
  findLayer(id: number) {
    return findNodeById(this.layers, id) || null;
  }

  // 上移 / 下移（toward = +1 上，-1 下）——在节点**同级**内。active 按 id 不需调整。
  // bottom = 同级 [0]，top = 同级末尾。跨组边界移动 = reparent（见 moveIntoGroup/moveOutOfGroup）。
  moveLayer(id: number, toward: number) {
    const loc = findParentOf(this.layers, id);
    if (!loc) return false;
    const j = loc.index + toward;
    if (j < 0 || j >= loc.parent.length) return false;
    const [n] = loc.parent.splice(loc.index, 1);
    loc.parent.splice(j, 0, n);
    return true;
  }

  // v267 复制图层：深拷贝像素（getImageData→putImageData）+ 全部属性（含 clip / lockAlpha），
  //   插在源层之上并设为 active。纯模型操作（无 history）：caller 负责入栈 + 压缩快照 + 刷新。
  //   成功 → { ok:true, newLayer, index }；失败 → { ok:false, reason: max | missing }
  duplicateLayer(id: number) {
    if (countLeaves(this.layers) >= this.maxLayers) return { ok: false, reason: "max" };
    const loc = findParentOf(this.layers, id);
    if (!loc) return { ok: false, reason: "missing" };
    const src = loc.node;
    if (src.isGroup) return { ok: false, reason: "missing" };   // 组复制留 P2（深拷整子树）
    const snap = src.snapshot();   // 句柄共享（tile 只读 + copy-on-write：编辑任一方才分叉）→ 复制瞬时零拷贝
    const L = new Layer({ width: this.width, height: this.height, name: `${src.name} 副本`, empty: true });
    L.visible = src.visible;
    L.opacity = src.opacity;
    L.mode = src.mode;
    L.clippingMask = src.clippingMask;
    L.lockAlpha = src.lockAlpha;
    L.restoreFromSnapshot(snap);
    disposeLayerSnap(snap);
    loc.parent.splice(loc.index + 1, 0, L);   // 源**同级**之上
    this.activeId = L.id;
    // loc = 新层在**同级**的插入位（撤销 insertLayerAt(parentId,index) 用；组内也精确）。
    return {
      ok: true, newLayer: L,
      loc: { parentId: loc.parentNode ? loc.parentNode.id : null, index: loc.index + 1 },
    };
  }

  // ---- 图层组 op（纯模型，无 history/DOM；caller 入栈 + 刷新。撤销底座 = snapshotTree）----

  // 新建**空**组，插在 active 节点的同级、active 之上，设为 active。返回新组。
  //   组不计入 maxLayers（只数叶）。创建入口走「+」菜单（编组当前层已砍，靠空组 + 移入上方组）。
  addGroup(name?: string) {
    const g = new LayerGroup({ name });
    this._insertAtActive(g);          // active 是组 → 嵌进去；否则同级之上
    this.activeId = g.id;
    return g;
  }

  // 把节点（id）包进一个新组，替换其在 parent 的原位。返回 { ok, group } 或 { ok:false }。
  groupSelection(id: number) {
    const loc = findParentOf(this.layers, id);
    if (!loc) return { ok: false, reason: "missing" };
    const g = new LayerGroup({ children: [loc.node] });
    loc.parent.splice(loc.index, 1, g);
    this.activeId = g.id;
    return { ok: true, group: g };
  }

  // 解组：组的 children 提到组在 parent 的原位（保序），删组。返回 { ok, childIds } 或 { ok:false }。
  ungroup(groupId: number) {
    const loc = findParentOf(this.layers, groupId);
    if (!loc || !loc.node.isGroup) return { ok: false, reason: "not-group" };
    const kids = loc.node.children;
    loc.parent.splice(loc.index, 1, ...kids);
    if (!findNodeById(this.layers, this.activeId)) {
      this.activeId = kids[0] ? kids[0].id : (flattenLeaves(this.layers).slice(-1)[0]?.id ?? null);
    }
    return { ok: true, childIds: kids.map((k) => k.id) };
  }

  // 把节点移入组（到组内顶部 = children 末尾）。拒绝把组移进自己的子孙。返回 ok。
  moveIntoGroup(id: number, groupId: number) {
    if (id === groupId) return false;
    const g = findNodeById(this.layers, groupId);
    const node = findNodeById(this.layers, id);
    if (!g || !g.isGroup || !node) return false;
    if (node.isGroup && findNodeById(node.children, groupId)) return false;   // g 是 node 后代 → 环
    const loc = findParentOf(this.layers, id)!;
    loc.parent.splice(loc.index, 1);
    g.children.push(node);
    return true;
  }

  // 把节点移出其所在组（提到组的同级、组之上）。已在根 → no-op。返回 ok。
  moveOutOfGroup(id: number) {
    const loc = findParentOf(this.layers, id);
    if (!loc || !loc.parentNode) return false;
    const gloc = findParentOf(this.layers, loc.parentNode.id);
    if (!gloc) return false;
    const [n] = loc.parent.splice(loc.index, 1);
    gloc.parent.splice(gloc.index + 1, 0, n);
    return true;
  }

  // ---- 结构撤销底座：保叶子**活引用**（零像素拷贝）+ 组记录 ----
  // 给 group/ungroup/reparent/组删除 的撤销用。纯结构变（不改像素）→ 不必像 snapshotAll 那样
  // dump 每层 imageData（iPad 内存紧）。叶子存活对象引用：撤销重挂同一 Layer，id/像素历史不变。
  snapshotTree() {
    const snapNode = (n: Node): TreeSnapNode => n.isGroup
      ? { isGroup: true, id: n.id, name: n.name, visible: n.visible, opacity: n.opacity,
          mode: n.mode, clippingMask: n.clippingMask, collapsed: n.collapsed,
          children: n.children.map(snapNode) }
      : { isGroup: false, ref: n };
    return { activeId: this.activeId, nodes: this.layers.map(snapNode) };
  }
  restoreTree(snap: { activeId: number | null; nodes: TreeSnapNode[] } | null) {
    if (!snap) return;
    const build = (rec: TreeSnapNode): Node => {
      if (!rec.isGroup) return rec.ref;     // 同一个活 Layer 对象
      const g = new LayerGroup({ name: rec.name });
      g.id = rec.id; g.visible = rec.visible; g.opacity = rec.opacity; g.mode = rec.mode;
      g.clippingMask = rec.clippingMask; g.collapsed = !!rec.collapsed;
      g.children = rec.children.map(build);
      return g;
    };
    this.layers = snap.nodes.map(build);
    reseedLayerIdCounter(this.layers);
    if (snap.activeId != null && findNodeById(this.layers, snap.activeId)) {
      this.activeId = snap.activeId;
    } else {
      const lv = flattenLeaves(this.layers);
      this.activeId = lv.length ? lv[lv.length - 1].id : null;
    }
  }

  // 清空当前 layer 像素（不删 layer）。
  clearActiveLayer() {
    const L = this.activeLayer;
    if (!L || L.isGroup) return;
    L.clearAll();
  }

  // v110: doc 整状态 snapshot（给 crop / resample 等 doc-level transform 的 undo 用）
  // 比单层 snapshot 重得多——含每层 imageData + bbox + 元信息 + selection mask 副本
  // 节点 ↔ spec 递归（组含 children specs；叶含像素 snap）。给 snapshotAll 树往返用。
  _nodeSnap(n: Node): DeepSnapNode {
    if (n.isGroup) {
      return {
        isGroup: true, id: n.id, name: n.name, visible: n.visible, opacity: n.opacity,
        mode: n.mode, clippingMask: n.clippingMask, collapsed: n.collapsed,
        children: n.children.map((c) => this._nodeSnap(c)),
      };
    }
    return {
      isGroup: false, id: n.id, name: n.name, visible: n.visible, opacity: n.opacity,
      mode: n.mode, clippingMask: n.clippingMask, lockAlpha: n.lockAlpha, snap: n.snapshot(),
    };
  }
  _nodeFromSnap(s: DeepSnapNode): Node {
    if (s.isGroup) {
      const g = new LayerGroup({ name: s.name });
      g.id = s.id; g.visible = s.visible; g.opacity = s.opacity; g.mode = s.mode;
      g.clippingMask = s.clippingMask; g.collapsed = !!s.collapsed;
      g.children = (s.children || []).map((c) => this._nodeFromSnap(c));
      if (s.id >= _layerIdCounter) _layerIdCounter = s.id + 1;
      return g;
    }
    const L = new Layer({ width: this.width, height: this.height, name: s.name, empty: true });
    L.id = s.id; L.visible = s.visible; L.opacity = s.opacity; L.mode = s.mode;
    L.clippingMask = s.clippingMask; L.lockAlpha = !!s.lockAlpha;
    L.docW = this.width; L.docH = this.height;
    L.restoreFromSnapshot(s.snap);
    if (s.id >= _layerIdCounter) _layerIdCounter = s.id + 1;
    return L;
  }
  snapshotAll() {
    return {
      width: this.width,
      height: this.height,
      activeId: this.activeId,
      activeIndex: this.activeIndex,   // 兼容：旧 restore 走 index
      referenceLayerId: this.referenceLayerId,
      selection: this.selection ? this.selection.clone() : null,   // v0.4.6：句柄别名 clone（零拷贝），快照自持所有权
      layers: this.layers.map((n) => this._nodeSnap(n)),
    };
  }
  restoreSnapshotAll(snap: {
    width: number;
    height: number;
    activeId?: number | null;
    activeIndex?: number;
    referenceLayerId: number | null;
    selection: Selection | null;
    layers: DeepSnapNode[];
  } | null) {
    if (!snap) return;
    this.width = snap.width;
    this.height = snap.height;
    this.referenceLayerId = snap.referenceLayerId;
    // v0.4.6：快照可反复 restore（undo/redo 往复）→ 装 clone，快照自身的 clone 仍归快照（op disposeData 释放）。
    const oldSel = this.selection;
    this.selection = snap.selection && !snap.selection.disposed ? snap.selection.clone() : null;
    if (oldSel && !oldSel.disposed) oldSel.dispose();
    this.layers = snap.layers.map((s) => this._nodeFromSnap(s));
    if (snap.activeId != null && findNodeById(this.layers, snap.activeId)) this.activeId = snap.activeId;
    else this.activeIndex = snap.activeIndex || 0;
  }

  // v112: 裁切 doc 到 rect（doc 坐标 {x, y, w, h}）。
  // v110 偷懒只改 bbox 不真裁 canvas，导致裁后旧像素 bbox 偏到 -X 露在 void 上
  // → user 画的东西落在新 doc 外 (实际是落在旧 bbox 区域)。修：真 clip layer canvas。
  // 裁剪·模板模式 commit（v0.6.48）：「裁剪 + 重采样到目标 px」原子 op，保层继续画。
  //   frame 可超 doc（外=透明）；逐层只处理 frame∩bbox 子矩形（保 tile 稀疏性）；
  //   resample-bytes：auto=缩小面积平均（整数比=严格 box，像素模板鲁棒）/放大双三次。
  //   frame 恰 = 目标 px 且整数 → resampleBytes 恒等路径 = 纯裁剪逐字节。
  cropResampleTo(frame: { x: number; y: number; w: number; h: number }, tw: number, th: number, mode = "auto") {
    const fx = frame.x, fy = frame.y, fw = Math.max(1, frame.w), fh = Math.max(1, frame.h);
    const sx = tw / fw, sy = th / fh;
    for (const L of flattenLeaves(this.layers)) {
      const ix0 = Math.max(fx, L.bboxX), iy0 = Math.max(fy, L.bboxY);
      const ix1 = Math.min(fx + fw, L.bboxX + L.bboxW), iy1 = Math.min(fy + fh, L.bboxY + L.bboxH);
      const iw = Math.ceil(ix1 - ix0), ih = Math.ceil(iy1 - iy0);
      if (iw <= 0 || ih <= 0) { L.remapPixelsBytes(tw, th, null, 0, 0, 0, 0); continue; }
      const srcBytes = L.pixels.getRegion(Math.floor(ix0), Math.floor(iy0), iw, ih);
      const nbx = Math.floor((ix0 - fx) * sx), nby = Math.floor((iy0 - fy) * sy);
      const nbw = Math.max(1, Math.min(tw - nbx, Math.round(iw * sx)));
      const nbh = Math.max(1, Math.min(th - nby, Math.round(ih * sy)));
      const out = resampleBytes(srcBytes, iw, ih, nbw, nbh, mode);
      L.remapPixelsBytes(tw, th, out, nbx, nby, nbw, nbh);
    }
    if (this.selection) {
      const old = this.selection;
      const cropped = old.croppedTo(Math.round(fx), Math.round(fy), Math.round(fw), Math.round(fh));
      if (cropped !== old) old.dispose();
      this.selection = cropped ? cropped.resampledTo(sx, sy) : null;
      if (cropped && cropped !== this.selection) cropped.dispose();
    }
    this.width = tw;
    this.height = th;
  }

  cropTo(rect: { x: number; y: number; w: number; h: number }) {
    const dx = rect.x | 0, dy = rect.y | 0, nw = Math.max(1, rect.w | 0), nh = Math.max(1, rect.h | 0);
    for (const L of flattenLeaves(this.layers)) {
      L.setPixels(L.pixels.cropped(dx, dy, nw, nh), nw, nh);   // 纯 tile：裁切 + 新 doc 尺寸
    }
    if (this.selection) {
      const old = this.selection;
      this.selection = old.croppedTo(dx, dy, nw, nh);
      if (old !== this.selection) old.dispose();   // v0.4.6：旧 mask 句柄释放（undo 侧有 snapshotAll clone）
    }
    this.width = nw;
    this.height = nh;
  }

  // 水平翻转整个 doc（所有 layer + selection）。doc 尺寸不变。
  // 每层：canvas 内容左右镜像；bbox 左上角 x → docW - (bboxX + bboxW)。
  flipHorizontal() {
    const W = this.width;
    for (const L of flattenLeaves(this.layers)) {
      L.setPixels(L.pixels.flippedHorizontal(), L.docW, L.docH);   // 纯 tile 水平镜像
    }
    if (this.selection) {
      const old = this.selection;
      this.selection = old.flippedHorizontal(W);
      if (old !== this.selection) old.dispose();
    }
  }

  // v258: 逆时针旋转整个 doc 90°（所有 layer + selection）。doc 尺寸 W↔H 互换。
  // 坐标变换（CCW 90°，已用角点验证方向）：旧 doc 点 (x,y) → 新 doc 点 (y, W-x)，W=旧宽。
  //   验证：旧左上 (0,0)→(0,W)=新左下；旧右上 (W,0)→(0,0)=新左上 → 确为逆时针。
  // 每层 bbox：newX=bboxY, newY=W-(bboxX+bboxW), newW=bboxH, newH=bboxW。
  // 每层 canvas：旧 (bboxW×bboxH) → 新 (bboxH×bboxW)。局部旋转：旧局部 (lx,ly)→新局部 (ly, bboxW-lx)。
  //   仿射矩阵 setTransform(a,b,c,d,e,f) 把 (x,y)→(a·x+c·y+e, b·x+d·y+f)。
  //   要 newX=ly, newY=bboxW-lx → (a,b,c,d,e,f)=(0,-1,1,0,0,bboxW)。
  //   （注意 e=0,f=bboxW；写成 (…,bboxW,0) 会把内容平移出界——这是常见照抄错。）
  rotate90CCW() {
    const W = this.width;
    const H = this.height;
    for (const L of flattenLeaves(this.layers)) {
      L.setPixels(L.pixels.rotated90CCW(), H, W);   // 纯 tile 逆时针 90°（新 doc = H×W）
    }
    if (this.selection) {
      const old = this.selection;
      this.selection = old.rotated90CCW(W, H);
      if (old !== this.selection) old.dispose();
    }
    this.width = H;
    this.height = W;
  }

  // v110: 重采样 doc 到 newW × newH。mode: "nearest" | "bilinear" | "bicubic"
  // 各 layer canvas 重画 + bbox 缩放；selection mask 同步缩放
  resampleTo(newW: number, newH: number, mode = "bilinear") {
    const nw = Math.max(1, newW | 0);
    const nh = Math.max(1, newH | 0);
    const sx = nw / this.width;
    const sy = nh / this.height;
    // v0.6.46 字节管线（去 canvas 化 F 批）：逐层 getRegion → resample-bytes（sharper=面积平均
    //   正解，bicubic 带 α 反振铃限幅、口径同 warp 采样器）→ 直落新 tile。零 premult 往返。
    for (const L of flattenLeaves(this.layers)) {
      const bx = L.bboxX, by = L.bboxY, oW = L.bboxW, oH = L.bboxH;
      if (oW <= 0 || oH <= 0) { L.remapPixelsBytes(nw, nh, null, 0, 0, 0, 0); continue; }
      const srcBytes = L.pixels.getRegion(bx, by, oW, oH);
      const nbw = Math.max(1, Math.round(oW * sx));
      const nbh = Math.max(1, Math.round(oH * sy));
      const nbx = Math.round(bx * sx);
      const nby = Math.round(by * sy);
      const out = resampleBytes(srcBytes, oW, oH, nbw, nbh, mode);
      L.remapPixelsBytes(nw, nh, out, nbx, nby, nbw, nbh);
    }
    if (this.selection) {
      const old = this.selection;
      this.selection = old.resampledTo(sx, sy);
      if (old !== this.selection) old.dispose();
    }
    this.width = nw;
    this.height = nh;
  }

  // 偏移整个 doc（dx, dy 像素），**环绕**（wrap-around）—— 画 seamless 贴图的核心动作。
  //   贴图要平铺无缝：把 doc 偏移半幅（dx=W/2, dy=H/2）后，原来藏在四条边上的接缝
  //   全汇到画面正中央，直接涂抹/仿章消除即可。doc 尺寸不变（区别于 crop/resample）。
  // 实现：每层合成进一张整幅 doc canvas 的 4 个环绕位（偏移归一化到 [0,W)/[0,H) 后只需 4 个，
  //   见下），bbox 设为整幅。整数平移 → 关插值保像素锐利。
  //   —— 不做 trim-to-content：seamless 贴图层通常铺满整幅，trim 后 bbox 仍是整幅；
  //      trim 扫描是易错优化，且 computeMaxLayers 本就按「每层占满」悲观预算，整幅 bbox 与之一致。
  offsetWrap(dx: number, dy: number) {
    const W = this.width, H = this.height;
    const ox = (((dx | 0) % W) + W) % W;   // 归一化到 [0, W)
    const oy = (((dy | 0) % H) + H) % H;   // 归一化到 [0, H)
    if (ox === 0 && oy === 0) return;       // 无变化（守卫也在调用方，这里再兜一次）
    // 归一化后，原内容（在 [bx, bx+bw)）右移 ox 落在 [bx+ox, …)，越过右/下边的部分由
    // 「-W / -H」环绕副本接回左/上。故只需 sx∈{0,-W} × sy∈{0,-H} 共 4 个位置。
    for (const L of flattenLeaves(this.layers)) {
      L.setPixels(L.pixels.offsetWrapped(ox, oy), W, H);   // 纯 tile 环绕偏移
    }
    if (this.selection) {
      const old = this.selection;
      this.selection = old.offsetWrapped(ox, oy, W, H);
      if (old !== this.selection) old.dispose();
    }
    // doc 尺寸不变
  }
}

// 图层数上限 = **动态总驻留字节预算**（v339，替代旧的「悲观 per-layer × 分辨率」静态公式）。
// 道理：tiling 后一层只占它**实画的 tile**（稀疏），不是整幅；旧公式按整幅算 → 2K 卡死 11 层，
//   即使大多数层只画了一角。新公式按**所有层当前实占字节**（residentBytes：稀疏 tile + 持有的物化 canvas）
//   对一个总字节预算封顶：
//     - 预算内 → 放到硬顶 HARD_CEIL（空层几乎免费 → 可像 Procreate 那样开很多稀疏层）。
//     - 已达预算 → 冻结在当前层数（≥2）→ 防 OOM（整幅画满的极端 doc 自然在 ~预算/16.8MB 层处停）。
//   GL 模式 release 物化 canvas → residentBytes 单份 → 放更多层（破 11 的真赢）；2D 模式 _mat 常驻 →
//   双份计费 → 自动更保守。
//
// layerByteBudget = clamp(deviceMemory × 1024 × 0.15 MB, 256, 768) → ~614MB@4GB。
//   0.15 留 85% 给 OS/别 tab/stroke buffer/undo blob/屏幕 canvas/JS heap；下限 256MB（撑得起十几层），
//   上限 768MB（不让单 doc 吃光）。`navigator.deviceMemory` Safari iOS 没有 → fallback 4GB（保守）。
// HARD_CEIL=64：绝对天花板（Procreate 量级），即使预算够也不放更多——防病态 doc + UI 合理。
export const LAYER_HARD_CEIL = 64;

export function layerByteBudget(): number {
  const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const budgetMB = Math.max(256, Math.min(768, deviceMemoryGB * 1024 * 0.15));
  return budgetMB * 1e6;
}

// currentLeafCount = 当前叶层数；residentBytes = 所有叶 residentBytes() 之和；budgetBytes = 该模式预算。
export function computeMaxLayers(currentLeafCount: number, residentBytes: number, budgetBytes = layerByteBudget()): number {
  if (residentBytes >= budgetBytes) return Math.max(2, currentLeafCount);   // 已达字节预算：冻结
  return LAYER_HARD_CEIL;                                                    // 预算内：放到硬顶
}

// ---- S8 · encode 冻结视图（spec:41「保存阻塞锁 workpiece 写」的达意实现，详 S8 报告 §S8d）----
// encode（ora/缩略图）是 async、逐层 await——编码中一笔 commit / 一次层结构操作会撕裂存档
// （stack.xml 与 layer PNG 不同刻，最坏解不开）。这里在 encode 入口**同步**冻结：
//   结构元数据浅拷 + 每叶 tile 句柄快照（O(tiles) 引用计数，零拷贝）。tile 不可变 ⇒
//   之后任何编辑都是 CoW 新 tile / 新结构，冻结视图物理不变 → 存档一致，且不阻塞用户。
// canvas / bbox 惰性物化（紧 bbox，与 Layer getter 同语义）。用完必须 dispose()（释放句柄）。

export interface FrozenLeaf {
  isGroup: false; id: number; name: string; opacity: number; mode: string;
  visible: boolean; clippingMask: boolean; lockAlpha: boolean;
  docW: number; docH: number;
  readonly canvas: Bitmap;
  readonly bboxX: number; readonly bboxY: number; readonly bboxW: number; readonly bboxH: number;
  readonly width: number; readonly height: number;
  /** v0.6.44：快照 tiles 字节直读（ora 存层走它——真机曾因缺此方法推送失败，见下）。零 canvas。 */
  getImageData(x: number, y: number, w: number, h: number): ImageData;
}
export interface FrozenGroup {
  isGroup: true; id: number; name: string; opacity: number; mode: string;
  visible: boolean; clippingMask: boolean;
  children: FrozenNode[];
}
export type FrozenNode = FrozenLeaf | FrozenGroup;
export interface FrozenDoc {
  width: number; height: number; backgroundColor: string;
  layers: FrozenNode[];
  // doc 级元数据也要进冻结视图——v0.7.7 前漏了这两个字段，保存路径的 stack.xml 永远
  // 写不出 webpaint:active / webpaint:reference（activeId 有 state.json 备份通道无症状，
  // referenceLayerId 没有 → 保存重开参考层丢失）。EncodeDoc 已改必填防再漏。
  activeId: number | null;
  referenceLayerId: number | null;
}

export function freezeDocForEncode(doc: PaintDoc): { frozen: FrozenDoc; dispose(): void } {
  const snaps: PixelsSnapshot[] = [];
  const freezeNode = (n: Node): FrozenNode => {
    if (n.isGroup) {
      const g = n as LayerGroup;
      return {
        isGroup: true, id: g.id, name: g.name, opacity: g.opacity, mode: g.mode,
        visible: g.visible, clippingMask: g.clippingMask,
        children: g.children.map(freezeNode),
      };
    }
    const view = (n as Layer)._freezeLeafView();
    snaps.push(view._snap);
    return view;
  };
  return {
    frozen: {
      width: doc.width, height: doc.height, backgroundColor: doc.backgroundColor,
      layers: doc.layers.map(freezeNode),
      activeId: doc.activeId, referenceLayerId: doc.referenceLayerId,
    },
    dispose() { for (const s of snaps) disposePixelsSnapshot(s); snaps.length = 0; },
  };
}
