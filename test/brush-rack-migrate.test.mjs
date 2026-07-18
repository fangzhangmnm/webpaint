// 笔架 v2→collection 模型验收（纯逻辑，桌面可测）。
// 2026-07 重构：uat/makeDefaultRack/mergeMissingDefaults/trash/resetAt 全撤 —— 持久化归 store.collection
//   （逐 brush 一 item + 一条 .meta），app 域只留 getInitData 构造 + .meta 纯操作。
// Node 下 builtin-brushes.json fetch 失败（无 document）→ builtinBrushes 走 emergency 兜底。
import { describe, it, assert, eq } from "./runner.mjs";
import {
  makeBrush, migrateBrush, defaultBrushForTool,
  getAllBrushes, getMeta, emptyMeta, metaAppend, metaRemove, metaMove,
  metaPrependBuiltins, buildInitMeta, builtinBrushInitData, builtinBrushes, RACK_META_ID, DEFAULT_FOLDER,
} from "../src/brushes.ts";
import { resolveBrush } from "../src/resolved-brush.ts";
import { DEFAULT_CONFIG } from "../src/current-brush-config.ts";

// 最小假 collection：entries() + getItem(id,def)（controller 的 CollectionLike 结构子集）。
function fakeColl(items) {
  return {
    entries: () => items.filter((e) => e.value !== null).map((e) => ({ id: e.id, value: e.value })),
    getItem: (id, def) => { const e = items.find((x) => x.id === id); return e && e.value !== null ? e.value : def; },
  };
}

describe("brushes · uat 撤除", () => {
  it("makeBrush 不再带 uat", () => {
    const b = makeBrush({ name: "n", tool: "brush" });
    assert(!("uat" in b), "makeBrush 输出不应含 uat");
  });
  it("migrateBrush 迁移 legacy 字段但不注入 uat", () => {
    const b = { id: "x", name: "n", tool: "brush", airbrush: true };
    migrateBrush(b);
    assert(!("uat" in b), "migrateBrush 不应再加 uat");
    eq(b.compositeMode, "buildup");   // airbrush → buildup（legacy 迁移仍在）
    assert(!("airbrush" in b), "airbrush 应删");
  });
});

describe("brushes · collection 视图桥", () => {
  it("getAllBrushes 过滤 .meta 特殊项", () => {
    const coll = fakeColl([
      { id: "b1", value: { id: "b1", name: "笔1", tool: "brush", size: { base: 8 } } },
      { id: RACK_META_ID, value: { folderOrder: ["我的常用"], order: { "我的常用": ["b1"] } } },
    ]);
    const brushes = getAllBrushes(coll);
    eq(brushes.length, 1);
    eq(brushes[0].id, "b1");
  });
  it("getMeta 缺项 → 空 meta", () => {
    const m = getMeta(fakeColl([]));
    assert(Array.isArray(m.folderOrder) && m.folderOrder.length === 0, "空 folderOrder");
    eq(Object.keys(m.order).length, 0);
  });
  it("defaultBrushForTool 取该工具第一支（视图 { brushes }）", () => {
    const rack = { brushes: [
      { id: "b1", name: "笔1", tool: "brush", size: { base: 8 } },
      { id: "e1", name: "擦1", tool: "eraser", size: { base: 8 } },
    ] };
    eq(defaultBrushForTool(rack, "eraser").id, "e1");
  });
});

describe("brushes · .meta 纯操作", () => {
  it("metaAppend 追加 + 登记 folder；重复不重加", () => {
    let m = emptyMeta();
    m = metaAppend(m, "A", "b1");
    m = metaAppend(m, "A", "b2");
    m = metaAppend(m, "A", "b1");   // 重复
    eq(m.folderOrder.join(","), "A");
    eq(m.order.A.join(","), "b1,b2");
  });
  it("metaRemove 从所有 folder 摘除", () => {
    let m = { folderOrder: ["A", "B"], order: { A: ["b1", "b2"], B: ["b1"] } };
    m = metaRemove(m, "b1");
    eq(m.order.A.join(","), "b2");
    eq(m.order.B.join(","), "");
  });
  it("metaMove 从旧 folder 挪到新 folder 末尾", () => {
    let m = { folderOrder: ["A", "B"], order: { A: ["b1", "b2"], B: ["x"] } };
    m = metaMove(m, "b1", "B");
    eq(m.order.A.join(","), "b2");
    eq(m.order.B.join(","), "x,b1");
  });
  it("metaPrependBuiltins 把出厂 id 提到各 folder 最前、用户笔留其后", () => {
    const m = { folderOrder: ["我的常用"], order: { "我的常用": ["user1", "default-a", "user2"] } };
    const out = metaPrependBuiltins(m, { "我的常用": ["default-a", "default-b"] });
    eq(out.order["我的常用"].join(","), "default-a,default-b,user1,user2");
  });
  it("buildInitMeta 按 folder 保序分组", () => {
    const meta = buildInitMeta([
      { id: "b1", folder: "A" }, { id: "b2", folder: "A" }, { id: "b3", folder: "B" },
    ]);
    eq(meta.folderOrder.join(","), "A,B");
    eq(meta.order.A.join(","), "b1,b2");
    eq(meta.order.B.join(","), "b3");
  });
});

