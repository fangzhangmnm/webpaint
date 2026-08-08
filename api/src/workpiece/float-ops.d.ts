import { DocumentOperator, Workpiece, type OpResult, type FloatState, type FloatTransformMeta, type FloatRect, type WorkpieceFloat } from "./workpiece.ts";
import { type ViewLeaf, type ViewLeafSnap } from "./painting-view.ts";
import { LayerPixels } from "../tiles/tile-layer.ts";
import type { Selection } from "../selection.ts";
export declare function estimateFloatPixelBytes(lp: LayerPixels): number;
export declare function cloneFloatMeta(t: FloatTransformMeta): FloatTransformMeta;
export declare function extractFloatPixels(leaf: ViewLeaf, sel: Selection | null): WorkpieceFloat | null;
export declare function composeCutHole(leaf: ViewLeaf, sel: Selection | null, region: FloatRect): {
    x: number;
    y: number;
    w: number;
    h: number;
    data: Uint8ClampedArray;
} | null;
export declare function applyRegionBuf(leaf: ViewLeaf, r: {
    x: number;
    y: number;
    w: number;
    h: number;
    data: Uint8ClampedArray;
}): void;
export declare function composeIdentityWriteback(leaf: ViewLeaf, f: WorkpieceFloat, ox?: number, oy?: number): {
    x: number;
    y: number;
    w: number;
    h: number;
    data: Uint8ClampedArray;
};
/** 整数刚体写回映射（v0.6.34 90° 族置换快路）：dest 整数矩形 (dx0,dy0,dw,dh)，
 *  dest 内偏移 (u,v) 的源 texel 索引 = (m11·u+m12·v+s0x, m21·u+m22·v+s0y)。
 *  系数 ∈ {−1,0,1} + 整数平移 → 纯像素置换，零重采样。 */
export interface RigidMap {
    dx0: number;
    dy0: number;
    dw: number;
    dh: number;
    m11: number;
    m12: number;
    s0x: number;
    m21: number;
    m22: number;
    s0y: number;
}
export declare function composeOverWriteback(leaf: ViewLeaf, x: number, y: number, w: number, h: number, src: Uint8ClampedArray): {
    x: number;
    y: number;
    w: number;
    h: number;
    data: Uint8ClampedArray;
};
export declare function composeRigidWriteback(leaf: ViewLeaf, f: WorkpieceFloat, m: RigidMap): {
    x: number;
    y: number;
    w: number;
    h: number;
    data: Uint8ClampedArray;
};
export interface LiftFloatArgs {
    nodeId: number;
    cut: boolean;
    fallbackFullLayer: boolean;
    ignoreSelection?: boolean;
}
export interface LiftSwapData {
    floats: FloatState | null;
    leafSnaps: {
        layerId: number;
        snap: ViewLeafSnap;
    }[];
    selection: {
        v: Selection | null;
    };
}
export declare class LiftFloatOp extends DocumentOperator<LiftFloatArgs, LiftSwapData> {
    readonly kind = "liftFloat";
    forward(w: Workpiece, args: LiftFloatArgs, data: LiftSwapData | undefined): OpResult<LiftSwapData>;
    backward(w: Workpiece, _args: LiftFloatArgs, data: LiftSwapData): OpResult<LiftSwapData>;
    private _swap;
    estimateQuotaBytes(_a: LiftFloatArgs, data: LiftSwapData | undefined): number;
    disposeData(_a: LiftFloatArgs, data: LiftSwapData | undefined): void;
}
export interface FloatTransformArgs {
    after: FloatTransformMeta;
}
export declare class FloatTransformOp extends DocumentOperator<FloatTransformArgs, {
    t: FloatTransformMeta;
}> {
    readonly kind = "floatTransform";
    forward(w: Workpiece, args: FloatTransformArgs, data: {
        t: FloatTransformMeta;
    } | undefined): OpResult<{
        t: FloatTransformMeta;
    }>;
    backward(w: Workpiece, _args: FloatTransformArgs, data: {
        t: FloatTransformMeta;
    }): OpResult<{
        t: FloatTransformMeta;
    }>;
}
export declare class DropFloatOp extends DocumentOperator<{
    reason?: string;
}, {
    fs: FloatState | null;
}> {
    readonly kind = "dropFloat";
    forward(w: Workpiece, _args: {
        reason?: string;
    }, data: {
        fs: FloatState | null;
    } | undefined): OpResult<{
        fs: FloatState | null;
    }>;
    backward(w: Workpiece, _args: {
        reason?: string;
    }, data: {
        fs: FloatState | null;
    }): OpResult<{
        fs: FloatState | null;
    }>;
    private _swap;
    estimateQuotaBytes(_a: {
        reason?: string;
    }, data: {
        fs: FloatState | null;
    } | undefined): number;
    disposeData(_a: {
        reason?: string;
    }, data: {
        fs: FloatState | null;
    } | undefined): void;
}
