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
import { createIdbCache } from "./idb-store.ts";
import { LOCAL_BACKUP_PREFIX } from "./move-aside.ts";

// ══════════════════════════════════════════════════════════════════════════════════════════
// ① 纯逻辑
// ══════════════════════════════════════════════════════════════════════════════════════════

// ── schema 版本戳：kv["store.schema"] = "vNNN-yyyymmdd"（NNN 零填充=单调序号，yyyymmdd=落地日）──
export type SchemaVersion = `v${string}`;   // 例 "v001-20260709"
export const SCHEMA_KEY = "store.schema";
export const CURRENT_SCHEMA: SchemaVersion = "v002-20260713";   // v002：身份 裸名→全名（薄库，X→X.ora）

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

// ── app 命名空间（同 origin 兄弟 PWA 隔离的红线；见 idb-store.ts 头注释）─────────────────────────
//   IndexedDB / localStorage 按 origin 隔离、不按 path → GitHub Pages 的 /webpaint/ 与 /jrp/ 同 origin。
//   写死的库名/键前缀会让两个 app 共用一份存储 = 灾难（文件互漏、schema 戳互踩、缓存互毁）。
//   ∴ 所有持久化标识都从 appId 派生：IDB 库 `${appId}.sync-store-cache`、localStorage 全 `${appId}.` 前缀。
export interface StoreNamespace {
  dbName: string;                 // IDB 库名
  schemaKey: string;              // schema 版本戳键
  etagPrefix: string;             // 新 etag 键前缀（= cloud-sync appKey `${appId}.sync` + ".etag:"）
  dirtyPrefixes: DirtyPrefixes;   // 新 dirty 双轨前缀（cloud-sync `${appId}.sync.dirty:` / local-head `${appId}.head.dirty:`）
  foldersPendingKey: string;      // 离线空夹登记键
}
export function storeNamespace(appId: string): StoreNamespace {
  if (!appId) throw new Error("storeNamespace: appId 必填——同 origin 兄弟 PWA 隔离的红线，不给会共用一个库");
  return {
    dbName: `${appId}.sync-store-cache`,
    schemaKey: `${appId}.store.schema`,
    etagPrefix: `${appId}.sync.etag:`,
    dirtyPrefixes: { collection: `${appId}.sync.dirty:`, workFile: `${appId}.head.dirty:` },
    foldersPendingKey: `${appId}.folders.pending`,
  };
}

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

/** 旧 session 记录 → 锚定记录形状：{name,updatedAt,ora,thumb} → {blob,peek,updatedAt}（丢冗余 name，ora→blob，thumb→peek）。纯函数。 */
export function remapSessionRecord(rec: { updatedAt?: number; ora: unknown; thumb?: unknown }): { blob: unknown; peek: unknown; updatedAt: number } {
  return { blob: rec.ora, peek: rec.thumb ?? null, updatedAt: rec.updatedAt ?? 0 };
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
  etagPrefix?: string;   // 新 etag 前缀（prod 传 `${appId}.sync.etag:`；默认裸 sync.etag: 仅给测试）
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
  const ep = opts.etagPrefix ?? NEW_ETAG_PREFIX;
  for (const key of kv.keys()) {
    if (key.startsWith(LEGACY_ETAG_PREFIX)) {
      const name = key.slice(LEGACY_ETAG_PREFIX.length);
      const v = kv.get(key);
      if (v != null) kv.set(ep + name, v);
      kv.remove(key);
    } else if (key.startsWith(LEGACY_DIRTY_PREFIX)) {
      const name = key.slice(LEGACY_DIRTY_PREFIX.length);
      const route = classifyDirty(name, kv.get(key), opts.collectionNames, dp);
      if (route.writeKey != null) kv.set(route.writeKey, route.writeValue!);
      kv.remove(key);
    }
  }
}

