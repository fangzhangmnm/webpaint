// store `migration` 深模块纯逻辑 + kv 半验收（ADR-0019 版本戳 / ADR-0020 dirty 拆轨）。
// 测无 IO 的纯函数 + over 注入 mem-kv 的 migrateKv/runMigrations（穷举）。
// IDB 半（migrateSessionsIdb 搬字节）= 真机验（IDB node 测不到），此处经 mock migrateIdb 只验编排。
import { describe, it, assert, eq } from "./runner.mjs";
import {
  parseSchemaVersion, needsMigration,
  classifyDirty, JRP_DIRTY_PREFIXES,
  remapLocalKey, remapSessionRecord,
  migrateKv, migrateIdentityKv, runMigrations, MIGRATIONS, CURRENT_SCHEMA, SCHEMA_KEY,
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

describe("migration › dirty 拆轨分类器（ADR-0020）", () => {
  const COLL = new Set(["reading-state.json", "brush-rack", "settings.json"]);
  const c = (name, val) => classifyDirty(name, val, COLL);
  it("collection + '1' → sync.dirty = '1'", () => { const r = c("reading-state.json", "1"); eq(r.track, "collection"); eq(r.writeKey, "sync.dirty:reading-state.json"); eq(r.writeValue, "1"); });
  it("collection + '0' → sync.dirty = '0'", () => { const r = c("brush-rack", "0"); eq(r.writeKey, "sync.dirty:brush-rack"); eq(r.writeValue, "0"); });
  it("collection + null → '1'（默认脏）", () => { eq(c("settings.json", null).writeValue, "1"); });
  it("collection + 怪值 → '1'", () => { eq(c("reading-state.json", "yes").writeValue, "1"); });
  it("工作文件 + '1' → head.dirty = '1'", () => { const r = c("MyPainting.ora", "1"); eq(r.track, "work-file-dirty"); eq(r.writeKey, "head.dirty:MyPainting.ora"); eq(r.writeValue, "1"); });
  it("工作文件 + '0' → clean（不写键）", () => { const r = c("MyPainting.ora", "0"); eq(r.track, "work-file-clean"); eq(r.writeKey, null); eq(r.writeValue, null); });
  it("工作文件 + null → 保守脏", () => { const r = c("Sketch.ora", null); eq(r.track, "work-file-dirty"); eq(r.writeValue, "1"); });
  it("工作文件 + 怪值 → 保守脏", () => { eq(c("Sketch.ora", "dirty").track, "work-file-dirty"); });
  it("含 / 路径名拼接正确", () => { eq(c("folder/sub/pic.ora", "1").writeKey, "head.dirty:folder/sub/pic.ora"); });
  it("含 : 名字拼接正确（不误切）", () => { eq(c("weird:name.ora", "1").writeKey, "head.dirty:weird:name.ora"); });
  it("红线：非 '0' 一律留脏", () => {
    for (const v of ["1", null, "", "0.0", "false", "clean", "x"]) { if (v === "0") continue; const r = c("only-copy.ora", v); eq(r.track, "work-file-dirty", `oldValue=${JSON.stringify(v)} 必留脏`); eq(r.writeValue, "1"); }
    eq(c("only-copy.ora", "0").track, "work-file-clean");
  });
  it("红线：不认识的名字 = 工作文件轨", () => { eq(c("unknown-thing", "1").track, "work-file-dirty"); eq(c("unknown-thing", "1").writeKey, "head.dirty:unknown-thing"); });
  it("自定义前缀被尊重", () => { eq(classifyDirty("x.ora", "1", COLL, { collection: "C:", workFile: "W:" }).writeKey, "W:x.ora"); eq(classifyDirty("reading-state.json", "1", COLL, { collection: "C:", workFile: "W:" }).writeKey, "C:reading-state.json"); });
  it("默认前缀 = JRP 锚定名", () => { eq(JRP_DIRTY_PREFIXES.collection, "sync.dirty:"); eq(JRP_DIRTY_PREFIXES.workFile, "head.dirty:"); });
});

describe("migration › remapper（纯）", () => {
  it("remapLocalKey: trash:→local-trash:", () => { eq(remapLocalKey("trash:1720000000-2:pic.ora"), "local-trash:1720000000-2:pic.ora"); });
  it("remapLocalKey: .backup-local/→local-backup:", () => { eq(remapLocalKey(".backup-local/20260709-abc:pic.ora"), "local-backup:20260709-abc:pic.ora"); });
  it("remapLocalKey: 普通名不变", () => { eq(remapLocalKey("MyPic.ora"), "MyPic.ora"); eq(remapLocalKey("folder/sub/p.ora"), "folder/sub/p.ora"); });
  it("remapSessionRecord: {...} → {blob,peek,updatedAt}", () => {
    const out = remapSessionRecord({ name: "x.ora", updatedAt: 42, ora: "BYTES", thumb: "T" });
    eq(out.blob, "BYTES"); eq(out.peek, "T"); eq(out.updatedAt, 42);
    eq("name" in out, false, "丢冗余 name"); eq("ora" in out, false, "ora→blob 改名");
  });
  it("remapSessionRecord: thumb 缺 → null；updatedAt 缺 → 0", () => {
    const out = remapSessionRecord({ ora: "B" }); eq(out.peek, null); eq(out.updatedAt, 0);
  });
});

describe("migration › migrateKv（over mem-kv，ADR-0019/0020）", () => {
  const COLL = new Set(["reading-state.json"]);
  function seed() {
    return memMkv({
      "webpaint.etag:MyPic.ora": "etagA",
      "webpaint.dirty:MyPic.ora": "1",                    // 工作文件脏 → head
      "webpaint.etag:Clean.ora": "etagB",
      "webpaint.dirty:Clean.ora": "0",                    // 工作文件 clean → 无键
      "webpaint.etag:reading-state.json": "etagC",
      "webpaint.dirty:reading-state.json": "1",           // collection → sync
      "webpaint.dirty:only-copy.ora": "1",                // 只有 dirty 没 etag（local-only 脏）→ head 留脏
      "settings:theme": "night",                          // 无关键 → 不碰
      "folders.pending": "[]",                            // 无关键 → 不碰
    });
  }

  it("etag 重前缀 webpaint→sync；旧键删", () => {
    const kv = seed(); migrateKv(kv, { collectionNames: COLL }); const d = kv._dump();
    eq(d["sync.etag:MyPic.ora"], "etagA"); eq(d["sync.etag:reading-state.json"], "etagC");
    eq("webpaint.etag:MyPic.ora" in d, false, "旧 etag 键应删");
  });
  it("dirty 拆轨：工作文件脏→head、collection→sync、clean 不写键", () => {
    const kv = seed(); migrateKv(kv, { collectionNames: COLL }); const d = kv._dump();
    eq(d["head.dirty:MyPic.ora"], "1", "工作文件脏→head");
    eq(d["head.dirty:only-copy.ora"], "1", "local-only 脏→head 留脏");
    eq(d["sync.dirty:reading-state.json"], "1", "collection→sync");
    eq("head.dirty:Clean.ora" in d, false, "工作文件 clean 不写键");
    eq("webpaint.dirty:Clean.ora" in d, false, "旧 clean 键也删");
  });
  it("红线：clean 只认显式 '0'，其余 dirty 全部保留（一条不丢）", () => {
    const kv = seed(); migrateKv(kv, { collectionNames: COLL }); const d = kv._dump();
    // 3 条工作文件脏(MyPic/only-copy) + collection(reading-state) 都在；唯一 clean 是 Clean.ora("0")
    let dirtyKeptCount = 0;
    for (const k of Object.keys(d)) if (k.startsWith("head.dirty:") || k.startsWith("sync.dirty:")) dirtyKeptCount++;
    eq(dirtyKeptCount, 3, "MyPic + only-copy + reading-state 三条 dirty 全留");
  });
  it("无关键不碰", () => {
    const kv = seed(); migrateKv(kv, { collectionNames: COLL }); const d = kv._dump();
    eq(d["settings:theme"], "night"); eq(d["folders.pending"], "[]");
  });
  it("幂等：再跑一次无旧前缀键 → 结果不变", () => {
    const kv = seed(); migrateKv(kv, { collectionNames: COLL }); const first = JSON.stringify(kv._dump());
    migrateKv(kv, { collectionNames: COLL }); eq(JSON.stringify(kv._dump()), first, "第二次 migrateKv 应 no-op");
  });
  it("名字含 : 的 etag/dirty 正确提取（slice 非 split）", () => {
    const kv = memMkv({ "webpaint.etag:a:b.ora": "e", "webpaint.dirty:a:b.ora": "1" });
    migrateKv(kv, { collectionNames: new Set() }); const d = kv._dump();
    eq(d["sync.etag:a:b.ora"], "e"); eq(d["head.dirty:a:b.ora"], "1");
  });
});

describe("migration › runMigrations 编排", () => {
  it("首跑：跑 v001 + 盖戳 + migrateIdb 调 1 次", async () => {
    const kv = memMkv({ "webpaint.etag:x.ora": "e", "webpaint.dirty:x.ora": "1" });
    let idbCalls = 0;
    await runMigrations({ kv, collectionNames: new Set(), migrateIdb: async () => { idbCalls++; } });
    eq(kv.get(SCHEMA_KEY), CURRENT_SCHEMA, "盖当前戳");
    eq(idbCalls, 1, "migrateIdb 调一次");
    eq(kv.get("sync.etag:x.ora"), "e", "kv 已迁");
    eq(kv.get("head.dirty:x.ora"), "1");
  });
  it("幂等：戳已当前 → 整体 no-op，migrateIdb 不再调", async () => {
    const kv = memMkv({ [SCHEMA_KEY]: CURRENT_SCHEMA, "webpaint.etag:leftover": "e" });
    let idbCalls = 0;
    await runMigrations({ kv, collectionNames: new Set(), migrateIdb: async () => { idbCalls++; } });
    eq(idbCalls, 0, "已到位不跑 IDB");
    eq(kv.get("webpaint.etag:leftover"), "e", "已到位不再动 kv");
  });
  it("重跑一遍（模拟二次 boot）：第二次不再调 migrateIdb", async () => {
    const kv = memMkv({ "webpaint.dirty:y.ora": "1" });
    let idbCalls = 0;
    const ctx = { kv, collectionNames: new Set(), migrateIdb: async () => { idbCalls++; } };
    await runMigrations(ctx); await runMigrations(ctx);
    eq(idbCalls, 1, "两次 boot 仅迁移一次");
    eq(kv.get(SCHEMA_KEY), CURRENT_SCHEMA);
  });
  it("崩溃安全：migrateIdb 抛 → 不盖戳（下次重跑）", async () => {
    const kv = memMkv({ "webpaint.dirty:z.ora": "1" });
    let threw = false;
    try { await runMigrations({ kv, collectionNames: new Set(), migrateIdb: async () => { throw new Error("idb boom"); } }); }
    catch { threw = true; }
    assert(threw, "IDB 抛应冒泡");
    eq(kv.get(SCHEMA_KEY), null, "run 未完成不盖戳 → 下次 needsMigration 仍 true");
  });
  it("注册表 version 单调 + 当前戳 = 表尾", () => {
    for (let i = 1; i < MIGRATIONS.length; i++) assert(MIGRATIONS[i - 1].version < MIGRATIONS[i].version, "version 应单调递增");
    eq(MIGRATIONS[MIGRATIONS.length - 1].version, CURRENT_SCHEMA, "CURRENT_SCHEMA = 注册表最后一条");
  });
});

describe("migration › v002 身份 裸名→全名（薄库 X→X.ora）", () => {
  // 测试用简化 toFull（append；真 app 注入 = sessionFileName，含 sanitize）。已 .ora 结尾 → null（幂等）。
  const toFull = (n) => /\.ora$/i.test(n) ? null : `${n}.ora`;
  const EP = "webpaint.sync.etag:";
  const DP = { collection: "webpaint.sync.dirty:", workFile: "webpaint.head.dirty:" };

  it("etag/dirty 段 裸→全名（值保留、旧键删）", () => {
    const kv = memMkv({
      "webpaint.sync.etag:20260528-01": "eA",
      "webpaint.head.dirty:20260528-01": "1",           // 工作文件脏（红线：必须跟着改名）
      "webpaint.sync.etag:A/wall": "eB",                // 子夹路径
    });
    migrateIdentityKv(kv, EP, DP, toFull);
    const d = kv._dump();
    eq(d["webpaint.sync.etag:20260528-01.ora"], "eA");
    eq(d["webpaint.head.dirty:20260528-01.ora"], "1", "红线：dirty 跟着改名，否则未推副本被当 clean 驱逐→丢编辑");
    eq(d["webpaint.sync.etag:A/wall.ora"], "eB", "子夹路径保留 + 追加 .ora");
    eq("webpaint.sync.etag:20260528-01" in d, false, "旧裸名 etag 键删");
    eq("webpaint.head.dirty:20260528-01" in d, false, "旧裸名 dirty 键删");
  });

  it("collection dirty 段（sync.dirty:）也改名", () => {
    const kv = memMkv({ "webpaint.sync.dirty:draft": "1" });
    migrateIdentityKv(kv, EP, DP, toFull);
    eq(kv._dump()["webpaint.sync.dirty:draft.ora"], "1");
  });

  it("幂等：已全名（.ora 结尾）→ toFull 返 null → 不动（崩溃重跑安全）", () => {
    const kv = memMkv({ "webpaint.sync.etag:X.ora": "e", "webpaint.head.dirty:X.ora": "1" });
    const before = JSON.stringify(kv._dump());
    migrateIdentityKv(kv, EP, DP, toFull);
    eq(JSON.stringify(kv._dump()), before, "全名键不再追加 .ora（防重入）");
  });

  it("无关键不碰（schema/pending/其它前缀）", () => {
    const kv = memMkv({ "webpaint.store.schema": "v001-x", "webpaint.folders.pending": "[]", "other:k": "v" });
    migrateIdentityKv(kv, EP, DP, toFull);
    const d = kv._dump();
    eq(d["webpaint.store.schema"], "v001-x"); eq(d["webpaint.folders.pending"], "[]"); eq(d["other:k"], "v");
  });

  it("名字含 : 正确提取（slice 非 split）", () => {
    const kv = memMkv({ "webpaint.head.dirty:a:b": "1" });
    migrateIdentityKv(kv, EP, DP, toFull);
    eq(kv._dump()["webpaint.head.dirty:a:b.ora"], "1");
  });

  it("编排：v001-stamped 设备 → 只跑 v002，kv 半生效 + 盖到 v002", async () => {
    const kv = memMkv({
      [SCHEMA_KEY]: "v001-20260709",           // 已在 v001（裸名、sync./head. 前缀）
      "webpaint.sync.etag:pic": "e",
      "webpaint.head.dirty:pic": "1",
    });
    // 不传 dbName：IDB 半（migrateIdentityIdb）真机验（node 无真 IDB）；此处只验 kv 半 + 编排盖戳。
    await runMigrations({
      kv, collectionNames: new Set(), migrateIdb: async () => {},
      schemaKey: SCHEMA_KEY, newEtagPrefix: EP, dirtyPrefixes: DP, toFull,
    });
    const d = kv._dump();
    eq(d["webpaint.sync.etag:pic.ora"], "e", "v002 kv 段生效");
    eq(d["webpaint.head.dirty:pic.ora"], "1");
    eq(kv.get(SCHEMA_KEY), CURRENT_SCHEMA, "盖到 v002");
  });

  it("编排：无 toFull → v002 身份改名 no-op（身份本就全名的 app）仍盖戳", async () => {
    const kv = memMkv({ "webpaint.sync.etag:paper.pdf": "e" });
    await runMigrations({ kv, collectionNames: new Set(), migrateIdb: async () => {}, schemaKey: SCHEMA_KEY, newEtagPrefix: EP, dirtyPrefixes: DP });
    eq(kv._dump()["webpaint.sync.etag:paper.pdf"], "e", "无 toFull → 不动身份");
    eq(kv.get(SCHEMA_KEY), CURRENT_SCHEMA, "仍盖到 v002（版本前进）");
  });
});
