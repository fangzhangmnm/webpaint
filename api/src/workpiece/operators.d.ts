import { DocumentOperator, Workpiece, type OpResult } from "./workpiece.ts";
import type { LayerPixels } from "../tiles/tile-layer.ts";
export interface FillColorArgs {
    value: string;
    _initialBefore?: {
        v: string;
    } | null;
}
export declare class FillColorOp extends DocumentOperator<FillColorArgs, {
    v: string;
}> {
    readonly kind = "fillColor";
    private _c;
    constructor(color: {
        get(): string;
        set(hex: string): void;
    });
    forward(_w: Workpiece, args: FillColorArgs, data: {
        v: string;
    } | undefined): OpResult<{
        v: string;
    }>;
    backward(_w: Workpiece, _args: FillColorArgs, data: {
        v: string;
    }): OpResult<{
        v: string;
    }>;
}
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
    fillColor: FillColorOp;
    docResize: DocResizeOp;
}
export declare function makeOperators(deps: {
    fillColor: {
        get(): string;
        set(hex: string): void;
    };
}): OperatorRegistry;
export {};
