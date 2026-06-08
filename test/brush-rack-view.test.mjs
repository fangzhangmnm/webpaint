// 笔架 view-model 验收（A3）。纯派生。
import { describe, it, assert, eq } from "./runner.mjs";
import { collectFolders, brushesInFolder, smoothstepRadialGradient } from "../src/brush-rack-view.js";

describe("brush-rack-view · collectFolders", () => {
  const D = "默认";
  it("去重 + 保首见序；无 folder 归默认夹", () => {
    eq(JSON.stringify(collectFolders([{ folder: "A" }, { folder: "A" }, { folder: "B" }, {}], D)),
      JSON.stringify(["A", "B", D]));
  });
  it("空列表 → 只有默认夹", () => eq(JSON.stringify(collectFolders([], D)), JSON.stringify([D])));
});

describe("brush-rack-view · brushesInFolder", () => {
  const D = "默认";
  const bs = [{ id: 1, folder: "A" }, { id: 2 }, { id: 3, folder: "A" }, { id: 4, folder: "B" }];
  it("按 folder 过滤；缺 folder 归默认夹", () => {
    eq(JSON.stringify(brushesInFolder(bs, "A", D).map((b) => b.id)), JSON.stringify([1, 3]));
    eq(JSON.stringify(brushesInFolder(bs, D, D).map((b) => b.id)), JSON.stringify([2]));
  });
});

describe("brush-rack-view · smoothstepRadialGradient", () => {
  it("closest-side + 含 0%/100% stop", () => {
    const g = smoothstepRadialGradient(1.0);
    assert(g.startsWith("radial-gradient(circle closest-side,"), "closest-side");
    assert(g.includes("0.0%") && g.includes("100.0%"), "含端点 stop");
  });
  it("hardness=1 全实心（每个 stop α=100%）", () => {
    const g = smoothstepRadialGradient(1.0);
    assert(!/ 0\.0%, /.test(g.replace(/transparent\) [\d.]+%/g, "")), "无中途 α=0");
    assert((g.match(/var\(--ink\) 100\.0%/g) || []).length >= 16, "全 α=100%");
  });
  it("hardness clamp 到 0..1（不抛）", () => {
    assert(typeof smoothstepRadialGradient(-5) === "string");
    assert(typeof smoothstepRadialGradient(99) === "string");
  });
});
