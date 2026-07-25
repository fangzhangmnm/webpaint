// 形状笔几何层（ADR-0005）。
// 问题陈述：
//   - 直线吸附：画布相对 15°，snap 后投影（跟手），0/45/90 与负象限精确。
//   - 矩形：视口相对（rot 下 roundtrip），constrain = 屏幕系正方。
//   - 圆/弧拟合：AABB 极值点 = 边界（max 范数哲学）；正圆半径取 max；
//     winding：355°→弧（留口）、375°→闭合（过冲）、半圆、反向绕行。
//   - 采样：闭合首==末、段长 ≤ maxSegLen、椭圆 n ∈ [24,512]。
import { describe, it, assert, eq } from "./runner.mjs";
const {
  snapLineEnd, rectCorners, fitEllipse, rotatePt,
  linePolyline, rectPolyline, ellipseArcPolyline, maxSegLenFor, perimeterRamanujan,
} = await import("../src/shape-geometry.ts");

const DEG = Math.PI / 180;
const close = (a, b, tol = 1e-9) => assert(Math.abs(a - b) <= tol, `${a} !~ ${b}`);

// 圆周点列生成器（拟合测试输入）：中心 (cx,cy)、半径 r、从 a0 扫 sweepDeg
function circlePts(cx, cy, r, a0Deg, sweepDeg, n = 200) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (a0Deg + (sweepDeg * i) / n) * DEG;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

describe("shape-geometry: 直线吸附", () => {
  it("正好 45° 不动", () => {
    const p = snapLineEnd(0, 0, 10, 10);
    close(p.x, 10, 1e-9); close(p.y, 10, 1e-9);
  });
  it("接近 0° 吸到水平，投影跟手（x 分量保留）", () => {
    const p = snapLineEnd(0, 0, 100, 3);
    close(p.y, 0, 1e-9); close(p.x, 100, 1e-9);   // 投影 = dx·cos0 + dy·sin0 = 100
  });
  it("负象限：接近 -90° 吸到竖直向上", () => {
    const p = snapLineEnd(0, 0, 2, -50);
    close(p.x, 0, 1e-9); close(p.y, -50, 1e-9);
  });
  it("17° 吸到 15°", () => {
    const p = snapLineEnd(0, 0, Math.cos(17 * DEG) * 100, Math.sin(17 * DEG) * 100);
    close(Math.atan2(p.y, p.x), 15 * DEG, 1e-9);
  });
  it("零位移原样返回", () => {
    const p = snapLineEnd(5, 5, 5, 5);
    eq(p.x, 5); eq(p.y, 5);
  });
});

describe("shape-geometry: 矩形（视口相对）", () => {
  it("rot=0：普通 AABB 四角", () => {
    const c = rectCorners({ x: 10, y: 20 }, { x: 50, y: 60 }, 0, false);
    eq(c[0].x, 10); eq(c[0].y, 20);
    eq(c[2].x, 50); eq(c[2].y, 60);
    eq(c[1].x, 50); eq(c[1].y, 20);
  });
  it("rot=30°：对角点 roundtrip（p0/p1 是角点），边与 doc 轴成 30°", () => {
    const rot = 30 * DEG;
    const c = rectCorners({ x: 0, y: 0 }, { x: 40, y: 20 }, rot, false);
    close(c[0].x, 0, 1e-9); close(c[0].y, 0, 1e-9);
    close(c[2].x, 40, 1e-9); close(c[2].y, 20, 1e-9);
    // 边 c0→c1 的方向 = 屏幕 x 轴在 doc 里的方向 = R(-rot)·(1,0) → 角度 -30°
    const e = Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x);
    close(e, -rot, 1e-9);
  });
  it("constrain：屏幕系正方，边长 = max(|dw|,|dh|)，象限跟拖拽", () => {
    const c = rectCorners({ x: 0, y: 0 }, { x: 30, y: -10 }, 0, true);
    close(c[2].x, 30, 1e-9); close(c[2].y, -30, 1e-9);   // 向右上拖 → 正方到右上
  });
  it("constrain + rot：doc 空间里四边等长", () => {
    const c = rectCorners({ x: 5, y: 5 }, { x: 25, y: 45 }, 40 * DEG, true);
    const len = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    close(len(c[0], c[1]), len(c[1], c[2]), 1e-9);
    close(len(c[1], c[2]), len(c[2], c[3]), 1e-9);
  });
});

