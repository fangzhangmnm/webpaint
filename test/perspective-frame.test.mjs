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
  configFromModeState, planesForMode, defaultVpsForMode,
  boxAxesForMode, boxCorners, solveBoxDrag,
} = await import("../src/perspective-frame.ts");
const mod2 = await import("../src/perspective-frame.ts");

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

describe("perspective-frame · 模式映射（UI v2.2：per-mode 槽位分开存）", () => {
  const V = (x, y) => ({ x, y });
  const base = { lockHorizon: true, plane: "ground",
    p1: { vp1: V(1.5, 2.5) },
    p2: { vp1: V(1.5, 2.5), vp2: V(100.5, 2.5) },
    p3: { vp1: V(1.5, 2.5), vp2: V(100.5, 2.5), vp3: V(50.5, 900.5) } };
  it("off/缺 VP → null（视口对齐）", () => {
    eq(configFromModeState({ ...base, mode: "off" }), null);
    eq(configFromModeState({ ...base, mode: "p2", p2: { vp1: V(1, 2), vp2: null } }), null);
    eq(configFromModeState({ ...base, mode: "p3", p3: { ...base.p3, vp3: null } }), null);
  });
  it("各模式读各自槽位（一点不复用二点的数据）", () => {
    const st = { ...base, p1: { vp1: V(9.5, 8.5) } };
    const c1 = configFromModeState({ ...st, mode: "p1" });
    eq(c1.vp1.x, 9.5); eq(c1.vp2, null); eq(c1.vp3, null);
    const c2 = configFromModeState({ ...st, mode: "p2" });
    eq(c2.vp1.x, 1.5);   // p2 槽位，不受 p1 槽影响
    assert(c2.vp1 && c2.vp2); eq(c2.vp3, null);
    const c3 = configFromModeState({ ...st, mode: "p3" });
    assert(c3.vp1 && c3.vp2 && c3.vp3);
  });
  it("plane 不合法 → coerce ground（p1 拿到 wallL 之类）", () => {
    eq(configFromModeState({ ...base, mode: "p1", plane: "wallL" }).plane, "ground");
    eq(configFromModeState({ ...base, mode: "p2", plane: "wall" }).plane, "ground");
  });
  it("planesForMode 清单：p1=地板/墙；p2/p3=地板/左墙/右墙", () => {
    eq(JSON.stringify(planesForMode("p1")), JSON.stringify(["ground", "wall"]));
    eq(JSON.stringify(planesForMode("p2")), JSON.stringify(["ground", "wallL", "wallR"]));
    eq(JSON.stringify(planesForMode("off")), "[]");
  });
  it("默认位：p1 画布正中；p2 总间隔 2H（每侧 ±1H）；p3 +上方 1.5H（全在像素中线）", () => {
    const d1 = defaultVpsForMode("p1", 800, 600);
    eq(d1.vp1.x, 400.5); eq(d1.vp1.y, 300.5); eq(d1.vp2, null);
    const d2 = defaultVpsForMode("p2", 800, 600);
    eq(d2.vp1.x, Math.floor(400 - 600) + 0.5);
    eq(d2.vp2.x, Math.floor(400 + 600) + 0.5);
    eq(d2.vp1.y, 300.5);
    const d3 = defaultVpsForMode("p3", 800, 600);
    assert(d3.vp3.y < 0, "VP3 默认在画布上方（仰视）");
    eq(((d3.vp3.y % 1) + 1) % 1, 0.5, "负坐标也在像素中线格");
  });
});

describe("perspective-frame · 参考 box（UI v2.1，拖角反算 VP）", () => {
  const mkSt = () => ({
    mode: "p3", lockHorizon: true,
    vp1: { x: -600.5, y: 300.5 }, vp2: { x: 1400.5, y: 300.5 }, vp3: { x: 400.5, y: -900.5 },
    box: { A: { x: 300.5, y: 430.5 }, t: [0.25, 0.25, 0.25] },
  });
  it("boxCorners：8 角有限、A/B 沿轴、D 存在", () => {
    const st = mkSt();
    const axes = boxAxesForMode("p3", st.vp1, st.vp2, st.vp3);
    const cs = boxCorners(axes, st.box);
    assert(cs && cs.length === 8);
    for (const c of cs) assert(Number.isFinite(c.x) && Number.isFinite(c.y));
    // B1 在 A→VP1 线段上
    const t = (cs[1].x - st.box.A.x) / (st.vp1.x - st.box.A.x);
    assert(Math.abs(t - 0.25) < 1e-9, "B1 = A + 0.25·(VP1−A)");
  });
  it("solveBoxDrag：拖角收敛到目标附近、其余角不乱跑、VP 有限且 lock 保持", () => {
    const st = mkSt();
    const axes = boxAxesForMode("p3", st.vp1, st.vp2, st.vp3);
    const before = boxCorners(axes, st.box);
    const target = { x: before[7].x + 12, y: before[7].y - 8 };   // 拖 D 角
    const out = solveBoxDrag(st, 7, target);
    const axes2 = boxAxesForMode("p3", out.vp1, out.vp2, out.vp3);
    const after = boxCorners(axes2, out.box);
    assert(after, "解后 box 仍可构造");
    const dDrag = Math.hypot(after[7].x - target.x, after[7].y - target.y);
    assert(dDrag < 4, `拖角贴目标，实差 ${dDrag.toFixed(2)}px`);
    let maxOther = 0;
    for (let k = 0; k < 7; k++) maxOther = Math.max(maxOther, Math.hypot(after[k].x - before[k].x, after[k].y - before[k].y));
    assert(maxOther < 40, `其余角小幅让步，实最大 ${maxOther.toFixed(1)}px`);
    assert(Math.abs(out.vp2.y - out.vp1.y) < 1e-6, "lockHorizon 保持");
    for (const v of [out.vp1, out.vp2, out.vp3]) assert(Number.isFinite(v.x) && Number.isFinite(v.y));
  });
  it("solveBoxDrag：弱透视（VP 很远）拖角把 VP 拉近/推远而不炸", () => {
    const st = { mode: "p2", lockHorizon: true,
      vp1: { x: -20000.5, y: 300.5 }, vp2: { x: 20000.5, y: 300.5 }, vp3: null,
      box: { A: { x: 300.5, y: 430.5 }, t: [0.02, 0.02, -180] } };
    const axes = boxAxesForMode("p2", st.vp1, st.vp2, null);
    const before = boxCorners(axes, st.box);
    const out = solveBoxDrag(st, 4, { x: before[4].x + 6, y: before[4].y + 10 });   // 拖 C12
    assert(Number.isFinite(out.vp1.x) && Number.isFinite(out.vp2.x));
    const axes2 = boxAxesForMode("p2", out.vp1, out.vp2, null);
    assert(boxCorners(axes2, out.box), "仍可构造");
  });
  it("p1/p2 模式的轴族形态", () => {
    const a1 = boxAxesForMode("p1", { x: 0.5, y: 0.5 }, null, null);
    eq(a1[0].kind, "pencil"); eq(a1[1].kind, "parallel"); eq(a1[2].kind, "parallel");
    eq(boxAxesForMode("p2", { x: 0.5, y: 0.5 }, null, null), null);   // 缺 vp2
  });
});

