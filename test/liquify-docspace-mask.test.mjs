// charter H7 转绿（S8 液化 doc-space mask 重写）：
//   旧病灶 = selection mask 在 beginStroke 按 layer.bbox 烤死平面，layer.bbox 外一律「选区外」
//   → 内容被推出旧 bbox 的那半不液化（半拉）。S8 起 mask 是 doc-space 平面（随 dispField 增长，
//   平面外直查 selection tile）→ 判定与 layer.bbox 彻底解耦。
// 引擎在 node 全跑真像素：mock layer（doc 尺寸 RGBA 缓冲）+ 真 Selection（gray8 tile）+
//   dom-shim 的最小 ImageData。
import { describe, it, assert, eq } from "./runner.mjs";
const { LiquifyEngine } = await import("../src/plugins/liquify-engine.ts");
const { Selection } = await import("../src/selection.ts");

// mock layer：整 doc RGBA 缓冲；snapshotImageData 按内容 bbox 物化（与真 Layer 形状一致）。
function mockLayer(docW, docH) {
  const buf = new Uint8ClampedArray(docW * docH * 4);
  const L = {
    docW, docH, bboxX: 0, bboxY: 0, bboxW: 0, bboxH: 0,
    fill(x, y, w, h, [r, g, b, a]) {
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
        const i = (yy * docW + xx) * 4; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
      }
      if (!L.bboxW) { L.bboxX = x; L.bboxY = y; L.bboxW = w; L.bboxH = h; }
      else {
        const x1 = Math.max(L.bboxX + L.bboxW, x + w), y1 = Math.max(L.bboxY + L.bboxH, y + h);
        L.bboxX = Math.min(L.bboxX, x); L.bboxY = Math.min(L.bboxY, y);
        L.bboxW = x1 - L.bboxX; L.bboxH = y1 - L.bboxY;
      }
    },
    px(x, y) { const i = (y * docW + x) * 4; return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]; },
    snapshotImageData() {
      const { bboxX: x, bboxY: y, bboxW: w, bboxH: h } = L;
      if (!w || !h) return { bboxX: 0, bboxY: 0, bboxW: 0, bboxH: 0, imageData: null };
      const data = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy++) data.set(buf.subarray(((y + yy) * docW + x) * 4, ((y + yy) * docW + x + w) * 4), yy * w * 4);
      return { bboxX: x, bboxY: y, bboxW: w, bboxH: h, imageData: { data, width: w, height: h } };
    },
    putImageData(x0, y0, img) {
      for (let yy = 0; yy < img.height; yy++) {
        const dy = y0 + yy;
        if (dy < 0 || dy >= docH) continue;
        buf.set(img.data.subarray(yy * img.width * 4, (yy + 1) * img.width * 4), (dy * docW + x0) * 4);
      }
    },
  };
  return L;
}

// 矩形选区（gray8 全 255）。
function rectSelection(x, y, w, h) {
  const d = new Uint8Array(w * h).fill(255);
  return Selection.fromGray8Region(x, y, w, h, d);
}

describe("liquify · doc-space mask（charter H7 转绿）", () => {
  it("选区判定是 doc 空间：把内容推出旧 layer.bbox，越界那半照常液化（不再『半拉』）", () => {
    const L = mockLayer(128, 128);
    L.fill(10, 10, 30, 30, [220, 30, 30, 255]);          // 红内容，layer.bbox=(10,10,30,30)
    const sel = rectSelection(0, 0, 100, 100);            // 选区盖住 bbox 外一大片
    const eng = new LiquifyEngine();
    eng.beginStroke(L, { size: 40, strength: 1, mode: "push", bleed: "edge" }, 35, 25, sel);
    eng.extendStroke(70, 25);                             // 往右推：内容应落到旧 bbox(右缘 40) 之外
    // dest(50,25)：旧码在 layer.bbox 外 → 误判选区外 → 保原（透明）。新码：doc-space 在选区内 → 液化。
    const [r, , , a] = L.px(50, 25);
    assert(a > 200, `旧 bbox 外的 dest 应收到被推来的内容（alpha=${a}）`);
    assert(r > 150, `推来的是红内容（r=${r}）`);
    sel.dispose();
  });

  it("选区仍然约束：footprint 内但选区外的 dest 不动", () => {
    const L = mockLayer(128, 128);
    L.fill(10, 10, 30, 30, [220, 30, 30, 255]);
    const sel = rectSelection(0, 0, 60, 50);              // 选区只到 x<60
    const eng = new LiquifyEngine();
    eng.beginStroke(L, { size: 40, strength: 1, mode: "push", bleed: "edge" }, 35, 25, sel);
    eng.extendStroke(70, 25);
    assert(L.px(50, 25)[3] > 200, "选区内（x=50）液化生效");
    eq(L.px(65, 25)[3], 0, "选区外（x=65）保持原样（原本透明），即使 footprint 覆盖且源头有内容");
    sel.dispose();
  });

  it("bleed 三模式在 doc-space mask 下语义不变（import 拉外部 / clip 设墙 / edge 整数 cell march）", () => {
    // 布局：选区 (8,8,16,16)。绿 x∈[8,23)，蓝边界列 x=23，红 x∈[24,40)（选区外）。
    const mk = (bleed) => {
      const L = mockLayer(64, 64);
      L.fill(8, 8, 15, 16, [30, 200, 30, 255]);     // 绿
      L.fill(23, 8, 1, 16, [30, 30, 220, 255]);     // 蓝（选区内最后一列）
      L.fill(24, 8, 16, 16, [220, 30, 30, 255]);    // 红（选区外）
      const sel = rectSelection(8, 8, 16, 16);
      const eng = new LiquifyEngine();
      eng.beginStroke(L, { size: 12, strength: 1, mode: "push", bleed }, 30, 16, sel);
      eng.extendStroke(14, 16);                     // 往左推：dest(16,16) 的位移源落到选区外的红区
      const p = L.px(16, 16);
      sel.dispose();
      return p;
    };
    const imp = mk("import");
    assert(imp[0] > 150 && imp[1] < 120, `import 应把外部红拉进来（got rgb=${imp.slice(0, 3)}）`);
    const clip = mk("clip");
    assert(clip[1] > 150 && clip[0] < 120 && clip[2] < 120, `clip 应保 dest 原绿（got rgb=${clip.slice(0, 3)}）`);
    const edge = mk("edge");
    assert(edge[2] > 150 && edge[0] < 120, `edge 应采选区边界整数 cell（蓝列）（got rgb=${edge.slice(0, 3)}）`);
  });

  it("mask 平面外的源查询回落 selection tile（不再把『平面外』当『选区外』）", () => {
    // 全 doc 选区；内容红 (30,30,20,20)；把 dest(38,40) 的源推到平面外的透明选中区 (≈12,40)。
    // 旧语义（平面外=false）会 edge-march 到平面左缘采到红；doc-space 正解 = 源透明 → dest 透明。
    const L = mockLayer(64, 64);
    L.fill(30, 30, 20, 20, [220, 30, 30, 255]);
    const sel = rectSelection(0, 0, 64, 64);
    const eng = new LiquifyEngine();
    eng.beginStroke(L, { size: 6, strength: 1, mode: "push", bleed: "edge" }, 12, 40, sel);
    eng.extendStroke(40, 40);
    eq(L.px(38, 40)[3], 0, "源在平面外但在选区内且透明 → dest 透明（不应误走 edge-march 采到红）");
    sel.dispose();
  });
});
