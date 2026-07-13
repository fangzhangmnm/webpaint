// 笔架 → store.collection 后端（brush-rack-store.ts）验收：真实 createCollection + 内存 cloud 往返。
//   覆盖：一次性 IDB 迁移 / 全新种子 / seedGen 幂等 / **跨设备删除不复活**（tombstone 不可见的取舍靠 seedGen 守）/
//         order 保序 / reconcile 逐 item 持久化 / 跨设备 per-item 合并。
import { describe, it, assert, eq } from "./runner.mjs";
import { createCollection } from "../src/store/collection.ts";
import { createRackStore, RACK_SEED_GEN } from "../src/brush-rack-store.ts";

// ── 内存 cloud：共享 blob 存储（authoritative etag）+ 每设备本地 dirty/etag 记账 ─────────────
function makeSharedCloud() {
  const store = new Map();   // name -> { text, etag }
  let etagSeq = 1;
  return {
    store,
    // 一个"设备"视角的 CloudSync 子集（folder-flow + collection 用到的面）。
    device() {
      const dirty = new Map();
      const etag = new Map();   // 本设备"我手上是哪版"
      const toText = (bytes) => (typeof bytes === "string" ? bytes
        : bytes instanceof Uint8Array ? new TextDecoder().decode(bytes)
        : String(bytes));
      return {
        isDirty: (n) => dirty.get(n) === true,
        setDirty: (n, v) => dirty.set(n, !!v),
        getETag: (n) => etag.get(n) ?? null,
        setETag: (n, e) => etag.set(n, e),
        fetchMeta: async (n) => { const r = store.get(n); return r ? { etag: r.etag } : null; },
        pull: async (n) => {
          const r = store.get(n);
          if (!r) return null;
          return { blob: { text: async () => r.text }, item: { eTag: r.etag } };
        },
        push: async (n, bytes, opts = {}) => {
          const r = store.get(n);
          const base = opts.baseEtag ?? null;
          if (r && base !== r.etag) {
            const err = Object.assign(new Error("conflict"), { name: "CloudConflictError", status: 412 });
            throw err;
          }
          const e = "etag-" + (etagSeq++);
          store.set(n, { text: toText(bytes), etag: e });
          return { item: { eTag: e } };
        },
      };
    },
  };
}

const NAME = ".webpaint/brush-rack.json";
let clock = 1000;
function mkColl(cloud) {
  clock = 1000;
  return createCollection({ cloud, name: NAME, isOnline: () => true, manual: true, now: () => ++clock });
}
// 老 schema 笔（无 order/uat，含已撤字段 airbrush/opacity）——测迁移。
const legacyRack = () => ({ version: 1, brushes: [
  { id: "u1", name: "我的水彩", tool: "brush", airbrush: true, opacity: 0.5 },
  { id: "u2", name: "我的橡皮", tool: "eraser" },
] });
const defaults = () => [
  { id: "default-brush-a", name: "默认A", tool: "brush", size: { base: 12 }, order: 0 },
  { id: "default-brush-b", name: "默认B", tool: "brush", size: { base: 20 }, order: 1 },
];

describe("brush-rack-store · 一次性 IDB 迁移", () => {
  it("collection 空 + 有老 IDB rack → 逐笔迁移进 collection（补 order，修老字段，uat 交给 collection）", async () => {
    const shared = makeSharedCloud();
    const rs = createRackStore(mkColl(shared.device()), async () => legacyRack());
    const brushes = await rs.init();
    eq(brushes.length, 2);
    eq(brushes[0].id, "u1"); eq(brushes[0].order, 0);
    eq(brushes[1].id, "u2"); eq(brushes[1].order, 1);
    // uat 由 collection 当保留 envelope 键接管（读回 strip）→ 笔的 payload 不再带 uat。
    assert(!("uat" in brushes[0]), "collection 接管合并键 → brush.uat 读回应被 strip");
    assert(!("airbrush" in brushes[0]), "migrateBrush 应删 airbrush");
    assert(!("opacity" in brushes[0]), "migrateBrush 应删 opacity");
  });

  it("已迁移过（另一设备）→ 第二个 store 从云端看到笔，不重复迁移", async () => {
    const shared = makeSharedCloud();
    const rsA = createRackStore(mkColl(shared.device()), async () => legacyRack());
    await rsA.init();
    await rsA.syncCloud();   // 推上云
    // 设备 B：legacy reader 返回**别的**数据；应无视（collection 非空 → 不迁移）
    const rsB = createRackStore(mkColl(shared.device()), async () => ({ brushes: [{ id: "zzz", name: "x", tool: "brush" }] }));
    const b = await rsB.init();
    eq(b.length, 2);
    assert(!b.some((x) => x.id === "zzz"), "B 不该迁移自己的老 IDB（collection 已有数据）");
  });
});

