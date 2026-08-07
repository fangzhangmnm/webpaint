import { Layer, type LayerSnap, type PaintDoc } from "../doc.ts";
import type { Workpiece } from "./workpiece.ts";
import type { UndoHistory } from "./undo-history.ts";
import type { OperatorRegistry } from "./operators.ts";
export interface PreSnapImage {
    bboxX: number;
    bboxY: number;
    bboxW: number;
    bboxH: number;
    imageData: ImageData | null;
}
export declare function snapToImage(snap: LayerSnap, docW: number, docH: number): PreSnapImage;
export declare class PixelTx {
    private _layerId;
    private _before;
    private _label;
    private _deps;
    constructor(deps: PixelEditDeps, layer: Layer, label: string);
    /** 入栈成功返回 true；layer 中途没了（删层）→ 不入栈返回 false。finalize 在拍 after 前跑（选区 mask 插槽）。
     *  o.checkpoint：compound 微步纪律用（v0.8.2 S2——selection-ops 挖洞等复合动作传 false）。 */
    commit(finalize?: (layer: Layer, preSnap: PreSnapImage) => void, o?: {
        checkpoint?: boolean;
    }): boolean;
    /** 放弃（层从未被改过的取消路径，如 adjust 预览全在 surrogate 上）：只释放快照，不还原不入栈。 */
    dispose(): void;
    /** 还原到 before，不入栈。 */
    abort(): void;
}
interface PixelEditDeps {
    doc: PaintDoc;
    w: Workpiece;
    history: UndoHistory;
    ops: OperatorRegistry;
    board?: {
        invalidateAll(): void;
    } | null;
}
/** PixelEdit 同名门面（input/filters 的 begin(layer, label) 调用形状不变）。 */
export declare class PixelEdits {
    private _deps;
    constructor(deps: PixelEditDeps);
    begin(layer: Layer, label: string): PixelTx;
}
export {};
