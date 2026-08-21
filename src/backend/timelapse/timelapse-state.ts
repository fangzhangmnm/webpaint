// Timelapse 文档级录制态（纯数据+编排，node 可测）。
// 持久化 = ora 内两个 entry（spec §5，consent 2026-08-19）：
//   timelapse.mp4            全部样本 mux 成的直接可播 mp4（中部大块区，thumbnail 保持最后）
//   .weebpaint/timelapse.json 录制状态（开关 sticky / pin 的取景框 / n / motionSamples）
// 自愈原则（spec §3）：任何回读失败 = 止损——录像作废、画照画、ora 照存，绝不 throw 出保存/加载路径。
import type { TimelapseSettings } from "./timelapse-core.ts";
import { TIMELAPSE_LONG_EDGES, TIMELAPSE_ASPECTS, TimelapseSampler } from "./timelapse-core.ts";
import type { TimelapseSample } from "./timelapse-mux.ts";
import { muxTimelapse, demuxTimelapse } from "./timelapse-mux.ts";

export interface TimelapseJsonV1 {
  v: 1;
  on: boolean;              // sticky：跨 session 续录开关
  aspect: [number, number]; // pin 的比例（开录烤死）
  longEdge: number;         // pin 的最长边
  n: number;                // 累计 commit 计数（衰减 park 中仍持久化，复议时无缝续）
  motionSamples: number;    // mp4 里前多少个样本是运动帧（其余=尾帧，回读时截掉）
}

export type TimelapseRestoreIssue = "corrupt-json" | "corrupt-mp4" | "mp4-missing" | "sample-count-mismatch";

/**
 * 一份文档的录制态。生命周期：
 *   无录像 → startRecording(settings) → (pause/resume)* → clear() 回到无录像
 * 保存：serializeForSave()——冻结（off）时原字节 passthrough，活跃时由调用方先喂 tail 再 mux。
 */
export class TimelapseDocState {
  /** 录像存在与否 = settings 非 null（开过录才有 pin 的取景框）。 */
  settings: TimelapseSettings | null = null;
  on = false;
  sampler: TimelapseSampler | null = null;
  motion: TimelapseSample[] = [];
  avcC: Uint8Array | null = null;
  /** 上次落盘的完整 mp4（冻结 passthrough 用；活跃 re-mux 后刷新）。 */
  lastMp4: Uint8Array | null = null;
  /** 回读出过什么问题（报 info 级 badge 用；null=健康）。 */
  restoreIssue: TimelapseRestoreIssue | null = null;
  /** motion 里已经进过 lastMp4 的前缀长度（「待保存帧数」= motion.length - 这个；冻结保存不动它）。 */
  savedMotionCount = 0;

  /** 开录：pin 取景框。已有录像时不准换设置（要换=先 clear，UI 负责引导）。 */
  startRecording(s: TimelapseSettings): void {
    if (this.settings) throw new Error("timelapse already recording; clear() first");
    if (!TIMELAPSE_LONG_EDGES.includes(s.longEdge)) throw new Error(`bad longEdge ${s.longEdge}`);
    if (!TIMELAPSE_ASPECTS.some(([w, h]) => w === s.aspectW && h === s.aspectH)) throw new Error("bad aspect");
    this.settings = { ...s };
    this.sampler = new TimelapseSampler(0);
    this.on = true;
  }

  pause(): void { this.on = false; }
  /** 重开（跨断片续录；调用方负责让 M 编码器下一帧出 IDR）。 */
  resume(): void { if (this.settings) this.on = true; }

  /** 清除录像（UI 已做 inline 二次确认；不可 undo）。 */
  clear(): void {
    this.settings = null; this.on = false; this.sampler = null;
    this.motion = []; this.avcC = null; this.lastMp4 = null; this.restoreIssue = null;
    this.savedMotionCount = 0;
  }

  /** 录制中收到一个有可见变化的 commit：返回要不要采这帧。 */
  noteCommit(nowMs: number): boolean {
    if (!this.on || !this.sampler) return false;
    return this.sampler.noteCommit(nowMs);
  }

