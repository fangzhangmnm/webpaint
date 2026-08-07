import { DocumentOperator, Workpiece, type OpResult } from "./workpiece.ts";
import { type LayerSpecShape, type LayerSnap, type PaintDoc } from "../doc.ts";
import { LiftFloatOp, FloatTransformOp, DropFloatOp } from "./float-ops.ts";
import type { Selection } from "../selection.ts";
export interface SwapPixelsArgs {
    layerId: number;
    _initialBefore?: LayerSnap | null;
}
export declare class SwapPixelsOp extends DocumentOperator<SwapPixelsArgs, LayerSnap> {
    readonly kind = "pixels";
    forward(w: Workpiece, args: SwapPixelsArgs, data: LayerSnap | undefined): OpResult<LayerSnap>;
    backward(w: Workpiece, args: SwapPixelsArgs, data: LayerSnap): OpResult<LayerSnap>;
    private _install;
    estimateQuotaBytes(args: SwapPixelsArgs, data: LayerSnap | undefined): number;
    disposeData(args: SwapPixelsArgs, data: LayerSnap | undefined): void;
}
export interface SwapSelectionArgs {
    _initialBefore?: {
        v: Selection | null;
    } | null;
}
type SelBox = {
    v: Selection | null;
};
export declare class SwapSelectionOp extends DocumentOperator<SwapSelectionArgs, SelBox> {
    readonly kind = "selection";
    forward(w: Workpiece, args: SwapSelectionArgs, data: SelBox | undefined): OpResult<SelBox>;
    backward(w: Workpiece, _args: SwapSelectionArgs, data: SelBox): OpResult<SelBox>;
    estimateQuotaBytes(args: SwapSelectionArgs, data: SelBox | undefined): number;
    disposeData(args: SwapSelectionArgs, data: SelBox | undefined): void;
}
export interface LayerPropArgs {
    layerId: number;
    prop: string;
    value: unknown;
    _initialOld?: {
        v: unknown;
    } | null;
}
export declare class LayerPropOp extends DocumentOperator<LayerPropArgs, {
    v: unknown;
}> {
    readonly kind = "layerProp";
    forward(w: Workpiece, args: LayerPropArgs, data: {
        v: unknown;
    } | undefined): OpResult<{
        v: unknown;
    }>;
    backward(w: Workpiece, args: LayerPropArgs, data: {
        v: unknown;
    }): OpResult<{
        v: unknown;
    }>;
}
export declare class ReferenceLayerOp extends DocumentOperator<{
    value: number | null;
}, {
    v: number | null;
}> {
    readonly kind = "referenceLayer";
    forward(w: Workpiece, args: {
        value: number | null;
    }, data: {
        v: number | null;
    } | undefined): OpResult<{
        v: number | null;
    }>;
    backward(w: Workpiece, _args: {
        value: number | null;
    }, data: {
        v: number | null;
    }): OpResult<{
        v: number | null;
    }>;
}
export interface FillColorArgs {
    value: string;
    _initialBefore?: {
        v: string;
    } | null;
}
export declare class FillColorOp extends DocumentOperator<FillColorArgs, {
    v: string;
}> {
    readonly kind = "fillColor";
    private _c;
    constructor(color: {
        get(): string;
        set(hex: string): void;
    });
    forward(_w: Workpiece, args: FillColorArgs, data: {
        v: string;
    } | undefined): OpResult<{
        v: string;
    }>;
    backward(_w: Workpiece, _args: FillColorArgs, data: {
        v: string;
    }): OpResult<{
        v: string;
    }>;
}
export interface AddLayerArgs {
    layerId: number;
    index: number;
    parentId: number | null;
    prevActiveId: number | null;
    layerName: string;
}
export declare class AddLayerRecordOp extends DocumentOperator<AddLayerArgs, LayerSpecShape | null> {
    readonly kind = "addLayer";
    forward(w: Workpiece, args: AddLayerArgs, data: LayerSpecShape | null | undefined): OpResult<LayerSpecShape | null>;
    backward(w: Workpiece, args: AddLayerArgs, _data: LayerSpecShape | null): OpResult<LayerSpecShape | null>;
    estimateQuotaBytes(_a: AddLayerArgs, data: LayerSpecShape | null | undefined): number;
    disposeData(_a: AddLayerArgs, data: LayerSpecShape | null | undefined): void;
    statusFor(dir: "do" | "undo" | "redo", args: AddLayerArgs): string | undefined;
}
interface RemovedRecord {
    spec: LayerSpecShape;
    index: number;
    parentId: number | null;
    prevActiveId: number | null;
}
export interface RemoveLayerArgs {
    layerId: number;
    layerName: string;
    allowEmpty?: boolean;
}
export declare class RemoveLayerRecordOp extends DocumentOperator<RemoveLayerArgs, RemovedRecord | undefined> {
    readonly kind = "removeLayer";
    forward(w: Workpiece, args: RemoveLayerArgs, _data: RemovedRecord | undefined): OpResult<RemovedRecord | undefined>;
    backward(w: Workpiece, args: RemoveLayerArgs, data: RemovedRecord): OpResult<RemovedRecord | undefined>;
    estimateQuotaBytes(_a: RemoveLayerArgs, data: RemovedRecord | undefined): number;
    disposeData(_a: RemoveLayerArgs, data: RemovedRecord | undefined): void;
    statusFor(dir: "do" | "undo" | "redo", args: RemoveLayerArgs): string | undefined;
}
export declare class MoveLayerOp extends DocumentOperator<{
    layerId: number;
    delta: number;
}, undefined> {
    readonly kind = "moveLayer";
    forward(w: Workpiece, args: {
        layerId: number;
        delta: number;
    }, _d: undefined): OpResult<undefined>;
    backward(w: Workpiece, args: {
        layerId: number;
        delta: number;
    }, _d: undefined): OpResult<undefined>;
}
type TreeSnap = ReturnType<PaintDoc["snapshotTree"]>;
export interface TreeStructureArgs {
    before: TreeSnap;
    after: TreeSnap;
    undoStatus?: string;
    redoStatus?: string;
}
export declare class TreeStructureOp extends DocumentOperator<TreeStructureArgs, undefined> {
    readonly kind = "treeStructure";
    forward(w: Workpiece, args: TreeStructureArgs, _d: undefined): OpResult<undefined>;
    backward(w: Workpiece, args: TreeStructureArgs, _d: undefined): OpResult<undefined>;
    statusFor(dir: "do" | "undo" | "redo", args: TreeStructureArgs): string | undefined;
}
type MergeRecord = {
    underId: number;
    underBefore: LayerSnap;
    underBeforeOpacity: number;
    underBeforeMode: string;
    underBeforeClipping: boolean;
    activeSpec: LayerSpecShape;
    activeLoc: {
        parentId: number | null;
        index: number;
    };
};
export declare class MergeDownOp extends DocumentOperator<{
    layerId: number;
}, MergeRecord | undefined> {
    readonly kind = "mergeDown";
    forward(w: Workpiece, args: {
        layerId: number;
    }, data: MergeRecord | undefined): OpResult<MergeRecord | undefined>;
    backward(w: Workpiece, args: {
        layerId: number;
    }, data: MergeRecord): OpResult<MergeRecord | undefined>;
    estimateQuotaBytes(_a: {
        layerId: number;
    }, data: MergeRecord | undefined): number;
    disposeData(_a: {
        layerId: number;
    }, data: MergeRecord | undefined): void;
    statusFor(dir: "do" | "undo" | "redo", _args: {
        layerId: number;
    }): string | undefined;
}
type DocSnapAll = ReturnType<PaintDoc["snapshotAll"]>;
export interface DocTransformArgs {
    before: {
        doc: DocSnapAll;
        viewport?: Record<string, number> | null;
        persp?: unknown;
    };
    after: {
        doc: DocSnapAll;
        viewport?: Record<string, number> | null;
        persp?: unknown;
    };
}
export declare class DocTransformOp extends DocumentOperator<DocTransformArgs, boolean> {
    readonly kind = "docTransform";
    private _applyUi;
    constructor(applyUi: (viewport: Record<string, number> | null | undefined, persp?: unknown) => void);
    forward(w: Workpiece, args: DocTransformArgs, data: boolean | undefined): OpResult<boolean>;
    backward(w: Workpiece, args: DocTransformArgs, _data: boolean): OpResult<boolean>;
    estimateQuotaBytes(args: DocTransformArgs): number;
    disposeData(args: DocTransformArgs): void;
}
export interface OperatorRegistry {
    pixels: SwapPixelsOp;
    selection: SwapSelectionOp;
    layerProp: LayerPropOp;
    referenceLayer: ReferenceLayerOp;
    fillColor: FillColorOp;
    addLayer: AddLayerRecordOp;
    removeLayer: RemoveLayerRecordOp;
    moveLayer: MoveLayerOp;
    treeStructure: TreeStructureOp;
    mergeDown: MergeDownOp;
    docTransform: DocTransformOp;
    liftFloat: LiftFloatOp;
    floatTransform: FloatTransformOp;
    dropFloat: DropFloatOp;
}
export declare function makeOperators(deps: {
    applyDocTransformUi: (viewport: Record<string, number> | null | undefined, persp?: unknown) => void;
    fillColor: {
        get(): string;
        set(hex: string): void;
    };
}): OperatorRegistry;
export {};
