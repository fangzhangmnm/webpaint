// operators —— 仍走 legacy 桥的 DocumentOperator（T3b-2 之后的**残余集**；T4/T5 清零）。
//
// v0.8 T3b-2 已迁走：layerProp/referenceLayer/addLayer/removeLayer/moveLayer/treeStructure/
// mergeDown（→ layerTree2 verbs，经 layer-tree.ts 门面 withPoint）与 DocTransformOp
// （→ doc-ops 的 computed verbs + DocResizeOp + step.hint）。本文件只剩：
//   pixels     SwapPixelsOp   —— 预览违规户（液化就地写/filterBrush/浮层落地）的事务型入栈；
//                                 买账路径（stroke/fill/滤镜 commit）早已 token+LayerTiles。
//   fillColor  FillColorOp    —— fill 预览期换色（T4 PendingFill 接棒）。
//   （selection 已迁 SelectionComponent——T4a。）
//   docResize  DocResizeOp    —— crop/resample 的叶实例交换记账（T3b-2 立；几何变换的
//                                 undo 包 = 另一侧 LayerPixels 实例，与树 record 同 step 翻转）。
//   float 三件套（float-ops.ts）—— T4 FloatLayerComponent 接棒。
//
// 执行形态与句柄纪律沿旧约（见 git 历史 v0.8.12 版头注）。

import { DocumentOperator, Workpiece, type OpResult } from "./workpiece.ts";
import { findViewNodeById, disposeViewSnap, type ViewLeaf, type ViewLeafSnap, type PaintingView } from "./painting-view.ts";
import type { LayerPixels } from "../tiles/tile-layer.ts";
import { LiftFloatOp, FloatTransformOp, DropFloatOp } from "./float-ops.ts";

// tile 句柄快照的配额估计：压缩前记 0（走共享 raw 池配额），压缩后 = compressedBytes/refCount。
function estimateSnapBytes(snap: ViewLeafSnap | null | undefined): number {
  if (!snap) return 0;
  let sum = 0;
  for (const [, h] of snap.pixels.tiles) {
    if (h.released) continue;
    if (h.isCompressed()) sum += Math.ceil(h.compressedByteLength() / Math.max(1, h.refCount()));
  }
  return sum;
}
function estimateInstanceBytes(lp: LayerPixels): number {
  let sum = 0;
  for (const h of lp.handles()) {
    if (h.released) continue;
    if (h.isCompressed()) sum += Math.ceil(h.compressedByteLength() / Math.max(1, h.refCount()));
  }
  return sum;
}

function leafById(doc: PaintingView, id: number): ViewLeaf | null {
  const n = findViewNodeById(doc.layers, id);
  return n && !n.isGroup ? n : null;
}

// ---- ① 像素 swap（液化/filterBrush/浮层落地等 pre-applied 事务型；T2 后的残余住户）----
export interface SwapPixelsArgs { layerId: number; _initialBefore?: ViewLeafSnap | null }
export class SwapPixelsOp extends DocumentOperator<SwapPixelsArgs, ViewLeafSnap> {
  readonly kind = "pixels";
  forward(w: Workpiece, args: SwapPixelsArgs, data: ViewLeafSnap | undefined): OpResult<ViewLeafSnap> {
    const doc = this.mut(w).doc;
    const L = leafById(doc, args.layerId);
    if (!L) { this.disposeData(args, data); return { ok: false, msg: "layer gone" }; }
    if (data === undefined) {                      // 首跑：引擎已应用 after，交出 before
      const before = args._initialBefore;
      args._initialBefore = null;
      if (!before) return { ok: false, msg: "missing _initialBefore" };
      return { ok: true, replaced: before };
    }
    return { ok: true, replaced: this._install(L, data) };
  }
  backward(w: Workpiece, args: SwapPixelsArgs, data: ViewLeafSnap): OpResult<ViewLeafSnap> {
    const doc = this.mut(w).doc;
    const L = leafById(doc, args.layerId);
    if (!L) return { ok: false, msg: "layer gone" };
    return { ok: true, replaced: this._install(L, data) };
  }
  private _install(L: ViewLeaf, snap: ViewLeafSnap): ViewLeafSnap {
    const cur = L.snapshot();
    L.restoreFromSnapshot(snap);
    disposeViewSnap(snap);                         // 已消费（restore 装的是 acquire 副本）
    return cur;
  }
  override estimateQuotaBytes(args: SwapPixelsArgs, data: ViewLeafSnap | undefined): number {
    return 512 + estimateSnapBytes(data) + estimateSnapBytes(args._initialBefore);
  }
  override disposeData(args: SwapPixelsArgs, data: ViewLeafSnap | undefined): void {
    if (args._initialBefore) { disposeViewSnap(args._initialBefore); args._initialBefore = null; }
    disposeViewSnap(data);
  }
}

