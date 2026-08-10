import { GpuTilePool, GLGpuTileBackend, IndexTexture } from "./gpu-tile-pool.ts";
import { CpuGpuTileBridge } from "./tile-bridge.ts";
import { GLCompositor } from "./gl-compositor.ts";
import type { Acc, OverlayDesc, FloatDesc } from "./gl-compositor.ts";
import type { DocNode, DocLeaf } from "./gl-doc-bridge.ts";
import { LayerPixels } from "../tiles/tile-layer.ts";
import { GLStampRasterizer } from "./gl-stamp.ts";
import type { Stamp, StrokeShape } from "./gl-stamp.ts";
import type { PlanNode, PlanStep, SegBuild } from "../render/render-plan.ts";
import type { PooledFBO, FBOPrec, Gl2Port } from "../common/gl2-port.ts";
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
export declare function overlayEmpty(ov: OverlayInput): boolean;
export interface LeafRec {
    index: IndexTexture;
    byKey: Map<number, number>;
    src: LayerPixels | null;
    cpuVersion: number;
    gen: number;
}
export declare class GlRoom {
    readonly glctx: Gl2Port;
    readonly backend: GLGpuTileBackend;
    readonly pool: GpuTilePool;
    readonly bridge: CpuGpuTileBridge;
    readonly comp: GLCompositor;
    readonly rasterizer: GLStampRasterizer;
    readonly leaves: Map<number, LeafRec>;
    private _overlay;
    private _overlayOwnedFBO;
    private _selTex;
    private _selTexSrc;
    private _fillTex;
    private _fillTexColor;
    private _floatTex;
    private _floats;
    private _liveMergedClip;
    private _invalidateListeners;
    constructor(glctx: Gl2Port, maxSlices: number, accumPrec?: FBOPrec);
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
    onInvalidate(cb: () => void): void;
    invalidateTree(): void;
    handleContextRestored(): void;
    syncLeafSafe(leafId: number, pixels: LayerPixels, docW: number, docH: number): void;
    private _syncPixels;
    syncSurrogate(s: SurrogateInput, docW: number, docH: number): void;
    recAlive(rec: {
        byKey: Map<number, number>;
    }): boolean;
    cpuAlive(): (id: number) => boolean;
    toPlanNodes(nodes: DocNode[], updated: Set<number>, overlayLeafId: number | null, leafById: Map<number, DocLeaf>): PlanNode[];
    composeSteps(steps: PlanStep[], acc: Acc, docW: number, docH: number, transient: Map<string, PooledFBO>, segLookup: ((key: string) => IndexTexture | undefined) | null): void;
    composeSegTransient(b: SegBuild, docW: number, docH: number, bg: Parameters<GLCompositor["newAcc"]>[2]): PooledFBO;
    liveClipTexFor(clipBaseId: number | null, docW: number, docH: number): WebGLTexture | null;
    releaseLiveClip(): void;
    get hasOverlay(): boolean;
    get overlayLayerId(): number | null;
    overlayDesc(): OverlayDesc | null;
    clearOverlay(): void;
    releaseOverlayFBO(): void;
    setStampOverlay(ov: OverlayInput, docW: number, docH: number): void;
    private _uploadSelMask;
    get floats(): ReadonlyMap<number, FloatDesc>;
    setFloats(floats: FloatInput[]): void;
}
export declare function poolCapacityForBudget(budgetBytes: number): number;
