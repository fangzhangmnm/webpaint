// 平滑管线的全局可调参数（SSoT）。dev 面板用 textbox/开关 改这里，localStorage 持久化。
// 详 docs/brush-procreate-smoothing.md。
//
// 为什么集中在这：调参从「改代码 commit/push」搬到「设备上改值」。dev 面板大范围 textbox →
// 自测每个参数是否真起作用（×100 没变化 = 死参数），杀「饱和假阴性」式煤气灯。
//
// 注：这些是**全局**常数；per-preset 的两参（streamline / stabilization）在 brush settings。

const LS_KEY = "webpaint.smooth.v4";

export const SMOOTH_DEFAULTS = Object.freeze({
  tauMaxMs:           160, // streamline=1 时的时间常数 tau（ms）。out += (pen−out)·(1−exp(−dt/tau))。
                           //   滞后恒 = tau 时长（与笔速/采样率/几何无关）；空间滞后=速度×tau，转角自然减速→顿涌现。
                           //   0.5→80ms（tremor 截止 ~2Hz，去抖好）；嫌拖就调小、嫌抖就调大此值。
  tailBow:            1,   // 动量弧 tail 的动量增益：1=自然(= 完美那版的弧)、>1 更鼓、0=直连光标。直行段恒直线。
  stabMaxPx:          8,   // stabilization=1 时死区半径（screen px）；半径内 raw 不拉动落点（与 tau 正交的硬阈值）
  rawStaticSq:        0.005, // raw 静止门限（screen px²）：动得比这小的 event 跳过
  pressureAlpha:      0.4,   // 压感 smP 一阶 EMA α（input 端传感器去尖刺）
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
