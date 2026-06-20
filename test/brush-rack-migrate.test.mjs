// brushes.js v1→v2 迁移 / uat 打戳 / resetAt watermark 验收（纯逻辑，桌面可测）。
// Node 下 default-brushes.json fetch 失败（无 document）→ _defaultsSpec 空 → emergency brush 顶上。
import { describe, it, assert, eq } from "./runner.mjs";
import {
  makeDefaultRack, mergeMissingDefaults, migrateBrush, rackFromJSON,
  defaultBrushForTool, PRE_HISTORY_UAT, RACK_VERSION,
} from "../src/brushes.ts";

describe("brushes v2 迁移", () => {
  it("migrateBrush：老笔无 uat → PRE_HISTORY_UAT", () => {
    const b = { id: "x", name: "n", tool: "brush" };
    migrateBrush(b);
    eq(b.uat, PRE_HISTORY_UAT);
  });
  it("migrateBrush：已有 uat 不覆盖", () => {
    const b = { id: "x", name: "n", tool: "brush", uat: 999 };
    migrateBrush(b);
    eq(b.uat, 999);
  });

  it("makeDefaultRack()：首boot resetAt=0 / trash=[] / 笔 uat=PRE_HISTORY / 无 activeByTool", () => {
    const r = makeDefaultRack();
    eq(r.version, RACK_VERSION);
    eq(r.resetAt, 0);
    assert(Array.isArray(r.trash) && r.trash.length === 0, "trash 应为空数组");
    assert(r.brushes.every((b) => b.uat === PRE_HISTORY_UAT), "首boot 笔 uat 应为 PRE_HISTORY");
    assert(!("activeByTool" in r), "不应再有 activeByTool");
  });

  it("makeDefaultRack({resetAt})：恢复出厂 笔 uat > resetAt（不被自己水位丢）", () => {
    const T = 1_700_000_000_000;
    const r = makeDefaultRack({ resetAt: T });
    eq(r.resetAt, T);
    assert(r.brushes.every((b) => b.uat > T), "出厂笔 uat 必须 > resetAt");
  });

  it("mergeMissingDefaults：v1 老 rack → 补 trash/resetAt、删 activeByTool、置 version", () => {
    const old = { version: 1, brushes: [{ id: "u1", name: "我的", tool: "brush", uat: 5 }], activeByTool: { brush: "u1" } };
    const out = mergeMissingDefaults(old);
    assert(out, "应返回新 rack（需迁移）");
    eq(out.version, RACK_VERSION);
    assert(Array.isArray(out.trash), "应补 trash");
    eq(out.resetAt, 0);
    assert(!("activeByTool" in out), "activeByTool 应删");
  });

  it("mergeMissingDefaults：已是 v2 且无缺失 → null（no-op 不白刷）", () => {
    const r = { version: RACK_VERSION, brushes: [{ id: "u1", name: "我的", tool: "brush", uat: 5 }], trash: [], resetAt: 0 };
    eq(mergeMissingDefaults(r), null);
  });

  it("defaultBrushForTool：取该工具第一支（不依赖 activeByTool）", () => {
    const r = { version: RACK_VERSION, trash: [], resetAt: 0, brushes: [
      { id: "b1", name: "笔1", tool: "brush", uat: 1 },
      { id: "e1", name: "擦1", tool: "eraser", uat: 1 },
    ] };
    eq(defaultBrushForTool(r, "eraser").id, "e1");
  });

  it("rackFromJSON：补 trash/resetAt 默认", () => {
    const r = rackFromJSON(JSON.stringify({ version: RACK_VERSION, brushes: [] }));
    assert(Array.isArray(r.trash));
    eq(r.resetAt, 0);
  });
});
