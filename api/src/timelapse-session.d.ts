import type { TimelapseSettings } from "./backend/timelapse/timelapse-core.ts";
import type { DecodedPainting } from "./backend/ora.ts";
interface DocViewLike {
    layers: readonly unknown[];
    width: number;
    height: number;
}
type RenderBytesFn = (nodes: readonly unknown[], w: number, h: number) => {
    data: Uint8ClampedArray;
    w: number;
    h: number;
} | null;
/** boot 接线：doc 视图 + 显示等价合成面（含 fill 预览/调整替身的 WYSIWYG——「录的是画画步骤看到的样子」，
 *  user 2026-08-19；save/export 的干净合成面不受影响）+ commit 钩子。probe 异步跑，结果前录制项灰。 */
export declare function initTimelapse(doc: DocViewLike, renderDisplay: RenderBytesFn): void;
/** 文档切换第一步（adoptModel 开头调）：旧录制态立刻退场——期间的 histchange 全部落空，绝不串扰。 */
export declare function timelapseDetach(): void;
/** 文档载入完成（adoptModel 末尾调）：从 ora sidecar 回读录制态；回读问题报 info 一次（自愈=止损）。 */
export declare function timelapseAdopt(loaded: {
    _timelapseJson?: string;
    _timelapseMp4?: Uint8Array;
} | DecodedPainting): void;
/**
 * 保存前拿 ora 的 timelapse 件。merged = 保存路径**同步刻**已渲好的合成字节（尾帧与 mergedimage
 * 同源一致；null = GL lost → 冻结 passthrough）。任何一步失败自愈降级，绝不 throw 出保存路径。
 */
export declare function timelapseForSave(merged: {
    data: Uint8ClampedArray;
    w: number;
    h: number;
} | null): Promise<{
    json: string;
    mp4: Uint8Array;
} | null>;
export interface TimelapseStatus {
    supported: boolean | null;
    exists: boolean;
    on: boolean;
    settings: TimelapseSettings | null;
    bytes: number;
    pendingFrames: number;
    restoreIssue: string | null;
}
export declare function timelapseStatus(): TimelapseStatus;
/** 开录（UI 已收集比例/最长边）。已有录像时 throw（UI 引导先清除）。 */
export declare function timelapseStart(s: TimelapseSettings): void;
export declare function timelapsePause(): void;
export declare function timelapseResume(): void;
/** 清除录像（UI 已做 inline 二次确认；不可 undo，不进 undo 栈）。 */
export declare function timelapseClear(): void;
/** 导出/预览用：上次落盘的完整 mp4（含尾帧定格；null=还没落过盘）。 */
export declare function timelapseMp4(): Uint8Array | null;
/**
 * 回放/导出的**新鲜快照**：drain 编码器 → 现编尾帧 → 内存里临时 mux（muxTimelapse 是纯函数，
 * 不需要落盘就能出可播字节）。**不写 lastMp4/savedMotionCount/ora——保存节律零改动**
 * （v0.9.17 曾在回放前静默 session.save()，user 否决：save 是 user consent 的事，2026-08-19）。
 * 暂停态 = 冻结语义 → 直接给上次落盘字节；任何失败也回落 lastMp4。
 */
export declare function timelapseSnapshotMp4(): Promise<Uint8Array | null>;
export {};
