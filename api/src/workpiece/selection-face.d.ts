import type { PaintingView } from "./painting-view.ts";
import type { Selection } from "../selection.ts";
import type { Workpiece, OpStatus, HistoryFacade } from "./workpiece.ts";
import type { OperatorRegistry } from "./operators.ts";
import type { RunOpts } from "./layer-tree.ts";
type Sel = Selection | null;
export declare class SelectionFace {
    private _w;
    private _doc;
    private _history;
    private _ops;
    constructor(deps: {
        w: Workpiece;
        doc: PaintingView;
        history: HistoryFacade;
        ops: OperatorRegistry;
    });
    /** 唯一记账口：doc.selection 已被引擎/调用方换好，before 所有权交入（消费/释放归 op）。 */
    commitPreApplied(before: Sel, o?: RunOpts): OpStatus;
    /** 预览 tx 窗口。origin = 进入时的 doc.selection（所有权：commit 交 op / abort 还原回 doc）。 */
    beginPreview(): SelectionPreviewTx;
    /** 组件内部用（tx 收口）。 */
    _run(before: Sel, o?: RunOpts): OpStatus;
}
export declare class SelectionPreviewTx {
    private _face;
    private _doc;
    private _origin;
    private _open;
    constructor(face: SelectionFace, doc: PaintingView);
    origin(): Sel;
    private _assertOpen;
    /** 换预览：上一个预览产物无人接手 → 就地 dispose（origin 与新值本体除外）。write(origin) 合法（= 预览回到原选区）。 */
    write(next: Sel): void;
    /** 收口：current ≠ origin → 记账（before=origin 所有权交 op）；无变化 → 不占 undo 步。 */
    commit(o?: RunOpts): {
        changed: boolean;
        ok: boolean;
        msg?: string;
    };
    /** 无痕还原 origin，预览产物就地 dispose。 */
    abort(): void;
}
export {};
