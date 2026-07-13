// ⚠ 使用前必读 README.md。app 不直接 import 本文件——经 createStore 的 store.localSettings /
//   store.syncedSettings 拿。
//
// 两种设置（README.md §4），**同处 `${ns}.settings.<key>` 散键裸值**命名空间（不分 synced/local、无 blob）：
//   localSettings  —— 设备本地 KV（不同步；theme/zoom/spread 等设备独立项）。裸值直读写。
//   syncedSettings —— 跨设备 KV。**读/写面 = localStorage 裸值（内存无副本、首屏零 await）**；
//                     一个后台 collection（`settings` 保留名）当 LWW 传输引擎：
//                       · set → 先写 localStorage（立即）+ fire-and-forget `collection.upsertItem`（内部管 uat/防抖推云）
//                       · refresh（boot/focus/visible/online）→ `await collection.init()` 拉云合并 → items 投影回散键
//                     uat 只活在 collection（IDB `collections/settings` envelope），localStorage 永远裸值。
// 两者 get 都**不给 default**（README.md §4）：默认值收在 app 一处 SSoT。
import type { Kv } from "./types.ts";
import type { Collection } from "./collection.ts";

// ── 设备本地 ──────────────────────────────────────────────────────────────
export interface LocalSettings {
  get<V = unknown>(key: string): V | undefined;   // 没设 → undefined（无 default 参数）
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

// namespace 默认 "settings."（wrapped kv 会补 `${appId}.${databaseId}.` 根 → `${ns}.settings.<key>`）。
export function createLocalSettings(kv: Kv, namespace = "settings."): LocalSettings {
  const k = (key: string): string => namespace + key;
  return {
    get<V = unknown>(key: string): V | undefined {
      const raw = kv.get(k(key));
      if (raw == null) return undefined;
      try { return JSON.parse(raw) as V; } catch { return undefined; }
    },
    set(key, value) { kv.set(k(key), JSON.stringify(value)); },
    delete(key) { kv.remove(k(key)); },
  };
}

// ── 跨设备（散键裸值读面 + 后台 collection 传输）────────────────────────────
// collection 的 item payload 形状：{ v: <任意 JSON 值> }，id = setting key。
export type SettingItem = { v: unknown };

export interface SyncedSettings {
  init(): Promise<void>;      // boot：首拉云 + 投影回散键
  refresh(): Promise<void>;   // focus/visible/online：再拉 + 投影（per-key LWW 保不覆盖刚改的值）
  get<V = unknown>(key: string): V | undefined;   // 同步直读 localStorage 裸值（首屏零 await）
  set(key: string, value: unknown): void;         // 直写 localStorage + fire-and-forget collection
  delete(key: string): void;
  flush(): Promise<void>;     // 立即把待推项落云 + 投影
}

export function createSyncedSettings(coll: Collection<SettingItem>, kv: Kv, namespace = "settings."): SyncedSettings {
  const k = (key: string): string => namespace + key;
  // 把 collection 现值投影回散键裸值（拉云合并后调）。只写 synced 键（collection 里的），local-only 键不碰。
  const project = (): void => { for (const it of coll.items()) kv.set(k(it.id), JSON.stringify((it as SettingItem & { id: string }).v)); };
  return {
    async init() { await coll.init(); project(); },
    async refresh() { await coll.init(); project(); },   // init 内含 pull-merge（+etag-skip 快路径），可重复调 = 再拉
    get<V = unknown>(key: string): V | undefined {
      const raw = kv.get(k(key));
      if (raw == null) return undefined;
      try { return JSON.parse(raw) as V; } catch { return undefined; }
    },
    set(key, value) { kv.set(k(key), JSON.stringify(value)); coll.upsertItem({ id: key, v: value }); },   // 立即 + fire-and-forget
    delete(key) { kv.remove(k(key)); coll.deleteItem(key); },
    async flush() { await coll.flush(); project(); },
  };
}
