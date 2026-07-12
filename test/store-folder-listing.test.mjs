// Per-folder 列举 / cloud-gone / watchFolder（网盘模型，2026-07-11）——红线覆盖。
//   sync-store 引擎在 WebPaint 侧此前零 node 覆盖（audit C10）；本文件补 per-folder 路径 + 数据安全 guardrail。
// 验：
//   · listing.listFolder：只列**该夹直属**子项、子夹从 nested-local/cloud/pending 派生；**别夹 local key 绝不进本夹**（guardrail #1）。
//   · reconcile.reconcileFolder：本夹 clean 孤儿→demote；**别夹 clean 文件绝不被本次降级**（身份=path 不跨夹追踪）；dirty 孤儿留（ghost）；非 complete→no-op。
//   · watchFolder：立即本地帧 + 云端帧、snapshot.path===订阅 path、本夹写即时重画、订阅 A 绝不收到 B 的文件。
import { describe, it, assert, eq } from "./runner.mjs";
import { createListing } from "../src/store/listing.ts";
import { createReconcile } from "../src/store/reconcile.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { createStore } from "../src/store/create-store.ts";

const CTX_ON = { signedIn: true, online: true };
const bytes = (s) => new TextEncoder().encode(s);

// ── listing.listFolder（单夹、非递归、直属 scope）───────────────────────────────────────
describe("listing.listFolder · 单夹直属 scope + 子夹派生", () => {
  function mk(cloudFolderRes, appKeys, seen = {}, dirty = new Set(), pending = []) {
    const cloud = {
      async listFolder() { return cloudFolderRes; },
      async listAll() { return { files: [], folders: [], complete: true }; },
      getETag: () => null,
    };
    const local = { async appKeys() { return appKeys; } };
    const head = { seenBase: (n) => (n in seen ? seen[n] : null), isDirty: (n) => dirty.has(n) };
    return createListing({ cloud, local, head, pendingFolders: () => pending });
  }

  it("只返回本夹直属文件；别夹 local key 绝不进本夹（guardrail）", async () => {
    const listing = mk(
      { files: [{ path: "A/foo", eTag: "e1", size: 3 }], folders: ["A/cloudsub"], complete: true },
      ["A/foo", "A/deep/x", "B/other"],          // A/deep/x → 子夹 A/deep；B/other → 别夹，必须不出现
      { "A/foo": "e1" },
    );
    const snap = await listing.listFolder("A", CTX_ON);
    eq(snap.path, "A");
    eq(snap.items.length, 1, "只 A/foo 一个直属文件");
    eq(snap.items[0].path, "A/foo");
    eq(snap.items[0].syncState, "synced", "本地+云同 etag → synced");
    assert(!snap.items.some((i) => i.path === "B/other"), "别夹文件绝不进列表");
    assert(snap.folders.includes("A/cloudsub"), "云端子夹");
    assert(snap.folders.includes("A/deep"), "nested local key 派生的子夹");
    assert(!snap.folders.some((f) => f.startsWith("B")), "别夹子夹不出现");
  });

  it("离线视角（cloud 不可达）→ 纯本地 union、绝不空", async () => {
    const listing = mk({ files: [], folders: [], complete: true }, ["A/foo"], {}, new Set(["A/foo"]));
    const snap = await listing.listFolder("A", { signedIn: false, online: false });
    eq(snap.complete, false, "离线 → 不权威");
    eq(snap.items.length, 1);
    eq(snap.items[0].syncState, "float", "从没 synced + dirty + 云不可达 → float");
  });

  it("根目录 folder=''：nested local + pending 都算 immediate 子夹", async () => {
    const listing = mk(
      { files: [{ path: "top", eTag: "e", size: 1 }], folders: [], complete: true },
      ["top", "P/inside"], { top: "e" }, new Set(), ["Q"],
    );
    const snap = await listing.listFolder("", CTX_ON);
    eq(snap.items.length, 1, "只 top 一个直属文件");
    assert(snap.folders.includes("P"), "nested local → 子夹 P");
    assert(snap.folders.includes("Q"), "pending 空夹 Q");
  });
});

