// 窄腰重构验收（2026-07-13）：命名空间根 `${appId}.${databaseId}` + kv 前缀 choke point +
//   isHidden 列举过滤 + collection 合法名/保留名 + files/collections 两实例 etag 隔离 +
//   settings 散键裸值 + collection 云端落 `.${appId}/<name>.json` + backupFolder 默认 `.backup`。
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
  kv.set("settings.theme", "\"dark\"");
  eq(raw.get("wp.defaultStore.files.etag:a.ora"), "E", "写落命名空间");
  eq(kv.get("files.etag:a.ora"), "E", "读经命名空间");
  eq(kv.get("settings.theme"), "\"dark\"");
  const ks = kv.keys().sort();
  eq(ks.join(","), "files.etag:a.ora,settings.theme", "keys() 只列本命名空间、去前缀，不含别的 app");
});

// ── createStore：命名空间 + collection 合法名/保留名 ───────────────────────────
test("[narrow-waist] createStore：所有 kv 键落 `wp.defaultStore.`；localSettings/syncedSettings 散键裸值", () => {
  const kv = dumpKv();
  const { store } = mkStore(kv);
  store.localSettings.set("theme", "night");
  store.syncedSettings.set("zoom", 1.5);
  for (const k of kv.keys()) assert(k.startsWith("wp.defaultStore."), `键必须落命名空间根: ${k}`);
  eq(kv.get("wp.defaultStore.settings.theme"), "\"night\"", "localSettings 散键裸值");
  eq(kv.get("wp.defaultStore.settings.zoom"), "1.5", "syncedSettings 立即写散键裸值（首屏同步读）");
  eq(store.localSettings.get("theme"), "night");
  eq(store.syncedSettings.get("zoom"), 1.5);
});

test("[narrow-waist] databaseId：默认 defaultStore；不同 databaseId → 不同命名空间根（多实例不打架）", () => {
  const kvA = dumpKv(), kvB = dumpKv();
  mkStore(kvA).store.localSettings.set("x", 1);
  mkStore(kvB, createMockProvider(), "thumbs").store.localSettings.set("x", 2);
  assert(kvA.keys().every((k) => k.startsWith("wp.defaultStore.")), "默认根 wp.defaultStore");
  assert(kvB.keys().every((k) => k.startsWith("wp.thumbs.")), "自定义根 wp.thumbs");
});

test("[narrow-waist] collection 名：非法/斜杠/保留名 settings → 抛；合法名 OK", () => {
  const { store } = mkStore(dumpKv());
  for (const bad of ["", "a/b", "a:b", "..", "x*"]) {
    let t = false; try { store.collection(bad); } catch { t = true; }
    assert(t, `非法 collection 名应抛: ${JSON.stringify(bad)}`);
  }
  let r = false; try { store.collection("settings"); } catch { r = true; }
  assert(r, "保留名 settings 应抛（syncedSettings 占用）");
  store.collection("brush-rack"); store.collection("reading-state");   // 合法：不抛
});

// ── files / collections 两实例 etag 隔离 + collection 云端落 .wp/<name>.json ──────
test("[narrow-waist] file 与同名 collection 的 etag 落不同前缀（两实例隔离）+ collection 云端 = .wp/<name>.json", async () => {
  const kv = dumpKv();
  const { store, provider } = mkStore(kv);

  await store.file("dup.ora", { isZip: false }).save(new TextEncoder().encode("BYTES"));   // 文件推云
  const coll = store.collection<{ v: number }>("dup");
  coll.upsertItem({ id: "k", v: 1 });
  await coll.flush();                                                                        // collection 推云

  // 文件 etag 落 files.etag:；collection etag 落 collections.etag:（同名 dup，前缀隔离不撞）
  assert(kv.keys().some((k) => k.startsWith("wp.defaultStore.files.etag:")), "文件 etag 落 files.etag:");
  assert(kv.keys().some((k) => k === "wp.defaultStore.collections.etag:dup"), "collection etag 落 collections.etag:dup");
  // 文件 dirty 权威 = local-head 的 files.dirty:（推成功后清）；绝无 collections 前缀写文件
  assert(!kv.keys().some((k) => k.startsWith("wp.defaultStore.collections.etag:dup.ora")), "文件不该落 collections 前缀");

  // collection 云端落隐藏夹 .wp/dup.json（app 追加 .json）
  const item = await provider.getItemByPath(".wp/dup.json");
  assert(!!item, "collection 应落云端 .wp/dup.json");
  // 文件落根 dup.ora（不带 .json、不进 .wp）
  assert(!!(await provider.getItemByPath("dup.ora")), "文件落 approot 根 dup.ora");
});

// ── cloud-sync backupFolder 默认 .backup（weakOverride loser 落 .backup/）─────────
test("[narrow-waist] cloud-sync backupFolder 默认 .backup（weakOverride 把云端 loser stash 进 .backup/）", async () => {
  const provider = createMockProvider();
  provider._seed("z.ora", "OLD-CLOUD");
  const cloud = createCloudSync({ provider, kv: (() => { const d = dumpKv(); return d; })(), fileName: (n: string) => n });
  const res = await cloud.weakOverride("z.ora", new TextEncoder().encode("NEW-LOCAL"));
  assert(String(res.backedUp).startsWith(".backup/"), `loser 应进 .backup/，实得 ${res.backedUp}`);
});