// （SwapSelectionOp 已死——T4a：选区记账归 SelectionComponent，见 selection-component.ts。）

// ---- ② fill 预览期换色（v0.7.8；语义见 git 历史。颜色 get/set 注入——desk 态，workpiece 不碰 UI）----
export interface FillColorArgs { value: string; _initialBefore?: { v: string } | null }
export class FillColorOp extends DocumentOperator<FillColorArgs, { v: string }> {
  readonly kind = "fillColor";
  private _c: { get(): string; set(hex: string): void };
  constructor(color: { get(): string; set(hex: string): void }) { super(); this._c = color; }
  forward(_w: Workpiece, args: FillColorArgs, data: { v: string } | undefined): OpResult<{ v: string }> {
    if (data === undefined) {                       // 首跑：pre-applied，只交出 undo 包
      const before = args._initialBefore;
      args._initialBefore = null;
      if (!before) return { ok: false, msg: "missing _initialBefore" };
      return { ok: true, replaced: before };
    }
    const cur = { v: this._c.get() };
    this._c.set(data.v);
    return { ok: true, replaced: cur };
  }
  backward(_w: Workpiece, _args: FillColorArgs, data: { v: string }): OpResult<{ v: string }> {
    const cur = { v: this._c.get() };
    this._c.set(data.v);
    return { ok: true, replaced: cur };
  }
}

// ---- ① 整 doc 几何 resize（T3b-2：crop/cropResample/resample 的实例交换记账）----
// pre-applied：doc-ops 已逐叶 exchangeLeafPixels 换上新实例，旧实例列表随 _initial 交入。
// data 循环 = 「另一侧」的实例集；swap = 逐叶 exchange（所有权互换，零拷贝）。json 尺寸
// （width/height）走 layerTree2.setTreeProp 进树 record——同一 step 内两账同向翻，一致性由
// 栈序保证（先于本步的 stroke record 要 undo 必先穿过本步，届时 docW 已还原、across 匹配）。
type ResizeSide = { leaves: { layerId: number; lp: LayerPixels }[] };
export interface DocResizeArgs { _initial?: ResizeSide | null }
export class DocResizeOp extends DocumentOperator<DocResizeArgs, ResizeSide> {
  readonly kind = "docResize";
  forward(w: Workpiece, args: DocResizeArgs, data: ResizeSide | undefined): OpResult<ResizeSide> {
    if (data === undefined) {                       // 首跑：pre-applied，交出旧实例集
      const initial = args._initial;
      args._initial = null;
      if (!initial) return { ok: false, msg: "missing _initial" };
      return { ok: true, replaced: initial };
    }
    return { ok: true, replaced: this._swap(this.mut(w).doc, data) };
  }
  backward(w: Workpiece, _args: DocResizeArgs, data: ResizeSide): OpResult<ResizeSide> {
    return { ok: true, replaced: this._swap(this.mut(w).doc, data) };
  }
  private _swap(doc: PaintingView, data: ResizeSide): ResizeSide {
    return {
      leaves: data.leaves.map((e) => {
        const cur = doc.exchangeLeafPixels(e.layerId, e.lp);
        if (!cur) throw new Error(`DocResizeOp: swap 时层已不在（layerId=${e.layerId}——栈序 bug）`);
        return { layerId: e.layerId, lp: cur };
      }),
    };
  }
  override estimateQuotaBytes(args: DocResizeArgs, data: ResizeSide | undefined): number {
    let sum = 1024;
    for (const e of data?.leaves ?? []) sum += estimateInstanceBytes(e.lp);
    for (const e of args._initial?.leaves ?? []) sum += estimateInstanceBytes(e.lp);
    return sum;
  }
  override disposeData(args: DocResizeArgs, data: ResizeSide | undefined): void {
    for (const e of data?.leaves ?? []) e.lp.dispose();
    if (data) data.leaves = [];
    for (const e of args._initial?.leaves ?? []) e.lp.dispose();
    if (args._initial) args._initial = null;
  }
}

// ---- 注册表（app.ts 组装进 ctx；有注入需求的在 app 侧 new）----
export interface OperatorRegistry {
  pixels: SwapPixelsOp;
  fillColor: FillColorOp;
  docResize: DocResizeOp;
  liftFloat: LiftFloatOp;
  floatTransform: FloatTransformOp;
  dropFloat: DropFloatOp;
}
export function makeOperators(deps: {
  fillColor: { get(): string; set(hex: string): void };
}): OperatorRegistry {
  return {
    pixels: new SwapPixelsOp(),
    fillColor: new FillColorOp(deps.fillColor),
    docResize: new DocResizeOp(),
    liftFloat: new LiftFloatOp(),
    floatTransform: new FloatTransformOp(),
    dropFloat: new DropFloatOp(),
  };
}
