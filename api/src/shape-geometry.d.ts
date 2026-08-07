export interface Pt {
    x: number;
    y: number;
}
export interface EllipseFit {
    cx: number;
    cy: number;
    rx: number;
    ry: number;
    rot: number;
    startAng: number;
    sweep: number;
    closed: boolean;
}
export declare function rotatePt(p: Pt, ang: number): Pt;
export declare function snapLineEnd(x0: number, y0: number, x: number, y: number, stepRad?: number): Pt;
export declare function rectCorners(p0: Pt, p1: Pt, rot: number, constrain: boolean): [Pt, Pt, Pt, Pt];
export declare function fitEllipse(pts: Pt[], rot: number, constrain: boolean): EllipseFit | null;
export declare function clampPixelCenter(v: number): number;
export declare function bresenhamLine(i0: number, j0: number, i1: number, j1: number): Pt[];
export declare function bresenhamRectPerimeter(i0: number, j0: number, i1: number, j1: number): Pt[];
export declare function bresenhamEllipseRect(i0: number, j0: number, i1: number, j1: number): Pt[];
export declare function maxSegLenFor(size: number, spacing: number): number;
export interface ClipBox {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}
export declare function clipSegToBox(a: Pt, b: Pt, box: ClipBox): [Pt, Pt] | null;
export declare function clipPolylineToBox(pts: Pt[], box: ClipBox): Pt[][];
export declare function linePolyline(p0: Pt, p1: Pt, maxSegLen: number): Pt[];
export declare function rectPolyline(corners: [Pt, Pt, Pt, Pt], maxSegLen: number): Pt[];
export declare function perimeterRamanujan(rx: number, ry: number): number;
export declare function ellipseArcPolyline(fit: EllipseFit, maxSegLen: number): Pt[];
