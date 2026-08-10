// 选区笔验收（v0.7.25 落地 / v0.7.26 笔架化）：笔架笔→选区笔渲染态覆写 + stamps→二值 gray8
// （引擎 Bresenham disc 同核）+ 笔刷引擎 buffered 动力学全链 smoke（begin/extend/end 不碰 layer 像素）。
import { describe, it, assert, eq } from "./runner.mjs";

const { selPenSettingsFrom, stampsToBinaryGray8, SEL_PEN_BAND } = await import("../src/sel-pen.ts");
const { resolveBrush } = await import("../src/resolved-brush.ts");
const { BrushEngine } = await import("../src/brush.ts");
const { Selection } = await import("../src/backend/selection.ts");

describe("sel-pen · 笔架笔 → 选区笔渲染态（v0.7.26：配置归笔架，无自有变体轮子）", () => {
  it("覆写：色带色/半透明/normal blend/pixelMode 压平；动力学字段原样穿透", () => {
    const base = resolveBrush({
      preset: { shape: { kind: "round", hardness: 1 }, taper: { in: 0, out: 0 }, sizeCoeff: 0, opaCoeff: 0,
                flowCoeff: 0, pressureGamma: 1, pressureLPF: 0, compositeMode: "wash", spacing: 0.5,
                pixelMode: true, smooth: { streamline: 0, stabilization: 0 } },
      size: 3, opacity: 1, color: "#ff0000",
    });
    const s = selPenSettingsFrom(base);
    eq(s.color, SEL_PEN_BAND, "色带色覆写");
    eq(s.opacity, 0.5, "预览半透明");
    eq(s.blendMode, "source-over", "blend 钉 normal");
    eq(s.pixelMode, false, "pixelMode 压平（buffered 动力学；精确落纸由 input 侧 disc 路径管）");
    eq(base.pixelMode, true, "base 不被改（Object.freeze 新对象）");
    eq(s.spacing, 0.5, "动力学字段穿透");
    eq(s.hardness, 1, "笔形穿透");
    eq(s.size, 3, "笔径来自笔架 dial");
  });
});

describe("sel-pen · stamps→二值 gray8（disc 同核）+ 动力学全链 smoke", () => {
  const eng = new BrushEngine();
  const disc = (buf, rw, rh, ox, oy, ix, iy, n) =>
    eng.pixelDiscInto(buf, rw, rh, ox, oy, ix, iy, n, { r: 0, g: 0, b: 0 }, 1, "over");

  it("单枚 size3 stamp → Bresenham 圆盘：中心实、远处空、纯二值", () => {
    const g = stampsToBinaryGray8([{ x: 4, y: 4, size: 3, alpha: 1 }], 0, 0, 9, 9, disc);
    eq(g[4 * 9 + 4], 255, "中心 on");
    eq(g[0], 0, "角落 off");
    let n = 0;
    for (const v of g) { assert(v === 0 || v === 255, "二值"); if (v) n++; }
    assert(n >= 5 && n <= 9, `disc 大小合理（${n}）`);
  });

  it("引擎 buffered 全链：begin/extend/end 出 stamps → gray8 → Selection（layer 像素零接触）", () => {
    let touched = false;
    const fakeLayer = {
      id: 1, docW: 64, docH: 64, lockAlpha: false,
      editRegionBytes: () => { touched = true; },
      getImageData: () => { touched = true; return { data: new Uint8ClampedArray(0) }; },
    };
    const settings = selPenSettingsFrom(resolveBrush({ preset: null, size: 10 }));
    eng.beginStroke(fakeLayer, settings, 10, 10, 0.8, "brush", {}, 0);
    for (let i = 1; i <= 8; i++) eng.extendStroke(10 + i * 4, 10, 0.8, i * 16);
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 0, "抬笔有 stamps");
    eq(touched, false, "buffered 全程不碰 layer 像素（选区笔前提）");
    const g = stampsToBinaryGray8(cs.stamps, cs.bx, cs.by, cs.bw, cs.bh, disc);
    let n = 0;
    for (const v of g) if (v) n++;
    assert(n > 20, `笔迹面积 ${n} > 20`);
    const sel = Selection.fromGray8Region(cs.bx, cs.by, cs.bw, cs.bh, g);
    assert(sel, "gray8 → Selection");
    sel.dispose();
  });
});
