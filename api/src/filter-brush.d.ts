import type { ViewLeaf } from "./workpiece/painting-view.ts";
import type { Selection } from "./selection.ts";
interface BrushFilter {
    id?: string;
    beginBrushStroke(layer: ViewLeaf, params: unknown, brushSettings: unknown, selection: Selection | null, x: number, y: number, pressure: number): unknown;
    extendBrushStamp(state: unknown, x: number, y: number, pressure: number): void;
    endBrushStroke?(state: unknown): void;
    cancelBrushStroke?(state: unknown): void;
    flushDirty?(state: unknown): [number, number, number, number] | null;
}
export declare class FilterBrushEngine {
    _handle: unknown;
    _Filter: BrushFilter | null;
    constructor();
    beginStroke(layer: ViewLeaf, Filter: BrushFilter, params: unknown, brushSettings: unknown, selection: Selection | null, x: number, y: number, pressure: number): void;
    extendStroke(x: number, y: number, pressure: number): void;
    endStroke(): void;
    cancelStroke(): void;
    flushDirty(): [number, number, number, number] | null;
    isActive(): boolean;
}
export {};
