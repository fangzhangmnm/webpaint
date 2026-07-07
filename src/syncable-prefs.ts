// 职责（单一）：「将来要跟人跨设备同步」的候选偏好集中处（语言 / 主题 …）。
//
// 现状 = 设备本地（localStorage 单 blob `webpaint.synced`）。**唯一 seam**：等新 store 的
//   settings-sync 接回来时，只把这里的 read/write 后端换成 store，调用方（i18n / theme）不动。
//   —— 用户 2026-07-07：「语言先和 theme 放一个地方，等新 store 模块接回来」。
//
// 只放**内容型**偏好（换设备该跟着人的：语言、主题）。**设备型**偏好（面板位置 / FPS 叠层 /
//   尺寸 / 压感手感 …）不放这里——它们该 per-device，留各自的 localStorage 键。
//
// 迁移：旧散键（webpaint.lang / webpaint.theme）由调用方读时兜底，下次 set 落进本 blob。

import { safeLS, safeLSSet } from "./safe-ls.ts";

export interface SyncablePrefs {
  lang?: string;
  theme?: string;
}

const KEY = "webpaint.synced";

function read(): SyncablePrefs {
  try { return JSON.parse(safeLS(KEY) || "{}") as SyncablePrefs; } catch { return {}; }
}

export function getPref<K extends keyof SyncablePrefs>(k: K): SyncablePrefs[K] {
  return read()[k];
}

export function setPref<K extends keyof SyncablePrefs>(k: K, v: NonNullable<SyncablePrefs[K]>): void {
  const p = read();
  p[k] = v;
  safeLSSet(KEY, JSON.stringify(p));
}
