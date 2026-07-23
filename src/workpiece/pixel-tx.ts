// pixel-tx —— 像素编辑事务（PixelEdit 的 0.4 后继）。把「一次按-拖-抬的 layer 像素改动」
// 收成一个 undo checkpoint：begin(layer) 拍 before（**句柄快照，零拷贝**）→ 引擎改层 →
// commit(finalize?) 经 SwapPixelsOp 入栈 / abort() 还原。
//
// 与旧 PixelEdit 的差异：
//   - before 快照 = tile 句柄 acquire（O(tiles) 计数操作），不再整层 getImageData + 异步 PNG 压缩；
//     undo 内存交给池的压缩管 + undo-history 配额。
//   - finalize(layer, preSnapImage)（选区 applyMaskPostStroke 插槽）需要 ImageData 形——
//     从句柄快照**按需物化**（tile 只读 → 快照恒为笔前内容），只有带选区的 commit 才付这份钱。
//   - 全同步。

import { findNodeById, disposeLayerSnap, Layer, type LayerSnap, type PaintDoc } from "../doc.ts";
import { LayerPixels, materialize } from "../tiles/tile-layer.ts";
import type { Workpiece } from "./workpiece.ts";
import type { UndoHistory } from "./undo-history.ts";
import type { OperatorRegistry } from "./operators.ts";

export interface PreSnapImage { bboxX: number; bboxY: number; bboxW: number; bboxH: number; imageData: ImageData | null }

// 句柄快照 → 紧 bbox ImageData（只读物化；browser-only，选区 finalize 才走）。
export function snapToImage(snap: LayerSnap, docW: number, docH: number): PreSnapImage {
  const tmp = new LayerPixels(docW, docH);
  tmp.restore(snap.pixels);
  const m = materialize(tmp, true);
  let out: PreSnapImage;
  if (!m) out = { bboxX: 0, bboxY: 0, bboxW: 0, bboxH: 0, imageData: null };
  else {
    const ctx = (m.canvas as HTMLCanvasElement).getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    out = { bboxX: m.ox, bboxY: m.oy, bboxW: m.canvas.width, bboxH: m.canvas.height, imageData: ctx.getImageData(0, 0, m.canvas.width, m.canvas.height) };
  }
  tmp.dispose();
  return out;
}

export class PixelTx {
  private _layerId: number;
  private _before: LayerSnap | null;
  private _label: string;
  private _deps: PixelEditDeps;
  constructor(deps: PixelEditDeps, layer: Layer, label: string) {
    this._deps = deps;
    this._layerId = layer.id;
    this._before = layer.snapshot();
    this._label = label;
  }
  /** 入栈成功返回 true；layer 中途没了（删层）→ 不入栈返回 false。finalize 在拍 after 前跑（选区 mask 插槽）。 */
  commit(finalize?: (layer: Layer, preSnap: PreSnapImage) => void): boolean {
    const { doc, w, history, ops } = this._deps;
    const L = findNodeById(doc.layers, this._layerId) as Layer | null;
    const before = this._before;
    this._before = null;
    if (!L || L.isGroup || !before) { disposeLayerSnap(before); return false; }
    if (finalize) finalize(L, snapToImage(before, L.docW, L.docH));
    const st = history.run(w, ops.pixels, { layerId: this._layerId, _initialBefore: before }, { label: this._label });
    return st.ok;
  }
  /** 还原到 before，不入栈。 */
  abort(): void {
    const { doc, board } = this._deps;
    const L = findNodeById(doc.layers, this._layerId) as Layer | null;
    const before = this._before;
    this._before = null;
    if (L && !L.isGroup && before) {
      (L as Layer).restoreFromSnapshot(before);
      board?.invalidateAll();
    }
    disposeLayerSnap(before);
  }
}

interface PixelEditDeps {
  doc: PaintDoc;
  w: Workpiece;
  history: UndoHistory;
  ops: OperatorRegistry;
  board?: { invalidateAll(): void } | null;
}

/** PixelEdit 同名门面（input/filters 的 begin(layer, label) 调用形状不变）。 */
export class PixelEdits {
  private _deps: PixelEditDeps;
  constructor(deps: PixelEditDeps) { this._deps = deps; }
  begin(layer: Layer, label: string): PixelTx {
    return new PixelTx(this._deps, layer, label);
  }
}
