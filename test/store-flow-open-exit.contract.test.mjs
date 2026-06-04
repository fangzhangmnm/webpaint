// Store.flow.openSession（C2）+ exitSession（C3）验收，跑在 MockCloudProvider + MockLocal 上。
import { describe, it, assert, eq } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.js";
import { createMockLocal } from "../src/store/mock-local.js";
import { createStore } from "../src/store/store.js";
import { memLS, graphFromProvider } from "./helpers.mjs";

globalThis.localStorage = globalThis.localStorage || memLS();
const cloud = await import("../src/cloud.js");
const fastSleep = () => Promise.resolve();
const dec = (u8) => new TextDecoder().decode(u8);
const enc = (s) => () => new TextEncoder().encode(s);

function fresh(hook) {
  globalThis.localStorage.clear();
  const mock = createMockProvider(hook ? { hook } : {});
  cloud.__setGraph(graphFromProvider(mock));
  cloud.__setSignedIn(() => true);
  const local = createMockLocal();
  const store = createStore({ cloud, local, sleep: fastSleep, backoffMs: 0 });
  return { mock, local, store };
}
// 同时种到云（建立 base etag）+ 本地
async function seed(store, local, name, s) {
  await store.flow.push(name, { encode: enc(s) });
  await local.save(name, new TextEncoder().encode(s));
}

describe("openSession：云端 gate 决策", () => {
  it("etag 一致 → 开本地（in-sync），不问 onNewer", async () => {
    const { store, local } = fresh();
    await seed(store, local, "画", "v1");
    let asked = false;
    const r = await store.flow.openSession("画", { onNewer: async () => { asked = true; return "pull"; } });
    eq(r.source, "local"); eq(r.reason, "in-sync"); eq(asked, false);
  });

  it("云端没有 → cloud-absent", async () => {
    const { store } = fresh();
    const r = await store.flow.openSession("新画", {});
    eq(r.source, "local"); eq(r.reason, "cloud-absent");
  });

  it("离线 → 本地，不碰云", async () => {
    const { store } = fresh();
    const r = await store.flow.openSession("画", { isOnline: () => false });
    eq(r.source, "local"); eq(r.reason, "offline");
  });

  it("E8：慢网『跳过到离线』即用本地，无硬超时", async () => {
    let release;
    const stuck = new Promise((r) => { release = r; });
    const { store } = fresh(async (op) => { if (op === "getItemByPath") await stuck; });
    const r = await store.flow.openSession("画", { probe: Promise.resolve() });
    eq(r.source, "local"); eq(r.reason, "skipped");
    release();
  });

  it("云端更新 + pull → 先备份本地、覆盖本地为云端版、adopt", async () => {
    const { mock, local, store } = fresh();
    await seed(store, local, "画", "v1");
    await mock.upload("画.ora", "cloud-newer", {});      // 别处推新版本，etag 变
    let adopted = null;
    const r = await store.flow.openSession("画", {
      onNewer: async () => "pull",
      adopt: async (blob) => { adopted = dec(new Uint8Array(await blob.arrayBuffer())); },
    });
    eq(r.source, "pulled");
    eq(r.backupName, "画-backup");
    eq(dec(await local.get("画-backup")), "v1", "原版备份保留");
    eq(dec(await local.get("画")), "cloud-newer", "本地已覆盖为云端版");
    eq(adopted, "cloud-newer", "adopt 收到云端字节");
  });

  it("pull 但本地无法备份 → abort，绝不拉、绝不覆盖（A4/A10）", async () => {
    const { mock, store } = fresh();
    // 只种云、不种本地 → local.backup 抛
    await store.flow.push("画", { encode: enc("v1") });
    await mock.upload("画.ora", "cloud-newer", {});
    let adopted = false;
    const r = await store.flow.openSession("画", {
      onNewer: async () => "pull",
      adopt: async () => { adopted = true; },
    });
    eq(r.source, "local"); eq(r.reason, "backup-failed");
    eq(adopted, false, "绝不覆盖/adopt");
    eq(dec(new Uint8Array(await (await mock.download((await mock.getItemByPath("画.ora")).id)).arrayBuffer())), "cloud-newer", "云端未变");
  });

  it("云端更新 + keep → 保留本地不覆盖", async () => {
    const { mock, local, store } = fresh();
    await seed(store, local, "画", "v1");
    await mock.upload("画.ora", "cloud-newer", {});
    const r = await store.flow.openSession("画", { onNewer: async () => "keep" });
    eq(r.reason, "kept");
    eq(dec(await local.get("画")), "v1", "本地没被动");
  });

  it("云端更新 + branch → 云端另存为副本", async () => {
    const { mock, local, store } = fresh();
    await seed(store, local, "画", "v1");
    await mock.upload("画.ora", "cloud-newer", {});
    const r = await store.flow.openSession("画", { onNewer: async () => "branch", now: () => 12345 });
    eq(r.source, "branched"); eq(r.branchName, "画-cloud-12345");
    eq(dec(await local.get("画-cloud-12345")), "cloud-newer");
    eq(dec(await local.get("画")), "v1", "原作不动");
  });

  it("#2 等冲突回调时强退 → 无持久副作用，重入仍检测分歧", async () => {
    const { mock, local, store } = fresh();
    await seed(store, local, "画", "v1");
    await mock.upload("画.ora", "other", {});            // 云端分歧
    const baseBefore = cloud.getKnownETag("画");
    // 模拟强退：onNewer 永不 resolve，丢弃这个 flow
    let hung;
    void store.flow.openSession("画", {
      onNewer: () => new Promise((r) => { hung = r; }),
      adopt: async () => { throw new Error("不该 adopt"); },
    });
    await new Promise((r) => setTimeout(r, 0));
    eq(dec(await local.get("画")), "v1", "本地未被改");
    eq(cloud.getKnownETag("画"), baseBefore, "base-etag 未改");
    eq(await local.exists("画-backup"), false, "未生成备份");
    // 重入：新 store 同持久态 → 仍检测到分歧
    const store2 = createStore({ cloud, local, sleep: fastSleep, backoffMs: 0 });
    let reasked = false;
    const r2 = await store2.flow.openSession("画", { onNewer: async () => { reasked = true; return "keep"; } });
    eq(reasked, true, "重入再次问 onNewer");
    eq(r2.reason, "kept");
    if (hung) hung("keep");
  });
});