// ── reconcile.reconcileFolder（per-folder cloud-gone + 数据安全 guardrail）──────────────────
describe("reconcile.reconcileFolder · per-folder cloud-gone guardrail", () => {
  function mk(cloudFolderRes, appKeys, seen, dirty = new Set(), online = true) {
    const cleared = [], forgot = [];
    const cloud = {
      async listAll() { return { files: [], folders: [], complete: true }; },
      async listFolder() { return cloudFolderRes; },
      clearState: (n) => cleared.push(n),
    };
    const local = { async appKeys() { return appKeys; } };
    const head = {
      seenBase: (n) => (n in seen ? seen[n] : null),
      isDirty: (n) => dirty.has(n),
      forget: (n) => forgot.push(n),
    };
    return { rec: createReconcile({ cloud, local, head, isOnline: () => online }), cleared, forgot };
  }

  it("本夹 clean 孤儿→demote；别夹 clean 文件绝不被降级（不跨夹追踪）；dirty 孤儿留", async () => {
    const { rec, cleared, forgot } = mk(
      { files: [{ path: "A/keep", eTag: "e" }], folders: [], complete: true },
      ["A/keep", "A/goneClean", "A/goneDirty", "B/goneClean"],
      { "A/keep": "e", "A/goneClean": "old", "A/goneDirty": "old", "B/goneClean": "old" },
      new Set(["A/goneDirty"]),
    );
    const { demoted } = await rec.reconcileFolder("A");
    eq(demoted.length, 1, "只降级一个");
    eq(demoted[0], "A/goneClean");
    assert(cleared.includes("A/goneClean") && forgot.includes("A/goneClean"), "清两条 etag 轨道");
    assert(!cleared.includes("B/goneClean") && !forgot.includes("B/goneClean"), "★别夹 clean 文件绝不被本次降级（guardrail）");
    assert(!demoted.includes("A/goneDirty"), "dirty 孤儿留（ghost，绝不删）");
  });

  it("这一夹没列全（complete:false）→ no-op，绝不据此判 gone", async () => {
    const { rec, cleared } = mk(
      { files: [], folders: [], complete: false },
      ["A/x"], { "A/x": "old" },
    );
    const { demoted } = await rec.reconcileFolder("A");
    eq(demoted.length, 0);
    eq(cleared.length, 0, "不权威 → 一个都不清");
  });

  it("离线 → no-op；从没 synced（seenBase=null）→ 永不碰", async () => {
    const { rec: recOff } = mk({ files: [], folders: [], complete: true }, ["A/x"], { "A/x": "e" }, new Set(), false);
    eq((await recOff.reconcileFolder("A")).demoted.length, 0, "离线 no-op");
    const { rec, cleared } = mk(
      { files: [], folders: [], complete: true },
      ["A/newLocal"], {},   // seenBase=null → 真本地新文件
    );
    eq((await rec.reconcileFolder("A")).demoted.length, 0, "从没 synced 不降级");
    eq(cleared.length, 0);
  });
});

