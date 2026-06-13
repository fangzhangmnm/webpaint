// 当前笔（ResolvedBrush）解析验收（candidate 3）。纯派生 + 不可变。
import { describe, it, assert, eq } from "./runner.mjs";
import { resolveBrush } from "../src/resolved-brush.js";
import { DEFAULT_SETTINGS } from "../src/brush.js";

describe("resolveBrush · 无笔架兜底（mental model：console 设工具即可画）", () => {
  it("preset=null 仍给出完整可画的笔（DEFAULT 兜底 + dial 覆盖）", () => {
    const b = resolveBrush({ preset: null, size: 40, opacity: 0.5, flow: 0.8, color: "#abcdef" });
    eq(b.size, 40); eq(b.opacity, 0.5); eq(b.flow, 0.8); eq(b.color, "#abcdef");
    // 形状/间距走 DEFAULT（无预设）
    eq(b.hardness, DEFAULT_SETTINGS.hardness);
    eq(b.spacing, DEFAULT_SETTINGS.spacing);
    eq(b.compositeMode, DEFAULT_SETTINGS.compositeMode);
  });
  it("全空参 = DEFAULT_SETTINGS 全集（含 type / taperFloor 这类旧 frozen 不碰的字段）", () => {
    const b = resolveBrush();
    eq(b.type, DEFAULT_SETTINGS.type);
    eq(b.taperFloor, DEFAULT_SETTINGS.taperFloor);
    eq(b.size, DEFAULT_SETTINGS.size);
  });
});

describe("resolveBrush · 不可变（by-value 红线）", () => {
  it("返回值被 freeze", () => assert(Object.isFrozen(resolveBrush()), "应 frozen"));
  it("写入抛错（strict）—— 引擎绝不能回写共享物", () => {
    const b = resolveBrush({ size: 10 });
    let threw = false;
    try { /** @type {any} */ (b).size = 999; } catch (_) { threw = true; }
    assert(threw, "写 frozen 当抛错");
    eq(b.size, 10);
  });
  it("两次解析互相独立（非同一引用）", () => {
    const a = resolveBrush({ size: 1 }), c = resolveBrush({ size: 2 });
    assert(a !== c, "应是两个新对象");
    eq(a.size, 1); eq(c.size, 2);
  });
});

describe("resolveBrush · 预设字段映射（对齐旧 applyBrushPresetFrozen）", () => {
  const preset = {
    shape: { kind: "ellipse", aspect: 0.5, rotation: 90, hardness: 0.3 },
    taper: { in: 0.2, out: 0.4 },
    sizeCoeff: 0.9, opaCoeff: 0.1, flowCoeff: -0.5,
    pressureGamma: 2.0, pressureLPF: 80,
    compositeMode: "buildup", blendMode: "multiply",
    spacing: { value: 0.25 }, pixelMode: true,
    smooth: { streamline: 0.7, stabilization: 0.2, cornerKeep: 0.4 },
    smudge: { strength: 0.6, dryness: 0.3 },
  };
  const b = resolveBrush({ preset, size: 33, opacity: 0.9, flow: 1.0, color: "#112233" });
  it("shape：kind/aspect/hardness 直拷，rotation 度→弧度", () => {
    eq(b.shapeKind, "ellipse"); eq(b.shapeAspect, 0.5); eq(b.hardness, 0.3);
    eq(b.shapeRotation, 90 * Math.PI / 180);
  });
  it("taper / coeffs / gamma / lpf", () => {
    eq(b.taperIn, 0.2); eq(b.taperOut, 0.4);
    eq(b.sizeCoeff, 0.9); eq(b.opaCoeff, 0.1); eq(b.flowCoeff, -0.5);
    eq(b.pressureGamma, 2.0); eq(b.pressureLPF, 80);
  });
  it("composite / blend / spacing(对象取 .value) / pixelMode", () => {
    eq(b.compositeMode, "buildup"); eq(b.blendMode, "multiply");
    eq(b.spacing, 0.25); eq(b.pixelMode, true);
  });
  it("smooth 参数 + smudge", () => {
    eq(b.streamline, 0.7); eq(b.stabilization, 0.2); eq(b.cornerKeep, 0.4);
    eq(b.smudgeStrength, 0.6); eq(b.smudgeDryness, 0.3);
  });
  it("dial（size/opacity/flow）+ color 覆盖", () => {
    eq(b.size, 33); eq(b.opacity, 0.9); eq(b.flow, 1.0); eq(b.color, "#112233");
  });
});

describe("resolveBrush · 预设缺字段走 ?? 默认（与旧逐字对齐）", () => {
  it("空 shape/taper → kind round / aspect 1 / hardness 1 / taper 0 / spacing 0.06", () => {
    const b = resolveBrush({ preset: {} });
    eq(b.shapeKind, "round"); eq(b.shapeAspect, 1.0); eq(b.hardness, 1.0);
    eq(b.taperIn, 0); eq(b.taperOut, 0); eq(b.spacing, 0.06);
    eq(b.sizeCoeff, 0.6); eq(b.opaCoeff, 0.6); eq(b.flowCoeff, 0);
  });
  it("number 型 spacing 直取", () => eq(resolveBrush({ preset: { spacing: 0.18 } }).spacing, 0.18));
});

describe("resolveBrush · 全局压感开关", () => {
  it("传入即覆盖（!! 归一）", () => {
    eq(resolveBrush({ pressureToSize: false, pressureToOpacity: true }).pressureToSize, false);
    eq(resolveBrush({ pressureToSize: 0, pressureToOpacity: 1 }).pressureToOpacity, true);
  });
  it("不传 = 保留 DEFAULT", () => {
    eq(resolveBrush().pressureToSize, DEFAULT_SETTINGS.pressureToSize);
  });
});
