import type { ViewLeaf, ViewGroup, PaintingView } from "./backend/workpiece/painting-view.ts";
import type { FloatFrame, TransformClass, FloatLayerComponent } from "./backend/workpiece/float-component.ts";
import type { SelectionComponent } from "./backend/workpiece/selection-component.ts";
import type { RigidMap } from "./backend/workpiece/float-ops.ts";
import type { History } from "./backend/workpiece/history.ts";
import type { SplinePlane } from "./backend/algorithms/bspline.ts";
import type { U8Plane } from "./backend/algorithms/rotsprite.ts";
type Node = ViewLeaf | ViewGroup;
interface Point {
    x: number;
    y: number;
}
type Mesh = Point[][];
interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}
type SampleMode = "nearest" | "bilinear" | "bicubic" | "spline" | "rotsprite";
export type WarpBakeFn = (src: SplinePlane | U8Plane, srcW: number, srcH: number, hinv: number[], mode: number, bx: number, by: number, bw: number, bh: number) => {
    data: Uint8ClampedArray;
    w: number;
    h: number;
    dstX: number;
    dstY: number;
} | null;
type TransformModeKind = "free" | "uniform" | "distort";
export interface FloatViewSource {
    layerId: number;
    bytes: U8Plane;
    rect: Rect;
    spline?: SplinePlane;
    rotsprite?: U8Plane;
}
export interface FloatView {
    sources: FloatViewSource[];
    gizmoFrame: FloatFrame;
    mesh: Mesh;
    meshN: number;
    mode: TransformModeKind | null;
}
export interface Hit {
    kind: "translate" | "corner" | "edge" | "rotate" | "basisRotate";
    row?: number;
    col?: number;
    edge?: string;
    pos?: Point;
    anchor?: Point;
}
interface Drag extends Hit {
    startX: number;
    startY: number;
    meshSnap: Mesh;
    frameSnap: FloatFrame;
    snapInt?: boolean;
}
interface LiftOpts {
    fallbackFullLayer?: boolean;
    cut?: boolean;
    ignoreSelection?: boolean;
}
interface LiveMeta {
    gizmoFrame: FloatFrame;
    mesh: Mesh;
    meshN: number;
    mode: TransformModeKind | null;
    uniformAspect: number;
    usedClass?: TransformClass;
}
export declare class FloatingTransform {
    _live: LiveMeta | null;
    _drag: Drag | null;
    _sampleMode: SampleMode;
    onChange: () => void;
    private _doc;
    private _history;
    private _float;
    private _sel;
    constructor(onChange?: () => void);
    attach(doc: PaintingView, history: History, float: FloatLayerComponent, sel: SelectionComponent): void;
    setSampleMode(m: string): void;
    getSampleMode(): SampleMode;
    isActive(): boolean;
    current(): FloatView | null;
    syncFromWorkpiece(): void;
    lift(node: Node | null, opts?: LiftOpts): boolean;
    private _installBaked;
    liftFromBytes(leaf: ViewLeaf | null, bytes: Uint8ClampedArray, rect: Rect): boolean;
    setMode(mode: TransformModeKind | null): void;
    canSetMode(mode: TransformModeKind | null): boolean;
    getMode(): TransformModeKind | null;
    hitTest(x: number, y: number, screenScale?: number): Hit | null;
    beginDrag(hit: Hit | null, x: number, y: number): void;
    extendDrag(x: number, y: number): void;
    _contentRects(): Rect[];
    private _isIntegerRigidState;
    endDrag(): void;
    private _escalateClass;
    private _transformLivePoints;
    flipHorizontal(): void;
    rotate90CCW(): void;
    resetToCenterOriginal(): boolean;
    private _pushTransformCheckpoint;
    private _bakeDown;
    private _leafFor;
    stamp(bakeFn?: WarpBakeFn | null): boolean;
    commit(bakeFn?: WarpBakeFn | null): boolean;
    cancel(): boolean;
    getFloatingScreenBbox(): number[] | null;
    visibleHandles(screenScale?: number): Hit[];
    _visibleHandles(screenScale?: number): Hit[];
    _pointInQuad(x: number, y: number): boolean;
}
export declare function isAffineQuad(mesh: Mesh): boolean;
export declare function sourceDestQuad(rect: Rect, frame: FloatFrame, mesh: Mesh): Mesh | null;
export declare function integerRigidOf(rect: Rect, dq: Mesh): RigidMap | null;
export declare function integerTranslationOf(rect: Rect, dq: Mesh): {
    x: number;
    y: number;
} | null;
export declare function quadWarp(mesh: Mesh): {
    hinv: number[];
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null;
export declare function sourceWarpMatrix(source: {
    rect: Rect;
}, gizmoFrame: FloatFrame, mesh: Mesh): {
    hinv: number[];
    bx: number;
    by: number;
    bw: number;
    bh: number;
} | null;
export {};
