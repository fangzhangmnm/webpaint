import type { BrushEngine } from "./brush.ts";
import type { FilterBrushEngine } from "./filter-brush.ts";
import type { ShapeBrushEngine } from "./shape-brush.ts";
import type { ViewLeaf, ViewLeafSnap } from "./workpiece/painting-view.ts";
import type { WriteToken } from "./workpiece/workpiece.ts";
import type { Selection } from "./selection.ts";
import { LayerPixels } from "./tiles/tile-layer.ts";
export type StrokeEngine = BrushEngine | FilterBrushEngine | ShapeBrushEngine;
export type StampCollect = NonNullable<ReturnType<BrushEngine["collectStamps"]>>;
/** 预览宿（census §3.4；见文件头）。 */
export type StrokePreview = "overlay" | "livesync" | "shadow";
export interface StrokeSessionDeps {
    /** wp2.begin —— 单令牌墙的开口（第二个 begin → throw） */
    begin(historyType: string): WriteToken;
    /** LayerTiles.tokenChanged —— 本令牌内该层是否真动过（finalize 谓词，防白付物化钱） */
    tokenChanged(layerId: number): boolean;
    /** LayerTiles.tokenBeforeImage —— 笔前像素现算（finalize 的 pre 图；只在真动过时才调） */
    tokenBeforeImage(layerId: number): Parameters<Selection["applyMaskPostStroke"]>[1];
    /** doc.selection 读面（finalize 兜底用；无选区 → null） */
    getSelection(): Selection | null;
    /** board.commitBrushStroke —— GPU merge（live 同一 shader）。true = 选区已在 shader 裁 */
    commitStamps(cs: StampCollect): boolean;
    /** board.invalidateAll —— 落层/回滚后的重渲通知 */
    invalidate(): void;
    /** board.setStrokeShadow —— shadow 预览宿的显示注入（surrogate 影子变体；(null,null) 关） */
    setShadow(layerId: number | null, pixels: LayerPixels | null): void;
}
export interface StrokeSessionSpec {
    /** 令牌事务标签（wp2.begin(label)） */
    historyType: string;
    /** 抬笔是否按选区 applyMaskPostStroke（filterBrush 在 begin 已吃 selection → false） */
    finalize: boolean;
}
export declare class StrokeShadow {
    readonly pixels: LayerPixels;
    readonly id: number;
    readonly isGroup: false;
    readonly lockAlpha: boolean;
    readonly docW: number;
    readonly docH: number;
    private _bounds;
    constructor(layer: ViewLeaf);
    private _contentBounds;
    get bboxX(): number;
    get bboxY(): number;
    get bboxW(): number;
    get bboxH(): number;
    editRegionBytes(x0: number, y0: number, w: number, h: number, fn: (buf: Uint8ClampedArray, ox: number, oy: number) => void): void;
    getImageData(docX: number, docY: number, w: number, h: number): ImageData;
    putImageData(docX: number, docY: number, img: ImageData): void;
    sampleAt(docX: number, docY: number): [number, number, number, number];
    snapshot(): ViewLeafSnap;
    restoreFromSnapshot(snap: ViewLeafSnap): void;
    snapshotImageData(): {
        bboxX: number;
        bboxY: number;
        bboxW: number;
        bboxH: number;
        imageData: ImageData | null;
    };
    commitTo(layer: ViewLeaf): void;
    dispose(): void;
}
export declare class StrokeSession {
    readonly engine: StrokeEngine;
    readonly layer: ViewLeaf;
    /** 描边中原地写真层（draw/erase pixelMode）——board live-sync 判据 */
    readonly inPlace: boolean;
    /** 引擎写靶：shadow 模式 = 替身叶（真叶描边期零写），否则真叶。引擎 beginStroke 必须喂它。 */
    readonly target: ViewLeaf;
    private readonly finalize;
    private readonly token;
    private readonly deps;
    private _shadow;
    private _open;
    constructor(deps: StrokeSessionDeps, engine: StrokeEngine, layer: ViewLeaf, spec: StrokeSessionSpec, preview: StrokePreview);
    get open(): boolean;
    /** 投喂一个输入事件（x,y 为 doc 坐标；t = 事件 timeStamp，手感数学的唯一时钟） */
    extend(x: number, y: number, pressure: number, t?: number | null): void;
    /** 引擎累积的 dirty bbox（board.markDocDirty 用）；无 → null */
    flushDirty(): [number, number, number, number] | null;
    /** GPU stamp overlay 拉取（brush/形状笔有；liquify/filterBrush 无 → null，走 shadow/live-sync） */
    collectStamps(): StampCollect | null;
    end(): void;
    cancel(): void;
}
