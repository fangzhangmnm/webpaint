/** 比例 chips（UI 顺序即此顺序；默认 1:1）。 */
export declare const TIMELAPSE_ASPECTS: ReadonlyArray<readonly [number, number]>;
/** 最长边档位（默认 512）。 */
export declare const TIMELAPSE_LONG_EDGES: ReadonlyArray<number>;
export interface TimelapseSettings {
    aspectW: number;
    aspectH: number;
    longEdge: number;
}
export declare const TIMELAPSE_DEFAULT_SETTINGS: TimelapseSettings;
/** 取景框像素尺寸：最长边给比例的长轴，短边取偶（编码器只要求偶数）。 */
export declare function timelapseFrameDims(s: TimelapseSettings): {
    w: number;
    h: number;
};
/** fit-居中：画布等比放进取景框（允许放大——诚实，小画布就是要占满）。整数像素。 */
export declare function timelapseFitRect(cw: number, ch: number, fw: number, fh: number): {
    dx: number;
    dy: number;
    dw: number;
    dh: number;
};
interface TierConst {
    n0: number;
    motionBps: number;
    tailBps: number;
    refBytes: number;
}
export declare function timelapseTier(longEdge: number): TierConst;
export declare const TIMELAPSE_BASE_DEBOUNCE_MS = 2000;
/** 每 N 帧强制一张 IDR（seek 保底）。 */
export declare const TIMELAPSE_FORCED_KEY_INTERVAL = 300;
/** 回放虚拟节奏：每帧 100ms（10fps）。 */
export declare const TIMELAPSE_FRAME_US = 100000;
/** 尾帧定格 5s（常数不做旋钮，user 2026-08-19）。 */
export declare const TIMELAPSE_TAIL_HOLD_US = 5000000;
/** debounce 窗口 = 2s × (1 + n/N₀)。体积走 log 曲线，无预算无 consolidation。 */
export declare function timelapseDebounceMs(n: number, longEdge: number): number;
/**
 * 采样闸门（leading-edge：窗口开头的 commit 采，其余合并进下一帧；
 * 收尾状态永远由 F 尾帧兜底，不怕漏掉安静期前的最后一笔）。
 * n 计数所有见过的 commit（含被合并的）——衰减的自变量是干活量。
 */
export declare class TimelapseSampler {
    n: number;
    private lastCaptureAt;
    private readonly longEdge;
    constructor(longEdge: number, n?: number);
    /** 每次有可见变化的 commit 调一次；返回「这个 commit 要不要采帧」。 */
    noteCommit(nowMs: number): boolean;
}
/**
 * src = 画布合成图 straight-alpha RGBA。输出 = fw×fh 不透明帧（内容 over 白，白边填充）。
 * 缩放走 areaResampleBytes（面积平均，缩小专业对口；放大=块状，诚实）。
 */
export declare function composeTimelapseFrame(src: Uint8ClampedArray, cw: number, ch: number, fw: number, fh: number): Uint8ClampedArray;
export {};
