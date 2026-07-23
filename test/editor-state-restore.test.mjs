// editor-state.serializedToolStatePatch 测试 —— adoptLoadedDoc 的 toolStates 反序列化下沉后（rec #5 part b）。
// 纯函数，覆老 doc 的兼容回退（.intensity / 只有 flow 的情形）。
// v415：dial 不再有 flow 轴（恒 1.0、无滑块、无 preset 来源 = 摆设，已删）——
//   但**读侧兼容必须留**：老 ORA 里的 flow 仍会被当 opacity 用，只是不再往 toolState 写回 flow。

import { describe, it, assert, eq } from "./runner.mjs";
import { serializedToolStatePatch } from "../src/workbench-state.ts";

const cur = () => ({ size: 12, opacity: 0.9, activeBrushId: "a", activeBrushName: "笔A" });

describe("editor-state · serializedToolStatePatch（toolStates 反序列化 + v98 兼容）", () => {
  it("saved 无效（null / 非对象）→ null（不动当前）", () => {
    eq(serializedToolStatePatch(cur(), null), null);
    eq(serializedToolStatePatch(cur(), undefined), null);
    eq(serializedToolStatePatch(cur(), 42), null);
  });

  it("opacity 存在 → 原样取；老档的 flow 被忽略（dial 已无 flow 轴）", () => {
    const p = serializedToolStatePatch(cur(), { size: 30, opacity: 0.5, flow: 0.3 });
    eq(p.size, 30); eq(p.opacity, 0.5);
    assert(!("flow" in p), "patch 不再产出 flow 字段");
  });

  it("老档兼容：只有 .intensity → 当 opacity", () => {
    const p = serializedToolStatePatch(cur(), { size: 20, intensity: 0.4 });
    eq(p.opacity, 0.4, "intensity 应回退成 opacity");
  });

  it("老档兼容：只有 flow 没 opacity → flow 当 opacity（★这条兼容不能删，老画要能载入）", () => {
    const p = serializedToolStatePatch(cur(), { size: 20, flow: 0.6 });
    eq(p.opacity, 0.6, "只有 flow 时 flow 当 opacity");
    assert(!("flow" in p), "但不写回 flow 字段");
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