describe("exitSession：consent push + H3 先存后清", () => {
  it("正常退出 → flush(本地落地) 在 push 之前、pushed、可清 active", async () => {
    globalThis.localStorage.clear();
    const order = [];
    const local = createMockLocal();
    const origSave = local.save.bind(local);
    local.save = async (n, b) => { order.push("save:" + n); return origSave(n, b); };
    const mock = createMockProvider({ hook: async (op) => { if (op === "upload") order.push("upload"); } });
    cloud.__setGraph(graphFromProvider(mock));
    cloud.__setSignedIn(() => true);
    const store = createStore({ cloud, local, sleep: fastSleep, backoffMs: 0 });

    const r = await store.flow.exitSession("画", { encode: enc("v1") });
    eq(r.status, "pushed"); eq(r.canClearActive, true);
    eq(order[0], "save:画", "flush 必须先于 push（H3）");
    assert(order.includes("upload"));
    eq(dec(await local.get("画")), "v1", "本地已落地");
  });

  it("退出撞真冲突 → 不清 active", async () => {
    const { mock, local, store } = fresh();
    await seed(store, local, "画", "v1");
    await mock.upload("画.ora", "OTHER", {});
    const r = await store.flow.exitSession("画", { encode: enc("v2"), onConflict: async () => "keep" });
    eq(r.status, "conflict"); eq(r.canClearActive, false);
  });

  it("退出撞 PUT 期间落键 → dirtyAfter → 不清 active", async () => {
    globalThis.localStorage.clear();
    let ver = 0;
    const local = createMockLocal();
    const mock = createMockProvider({ hook: async (op) => { if (op === "upload") ver++; } });
    cloud.__setGraph(graphFromProvider(mock));
    cloud.__setSignedIn(() => true);
    const store = createStore({ cloud, local, sleep: fastSleep, backoffMs: 0 });
    const r = await store.flow.exitSession("画", { encode: enc("v1"), getEditVersion: () => ver });
    eq(r.dirtyAfter, true); eq(r.canClearActive, false);
  });

  it("离线（重试耗尽）→ deferred，允许退出（E4）", async () => {
    globalThis.localStorage.clear();
    const local = createMockLocal();
    const mock = createMockProvider();
    cloud.__setGraph(graphFromProvider(mock));
    cloud.__setSignedIn(() => true);
    const store = createStore({ cloud, local, sleep: fastSleep, backoffMs: 0, maxAttempts: 2 });
    mock.injectFault({ op: "upload", kind: "error", status: 503, times: 9 });
    const r = await store.flow.exitSession("画", { encode: enc("v1") });
    eq(r.status, "deferred"); eq(r.canClearActive, true); eq(r.queued, true);
    eq(dec(await local.get("画")), "v1", "本地仍已落地（flush 在 push 之前）");
  });
});
