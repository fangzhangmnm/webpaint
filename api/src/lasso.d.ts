import { Selection } from "./selection.ts";
import { LineartOracle } from "./lineart-oracle.ts";
import type { ColorMetric } from "./color-dist.ts";
import { FloatingTransform } from "./floating-transform.ts";
import type { WarpBakeFn } from "./floating-transform.ts";
import type { Layer, LayerGroup } from "./doc.ts";
import type { Workpiece } from "./workpiece/workpiece.ts";
import type { UndoHistory } from "./workpiece/undo-history.ts";
import type { OperatorRegistry } from "./workpiece/operators.ts";
interface Point {
    x: number;
    y: number;
}
interface DraftRect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}
type SelectionLike = Selection;
interface LassoDoc {
    width: number;
    height: number;
    selection: SelectionLike | null;
}
type LassoNode = Layer | LayerGroup;
type LiftOpts = {
    cut?: boolean;
    fallbackFullLayer?: boolean;
    ignoreSelection?: boolean;
};
type LassoState = "idle" | "drawing-freehand" | "drawing-rect" | "drawing-ellipse" | "magic-tentative" | "magic-drag" | "drawing-polygon" | "floating";
type SubTool = "freehand" | "rect" | "ellipse" | "polygon" | "magic" | "pen";
type SetOpMode = "new" | "union" | "subtract" | "intersect";
export type MagicAlgorithm = "classic" | "lineart" | "similar";
export declare const MAGIC_ALGORITHMS: {
    id: MagicAlgorithm;
    labelKey: string;
}[];
export declare class LassoEngine {
    _state: LassoState;
    _subTool: SubTool;
    _setOpMode: SetOpMode;
    _constrainSquare: boolean;
    _magicThreshold: number;
    _similarThreshold: number;
    _colorMetric: ColorMetric;
    _fillGapPx: number;
    _magicAutoExpandPx: number;
    _magicAlgorithm: MagicAlgorithm;
    _lineartOracle: LineartOracle;
    _points: Point[];
    _rect: DraftRect | null;
    _magicStart: Point | null;
    _polyVerts: Point[];
    _polyPreview: Point | null;
    _ft: FloatingTransform;
    doc: LassoDoc | null;
    onChange: () => void;
    constructor();
    setDoc(doc: LassoDoc | null): void;
    attachWorkpiece(w: Workpiece, history: UndoHistory, ops: OperatorRegistry): void;
    syncFloating(): void;
    setSubTool(name: SubTool): void;
    getSubTool(): SubTool;
    setSetOpMode(mode: SetOpMode): void;
    getSetOpMode(): SetOpMode;
    setMagicThreshold(v: number): void;
    getMagicThreshold(): number;
    setSimilarThreshold(v: number): void;
    getSimilarThreshold(): number;
    setColorMetric(m: ColorMetric): void;
    getColorMetric(): ColorMetric;
    setMagicAutoExpand(px: number): void;
    getMagicAutoExpand(): number;
    setFillGap(px: number): void;
    getFillGap(): number;
    setMagicAlgorithm(v: MagicAlgorithm): void;
    getMagicAlgorithm(): MagicAlgorithm;
    /** 线稿分区缓存是否已就绪（首次 tap 前 UI 可提示「分析线稿中…」） */
    lineartReady(sourceLayer: Layer | null): boolean;
    setLineartCloseDist(px: number): void;
    getLineartCloseDist(): number;
    setLineartInkThreshold(pct: number): void;
    getLineartInkThreshold(): number;
    setLineartMinRegion(px: number): void;
    getLineartMinRegion(): number;
    setLineartTipSensitivity(pct: number): void;
    getLineartTipSensitivity(): number;
    setLineartBleed(px: number): void;
    getLineartBleed(): number;
    _lineartDebugView: boolean;
    setLineartDebugView(on: unknown): void;
    getLineartDebugView(): boolean;
    lineartDebugInfo(sourceLayer: Layer | null): {
        w: number;
        h: number;
        keypoints: import("./lineart/partition.ts").LineartPartition["keypoints"];
        bridges: import("./lineart/partition.ts").LineartPartition["bridges"];
    } | null;
    setSampleMode(m: string): void;
    getSampleMode(): "bicubic" | "rotsprite" | "spline" | "bilinear" | "nearest";
    setConstrainSquare(on: unknown): void;
    getConstrainSquare(): boolean;
    beginPath(x: number, y: number): void;
    extendPath(x: number, y: number): void;
    endPath(sourceLayer: Layer | null): {
        type: string;
        before: Selection | null;
        after: Selection | null;
    } | null;
    _clipSelectionToDoc(sel: SelectionLike | null): SelectionLike | null;
    setSelection(sel: SelectionLike | null): {
        type: string;
        before: Selection | null;
        after: Selection | null;
    } | null;
    hasSelection(): boolean;
    getSelection(): Selection | null;
    cancelDrawing(): void;
    polygonAddVertex(x: number, y: number): void;
    polygonVertexCount(): number;
    polygonHover(x: number, y: number): void;
    polygonFirstVertex(): Point | null;
    polygonSessionActive(): boolean;
    polygonClose(): {
        type: string;
        before: Selection | null;
        after: Selection | null;
    } | null;
    polygonCancelSession(): void;
    liftSelectionForTransform(layer: LassoNode | null, opts?: LiftOpts): boolean;
    _rasterizeFreehandToSelection(pts: Point[]): SelectionLike | null;
    _rasterizeRectToSelection(r: DraftRect | null): SelectionLike | null;
    _rasterizeEllipseToSelection(r: DraftRect | null): SelectionLike | null;
    _magicWandToSelection(start: Point | null, sourceLayer: Layer | null): SelectionLike | null;
    _magicOrig: SelectionLike | null;
    _magicAccum: SelectionLike | null;
    _magicDragLastX: number;
    _magicDragLastY: number;
    beginMagicDrag(): void;
    /** 采样一点；选区真变了返回 true（调用方重绘）。 */
    magicDragStep(x: number, y: number, sourceLayer: Layer | null): boolean;
    /** 收笔：产单条 history entry（before 所有权随 entry 交给 workpiece.sel 记账口，同 _applySelectionUpdate 契约）。 */
    magicDragEnd(): {
        type: string;
        before: Selection | null;
        after: Selection | null;
    } | null;
    /** 中断（双指手势/pointercancel/出错）：还原起笔时选区，无痕。 */
    magicDragCancel(): void;
    _applySelectionUpdate(newSel: SelectionLike): {
        type: string;
        before: Selection | null;
        after: Selection | null;
    } | null;
    setMode(mode: Parameters<FloatingTransform["setMode"]>[0]): void;
    getMode(): ("free" | "uniform" | "distort") | null;
    canSetMode(mode: Parameters<FloatingTransform["setMode"]>[0]): boolean;
    flipFloatHorizontal(): void;
    rotateFloat90(): void;
    resetFloatTransform(): boolean;
    hitTest(x: number, y: number, screenScale?: number): import("./floating-transform.ts").Hit | null;
    beginDrag(hit: Parameters<FloatingTransform["beginDrag"]>[0], x: number, y: number): void;
    extendDrag(x: number, y: number): void;
    endDrag(): void;
    _warpBakeProvider: (() => WarpBakeFn | null) | null;
    setWarpBakeProvider(fn: (() => WarpBakeFn | null) | null): void;
    stamp(): boolean;
    commit(): boolean;
    cancel(): boolean;
    hasFloating(): boolean;
    getDrawingPath(): Point[] | null;
    getDrawingRect(): DraftRect | null;
    getDrawingEllipse(): DraftRect | null;
    getFloating(): import("./floating-transform.ts").FloatView | null;
    state(): LassoState;
    getFloatingScreenBbox(): number[] | null;
    visibleHandles(screenScale?: number): import("./floating-transform.ts").Hit[];
}
export interface FloodStopMask {
    x: number;
    y: number;
    w: number;
    h: number;
    data: Uint8Array;
}
export declare function floodSelectFrom(doc: {
    width: number;
    height: number;
}, start: Point | null, sourceLayer: Layer | null, thresholdPct: number, metric?: ColorMetric, // v0.7.21：默认 rgb = v242 逐字语义（旧测试原样绿）；app 侧灌 editorState 的度量
stopMask?: FloodStopMask | null, gapPx?: number): Selection | null;
export declare function similarSelectFrom(doc: {
    width: number;
    height: number;
}, start: Point | null, sourceLayer: Layer | null, thresholdPct: number, metric?: ColorMetric): Selection | null;
export {};