  pushMotionSample(s: TimelapseSample, avcC?: Uint8Array | null): void {
    if (avcC && !this.avcC) this.avcC = avcC;
    this.motion.push(s);
  }

  /** 自上次 mux 后有没有新东西（活跃期恒真——尾帧每次保存都要刷新）。 */
  get active(): boolean { return this.on && this.settings !== null; }

  /**
   * 保存路径拿 ora entry 字节：
   *   冻结（off / 尾帧无法生成）→ 原字节 passthrough（spec §3：暂停=录像整体冻结，不刷尾帧）；
   *   活跃 → 调用方现编 tail 传进来，整体 re-mux。
   * 返回 null = 本文档无录像（不写 entry）。
   */
  serializeForSave(tail: TimelapseSample | null, frameW: number, frameH: number):
      { json: string; mp4: Uint8Array } | null {
    if (!this.settings) return null;
    let mp4 = this.lastMp4;
    if (this.on && tail && this.avcC) {
      mp4 = muxTimelapse(this.motion, tail, this.avcC, frameW, frameH);
      this.lastMp4 = mp4;
      this.savedMotionCount = this.motion.length;
    }
    if (!mp4) {
      // 开了录但一帧都没编出来（如编码器还没吐出首帧就保存）：只落 json 记住开关与设置。
      return { json: this.toJson(), mp4: new Uint8Array(0) };
    }
    return { json: this.toJson(), mp4 };
  }

  toJson(): string {
    const s = this.settings!;
    const j: TimelapseJsonV1 = {
      v: 1, on: this.on, aspect: [s.aspectW, s.aspectH], longEdge: s.longEdge,
      n: this.sampler?.n ?? 0, motionSamples: this.motion.length,
    };
    return JSON.stringify(j);
  }

  /**
   * 从 ora 回读。任何一步失败 → 自愈：返回带 restoreIssue 的空态（录像作废，绝不 throw）。
   * mp4Bytes=null 表示 entry 缺席。
   */
  static restore(json: string | null, mp4Bytes: Uint8Array | null): TimelapseDocState {
    const st = new TimelapseDocState();
    if (json == null) return st;   // 从没开过录：健康空态
    let j: TimelapseJsonV1;
    try {
      j = JSON.parse(json) as TimelapseJsonV1;
      if (j.v !== 1 || !Array.isArray(j.aspect) || typeof j.longEdge !== "number"
          || typeof j.n !== "number" || typeof j.motionSamples !== "number") throw new Error("shape");
    } catch {
      st.restoreIssue = "corrupt-json";
      return st;
    }
    st.settings = { aspectW: j.aspect[0], aspectH: j.aspect[1], longEdge: j.longEdge };
    st.sampler = new TimelapseSampler(j.n);
    st.on = !!j.on;
    if (mp4Bytes == null || mp4Bytes.length === 0) {
      if (j.motionSamples > 0) {   // json 说有货但 mp4 没了：录像丢失，止损清空
        const issue: TimelapseRestoreIssue = "mp4-missing";
        const fresh = new TimelapseDocState();
        fresh.restoreIssue = issue;
        return fresh;
      }
      return st;   // 开了录还没落过帧：合法空录像
    }
    try {
      const d = demuxTimelapse(mp4Bytes);
      if (j.motionSamples > d.samples.length) throw new Error("sample-count");
      st.motion = d.samples.slice(0, j.motionSamples);   // 截掉尾帧（每次保存重新现编）
      st.avcC = d.avcC;
      st.lastMp4 = mp4Bytes;
      st.savedMotionCount = st.motion.length;   // 回读来的都已在盘上
    } catch (e) {
      const fresh = new TimelapseDocState();
      fresh.restoreIssue = e instanceof Error && e.message === "sample-count" ? "sample-count-mismatch" : "corrupt-mp4";
      return fresh;
    }
    return st;
  }

  /** 当前录像字节数（UX 显示；数据层裸字节，显示层才 KiB/MiB）。 */
  get byteSize(): number { return this.lastMp4?.length ?? 0; }
}
