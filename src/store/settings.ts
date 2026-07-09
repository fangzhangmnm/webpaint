// ⚠ 使用前必读 README.md。app 不直接 import 本文件——经 createStore 的 store.localSettings /
//   store.syncedSettings 拿。
//
// 两种设置（README.md §4）：
//   localSettings  —— 设备本地 KV（over 注入的 Kv，不同步；theme/zoom/spread 等设备独立项）。
//   syncedSettings —— 跨设备 KV，**内部就是一个 collection、每个 key 当一个 item**：
//                     per-key last-write-wins 是 §3 per-item LWW 白送的，没有第二套合并逻辑。
// 两者 get 都**不给 default**（README.md §4）：默认值收在 app 一处 SSoT，别每次取值各写各的。
import type { Kv } from "./types.ts";
import type { Collection } from "./collection.ts";

// ── 设备本地 ──────────────────────────────────────────────────────────────
export interface LocalSettings {
  get<V = unknown>(key: string): V | undefined;   // 没设 → undefined（无 default 参数）
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

export function createLocalSettings(kv: Kv, namespace = "settings:"): LocalSettings {
  const k = (key: string) => namespace + key;
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

// ── 跨设备（over collection，key-as-item）─────────────────────────────────
// collection 的 payload 形状：{ v: <任意 JSON 值> }，id = setting key。
export type SettingItem = { v: unknown };

export interface SyncedSettings {
  init(): Promise<void>;
  get<V = unknown>(key: string): V | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  flush(): Promise<void>;
}

export function createSyncedSettings(coll: Collection<SettingItem>): SyncedSettings {
  return {
    init: () => coll.init(),
    get<V = unknown>(key: string): V | undefined {
      const it = coll.getItem(key);
      return it ? (it.v as V) : undefined;
    },
    set(key, value) { coll.upsertItem({ id: key, v: value }); },
    delete(key) { coll.deleteItem(key); },
    flush: () => coll.flush(),
  };
}
