export interface PixelStrokeSpec {
    engineKey: string;
    coalesceLatest: boolean;
    usesResolvedBrush: boolean;
    finalize: boolean;
    historyType: string;
}
export declare const PIXEL_STROKE_SPECS: Readonly<Record<string, PixelStrokeSpec>>;
export declare function isPixelStroke(role: string): boolean;
export declare function pixelStrokeSpec(role: string): PixelStrokeSpec | null;
