// operators —— 仍走 legacy 桥的 DocumentOperator（T4b 之后的**残余集**；T5 清零）。
//
// v0.8 已迁走：结构 7 族+DocTransform（T3b-2 → layerTree2/doc-ops）、selection（T4a →
// SelectionComponent）、pixels/float 三件套（T4b → LayerTiles 写时扣押 + FloatLayerComponent；
// SwapPixelsOp 的最后住户是浮层落地，液化/filterBrush 早已 wp2.begin 令牌化；fillColor T4c →
// PendingFill）。本文件只剩：
//   docResize  DocResizeOp    —— crop/resample 的叶实例交换记账（T3b-2 立；几何变换的
//                                 undo 包 = 另一侧 LayerPixels 实例，与树 record 同 step 翻转）。
//
// 执行形态与句柄纪律沿旧约（见 git 历史 v0.8.12 版头注）。

import { DocumentOperator, Workpiece, type OpResult } from "./workpiece.ts";
import type { PaintingView } from "./painting-view.ts";
import type { LayerPixels } from "../tiles/tile-layer.ts";

function estimateInstanceBytes(lp: LayerPixels): number {
  let sum = 0;
  for (const h of lp.handles()) {
    if (h.released) continue;
    if (h.isCompressed()) sum += Math.ceil(h.compressedByteLength() / Math.max(1, h.refCount()));
  }
  return sum;
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
  docResize: DocResizeOp;
}
export function makeOperators(): OperatorRegistry {
  return {
    docResize: new DocResizeOp(),
  };
}
