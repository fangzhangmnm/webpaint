// v0.7.25 选区笔验收：三变体 ResolvedBrush 装配（抄内置笔手感）+ stamps→二值 gray8（引擎
// Bresenham disc 同核）+ 笔刷引擎 buffered 动力学全链 smoke（begin/extend/end 不碰 layer 像素）。
import { describe, it, assert, eq } from "./runner.mjs";

const { resolveSelPenBrush, stampsToBinaryGray8, SEL_PEN_BAND } = await import("../src/sel-pen.ts");
const { BrushEngine } = await import("../src/brush.ts");
const { Selection } = await import("../src/selection.ts");

describe("sel-pen · 变体装配（ResolvedBrush 复用，不写第二条动力学）", () => {
  it("勾线变体：重平滑/轻压变粗/起笔尖/buffered（非 pixelMode）", () => {
    const b = resolveSelPenBrush("ink", 8);
    eq(b.streamline, 0.5, "streamline");
    eq(b.stabilization, 0.5, "stabilization");
    eq(b.pressureGamma, 0.5, "γ");
    eq(b.taperIn, 0.5, "taperIn");
    eq(b.pixelMode, false, "像素变体也走 buffered——pixelMode 恒 false");
    eq(b.color, SEL_PEN_BAND, "色带色");
    eq(b.opacity, 0.5, "预览半透明");
  });
  it("像素变体：硬边/spacing .5/零平滑；尺寸夹取到变体上限", () => {
    const b = resolveSelPenBrush("pixel", 999);
    eq(b.hardness, 1, "硬边");
    eq(b.spacing, 0.5, "spacing");
    eq(b.streamline, 0, "零平滑");
    eq(b.size, 64, "夹到像素变体上限 64");
    eq(resolveSelPenBrush("hard", 30).sizeCoeff, 1, "硬圆压感全给尺寸");
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
    const settings = resolveSelPenBrush("hard", 10);
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
