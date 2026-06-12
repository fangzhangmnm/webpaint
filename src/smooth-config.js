// 平滑管线的全局可调参数（SSoT）。dev 面板用 textbox/开关 改这里，localStorage 持久化。
// 详 docs/stroke-smoother-time-gate.md。默认值 = 各处原来写死的常数。
//
// 为什么集中在这：调参从「改代码 commit/push」搬到「设备上改值」。dev 面板大范围 textbox →
// 自测每个参数是否真起作用（×100 没变化 = 死参数，如 vref），杀「饱和假阴性」式煤气灯。
//
// 注：这些是**全局**常数；per-preset 的平滑字段（streamline / taperIn / spacing 等）在 brush settings。

const LS_KEY = "webpaint.smooth.v1";

export const SMOOTH_DEFAULTS = Object.freeze({
  lookaheadCap: 90,    // streamline=1 时的窗口上限（screen px）；W_doc = streamline × cap ÷ scale。（v240 试过 240 太大，v241 改回 90）
  smoothBoost:  1,     // 轻压平滑增益：W_i = W×(1+boost×(1−p))。轻按(p→0)窗口×(1+boost) → 治提笔/轻描抖。0=关
  deflate:      false, // 内缩/毛笔甩尖：false→2 阶(保曲率,默认) / true→0 阶(内缩)
  vref:         0.1,   // V_REF（旧四件套速度自适应；已知对主笔刷无效，暴露以自证）
  rawStaticSq:  0.005, // raw 静止门限（screen px²）：动得比这小的 event 跳过
  pressureAlpha: 0.4,  // 压感 smP 一阶 EMA α（input 端）
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
