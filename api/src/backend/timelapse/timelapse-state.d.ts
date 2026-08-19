import type { TimelapseSettings } from "./timelapse-core.ts";
import { TimelapseSampler } from "./timelapse-core.ts";
import type { TimelapseSample } from "./timelapse-mux.ts";
export interface TimelapseJsonV1 {
    v: 1;
    on: boolean;
    aspect: [number, number];
    longEdge: number;
    n: number;
    motionSamples: number;
}
export type TimelapseRestoreIssue = "corrupt-json" | "corrupt-mp4" | "mp4-missing" | "sample-count-mismatch";
/**
 * 一份文档的录制态。生命周期：
 *   无录像 → startRecording(settings) → (pause/resume)* → clear() 回到无录像
 * 保存：serializeForSave()——冻结（off）时原字节 passthrough，活跃时由调用方先喂 tail 再 mux。
 */
export declare class TimelapseDocState {
    /** 录像存在与否 = settings 非 null（开过录才有 pin 的取景框）。 */
    settings: TimelapseSettings | null;
    on: boolean;
    sampler: TimelapseSampler | null;
    motion: TimelapseSample[];
    avcC: Uint8Array | null;
    /** 上次落盘的完整 mp4（冻结 passthrough 用；活跃 re-mux 后刷新）。 */
    lastMp4: Uint8Array | null;
    /** 回读出过什么问题（报 info 级 badge 用；null=健康）。 */
    restoreIssue: TimelapseRestoreIssue | null;
    /** 开录：pin 取景框。已有录像时不准换设置（要换=先 clear，UI 负责引导）。 */
    startRecording(s: TimelapseSettings): void;
    pause(): void;
    /** 重开（跨断片续录；调用方负责让 M 编码器下一帧出 IDR）。 */
    resume(): void;
    /** 清除录像（UI 已做 inline 二次确认；不可 undo）。 */
    clear(): void;
    /** 录制中收到一个有可见变化的 commit：返回要不要采这帧。 */
    noteCommit(nowMs: number): boolean;
    pushMotionSample(s: TimelapseSample, avcC?: Uint8Array | null): void;
    /** 自上次 mux 后有没有新东西（活跃期恒真——尾帧每次保存都要刷新）。 */
    get active(): boolean;
    /**
     * 保存路径拿 ora entry 字节：
     *   冻结（off / 尾帧无法生成）→ 原字节 passthrough（spec §3：暂停=录像整体冻结，不刷尾帧）；
     *   活跃 → 调用方现编 tail 传进来，整体 re-mux。
     * 返回 null = 本文档无录像（不写 entry）。
     */
    serializeForSave(tail: TimelapseSample | null, frameW: number, frameH: number): {
        json: string;
        mp4: Uint8Array;
    } | null;
    toJson(): string;
    /**
     * 从 ora 回读。任何一步失败 → 自愈：返回带 restoreIssue 的空态（录像作废，绝不 throw）。
     * mp4Bytes=null 表示 entry 缺席。
     */
    static restore(json: string | null, mp4Bytes: Uint8Array | null): TimelapseDocState;
    /** 当前录像字节数（UX 显示；数据层裸字节，显示层才 KiB/MiB）。 */
    get byteSize(): number;
}
