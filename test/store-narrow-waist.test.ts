// 窄腰 + collection-KV 验收（2026-07-13）：命名空间根 `${appId}.${databaseId}` + kv 前缀 choke point +
//   isHidden 列举过滤 + collection 合法名 + files/collections 两实例 etag 隔离 +
//   collection KV 面（getItem/default/setItem/getEntry/pre-init 守卫/local-only 变体） +
//   collection 云端落 `.${appId}/<name>.json` + scaffold + backupFolder 默认 `.backup`。
//   （localSettings/syncedSettings 已删 2026-07-13——设置/状态全走 collection。）
import { test, eq, assert } from "./runner.mjs";
import { isHidden } from "../src/store/is-hidden.ts";
import { namespacedKv } from "../src/store/kv-namespace.ts";
import { createStore } from "../src/store/create-store.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { createCloudSync } from "../src/store/cloud-sync.ts";

// 可 dump 的内存 kv（含 keys()）——检查命名空间。
function dumpKv() {
  const m = new Map<string, string>();
  return {
    get: (k: string) => (m.has(k) ? m.get(k)! : null),
    set: (k: string, v: string) => { m.set(k, String(v)); },
    remove: (k: string) => { m.delete(k); },
    keys: () => [...m.keys()],
    _map: m,
  };
}

const STUB_UI = { busy: (_l: string, fn: () => Promise<unknown>) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {} } as never;
function mkStore(kv: ReturnType<typeof dumpKv>, provider = createMockProvider(), databaseId?: string) {
  return {
    provider,
    store: createStore({
      appId: "wp", databaseId, provider, ui: STUB_UI,
      validateAdopt: () => true, kv, local: createMockLocal(),
      fileName: (n: string) => n, isOnline: () => true, signedIn: () => true, skipMigration: true,
    }),
  };
}

// ── isHidden（纯）────────────────────────────────────────────────────────────
test("[narrow-waist] isHidden：末段 dot 判隐藏（.trash/.backup/.wp/任意 dot；a/.b；.x/y 段）", () => {
  for (const h of [".trash", ".backup", ".wp", ".secret.ora", "a/.hidden", "folder/.b.ora"])
    assert(isHidden(h), `应隐藏: ${h}`);
  for (const v of ["x.ora", "folder/x.ora", "reading-state", "a.b/c.ora", ""])
    assert(!isHidden(v), `不应隐藏: ${v}`);
});

// ── namespacedKv（纯）────────────────────────────────────────────────────────
test("[narrow-waist] namespacedKv：所有键补 `${ns}.` 前缀，keys() 只返本命名空间去前缀键", () => {
  const raw = dumpKv();
  raw.set("other.app.foo", "x");                 // 别的命名空间的键
  const kv = namespacedKv(raw, "wp.defaultStore");
  kv.set("files.etag:a.ora", "E");
  kv.set("collections.etag:pref", "F");
  eq(raw.get("wp.defaultStore.files.etag:a.ora"), "E", "写落命名空间");
  eq(kv.get("files.etag:a.ora"), "E", "读经命名空间");
  const ks = kv.keys().sort();
  eq(ks.join(","), "collections.etag:pref,files.etag:a.ora", "keys() 只列本命名空间、去前缀，不含别的 app");
});

// ── collection KV 面：getItem 缺省 / setItem 往返 / getEntry / 信封 {id,uat,value} ─────────
test("[collection] getItem 缺省 + setItem/getItem 往返 + getEntry(uat) + 裸值/对象 value", async () => {
  const { store } = mkStore(dumpKv());
  const c = store.collection("synced-user-preference");
  eq(c.getItem("lang", "en"), "en", "init/无值 → 返 default");
  eq(c.getItem("lang", () => "zh"), "zh", "default 支持 lambda");
  await c.init();
  eq(c.getItem("lang", "en"), "en", "hydrate 空 → 仍 default");
  c.setItem("lang", "ja");                       // 裸值
  c.setItem("panel", { x: 1, y: 2 });            // 对象值
  eq(c.getItem("lang", "en"), "ja", "setItem/getItem 往返（裸值）");
  eq(JSON.stringify(c.getItem("panel", null)), JSON.stringify({ x: 1, y: 2 }), "对象 value 往返");
  const e = c.getEntry("lang");
  assert(e && e.id === "lang" && e.value === "ja" && typeof e.uat === "number" && e.uat > 0, "getEntry 带 id/value/uat 盖戳");
  assert(c.keys().includes("lang") && c.keys().includes("panel"), "keys() 列所有 id");
});

