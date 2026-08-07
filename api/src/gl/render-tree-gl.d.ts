import type { Background } from "./gl-compositor.ts";
import type { DocNode } from "./gl-doc-bridge.ts";
import { LayerPixels } from "../tiles/tile-layer.ts";
import type { Stamp, StrokeShape } from "./gl-stamp.ts";
import type { PooledFBO, FBOPrec, GLContext } from "./gl-context.ts";
export interface SurrogateInput {
    layerId: number;
    bytes: {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    };
    bx: number;
    by: number;
    w: number;
    h: number;
}
export interface FloatInput {
    layerId: number;
    srcW: number;
    srcH: number;
    hinv: number[];
    mode: number;
    splinePlane?: {
        data: Float32Array;
        w: number;
        h: number;
    } | null;
    u8Plane?: {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    } | null;
}
export interface StampOverlayInput {
    stamps: Stamp[];
    shape: StrokeShape;
    bx: number;
    by: number;
    bw: number;
    bh: number;
    layerId: number;
    opacity: number;
    erase: boolean;
    blendMode: string;
    lockAlpha: boolean;
    selMask: {
        data: Uint8Array;
        ox: number;
        oy: number;
        ow: number;
        oh: number;
    } | null;
}
export interface FillOverlayInput {
    kind: "fill";
    color: [number, number, number];
    bx: number;
    by: number;
    bw: number;
    bh: number;
    layerId: number;
    lockAlpha: boolean;
    selMask: {
        data: Uint8Array;
        ox: number;
        oy: number;
        ow: number;
        oh: number;
    };
}
export type OverlayInput = StampOverlayInput | FillOverlayInput;
export declare class RenderTreeGL {
    private _glctx;
    private _backend;
    private _pool;
    private _bridge;
    private _comp;
    private _rasterizer;
    private _layerTiles;
    private _segCache;
    private _display;
    private _displaySig;
    private _dirty;
    private _lastDocW;
    private _lastDocH;
    private _lastPlan;
    private _overlayOwnedFBO;
    private _selTex;
    private _selTexSrc;
    private _fillTex;
    private _fillTexColor;
    private _overlay;
    private _floatTex;
    private _floats;
    private _liveMergedClip;
    readonly frameStats: {
        segBuilds: number;
        segHits: number;
        cachingDegraded: boolean;
    };
    constructor(glctx: GLContext, maxSlices: number, accumPrec?: FBOPrec);
    markDirty(): void;
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
    handleContextRestored(): void;
    rasterizeStampsToBytes(stamps: StampOverlayInput["stamps"], shape: StampOverlayInput["shape"], bx: number, by: number, bw: number, bh: number): Uint8ClampedArray | null;
    commitBrushStroke(leafId: number, pixels: LayerPixels, ov: OverlayInput, docW: number, docH: number, apply: (px: Uint8ClampedArray, x: number, y: number, w: number, h: number) => {
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
    renderFrame(nodes: DocNode[], docW: number, docH: number, bg: Background | undefined, affine6: number[], canvasW: number, canvasH: number, scale: number, voidRgb: [number, number, number], floats: FloatInput[], stampOverlay: OverlayInput | null, surrogate: SurrogateInput | null, liveSyncLeafId: number | null): void;
    compositeOnce(nodes: DocNode[], docW: number, docH: number, bg?: Background, surrogate?: SurrogateInput | null, overlay?: OverlayInput | null): PooledFBO;
    compositeToBytes(nodes: DocNode[], docW: number, docH: number): {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    };
    compositeToCanvas(nodes: DocNode[], docW: number, docH: number): HTMLCanvasElement;
    pickColor(nodes: DocNode[], docW: number, docH: number, bg: Background | undefined, x: number, y: number, surrogate?: SurrogateInput | null, overlay?: OverlayInput | null): [number, number, number, number];
    private _toPlanNodes;
    private _planSig;
    private _segValid;
    private _recAlive;
    private _invalidateSegs;
    private _coverageEstimate;
    private _syncLeafSafe;
    private _syncPixels;
    private _syncSurrogate;
    private _cpuAlive;
    private _buildSeg;
    private _composeSegTransient;
    private _liveClipTexFor;
    private _composeSteps;
    private _present;
    private _overlayDesc;
    private _setStampOverlay;
    private _uploadSelMask;
    private _setFloats;
}
export declare function poolCapacityForBudget(budgetBytes: number): number;
