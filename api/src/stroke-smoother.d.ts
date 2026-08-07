interface StrokeSmootherOpts {
    tau?: number;
    deadzone?: number;
    tailBow?: number;
}
export declare class StrokeSmoother {
    tau: number;
    r: number;
    bow: number;
    cx: number[];
    cy: number[];
    cp: number[];
    _committed: number;
    _tailLen: number;
    seq: number;
    _ox: number;
    _oy: number;
    _vx: number;
    _vy: number;
    _sx: number;
    _sy: number;
    _lastT: number | null;
    _lastP: number;
    _started: boolean;
    constructor(opts?: StrokeSmootherOpts);
    get count(): number;
    push(x: number, y: number, p: number, t: number | null | undefined): void;
    _buildTail(tp: number): number;
    finish(): void;
    frozenIndex(): number;
    update(): void;
}
export {};