// ── getItem/setItem 两侧 shallow copy 隔离：app 改拿到/传入的对象都不污染信封 ───────────────
test("[collection] getItem/setItem 两侧 shallow copy 隔离（改副本不污染信封）", async () => {
  const { store } = mkStore(dumpKv());
  const c = store.collection("synced-app-state");
  await c.init();
  const src = { left: 1, top: 2 };
  c.setItem("pos", src);
  src.left = 999;                                  // app 事后改传入对象
  eq((c.getItem("pos", null) as { left: number }).left, 1, "setItem 浅拷贝：事后改传入对象不污染信封");
  const got = c.getItem("pos", null) as { left: number };
  got.left = 777;                                  // app 原地改拿到的对象
  eq((c.getItem("pos", null) as { left: number }).left, 1, "getItem 浅拷贝：原地改返回对象不污染信封");
});

// ── onChange 单 key 绑定：只该 key 变才触发（跨设备 pull 带来值变）─────────────────────────
test("[collection] onChange(id,cb) 单 key 绑定：只该 key 变才触发", async () => {
  const provider = createMockProvider();
  const a = mkStore(dumpKv(), provider).store.collection("synced-user-preference");
  await a.init(); a.setItem("lang", "zh"); await a.reconcileWithRemote();   // A 先推云 lang=zh
  const b = mkStore(dumpKv(), provider).store.collection("synced-user-preference");   // B 后登录（另一台设备）
  let langHits = 0, otherHits = 0;
  b.onChange("lang", () => { langHits++; });
  b.onChange("other-key", () => { otherHits++; });
  await b.init(); await b.reconcileWithRemote();       // B 拉云 → lang 从无→zh 值变
  assert(langHits >= 1, "绑定的 lang 变了 → 触发");
  eq(otherHits, 0, "没变的 other-key → 不触发");
});

// ── pre-init 守卫：init() 前 setItem 抛错；getItem 恒返 default ───────────────────────────
test("[collection] pre-init 守卫：init 前 setItem 抛、getItem 返 default", () => {
  const { store } = mkStore(dumpKv());
  const c = store.collection("synced-app-state");
  eq(c.getItem("current-file", null), null, "init 前 getItem 返 default（不崩）");
  let threw = false;
  try { c.setItem("current-file", "x.ora"); } catch { threw = true; }
  assert(threw, "init 前 setItem 应抛（设置未就绪，防覆盖未 hydrate 的值）");
});

// ── local-only 变体（{local:true}）：只走 IDB、永不碰云、不 scaffold 云文件 ──────────────────
test("[collection] local-only 变体：不上云（无 collections.etag/dirty kv、云端无文件）、isDirty 恒 false", async () => {
  const kv = dumpKv();
  const { store, provider } = mkStore(kv, createMockProvider());
  const c = store.collection("local-user-preference", { local: true });
  await c.init();
  c.setItem("color-theme", "night");
  await c.flushLocal();
  eq(c.getItem("color-theme", "auto"), "night", "本地往返 OK");
  eq(c.isDirty(), false, "local-only 永不脏");
  assert(!kv.keys().some((k) => k.includes("collections.etag:local-user-preference")), "local-only 不写 collections etag kv");
  await new Promise((r) => setTimeout(r, 20));
  assert(!(await provider.getItemByPath(".wp/local-user-preference.json")), "local-only 不 scaffold 云端文件");
});

test("[narrow-waist] databaseId：默认 defaultStore；不同 databaseId → 不同命名空间根（多实例不打架）", async () => {
  const kvA = dumpKv(), kvB = dumpKv();
  const a = mkStore(kvA).store.collection("synced-user-preference"); await a.init(); a.setItem("lang", "zh"); await a.reconcileWithRemote();
  const b = mkStore(kvB, createMockProvider(), "thumbs").store.collection("synced-user-preference"); await b.init(); b.setItem("lang", "en"); await b.reconcileWithRemote();
  assert(kvA.keys().every((k) => k.startsWith("wp.defaultStore.")), "默认根 wp.defaultStore");
  assert(kvB.keys().every((k) => k.startsWith("wp.thumbs.")), "自定义根 wp.thumbs");
});

test("[narrow-waist] collection 名：非法/斜杠/.. → 抛；合法名 OK（settings 已非保留名）", () => {
  const { store } = mkStore(dumpKv());
  for (const bad of ["", "a/b", "a:b", "..", "x*"]) {
    let t = false; try { store.collection(bad); } catch { t = true; }
    assert(t, `非法 collection 名应抛: ${JSON.stringify(bad)}`);
  }
  store.collection("settings"); store.collection("brush-rack"); store.collection("synced-user-preference");   // 合法：不抛（settings 已解除保留）
});

