// ⚠ 引擎内部深模块（ADR-0019 显式版本迁移）。app **碰不到**本文件（只走 createStore 的 file / collection 两面）。
//   schema 名字/迁移是 store 独占。设计见 JRP src/store/CONTEXT.md 的 migration/schema-version 段。
//
// **框架，不含迁移**（2026-07-13）：WebPaint 无用户、无后向兼容 → 历史 V001（webpaint-anchor）/ V002（裸名→全名）
//   两条迁移的搬迁逻辑（tax）已删，库以**最新标准**出生（身份=全名 X.ora、appId 命名空间、dirty 双轨）。
//   保留的是**体系**：schema 版本戳 · 有序注册表 MIGRATIONS · 编排 runMigrations（读戳→按序跑→成功才盖戳，幂等崩溃安全）
//   · 运行时命名空间 storeNamespace（IDB 库名 + localStorage 键前缀，据 appId 隔离同 origin 兄弟 PWA）。
//   将来真有用户、真要改 kv/IDB 结构时 → 往 MIGRATIONS 加**第一条** Migration（version 单调），编排自动接管。
//
// 结构：① 纯逻辑（版本戳解析/比较）；② 命名空间派生；③ 编排；④ IO 薄壳（localStorage 包装）。

import type { Kv } from "./types.ts";
import { namespacedKv } from "./kv-namespace.ts";

// ══════════════════════════════════════════════════════════════════════════════════════════
// ① schema 版本戳（namespacedKv 下 schemaKey="database-version" → `${ns}.database-version` = "vNNN-yyyymmdd"，NNN 零填充=单调序号，yyyymmdd=落地日）
// ══════════════════════════════════════════════════════════════════════════════════════════

export type SchemaVersion = `v${string}`;   // 例 "v001-20260709"

/** 解析 vNNN-yyyymmdd。合法 → { seq, date }；非法 → null。 */
export function parseSchemaVersion(v: string): { seq: number; date: string } | null {
  const m = /^v(\d{3,})-(\d{8})$/.exec(v);
  if (!m) return null;
  return { seq: Number(m[1]), date: m[2] };
}

/** current 落后于 target（= 需要跑迁移）？null/损坏戳 → true（保守；迁移幂等无害）；否则按 seq 比。target 非法 → 抛。 */
export function needsMigration(current: string | null, target: SchemaVersion): boolean {
  const t = parseSchemaVersion(target);
  if (!t) throw new Error(`非法 target schema 版本戳: ${target}`);
  if (current == null) return true;
  const c = parseSchemaVersion(current);
  if (!c) return true;
  return c.seq < t.seq;
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// ② app 命名空间（运行时——create-store 用；同 origin 兄弟 PWA 隔离的红线，见 idb-store.ts 头注释）
//   IndexedDB / localStorage 按 origin 隔离、不按 path → GitHub Pages 的 /webpaint/ 与 /jrp/ 同 origin。
//   写死的库名/键前缀会让两个 app 共用一份存储 = 灾难。∴ 所有持久化标识都从 appId 派生。
// ══════════════════════════════════════════════════════════════════════════════════════════

// 命名空间根 = `${appId}.${databaseId}`（IDB 库名 + 全部 localStorage 键的前缀，经 namespacedKv 统一加）。
//   databaseId 默认 "defaultStore"（createStore ctor）；同 app 多 store 实例（不同 databaseId）本地互不打架。
//   schemaKey 是**相对键**（namespacedKv 会补根前缀 → 实际 `${root}.database-version`）；migration 的
//   kv 也是 namespacedKv，故各 Migration 内读写结构键都用相对键、天然落命名空间内。
export interface StoreNamespace {
  root: string;      // `${appId}.${databaseId}`
  dbName: string;    // IDB 库名 = root
  schemaKey: string; // 相对键 "database-version"
}

export function storeNamespace(appId: string, databaseId: string): StoreNamespace {
  if (!appId) throw new Error("storeNamespace: appId 必填——同 origin 兄弟 PWA 隔离的红线，不给会共用一个库");
  if (!databaseId) throw new Error("storeNamespace: databaseId 必填——同 app 多 store 实例隔离（默认 defaultStore）");
  const root = `${appId}.${databaseId}`;
  return { root, dbName: root, schemaKey: "database-version" };
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// ③ 编排
// ══════════════════════════════════════════════════════════════════════════════════════════

/** 迁移需要枚举键（运行时 Kv 不需要 → 不在 Kv 契约里）。prod 包 localStorage，测试用 mem。 */
export interface MigrationKv extends Kv {
  keys(): string[];
}

/** 一条迁移拿到的上下文：可枚举 kv + 命名空间（dbName/etag/dirty 前缀等，改结构按需取）+ 日志。 */
export interface MigrationCtx {
  kv: MigrationKv;
  ns: StoreNamespace;
  log?: (msg: string) => void;
}

export interface Migration {
  version: SchemaVersion;
  describe: string;
  run(ctx: MigrationCtx): Promise<void>;
}

/**
 * 有序注册表：每次动 kv/IDB 结构加一条，version 单调递增。
 * **现为空**——库以最新标准出生（无用户/无后向兼容，2026-07-13 清 V001/V002 tax）。
 */
export const MIGRATIONS: readonly Migration[] = [];

/**
 * 读戳 → 按序跑欠的迁移 → **run 成功后才盖新戳**（崩了不盖→下次重跑）。幂等：戳已到位则整体 no-op。
 * createStore 在 ready-gate 前 await 本函数（迁移未完不提供任何读）。MIGRATIONS 空 → 直接返回、不写戳。
 * migrations 参数默认 = MIGRATIONS（prod）；测试注入合成列表验编排机制（版本戳单调/幂等/崩溃安全）。
 */
export async function runMigrations(ctx: MigrationCtx, migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  for (const m of migrations) {
    if (!needsMigration(ctx.kv.get(ctx.ns.schemaKey), m.version)) continue;
    ctx.log?.(`[migration] → ${m.version}: ${m.describe}`);
    await m.run(ctx);
    ctx.kv.set(ctx.ns.schemaKey, m.version);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// ④ IO 薄壳（localStorage 包装成可枚举 MigrationKv）
// ══════════════════════════════════════════════════════════════════════════════════════════

/** prod：包 localStorage 成 MigrationKv（keys 经 Object.keys）。 */
export function localStorageMigrationKv(): MigrationKv {
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (!ls) throw new Error("localStorageMigrationKv: 无 localStorage");
  return {
    get: (k) => ls.getItem(k),
    set: (k, v) => ls.setItem(k, v),
    remove: (k) => ls.removeItem(k),
    keys: () => Object.keys(ls),
  };
}

/** prod 组装 + 跑（createStore 在 ready-gate 前调）。命名空间根 = `${appId}.${databaseId}`。
 *  kv 经 namespacedKv 包过 → migration 内所有键读写自动落 `${root}.` 命名空间（含 keys() 只列本命名空间）。 */
export async function runStoreMigrations(appId: string, databaseId: string, log?: (m: string) => void): Promise<void> {
  const ns = storeNamespace(appId, databaseId);
  const kv = namespacedKv(localStorageMigrationKv(), ns.root);
  await runMigrations({ kv, ns, log });
}
