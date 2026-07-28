// isometric 透视模式（v0.6.20，2:1 像素惯例）：纯平行三轴、零奇点、仿射度量。
// 问题陈述：
//   - configFromModeState("iso") → axes 配置（无 VP）；三平面 = 顶/左/右。
//   - quadFromCorners 全仿射：任意拖拽无翻面（平行×平行无消失线）。
//   - planeMetric 仿射实现：project∘unproject ≈ id；正方 |du|==|dv|；正圆 = 世界圆的像。
//   - box：全平行轴的 boxCorners = 平行六面体；remapShapePersp 带 iso box。
import { describe, it, assert, eq } from "./runner.mjs";
const pf = await import("../src/perspective-frame.ts");
const {
  configFromModeState, planesForMode, planeFamilies, quadFromCorners, snapDirections,
  planeMetric, constrainSquareOnPlane, metricCirclePolyline, boxAxesForMode, boxCorners, ISO_AXES,
} = pf;

const close = (a, b, tol = 1e-6) => assert(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const GISO = { mode: "iso", lockHorizon: true, plane: "ground",
  p1: { vp1: null }, p2: { vp1: null, vp2: null }, p3: { vp1: null, vp2: null, vp3: null } };

describe("iso · 配置与平面", () => {
  it("configFromModeState(iso) → axes 配置、无 VP、plane coerce", () => {
    const cfg = configFromModeState({ ...GISO, plane: "wall" });   // wall 不在 iso 清单 → coerce ground
    assert(cfg && cfg.axes, "axes 在");
    eq(cfg.vp1, null); eq(cfg.plane, "ground");
    eq(planesForMode("iso").join(","), "ground,wallL,wallR");
  });
  it("三平面族配对：ground=轴1×轴2 / wallL=轴2×竖直 / wallR=轴1×竖直", () => {
    const mk = (plane) => planeFamilies(configFromModeState({ ...GISO, plane }));
    const g = mk("ground"), l = mk("wallL"), r = mk("wallR");
    assert(g && l && r);
    close(g[0].dir.x, 2 / Math.sqrt(5)); close(g[1].dir.x, -2 / Math.sqrt(5));
    close(l[1].dir.y, 1); close(l[1].dir.x, 0);
    close(r[0].dir.x, 2 / Math.sqrt(5)); close(r[1].dir.y, 1);
  });
  it("snapDirections(iso) = 恰好三轴方向", () => {
    const cfg = configFromModeState(GISO);
    const dirs = snapDirections(cfg, { x: 100, y: 100 });
    eq(dirs.length, 3);
  });
});

describe("iso · 两角定形（全仿射零奇点）", () => {
  const cfg = configFromModeState(GISO);
  const [famA, famB] = planeFamilies(cfg);
  it("ground 拉矩形 = 平行四边形（对边平行、角点精确）", () => {
    const c0 = { x: 100, y: 300 }, c1 = { x: 260, y: 220 };
    const q = quadFromCorners(c0, c1, famA, famB);
    assert(q);
    eq(q[0], c0); eq(q[2], c1);
    // 对边向量相等（平行四边形判据）
    close(q[1].x - q[0].x, q[2].x - q[3].x, 1e-6);
    close(q[1].y - q[0].y, q[2].y - q[3].y, 1e-6);
  });
  it("任意方向长距离拖拽：恒有 quad、全有限（无翻面/无 null——平行族无消失线）", () => {
    const c0 = { x: 256, y: 256 };
    for (const c1 of [{ x: 5000, y: -4000 }, { x: -3000, y: 6000 }, { x: 256, y: -9999 }]) {
      const q = quadFromCorners(c0, c1, famA, famB);
      assert(q, `c1=(${c1.x},${c1.y}) 不该 null`);
      for (const p of q) assert(Number.isFinite(p.x) && Number.isFinite(p.y));
    }
  });
});

describe("iso · 仿射度量（正方/正圆）", () => {
  const cfg = configFromModeState(GISO);
  const [famA, famB] = planeFamilies(cfg);
  const anchor = { x: 200, y: 200 };
  const m = planeMetric(cfg, famA, famB, anchor, 512, 512);
  it("度量存在；project∘unproject ≈ id", () => {
    assert(m, "iso 平面度量应存在（仿射实现）");
    for (const q of [{ x: 240, y: 180 }, { x: 100, y: 300 }, { x: 205, y: 201 }]) {
      const P = m.unproject(q);
      assert(P, "仿射 unproject 恒有解");
      const back = m.project(P);
      close(back.x, q.x, 1e-6); close(back.y, q.y, 1e-6);
    }
  });
  it("constrainSquareOnPlane：调整后平面坐标 |du|==|dv|", () => {
    const adj = constrainSquareOnPlane(m, { x: 260, y: 190 });
    assert(adj);
    const P = m.unproject(adj);
    close(Math.abs(P[0]), Math.abs(P[1]), 1e-6);
  });
  it("metricCirclePolyline：世界等距圆的像（每采样点 unproject 后半径恒定）", () => {
    const pts = metricCirclePolyline(m, { x: 260, y: 190 }, 32);
    assert(pts.length >= 32, "平行投影无背面，采样全保留");
    const R0 = Math.hypot(...m.unproject(pts[0]).slice(0, 2));
    for (const q of pts) {
      const P = m.unproject(q);
      close(Math.hypot(P[0], P[1]), R0, 1e-6);
    }
  });
  it("ground 度量各向同性（|d1单位|==|d2单位|）：世界正方是屏幕菱形，对角线比 2:1", () => {
    // 世界 (±1,±1) 四角 → 屏幕菱形：水平对角 8px、竖直对角 4px（单位立方顶面 4×2 的 2 倍）
    const c = [m.project([1, 1, 0]), m.project([-1, 1, 0]), m.project([-1, -1, 0]), m.project([1, -1, 0])];
    const wSpan = Math.max(...c.map((p) => p.x)) - Math.min(...c.map((p) => p.x));
    const hSpan = Math.max(...c.map((p) => p.y)) - Math.min(...c.map((p) => p.y));
    close(wSpan / hSpan, 2, 1e-6);
  });
});

describe("iso · 参考 box 与重映射", () => {
  it("boxCorners(ISO_AXES) = 平行六面体：D = A + t1·d1 + t2·d2 + t3·d3", () => {
    eq(boxAxesForMode("iso", null, null, null), ISO_AXES);
    const A = { x: 100.5, y: 300.5 };
    const t = [50, 40, -60];
    const cs = boxCorners(ISO_AXES, { A, t });
    assert(cs);
    const d = ISO_AXES.map((f) => f.dir);
    const ex = { x: A.x + t[0] * d[0].x + t[1] * d[1].x + t[2] * d[2].x,
                 y: A.y + t[0] * d[0].y + t[1] * d[1].y + t[2] * d[2].y };
    close(cs[7].x, ex.x, 1e-6); close(cs[7].y, ex.y, 1e-6);
  });
  it("remapShapePersp：iso box 锚点随 crop 平移", async () => {
    const ws = await import("../src/workbench-state.ts");
    ws.editorState.persp.mode = "iso";
    ws.editorState.persp.iso.box = { A: { x: 100.5, y: 200.5 }, t: [50, 50, -50] };
    ws.remapShapePersp((p) => ({ x: p.x - 30, y: p.y - 20 }));
    const b = ws.editorState.persp.iso.box;
    close(b.A.x, 70.5); close(b.A.y, 180.5);
    ws.editorState.persp.iso.box = null;
    ws.editorState.persp.mode = "off";
  });
});
