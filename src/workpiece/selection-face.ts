// selection-face —— workpiece 的选区写面 component（v0.8.2 · S2，ADR-0007 ①型退役）。
//
// 分工（刻意）：LassoEngine 仍是选区**生产**引擎（compose/dispose 舞蹈引擎内自理，entry 契约
// node 直测）；本组件是选区写面的**唯一记账口**——app 层不再直接摸 ops.selection：
//   - commitPreApplied(before)：引擎已把 after 换上 doc.selection、before 所有权交入（disposal
//     归 SwapSelectionOp）。input/_pushSelEntry、toolbar/pushSel、fill-mode 全走这里。
//   - beginPreview()：预览 tx 窗口（形状同 pixel-tx）——origin 保管、write 换预览（旧预览
//     ≠origin 就地 dispose）、commit 记账 origin→current、abort 无痕还原。
//     toolbar 扩缩预览（morphed）第一个住户；「不记账」从默认态变成显式声明态。
// 本组件不碰 DOM/i18n/store。

import type { PaintDoc } from "../doc.ts";
import type { Selection } from "../selection.ts";
import type { Workpiece, OpStatus } from "./workpiece.ts";
import type { UndoHistory } from "./undo-history.ts";
import type { OperatorRegistry } from "./operators.ts";
import type { RunOpts } from "./layer-tree.ts";

type Sel = Selection | null;

export class SelectionFace {
  private _w: Workpiece;
  private _doc: PaintDoc;
  private _history: UndoHistory;
  private _ops: OperatorRegistry;

  constructor(deps: { w: Workpiece; doc: PaintDoc; history: UndoHistory; ops: OperatorRegistry }) {
    this._w = deps.w;
    this._doc = deps.doc;
    this._history = deps.history;
    this._ops = deps.ops;
    deps.w._attachSel(this);
  }

  /** 唯一记账口：doc.selection 已被引擎/调用方换好，before 所有权交入（消费/释放归 op）。 */
  commitPreApplied(before: Sel, o?: RunOpts): OpStatus {
    return this._history.run(this._w, this._ops.selection,
      { _initialBefore: { v: before as Selection | null } }, o);
  }

  /** 预览 tx 窗口。origin = 进入时的 doc.selection（所有权：commit 交 op / abort 还原回 doc）。 */
  beginPreview(): SelectionPreviewTx {
    return new SelectionPreviewTx(this, this._doc);
  }

  /** 组件内部用（tx 收口）。 */
  _run(before: Sel, o?: RunOpts): OpStatus { return this.commitPreApplied(before, o); }
}

export class SelectionPreviewTx {
  private _face: SelectionFace;
  private _doc: PaintDoc;
  private _origin: Sel;
  private _open = true;

  constructor(face: SelectionFace, doc: PaintDoc) {
    this._face = face;
    this._doc = doc;
    this._origin = doc.selection;
  }

  origin(): Sel { return this._origin; }
  private _assertOpen(): void {
    if (!this._open) throw new Error("SelectionPreviewTx: 已收口（commit/abort 后不可再用）");
  }

  /** 换预览：上一个预览产物无人接手 → 就地 dispose（origin 与新值本体除外）。write(origin) 合法（= 预览回到原选区）。 */
  write(next: Sel): void {
    this._assertOpen();
    const prev = this._doc.selection;
    if (prev === next) return;
    this._doc.selection = next;
    if (prev && prev !== this._origin && !prev.disposed) prev.dispose();
  }

  /** 收口：current ≠ origin → 记账（before=origin 所有权交 op）；无变化 → 不占 undo 步。 */
  commit(o?: RunOpts): { changed: boolean; ok: boolean; msg?: string } {
    this._assertOpen();
    this._open = false;
    const cur = this._doc.selection;
    if (cur === this._origin) return { changed: false, ok: true };
    const st = this._face._run(this._origin, o);
    return { changed: true, ok: st.ok, msg: st.ok ? undefined : st.msg };
  }

  /** 无痕还原 origin，预览产物就地 dispose。 */
  abort(): void {
    this._assertOpen();
    this._open = false;
    const cur = this._doc.selection;
    if (cur !== this._origin) {
      if (cur && !cur.disposed) cur.dispose();
      this._doc.selection = this._origin;
    }
  }
}
