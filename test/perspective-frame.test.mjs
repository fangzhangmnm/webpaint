// 透视 frame 纯函数层（ADR-0006）。
// 问题陈述：
//   - 两角点定四边形：角点精确保留、边分属两族（过 VP 共线 / 平行）。
//   - unit-square homography：四角精确、内点可逆往返。
//   - chart：远离地平线区 toDoc∘toPlane ≈ id；族线对齐坐标轴（famA 线上 v 恒定）；
//     ε 规则：pencil 枚举坐标（路宽）饱和不爆，parallel 枚举坐标（纵深）真发散、
//     过线 clamp +BIG 不翻负（不进另一张 manifold patch）。
//   - snapDirections 族清单随 VP 配置增减；normalizeConfig 排序+锁地平线。
import { describe, it, assert, eq } from "./runner.mjs";
const {
  planeFamilies, quadFromCorners, homographyUnitSquare, applyMat3, invertMat3,
  planeChart, snapDirections, snapToDirections, normalizeConfig, HORIZON_EPS,
} = await import("../src/perspective-frame.ts");

const close = (a, b, tol = 1e-6) => assert(Math.abs(a - b) <= tol, `${a} !~ ${b} (tol ${tol})`);
const collinear = (a, b, c, tol = 1e-6) =>
  assert(Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) <=
    tol * Math.max(1, Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - a.x, c.y - a.y)),
    "应共线");

const CFG0 = { vp1: null, vp2: null, vp3: null, lockHorizon: true, refPoint: null, plane: "off" };

describe("perspective-frame · 两角点定四边形", () => {
  const vp = { x: 100.5, y: -200.5 };
  const [famA, famB] = planeFamilies({ ...CFG0, vp1: vp, plane: "ground" });
  it("1 点地面：famA=pencil famB=水平", () => {
    eq(famA.kind, "pencil"); eq(famB.kind, "parallel"); eq(famB.dir.y, 0);
  });
  it("角点保留、p10 在 c1 的水平线上且与 c0-VP 共线", () => {
    const c0 = { x: 50, y: 50 }, c1 = { x: 150, y: 80 };
    const q = quadFromCorners(c0, c1, famA, famB);
    assert(q, "非病态");
    eq(q[0], c0); eq(q[2], c1);
    close(q[1].y, 80);                    // B(c1) 水平线
    collinear(c0, vp, q[1]);              // A(c0) 过 VP
    close(q[3].y, 50);
    collinear(c1, vp, q[3]);
  });
  it("角点撞 VP → null（病态护栏）", () => {
    eq(quadFromCorners({ x: 100.5, y: -200.5 }, { x: 1, y: 1 }, famA, famB), null);
  });
  it("两点地面：四边分属两个 pencil", () => {
    const cfg = { ...CFG0, vp1: { x: -300, y: 0 }, vp2: { x: 500, y: 0 }, plane: "ground" };
    const [fa, fb] = planeFamilies(cfg);
    const c0 = { x: 100, y: 200 }, c1 = { x: 180, y: 260 };
    const q = quadFromCorners(c0, c1, fa, fb);
    collinear(c0, fa.vp, q[1]);
    collinear(c1, fb.vp, q[1]);
  });
});

describe("perspective-frame · homography", () => {
  const q = [{ x: 10, y: 10 }, { x: 110, y: 30 }, { x: 90, y: 100 }, { x: 20, y: 80 }];
  const H = homographyUnitSquare(q);
  it("四角精确", () => {
    for (const [uv, p] of [[[0, 0], q[0]], [[1, 0], q[1]], [[1, 1], q[2]], [[0, 1], q[3]]]) {
      const m = applyMat3(H, uv[0], uv[1]);
      close(m.x, p.x); close(m.y, p.y);
    }
  });
  it("内点逆往返", () => {
    const Hi = invertMat3(H);
    const m = applyMat3(H, 0.3, 0.7);
    const back = applyMat3(Hi, m.x, m.y);
    close(back.x, 0.3); close(back.y, 0.7);
  });
  it("平行四边形（仿射）也对", () => {
    const qa = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 14, y: 8 }, { x: 4, y: 8 }];
    const Ha = homographyUnitSquare(qa);
    const m = applyMat3(Ha, 0.5, 0.5);
    close(m.x, 7); close(m.y, 4);
  });
});

