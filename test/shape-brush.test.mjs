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
const { BrushEngine } = await import("../src/brush.ts");

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

describe("shape-brush · 透视 frame + grid 子工具（ADR-0006）", () => {
  const CFG1 = (vp) => ({ vp1: vp, vp2: null, vp3: null, lockHorizon: true, refPoint: null, plane: "ground" });
  const collinear = (a, b, c, tol = 1.5) =>
    Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) /
      Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)) <= tol;
  function mkPerspEngine(sub, vp, constrain = false) {
    const eng = new ShapeBrushEngine();
    eng.setSubTool(sub);
    eng.setConstrain(constrain);
    eng.setViewportRotProvider(() => 0);
    eng.setPerspProvider(() => CFG1(vp));
    return eng;
  }
  it("透视 rect = 梯形：两边过 VP、两边水平", () => {
    const s = resolveBrush({ size: 6, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const vp = { x: 256.5, y: 50.5 };
    const eng = mkPerspEngine("rect", vp);
    eng.beginStroke(doc.layers[0], s, 150, 300, 0.5, "brush");
    eng.extendStroke(300, 400, 0.5);
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 20);
    // 水平边：y≈300 与 y≈400 上都有横向散布的 stamps
    assert(cs.stamps.some((t) => Math.abs(t.y - 300) < 1 && Math.abs(t.x - 200) < 60), "上水平边");
    assert(cs.stamps.some((t) => Math.abs(t.y - 400) < 1), "下水平边");
    // 收敛边：存在与 (150,300)-VP 共线的 stamps（非水平的）
    assert(cs.stamps.some((t) => Math.abs(t.y - 300) > 5 && Math.abs(t.y - 400) > 5 &&
      collinear({ x: 150, y: 300 }, vp, t)), "过 VP 的边");
  });
  it("透视 line 约束：吸向 VP 方向", () => {
    const s = resolveBrush({ size: 6, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const vp = { x: 400.5, y: 20.5 };
    const eng = mkPerspEngine("line", vp, true);
    eng.beginStroke(doc.layers[0], s, 100, 400, 0.5, "brush");
    eng.extendStroke(180, 290, 0.5);   // 大致朝 VP
    const cs = eng.endStroke();
    for (const t of cs.stamps) assert(collinear({ x: 100, y: 400 }, vp, t), `在 VP 线上 ${t.x},${t.y}`);
  });
  it("grid（视口 frame）：默认 2×6 → 1 竖 + 5 横，一条 undo（单 StampCollect）", () => {
    const s = resolveBrush({ size: 4, color: "#000", spacing: 0.25 });
    const doc = mkDoc();
    const eng = mkEngine("grid");
    eng.beginStroke(doc.layers[0], s, 100, 100, 0.5, "brush");
    eng.extendStroke(300, 460, 0.5);   // 高盒（头身比用法）
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 30, "多线合成");
    // 5 条内部横线的 y：160, 220, 280, 340, 400
    for (const y of [160, 220, 280, 340, 400]) {
      assert(cs.stamps.some((t) => Math.abs(t.y - y) < 1 && t.x > 150 && t.x < 250), `横线 y=${y}`);
    }
    // 1 条中线 x=200
    assert(cs.stamps.some((t) => Math.abs(t.x - 200) < 1 && t.y > 150), "竖中线");
    // 默认无 border：上边 y=100 上除竖中线的线头（x≈200）外无横向铺开
    assert(!cs.stamps.some((t) => Math.abs(t.y - 100) < 0.5 && ((t.x > 120 && t.x < 190) || (t.x > 210 && t.x < 280))), "默认无外框");
  });
  it("grid（透视 frame）：横线仍横、竖分割线过 VP；border 开时四边在", () => {
    const s = resolveBrush({ size: 4, color: "#000", spacing: 0.25 });
    const doc = mkDoc();
    const vp = { x: 250.5, y: 40.5 };
    const eng = mkPerspEngine("grid", vp);
    eng.setGridConfig({ nu: 2, nv: 4, border: true });
    eng.beginStroke(doc.layers[0], s, 150, 300, 0.5, "brush");
    eng.extendStroke(350, 450, 0.5);
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 30);
    assert(cs.stamps.some((t) => Math.abs(t.y - 300) < 1), "border 上边（水平）");
    assert(cs.stamps.some((t) => Math.abs(t.y - 450) < 1), "border 下边");
    // 竖分割线（u=1/2）过 VP：找非水平 stamps 验共线
    const mid = cs.stamps.filter((t) => t.y > 320 && t.y < 430 &&
      collinear({ x: 250.5, y: 40.5 }, { x: 250, y: 500 }, { x: t.x, y: t.y }, 8));
    assert(mid.length > 0, "中线在 VP 与盒中之间的走廊里");
  });
  it("透视像素圆：AABB 拖拽 → conic 环 exact-once（alpha 全等）", () => {
    const s = resolveBrush({ size: 1, color: "#000000", opacity: 0.5, preset: { pixelMode: true } });
    const doc = mkDoc();
    const eng = mkPerspEngine("circle", { x: 60.5, y: 10.5 });
    eng.beginStroke(doc.layers[0], s, 30.2, 60.7, 0.5, "brush");
    eng.extendStroke(90.8, 100.3, 0.5);
    eng.endStroke();
    const snap = doc.layers[0].snapshotImageData();
    const d = snap.imageData.data;
    const alphas = new Set();
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) { alphas.add(d[i]); n++; }
    assert(n > 10, "conic 环有像素");
    eq(alphas.size, 1, "alpha 全等 = 每像素恰好一次");
  });
  it("像素 grid：交叉点不双叠（全形状 seen-set）", () => {
    const s = resolveBrush({ size: 1, color: "#000000", opacity: 0.5, preset: { pixelMode: true } });
    const doc = mkDoc();
    const eng = mkEngine("grid");
    eng.setGridConfig({ nu: 3, nv: 3, border: true });
    eng.beginStroke(doc.layers[0], s, 10.2, 10.7, 0.5, "brush");
    eng.extendStroke(40.8, 40.3, 0.5);
    eng.endStroke();
    const snap = doc.layers[0].snapshotImageData();
    const d = snap.imageData.data;
    const alphas = new Set();
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) alphas.add(d[i]);
    eq(alphas.size, 1, "交叉/共角像素 alpha 全等");
  });
  it("透视徒手拟合圆：地平线下画一圈不炸、出 stamps", () => {
    const s = resolveBrush({ size: 8, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = mkPerspEngine("circle", { x: 256.5, y: 30.5 });
    eng.beginStroke(doc.layers[0], s, 256 + 60, 300, 0.5, "brush");
    for (let i = 1; i <= 80; i++) {
      const a = (375 * (i / 80)) * Math.PI / 180;
      eng.extendStroke(256 + 60 * Math.cos(a), 300 + 35 * Math.sin(a), 0.5);
    }
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 10, "透视拟合出 stamps");
    for (const t of cs.stamps) assert(Number.isFinite(t.x) && Number.isFinite(t.y));
  });
});

