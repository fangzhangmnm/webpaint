// editor-state.serializedToolStatePatch 测试 —— adoptLoadedDoc 的 toolStates 反序列化下沉后（rec #5 part b）。
// 纯函数，覆 v98 opacity/flow 分离的兼容回退（老 doc .intensity / 只有 flow 的情形）。

import { describe, it, assert, eq } from "./runner.mjs";
import { serializedToolStatePatch } from "../src/editor-state.ts";

const cur = () => ({ size: 12, opacity: 0.9, flow: 1.0, activeBrushId: "a", activeBrushName: "笔A" });

describe("editor-state · serializedToolStatePatch（toolStates 反序列化 + v98 兼容）", () => {
  it("saved 无效（null / 非对象）→ null（不动当前）", () => {
    eq(serializedToolStatePatch(cur(), null), null);
    eq(serializedToolStatePatch(cur(), undefined), null);
    eq(serializedToolStatePatch(cur(), 42), null);
  });

  it("新格式（opacity+flow 都有）→ 原样取", () => {
    const p = serializedToolStatePatch(cur(), { size: 30, opacity: 0.5, flow: 0.3 });
    eq(p.size, 30); eq(p.opacity, 0.5); eq(p.flow, 0.3);
  });

  it("v98 兼容：老 doc 只有 .intensity → 当 opacity", () => {
    const p = serializedToolStatePatch(cur(), { size: 20, intensity: 0.4 });
    eq(p.opacity, 0.4, "intensity 应回退成 opacity");
    eq(p.flow, cur().flow, "无 flow → 保留当前 flow");
  });

  it("v98 兼容：只有 flow 没 opacity → flow 当 opacity，flow 自身保留当前", () => {
    const p = serializedToolStatePatch(cur(), { size: 20, flow: 0.6 });
    eq(p.opacity, 0.6, "只有 flow 时 flow 当 opacity");
    eq(p.flow, cur().flow, "opacity 缺失时 flow 不被 saved.flow 覆盖（fl 取当前）");
  });

  it("缺字段保留当前值；string 字段类型校验", () => {
    const p = serializedToolStatePatch(cur(), { opacity: 0.5 });
    eq(p.size, 12, "无 size → 保留当前");
    eq(p.activeBrushId, "a", "无 activeBrushId → 保留当前");
    const p2 = serializedToolStatePatch(cur(), { size: 9, activeBrushId: 123 });
    eq(p2.activeBrushId, "a", "activeBrushId 非 string → 保留当前");
  });

  it("v132：variantId（string）带出；非 string 不带", () => {
    const p = serializedToolStatePatch(cur(), { variantId: "soft" });
    eq(p.variantId, "soft");
    const p2 = serializedToolStatePatch(cur(), { variantId: 7 });
    assert(!("variantId" in p2), "非 string variantId 不应出现在 patch");
  });
});
