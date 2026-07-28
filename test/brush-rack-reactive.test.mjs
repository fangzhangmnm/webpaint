// 笔架 ↔ collection 的**绑定**回归测试（v415 防退化时补）。
//
// 为什么单开一个文件：v415 把笔架从手动计数器 rackVersion 改成 shallowRef 镜像，
//   注释写着「镜像的唯一写入点 = collection.onChange」，**但那行代码漏了**——
//   而当时的测试是手动替换 mirror.value 来模拟 onChange，于是只测了「镜像变了→重算」这一半，
//   把「写 collection → 镜像跟着变」那一半（真正漏掉的那半）当成了前提。
//   结果：编辑保存一支笔 / 新建 / 删除 / 导入 / 云端拉取，笔架和引擎全都不刷新。
// 这个文件走**真 collection + 真 controller**，把那条绑定钉死。
import { describe, it, assert, eq } from "./runner.mjs";
import { createCollection } from "../src/store/collection.ts";
import { BrushRackController } from "../src/brush-rack-controller.ts";
import { RACK_META_ID } from "../src/brushes.ts";

const blobOf = (s) => ({ text: async () => s });
function mockCloud() {
  let stored = null, n = 0;
  const dirty = new Map(), etags = new Map();
  return {
    pull: async () => (stored == null ? null : { blob: blobOf(stored), item: { eTag: "e" } }),
    push: async (_n, blob) => { stored = await blob.text(); return { item: { eTag: "e" + ++n } }; },
    fetchMeta: async () => null,
    setDirty: (k, v) => dirty.set(k, v), isDirty: (k) => !!dirty.get(k),
    setETag: (k, v) => etags.set(k, v), getETag: (k) => etags.get(k) ?? null,
  };
}

const brush = (id, name, extra = {}) => ({
  id, name, tool: "brush", folder: "我的常用",
  size: { base: 12, max: 200 }, spacing: 0.06, ...extra,
});

// 最小 controller：只喂数据层依赖（不碰 DOM——订阅在 load()，正是为此挪的）。
async function mkRack(initial = []) {
  const collection = createCollection({ cloud: mockCloud(), name: "rack.json", cloudless: true, now: () => 1 });
  const toolStates = { brush: { size: 12, opacity: 1, activeBrushId: null, activeBrushName: null } };
  const rack = new BrushRackController({
    collection,
    state: { toolStates },
    dialReactive: { tool: "brush" },
    editMode: () => ({ current: () => "brush" }),
    setStatus: () => {}, confirm: async () => true,
    openExclusive: () => {}, closeExclusive: () => {}, registerPanel: () => {},
    isSignedIn: () => false, isOnline: () => false,
  });
  await collection.init();
  for (const b of initial) collection.setItem(b.id, b);
  await rack.load();          // ← 订阅 + 首帧
  return { rack, collection, toolStates };
}

describe("笔架 ↔ collection 绑定（★v415 漏接过，别再漏）", () => {
  it("编辑保存一支笔（setItem）→ 笔架镜像立刻反映新值", async () => {
    const { rack, collection } = await mkRack([brush("b1", "笔A")]);
    eq(rack._view().brushes.find((b) => b.id === "b1").spacing, 0.06, "先是旧值");
    collection.setItem("b1", brush("b1", "笔A", { spacing: 0.5 }));
    eq(rack._view().brushes.find((b) => b.id === "b1").spacing, 0.5,
       "★写 collection 后镜像必须跟着变（漏了这条 = 改笔按保存没效果）");
  });

  it("新建/导入一支笔 → 出现在笔架里", async () => {
    const { rack, collection } = await mkRack([brush("b1", "笔A")]);
    collection.setItem("b2", brush("b2", "笔B"));
    assert(rack._view().brushes.some((b) => b.id === "b2"), "★新笔必须出现（否则导入看着像没反应）");
  });

  it("删除一支笔 → 从笔架消失", async () => {
    const { rack, collection } = await mkRack([brush("b1", "笔A"), brush("b2", "笔B")]);
    collection.deleteItem("b2");
    assert(!rack._view().brushes.some((b) => b.id === "b2"), "★删掉的笔必须消失");
  });

  it("★.meta 连续两次写不会互相回滚（镜像若不刷，第二次是从第一次之前的快照算的）", async () => {
    const { rack, collection } = await mkRack([brush("b1", "笔A"), brush("b2", "笔B")]);
    collection.setItem(RACK_META_ID, { folderOrder: ["我的常用"], order: { "我的常用": ["b1", "b2"] } });
    eq(rack._meta().order["我的常用"].length, 2, "首次写生效");
    // 基于**当前** meta 再写一次（模拟 metaRemove 那类 read-modify-write）
    const cur = rack._meta();
    collection.setItem(RACK_META_ID, { folderOrder: cur.folderOrder, order: { "我的常用": cur.order["我的常用"].filter((x) => x !== "b1") } });
    eq(JSON.stringify(rack._meta().order["我的常用"]), JSON.stringify(["b2"]),
       "★第二次写必须基于第一次的结果（镜像陈旧会让两次删除互相复活）");
  });

  it("云端拉取带来的变更也走同一条路（本地/远端一视同仁）", async () => {
    const { rack, collection } = await mkRack([brush("b1", "笔A")]);
    // collection 对本地写和远端写用的是同一个 emit → 这里用 setItem 代表"某处来了个变更"
    collection.setItem("b1", brush("b1", "笔A改名后"));
    eq(rack._view().brushes.find((b) => b.id === "b1").name, "笔A改名后", "变更来源不影响刷新");
  });
});

