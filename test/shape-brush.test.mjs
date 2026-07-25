// 形状笔引擎（ADR-0005）。
// 问题陈述：
//   - 恒压可观测定义：sizeCoeff>0 且 taper 被覆写归零 → 全部 stamp size 相等（机械均匀线）。
//   - taper 覆写：preset 带 taperIn/Out 也被强制无视（taper 是笔压修饰，笔压已禁用）。
//   - 三子工具几何→stamps 全链（line 共线 / rect 盖四边 / circle 闭合环 / 半圆出弧）。
//   - 恒吃 raw + 约束吸附在引擎内（45° snap 下 stamps 落在吸附轴上）。
//   - cancel 无痕（buffered 清态；pixelMode 像素还原）；pixelMode 每帧 restore（中间几何不残留）。
import { describe, it, assert, eq } from "./runner.mjs";
const { ShapeBrushEngine } = await import("../src/shape-brush.ts");
const { resolveBrush } = await import("../src/resolved-brush.ts");
const { PaintDoc } = await import("../src/doc.ts");
const { bresenhamEllipseRect } = await import("../src/shape-geometry.ts");

const mkDoc = () => new PaintDoc({ width: 512, height: 512 });

function mkEngine(sub, constrain = false, rot = 0) {
  const eng = new ShapeBrushEngine();
  eng.setSubTool(sub);
  eng.setConstrain(constrain);
  eng.setViewportRotProvider(() => rot);
  return eng;
}

// 非零 alpha 像素计数（pixelMode 落层验证）
function paintedCount(layer) {
  const s = layer.snapshotImageData();
  if (!s.imageData) return 0;
  const d = s.imageData.data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
}

describe("shape-brush · 恒压 + taper 覆写", () => {
  it("sizeCoeff>0 + preset taper>0 → 全 stamp size 相等（机械均匀线）", () => {
    const s = resolveBrush({ size: 24, color: "#000000", spacing: 0.15,
      preset: { sizeCoeff: 0.9, taperIn: 0.5, taperOut: 0.5 } });
    const doc = mkDoc();
    const eng = mkEngine("line");
    eng.beginStroke(doc.layers[0], s, 50, 50, 1.0, "brush");
    eng.extendStroke(400, 50, 0.3);
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 5, `应有多颗 stamp，实得 ${cs ? cs.stamps.length : "null"}`);
    const size0 = cs.stamps[0].size;
    for (const st of cs.stamps) {
      assert(Math.abs(st.size - size0) < 1e-6, `size 应恒定：${st.size} vs ${size0}`);
      assert(Math.abs(st.alpha - cs.stamps[0].alpha) < 1e-6, "alpha 也恒定");
    }
  });
  it("传入的 pressure 参数被忽略（begin 1.0 / extend 0.1 不影响粗细一致）", () => {
    const s = resolveBrush({ size: 24, color: "#000", spacing: 0.15, preset: { sizeCoeff: 1.0 } });
    const doc = mkDoc();
    const eng = mkEngine("line");
    eng.beginStroke(doc.layers[0], s, 0, 0, 1.0, "brush");
    eng.extendStroke(300, 0, 0.1);
    const cs = eng.endStroke();
    const sizes = new Set(cs.stamps.map((t) => t.size.toFixed(6)));
    eq(sizes.size, 1, "全线一个粗细");
  });
});

