import { LayerPixels, type PixelsSnapshot } from "../tiles/tile-layer.ts";
import type { PaintingWorkpiece } from "./painting-workpiece.ts";
import type { LayerTiles } from "./layer-tiles.ts";
import type { Selection } from "../selection.ts";
type Bitmap = OffscreenCanvas | HTMLCanvasElement;
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
export interface ViewLeafSnap {
    pixels: PixelsSnapshot;
}
export declare function disposeViewSnap(snap: ViewLeafSnap | null | undefined): void;
/** 叶 view：旧 Layer 的读写面，像素 = tileset 注册表里的活 LayerPixels。 */
export declare class ViewLeaf {
    readonly isGroup: false;
    readonly id: number;
    name: string;
    visible: boolean;
    opacity: number;
    mode: string;
    clippingMask: boolean;
    lockAlpha: boolean;
    docW: number;
    docH: number;
    /** @internal 属性回灌（端口 resync 用）。 */
    _pixelsRef: number;
    private _tiles;
    private _mat;
    private _empty;
    constructor(tiles: LayerTiles, id: number);
    /** 活像素（tileset 注册表解析；叶已被删时端口不再发出本对象，getter 假定 ref 有效）。 */
    get pixels(): LayerPixels;
    /** 内容版本（全局单调不复用；lineart-oracle 等 (id,rev) 缓存键）。 */
    get contentRev(): number;
    private _ensureMat;
    /** 纯腾内存（GL 模式每帧后调；下次访问按需重建）。 */
    releaseMaterialized(): void;
    residentBytes(countMat: boolean): number;
    get canvas(): Bitmap;
    get ctx(): Ctx2D;
    get bboxX(): number;
    get bboxY(): number;
    get bboxW(): number;
    get bboxH(): number;
    get width(): number;
    get height(): number;
    editRegion(x0: number, y0: number, w: number, h: number, fn: (ctx: CanvasRenderingContext2D, ox: number, oy: number) => void): void;
    editRegionBytes(x0: number, y0: number, w: number, h: number, fn: (buf: Uint8ClampedArray, ox: number, oy: number) => void): void;
    replaceFromBytes(data: Uint8ClampedArray, ox: number, oy: number, w: number, h: number): void;
    clearAll(): void;
    sampleAt(docX: number, docY: number): [number, number, number, number];
    getImageData(docX: number, docY: number, w: number, h: number): ImageData;
    putImageData(docX: number, docY: number, img: ImageData): void;
    applyRegionDiff(docX: number, docY: number, w: number, h: number, src: Uint8ClampedArray): {
        tx: number;
        ty: number;
    }[];
    snapshot(): ViewLeafSnap;
    restoreFromSnapshot(snap: ViewLeafSnap): void;
    /** CPU 算法读者的只读物化（液化 startSnap/选区 preSnap）；空层 imageData:null。 */
    snapshotImageData(): {
        bboxX: number;
        bboxY: number;
        bboxW: number;
        bboxH: number;
        imageData: ImageData | null;
    };
}
/** 组 view：纯结构镜像（每次 resync 重建，children 里叶按 id 复用）。 */
export declare class ViewGroup {
    readonly isGroup: true;
    readonly id: number;
    name: string;
    visible: boolean;
    opacity: number;
    mode: string;
    clippingMask: boolean;
    children: ViewNode[];
    constructor(id: number);
}
export type ViewNode = ViewLeaf | ViewGroup;
export declare function eachViewLeaf(nodes: readonly ViewNode[], fn: (leaf: ViewLeaf) => void): void;
export declare function flattenViewLeaves(nodes: readonly ViewNode[]): ViewLeaf[];
export declare function findViewNodeById(nodes: readonly ViewNode[], id: number | null): ViewNode | null;
export declare function countViewLeaves(nodes: readonly ViewNode[]): number;
/** app 的文档读写端口（旧 ctx.doc = DocView 的后继；单例，跨换文档稳定）。 */
export declare class PaintingView {
    private _wp;
    private _nodes;
    private _leafCache;
    private _lastRoot;
    private _selection;
    private _memBudgetBytes;
    private _memCountMat;
    constructor(wp: PaintingWorkpiece);
    private get _tree();
    /** 根引用身份同步：LayerTree2 每写换新根 → 引用变了才重建镜像（叶按 id 复用）。 */
    private _sync;
    private _syncLeaf;
    get width(): number;
    get height(): number;
    get backgroundColor(): string;
    get activeId(): number | null;
    get referenceLayerId(): number | null;
    get layers(): ViewNode[];
    get activeLayer(): ViewNode | null;
    findLayer(id: number): ViewNode | null;
    /** 扁平叶序 index 兼容 getter（session-state 持久化用）。 */
    get activeIndex(): number;
    /** 节点同级位置（面板按钮态用）。 */
    locateNode(id: number): {
        parentId: number | null;
        index: number;
    } | null;
    canMoveLayer(id: number, toward: number): boolean;
    /** 「能否在当前 active 写像素」单谓词（语义沿旧 PaintDoc.activeEditableLeaf）。 */
    activeEditableLeaf({ allowHidden }?: {
        allowHidden?: boolean;
    }): {
        leaf: ViewLeaf | null;
        reason: string | null;
    };
    /** active 自身或任一祖先组隐藏？（变换类操作的盲改软拒。） */
    activeNodeHidden(): boolean;
    getReferenceLayer(): ViewNode | null;
    /** 魔棒/油漆桶 source：reference 优先，否则 active（组不可作源 → null）。 */
    getFloodSourceLayer(): ViewLeaf | null;
    get selection(): Selection | null;
    set selection(v: Selection | null);
    /** 换文档收尾（跨 session 不沿用选区——旧 adoptState 语义）。 */
    clearSelectionOnLoad(): void;
    configureMemory(budgetBytes: number, countMat: boolean): void;
    get maxLayers(): number;
    exchangeLeafPixels(layerId: number, np: LayerPixels): LayerPixels | null;
}
export {};