// ── v002 身份 裸名 → 全名（薄库：库身份从 app 注入名变成全名 X.ora）──────────────────────────
//   toFull(name)：裸名 → 全名（app 注入 = sessionFileName，含 sanitize，与 app 现在的 store.file(全名) lookup 逐字一致）；
//     返回 null = **不动**（已全名 / 非 session）→ 幂等 + 防重入（崩溃重跑不二次追加）。红线：null 判定必须让「已迁移的键」返 null。
export type ToFull = (name: string) => string | null;

/**
 * v002 kv 半（同步，over MigrationKv，穷举 mem 测）：etag + dirty(head/sync) 三前缀的 **name 段** 裸→全名。
 *   `${etagPrefix}X` → `${etagPrefix}toFull(X)`；dirty 两轨同理。值原样保留；toFull 返 null/同名 → 跳（幂等）。
 *   红线：dirty 键必须跟着改名——否则全名身份查不到旧裸名的 dirty flag → 未推的世界唯一副本被当 clean 驱逐（丢编辑）。
 */
export function migrateIdentityKv(kv: MigrationKv, etagPrefix: string, dirtyPrefixes: DirtyPrefixes, toFull: ToFull): void {
  const prefixes = [etagPrefix, dirtyPrefixes.workFile, dirtyPrefixes.collection];
  for (const key of kv.keys()) {
    for (const p of prefixes) {
      if (!key.startsWith(p)) continue;
      const name = key.slice(p.length);
      const full = toFull(name);
      if (full != null && full !== name) {
        const v = kv.get(key);
        if (v != null) kv.set(p + full, v);
        kv.remove(key);
      }
      break;   // 一个键至多命中一个前缀
    }
  }
}

// ── 迁移编排 ────────────────────────────────────────────────────────────────────────────
export interface MigrationCtx {
  kv: MigrationKv;
  collectionNames: ReadonlySet<string>;
  /** IDB 搬字节（注入：prod=真 IDB copy；测试=mock）。分开注入 → 编排+kv 半可 node 测，IDB 半真机验。 */
  migrateIdb: () => Promise<void>;
  // ── app 命名空间（prod 传；不传 → 用裸默认，仅给测试）。──
  schemaKey?: string;              // schema 戳键（默认 SCHEMA_KEY="store.schema"）
  newEtagPrefix?: string;          // 新 etag 前缀（默认 NEW_ETAG_PREFIX="sync.etag:"）
  dirtyPrefixes?: DirtyPrefixes;   // 新 dirty 双轨前缀（默认 JRP_DIRTY_PREFIXES）
  // ── v002 身份 裸→全名 用 ──
  dbName?: string;                 // IDB 库名（v002 blob key 改名用；prod = ns.dbName）
  toFull?: ToFull;                 // 裸名→全名映射（app 注入 = sessionFileName；不给 → v002 身份改名整段 no-op）
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
    migrateKv(ctx.kv, { collectionNames: ctx.collectionNames, etagPrefix: ctx.newEtagPrefix, dirtyPrefixes: ctx.dirtyPrefixes });   // 同步、可测
    await ctx.migrateIdb();                                         // 注入、真机验
  },
};

/** v002 身份 裸名 → 全名（薄库）：kv etag/dirty 段改名（可测）+ IDB blob key 改名（注入）。
 *   toFull 不给（测试/JRP 等身份本就是全名的 app）→ 整条 no-op（仍盖戳，版本前进）。
 *   红线：dirty 键与 blob key 必须一起改名（否则未推的世界唯一副本身份错位 → 被当 clean 驱逐 = 丢编辑）。 */
export const V002_FULL_IDENTITY: Migration = {
  version: "v002-20260713",
  describe: "身份 裸名→全名（薄库 X→X.ora）：blob key + etag + dirty 段改名（toFull 幂等跳已全名）",
  async run(ctx) {
    if (!ctx.toFull) { ctx.log?.("[migration] v002：无 toFull → 身份改名 no-op（身份本就是全名）"); return; }
    migrateIdentityKv(ctx.kv, ctx.newEtagPrefix ?? NEW_ETAG_PREFIX, ctx.dirtyPrefixes ?? JRP_DIRTY_PREFIXES, ctx.toFull);   // 同步、可测
    if (ctx.dbName) await migrateIdentityIdb(ctx.dbName, ctx.toFull);   // 注入、真机验
  },
};