// ── cloud-sync.listFolder（真 cloud-sync over mock provider，非递归 + .trash/.backup 跳过）──
describe("cloud-sync.listFolder · 非递归 + 顶层安全网跳过", () => {
  it("只返回直属文件+子夹；根跳过 .trash/.backup；子夹列全", async () => {
    const provider = createMockProvider();
    const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n) => n });
    await cloud.push("root1", bytes("a"));
    await cloud.push("A/foo", bytes("b"));
    await cloud.push("A/sub/deep", bytes("c"));
    await provider.ensureFolder(".trash");
    await provider.ensureFolder(".backup");

    const root = await cloud.listFolder("");
    eq(root.complete, true);
    assert(root.files.some((f) => f.path === "root1"), "根直属文件");
    assert(!root.files.some((f) => f.path === "A/foo"), "非递归：不含深层文件");
    assert(root.folders.includes("A"), "子夹 A");
    assert(!root.folders.includes(".trash") && !root.folders.includes(".backup"), "顶层 .trash/.backup 跳过");

    const a = await cloud.listFolder("A");
    assert(a.files.some((f) => f.path === "A/foo"), "A 直属文件");
    assert(a.folders.includes("A/sub"), "A 的子夹");
    assert(!a.files.some((f) => f.path === "A/sub/deep"), "非递归");
  });

  it("不存在的夹 → complete:false（list 抛错被吞），绝不 throw", async () => {
    const provider = createMockProvider();
    const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n) => n });
    const r = await cloud.listFolder("nope");
    eq(r.complete, false);
    eq(r.files.length, 0);
  });
});

// ── watchFolder（真 createStore + mock；两帧节律 + path 契约 + 本夹写即时重画 + 夹隔离）────────
describe("watchFolder · 网盘模型集成", () => {
  function mkStore({ online = true, signedIn = true } = {}) {
    const errors = [];
    const store = createStore({
      provider: createMockProvider(),
      ui: { busy: (_l, fn) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: (e) => errors.push(e) },
      validateAdopt: () => true,
      kv: memKv(), local: createMockLocal(),
      isOnline: () => online, signedIn: () => signedIn,
      skipMigration: true,
    });
    return { store, errors };
  }
  const raw = (store, name) => store.file(name, { isZip: false });

  it("订阅立即回本地帧、snapshot.path===订阅 path、绝不空/throw", async () => {
    const { store } = mkStore({ online: false });   // 离线：只走本地帧，不碰云
    await raw(store, "A/foo").save(bytes("x"), { tryPush: false });
    const snaps = [];
    const unsub = await new Promise((resolve) => {
      const u = store.watchFolder("A", (s) => { snaps.push(s); if (snaps.length === 1) resolve(u); });
    });
    assert(snaps.length >= 1, "至少一帧");
    eq(snaps[0].path, "A", "snapshot 带订阅 path");
    assert(snaps[0].items.some((i) => i.path === "A/foo"), "本地文件即在首帧");
    unsub();
  });

  it("本夹保存 → watcher 即时重画（notifyFolderOf）", async () => {
    const { store } = mkStore({ online: false });
    let last = null, calls = 0;
    const unsub = store.watchFolder("A", (s) => { last = s; calls++; });
    await new Promise((r) => setTimeout(r, 5));   // 放过订阅两帧
    const before = calls;
    await raw(store, "A/bar").save(bytes("y"), { tryPush: false });
    await new Promise((r) => setTimeout(r, 5));
    assert(calls > before, "保存后 cb 再次触发");
    assert(last.items.some((i) => i.path === "A/bar"), "新文件反映进快照");
    unsub();
  });

  it("订阅 A 绝不收到 B 的文件（夹隔离）", async () => {
    const { store } = mkStore({ online: false });
    await raw(store, "A/inA").save(bytes("a"), { tryPush: false });
    await raw(store, "B/inB").save(bytes("b"), { tryPush: false });
    let last = null;
    const unsub = store.watchFolder("A", (s) => { last = s; });
    await new Promise((r) => setTimeout(r, 5));
    assert(last.items.some((i) => i.path === "A/inA"), "A 的文件在");
    assert(!last.items.some((i) => i.path === "B/inB"), "★B 的文件绝不出现在 A 的快照");
    unsub();
  });

  it("unsubscribe 后不再收帧", async () => {
    const { store } = mkStore({ online: false });
    let calls = 0;
    const unsub = store.watchFolder("A", () => { calls++; });
    await new Promise((r) => setTimeout(r, 5));
    unsub();
    const after = calls;
    await raw(store, "A/z").save(bytes("z"), { tryPush: false });
    await new Promise((r) => setTimeout(r, 5));
    eq(calls, after, "退订后写入不再回调");
  });
});
