// ⚠ 引擎内部深模块（ADR-0019 锚 JRP 名 + 显式版本迁移 / ADR-0020 dirty 双轨 / ADR-0021 app 四面不碰 kv）。
//   app **碰不到**本文件（只走 createStore 的 file/collection/localSettings/syncedSettings）。schema 名字/迁移是 store 独占。
//   设计见 docs/20260709-store-convergence-migration-plan.md + JRP src/store/CONTEXT.md 的 migration/schema-version 段。
//
// 结构：
//   ① 纯逻辑（无 IO，穷举 node 测）：版本戳解析/比较 · dirty 拆轨分类器 · key/record remapper。
//   ② over 注入 kv（mem 可测）：migrateKv（etag 重前缀 + dirty 全量拆轨）· runMigrations（编排 + 盖戳 + 幂等）。
//   ③ IO 薄壳（IDB 不能 node 测 → 真机验，写到一眼看对）：migrateSessionsIdb · localStorageMigrationKv · runStoreMigrations。
//
// **不做愈合**（无 `?? ora` read-fallback，ADR-0019）：迁移一次性把数据搬到锚定名，之后 reader 全干净。

import type { Kv } from "./types.ts";

// ══════════════════════════════════════════════════════════════════════════════════════════
// ① 纯逻辑
// ══════════════════════════════════════════════════════════════════════════════════════════

// ── schema 版本戳：kv["store.schema"] = "vNNN-yyyymmdd"（NNN 零填充=单调序号，yyyymmdd=落地日）──
export type SchemaVersion = `v${string}`;   // 例 "v001-20260709"
export const SCHEMA_KEY = "store.schema";
export const CURRENT_SCHEMA: SchemaVersion = "v001-20260709";

/** 解析 vNNN-yyyymmdd。合法 → { seq, date }；非法 → null。 */
export function parseSchemaVersion(v: string): { seq: number; date: string } | null {
  const m = /^v(\d{3,})-(\d{8})$/.exec(v);
  if (!m) return null;
  return { seq: Number(m[1]), date: m[2] };
}

/**
 * current 落后于 target（= 需要跑迁移）？null/损坏戳 → true（保守；迁移幂等无害）；否则按 seq 比。target 非法 → 抛。
 */
export function needsMigration(current: string | null, target: SchemaVersion): boolean {
  const t = parseSchemaVersion(target);
  if (!t) throw new Error(`非法 target schema 版本戳: ${target}`);
  if (current == null) return true;
  const c = parseSchemaVersion(current);
  if (!c) return true;
  return c.seq < t.seq;
}

// ── 旧 → 锚定名 的固定前缀（v001 webpaint-anchor）──
export const LEGACY_ETAG_PREFIX = "webpaint.etag:";
export const LEGACY_DIRTY_PREFIX = "webpaint.dirty:";
export const NEW_ETAG_PREFIX = "sync.etag:";                    // = createCloudSync 默认 appKey "sync"
export const LEGACY_LOCAL_TRASH = "trash:";
export const NEW_LOCAL_TRASH = "local-trash:";                  // 对齐云端 .trash
export const LEGACY_LOCAL_BACKUP = ".backup-local/";
export const NEW_LOCAL_BACKUP = "local-backup:";               // 对齐云端 .backup

// ── dirty 拆轨（ADR-0020）──
export type DirtyTrack = "collection" | "work-file-dirty" | "work-file-clean";

export interface DirtyRoute {
  name: string;
  track: DirtyTrack;
  writeKey: string | null;   // 迁移后写的 kv key（null = clean 工作文件：local-head 语义 clean=无键）
  writeValue: string | null;
}

export interface DirtyPrefixes {
  collection: string;   // cloud-sync 轨（默认脏）。锚定 JRP：sync.dirty:
  workFile: string;     // local-head 轨（默认 clean）。锚定 JRP：head.dirty:
}
export const JRP_DIRTY_PREFIXES: DirtyPrefixes = { collection: "sync.dirty:", workFile: "head.dirty:" };

/**
 * 把一条旧 dirty 分类到收敛后两轨之一（ADR-0020）。纯函数。
 * 红线：**仅** oldValue==="0" 判 clean；"1"/缺失/怪值/不认识的名字 一律留脏，绝不把未推的世界唯一副本降 clean → 被驱逐。
 */
