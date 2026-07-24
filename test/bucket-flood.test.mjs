// #22 油漆桶 / #31 魔棒 · flood 内核提取验收（floodSelectFrom，v242 语义原样）。
// 内核吃 { width, height } + sourceLayer{bbox*, ctx.getImageData} 纯数据 → node 直测无 DOM。
// 桶的「被现有选区裁剪」走 Selection.compose("intersect")，一并回归（compose 语义已在 selection-tiles 测，
// 这里测的是桶的用法：flood ∩ 选区、不碰输入选区）。
import { describe, it, assert, eq } from "./runner.mjs";

const { floodSelectFrom } = await import("../src/lasso.ts");
const { Selection } = await import("../src/selection.ts");

// 假图层：w×h 的 RGBA 数据，bbox 盖满
function fakeLayer(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) fill(i % w, (i / w) | 0, data, i * 4);
  return { bboxX: 0, bboxY: 0, bboxW: w, bboxH: h, ctx: { getImageData: () => ({ data }) } };
}
function count255(sel) {
  const g = sel.materializeMaskRegion(sel.bboxX, sel.bboxY, sel.bboxW, sel.bboxH);
  let n = 0; for (let i = 0; i < g.length; i++) if (g[i] === 255) n++;
  return n;
}

describe("floodSelectFrom · 魔棒/油漆桶共用 flood 内核", () => {
  it("空层（null sourceLayer）：tap 透明 → 全 doc 选区", () => {
    const sel = floodSelectFrom({ width: 8, height: 8 }, { x: 0, y: 0 }, null, 20);
    assert(sel, "应有选区");
    eq(count255(sel), 64, "8×8 全选");
    sel.dispose();
  });

  it("左半红右半透明：tap 红区 → 只选左半（右半是 barrier）", () => {
    const L = fakeLayer(8, 8, (x, _y, d, o) => {
      if (x < 4) { d[o] = 255; d[o + 3] = 255; }   // 左半红
    });
    const sel = floodSelectFrom({ width: 8, height: 8 }, { x: 1, y: 1 }, L, 20);
    assert(sel, "应有选区");
    eq(count255(sel), 32, "只选左半 32 px");
    eq(sel.bboxW, 4, "bbox 宽 4");
    sel.dispose();
  });

  it("tap 透明半区 → 只选右半；doc 外起点 → null", () => {
    const L = fakeLayer(8, 8, (x, _y, d, o) => {
      if (x < 4) { d[o] = 255; d[o + 3] = 255; }
    });
    const sel = floodSelectFrom({ width: 8, height: 8 }, { x: 6, y: 3 }, L, 20);
    eq(count255(sel), 32, "右半 32 px");
    sel.dispose();
    eq(floodSelectFrom({ width: 8, height: 8 }, { x: 99, y: 0 }, L, 20), null, "出界 null");
  });

  it("阈值放行：threshold 100 时半透明差异不成 barrier → 全选", () => {
    const L = fakeLayer(4, 4, (x, _y, d, o) => { d[o + 3] = x * 40; });   // alpha 渐变 0..120
    const sel = floodSelectFrom({ width: 4, height: 4 }, { x: 0, y: 0 }, L, 100);
    eq(count255(sel), 16, "阈值拉满全放行");
    sel.dispose();
  });

  it("桶的选区裁剪用法：flood ∩ 现有选区 = 交集，且不碰输入选区", () => {
    const flood = floodSelectFrom({ width: 8, height: 8 }, { x: 0, y: 0 }, null, 20);   // 全 doc
    const existing = Selection.full(4, 4, 2, 2);   // (2,2) 处 4×4
    const clipped = Selection.compose(existing, flood, "intersect");
    assert(clipped && clipped !== existing && clipped !== flood, "交集是新对象");
    eq(count255(clipped), 16, "交集 = 4×4");
    eq(count255(existing), 16, "输入选区原样（不碰选区红线）");
    flood.dispose(); existing.dispose(); clipped.dispose();
  });

  it("桶完全在选区外：交集为 null（bk.outsideSelection 路径）", () => {
    const L = fakeLayer(8, 8, (x, _y, d, o) => {
      if (x < 4) { d[o] = 255; d[o + 3] = 255; }
    });
    const flood = floodSelectFrom({ width: 8, height: 8 }, { x: 1, y: 1 }, L, 20);   // 左半
    const existing = Selection.full(2, 2, 6, 1);   // 右半里的 2×2
    const clipped = Selection.compose(existing, flood, "intersect");
    eq(clipped, null, "无交集 → null");
    flood.dispose(); existing.dispose();
  });
});
