// 平滑管线的全局可调参数（SSoT）。dev 面板用 textbox/开关 改这里，localStorage 持久化。
// 详 docs/brush-procreate-smoothing.md。
//
// 为什么集中在这：调参从「改代码 commit/push」搬到「设备上改值」。dev 面板大范围 textbox →
// 自测每个参数是否真起作用（×100 没变化 = 死参数），杀「饱和假阴性」式煤气灯。
//
// 注：这些是**全局**常数；per-preset 的三参（streamline / streamlinePressure / stabilization）在 brush settings。
// 三参滑块∈[0,1] × 下面的 *MaxLagPx/*MaxPx 上限 → 实际 EMA 滞后 / 死区半径。

const LS_KEY = "webpaint.smooth.v2";

export const SMOOTH_DEFAULTS = Object.freeze({
  resampleStepPx:     2,   // 弧长重采样间隔 Δ（screen px）。EMA 跑在重采样点上 → 帧率无关。
  streamlineMaxLagPx: 24,  // streamline=1 时的目标滞后（screen px）；a = L/(L+Δ)，L = streamline × 此值 ÷ scale
  pressureMaxLagPx:   24,  // streamlinePressure=1 时压感 EMA 滞后弧长（screen px）
  stabMaxPx:          8,   // stabilization=1 时死区半径（screen px）；半径内 raw 不拉动落点
  rawStaticSq:        0.005, // raw 静止门限（screen px²）：动得比这小的 event 跳过
  pressureAlpha:      0.4,   // 压感 smP 一阶 EMA α（input 端传感器去尖刺，与 streamlinePressure 正交）
});

// 运行时可变副本（dev 面板改它）。启动从 localStorage 合并覆盖。
export const SMOOTH = { ...SMOOTH_DEFAULTS };
try {
  const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  for (const k of Object.keys(SMOOTH_DEFAULTS)) {
    if (k in saved) SMOOTH[k] = saved[k];
  }
} catch (_) { /* 坏 JSON 忽略，用默认 */ }

export function saveSmooth() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(SMOOTH)); } catch (_) {}
}
export function resetSmooth() {
  Object.assign(SMOOTH, SMOOTH_DEFAULTS);
  saveSmooth();
}
