import type { Pt } from "./shape-geometry.ts";
export interface Vp {
    x: number;
    y: number;
}
export type PlaneId = "off" | "ground" | "wall" | "wallL" | "wallR";
export interface PerspConfig {
    vp1: Vp | null;
    vp2: Vp | null;
    vp3: Vp | null;
    lockHorizon: boolean;
    plane: PlaneId;
    axes?: [Family, Family, Family] | null;
}
export type Family = {
    kind: "pencil";
    vp: Vp;
} | {
    kind: "parallel";
    dir: Pt;
};
export declare const ISO_AXES: [Family, Family, Family];
export declare const HORIZON_EPS = 2;
export declare const HORIZON_LEVER = 5;
export declare function horizonEpsFor(w0: number): number;
export declare const HORIZON_PIN = 0.5;
export declare function planeFamilies(cfg: PerspConfig): [Family, Family] | null;
type H3 = [number, number, number];
export declare function familyLineThrough(p: Pt, fam: Family): H3;
export declare function intersectLines(l1: H3, l2: H3): Pt | null;
export declare function quadFromCorners(c0: Pt, c1: Pt, famA: Family, famB: Family): [Pt, Pt, Pt, Pt] | null;
export type Mat3 = [number, number, number, number, number, number, number, number, number];
export declare function homographyUnitSquare(q: [Pt, Pt, Pt, Pt]): Mat3 | null;
export declare function applyMat3(m: Mat3, u: number, v: number): Pt;
export declare function invertMat3(m: Mat3): Mat3 | null;
export interface PlaneChart {
    toPlane(p: Pt): Pt;
    toDoc(u: number, v: number): Pt | null;
}
export declare function planeChart(famA: Family, famB: Family, anchor: Pt): PlaneChart | null;
export declare function snapDirections(cfg: PerspConfig, from: Pt): Pt[];
export declare function snapToDirections(x0: number, y0: number, x: number, y: number, dirs: Pt[]): Pt;
export type PerspMode = "off" | "p1" | "p2" | "p3" | "iso";
export declare function planesForMode(mode: PerspMode): PlaneId[];
export interface PerspModeState {
    mode: string;
    lockHorizon: boolean;
    plane: string;
    p1: {
        vp1: Vp | null;
    };
    p2: {
        vp1: Vp | null;
        vp2: Vp | null;
    };
    p3: {
        vp1: Vp | null;
        vp2: Vp | null;
        vp3: Vp | null;
    };
}
export declare function configFromModeState(g: PerspModeState): PerspConfig | null;
export declare function defaultVpsForMode(mode: PerspMode, docW: number, docH: number): {
    vp1: Vp | null;
    vp2: Vp | null;
    vp3: Vp | null;
};
export declare function normalizeConfig(cfg: PerspConfig): PerspConfig;
export interface BoxParams {
    A: Vp;
    t: [number, number, number];
}
export declare function boxAxesForMode(mode: PerspMode, vp1: Vp | null, vp2: Vp | null, vp3: Vp | null): [Family, Family, Family] | null;
export declare function boxCorners(axes: [Family, Family, Family], box: BoxParams): Pt[] | null;
export declare const BOX_EDGES: Array<[number, number]>;
export interface BoxDragState {
    mode: PerspMode;
    lockHorizon: boolean;
    vp1: Vp;
    vp2: Vp | null;
    vp3: Vp | null;
    box: BoxParams;
}
export declare function solveBoxDrag(st: BoxDragState, cornerIdx: number, target: Pt): BoxDragState;
type V3 = [number, number, number];
export interface PlaneMetric {
    project(P: V3): Pt | null;
    unproject(q: Pt): V3 | null;
    U: V3;
    V: V3;
    A3: V3;
}
export declare function planeMetric(cfg: PerspConfig, famA: Family, famB: Family, anchor: Pt, docW: number, docH: number): PlaneMetric | null;
export declare function constrainSquareOnPlane(m: PlaneMetric, c1: Pt): Pt | null;
export declare function metricCirclePolyline(m: PlaneMetric, drag: Pt, n: number): Pt[];
export {};
