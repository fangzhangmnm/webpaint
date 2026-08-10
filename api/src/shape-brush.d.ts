import { BrushEngine } from "./backend/brush.ts";
import type { ClipBox } from "./shape-geometry.ts";
import type { Family, PerspConfig, Mat3 } from "./perspective-frame.ts";
import type { ViewLeafSnap as LayerSnap } from "./backend/workpiece/painting-view.ts";
import type { ViewLeaf } from "./backend/workpiece/painting-view.ts";
import type { ResolvedBrush } from "./resolved-brush.ts";
import type { Pt } from "./shape-geometry.ts";
export type ShapeSubTool = "line" | "rect" | "circle" | "grid";
export interface GridConfig {
    nu: number;
    nv: number;
    border: boolean;
}
type Rect4 = [number, number, number, number];
type StampCollect = NonNullable<ReturnType<BrushEngine["collectStamps"]>>;
type Frame = {
    kind: "viewport";
    rot: number;
} | {
    kind: "persp";
    cfg: PerspConfig;
    famA: Family;
    famB: Family;
};
interface ShapeStroke {
    layer: ViewLeaf;
    settings: ResolvedBrush;
    mode: string;
    frame: Frame;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    pts: Pt[];
    preSnap: LayerSnap | null;
    lastPaint: Rect4 | null;
    dirty: Rect4 | null;
    cs: StampCollect | null;
}
export declare class ShapeBrushEngine {
    _inner: BrushEngine;
    _subTool: ShapeSubTool;
    _constrain: Record<"line" | "rect" | "circle", boolean>;
    _constrainInvert: boolean;
    _grid: GridConfig;
    _rotProvider: (() => number) | null;
    _perspProvider: (() => PerspConfig | null) | null;
    _st: ShapeStroke | null;
    setSubTool(s: ShapeSubTool): void;
    getSubTool(): ShapeSubTool;
    setConstrain(b: boolean): void;
    getConstrain(): boolean;
    setConstrainFor(sub: "line" | "rect" | "circle", b: boolean): void;
    setConstrainInvert(b: boolean): void;
    _effConstrain(): boolean;
    setGridConfig(g: Partial<GridConfig>): void;
    getGridConfig(): GridConfig;
    setViewportRotProvider(fn: (() => number) | null): void;
    setPerspProvider(fn: (() => PerspConfig | null) | null): void;
    _resolveFrame(pixel: boolean): Frame;
    beginStroke(layer: ViewLeaf, settings: ResolvedBrush, x: number, y: number, _pressure: number, mode?: string, _smooth?: object, _t?: number | null): void;
    extendStroke(x: number, y: number, _pressure: number, _t?: number | null): void;
    endStroke(): StampCollect | null;
    cancelStroke(): void;
    collectStamps(): StampCollect | null;
    flushDirty(): Rect4 | null;
    _quad(st: ShapeStroke, constrain: boolean): [Pt, Pt, Pt, Pt] | null;
    _clipBox(st: ShapeStroke): ClipBox;
    _polylines(st: ShapeStroke): Pt[][];
    _gridSegments(H: Mat3): Array<[Pt, Pt]>;
    _resynth(): void;
    _resynthPixel(st: ShapeStroke): void;
    _pixelPixels(st: ShapeStroke): Pt[];
    _gridPixels(q: [Pt, Pt, Pt, Pt], box?: ClipBox): Pt[];
    _mergeDirty(st: ShapeStroke, r: Rect4): void;
}
export {};