describe("brush-rack-store · 默认笔种子 + seedGen", () => {
  it("全新（无 IDB）→ init 种 emergency 占位；seedDefaults 补真默认笔并清 emergency", async () => {
    const shared = makeSharedCloud();
    const rs = createRackStore(mkColl(shared.device()), async () => null);
    const afterInit = await rs.init();
    assert(afterInit.some((b) => b.id === "emergency-brush"), "fetch 未回时 init 应种 emergency 占位");
    const seeded = rs.seedDefaults(defaults());
    assert(seeded, "seedDefaults 应返回新架");
    eq(seeded.length, 2);
    assert(!seeded.some((b) => b.id === "emergency-brush"), "真默认笔到位后应清掉 emergency");
    eq(seeded.map((b) => b.id).join(","), "default-brush-a,default-brush-b");
  });

  it("seedGen 已当前 → seedDefaults no-op（幂等）", async () => {
    const shared = makeSharedCloud();
    const rs = createRackStore(mkColl(shared.device()), async () => null);
    await rs.init();
    rs.seedDefaults(defaults());
    eq(rs.seedDefaults(defaults()), null);   // 第二次 no-op
  });
});

describe("brush-rack-store · 跨设备删除不复活（seedGen 守，tombstone 不可见）", () => {
  it("A 种默认笔+删一支+同步；B 新设备 init+seedDefaults → 删掉的默认笔不复活", async () => {
    const shared = makeSharedCloud();
    const rsA = createRackStore(mkColl(shared.device()), async () => null);
    await rsA.init();
    const seeded = rsA.seedDefaults(defaults());     // A 有 a,b
    // A 删掉 default-brush-a（reconcile 去掉它 → collection deleteItem→tombstone）
    rsA.reconcile(seeded.filter((b) => b.id !== "default-brush-a"));
    await rsA.syncCloud();
    // 设备 B：全新 init（从云端拉到 b + tombstone(a) + meta gen=1）
    const rsB = createRackStore(mkColl(shared.device()), async () => null);
    const bInit = await rsB.init();
    eq(bInit.map((x) => x.id).sort().join(","), "default-brush-b");
    // B 也调 seedDefaults（boot 一定会调）——gen 已是当前 → 不复活 a
    eq(rsB.seedDefaults(defaults()), null);
    const bAfter = await rsB.syncCloud();
    eq(bAfter.map((x) => x.id).sort().join(","), "default-brush-b");
  });
});

describe("brush-rack-store · reconcile 持久化 + order 保序 + 跨设备合并", () => {
  it("reconcile 新增/改/删逐 item 落 collection；list 按 order 排", async () => {
    const shared = makeSharedCloud();
    const rs = createRackStore(mkColl(shared.device()), async () => null);
    await rs.init();
    const list = rs.seedDefaults(defaults());
    // 改 b 名字 + 加一支新笔（order 接末尾）+ 删 a
    const edited = list.map((b) => b.id === "default-brush-b" ? { ...b, name: "改过的B" } : b)
      .filter((b) => b.id !== "default-brush-a")
      .concat([{ id: "new1", name: "新笔", tool: "brush", size: { base: 8 }, order: 5 }]);
    rs.reconcile(edited);
    const after = await rs.syncCloud();
    eq(after.map((b) => b.id).join(","), "default-brush-b,new1");   // a 删了；order b(1)<new1(5)
    eq(after.find((b) => b.id === "default-brush-b").name, "改过的B");
  });

  it("两设备各加一支笔 → 都脏则各自 pull-merge-push 收敛（per-item 零冲突；干净设备靠 init/boot 拉）", async () => {
    const shared = makeSharedCloud();
    const rsA = createRackStore(mkColl(shared.device()), async () => null);
    await rsA.init(); const aSeed = rsA.seedDefaults(defaults()); await rsA.syncCloud();
    const rsB = createRackStore(mkColl(shared.device()), async () => null);
    await rsB.init();   // B 拉到 A 的默认笔
    // A 加 aX（脏→push）
    rsA.reconcile(aSeed.concat([{ id: "aX", name: "A的笔", tool: "brush", size: { base: 9 }, order: 10 }]));
    await rsA.syncCloud();
    // B 加 bY（脏→flush 触发 pull-merge-push：B 拉到 aX + 自己 bY，一起推）
    const bList = await rsB.syncCloud();   // B 干净 → 不拉（网盘模型：干净设备中途不拉）
    rsB.reconcile(bList.concat([{ id: "bY", name: "B的笔", tool: "brush", size: { base: 9 }, order: 11 }]));
    const bFinal = await rsB.syncCloud();
    assert(bFinal.some((b) => b.id === "aX"), "B 脏同步应 pull 到 A 的 aX");
    assert(bFinal.some((b) => b.id === "bY"), "B 应有自己的 bY");
    // 全新设备 C（模拟下次开 app）init → 收敛到两设备的笔全在。
    const rsC = createRackStore(mkColl(shared.device()), async () => null);
    const cInit = await rsC.init();
    assert(cInit.some((b) => b.id === "aX") && cInit.some((b) => b.id === "bY"), "新设备 init 应收敛到全部笔");
  });

  it("RACK_SEED_GEN 是正整数（升号=推新默认笔给老用户）", () => {
    assert(Number.isInteger(RACK_SEED_GEN) && RACK_SEED_GEN >= 1, "seedGen 应为 >=1 整数");
  });
});