describe("brushes · builtinBrushInitData（新库 seed 载荷）", () => {
  // v423 契约反转（用户报「清空 IDB/localStorage 后没有自动填充工厂笔」的根因防退化）：
  //   builtin-brushes.json 加载不到时 seed 必须**返空**，而不是把 emergency 兜底笔当内置笔腌进去。
  //   store 的 seed 只认「idb 里这个 collection 有没有」、不认空——一旦腌了一支笔，这个库就永远
  //   算「已存在」，内置笔再也回不来了（还会被推上云污染所有设备）。返空 → store 不写本地 →
  //   下次开 app 重新 seed、重新 fetch = 自愈。
  it("加载不到内置笔数据 → 返空载荷（绝不 seed emergency 兜底笔）", async () => {
    const data = await builtinBrushInitData();   // node 下无 document/fetch → 必失败
    eq(data.length, 0, "载荷应为空");
  });
  it("但显示路径仍有 emergency 兜底（UI 至少一支能画的笔）", async () => {
    const brushes = await builtinBrushes();
    assert(brushes.length >= 1, "builtinBrushes 应有兜底");
    assert(brushes.every((b) => b.id !== undefined), "兜底笔要有 id");
  });
  it("有数据时：笔项无 uat + .meta 覆盖每支笔的 folder", () => {
    // 不依赖 fetch：直接用 buildInitMeta 钉住 seed 载荷的结构约定。
    const bs = [makeBrush({ id: "a", name: "A", tool: "brush", folder: "F1" }),
                makeBrush({ id: "b", name: "B", tool: "brush", folder: "F2" })];
    const meta = buildInitMeta(bs);
    for (const b of bs) {
      assert(!("uat" in b), "seed 笔不应带 uat");
      assert((meta.order[b.folder || DEFAULT_FOLDER] || []).includes(b.id), `.meta 应含 ${b.id}`);
    }
    assert(RACK_META_ID === ".meta", ".meta 特殊 id 不变");
  });
});

// ── 默认值一致性（v416）───────────────────────────────────────────────────────────────────
// 症状史：同一个概念的默认值散在 makeBrush / DEFAULT_CONFIG / ensureBrushConfigDefaults /
//   resolveBrush 四处，各写各的 → hardness 曾是 0.75/1.0/1.0/1.0，pressureLPF 曾是 0/50/50/50。
//   出厂笔因为**每个字段都显式写了值**所以从没暴露；只有「新建笔」（只传 id/name/tool/folder，
//   其余全吃 makeBrush 默认）会掉进去 —— 新建的笔没有压感 LPF、转角顿一下，而出厂笔不会。
describe("默认值四处一致（新建笔必须和出厂笔/UI 默认同一套）", () => {
  it("新建笔（只给 id/name/tool/folder）resolve 出来 == DEFAULT_CONFIG", () => {
    const nb = makeBrush({ id: "x", name: "新笔 1", tool: "brush", folder: DEFAULT_FOLDER });
    const r = resolveBrush({ preset: nb });
    for (const k of ["pressureLPF", "hardness", "spacing", "sizeCoeff", "opaCoeff", "flowCoeff",
                     "pressureGamma", "streamline", "stabilization", "taperIn", "taperOut", "taperFloor"]) {
      eq(r[k], DEFAULT_CONFIG[k], `新建笔的 ${k} 必须等于 DEFAULT_CONFIG（四处默认别再各说各话）`);
    }
  });

  it("老笔补字段（migrateBrush 路径）的 pressureLPF 也是 50", () => {
    const old = migrateBrush({ id: "o", name: "老笔", tool: "brush", shape: {}, size: { base: 12 } });
    eq(old.pressureLPF, 50, "v416：human 拍板四处全统一 50，含老笔补字段");
  });
});
