interface SegCount {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
    total: number;
}
export declare function segPositions(maxPx: number): SegCount;
export declare function sliderPosToSize(pos: number, maxPx: number): number;
export declare function sizeToSliderPos(size: number, maxPx: number): number;
export declare function sliderMaxPos(maxPx: number): number;
export declare function stepFor(size: number): number;
export declare function quantizeSize(v: number): number;
export {};
