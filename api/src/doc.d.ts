import { LayerPixels, type PixelsSnapshot } from "./tiles/tile-layer.ts";
export declare const DEFAULT_DOC_SIZE = 2048;
type Bitmap = OffscreenCanvas | HTMLCanvasElement;
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type Node = Layer | LayerGroup;
export interface LayerSnap {
    pixels: PixelsSnapshot;
}
export declare function disposeLayerSnap(snap: LayerSnap | null | undefined): void;
export interface LayerSpecShape {
    id: number;
    name: string;
    visible?: boolean;
    opacity?: number;
    mode?: string;
    clippingMask?: boolean;
    lockAlpha?: boolean;
    snap?: LayerSnap | null;
}
export declare function disposeLayerSpec(spec: LayerSpecShape | null | undefined): void;
export declare function disposeDeepSnapNodes(nodes: DeepSnapNode[]): void;
type TreeSnapNode = {
    isGroup: false;
    ref: Layer;
} | {
    isGroup: true;
    id: number;
    name: string;
    visible: boolean;
    opacity: number;
    mode: string;
    clippingMask: boolean;
    collapsed: boolean;
    children: TreeSnapNode[];
};
export type DeepSnapNode = {
    isGroup: false;
    id: number;
    name: string;
    visible: boolean;
    opacity: number;
    mode: string;
    clippingMask: boolean;
    lockAlpha: boolean;
    snap: LayerSnap;
} | {
    isGroup: true;
    id: number;
    name: string;
    visible: boolean;
    opacity: number;
    mode: string;
    clippingMask: boolean;
    collapsed: boolean;
    children: DeepSnapNode[];
};
import type { Selection } from "./selection.ts";
export declare class Layer {
    id: number;
    isGroup: false;
    name: string;
    visible: boolean;
    opacity: number;
    mode: string;
    clippingMask: boolean;
    lockAlpha: boolean;
    docW: number;
    docH: number;
    pixels: LayerPixels;
    private _mat;
    private _empty;
    contentRev: number;
    constructor({ width, height, name }?: {
        width: number;
        height: number;
        name?: string;
        empty?: boolean;
    });
    private _ensureMat;
    private _invalidate;
    releaseMaterialized(): void;
    residentBytes(countMat: boolean): number;
    get canvas(): Bitmap;
    get ctx(): Ctx;
    get bboxX(): number;
    get bboxY(): number;
    get bboxW(): number;
    get bboxH(): number;
    get width(): number;
    get height(): number;
    editRegion(x0: number, y0: number, w: number, h: number, fn: (ctx: CanvasRenderingContext2D, ox: number, oy: number) => void): void;
    editRegionBytes(x0: number, y0: number, w: number, h: number, fn: (buf: Uint8ClampedArray, ox: number, oy: number) => void): void;
    replaceFromCanvas(srcCanvas: CanvasImageSource, ox: number, oy: number, w: number, h: number): void;
    replaceFromBytes(data: Uint8ClampedArray, ox: number, oy: number, w: number, h: number): void;
    clearAll(): void;
    setPixels(p: LayerPixels, newDocW: number, newDocH: number): void;
    remapPixels(newDocW: number, newDocH: number, src: CanvasImageSource | null, ox?: number, oy?: number, w?: number, h?: number): void;
    remapPixelsBytes(newDocW: number, newDocH: number, data: Uint8ClampedArray | null, ox: number, oy: number, w: number, h: number): void;
    sampleAt(docX: number, docY: number): [number, number, number, number];
    getImageData(docX: number, docY: number, w: number, h: number): ImageData;
    putImageData(docX: number, docY: number, img: ImageData): void;
    applyRegionDiff(docX: number, docY: number, w: number, h: number, src: Uint8ClampedArray): {
        tx: number;
        ty: number;
    }[];
    _freezeLeafView(): FrozenLeaf & {
        _snap: PixelsSnapshot;
    };
    snapshot(): LayerSnap;
    restoreFromSnapshot(snap: LayerSnap): void;
    snapshotImageData(): {
        bboxX: number;
        bboxY: number;
        bboxW: number;
        bboxH: number;
        imageData: ImageData | null;
    };
}
export declare class LayerGroup {
    id: number;
    isGroup: true;
    name: string;
    visible: boolean;
    opacity: number;
    mode: string;
    clippingMask: boolean;
    collapsed: boolean;
    children: Node[];
    constructor({ name, children }?: {
        name?: string;
        children?: Node[];
    });
}
export declare function eachLeaf(nodes: readonly Node[], fn: (leaf: Layer) => void): void;
export declare function flattenLeaves(nodes: readonly Node[]): Layer[];
export declare function findNodeById(nodes: readonly Node[], id: number | null): Node | null;
export declare function findParentOf(nodes: Node[], id: number | null, parentNode?: LayerGroup | null): {
    parent: Node[];
    parentNode: LayerGroup | null;
    index: number;
    node: Node;
} | null;
export declare function countLeaves(nodes: readonly Node[]): number;
export declare function reseedLayerIdCounter(nodes: Node[]): void;
export declare class PaintDoc {
    width: number;
    height: number;
    layers: Node[];
    activeId: number | null;
    backgroundColor: string;
    selection: Selection | null;
    referenceLayerId: number | null;
    _memBudgetBytes: number | null;
    _memCountMat: boolean;
    constructor({ width, height }?: {
        width?: number;
        height?: number;
    });
    adoptState(loaded: {
        layers: Node[];
        activeId?: number | null;
        activeIndex?: number;
        width: number;
        height: number;
        backgroundColor: string;
        referenceLayerId?: number | null;
    }): void;
    getReferenceLayer(): Node | null;
    getFloodSourceLayer(): Layer | null;
    get activeLayer(): Node | null;
    activeEditableLeaf({ allowHidden }?: {
        allowHidden?: boolean;
    }): {
        leaf: Layer | null;
        reason: string | null;
    };
    activeNodeHidden(): boolean;
    get activeIndex(): number;
    set activeIndex(i: number);
    configureMemory(budgetBytes: number, countMat: boolean): void;
    get maxLayers(): number;
    setActive(index: number): boolean;
    setActiveById(id: number): boolean;
    _insertAtActive(node: Node): void;
    addLayer(name?: string): Layer | null;
    _nextLayerNum(): number;
    _nextLayerName(): string;
    removeLayer(id: number, allowEmpty?: boolean): boolean;
    layerSpec(L: Layer): LayerSpecShape;
    collapseGroupToLayer(id: number, merged: {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    } | null): Layer | null;
    explodeLayerToLayers(id: number, parts: {
        data: Uint8ClampedArray;
        name: string;
    }[], rect: {
        ox: number;
        oy: number;
        w: number;
        h: number;
    }): Layer[] | null;
    stampAllToTopLayer(merged: {
        data: Uint8ClampedArray;
        w: number;
        h: number;
    }): Layer | null;
    mergeDownLayer(L: Layer): {
        ok: boolean;
        reason: string;
        underId?: undefined;
        underBefore?: undefined;
        underAfter?: undefined;
        underBeforeOpacity?: undefined;
        underBeforeMode?: undefined;
        underBeforeClipping?: undefined;
        resultClipping?: undefined;
        activeSpec?: undefined;
        activeLoc?: undefined;
    } | {
        ok: boolean;
        underId: number;
        underBefore: LayerSnap;
        underAfter: LayerSnap;
        underBeforeOpacity: number;
        underBeforeMode: string;
        underBeforeClipping: boolean;
        resultClipping: boolean;
        activeSpec: LayerSpecShape;
        activeLoc: {
            parentId: number | null;
            index: number;
        };
        reason?: undefined;
    };
    insertLayerAt(index: number, spec: LayerSpecShape, parentId?: number | null): boolean;
    locateNode(id: number): {
        parentId: number | null;
        index: number;
    } | null;
    canMoveLayer(id: number, toward: number): boolean;
    findLayer(id: number): Node | null;
    moveLayer(id: number, toward: number): boolean;
    duplicateLayer(id: number): {
        ok: boolean;
        reason: string;
        newLayer?: undefined;
        loc?: undefined;
    } | {
        ok: boolean;
        newLayer: Layer;
        loc: {
            parentId: number | null;
            index: number;
        };
        reason?: undefined;
    };
    addGroup(name?: string): LayerGroup;
    groupSelection(id: number): {
        ok: boolean;
        reason: string;
        group?: undefined;
    } | {
        ok: boolean;
        group: LayerGroup;
        reason?: undefined;
    };
    ungroup(groupId: number): {
        ok: boolean;
        reason: string;
        childIds?: undefined;
    } | {
        ok: boolean;
        childIds: number[];
        reason?: undefined;
    };
    moveIntoGroup(id: number, groupId: number): boolean;
    moveOutOfGroup(id: number): boolean;
    snapshotTree(): {
        activeId: number | null;
        nodes: TreeSnapNode[];
    };
    restoreTree(snap: {
        activeId: number | null;
        nodes: TreeSnapNode[];
    } | null): void;
    clearActiveLayer(): void;
    _nodeSnap(n: Node): DeepSnapNode;
    _nodeFromSnap(s: DeepSnapNode): Node;
    snapshotAll(): {
        width: number;
        height: number;
        activeId: number | null;
        activeIndex: number;
        referenceLayerId: number | null;
        selection: Selection | null;
        layers: DeepSnapNode[];
    };
    restoreSnapshotAll(snap: {
        width: number;
        height: number;
        activeId?: number | null;
        activeIndex?: number;
        referenceLayerId: number | null;
        selection: Selection | null;
        layers: DeepSnapNode[];
    } | null): void;
    cropResampleTo(frame: {
        x: number;
        y: number;
        w: number;
        h: number;
    }, tw: number, th: number, mode?: string): void;
    cropTo(rect: {
        x: number;
        y: number;
        w: number;
        h: number;
    }): void;
    flipHorizontal(): void;
    rotate90CCW(): void;
    resampleTo(newW: number, newH: number, mode?: string): void;
    offsetWrap(dx: number, dy: number): void;
}
export declare const LAYER_HARD_CEIL = 64;
export declare function layerByteBudget(): number;
export declare function computeMaxLayers(currentLeafCount: number, residentBytes: number, budgetBytes?: number): number;
export interface FrozenLeaf {
    isGroup: false;
    id: number;
    name: string;
    opacity: number;
    mode: string;
    visible: boolean;
    clippingMask: boolean;
    lockAlpha: boolean;
    docW: number;
    docH: number;
    readonly canvas: Bitmap;
    readonly bboxX: number;
    readonly bboxY: number;
    readonly bboxW: number;
    readonly bboxH: number;
    readonly width: number;
    readonly height: number;
    /** v0.6.44：快照 tiles 字节直读（ora 存层走它——真机曾因缺此方法推送失败，见下）。零 canvas。 */
    getImageData(x: number, y: number, w: number, h: number): ImageData;
}
export interface FrozenGroup {
    isGroup: true;
    id: number;
    name: string;
    opacity: number;
    mode: string;
    visible: boolean;
    clippingMask: boolean;
    children: FrozenNode[];
}
export type FrozenNode = FrozenLeaf | FrozenGroup;
export interface FrozenDoc {
    width: number;
    height: number;
    backgroundColor: string;
    layers: FrozenNode[];
    activeId: number | null;
    referenceLayerId: number | null;
}
export declare function freezeDocForEncode(doc: PaintDoc): {
    frozen: FrozenDoc;
    dispose(): void;
};
export {};