describe("perspective-frame · 平面欧氏度量（UI v2.4：正方/正圆 respect 透视）", () => {
  const { planeMetric, constrainSquareOnPlane, metricCirclePolyline } = mod2;
  const CFG2 = { vp1: { x: -600.5, y: 300.5 }, vp2: { x: 1400.5, y: 300.5 }, vp3: null, lockHorizon: true, plane: "ground" };
  const [fa2, fb2] = mod2.planeFamilies(CFG2);
  it("二点：主点=画布中心投影、d²=s(len−s)>0；U⊥V；project∘unproject=id", () => {
    const m = planeMetric(CFG2, fa2, fb2, { x: 300, y: 450 }, 800, 600);
    assert(m, "度量可实现");
    const dotUV = m.U[0] * m.V[0] + m.U[1] * m.V[1] + m.U[2] * m.V[2];
    assert(Math.abs(dotUV) < 1e-9, "U⊥V");
    const P = m.unproject({ x: 350, y: 420 });
    assert(P, "画布下方点可落平面");
    const back = m.project(P);
    assert(Math.abs(back.x - 350) < 1e-6 && Math.abs(back.y - 420) < 1e-6, "往返恒等");
    eq(m.unproject({ x: 300, y: 200 }), null, "越地平线（y<300 远处）→ null 不进另一 patch");
  });
  it("constrainSquareOnPlane：调整后平面内 |du|==|dv|", () => {
    const m = planeMetric(CFG2, fa2, fb2, { x: 300, y: 450 }, 800, 600);
    const adj = constrainSquareOnPlane(m, { x: 420, y: 400 });
    assert(adj, "可调整");
    const C = m.unproject(adj);
    const off = [C[0] - m.A3[0], C[1] - m.A3[1], C[2] - m.A3[2]];
    const du = off[0] * m.U[0] + off[1] * m.U[1] + off[2] * m.U[2];
    const dv = off[0] * m.V[0] + off[1] * m.V[1] + off[2] * m.V[2];
    assert(Math.abs(Math.abs(du) - Math.abs(dv)) < 1e-6, `|du|=${Math.abs(du).toFixed(3)} == |dv|=${Math.abs(dv).toFixed(3)}`);
  });
  it("metricCirclePolyline：采样点在平面上到圆心等距（真欧氏圆）", () => {
    const m = planeMetric(CFG2, fa2, fb2, { x: 300, y: 450 }, 800, 600);
    const pts = metricCirclePolyline(m, { x: 380, y: 430 }, 48);
    assert(pts.length > 40);
    const B = m.unproject({ x: 380, y: 430 });
    const R = Math.hypot(B[0] - m.A3[0], B[1] - m.A3[1], B[2] - m.A3[2]);
    for (const q of pts) {
      const P = m.unproject(q);
      assert(P, "环上点都在平面前侧");
      const r = Math.hypot(P[0] - m.A3[0], P[1] - m.A3[1], P[2] - m.A3[2]);
      assert(Math.abs(r - R) < R * 0.01, `等距 ${r.toFixed(2)} vs ${R.toFixed(2)}`);
    }
  });
  it("三点：默认 VP 布局的垂心度量可实现（d²>0）", () => {
    const d3 = defaultVpsForMode("p3", 800, 600);
    const CFG3 = { vp1: d3.vp1, vp2: d3.vp2, vp3: d3.vp3, lockHorizon: true, plane: "ground" };
    const [fa3, fb3] = mod2.planeFamilies(CFG3);
    const m = planeMetric(CFG3, fa3, fb3, { x: 400, y: 500 }, 800, 600);
    assert(m, "p3 默认布局度量可实现");
  });
  it("一点：P0=VP、d=H 约定可用", () => {
    const CFG1 = { vp1: { x: 400.5, y: 300.5 }, vp2: null, vp3: null, lockHorizon: true, plane: "ground" };
    const [fa1, fb1] = mod2.planeFamilies(CFG1);
    const m = planeMetric(CFG1, fa1, fb1, { x: 200, y: 500 }, 800, 600);
    assert(m);
    const P = m.unproject({ x: 250, y: 480 });
    assert(P && m.project(P));
  });
});
