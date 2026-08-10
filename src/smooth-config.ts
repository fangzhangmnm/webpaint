// 平滑管线的全局可调参数（SSoT）。dev 面板用 textbox/开关 改这里，syncedUserPreference 持久化（跨设备）。
// 详 ai-docs/20260613-brush-procreate-smoothing.md。
//
// 为什么集中在这：调参从「改代码 commit/push」搬到「设备上改值」。dev 面板大范围 textbox →
// 自测每个参数是否真起作用（×100 没变化 = 死参数），杀「饱和假阴性」式煤气灯。
//
// 注：这些是**全局**常数；per-preset 的两参（streamline / stabilization）在 brush settings。
// 持久化（2026-07-14）：从 webpaint.smooth.v4 LS 迁 synced-user-preference collection（key stylus-smooth-params）。
//   SMOOTH 仍是**同步读的可变对象**（手感热路径不变）；boot 门后 hydrateSmoothFromPrefs() 把 collection 值合并进来。

import { syncedUserPreference, PREF_DEFAULTS } from "./app-prefs.ts";
import { SMOOTH_DEFAULTS } from "./common/smooth-defaults.ts";

// 出厂默认 C8 迁 src/common/smooth-defaults.ts（backend 档口的 {tau,deadzone} 推导也吃它）；
// 这里 re-export 保存量消费者路径。
export { SMOOTH_DEFAULTS } from "./common/smooth-defaults.ts";

// 运行时可变副本（dev 面板改它，手感热路径同步读）。eval 期 = DEFAULTS；boot 门后 hydrate 合并 collection。
export const SMOOTH: Record<keyof typeof SMOOTH_DEFAULTS, number> = { ...SMOOTH_DEFAULTS };

// boot 门后调（collection 已 hydrate）：把 synced 保存值合并进 SMOOTH。绘图发生在 boot 后，故手感读到的是 synced 值。
export function hydrateSmoothFromPrefs() {
  const saved = syncedUserPreference.getItem<Record<string, number>>("stylus-smooth-params", PREF_DEFAULTS["stylus-smooth-params"]);
  if (saved && typeof saved === "object") {
    for (const k of Object.keys(SMOOTH_DEFAULTS) as (keyof typeof SMOOTH_DEFAULTS)[]) {
      if (typeof saved[k] === "number") SMOOTH[k] = saved[k];
    }
  }
}

export function saveSmooth() {
  syncedUserPreference.setItem("stylus-smooth-params", { ...SMOOTH });
}
export function resetSmooth() {
  Object.assign(SMOOTH, SMOOTH_DEFAULTS);
  saveSmooth();
}
