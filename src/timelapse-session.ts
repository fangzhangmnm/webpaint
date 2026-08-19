// Timelapse 壳编排（单 tab 单 doc；spec=ai-docs/20260819-timelapse-spec.md）。
// 职责：commit 钩子（wp:histchange）→ 采样 → GL 合成字节 → 白边帧 → M 编码器；
//       保存前 drain + 尾帧（复用保存路径同步刻渲好的 merged，与 mergedimage 严格同源）；
//       文档切换的串扰墙（detach → adopt）；自愈=止损（录像永不绑架画画/保存）。
// UI（面板/红点/预览/导出）在 timelapse-ui.ts，通过 wp:timelapse-changed 事件 + 只读状态对象联动。
import { TimelapseDocState } from "./backend/timelapse/timelapse-state.ts";
import type { TimelapseSettings } from "./backend/timelapse/timelapse-core.ts";
import {
  composeTimelapseFrame, timelapseFrameDims, timelapseTier, TIMELAPSE_FORCED_KEY_INTERVAL, TIMELAPSE_FRAME_US,
} from "./backend/timelapse/timelapse-core.ts";
import {
  TimelapseMotionEncoder, encodeTailFrame, timelapseProbeSupport,
} from "./backend/timelapse/timelapse-encoder.ts";
import type { DecodedPainting } from "./backend/ora.ts";
import { renderNodesToBytes } from "./backend/doc-render.ts";
import { reportError } from "./error-badge.ts";
import { t } from "./i18n/index.ts";

interface DocViewLike { layers: readonly unknown[]; width: number; height: number }

let _doc: DocViewLike | null = null;
let _st = new TimelapseDocState();
let _mEnc: TimelapseMotionEncoder | null = null;
let _needKey = true;          // 冷启动 / 断片重开 / 文档切换 → 下一帧 IDR
let _frameSeq = 0;            // M 编码器时间戳序号（编码器节奏用；成片时间戳在 mux 重生成）
let _supported: boolean | null = null;   // isConfigSupported probe 缓存（per session）
let _captureBusy = false;     // 帧管线忙 → 该 commit 静默并入下一帧（debounce 已在合并，兜底）
let _detached = true;         // 串扰墙：文档切换期间丢弃一切 commit

function _notifyUi(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("wp:timelapse-changed"));
}

/** boot 接线：doc 视图 + commit 钩子。probe 异步跑，结果前录制项灰。 */
export function initTimelapse(doc: DocViewLike): void {
  _doc = doc;
  window.addEventListener("wp:histchange", () => { _onCommit(); });
  void timelapseProbeSupport(512, 512).then((ok) => {
    _supported = ok;
    if (!ok) reportError("[timelapse] VideoEncoder unavailable or avc unsupported; recording disabled on this device", "log");
    _notifyUi();
  });
}

/** 文档切换第一步（adoptModel 开头调）：旧录制态立刻退场——期间的 histchange 全部落空，绝不串扰。 */
export function timelapseDetach(): void {
  _detached = true;
  _mEnc?.close(); _mEnc = null;
  _st = new TimelapseDocState();
  _needKey = true; _frameSeq = 0;
  _notifyUi();
}

/** 文档载入完成（adoptModel 末尾调）：从 ora sidecar 回读录制态；回读问题报 info 一次（自愈=止损）。 */
export function timelapseAdopt(loaded: { _timelapseJson?: string; _timelapseMp4?: Uint8Array } | DecodedPainting): void {
  _st = TimelapseDocState.restore(loaded._timelapseJson ?? null, loaded._timelapseMp4 ?? null);
  if (_st.restoreIssue) reportError(t("tl.restoreLost"), "info");
  _detached = false;
  _needKey = true; _frameSeq = 0;
  _notifyUi();
}

// ---- 采集管线 ----

function _onCommit(): void {
  if (_detached || !_doc || _supported !== true || !_st.active || !_st.settings) return;
  if (!_st.noteCommit(Date.now())) return;   // 调和衰减 debounce（n 照涨）
  void _captureFrame();
}

