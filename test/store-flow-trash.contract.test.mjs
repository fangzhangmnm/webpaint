// Store.flow.delete / replayDelete / restore / purge（C5）验收，跑在 MockCloudProvider + MockLocal 上。
import { describe, it, assert, eq } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.js";
import { createMockLocal } from "../src/store/mock-local.js";
import { createStore } from "../src/store/store.js";
import { memLS, graphFromProvider } from "./helpers.mjs";

globalThis.localStorage = globalThis.localStorage || memLS();
const cloud = await import("../src/cloud.js");
const fastSleep = () => Promise.resolve();
const enc = (s) => () => new TextEncoder().encode(s);
const yes = async () => true;
const no = async () => false;

function fresh() {
  globalThis.localStorage.clear();
  const mock = createMockProvider();
  cloud.__setGraph(graphFromProvider(mock));
  cloud.__setSignedIn(() => true);
  const local = createMockLocal();
  const store = createStore({ cloud, local, sleep: fastSleep, backoffMs: 0 });
  return { mock, local, store };
}
async function seedCloud(store, name, s) { await store.flow.push(name, { encode: enc(s) }); }

describe("flow.delete：护栏 + 三态决策", () => {
  it("confirm 拒绝 → cancelled，本地云端都不动", async () => {
    const { mock, local, store } = fresh();
    await seedCloud(store, "画", "v1");
    await local.save("画", new TextEncoder().encode("v1"));
    const r = await store.flow.delete("画", { confirm: no });
    eq(r.status, "cancelled");
    assert(await mock.getItemByPath("画.ora"), "云端还在");
    assert(await local.exists("画"), "本地还在");
  });

  it("仅本地（云端无）→ 本地 move-aside，不碰云", async () => {
    const { local, store } = fresh();
    await local.save("草稿", new TextEncoder().encode("x"));
    const r = await store.flow.delete("草稿", { confirm: yes });
    eq(r.status, "trashed"); eq(r.where, "local");
    eq(await local.exists("草稿"), false, "已移出");
    eq(local._trash.size, 1, "进了本地 trash");
  });

  it("仅云端（无本地）→ 云端进 .trash", async () => {
    const { mock, store } = fresh();
    await seedCloud(store, "画", "v1");
    const r = await store.flow.delete("画", { confirm: yes });
    eq(r.where, "cloud");
    eq(await mock.getItemByPath("画.ora"), null);
    eq((await mock.list(".trash")).length, 1);
  });

  it("本地+云端 → 云端进 .trash + 本地直接删（不留双份）", async () => {
    const { mock, local, store } = fresh();
    await seedCloud(store, "画", "v1");
    await local.save("画", new TextEncoder().encode("v1"));
    const r = await store.flow.delete("画", { confirm: yes });
    eq(r.where, "cloud");
    eq((await mock.list(".trash")).length, 1, "云端一份 trash");
    eq(await local.exists("画"), false, "本地已删");
    eq(local._trash.size, 0, "本地不进 trash（不留双份）");
  });

  it("C3：删 cloud-dirty 项 + onDirtyWarn 拒绝 → cancelled", async () => {
    const { store } = fresh();
    cloud.setCloudDirty("画", true);
    let warned = false;
    const r = await store.flow.delete("画", { confirm: yes, onDirtyWarn: async () => { warned = true; return false; } });
    eq(warned, true); eq(r.status, "cancelled");
  });

  it("数据安全：云端进 trash 失败 → 抛错，本地绝不删", async () => {
    const { mock, local, store } = fresh();
    await seedCloud(store, "画", "v1");
    await local.save("画", new TextEncoder().encode("v1"));
    mock.injectFault({ op: "move", kind: "error", status: 500 });
    let threw = false;
    try { await store.flow.delete("画", { confirm: yes }); } catch (_) { threw = true; }
    eq(threw, true);
    assert(await local.exists("画"), "本地绝不在云端 trash 失败时删");
    assert(await mock.getItemByPath("画.ora"), "云端原文件仍在");
  });

  it("离线 → 本地 move-aside + 排队云删（带 base-etag），不碰云", async () => {
    const { mock, local, store } = fresh();
    await seedCloud(store, "画", "v1");
    await local.save("画", new TextEncoder().encode("v1"));
    const r = await store.flow.delete("画", { isOnline: () => false, confirm: yes });
    eq(r.where, "local"); eq(r.queuedCloudDelete, true);
    assert(r.baseEtag, "带 base-etag 供重连重放");
    assert(r.trashKey, "本地 trashKey");
    assert(await mock.getItemByPath("画.ora"), "离线没碰云");
    eq(await local.exists("画"), false, "本地已 move-aside");
  });
});

describe("flow.replayDelete：离线删除重连收敛（C7）", () => {
  it("云端没动 → 进 trash（收敛）", async () => {
    const { mock, store } = fresh();
    await seedCloud(store, "画", "v1");
    const r = await store.flow.replayDelete("画", { baseEtag: cloud.getKnownETag("画") });
    eq(r.status, "trashed");
    eq(await mock.getItemByPath("画.ora"), null);
  });

  it("云端已被删 → 静默收敛", async () => {
    const { store } = fresh();
    const r = await store.flow.replayDelete("不存在", { baseEtag: "etag-x" });
    eq(r.status, "converged"); eq(r.reason, "already-gone");
  });

  it("云端被别处改过 → edit-wins 不删", async () => {
    const { mock, store } = fresh();
    await seedCloud(store, "画", "v1");
    const base = cloud.getKnownETag("画");
    await mock.upload("画.ora", "edited", {});
    const r = await store.flow.replayDelete("画", { baseEtag: base });
    eq(r.status, "conflict-edit-wins");
    assert(await mock.getItemByPath("画.ora"), "不删，留给用户");
  });
});

describe("flow.restore / purge", () => {
  it("云端 restore 撞名 → 自动落 (2)", async () => {
    const { store } = fresh();
    await seedCloud(store, "画", "v1");
    const trashed = await cloud.trashCloudSession("画");
    await seedCloud(store, "画", "occupied");
    const r = await store.flow.restore({ fromCloud: true, cloudItemId: trashed.id, targetName: "画" });
    eq(r.status, "restored"); eq(r.item.path, "画 (2).ora");
  });

  it("本地 restore → 从本地 trash 拿回", async () => {
    const { local, store } = fresh();
    await local.save("草稿", new TextEncoder().encode("x"));
    const tk = await local.trash("草稿");
    const r = await store.flow.restore({ trashKey: tk });
    eq(r.status, "restored"); eq(r.where, "local"); eq(r.name, "草稿");
    assert(await local.exists("草稿"));
  });

  it("purge confirm 拒绝 → cancelled；接受 → 永久删", async () => {
    const { mock, store } = fresh();
    await seedCloud(store, "画", "v1");
    const trashed = await cloud.trashCloudSession("画");
    eq((await store.flow.purge(trashed.id, { confirm: no })).status, "cancelled");
    eq((await mock.list(".trash")).length, 1);
    eq((await store.flow.purge(trashed.id, { confirm: yes })).status, "purged");
    eq((await mock.list(".trash")).length, 0);
  });
});
