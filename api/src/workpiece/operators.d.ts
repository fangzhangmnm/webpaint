import { DocumentOperator, Workpiece, type OpResult } from "./workpiece.ts";
import type { LayerPixels } from "../tiles/tile-layer.ts";
type ResizeSide = {
    leaves: {
        layerId: number;
        lp: LayerPixels;
    }[];
};
export interface DocResizeArgs {
    _initial?: ResizeSide | null;
}
export declare class DocResizeOp extends DocumentOperator<DocResizeArgs, ResizeSide> {
    readonly kind = "docResize";
    forward(w: Workpiece, args: DocResizeArgs, data: ResizeSide | undefined): OpResult<ResizeSide>;
    backward(w: Workpiece, _args: DocResizeArgs, data: ResizeSide): OpResult<ResizeSide>;
    private _swap;
    estimateQuotaBytes(args: DocResizeArgs, data: ResizeSide | undefined): number;
    disposeData(args: DocResizeArgs, data: ResizeSide | undefined): void;
}
export interface OperatorRegistry {
    docResize: DocResizeOp;
}
export declare function makeOperators(): OperatorRegistry;
export {};
