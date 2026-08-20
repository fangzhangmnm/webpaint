import type { Gl2Port } from "../common/gl2-port.ts";
import { RasterService } from "../backend/gl/raster-service.ts";
import type { FloatInput, OverlayInput, SurrogateInput } from "../backend/gl/gl-room.ts";
import type { LayerPixels } from "../backend/tiles/tile-layer.ts";
import type { DocNode, DocLeaf } from "../backend/gl/gl-doc-bridge.ts";
export interface GLDoc {
    layers: DocNode[];
    width: number;
    height: number;
}
export type { DocLeaf as GLLeaf } from "../backend/gl/gl-doc-bridge.ts";
export declare class GLBoard {
    private _glctx;
    private _room;
    private _tree;
    private _raster;
    constructor(glctx: Gl2Port, maxSlices: number);
    get memory(): {
        usedTiles: number;
        capacity: number;
        usedBytes: number;
        committedBytes: number;
        quotaBytes: number;
    };
    get stats(): {
        passes: number;
        floatPasses: number;
    };
    get fboPoolStats(): {
        count: number;
        bytes: number;
    };
    get frameStats(): {
        segBuilds: number;
        segHits: number;
        cachingDegraded: boolean;
    };
    markContentDirty(): void;
    commitBrushStroke(leafId: number, pixels: LayerPixels, ov: OverlayInput, docW: number, docH: number, apply: (px: Uint8ClampedArray, x: number, y: number, w: number, h: number) => {
        tx: number;
        ty: number;
    }[]): boolean;
    rasterizeStampsToBytes(stamps: Parameters<RasterService["rasterizeStampsToBytes"]>[0], shape: Parameters<RasterService["rasterizeStampsToBytes"]>[1], bx: number, by: number, bw: number, bh: number): Uint8ClampedArray | null;
    compositeToBytes(nodes: DocNode[], docW: number, docH: number, surrogate?: SurrogateInput | null, overlay?: OverlayInput | null): {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    } | null;
    pickColor(doc: GLDoc, docBg: string | null, x: number, y: number, surrogate?: SurrogateInput | null, overlay?: OverlayInput | null): [number, number, number, number] | null;
    warpToBytes(src: Parameters<RasterService["warpToBytes"]>[0], srcW: number, srcH: number, hinv: number[], mode: number, bx: number, by: number, bw: number, bh: number): {
        data: Uint8ClampedArray;
        w: number;
        h: number;
        dstX: number;
        dstY: number;
    } | null;
    render(doc: GLDoc, affine6: number[], canvasW: number, canvasH: number, scale: number, voidColor: string, docBg: string | null, floats?: FloatInput[], stampOverlay?: OverlayInput | null, liveSyncLeaf?: DocLeaf | null, surrogate?: SurrogateInput | null, gridBg?: {
        dotColor: string;
        stepPx: number;
        radiusPx: number;
    } | null): void;
}
