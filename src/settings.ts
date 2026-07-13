// 职责（单一）：settings 的**唯一入口**。所有设置读写走 getSetting/setSetting；路由 local↔synced 由
//   settings-core 的注册表决定（见那里）。app 各处不再散碰 localStorage 设置键。
//
// ⚠ 刻意**不 import app-store**：theme/lang 走 settings，而 t()/theme 被极多 leaf 模块与 node 测用——
//   若 settings 拖进 app-store，就把整个 store/crypto(7z-wasm/msal) 栈塞进每个用 t() 的模块（耦合 + node 测崩）。
//   故 local 镜像直接用 localStorage（本就是设备本地，语义 == store.localSettings）；synced 后端由 app-store
//   建好 store 后**惰性注入** store.syncedSettings（wireSyncedSettings）。注入前 synced 项只走本地镜像（boot 安全）。
//
// 分层：纯逻辑 + 注册表在 settings-core.ts（可 node 测）；本文件只做后端装配 + initSettings（拉云 + 通知 theme 重贴）。

import { safeLS, safeLSSet, safeLSRemove } from "./safe-ls.ts";
import { createSettings, type SettingKey, type Settings, type KvLike, type SyncedLike } from "./settings-core.ts";

// 本地镜像后端：localStorage KV，键前缀 webpaint.set.（与旧散键 webpaint.* 不撞 → 迁移安全）。
const LOCAL_PREFIX = "webpaint.set.";
const localKv: KvLike = {
  get<V = unknown>(key: string): V | undefined {
    const v = safeLS(LOCAL_PREFIX + key);
    if (v == null) return undefined;
    try { return JSON.parse(v) as V; } catch { return undefined; }
  },
  set(key, value) { safeLSSet(LOCAL_PREFIX + key, JSON.stringify(value)); },
  delete(key) { safeLSRemove(LOCAL_PREFIX + key); },
};

// synced 后端惰性接入：app-store 建好 store 后注入 store.syncedSettings；注入前 synced 项只走本地镜像。
let _synced: SyncedLike | undefined;
const syncedProxy: SyncedLike = {
  get: (k) => _synced?.get(k),
  set: (k, v) => { _synced?.set(k, v); },
  delete: (k) => { _synced?.delete(k); },
  init: () => _synced?.init() ?? Promise.resolve(),
  flush: () => _synced?.flush() ?? Promise.resolve(),
};
// app-store 唯一调：把 store.syncedSettings（或 undefined=未配 syncedSettingsFileName）接进来。
export function wireSyncedSettings(s: SyncedLike | undefined): void { _synced = s; }

const _settings: Settings = createSettings({ local: localKv, synced: syncedProxy, ls: { get: safeLS } });

export function getSetting<V = unknown>(key: SettingKey): V { return _settings.get<V>(key); }
export function setSetting(key: SettingKey, value: unknown): void { _settings.set(key, value); }
export function deleteSetting(key: SettingKey): void { _settings.delete(key); }
export function flushSettings(): Promise<void> { return _settings.flushSynced(); }

// synced key 变更监听（init 拉云后云端值更新了本地镜像 → 通知重贴，如 theme）。
const _listeners = new Map<SettingKey, Array<() => void>>();
export function onSyncedSettingChange(key: SettingKey, cb: () => void): void {
  const arr = _listeners.get(key) || [];
  arr.push(cb);
  _listeners.set(key, arr);
}

// boot 调（store 就绪、wireSyncedSettings 之后）：拉 syncedSettings → 折回本地镜像 → 对有变的 synced key 触发监听。
//   fire-and-forget，不阻塞首帧；离线/失败优雅（syncedSettings.init 内部不 wipe）。
export async function initSettings(): Promise<void> {
  let changed: SettingKey[] = [];
  try { changed = await _settings.initSynced(); }
  catch (e) { console.warn("[settings] initSynced failed:", e); return; }
  for (const key of changed) for (const cb of _listeners.get(key) || []) { try { cb(); } catch { /* 单个监听崩不连累 */ } }
}
