import { BrushEngine } from "./brush.ts";
import { LassoEngine } from "./lasso.ts";
import { FilterBrushEngine } from "./filter-brush.ts";
import { ShapeBrushEngine } from "./shape-brush.ts";
import type { GestureViewport, TapRef } from "./pointer-gesture.ts";
import type { PaintingView, ViewLeaf } from "./workpiece/painting-view.ts";
import type { Board } from "./board.ts";
import type { EditMode } from "./edit-mode.ts";
import type { History } from "./workpiece/history.ts";
import type { PaintingWorkpiece } from "./workpiece/painting-workpiece.ts";
import type { LayerTiles } from "./workpiece/layer-tiles.ts";
import type { WriteToken } from "./workpiece/workpiece.ts";
import type { ResolvedBrush } from "./resolved-brush.ts";
import { Selection } from "./selection.ts";
type Doc = PaintingView;
interface FilterBrushState {
    Filter: unknown;
    params: unknown;
}
type StrokeEngine = BrushEngine | FilterBrushEngine | ShapeBrushEngine;
interface ActiveStroke {
    engine: StrokeEngine;
    token: WriteToken;
    layer: ViewLeaf;
    finalize: boolean;
    inPlace: boolean;
}
interface SelectionChangeEntry {
    before?: Selection | null;
    after?: Selection | null;
}
interface PointerRec {
    pointerType: string;
    role: string | null;
    x: number;
    y: number;
    startX?: number;
    startY?: number;
    smX?: number;
    smY?: number;
    downTime?: number;
    lastUpdateTs?: number;
    longPressTimer?: ReturnType<typeof setTimeout> | null;
    lastRawX?: number;
    lastRawY?: number;
    lastP?: number | null;
    smP?: number;
    lastEventTs?: number;
    rawSX?: number;
    rawSY?: number;
    stabX?: number;
    stabY?: number;
    rawToEngine?: boolean;
    _deferGroupWarn?: boolean;
    _deferHiddenWarn?: boolean;
    _lastX?: number;
    _lastY?: number;
    _lassoMode?: string;
    _lassoStartDocX?: number;
    _lassoStartDocY?: number;
}
interface GestureTap {
    startTime: number;
    firstDownTime: number;
    isTap: boolean;
    maxCount: number;
    startPositions: Record<string, {
        x: number;
        y: number;
    }>;
}
interface InputOpts {
    getTool?: () => string;
    editMode?: EditMode | null;
    getResolvedBrush?: () => ResolvedBrush | null;
    getFilterBrushState?: () => FilterBrushState | null;
    getLongPressPickEnabled?: () => boolean;
    getSingleFingerDraw?: () => boolean;
    getPickMode?: () => string;
    onColorSampled?: (hex: string) => void;
    status?: (msg: string) => void;
    history?: History | null;
    wp2?: PaintingWorkpiece | null;
    layerTiles?: LayerTiles | null;
    isContentReplacing?: () => boolean;
}
interface KeyboardShortcut {
    combo: string;
    desc: string;
    category: string;
    when?: (i: InputController) => boolean;
    run: (i: InputController) => void;
}
export declare const KEYBOARD_SHORTCUTS: KeyboardShortcut[];
export declare class InputController {
    board: Board;
    doc: Doc;
    canvas: HTMLCanvasElement;
    brush: BrushEngine;
    lasso: LassoEngine;
    filterBrush: FilterBrushEngine;
    shapeBrush: ShapeBrushEngine;
    getTool: () => string;
    editMode: EditMode | null;
    getResolvedBrush: () => ResolvedBrush | null;
    getFilterBrushState: () => FilterBrushState | null;
    getLongPressPickEnabled: () => boolean;
    getSingleFingerDraw: () => boolean;
    getPickMode: () => string;
    isContentReplacing: () => boolean;
    onColorSampled: (hex: string) => void;
    status: (msg: string) => void;
    pointers: Map<number, PointerRec>;
    penEverSeen: boolean;
    spaceDown: boolean;
    altDown: boolean;
    gestureStart: {
        dist: number;
        midX: number;
        midY: number;
        angle: number;
        vp: GestureViewport;
        lastDist: number;
        lastAngle: number;
        velEma: number;
        lastMoveT: number;
    } | null;
    _gestureTap: GestureTap | null;
    _lastTap: TapRef | null;
    _lastPenActivity: number;
    history: History | null;
    wp2: PaintingWorkpiece | null;
    layerTiles: LayerTiles | null;
    _activeStroke: ActiveStroke | null;
    constructor(board: Board, doc: Doc, opts?: InputOpts);
    _bind(): void;
    _updateCursorPreview(e: PointerEvent): void;
    _down(e: PointerEvent): void;
    _move(e: PointerEvent): void;
    _up(e: PointerEvent, cancelled?: boolean): void;
    _beginStroke(e: PointerEvent, rec: PointerRec, mode: string): void;
    _endStroke(): void;
    _abortStroke(): void;
    isStrokeActive(): boolean;
    collectActiveStamps(): ReturnType<BrushEngine["collectStamps"]>;
    abortActiveStroke(): void;
    liveMutatedLeaf(): ViewLeaf | null;
    _beginFilterBrush(rec: PointerRec): void;
    _beginLasso(rec: PointerRec, e?: PointerEvent): void;
    _endLasso(rec: PointerRec): void;
    _polygonUp(rec: PointerRec): void;
    _polygonClose(): void;
    _commitLasso(): void;
    _selPenPixel: boolean;
    _selPenLive: boolean;
    selPenStrokeActive(): boolean;
    /** 抬笔：stamps → alpha → ≥128 二值 → setOp 合成（一笔一条 selectionChange；蚂蚁线此刻才更新=A 档拍板） */
    _endSelPen(): void;
    _abortSelPen(): void;
    _abortLasso(): void;
    commitLassoIfFloating(): void;
    _doPick(sx: number, sy: number): void;
    _gestureTouches(): PointerRec[];
    _updateGestureTapSnapshot(): void;
    _beginGesture(): void;
    _updateGesture(): void;
    _endGesture(): void;
    _wheel(e: WheelEvent): void;
    _keydown(e: KeyboardEvent): void;
    _keyup(e: KeyboardEvent): void;
    _emitTool(tool: string): void;
    _adjustSize(delta: number): void;
    canUndo(): boolean;
    canRedo(): boolean;
    ctrlZ(): void;
    undo(): void;
    redo(): void;
    clearHistory(): void;
    _pushSelEntry(entry: SelectionChangeEntry | null | undefined): void;
    _purgeStalePointers(): void;
    _purgeAllTouches(): void;
    _discardPointer(pid: number): void;
    _maybeEndGesture(): void;
    cancelAllPointers(): void;
}
export declare function bindPressureDisabled(fn: () => boolean): void;
export {};
