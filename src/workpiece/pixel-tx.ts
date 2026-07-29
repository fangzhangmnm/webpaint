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

// 句柄快照 → 紧 bbox ImageData（只读物化；选区 finalize 才走）。
// v0.6.39 去 canvas 化：getRegion 字节直读（旧 materialize→getImageData 的 premult 往返会让
// undo 依赖的 preSnap 带量化损）。ImageData 只当容器，node 也能跑。
export function snapToImage(snap: LayerSnap, docW: number, docH: number): PreSnapImage {
  const tmp = new LayerPixels(docW, docH);
  tmp.restore(snap.pixels);
  const b = tmp.contentBounds(true);
  const out: PreSnapImage = b
    ? { bboxX: b.x, bboxY: b.y, bboxW: b.w, bboxH: b.h, imageData: new ImageData(tmp.getRegion(b.x, b.y, b.w, b.h), b.w, b.h) }
    : { bboxX: 0, bboxY: 0, bboxW: 0, bboxH: 0, imageData: null };
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
    // no-op 守卫（v0.6.17，user：笔/滤镜笔/形状笔画下去若画布无任何实质变化，不占 undo 步）：
    //   tile 句柄图与 before 逐格同 id ⇔ 这笔没写过任何像素（画布外/零 stamps/被选区全裁/
    //   擦空白区——CoW 纪律保证真实写入必换句柄）。跳过 finalize（没写过就没有要 mask 还原的），
    //   不入栈 → 不 bump dirty、不发 histchange（保存/脏标记随之天然跳过）。
    //   返回 false 与「层没了」共用（调用方 input.ts 本就不读返回值）。
    if (L.pixels.snapshotEquals(before.pixels)) { disposeLayerSnap(before); return false; }
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
