import { LayerPixels } from "../tiles/tile-layer.ts";
import type { RecordData } from "./undo-stack.ts";
import type { Workpiece, CollectorComponent } from "./workpiece2.ts";
/** 实例↔身份解析 + 实例替换（computed 变换用）。T2 由 app 以 doc 树实现；T3 起归 LayerTree json。 */
export interface TilesHost {
    getPixels(layerId: number): LayerPixels | null;
    findLayerIdByPixels(lp: LayerPixels): number | null;
    eachLayer(cb: (layerId: number, lp: LayerPixels) => void): void;
    /** 换整个 tileset 实例（旧实例由 host 负责 dispose）。computed 变换 apply 用。 */
    replacePixels(layerId: number, np: LayerPixels): void;
}
/** applyMaskPostStroke 的 preSnap 形状（原 pixel-tx PreSnapImage；selection.ts LayerSnapLike 同构）。 */
export interface PreSnapImage {
    bboxX: number;
    bboxY: number;
    bboxW: number;
    bboxH: number;
    imageData: ImageData | null;
}
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface TileEntry {
    tx: number;
    ty: number;
    contentId: number;
    bytes(): Uint8ClampedArray;
}
export declare class LayerTiles implements CollectorComponent {
    readonly kind = "layerTiles";
    private _wp;
    private _host;
    private _collected;
    private _computed;
    private _suspend;
    constructor(wp: Workpiece, host: TilesHost);
    /** legacy-bridge 协作面：旧 operator 应用期间挂起收集（其 undo 自带快照，收了=双记账）。 */
    _suspendCollect(on: boolean): void;
    version(layerId: number): number;
    tiles(layerId: number): IterableIterator<TileEntry>;
    contentBounds(layerId: number, tight?: boolean): Rect | null;
    getRegion(layerId: number, x: number, y: number, w: number, h: number): Uint8ClampedArray;
    putRegion(layerId: number, x: number, y: number, w: number, h: number, bytes: Uint8ClampedArray): void;
    editRegion(layerId: number, rect: Rect, fn: (buf: Uint8ClampedArray, ox: number, oy: number) => void): void;
    /** 整层替换（merge-down/滤镜 commit）：清空 + rect 整块写入（= 旧 replaceFromBytes 语义）。 */
    replaceLayer(layerId: number, bytes: Uint8ClampedArray, rect: Rect): void;
    clearLayer(layerId: number): void;
    flipHorizontalAll(): void;
    rotate90All(dir: 1 | -1): void;
    offsetWrapAll(dx: number, dy: number): void;
    /** 本 token 是否真的动过该层（collector 有它的扣押）。 */
    tokenChanged(layerId: number): boolean;
    /** 令牌前该层内容的紧 bbox 物化（applyMaskPostStroke 的 preSnap）。
     *  = 现内容 + collector 扣押件盖回（未变 tile 现值即前值）。仅带选区 finalize 才付这份钱。 */
    tokenBeforeImage(layerId: number): PreSnapImage;
    sealRecord(): RecordData | null;
    swapRecord(data: RecordData): RecordData;
    recordBytes(data: RecordData): number;
    disposeRecord(data: RecordData): void;
    private _onTileSwap;
    private _write;
    private _computedVerb;
    private _applyComputed;
    private _invertComputed;
    private _applyAll;
    private _applyRot;
    private _collectedCount;
    private _disposeCollected;
}