describe("shape-geometry: 圆/弧拟合", () => {
  it("整圆（375° 过冲）→ closed，中心/半径 = AABB", () => {
    const fit = fitEllipse(circlePts(100, 80, 40, 0, 375), 0, false);
    assert(fit.closed, "375° 应闭合");
    close(fit.cx, 100, 0.1); close(fit.cy, 80, 0.1);
    close(fit.rx, 40, 0.1); close(fit.ry, 40, 0.1);
  });
  it("355° → 弧（留口），sweep ≈ 355°", () => {
    const fit = fitEllipse(circlePts(0, 0, 50, 90, 355), 0, false);
    assert(!fit.closed, "355° 不应闭合");
    close(fit.sweep / DEG, 355, 1);
  });
  it("半圆 → sweep ≈ 180°，起角正确", () => {
    const fit = fitEllipse(circlePts(0, 0, 30, 0, 180), 0, false);
    assert(!fit.closed);
    close(fit.sweep / DEG, 180, 2);
    close(fit.startAng, 0, 0.1);
  });
  it("反向绕行：sweep 为负", () => {
    const fit = fitEllipse(circlePts(0, 0, 30, 0, -200), 0, false);
    assert(!fit.closed);
    close(fit.sweep / DEG, -200, 2);
  });
  it("椭圆手抖不糊边界：AABB 极值点即边界（max 范数）", () => {
    // 椭圆点列 + 往内的抖动（内抖不改极值）→ rx/ry 仍 = 真半轴
    const pts = [];
    for (let i = 0; i <= 300; i++) {
      const a = (i / 300) * 2 * Math.PI * 1.05;
      const jitter = 1 - 0.03 * Math.abs(Math.sin(i * 7));   // 只往内抖
      pts.push({ x: 60 * Math.cos(a) * jitter, y: 25 * Math.sin(a) * jitter });
    }
    const fit = fitEllipse(pts, 0, false);
    close(fit.rx, 60, 0.5); close(fit.ry, 25, 0.5);
  });
  it("constrain 正圆：半径取 max(rx,ry)", () => {
    const pts = circlePts(0, 0, 40, 0, 370).map((p) => ({ x: p.x, y: p.y * 0.5 }));  // 压扁成 40×20
    const fit = fitEllipse(pts, 0, true);
    close(fit.rx, 40, 0.5); close(fit.ry, 40, 0.5);
  });
  it("视口 rot 下拟合：斜椭圆 roundtrip（polyline 极值沿 frame 轴）", () => {
    const rot = 25 * DEG;
    // 在 frame 空间造 60×20 椭圆再旋回 doc（模拟转了视口画的椭圆）
    const pts = circlePts(0, 0, 1, 0, 370).map((p) =>
      rotatePt({ x: 60 * p.x, y: 20 * p.y }, -rot));
    const fit = fitEllipse(pts, rot, false);
    close(fit.rx, 60, 0.5); close(fit.ry, 20, 0.5);
    assert(fit.closed);
  });
  it("点数不足 → null", () => {
    eq(fitEllipse([{ x: 1, y: 2 }], 0, false), null);
  });
});

describe("shape-geometry: 采样", () => {
  it("直线：等距、段长 ≤ maxSegLen、端点精确", () => {
    const pts = linePolyline({ x: 0, y: 0 }, { x: 100, y: 0 }, 7);
    eq(pts[0].x, 0); eq(pts[pts.length - 1].x, 100);
    for (let i = 1; i < pts.length; i++) {
      assert(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) <= 7 + 1e-9);
    }
  });
  it("矩形：闭合（首==末）、无重复角点", () => {
    const pts = rectPolyline(rectCorners({ x: 0, y: 0 }, { x: 40, y: 30 }, 0, false), 10);
    eq(pts[0].x, pts[pts.length - 1].x);
    eq(pts[0].y, pts[pts.length - 1].y);
    for (let i = 1; i < pts.length - 1; i++) {
      assert(pts[i].x !== pts[i - 1].x || pts[i].y !== pts[i - 1].y, `重复点 @${i}`);
    }
  });
  it("闭合椭圆：首==末、段长有界、n ∈ [24,512]", () => {
    const fit = fitEllipse(circlePts(0, 0, 100, 30, 380), 0, false);
    const pts = ellipseArcPolyline(fit, 8);
    eq(pts[0].x, pts[pts.length - 1].x);
    eq(pts[0].y, pts[pts.length - 1].y);
    assert(pts.length - 1 >= 24 && pts.length - 1 <= 512);
    for (let i = 1; i < pts.length; i++) {
      assert(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) <= 8 * 1.3);
    }
  });
  it("弧：起点在 startAng、终点差 sweep，不闭合", () => {
    const fit = fitEllipse(circlePts(0, 0, 50, 0, 180), 0, false);
    const pts = ellipseArcPolyline(fit, 5);
    close(pts[0].x, 50, 1);  close(pts[0].y, 0, 1);      // startAng≈0 → (r,0)
    close(pts[pts.length - 1].x, -50, 2);                 // 180° → (-r,0)
    close(pts[pts.length - 1].y, 0, 3);
  });
  it("极小笔 maxSegLen 有下限 2", () => {
    eq(maxSegLenFor(1, 0.1), 2);
  });
  it("Ramanujan 圆周长 sanity（r=10 → 2πr）", () => {
    close(perimeterRamanujan(10, 10), 2 * Math.PI * 10, 1e-6);
  });
});