describe("shape-brush · 三子工具几何→stamps", () => {
  it("line：stamps 共线（y 恒定）、覆盖起终点区间", () => {
    const s = resolveBrush({ size: 10, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = mkEngine("line");
    eng.beginStroke(doc.layers[0], s, 20, 100, 0.5, "brush");
    eng.extendStroke(480, 100, 0.5);
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 10);
    for (const st of cs.stamps) assert(Math.abs(st.y - 100) < 0.5, `共线 y=100，实得 ${st.y}`);
    const xs = cs.stamps.map((t) => t.x);
    assert(Math.min(...xs) < 30 && Math.max(...xs) > 470, "覆盖全程");
  });
  it("line + constrain：17° 拖拽吸到 15° 轴上", () => {
    const s = resolveBrush({ size: 10, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = mkEngine("line", true);
    const DEG = Math.PI / 180;
    eng.beginStroke(doc.layers[0], s, 0, 0, 0.5, "brush");
    eng.extendStroke(Math.cos(17 * DEG) * 400, Math.sin(17 * DEG) * 400, 0.5);
    const cs = eng.endStroke();
    for (const st of cs.stamps) {
      if (Math.hypot(st.x, st.y) < 5) continue;   // 起点附近角度不稳定
      const a = Math.atan2(st.y, st.x);
      assert(Math.abs(a - 15 * DEG) < 0.01, `吸到 15°，实得 ${a / DEG}°`);
    }
  });
  it("rect：stamps 的 AABB ≈ 拖出的矩形、四边都有点", () => {
    const s = resolveBrush({ size: 8, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = mkEngine("rect");
    eng.beginStroke(doc.layers[0], s, 100, 100, 0.5, "brush");
    eng.extendStroke(300, 200, 0.5);
    const cs = eng.endStroke();
    const xs = cs.stamps.map((t) => t.x), ys = cs.stamps.map((t) => t.y);
    assert(Math.abs(Math.min(...xs) - 100) < 2 && Math.abs(Math.max(...xs) - 300) < 2, "x 范围");
    assert(Math.abs(Math.min(...ys) - 100) < 2 && Math.abs(Math.max(...ys) - 200) < 2, "y 范围");
    // 四边都有点：每条边附近至少一颗
    assert(cs.stamps.some((t) => Math.abs(t.y - 100) < 1 && t.x > 150 && t.x < 250), "上边");
    assert(cs.stamps.some((t) => Math.abs(t.y - 200) < 1 && t.x > 150 && t.x < 250), "下边");
    assert(cs.stamps.some((t) => Math.abs(t.x - 100) < 1 && t.y > 120 && t.y < 180), "左边");
    assert(cs.stamps.some((t) => Math.abs(t.x - 300) < 1 && t.y > 120 && t.y < 180), "右边");
  });
  it("circle：整圈鼠绘（370°）→ stamps 成闭合环（到圆心距离恒定）", () => {
    const s = resolveBrush({ size: 10, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = mkEngine("circle");
    eng.beginStroke(doc.layers[0], s, 250 + 80, 250, 0.5, "brush");
    for (let i = 1; i <= 100; i++) {
      const a = (370 * (i / 100)) * Math.PI / 180;
      eng.extendStroke(250 + 80 * Math.cos(a), 250 + 80 * Math.sin(a), 0.5);
    }
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 20);
    for (const st of cs.stamps) {
      const r = Math.hypot(st.x - 250, st.y - 250);
      assert(Math.abs(r - 80) < 2, `环半径 80，实得 ${r}`);
    }
  });
  it("circle：半圆（180°）→ 出弧，不闭合（下半平面无 stamp）", () => {
    const s = resolveBrush({ size: 10, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = mkEngine("circle");
    eng.beginStroke(doc.layers[0], s, 250 + 80, 250, 0.5, "brush");
    for (let i = 1; i <= 60; i++) {
      const a = (180 * (i / 60)) * Math.PI / 180;
      eng.extendStroke(250 + 80 * Math.cos(a), 250 + 80 * Math.sin(a), 0.5);
    }
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 8);
    for (const st of cs.stamps) assert(st.y >= 250 - 2, `弧在上扫过的半平面（y≥250），实得 ${st.y}`);
    assert(cs.stamps.some((t) => t.y > 300), "弧顶存在");
  });
});

describe("shape-brush · 生命周期", () => {
  it("cancel（buffered）：无痕，collectStamps 归 null", () => {
    const s = resolveBrush({ size: 10, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = mkEngine("line");
    eng.beginStroke(doc.layers[0], s, 0, 0, 0.5, "brush");
    eng.extendStroke(100, 0, 0.5);
    assert(eng.collectStamps() !== null, "描边中有预览 stamps");
    eng.cancelStroke();
    eq(eng.collectStamps(), null);
    eq(eng.endStroke(), null);
    eq(paintedCount(doc.layers[0]), 0, "层上无像素");
  });
  it("pixelMode：每帧 restore（中间几何不残留），endStroke 后只剩最终直线", () => {
    const s = resolveBrush({ size: 3, color: "#000000", preset: { pixelMode: true } });
    const doc = mkDoc();
    const layer = doc.layers[0];
    const eng = mkEngine("line");
    eng.beginStroke(layer, s, 10, 10, 0.5, "brush");
    eng.extendStroke(10, 400, 0.5);      // 先拖一条竖线
    const midCount = paintedCount(layer);
    assert(midCount > 0, "描边中 in-place 落了像素");
    eng.extendStroke(400, 10, 0.5);      // 改拖横线 → 竖线应被 restore 擦掉
    eq(eng.endStroke(), null, "pixelMode endStroke 返 null（已 in-place）");
    const snap = layer.snapshotImageData();
    const d = snap.imageData.data;
    let vertLeft = 0;
    for (let y = 100; y < 400; y += 20) {   // 原竖线路径（x=10, y>100）不该再有像素
      const px = (Math.round(y - snap.bboxY) * snap.bboxW + Math.round(10 - snap.bboxX)) * 4 + 3;
      if (d[px] > 0) vertLeft++;
    }
    eq(vertLeft, 0, "中间几何（竖线）被擦净");
    assert(paintedCount(layer) > 0, "最终横线在");
  });
  it("pixelMode cancel：像素全还原", () => {
    const s = resolveBrush({ size: 3, color: "#000000", preset: { pixelMode: true } });
    const doc = mkDoc();
    const eng = mkEngine("rect");
    eng.beginStroke(doc.layers[0], s, 50, 50, 0.5, "brush");
    eng.extendStroke(200, 200, 0.5);
    assert(paintedCount(doc.layers[0]) > 0);
    eng.cancelStroke();
    eq(paintedCount(doc.layers[0]), 0, "cancel 无痕");
  });
  it("视口 rot=90°：rect 拖对角在 doc 里仍是矩形（roundtrip 由几何层保证，这里验链路接通）", () => {
    const s = resolveBrush({ size: 8, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = mkEngine("rect", false, Math.PI / 2);
    eng.beginStroke(doc.layers[0], s, 100, 100, 0.5, "brush");
    eng.extendStroke(300, 200, 0.5);
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 10, "rot 下正常出 stamps");
  });
});

describe("shape-brush · 像素模式特化（clamp + Bresenham exact-once）", () => {
  const pixBrush = (opacity = 1) =>
    resolveBrush({ size: 1, color: "#000000", opacity, preset: { pixelMode: true } });
  // 落层像素集合 {x,y → alpha}
  function painted(layer) {
    const s = layer.snapshotImageData();
    const m = new Map();
    if (!s.imageData) return m;
    const d = s.imageData.data;
    for (let j = 0; j < s.bboxH; j++) for (let i = 0; i < s.bboxW; i++) {
      const a = d[(j * s.bboxW + i) * 4 + 3];
      if (a > 0) m.set(`${i + s.bboxX},${j + s.bboxY}`, a);
    }
    return m;
  }
  it("端点 clamp：line(10.3,10.7)→(20.9,10.2) 全在 y=10 一行，每像素恰好一次", () => {
    const doc = mkDoc();
    const eng = mkEngine("line");
    eng.beginStroke(doc.layers[0], pixBrush(0.5), 10.3, 10.7, 0.5, "brush");
    eng.extendStroke(20.9, 10.2, 0.5);
    eng.endStroke();
    const m = painted(doc.layers[0]);
    eq(m.size, 11, "10..20 共 11 像素");
    const alphas = new Set(m.values());
    eq(alphas.size, 1, "alpha 全等 = 无双叠");
    for (const k of m.keys()) assert(k.endsWith(",10"), `全在 y=10 行：${k}`);
  });
  it("45° 约束：整数空间精确对角（|di|==|dj| 逐格）", () => {
    const doc = mkDoc();
    const eng = mkEngine("line", true);
    eng.beginStroke(doc.layers[0], pixBrush(), 5.2, 5.8, 0.5, "brush");
    eng.extendStroke(15.6, 16.9, 0.5);   // ≈47° → 吸 45°
    eng.endStroke();
    const m = painted(doc.layers[0]);
    for (const k of m.keys()) {
      const [x, y] = k.split(",").map(Number);
      eq(x - 5, y - 5, `对角逐格：${k}`);
    }
  });
  it("矩形周界：每像素恰好一次（alpha 全等）、角不重叠", () => {
    const doc = mkDoc();
    const eng = mkEngine("rect");
    eng.beginStroke(doc.layers[0], pixBrush(0.5), 3.4, 4.6, 0.5, "brush");
    eng.extendStroke(12.2, 10.9, 0.5);
    eng.endStroke();
    const m = painted(doc.layers[0]);
    eq(m.size, 2 * 10 + 2 * 7 - 4, "周界像素数 2w+2h-4");
    eq(new Set(m.values()).size, 1, "alpha 全等 = 角点无双叠");
  });
  it("像素圆 = AABB 拖拽 → bresenham 集合逐位一致，alpha 全等", () => {
    const doc = mkDoc();
    const eng = mkEngine("circle");
    eng.beginStroke(doc.layers[0], pixBrush(0.5), 10.2, 10.8, 0.5, "brush");
    eng.extendStroke(15.7, 20.3, 0.5);   // 拖一下中间几何（顺便验每帧 restore）
    eng.extendStroke(20.7, 16.3, 0.5);
    eng.endStroke();
    const m = painted(doc.layers[0]);
    const want = new Set(bresenhamEllipseRect(10, 10, 20, 16).map((p) => `${p.x - 0.5},${p.y - 0.5}`));
    eq(m.size, want.size, "像素数一致");
    for (const k of m.keys()) assert(want.has(k), `多余像素 ${k}`);
    eq(new Set(m.values()).size, 1, "alpha 全等 = 每像素恰好一次");
  });
  it("像素圆 constrain → 整数正方盒（painted bbox w==h）", () => {
    const doc = mkDoc();
    const eng = mkEngine("circle", true);
    eng.beginStroke(doc.layers[0], pixBrush(), 10.1, 10.1, 0.5, "brush");
    eng.extendStroke(24.9, 18.2, 0.5);
    eng.endStroke();
    const m = painted(doc.layers[0]);
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const k of m.keys()) {
      const [x, y] = k.split(",").map(Number);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    eq(x1 - x0, y1 - y0, "正方");
  });
  it("像素模式忽略视口旋转（rect 按 doc 轴）", () => {
    const doc = mkDoc();
    const eng = mkEngine("rect", false, Math.PI / 6);   // rot=30° 应被无视
    eng.beginStroke(doc.layers[0], pixBrush(), 5.5, 5.5, 0.5, "brush");
    eng.extendStroke(15.5, 12.5, 0.5);
    eng.endStroke();
    const m = painted(doc.layers[0]);
    eq(m.size, 2 * 11 + 2 * 8 - 4, "doc 轴周界像素数（斜了就对不上）");
  });
  it("非像素笔行为不变（连续坐标不 clamp）", () => {
    const s = resolveBrush({ size: 10, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = mkEngine("line", false, 0);
    eng.beginStroke(doc.layers[0], s, 10.3, 100.7, 0.5, "brush");
    eng.extendStroke(400.9, 100.7, 0.5);
    const cs = eng.endStroke();
    for (const st of cs.stamps) assert(Math.abs(st.y - 100.7) < 0.5, "y 保持 100.7 非 100.5");
  });
});
