import type { Selection } from "../selection.ts";
import type { RecordData } from "./undo-stack.ts";
import type { Workpiece, CollectorComponent } from "./workpiece2.ts";
export declare function estimateSelectionBytes(sel: Selection | null | undefined): number;
export declare class SelectionComponent implements CollectorComponent {
    readonly kind = "selection";
    private _wp;
    private _cur;
    private _origin;
    constructor(wp: Workpiece);
    view(): Selection | null;
    /** 预览直写（不记账不收集）。dispose 责任在调用方（沿旧 doc.selection setter 契约）。 */
    _rawWrite(v: Selection | null): void;
    /** 记账写：组件自己换手（调用方未 pre-applied 时用；替换值所有权交入 collector/即弃）。 */
    set(next: Selection | null): void;
    /** 记账写（pre-applied）：调用方已把 after 直写上台，before 所有权交入。 */
    commitPreApplied(before: Selection | null): void;
    /** 换文档收尾（跨 session 不沿用选区；旧 adoptState 语义）。无 token——load 流，栈随后清。 */
    clearOnLoad(): void;
    sealRecord(): RecordData | null;
    swapRecord(data: RecordData): RecordData;
    recordBytes(data: RecordData): number;
    disposeRecord(data: RecordData): void;
}
