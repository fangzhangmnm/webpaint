export interface CropRect {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface CropSizeOpts {
    min?: number;
    max?: number;
}
export declare function resizeCropRect(handle: string, startRect: CropRect, dx: number, dy: number, opts?: CropSizeOpts): CropRect;
export declare function resizeCropRectAspect(handle: string, startRect: CropRect, dx: number, dy: number, aspect: number, opts?: CropSizeOpts): CropRect;
export declare function fitRectToBBox(bbox: CropRect, aspect: number, mode: "cover" | "contain"): CropRect;
export declare function cropRectToInts(rect: CropRect, opts?: CropSizeOpts): CropRect;