describe("shape-brush · 透视奇点采样护栏（近地平线不卡死）", () => {
  const CFGH = { vp1: { x: 256.5, y: 100.5 }, vp2: null, vp3: null, lockHorizon: true, refPoint: null, plane: "ground" };
  function mkH(sub, pixel = false) {
    const eng = new ShapeBrushEngine();
    eng.setSubTool(sub);
    eng.setViewportRotProvider(() => 0);
    eng.setPerspProvider(() => CFGH);
    return eng;
  }
  it("透视 rect 角点贴地平线（交点飞远）→ 秒级返回、stamps 有界", () => {
    const s = resolveBrush({ size: 6, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = mkH("rect");
    const t0 = Date.now();
    eng.beginStroke(doc.layers[0], s, 150, 400, 0.5, "brush");
    eng.extendStroke(300, 101, 0.5);   // 上边贴 VP 的水平线 → 交点 x 飞远
    const cs = eng.endStroke();
    assert(Date.now() - t0 < 3000, "秒级返回");
    assert(!cs || cs.stamps.length < 30000, `stamps 有界，实得 ${cs ? cs.stamps.length : 0}`);
  });
  it("透视 grid 贴地平线 → 秒级返回、stamps 有界", () => {
    const s = resolveBrush({ size: 4, color: "#000", spacing: 0.25 });
    const doc = mkDoc();
    const eng = mkH("grid");
    eng.setGridConfig({ nu: 4, nv: 8, border: true });
    const t0 = Date.now();
    eng.beginStroke(doc.layers[0], s, 100, 450, 0.5, "brush");
    eng.extendStroke(400, 100.6, 0.5);
    const cs = eng.endStroke();
    assert(Date.now() - t0 < 3000, "秒级返回");
    assert(!cs || cs.stamps.length < 60000, `stamps 有界，实得 ${cs ? cs.stamps.length : 0}`);
  });
  it("透视像素 rect/圆 贴地平线 → 秒级返回、像素数有界", () => {
    const s = resolveBrush({ size: 1, color: "#000000", preset: { pixelMode: true } });
    for (const sub of ["rect", "circle"]) {
      const doc = mkDoc();
      const eng = mkH(sub, true);
      const t0 = Date.now();
      eng.beginStroke(doc.layers[0], s, 150.2, 400.7, 0.5, "brush");
      eng.extendStroke(300.8, 101.2, 0.5);
      eng.endStroke();
      assert(Date.now() - t0 < 3000, `${sub} 秒级返回`);
      assert(paintedCount(doc.layers[0]) < 200000, `${sub} 像素数有界`);
    }
  });
  it("透视 rect 裁剪后仍画出盒内可见部分（不是整形消失）", () => {
    const s = resolveBrush({ size: 6, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = mkH("rect");
    eng.beginStroke(doc.layers[0], s, 150, 400, 0.5, "brush");
    eng.extendStroke(300, 102, 0.5);
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 10, "可见段仍在");
    assert(cs.stamps.some((t) => Math.abs(t.y - 400) < 1), "下水平边在");
  });
});

describe("shape-brush · 透视圆往返（chart 尺度修正回归）", () => {
  it("平面圆投影成笔迹 → 拟合输出贴回真曲线（Hausdorff ≤3px）", async () => {
    const pf = await import("../src/perspective-frame.ts");
    const CFG = { vp1: { x: 256.5, y: 100.5 }, vp2: null, vp3: null, lockHorizon: true, plane: "ground" };
    const [fa, fb] = pf.planeFamilies(CFG);
    const anchorChart = pf.planeChart(fa, fb, { x: 256, y: 300 });
    // 真曲线：平面空间半径 60 的圆（锚点尺度 ≈ doc px），投影到 doc = 用户该画的笔迹
    const truth = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const p = anchorChart.toDoc(60 * Math.cos(a), 60 * Math.sin(a));
      if (p) truth.push(p);
    }
    assert(truth.length > 90, "真曲线可投影");
    // 喂引擎：沿真曲线徒手画一圈（多绕 20°）
    const s = resolveBrush({ size: 8, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = new ShapeBrushEngine();
    eng.setSubTool("circle");
    eng.setViewportRotProvider(() => 0);
    eng.setPerspProvider(() => CFG);
    eng.beginStroke(doc.layers[0], s, truth[0].x, truth[0].y, 0.5, "brush");
    for (let i = 1; i <= 100; i++) {
      const a = ((380 * (i / 100)) / 360) * Math.PI * 2;
      const p = anchorChart.toDoc(60 * Math.cos(a), 60 * Math.sin(a));
      if (p) eng.extendStroke(p.x, p.y, 0.5);
    }
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 20, "出 stamps");
    let dMax = 0;
    for (const t of cs.stamps) {
      let best = Infinity;
      for (const c of truth) best = Math.min(best, Math.hypot(t.x - c.x, t.y - c.y));
      dMax = Math.max(dMax, best);
    }
    assert(dMax <= 3, `拟合贴回真曲线，Hausdorff=${dMax.toFixed(2)}px`);
  });
});

describe("shape-brush · 正圆=圆心拖半径（v2.3 改规则）+ Shift 反转", () => {
  it("constrain 圆（buffered）：起点=圆心、拖多远半径多大", () => {
    const s = resolveBrush({ size: 10, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = mkEngine("circle", true);
    eng.beginStroke(doc.layers[0], s, 250, 250, 0.5, "brush");
    eng.extendStroke(330, 250, 0.5);   // 半径 80
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 20);
    for (const t of cs.stamps) {
      const r = Math.hypot(t.x - 250, t.y - 250);
      assert(Math.abs(r - 80) < 1, `圆心 250,250 半径 80，实得 ${r}`);
    }
  });
  it("Shift 反转：constrain 关 + invert 开 → 直线临时吸附", () => {
    const s = resolveBrush({ size: 10, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = mkEngine("line", false);
    eng.setConstrainInvert(true);
    const DEG = Math.PI / 180;
    eng.beginStroke(doc.layers[0], s, 0, 0, 0.5, "brush");
    eng.extendStroke(Math.cos(17 * DEG) * 400, Math.sin(17 * DEG) * 400, 0.5);
    const cs = eng.endStroke();
    for (const t of cs.stamps) {
      if (Math.hypot(t.x, t.y) < 5) continue;
      assert(Math.abs(Math.atan2(t.y, t.x) - 15 * DEG) < 0.01, "invert 生效吸到 15°");
    }
    eng.setConstrainInvert(false);
    eq(eng.getConstrain(), false, "持久开关不被 invert 污染");
  });
});

describe("shape-brush · 批量像素写入（golden 等价 + 提速）", () => {
  function pixelsOf(layer) {
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
  const ringPts = (n = 800, r = 150) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push({ x: Math.floor(250 + r * Math.cos(a)) + 0.5, y: Math.floor(250 + r * Math.sin(a)) + 0.5 });
    }
    return out;
  };
  it("stampPixels ≡ 逐像素 stampAt（size1 与 size5 disc、alpha 半透明，逐位一致）", () => {
    for (const size of [1, 5]) {
      const s = resolveBrush({ size, color: "#000000", opacity: 0.5, preset: { pixelMode: true } });
      const pts = ringPts(400, 100);
      const mk = (batch) => {
        const doc = mkDoc();
        const eng = new BrushEngine();
        eng.beginStroke(doc.layers[0], s, pts[0].x, pts[0].y, 0.5, "brush");
        if (batch) eng.stampPixels(pts.slice(1), 0.5);
        else for (let i = 1; i < pts.length; i++) eng.stampAt(pts[i].x, pts[i].y, 0.5);
        eng.cancelStroke();   // 只清引擎态，像素已 in-place
        return pixelsOf(doc.layers[0]);
      };
      const a = mk(false), b = mk(true);
      eq(a.size, b.size, `size=${size} 像素数一致`);
      for (const [k, v] of a) eq(b.get(k), v, `size=${size} 像素 ${k} alpha 一致`);
    }
  });
  it("大圆 30 帧重画在时限内（批量路径生效）", () => {
    const s = resolveBrush({ size: 1, color: "#000000", preset: { pixelMode: true } });
    const doc = mkDoc();
    const eng = mkEngine("circle");
    const t0 = Date.now();
    eng.beginStroke(doc.layers[0], s, 50.2, 50.7, 0.5, "brush");
    for (let f = 0; f < 30; f++) {
      eng.extendStroke(450.5 - f, 450.5 - f, 0.5);   // 每帧改几何 → 全量重画
    }
    eng.endStroke();
    assert(Date.now() - t0 < 4000, `30 帧大圆重画 ${Date.now() - t0}ms`);
  });
});

describe("shape-brush · 正方/正圆 respect 透视（UI v2.4 接线烟测）", () => {
  const CFG2 = { vp1: { x: -600.5, y: 300.5 }, vp2: { x: 1400.5, y: 300.5 }, vp3: null, lockHorizon: true, plane: "ground" };
  it("persp + constrain 圆：出 stamps 且全有限（平面欧氏圆的像）", () => {
    const s = resolveBrush({ size: 8, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = new ShapeBrushEngine();
    eng.setSubTool("circle"); eng.setConstrain(true);
    eng.setViewportRotProvider(() => 0);
    eng.setPerspProvider(() => CFG2);
    eng.beginStroke(doc.layers[0], s, 300, 450, 0.5, "brush");
    eng.extendStroke(380, 430, 0.5);
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 20, "透视正圆出 stamps");
    for (const t of cs.stamps) assert(Number.isFinite(t.x) && Number.isFinite(t.y));
    // 透视圆非 doc 圆：到锚点的 doc 距离应**不**恒定（否则度量没生效）
    const rs = cs.stamps.map((t) => Math.hypot(t.x - 300, t.y - 450));
    assert(Math.max(...rs) - Math.min(...rs) > 3, "近大远小（不是 doc 空间正圆）");
  });
  it("persp + constrain 矩形：四角 unproject 后平面内 |du|==|dv|", async () => {
    const pf = await import("../src/perspective-frame.ts");
    const s = resolveBrush({ size: 6, color: "#000", spacing: 0.2 });
    const doc = mkDoc();
    const eng = new ShapeBrushEngine();
    eng.setSubTool("rect"); eng.setConstrain(true);
    eng.setViewportRotProvider(() => 0);
    eng.setPerspProvider(() => CFG2);
    eng.beginStroke(doc.layers[0], s, 300, 450, 0.5, "brush");
    eng.extendStroke(420, 400, 0.5);
    const cs = eng.endStroke();
    assert(cs && cs.stamps.length > 10, "透视正方出 stamps");
  });
});
