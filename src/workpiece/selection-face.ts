// selection-face —— 选区写面门面（v0.8.2 · S2 立；T4a 换心：operator 流 → SelectionComponent）。
//
// 分工（刻意）：LassoEngine 仍是选区**生产**引擎（compose/dispose 舞蹈引擎内自理，entry 契约
// node 直测）；本门面是选区写面的**唯一记账口**——app 层不摸组件也不摸 operator：
//   - commitPreApplied(before)：引擎已把 after 换上 doc.selection（组件 _rawWrite 直通）、
//     before 所有权交入（disposal 归组件 record）。input/_pushSelEntry、toolbar/pushSel、
//     fill-mode 全走这里。经 history.withPoint 骑共享令牌 → checkpoint:false 聚合语义保住。
//   - beginPreview()：预览 tx 窗口——origin 保管、write 换预览（旧预览 ≠origin 就地 dispose）、
//     commit 记账 origin→current、abort 无痕还原。toolbar 扩缩预览（morphed）住户。
// 本门面不碰 DOM/i18n/store。T5 随 v1 拆时评估收编（调用方届时直接 wp2.begin + 组件 verb）。

import type { Selection } from "../selection.ts";
import type { Workpiece, OpStatus, HistoryFacade } from "./workpiece.ts";
import type { SelectionComponent } from "./selection-component.ts";
import type { RunOpts } from "./layer-tree.ts";

type Sel = Selection | null;

export class SelectionFace {
  private _history: HistoryFacade;
  private _sel: SelectionComponent;

  constructor(deps: { w: Workpiece; history: HistoryFacade; sel: SelectionComponent }) {
    this._history = deps.history;
    this._sel = deps.sel;
    deps.w._attachSel(this);
  }

  /** 唯一记账口：doc.selection 已被引擎/调用方换好，before 所有权交入（消费/释放归组件 record）。 */
  commitPreApplied(before: Sel, o?: RunOpts): OpStatus {
    const r = this._history.withPoint(o?.label ?? "selection", { checkpoint: o?.checkpoint },
      () => this._sel.commitPreApplied(before));
    return r.ok ? { ok: true } : { ok: false, msg: r.msg };
  }

  /** 预览 tx 窗口。origin = 进入时的选区（所有权：commit 交组件 record / abort 还原回 substrate）。 */
  beginPreview(): SelectionPreviewTx {
    return new SelectionPreviewTx(this, this._sel);
  }

  /** 组件内部用（tx 收口）。 */
  _run(before: Sel, o?: RunOpts): OpStatus { return this.commitPreApplied(before, o); }
}

export class SelectionPreviewTx {
  private _face: SelectionFace;
  private _sel: SelectionComponent;
  private _origin: Sel;
  private _open = true;

  constructor(face: SelectionFace, sel: SelectionComponent) {
    this._face = face;
    this._sel = sel;
    this._origin = sel.view();
  }

  origin(): Sel { return this._origin; }
  private _assertOpen(): void {
    if (!this._open) throw new Error("SelectionPreviewTx: 已收口（commit/abort 后不可再用）");
  }

  /** 换预览：上一个预览产物无人接手 → 就地 dispose（origin 与新值本体除外）。write(origin) 合法（= 预览回到原选区）。 */
  write(next: Sel): void {
    this._assertOpen();
    const prev = this._sel.view();
    if (prev === next) return;
    this._sel._rawWrite(next);
    if (prev && prev !== this._origin && !prev.disposed) prev.dispose();
  }

  /** 收口：current ≠ origin → 记账（before=origin 所有权交组件 record）；无变化 → 不占 undo 步。 */
  commit(o?: RunOpts): { changed: boolean; ok: boolean; msg?: string } {
    this._assertOpen();
    this._open = false;
    const cur = this._sel.view();
    if (cur === this._origin) return { changed: false, ok: true };
    const st = this._face._run(this._origin, o);
    return { changed: true, ok: st.ok, msg: st.ok ? undefined : st.msg };
  }

  /** 无痕还原 origin，预览产物就地 dispose。 */
  abort(): void {
    this._assertOpen();
    this._open = false;
    const cur = this._sel.view();
    if (cur !== this._origin) {
      if (cur && !cur.disposed) cur.dispose();
      this._sel._rawWrite(this._origin);
    }
  }
}
