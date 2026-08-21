// storage-persist.ts —— 向浏览器申请「持久化存储」（best-effort → persistent）。
//
// 为什么必须有（2026-08-21 存储驱逐调查，详 ai-docs/20260821-storage-eviction-investigation.md）：
//   不申请，IndexedDB 全程是 **best-effort** —— 浏览器在存储压力下按 LRU **整源驱逐**，
//   绕过 app 的一切逻辑（store §A 的「dirty 永不被驱逐」守的是 store 自己的 offload 决策，
//   防不住浏览器发起的驱逐；见该文档 escalation E3）。
//   · MDN：驱逐「skips over origins that have been granted data persistence」——**所有浏览器**都跳过已持久化的源。
//   · WebKit 官方：授予与否按启发式，「whether the website is opened as a Home Screen Web App」是点名因子之一
//     → 引导用户装到主屏是**数据安全措施**，不只是 UX 建议。
//   实测（2026-08-21，weebpaint.com，Edge 151 桌面）：persist() = true，2ms，无弹窗。
//
// 纪律：
//   · **每次 app 打开都问一次**：有开发者报告 Safari 的授予不跨 app 打开保留（Apple 无官方文档，取保守做法）。
//   · 已经是 persistent 就**不再申请** —— Firefox 的 persist() 会弹权限框，别每次开都骚扰用户。
//   · 失败**绝不静默当成功**：状态可读（getStoragePersistence()），供数据安全文案/警告消费。
//   · 本模块**不弹任何 UI**、不写任何盘：申请时机与告知文案是产品决策，留给调用方。
//   · ⚠ persist() 授予后是否豁免 Safari 的 ITP「7 天无互动清除」——Apple 无文档、开发者报告互相矛盾，
//     **别假定它豁免**。产品文案按「不豁免」写。

import { reportError } from "./error-badge.ts";

/** persistent = 浏览器承诺不主动驱逐；best-effort = 可能被整源清掉；unsupported/error = 不可知，按最坏假设。 */
export type PersistenceState = "unknown" | "unsupported" | "persistent" | "best-effort" | "error";

let _state: PersistenceState = "unknown";

/** 当前已知的存储持久性。boot 的 ensureStoragePersistence() 跑完前是 "unknown"。 */
export function getStoragePersistence(): PersistenceState {
  return _state;
}

/** 本地作品是否可能被浏览器整源驱逐（"unknown" 也算 true —— 未知按最坏假设，不许乐观）。 */
export function localStorageIsEvictable(): boolean {
  return _state !== "persistent";
}

/** boot 时调一次。幂等（已 persistent 直接返回，不重复申请）。fire-and-forget 安全：自己吞异常。 */
export async function ensureStoragePersistence(): Promise<PersistenceState> {
  const sm = navigator.storage;
  if (!sm || typeof sm.persist !== "function" || typeof sm.persisted !== "function") {
    _state = "unsupported";
    reportError(new Error("[storage] StorageManager unavailable; IndexedDB stays best-effort (browser may evict all local works)"), "log");
    return _state;
  }
  try {
    if (await sm.persisted()) { _state = "persistent"; return _state; }
    const granted = await sm.persist();
    _state = granted ? "persistent" : "best-effort";
    if (!granted) {
      reportError(new Error("[storage] persist() denied; IndexedDB stays best-effort — the browser may evict every local work under storage pressure"), "log");
    }
    return _state;
  } catch (e) {
    _state = "error";
    reportError(new Error("[storage] persist() threw: " + String(e)), "log");
    return _state;
  }
}
