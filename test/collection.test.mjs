// collection 深模块验收。重点 = onChange 的语义：**本地写和云端写一视同仁**
//   （网盘模型；app 刻意分不出变更来源，见 collection.ts 头部）。
//   本地 setItem/deleteItem 同步 fire（不等 400ms IDB 防抖、不等云），远端 reconcile 照旧 fire。
import { describe, it, assert, eq } from "./runner.mjs";
import { createCollection } from "../src/store/collection.ts";

const blobOf = (s) => ({ text: async () => s });

// 最小 CloudSync 替身（collection 只用到这几个面；folder-flow 用 pull/push）。
function mockCloud({ text = null } = {}) {
  let stored = text, et = text == null ? null : "e0", n = 0;
  const dirty = new Map(), etags = new Map();
  return {
    pulls: 0, pushes: 0,
    pull: async function () { this.pulls++; return stored == null ? null : { blob: blobOf(stored), item: { eTag: et } }; },
    push: async function (_name, blob) { this.pushes++; stored = await blob.text(); et = "e" + (++n); return { item: { eTag: et } }; },
    fetchMeta: async () => (stored == null ? null : { etag: et, lastModified: 0, size: stored.length, item: {} }),
    setDirty: (nm, v) => dirty.set(nm, v),
    isDirty: (nm) => !!dirty.get(nm),
    setETag: (nm, v) => etags.set(nm, v),
    getETag: (nm) => etags.get(nm) ?? null,
    _stored: () => stored,
    _seedCloud: (obj, tag = "eX") => { stored = JSON.stringify(obj); et = tag; },
  };
}

// 纯本地变体：不碰云，专测本地写路径。
async function localColl(cloud = mockCloud()) {
  const c = createCollection({ cloud, name: "c.json", cloudless: true, now: () => 1000 });
  await c.init();
  return c;
}

describe("collection.onChange · 本地写", () => {
  it("setItem 同步 fire（不等防抖），changedIds 精确只带该 id", async () => {
    const c = await localColl();
    const seen = [];
    c.onChange((ids) => seen.push(ids));
    c.setItem("a", { v: 1 });
    eq(seen.length, 1, "同步 fire 一次（调用返回时就已经通知，没有 await）");
    eq(JSON.stringify(seen[0]), JSON.stringify(["a"]), "只带变的那个 id");
  });

  it("同值重写不 fire（避免无谓重算）", async () => {
    const c = await localColl();
    c.setItem("a", { v: 1 });
    let n = 0;
    c.onChange(() => n++);
    c.setItem("a", { v: 1 });
    eq(n, 0, "值没变 → 不通知");
    c.setItem("a", { v: 2 });
    eq(n, 1, "值变了 → 通知");
  });

  it("deleteItem（墓碑）也 fire", async () => {
    const c = await localColl();
    c.setItem("a", { v: 1 });
    const seen = [];
    c.onChange((ids) => seen.push(ids));
    c.deleteItem("a");
    eq(seen.length, 1, "删除通知");
    eq(seen[0][0], "a", "带被删的 id");
    eq(c.getItem("a"), undefined, "读面看不到墓碑");
  });

  it("onChange(id, cb) 单 key 绑定：本地写也只在该 key 变时触发", async () => {
    const c = await localColl();
    let a = 0;
    c.onChange("a", () => a++);
    c.setItem("b", 1);
    eq(a, 0, "别的 key 不触发");
    c.setItem("a", 1);
    eq(a, 1, "本 key 触发");
  });

  it("listener 内再 setItem → 不递归、合并成下一批（重入防线）", async () => {
    const c = await localColl();
    const batches = [];
    let depth = 0, maxDepth = 0;
    c.onChange((ids) => {
      depth++; maxDepth = Math.max(maxDepth, depth);
      batches.push([...ids]);
      if (ids.includes("a")) c.setItem("b", 99);   // 在通知里再写
      depth--;
    });
    c.setItem("a", 1);
    eq(maxDepth, 1, "★绝不递归进入（否则深度会 >1）");
    eq(batches.length, 2, "两批：先 a、再合并出的 b");
    eq(batches[1][0], "b", "第二批是重入写的 key");
    eq(c.getItem("b"), 99, "重入的写照样落进了内存");
  });

  it("退订后不再收到", async () => {
    const c = await localColl();
    let n = 0;
    const off = c.onChange(() => n++);
    c.setItem("a", 1);
    off();
    c.setItem("a", 2);
    eq(n, 1, "退订生效");
  });
});

describe("collection.onChange · 远端写（回归：语义没变）", () => {
  it("reconcileWithRemote 带来云端值变 → 照旧 fire", async () => {
    const cloud = mockCloud();
    cloud._seedCloud({ version: 2, items: [{ id: "k", uat: 9999, value: { from: "cloud" } }] });
    const c = createCollection({ cloud, name: "c.json", now: () => 1000 });
    await c.init();
    const seen = [];
    c.onChange((ids) => seen.push(ids));
    await c.reconcileWithRemote();
    assert(seen.some((ids) => ids.includes("k")), "云端来的值变照样通知");
    eq(JSON.stringify(c.getItem("k")), JSON.stringify({ from: "cloud" }), "值已并入");
  });
});

describe("collection · getInitData seed 的 LWW（SEED_UAT=1 最低戳）", () => {
  it("云端有真实 uat 的改过版 → reconcile 后云端赢，seed 不复活", async () => {
    const cloud = mockCloud();
    // 云端：同 id 但 uat 是真实时钟（远大于 SEED_UAT=1），value 是用户改过的
    cloud._seedCloud({ version: 2, items: [{ id: "b1", uat: 1750000000000, value: { name: "我改过的笔" } }] });
    const c = createCollection({
      cloud, name: "rack.json", now: () => 1750000001000,
      getInitData: () => [{ id: "b1", value: { name: "出厂笔" } }],
    });
    await c.init();                       // eager seed：先填 uat=1 的出厂笔
    eq(c.getItem("b1").name, "出厂笔", "离线/云端未到时先显 seed");
    await c.reconcileWithRemote();
    eq(c.getItem("b1").name, "我改过的笔", "★云端真数据（uat 大）必胜 seed");
    eq(c.getEntry("b1").uat, 1750000000000, "uat 也是云端那个，seed 戳没留下");
  });

  it("未登录/离线（cloudless）→ 照样拿到出厂笔，且不 clobber 云端", async () => {
    const cloud = mockCloud();
    const c = createCollection({
      cloud, name: "rack.json", cloudless: true, now: () => 1000,
      getInitData: () => [{ id: "b1", value: { name: "出厂笔" } }],
    });
    await c.init();
    eq(c.getItem("b1").name, "出厂笔", "离线新设备立即有内容");
    eq(cloud.pushes, 0, "★cloudless 绝不碰云（不会把 seed 推上去盖掉云端真数据）");
    eq(cloud.pulls, 0, "也不拉");
  });

  it("云端确实空 → seed 留着（不被误当成「云端赢」抹掉）", async () => {
    const cloud = mockCloud();     // stored=null = 云端没这文件
    const c = createCollection({
      cloud, name: "rack.json", now: () => 1000,
      getInitData: () => [{ id: "b1", value: { name: "出厂笔" } }],
    });
    await c.init();
    await c.reconcileWithRemote();
    eq(c.getItem("b1").name, "出厂笔", "云端空 → seed 存活");
  });
});
