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
/**
 * 采样闸门（leading-edge：窗口开头的 commit 采，其余合并进下一帧；
 * 收尾状态永远由 F 尾帧兜底，不怕漏掉安静期前的最后一笔）。
 * n 计数所有见过的 commit（含被合并的）——纯统计，随 sidecar 持久化（timelapse.json）。
 */
export declare class TimelapseSampler {
    n: number;
    private lastCaptureAt;
    constructor(n?: number);
    /** 每次有可见变化的 commit 调一次；返回「这个 commit 要不要采帧」。 */
    noteCommit(nowMs: number): boolean;
}
/**
 * src = 画布合成图 straight-alpha RGBA。输出 = fw×fh 不透明帧（内容 over 白，白边填充）。
 * 缩放两向分治（对齐主画布 GL 成文规则「缩小 LINEAR 抗锯齿、放大 NEAREST 看像素」，
 * gl-compositor.ts 同源）：缩小走 areaResampleBytes（面积平均，专业对口）；放大走
 * nearestResampleBytes——像素画 upscale 录 timelapse 整数倍完美还原、非整数倍诚实块状
 * （area 放大是近似盒复制，跨块有混色缝，非整数倍尤其脏——resample-bytes.ts 头注自己都说别用）。
 * 注：nearest 之后残余的糊来自 H.264 4:2:0 色度下采样（timelapse-encoder.ts 编码器约束），
 * 不是插值问题，这里救不了。
 */
export declare function composeTimelapseFrame(src: Uint8ClampedArray, cw: number, ch: number, fw: number, fh: number): Uint8ClampedArray;
export {};
