// ⚠ store 内部深模块。app 不直接 import——经 createStore。
//
// namespacedKv —— 把注入的 Kv 包一层，所有键自动加 `${ns}.` 前缀（ns = `${appId}.${databaseId}`）。
//   **窄腰的唯一 choke point**：各深模块只用相对键（`files.etag:` / `files.dirty:` / `collections.*` /
//   `settings.*` / `internal.*` / `database-version`），根前缀在这一处统一加 → 任何模块想把键写到命名空间
//   之外都不可能。同 origin 兄弟 PWA / 同 app 多 store 实例（不同 databaseId）据此隔离，绝不互踩。
import type { Kv } from "./types.ts";

// 可枚举 Kv（迁移 / 命名空间过滤需要列键）。prod 的 localStorage 包装、测试的 memKv 皆可实现（缺 keys → 视作空）。
export interface KeyedKv extends Kv {
  keys?(): string[];
}
// 包装后的面：Kv + keys()（只返本命名空间内、**去掉根前缀**的相对键）。
export interface NamespacedKv extends Kv {
  keys(): string[];
}

export function namespacedKv(kv: KeyedKv, ns: string): NamespacedKv {
  if (!ns) throw new Error("namespacedKv: ns 必填（${appId}.${databaseId}）");
  const prefix = `${ns}.`;
  return {
    get: (k) => kv.get(prefix + k),
    set: (k, v) => kv.set(prefix + k, v),
    remove: (k) => kv.remove(prefix + k),
    keys: () => (kv.keys?.() ?? []).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)),
  };
}