// ── files / collections 两实例 etag 隔离 + collection 云端落 .wp/<name>.json ──────
test("[narrow-waist] file 与同名 collection 的 etag 落不同前缀（两实例隔离）+ collection 云端 = .wp/<name>.json", async () => {
  const kv = dumpKv();
  const { store, provider } = mkStore(kv);

  await store.file("dup.ora", { isZip: false }).save(new TextEncoder().encode("BYTES"));   // 文件推云
  const coll = store.collection("dup");
  await coll.init();
  coll.setItem("k", { v: 1 });
  await coll.reconcileWithRemote();                                                                        // collection 推云

  assert(kv.keys().some((k) => k.startsWith("wp.defaultStore.files.etag:")), "文件 etag 落 files.etag:");
  assert(kv.keys().some((k) => k === "wp.defaultStore.collections.etag:dup"), "collection etag 落 collections.etag:dup");
  assert(!kv.keys().some((k) => k.startsWith("wp.defaultStore.collections.etag:dup.ora")), "文件不该落 collections 前缀");

  const item = await provider.getItemByPath(".wp/dup.json");
  assert(!!item, "collection 应落云端 .wp/dup.json");
  assert(!!(await provider.getItemByPath("dup.ora")), "文件落 approot 根 dup.ora");
});

// ── store 自管 scaffold：synced collection 建 .wp/<name>.json（不覆盖已有）──────────────────
test("[narrow-waist] scaffold：建 synced collection → 建 .wp/<name>.json（不覆盖已有）", async () => {
  const provider = createMockProvider();
  const { store } = mkStore(dumpKv(), provider);
  store.collection("brush-rack");                        // synced collection → store 自动在云端建出文件
  await new Promise((r) => setTimeout(r, 30));           // 等 fire-and-forget scaffold 落地
  assert(!!(await provider.getItemByPath(".wp/brush-rack.json")), "建 collection 应建 .wp/brush-rack.json");
  const before = await provider.getItemByPath(".wp/brush-rack.json");
  // 二次建同名同 provider → 已存在不重建、不覆盖（etag 不变）
  const { store: store2 } = mkStore(dumpKv(), provider);
  store2.collection("brush-rack");
  await new Promise((r) => setTimeout(r, 30));
  const after = await provider.getItemByPath(".wp/brush-rack.json");
  eq(after!.eTag, before!.eTag, "已存在的 .wp/brush-rack.json 不被空信封覆盖（etag 不变）");
});

// ── cloud-sync backupFolder 默认 .backup（weakOverride loser 落 .backup/）─────────
test("[narrow-waist] cloud-sync backupFolder 默认 .backup（weakOverride 把云端 loser stash 进 .backup/）", async () => {
  const provider = createMockProvider();
  provider._seed("z.ora", "OLD-CLOUD");
  const cloud = createCloudSync({ provider, kv: (() => { const d = dumpKv(); return d; })(), fileName: (n: string) => n });
  const res = await cloud.weakOverride("z.ora", new TextEncoder().encode("NEW-LOCAL"));
  assert(String(res.backedUp).startsWith(".backup/"), `loser 应进 .backup/，实得 ${res.backedUp}`);
});

// ── file mode:"new" 新建画布防静默覆盖（1d，2026-07-17）────────────────────────────────
{
  const _enc = (s: string) => new TextEncoder().encode(s);
  const _td = new TextDecoder();
  async function readFile(store: ReturnType<typeof mkStore>["store"], name: string): Promise<string> {
    const b = await store.file(name, { isZip: true, mode: "existing" }).open();
    if (!b) return "";
    const u8 = b instanceof Uint8Array ? b : new Uint8Array(await (b as Blob).arrayBuffer());
    return _td.decode(u8);
  }
  test("[file mode] mode:'new' 撞名不覆盖（抛 collision）；existing 覆盖=正常编辑", async () => {
    const { store } = mkStore(dumpKv());
    await store.file("A.ora", { isZip: true, mode: "new" }).save(_enc("V1"), { tryPush: false });   // 空名 → 建成功
    eq(await readFile(store, "A.ora"), "V1", "新建成功、可读");
    let threw = false;
    try { await store.file("A.ora", { isZip: true, mode: "new" }).save(_enc("V2"), { tryPush: false }); }
    catch { threw = true; }
    assert(threw, "mode:'new' 撞名 → 抛（绝不静默覆盖）");
    eq(await readFile(store, "A.ora"), "V1", "原字节没被覆盖（还是 V1）");
    await store.file("A.ora", { isZip: true, mode: "existing" }).save(_enc("V3"), { tryPush: false });   // 编辑=覆盖正常
    eq(await readFile(store, "A.ora"), "V3", "existing 覆盖 = 正常持久");
  });
}
