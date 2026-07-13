// store `migration` **框架**验收（ADR-0019 显式版本迁移）。
//   2026-07-13：无用户/无后向兼容 → V001/V002 搬迁 tax 已删（MIGRATIONS 空）。这里测**留下的体系**：
//   版本戳解析/比较 · appId 命名空间派生 · runMigrations 编排机制（单调/幂等/崩溃安全，合成迁移注入）。
//   将来加第一条真迁移时，编排机制已被这些测试守门。
import { describe, it, assert, eq } from "./runner.mjs";
import {
  parseSchemaVersion, needsMigration,
  storeNamespace, runMigrations, MIGRATIONS,
} from "../src/store/migration.ts";

// 内存 MigrationKv（含 keys 枚举）。
function memMkv(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, String(v)); },
    remove: (k) => { m.delete(k); },
    keys: () => [...m.keys()],
    _dump: () => Object.fromEntries(m),
  };
}
const NS = storeNamespace("webpaint", "defaultStore");
const ctxOf = (kv, extra = {}) => ({ kv, ns: NS, ...extra });

describe("migration › schema 版本戳", () => {
  it("parse 合法 vNNN-yyyymmdd", () => { const p = parseSchemaVersion("v001-20260709"); eq(p.seq, 1); eq(p.date, "20260709"); });
  it("parse 多位 seq", () => { eq(parseSchemaVersion("v042-20261231").seq, 42); });
  it("parse 非法 → null", () => {
    for (const bad of ["", "v1-20260709", "001-20260709", "v001-2026079", "vabc-20260709", "garbage", "v001_20260709"])
      eq(parseSchemaVersion(bad), null, `应拒: ${bad}`);
  });
  it("needsMigration: null current → true", () => { eq(needsMigration(null, "v001-20260709"), true); });
  it("needsMigration: 同 seq → false", () => {
    eq(needsMigration("v001-20260709", "v001-20260709"), false);
    eq(needsMigration("v001-20260101", "v001-20260709"), false, "同 seq 不同 date 仍到位");
  });
  it("needsMigration: seq 落后 → true", () => { eq(needsMigration("v001-20260709", "v002-20260801"), true); });
  it("needsMigration: seq 领先 → false", () => { eq(needsMigration("v003-20260901", "v001-20260709"), false); });
  it("needsMigration: 损坏戳 → true（保守重跑）", () => { eq(needsMigration("garbage", "v001-20260709"), true); });
  it("needsMigration: 非法 target → 抛", () => {
    let t = false; try { needsMigration("v001-20260709", "bad"); } catch { t = true; } assert(t, "非法 target 应抛");
  });
});

describe("migration › 命名空间根 appId.databaseId（同 origin 兄弟 PWA / 多 store 实例隔离红线）", () => {
  it("标识据 appId.databaseId 派生", () => {
    const ns = storeNamespace("webpaint", "defaultStore");
    eq(ns.root, "webpaint.defaultStore");
    eq(ns.dbName, "webpaint.defaultStore");
    eq(ns.schemaKey, "database-version");   // 相对键（namespacedKv 补根 → webpaint.defaultStore.database-version）
  });
  it("不同 appId / databaseId → 不同库名（不互踩）", () => {
    eq(storeNamespace("jrp", "defaultStore").dbName === storeNamespace("webpaint", "defaultStore").dbName, false);
    eq(storeNamespace("webpaint", "thumbs").dbName === storeNamespace("webpaint", "defaultStore").dbName, false);
    eq(storeNamespace("webpaint", "thumbs").dbName, "webpaint.thumbs");
  });
  it("空 appId / databaseId → 抛（不许 fallback 到共用库）", () => {
    let t = false; try { storeNamespace("", "defaultStore"); } catch { t = true; } assert(t, "空 appId 必抛");
    let t2 = false; try { storeNamespace("webpaint", ""); } catch { t2 = true; } assert(t2, "空 databaseId 必抛");
  });
});

