// cloud-capability —— 「启用云端功能」开关的**单一接缝**（2026-08-21 user 拍板的接缝雏形）。
//
// 将来审计「哪些地方吃这个开关」= 查本模块的 import 图；v1 消费方：
//   settings-menu（toggle + 图库菜单项显隐）/ save-status（徽章无云态）/
//   topbar-menu（smart save 短路云腿 + 图库入口守卫）/ boot.ts（冷启动不自动恢复 store 画）。
//
// 【自愈红线】开关是**纯 UI/能力 gating，零数据变更**：不删不迁 IDB、不动 MSAL 缓存、
//   不 sign-out、不碰任何 store 结构。关→开必须原样回来（用户存值 + 全部本地/云数据无损）。
//   v1 关闭态 gallery 数据层照常初始化，只是 UI 藏（刻意范围，见 2026-08-21 拍板）。
//
// pref 面：**设备本地**（app-prefs 的 local collection，绝不进 synced——否则别的设备一关，
//   这台也被关，见 app-prefs.ts 注释）。默认 true。!isAuthConfigured()（容器不支持云）→ 恒 false，
//   但**不写盘**：配置恢复后自愈回用户存值。

import { localUserPreference, PREF_DEFAULTS } from "./app-prefs.ts";
import { isAuthConfigured } from "./app-store.ts";

/** 开关变更广播（window 事件；detail 无——消费方自己重读 isCloudEnabled()）。 */
export const CLOUD_CAPABILITY_EVENT = "wp:cloud-capability-changed";

/** 用户存的 pref 原值（不含 isAuthConfigured 门）——设置页 toggle 显示「用户意愿」用。 */
export function cloudPrefEnabled(): boolean {
  return localUserPreference.getItem<boolean>("cloud-enabled", PREF_DEFAULTS["cloud-enabled"]);
}

/** 云端功能有效开关：容器不支持云（未配置 auth）→ 恒 false；否则读设备本地 pref（默认 true）。 */
export function isCloudEnabled(): boolean {
  if (!isAuthConfigured()) return false;
  return cloudPrefEnabled();
}

export function setCloudEnabled(v: boolean): void {
  localUserPreference.setItem("cloud-enabled", !!v);
  try { window.dispatchEvent(new Event(CLOUD_CAPABILITY_EVENT)); } catch { /* node 测试环境无 window */ }
}