/** 有序注册表（每次动 kv/IDB 结构加一条，version 单调）。 */
export const MIGRATIONS: readonly Migration[] = [V001_WEBPAINT_ANCHOR, V002_FULL_IDENTITY];

/**
 * 读戳 → 按序跑欠的迁移 → **run 成功后才盖新戳**（崩了不盖→下次重跑）。幂等：戳已到位则整体 no-op。
 * createStore 在 ready-gate 前 await 本函数（迁移未完不提供任何读）。
 */
export async function runMigrations(ctx: MigrationCtx): Promise<void> {
  const schemaKey = ctx.schemaKey ?? SCHEMA_KEY;
  for (const m of MIGRATIONS) {
    if (!needsMigration(ctx.kv.get(schemaKey), m.version)) continue;
    ctx.log?.(`[migration] → ${m.version}: ${m.describe}`);
    await m.run(ctx);
    ctx.kv.set(schemaKey, m.version);
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
export async function migrateSessionsIdb(newDbName: string): Promise<void> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return;   // 无 IDB 环境（不该在 prod 发生）→ no-op
  const OLD_DB = "webpaint", OLD_STORE = "sessions";
  const NEW_DB = newDbName, NEW_STORE = "blobs";   // ⚠ newDbName 必带 app 命名空间（`${appId}.sync-store-cache`）——非写死，防同 origin 兄弟 PWA 互踩

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

/**
 * v002 IDB 半（真机验）：`${appId}.sync-store-cache`/`blobs` 里的**每个 session blob key** 裸→全名（toFull）。
 *   排除内部命名空间（local-trash: / .backup-local / __collection__/）——只改用户 session 文件。
 *   幂等：toFull 对**已全名**键返 null → 跳（崩溃重跑不二次追加 .ora）。原子 rename（get→put 新→del 旧）。
 * 红线：blob key 必须与 kv 半（etag/dirty）**同一 toFull** 改名，否则全名身份读不到本地字节/dirty flag。
 * ⚠ 未 node 测（IDB node 不可用）。真机验：迁移前把画都 push OneDrive（本地纯可重下影子，风险归零）。
 */
export async function migrateIdentityIdb(dbName: string, toFull: ToFull): Promise<void> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return;   // 无 IDB 环境 → no-op
  const cache = createIdbCache(dbName);
  const keys = await cache.keys();
  for (const k of keys) {
    if (k.startsWith("local-trash:") || k.startsWith(LOCAL_BACKUP_PREFIX) || k.startsWith("__collection__/")) continue;   // 内部命名空间不动
    const full = toFull(k);
    if (full == null || full === k) continue;   // 已全名/不动 → 跳（幂等）
    await cache.rename(k, full);                 // 原子 get→put(全名)→del(裸名)
  }
}

/** prod 组装 + 跑（createStore 在 ready-gate 前调）。IO 薄壳，真机验。
 *  appId = app 在本 origin 内的唯一命名空间 → 所有持久化标识（IDB 库名 + localStorage 键）都据它隔离。
 *  toFull = app 的裸名→全名映射（WebPaint = sessionFileName；不给 → v002 身份改名 no-op）。 */
export async function runStoreMigrations(appId: string, collectionNames: ReadonlySet<string>, toFull?: ToFull, log?: (m: string) => void): Promise<void> {
  const ns = storeNamespace(appId);
  await runMigrations({
    kv: localStorageMigrationKv(),
    collectionNames,
    migrateIdb: () => migrateSessionsIdb(ns.dbName),
    schemaKey: ns.schemaKey,
    newEtagPrefix: ns.etagPrefix,
    dirtyPrefixes: ns.dirtyPrefixes,
    dbName: ns.dbName,
    toFull,
    log,
  });
}