describe("migration › MIGRATIONS 注册表（tax 已清）", () => {
  it("现为空——库以最新标准出生", () => { eq(MIGRATIONS.length, 0); });
  it("version 单调（将来加迁移的护栏；现空 vacuously 真）", () => {
    for (let i = 1; i < MIGRATIONS.length; i++) assert(MIGRATIONS[i - 1].version < MIGRATIONS[i].version, "version 应单调递增");
  });
  it("空注册表跑 runMigrations → no-op、不写任何键", async () => {
    const kv = memMkv({ "files.etag:x.ora": "e" });
    await runMigrations(ctxOf(kv));   // 默认 MIGRATIONS（空）
    eq(kv._dump()[NS.schemaKey], undefined, "无迁移不盖戳");
    eq(kv._dump()["files.etag:x.ora"], "e", "无迁移不动数据");
  });
});

describe("migration › runMigrations 编排机制（合成迁移注入）", () => {
  // 合成迁移：run 时把 kv 里 mark:<v> 置 1，便于断言「跑了哪几条」。
  const mk = (version, mark, run) => ({ version, describe: `test ${version}`, run: run ?? (async (ctx) => { ctx.kv.set(mark, "1"); }) });
  const V1 = mk("v001-20260101", "ran:v001");
  const V2 = mk("v002-20260202", "ran:v002");
  const LIST = [V1, V2];

  it("首跑：按序跑全部 + 逐条盖戳到表尾", async () => {
    const kv = memMkv();
    await runMigrations(ctxOf(kv), LIST);
    eq(kv.get("ran:v001"), "1"); eq(kv.get("ran:v002"), "1");
    eq(kv.get(NS.schemaKey), "v002-20260202", "盖到最后一条");
  });
  it("部分落后：v001-stamped 设备 → 只跑 v002", async () => {
    const kv = memMkv({ [NS.schemaKey]: "v001-20260101" });
    await runMigrations(ctxOf(kv), LIST);
    eq(kv.get("ran:v001"), null, "v001 已到位不重跑");
    eq(kv.get("ran:v002"), "1", "只跑欠的 v002");
    eq(kv.get(NS.schemaKey), "v002-20260202");
  });
  it("幂等：戳已表尾 → 整体 no-op", async () => {
    const kv = memMkv({ [NS.schemaKey]: "v002-20260202" });
    await runMigrations(ctxOf(kv), LIST);
    eq(kv.get("ran:v001"), null); eq(kv.get("ran:v002"), null);
  });
  it("重跑一遍（模拟二次 boot）：第二次不再跑", async () => {
    const kv = memMkv();
    let runs = 0;
    const list = [mk("v001-20260101", "", async (ctx) => { runs++; ctx.kv.set("m", "1"); })];
    await runMigrations(ctxOf(kv), list); await runMigrations(ctxOf(kv), list);
    eq(runs, 1, "两次 boot 仅迁移一次");
  });
  it("崩溃安全：迁移 run 抛 → 不盖戳（下次 needsMigration 仍 true）", async () => {
    const kv = memMkv();
    const boom = [mk("v001-20260101", "", async () => { throw new Error("boom"); })];
    let threw = false;
    try { await runMigrations(ctxOf(kv), boom); } catch { threw = true; }
    assert(threw, "迁移抛应冒泡");
    eq(kv.get(NS.schemaKey), null, "run 未完成不盖戳");
  });
  it("崩溃在第二条：第一条已盖、第二条不盖（下次从第二条重跑）", async () => {
    const kv = memMkv();
    const list = [V1, mk("v002-20260202", "", async () => { throw new Error("boom2"); })];
    let threw = false;
    try { await runMigrations(ctxOf(kv), list); } catch { threw = true; }
    assert(threw);
    eq(kv.get("ran:v001"), "1", "第一条成功已生效");
    eq(kv.get(NS.schemaKey), "v001-20260101", "戳停在第一条（第二条崩，下次续跑）");
  });
});
