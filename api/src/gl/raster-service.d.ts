import type { Background } from "./gl-compositor.ts";
import type { DocNode } from "./gl-doc-bridge.ts";
import type { LayerPixels } from "../tiles/tile-layer.ts";
import type { Stamp, StrokeShape } from "./gl-stamp.ts";
import type { PooledFBO } from "./gl-context.ts";
import type { GlRoom, OverlayInput, SurrogateInput } from "./gl-room.ts";
export declare class RasterService {
    private _room;
    constructor(room: GlRoom);
    rasterizeStampsToBytes(stamps: Stamp[], shape: StrokeShape, bx: number, by: number, bw: number, bh: number): Uint8ClampedArray | null;
    bakeStamps(leafId: number, pixels: LayerPixels, ov: OverlayInput, docW: number, docH: number, apply: (px: Uint8ClampedArray, x: number, y: number, w: number, h: number) => {
        tx: number;
        ty: number;
    }[]): boolean;
    warpToBytes(src: {
        data: Float32Array;
        w: number;
        h: number;
    } | {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    }, srcW: number, srcH: number, hinv: number[], mode: number, bx: number, by: number, bw: number, bh: number): {
        data: Uint8ClampedArray;
        w: number;
        h: number;
        dstX: number;
        dstY: number;
    } | null;
    compositeOnce(nodes: DocNode[], docW: number, docH: number, bg?: Background, surrogate?: SurrogateInput | null, overlay?: OverlayInput | null): PooledFBO;
    compositeToBytes(nodes: DocNode[], docW: number, docH: number): {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    };
    compositeToCanvas(nodes: DocNode[], docW: number, docH: number): HTMLCanvasElement;
    pickColor(nodes: DocNode[], docW: number, docH: number, bg: Background | undefined, x: number, y: number, surrogate?: SurrogateInput | null, overlay?: OverlayInput | null): [number, number, number, number];
}