// ── 空笔架自愈（v423）─────────────────────────────────────────────────────────────────
// 用户提的场景：新用户首开时 builtin-brushes.json 没加载到（离线 / SW 没缓上 / 404）
//   → 笔架是空的，而他**根本不知道**要去调试菜单点「还原内置笔刷」= app 开箱即坏。
//   所以补笔失败**不许认命**：会话内退避重试 + online 事件重试，直到有笔为止。
// node 下 fetch 必失败（无 document）→ 正好用来测「失败之后」这半边。
describe("空笔架自愈 · 补内置笔失败不认命（v423）", () => {
  it("笔架空 + 内置笔数据拿不到 → 挂上会话内重试（不是补一次就放弃）", async () => {
    const { rack } = await mkRack([]);                       // 空笔架
    eq(rack._view().brushes.length, 0, "前提：node 下补不进内置笔，笔架确实是空的");
    assert(rack._healTimer != null, "★必须挂着重试定时器——否则新用户首开离线就永远是空笔架");
    assert(rack._healAttempt > 0, "重试计数应已推进（退避）");
    assert(rack._healOnline == null || typeof rack._healOnline === "function", "online 重试钩子形态正常");
    rack._stopHeal();
  });

  it("重试时笔架已经有笔了（云端拉到 / 用户自己新建）→ 停掉重试，不再打扰", async () => {
    const { rack, collection } = await mkRack([]);
    assert(rack._healTimer != null, "前提：先挂着重试");
    collection.setItem("b1", brush("b1", "笔A"));             // 笔架有笔了
    await rack._healEmptyRack();                             // 模拟下一次重试 tick
    assert(rack._healTimer == null, "★有笔了必须停止重试");
    eq(rack._healAttempt, 0, "重试计数应复位");
  });

  it("手点还原也失败 → 同样挂上后台重试（用户不必自己盯着反复点）", async () => {
    const { rack } = await mkRack([]);
    rack._stopHeal();
    eq(await rack.restoreBuiltins(), 0, "node 下必失败，如实返 0（0 = 失败，别谎报成功）");
    assert(rack._healTimer != null, "★手点失败后也要接管重试");
    rack._stopHeal();
  });
});

// v0.6.14 缺笔自愈（纯派生，不回写 dial）：dial 指的笔被删/还没 sync 到 → 当前笔退该工具默认笔；
//   缺的笔从云端回来那一刻自动复原（正因为没回写，存档里的 id 没被销毁）。
describe("缺笔自愈（v0.6.14 resolveActiveBrushPure）", () => {
  it("dial 指着不存在的笔 → 退到该工具默认笔；dial 不被回写", async () => {
    const { rack, toolStates } = await mkRack([brush("b1", "笔A"), brush("b2", "笔B")]);
    toolStates.brush.activeBrushId = "ghost";
    toolStates.brush.activeBrushName = "已删的笔";
    const r = rack.resolveActiveBrushPure(toolStates.brush, "brush");
    eq(r?.id, "b1", "★缺笔必须退默认笔（不再是 DEFAULT_CONFIG 幽灵笔）");
    eq(toolStates.brush.activeBrushId, "ghost", "★不回写 dial——存档引用保留，等 sync 复原");
  });

  it("缺的笔 sync 回来（collection 写入同 id）→ 自动复原为原笔", async () => {
    const { rack, collection, toolStates } = await mkRack([brush("b1", "笔A")]);
    toolStates.brush.activeBrushId = "ghost";
    toolStates.brush.activeBrushName = null;
    eq(rack.resolveActiveBrushPure(toolStates.brush, "brush")?.id, "b1", "前提：先退默认");
    collection.setItem("ghost", brush("ghost", "外域笔"));
    eq(rack.resolveActiveBrushPure(toolStates.brush, "brush")?.id, "ghost", "★sync 到货即复原");
  });

  it("id 死但 name 还在 → 名字兜底命中，不算缺笔", async () => {
    const { rack, toolStates } = await mkRack([brush("b1", "笔A")]);
    toolStates.brush.activeBrushId = "ghost";
    toolStates.brush.activeBrushName = "笔A";
    eq(rack.resolveActiveBrushPure(toolStates.brush, "brush")?.id, "b1", "name 兜底优先于默认笔");
  });
});

// v0.6.25 pin（user：「shape brush 和 brush 的默认笔刷是同一个同步的吧，pin 一下」）：
// 形状笔与笔刷共享 rack/当前笔的 alias 是行为契约（ADR-0005），别被将来重构悄悄拆散。
describe("rack · getRackToolKey alias（形状笔=笔刷同一支笔）", () => {
  it("shapeBrush/airbrush → brush；eraser 独立", async () => {
    const { rack } = await mkRack();
    eq(rack.getRackToolKey("shapeBrush"), "brush", "形状笔与笔刷同一支笔（ADR-0005）");
    eq(rack.getRackToolKey("airbrush"), "brush", "喷枪 alias（v96）");
    eq(rack.getRackToolKey("eraser"), "eraser", "橡皮各自独立");
    eq(rack.getRackToolKey("brush"), "brush");
  });
});