export function classifyDirty(
  name: string,
  oldValue: string | null,
  collectionNames: ReadonlySet<string>,
  prefixes: DirtyPrefixes = JRP_DIRTY_PREFIXES,
): DirtyRoute {
  if (collectionNames.has(name)) {
    const value = oldValue === "0" ? "0" : "1";   // cloud-sync 默认脏：非显式 clean 一律脏
    return { name, track: "collection", writeKey: prefixes.collection + name, writeValue: value };
  }
  if (oldValue === "0") return { name, track: "work-file-clean", writeKey: null, writeValue: null };
  return { name, track: "work-file-dirty", writeKey: prefixes.workFile + name, writeValue: "1" };
}

/** IDB 记录 key 前缀重映射（trash/backup 对齐云端命名；普通名不变）。纯函数。 */
export function remapLocalKey(key: string): string {
  if (key.startsWith(LEGACY_LOCAL_TRASH)) return NEW_LOCAL_TRASH + key.slice(LEGACY_LOCAL_TRASH.length);
  if (key.startsWith(LEGACY_LOCAL_BACKUP)) return NEW_LOCAL_BACKUP + key.slice(LEGACY_LOCAL_BACKUP.length);
  return key;
}

/** 旧 session 记录 → 锚定记录形状：{name,updatedAt,ora,thumb} → {blob,thumb,updatedAt}（丢冗余 name，ora→blob）。纯函数。 */
export function remapSessionRecord(rec: { updatedAt?: number; ora: unknown; thumb?: unknown }): { blob: unknown; thumb: unknown; updatedAt: number } {
  return { blob: rec.ora, thumb: rec.thumb ?? null, updatedAt: rec.updatedAt ?? 0 };
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// ② over 注入 kv（mem 可测）
// ══════════════════════════════════════════════════════════════════════════════════════════

/** 迁移需要枚举键（运行时 Kv 不需要 → 不在 Kv 契约里）。prod 包 localStorage，测试用 mem。 */
export interface MigrationKv extends Kv {
  keys(): string[];
}

export interface MigrateKvOpts {
  collectionNames: ReadonlySet<string>;
  dirtyPrefixes?: DirtyPrefixes;
}

/**
 * v001 的 kv 半（同步，over 注入 MigrationKv，穷举 mem 测）：
 *   - `webpaint.etag:<name>`  → `sync.etag:<name>`（值保留）；删旧。
 *   - `webpaint.dirty:<name>` → classifyDirty 路由到 `head.`/`sync.` 两轨（clean 工作文件不写键）；删旧。
 *   - 其它键（settings/version/pending…）**不碰**。
 * 幂等：旧前缀已被迁走 → 再跑无键可迁，no-op。名字含 `:` 用 slice(前缀长) 提取，不 split。
 */
export function migrateKv(kv: MigrationKv, opts: MigrateKvOpts): void {
  const dp = opts.dirtyPrefixes ?? JRP_DIRTY_PREFIXES;
  for (const key of kv.keys()) {
    if (key.startsWith(LEGACY_ETAG_PREFIX)) {
      const name = key.slice(LEGACY_ETAG_PREFIX.length);
      const v = kv.get(key);
      if (v != null) kv.set(NEW_ETAG_PREFIX + name, v);
      kv.remove(key);
    } else if (key.startsWith(LEGACY_DIRTY_PREFIX)) {
      const name = key.slice(LEGACY_DIRTY_PREFIX.length);
      const route = classifyDirty(name, kv.get(key), opts.collectionNames, dp);
      if (route.writeKey != null) kv.set(route.writeKey, route.writeValue!);
      kv.remove(key);
    }
  }
}

// ── 迁移编排 ────────────────────────────────────────────────────────────────────────────
export interface MigrationCtx {
  kv: MigrationKv;
  collectionNames: ReadonlySet<string>;
  /** IDB 搬字节（注入：prod=真 IDB copy；测试=mock）。分开注入 → 编排+kv 半可 node 测，IDB 半真机验。 */
  migrateIdb: () => Promise<void>;
  log?: (msg: string) => void;
}

export interface Migration {
  version: SchemaVersion;
  describe: string;
  run(ctx: MigrationCtx): Promise<void>;
}

/** v001 webpaint-anchor：kv 重前缀 + dirty 拆轨（可测）+ IDB 搬字节（注入）。 */
export const V001_WEBPAINT_ANCHOR: Migration = {
  version: "v001-20260709",
  describe: "webpaint-anchor：webpaint→sync/head/local-* 名 + ora→blob + dirty 拆轨",
  async run(ctx) {
    migrateKv(ctx.kv, { collectionNames: ctx.collectionNames });   // 同步、可测
    await ctx.migrateIdb();                                         // 注入、真机验
  },
};

/** 有序注册表（每次动 kv/IDB 结构加一条，version 单调）。 */
export const MIGRATIONS: readonly Migration[] = [V001_WEBPAINT_ANCHOR];

/**
 * 读戳 → 按序跑欠的迁移 → **run 成功后才盖新戳**（崩了不盖→下次重跑）。幂等：戳已到位则整体 no-op。
 * createStore 在 ready-gate 前 await 本函数（迁移未完不提供任何读）。
 */
export async function runMigrations(ctx: MigrationCtx): Promise<void> {
  for (const m of MIGRATIONS) {
    if (!needsMigration(ctx.kv.get(SCHEMA_KEY), m.version)) continue;
    ctx.log?.(`[migration] → ${m.version}: ${m.describe}`);
    await m.run(ctx);
    ctx.kv.set(SCHEMA_KEY, m.version);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// ③ IO 薄壳（IDB/localStorage 不能 node 测 → 真机验。写到一眼看对；红线：先写新+盖戳，最后才删旧）
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

/**
 * v001 IDB 半（真机验）：旧 `webpaint`/`sessions` 每条 → 新 `sync-store-cache`/`blobs`，
 *   key 经 remapLocalKey、record 经 remapSessionRecord。
 * 红线：**先把新库全部写成，才允许删旧库**（本函数不删旧——留给上层在整条迁移+盖戳确认后再清；崩溃重跑幂等，put 覆盖）。
 * ⚠ 未 node 测（IDB node 不可用）。cutover 前真机验：迁移前先把所有画 push OneDrive（本地纯可重下影子，风险归零）。
 */
export async function migrateSessionsIdb(): Promise<void> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return;   // 无 IDB 环境（不该在 prod 发生）→ no-op
  const OLD_DB = "webpaint", OLD_STORE = "sessions";
  const NEW_DB = "sync-store-cache", NEW_STORE = "blobs";

  const open = (name: string, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> =>
    new Promise((res, rej) => {
      const r = idb.open(name);
      r.onupgradeneeded = () => upgrade?.(r.result);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });

  // 旧库不存在（JRP/新装）→ 整条 no-op。
  const oldDb = await open(OLD_DB).catch(() => null);
  if (!oldDb || !oldDb.objectStoreNames.contains(OLD_STORE)) { oldDb?.close(); return; }

  const newDb = await open(NEW_DB, (db) => { if (!db.objectStoreNames.contains(NEW_STORE)) db.createObjectStore(NEW_STORE); });

  // 读全旧库到内存（session 数量小），再逐条写新库。put 覆盖 → 重跑幂等。不删旧库。
  const entries: { key: string; rec: { updatedAt?: number; ora: unknown; thumb?: unknown } }[] = await new Promise((res, rej) => {
    const out: { key: string; rec: any }[] = [];
    const tx = oldDb.transaction(OLD_STORE, "readonly");
    const cur = tx.objectStore(OLD_STORE).openCursor();
    cur.onsuccess = () => { const c = cur.result; if (c) { out.push({ key: String(c.key), rec: c.value }); c.continue(); } };
    cur.onerror = () => rej(cur.error);
    tx.oncomplete = () => res(out);
  });

  await new Promise<void>((res, rej) => {
    const tx = newDb.transaction(NEW_STORE, "readwrite");
    const store = tx.objectStore(NEW_STORE);
    for (const { key, rec } of entries) store.put(remapSessionRecord(rec), remapLocalKey(key));
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });

  oldDb.close(); newDb.close();
}

/** prod 组装 + 跑（createStore 在 ready-gate 前调）。IO 薄壳，真机验。 */
export async function runStoreMigrations(collectionNames: ReadonlySet<string>, log?: (m: string) => void): Promise<void> {
  await runMigrations({
    kv: localStorageMigrationKv(),
    collectionNames,
    migrateIdb: migrateSessionsIdb,
    log,
  });
}
