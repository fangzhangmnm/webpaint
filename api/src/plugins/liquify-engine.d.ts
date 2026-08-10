import type { ViewLeaf } from "../backend/workpiece/painting-view.ts";
import type { SplinePlane } from "../backend/algorithms/bspline.ts";
import type { Selection } from "../backend/selection.ts";
interface LiquifySettings {
    bleed?: string;
    sample?: string;
    size: number;
    strength: number;
    mode: string;
}
interface DispField {
    bboxX: number;
    bboxY: number;
    bboxW: number;
    bboxH: number;
    data: Float32Array;
}
interface LayerSnapshot {
    bboxX: number;
    bboxY: number;
    bboxW: number;
    bboxH: number;
    imageData?: ImageData | null;
}
interface MaskPlane {
    x: number;
    y: number;
    w: number;
    h: number;
    data: Uint8Array;
}
interface LiquifyStroke {
    layer: ViewLeaf;
    settings: LiquifySettings;
    bleed: string;
    lastX: number;
    lastY: number;
    dirty: [number, number, number, number] | null;
    startSnap: LayerSnapshot;
    splinePlane: SplinePlane | null;
    dispField: DispField;
    selection: Selection | null;
    mask: MaskPlane | null;
}
export declare class LiquifyEngine {
    _stroke: LiquifyStroke | null;
    constructor();
    beginStroke(layer: ViewLeaf, settings: LiquifySettings, x: number, y: number, selection: Selection | null): void;
    extendStroke(x: number, y: number): void;
    endStroke(): void;
    isActive(): boolean;
    cancelStroke(): void;
    flushDirty(): [number, number, number, number] | null;
    _growDispField(x0: number, y0: number, x1: number, y1: number): void;
}
export declare function bilinearSample(sdat: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, ddat: Uint8ClampedArray, dstIdx: number): void;
export {};
