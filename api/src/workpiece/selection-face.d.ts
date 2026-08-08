import type { Selection } from "../selection.ts";
import type { Workpiece, OpStatus, HistoryFacade } from "./workpiece.ts";
import type { SelectionComponent } from "./selection-component.ts";
import type { RunOpts } from "./layer-tree.ts";
type Sel = Selection | null;
export declare class SelectionFace {
    private _history;
    private _sel;
    constructor(deps: {
        w: Workpiece;
        history: HistoryFacade;
        sel: SelectionComponent;
    });
    /** 唯一记账口：doc.selection 已被引擎/调用方换好，before 所有权交入（消费/释放归组件 record）。 */
    commitPreApplied(before: Sel, o?: RunOpts): OpStatus;
    /** 预览 tx 窗口。origin = 进入时的选区（所有权：commit 交组件 record / abort 还原回 substrate）。 */
    beginPreview(): SelectionPreviewTx;
    /** 组件内部用（tx 收口）。 */
    _run(before: Sel, o?: RunOpts): OpStatus;
}
export declare class SelectionPreviewTx {
    private _face;
    private _sel;
    private _origin;
    private _open;
    constructor(face: SelectionFace, sel: SelectionComponent);
    origin(): Sel;
    private _assertOpen;
    /** 换预览：上一个预览产物无人接手 → 就地 dispose（origin 与新值本体除外）。write(origin) 合法（= 预览回到原选区）。 */
    write(next: Sel): void;
    /** 收口：current ≠ origin → 记账（before=origin 所有权交组件 record）；无变化 → 不占 undo 步。 */
    commit(o?: RunOpts): {
        changed: boolean;
        ok: boolean;
        msg?: string;
    };
    /** 无痕还原 origin，预览产物就地 dispose。 */
    abort(): void;
}
export {};
