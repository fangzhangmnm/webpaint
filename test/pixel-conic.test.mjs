// 像素透视圆：Zingl 有理二次 Bézier conic 栅格（ADR-0006）。
// 验证策略：不信转录信几何——对解析真曲线（单位圆经 H 的像密采样）做**双向 Hausdorff**：
//   每颗像素离真曲线 ≤ 1px（无飞点），真曲线每处都有像素 ≤ 1px（无断口）。
import { describe, it, assert, eq } from "./runner.mjs";
const { bresenhamConicInQuad } = await import("../src/pixel-conic.ts");
const { homographyUnitSquare, applyMat3 } = await import("../src/perspective-frame.ts");
const { bresenhamEllipseRect } = await import("../src/shape-geometry.ts");

function analytic(quad, n = 2048) {
  const H = homographyUnitSquare(quad);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(applyMat3(H, 0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)));
  }
  return out;
}
function hausdorffBoth(pixels, curve) {
  let dPix = 0;
  for (const p of pixels) {
    let best = Infinity;
    for (const c of curve) best = Math.min(best, Math.hypot(p.x - c.x, p.y - c.y));
    dPix = Math.max(dPix, best);
  }
  let dCur = 0;
  for (let i = 0; i < curve.length; i += 8) {
    const c = curve[i];
    let best = Infinity;
    for (const p of pixels) best = Math.min(best, Math.hypot(p.x - c.x, p.y - c.y));
    dCur = Math.max(dCur, best);
  }
  return { dPix, dCur };
}
const uniq = (pts) => new Set(pts.map((p) => `${p.x},${p.y}`)).size === pts.length;

describe("pixel-conic · Zingl 有理 Bézier conic 栅格", () => {
  it("正方形盒（内切正圆）≈ 盒式 midpoint 圆（高重合 + Hausdorff ≤1）", () => {
    const quad = [{ x: 10.5, y: 10.5 }, { x: 30.5, y: 10.5 }, { x: 30.5, y: 30.5 }, { x: 10.5, y: 30.5 }];
    const pts = bresenhamConicInQuad(quad);
    assert(uniq(pts), "去重");
    const { dPix, dCur } = hausdorffBoth(pts, analytic(quad));
    assert(dPix <= 1.0, `像素离真圆 ≤1px，实得 ${dPix}`);
    assert(dCur <= 1.0, `真圆处处有像素 ≤1px，实得 ${dCur}`);
    const ref = new Set(bresenhamEllipseRect(10, 10, 30, 30).map((p) => `${p.x},${p.y}`));
    let hit = 0;
    for (const p of pts) if (ref.has(`${p.x},${p.y}`)) hit++;
    assert(hit / Math.max(pts.length, ref.size) > 0.7, `与盒式 midpoint 圆大体重合，实得 ${(hit / Math.max(pts.length, ref.size)).toFixed(2)}`);
  });
  it("一点透视梯形（左右对称）：Hausdorff ≤1.3 + 大体左右对称", () => {
    // 对称梯形：VP 在正上方 → 上边短下边长。
    // 容差 1.3：整数端点舍入（切点钉格 ±0.71）+ 栅格半像素 的固有叠加，非转录误差。
    const quad = [{ x: 20.5, y: 60.5 }, { x: 60.5, y: 60.5 }, { x: 50.5, y: 20.5 }, { x: 30.5, y: 20.5 }];
    const pts = bresenhamConicInQuad(quad);
    const { dPix, dCur } = hausdorffBoth(pts, analytic(quad));
    assert(dPix <= 1.3, `dPix=${dPix}`);
    assert(dCur <= 1.3, `dCur=${dCur}`);
    const s = new Set(pts.map((p) => `${p.x},${p.y}`));
    let sym = 0;
    for (const p of pts) {
      const mx = 81 - p.x;   // 关于 x=40.5 镜像
      if (s.has(`${mx},${p.y}`) || s.has(`${mx - 1},${p.y}`) || s.has(`${mx + 1},${p.y}`)) sym++;
    }
    assert(sym / pts.length > 0.9, `对称率 ${(sym / pts.length).toFixed(2)}`);
  });
  it("一般四边形（两点透视风）：Hausdorff ≤1 + 环连通", () => {
    const quad = [{ x: 15.5, y: 70.5 }, { x: 80.5, y: 60.5 }, { x: 70.5, y: 25.5 }, { x: 30.5, y: 35.5 }];
    const pts = bresenhamConicInQuad(quad);
    const { dPix, dCur } = hausdorffBoth(pts, analytic(quad));
    assert(dPix <= 1.0, `dPix=${dPix}`);
    assert(dCur <= 1.0, `dCur=${dCur}`);
    const s = new Set(pts.map((p) => `${p.x},${p.y}`));
    for (const p of pts) {
      let n = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        if (s.has(`${p.x + dx},${p.y + dy}`)) n++;
      }
      assert(n >= 1, `孤立像素 ${p.x},${p.y}`);
    }
  });
  it("小四边形（10px 级）与退化护栏（超界角点）都不炸", () => {
    const small = bresenhamConicInQuad([{ x: 2.5, y: 2.5 }, { x: 9.5, y: 3.5 }, { x: 8.5, y: 9.5 }, { x: 1.5, y: 8.5 }]);
    assert(small.length > 4 && uniq(small));
    const degen = bresenhamConicInQuad([{ x: 0, y: 0 }, { x: 1e7, y: 5 }, { x: 1e7, y: 1e7 }, { x: 5, y: 1e7 }]);
    assert(Array.isArray(degen), "护栏返回列表不炸");
    for (const p of degen) assert(Number.isFinite(p.x) && Number.isFinite(p.y));
  });
});