describe("perspective-frame · chart 与 ε 护栏", () => {
  // 1 点地面：VP=(0,0)，地平线 y=0，画布在下方（y>0），anchor (0,100)
  const cfg = { ...CFG0, vp1: { x: 0, y: 0 }, plane: "ground" };
  const [famA, famB] = planeFamilies(cfg);
  const chart = planeChart(famA, famB, { x: 0, y: 100 });
  it("远离地平线：toDoc∘toPlane ≈ id", () => {
    for (const p of [{ x: 30, y: 120 }, { x: -50, y: 80 }, { x: 10, y: 300 }]) {
      const q = chart.toPlane(p);
      const back = chart.toDoc(q.x, q.y);
      assert(back, "应可逆");
      close(back.x, p.x, 1e-3); close(back.y, p.y, 1e-3);
    }
  });
  it("famA 线（过 VP 的射线）上 v 恒定；famB 线（水平线）上 u 恒定", () => {
    // 过 VP(0,0) 与 (50,100) 的射线上取两点
    const a1 = chart.toPlane({ x: 50, y: 100 });
    const a2 = chart.toPlane({ x: 25, y: 50 });
    close(a1.y, a2.y, 1e-6);
    const b1 = chart.toPlane({ x: -40, y: 150 });
    const b2 = chart.toPlane({ x: 70, y: 150 });
    close(b1.x, b2.x, 1e-6);   // u 枚举 famB（水平线）→ 同一水平线上 u 相同
  });
  // 坐标语义：u(.x) 枚举水平族 = 纵深（真发散）；v(.y) 枚举 pencil 射线 = 横向（饱和）。
  it("ε：横向（pencil 枚举，v=.y）饱和——贴地平线的两点横向相同（1/ε 不 1/z）", () => {
    const p1 = chart.toPlane({ x: 50, y: 1 });
    const p2 = chart.toPlane({ x: 50, y: 0.01 });
    close(p1.y, p2.y, 1e-6);   // 都按 w=ε 算
    assert(Number.isFinite(p1.y));
  });
  it("ε：纵深（parallel 枚举，u=.x）真发散、单调、过线 clamp 不翻负", () => {
    const uFar = chart.toPlane({ x: 0, y: 200 }).x;
    const uNear = chart.toPlane({ x: 0, y: 5 }).x;
    const uVeryNear = chart.toPlane({ x: 0, y: 0.05 }).x;
    const uPast = chart.toPlane({ x: 0, y: -10 }).x;
    assert(uNear > uFar, "越近地平线纵深越大");
    assert(uVeryNear > uNear);
    assert(uPast >= uVeryNear, "过线不回落、不翻负");
    assert(uPast <= 1e6 + 1, "clamp 在 +BIG");
  });
  it("wall 平面（VP×竖直）：竖直线上 u 恒定", () => {
    const cfgW = { ...CFG0, vp1: { x: 0, y: 0 }, plane: "wall" };
    const [fa, fb] = planeFamilies(cfgW);
    eq(fb.kind, "parallel"); eq(fb.dir.x, 0);
    const ch = planeChart(fa, fb, { x: 100, y: 100 });
    const p1 = ch.toPlane({ x: 100, y: 60 });
    const p2 = ch.toPlane({ x: 100, y: 140 });
    close(p1.x, p2.x, 1e-6);
  });
});

describe("perspective-frame · snap 方向 + 配置规范化", () => {
  it("0 VP → 水平+竖直；1 VP → +VP 方向；2 VP → 水平族退场；3 VP → 只剩 VP", () => {
    eq(snapDirections(CFG0, { x: 0, y: 0 }).length, 2);
    eq(snapDirections({ ...CFG0, vp1: { x: 100, y: 0 } }, { x: 0, y: 50 }).length, 3);
    const two = snapDirections({ ...CFG0, vp1: { x: -100, y: 0 }, vp2: { x: 100, y: 0 } }, { x: 0, y: 50 });
    eq(two.length, 3);   // vp1 + vp2 + 竖直
    const three = snapDirections({ ...CFG0, vp1: { x: -100, y: 0 }, vp2: { x: 100, y: 0 }, vp3: { x: 0, y: 500 } }, { x: 0, y: 50 });
    eq(three.length, 3);   // 平行族清零
  });
  it("snapToDirections：投影到最近方向（朝 VP 拖 → 贴 VP 线）", () => {
    const dirs = snapDirections({ ...CFG0, vp1: { x: 100, y: 0 } }, { x: 0, y: 100 });
    const s = snapToDirections(0, 100, 52, 49, dirs);   // 大致朝 VP(100,0) 方向
    collinear({ x: 0, y: 100 }, { x: 100, y: 0 }, s, 1e-6);
  });
  it("normalizeConfig：VP1/VP2 按 x 排序 + lockHorizon 锁 y", () => {
    const n = normalizeConfig({ ...CFG0, vp1: { x: 200, y: 10 }, vp2: { x: -100, y: 30 } });
    eq(n.vp1.x, -100); eq(n.vp2.x, 200);
    eq(n.vp2.y, 30 === n.vp1.y ? 30 : n.vp1.y);   // lock 开：vp2.y = vp1.y
    const free = normalizeConfig({ ...CFG0, lockHorizon: false, vp1: { x: 200, y: 10 }, vp2: { x: -100, y: 30 } });
    eq(free.vp2.y, 10);   // 排序后原 vp1(y=10) 成为右点，y 保留（可歪地平线）
  });
});