// 零可见变化的 commit（纯选区等）不做像素比对甄别：重复帧被编码器整帧 skip，成本≈几十字节，
// 甄别反而要整幅 diff。spec §2「跳过」按成本语义达成。
async function _captureFrame(): Promise<void> {
  if (_captureBusy) return;                  // 上一帧还在管线里：并入下一次采样
  _captureBusy = true;
  try {
    const doc = _doc!; const s = _st.settings!;
    const merged = renderNodesToBytes(doc.layers, doc.width, doc.height);
    if (!merged) return;                     // GL lost：静默跳帧，画画优先
    const { w, h } = timelapseFrameDims(s);
    const rgba = composeTimelapseFrame(merged.data, merged.w, merged.h, w, h);
    if (!_mEnc) _mEnc = new TimelapseMotionEncoder(w, h, timelapseTier(s.longEdge).motionBps, TIMELAPSE_FORCED_KEY_INTERVAL);
    const frame = new VideoFrame(rgba.buffer as ArrayBuffer, {
      format: "RGBA", codedWidth: w, codedHeight: h, timestamp: _frameSeq++ * TIMELAPSE_FRAME_US,
    });
    try { _mEnc.encode(frame, _needKey); _needKey = false; } finally { frame.close(); }
    if (_mEnc.dead) _dropEncoder("motion encoder died mid-stream");
  } catch (e) {
    _dropEncoder(String(e));
  } finally {
    _captureBusy = false;
  }
}

/** 编码链路坏死 → 止损：停录（暂停语义，素材保住），报一次 info。resume 会重建编码器再试。 */
function _dropEncoder(why: string): void {
  reportError("[timelapse] capture halted (recording paused, footage kept): " + why, "log");
  _mEnc?.close(); _mEnc = null;
  if (_st.on) { _st.pause(); reportError(t("tl.captureHalted"), "info"); _notifyUi(); }
}

// ---- 保存接缝（session-state._encodeCurrentOraWithPeek 调） ----

/**
 * 保存前拿 ora 的 timelapse 件。merged = 保存路径**同步刻**已渲好的合成字节（尾帧与 mergedimage
 * 同源一致；null = GL lost → 冻结 passthrough）。任何一步失败自愈降级，绝不 throw 出保存路径。
 */
export async function timelapseForSave(merged: { data: Uint8ClampedArray; w: number; h: number } | null,
                                       ): Promise<{ json: string; mp4: Uint8Array } | null> {
  if (_detached || !_st.settings) return null;
  const s = _st.settings;
  const { w, h } = timelapseFrameDims(s);
  try {
    if (_st.on && _mEnc) {
      const drained = await _mEnc.drain();
      for (const smp of drained) _st.pushMotionSample(smp, _mEnc.avcC);
      if (_mEnc.dead) _dropEncoder("motion encoder died at drain");
    }
    let tail = null;
    if (_st.on && _supported === true && merged && _st.avcC) {
      const rgba = composeTimelapseFrame(merged.data, merged.w, merged.h, w, h);
      const frame = new VideoFrame(rgba.buffer as ArrayBuffer, { format: "RGBA", codedWidth: w, codedHeight: h, timestamp: 0 });
      try {
        tail = (await encodeTailFrame(frame, w, h, timelapseTier(s.longEdge).tailBps)).sample;
      } finally { frame.close(); }
    }
    const out = _st.serializeForSave(tail, w, h);
    _notifyUi();   // 体积实况刷新
    return out;
  } catch (e) {
    reportError("[timelapse] serialize failed; keeping last saved footage: " + String(e), "log");
    try { return _st.serializeForSave(null, w, h); } catch { return null; }
  }
}

// ---- UI 消费面 ----

export interface TimelapseStatus {
  supported: boolean | null;      // null = probe 未回
  exists: boolean;                // 开过录（settings pin 了）
  on: boolean;
  settings: TimelapseSettings | null;
  bytes: number;                  // 上次落盘录像大小（裸字节；显示层再 KiB/MiB）
  pendingFrames: number;          // 未落盘的运动帧数（提示「保存后生效」用）
  restoreIssue: string | null;
}

export function timelapseStatus(): TimelapseStatus {
  return {
    supported: _supported,
    exists: _st.settings !== null,
    on: _st.on,
    settings: _st.settings ? { ..._st.settings } : null,
    bytes: _st.byteSize,
    pendingFrames: _st.motion.length,
    restoreIssue: _st.restoreIssue,
  };
}

/** 开录（UI 已收集比例/最长边）。已有录像时 throw（UI 引导先清除）。 */
export function timelapseStart(s: TimelapseSettings): void {
  _st.startRecording(s);
  _needKey = true;
  _notifyUi();
}

export function timelapsePause(): void { _st.pause(); _notifyUi(); }

export function timelapseResume(): void {
  _st.resume();
  _needKey = true;   // 断片重开 → IDR（spec §3：跳变诚实，不记「此处停录过」）
  _notifyUi();
}

/** 清除录像（UI 已做 inline 二次确认；不可 undo，不进 undo 栈）。 */
export function timelapseClear(): void {
  _mEnc?.close(); _mEnc = null;
  _st.clear();
  _needKey = true; _frameSeq = 0;
  _notifyUi();
}

/** 导出/预览用：上次落盘的完整 mp4（含尾帧定格；null=还没落过盘）。 */
export function timelapseMp4(): Uint8Array | null { return _st.lastMp4; }
