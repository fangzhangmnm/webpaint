// 像素透视圆（ADR-0006）：单位圆经 homography 的像 = 一般圆锥曲线（conic），用
// **Zingl 有理二次 Bézier 栅格化**逐像素画出（《The Beauty of Bresenham's Algorithm》
// plotQuadRationalBezier(Seg)，整数误差项推进，正宗 Bresenham 家族；user 拍板正解，
// 权重从 homography 解析算出，零可调参数）。
//
// 结构：内切圆四象限弧 → 每段 {端点=切点(边中点的像), 控制点=四边形角(切线交点=角点的像),
//   权重=由 45° 弧中点的像解出} → Zingl 逐段栅格。退化护栏（角点飞向地平线/权重解不出）
//   → 密采样折线 + Bresenham 连线 + 去重的逃生门（user：非常实在不行才用）。
import { applyMat3, homographyUnitSquare } from "./perspective-frame.ts";
import { bresenhamLine } from "./shape-geometry.ts";
import type { Pt } from "./shape-geometry.ts";

type Plot = (px: number, py: number) => void;

// ---- Zingl plotQuadRationalBezierSeg（入参 w2 = 权重的平方；梯度符号不变的受限段）----
function plotSeg(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, w2: number, plot: Plot, depth = 0) {
  let sx = x2 - x1, sy = y2 - y1;
  let dx = x0 - x2, dy = y0 - y2, xx = x0 - x1, yy = y0 - y1;
  let xy = xx * sy + yy * sx;
  let cur = xx * sy - yy * sx;
  let err: number;
  // 梯度符号必须不变（wrapper 负责切分）；数值毛刺时直接退化成直线段
  if (xx * sx > 0 || yy * sy > 0 || depth > 8) {
    for (const p of bresenhamLine(x0, y0, x2, y2)) plot(p.x - 0.5, p.y - 0.5);
    return;
  }
  if (cur !== 0 && w2 > 0) {
    if (sx * sx + sy * sy > xx * xx + yy * yy) {   // 从长的一半开始
      x2 = x0; x0 -= dx; y2 = y0; y0 -= dy; cur = -cur;
    }
    xx = 2.0 * (4.0 * w2 * sx * xx + dx * dx);
    yy = 2.0 * (4.0 * w2 * sy * yy + dy * dy);
    sx = x0 < x2 ? 1 : -1;
    sy = y0 < y2 ? 1 : -1;
    xy = -2.0 * sx * sy * (2.0 * w2 * xy + dx * dy);
    if (cur * sx * sy < 0) { xx = -xx; yy = -yy; xy = -xy; cur = -cur; }
    dx = 4.0 * w2 * (x1 - x0) * sy * cur + xx / 2.0 + xy;
    dy = 4.0 * w2 * (y0 - y1) * sx * cur + yy / 2.0 + xy;
    if (w2 < 0.5 && (dy > xy || dx < xy)) {   // 扁 conic：算法失效 → 折半细分
      cur = (w2 + 1.0) / 2.0;
      const w = Math.sqrt(w2);
      const rcp = 1.0 / (w + 1.0);
      const mx = Math.floor((x0 + 2.0 * w * x1 + x2) * rcp / 2.0 + 0.5);
      const my = Math.floor((y0 + 2.0 * w * y1 + y2) * rcp / 2.0 + 0.5);
      let cx = Math.floor((w * x1 + x0) * rcp + 0.5), cy = Math.floor((y1 * w + y0) * rcp + 0.5);
      plotSeg(x0, y0, cx, cy, mx, my, cur, plot, depth + 1);
      cx = Math.floor((w * x1 + x2) * rcp + 0.5); cy = Math.floor((y1 * w + y2) * rcp + 0.5);
      plotSeg(mx, my, cx, cy, x2, y2, cur, plot, depth + 1);
      return;
    }
    err = dx + dy - xy;
    let guard = 0;
    const GUARD_MAX = 100000;
    do {
      plot(x0, y0);
      if (x0 === x2 && y0 === y2) return;
      const fx = 2 * err > dy, fy = 2 * (err + yy) < -dy;
      if (2 * err < dx || fy) { y0 += sy; dy += xy; err += dx += xx; }
      if (2 * err > dx || fx) { x0 += sx; dx += xy; err += dy += yy; }
    } while (dy <= xy && dx >= xy && guard++ < GUARD_MAX);
  }
  for (const p of bresenhamLine(x0, y0, x2, y2)) plot(p.x - 0.5, p.y - 0.5);   // 剩余直段
}

// ---- Zingl plotQuadRationalBezier（任意有理二次段：在 x/y 梯度反号处切分再喂 seg）----
function plotAny(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, w: number, plot: Plot) {
  let x = x0 - 2 * x1 + x2, y = y0 - 2 * y1 + y2;
  let xx = x0 - x1, yy = y0 - y1, ww: number, t: number, q: number;
  if (xx * (x2 - x1) > 0) {                       // x 向要切？
    if (yy * (y2 - y1) > 0) {                     // y 向也要切 → 先切远的那个
      if (Math.abs(xx * y) > Math.abs(yy * x)) {
        x0 = x2; x2 = xx + x1; y0 = y2; y2 = yy + y1;   // 交换端点
      }
    }
    if (x0 === x2 || w === 1.0) t = (x0 - x1) / x;
    else {
      q = Math.sqrt(4.0 * w * w * (x0 - x1) * (x2 - x1) + (x2 - x0) * (x2 - x0));
      if (x1 < x0) q = -q;
      t = (2.0 * w * (x0 - x1) - x0 + x2 + q) / (2.0 * (1.0 - w) * (x2 - x0));
    }
    q = 1.0 / (2.0 * t * (1.0 - t) * (w - 1.0) + 1.0);
    xx = (t * t * (x0 - 2.0 * w * x1 + x2) + 2.0 * t * (w * x1 - x0) + x0) * q;
    yy = (t * t * (y0 - 2.0 * w * y1 + y2) + 2.0 * t * (w * y1 - y0) + y0) * q;
    ww = t * (w - 1.0) + 1.0; ww *= ww * q;       // 前半段权重²
    w = ((1.0 - t) * (w - 1.0) + 1.0) * Math.sqrt(q);   // 后半段权重
    x = Math.floor(xx + 0.5); y = Math.floor(yy + 0.5);
    yy = (xx - x0) * (y1 - y0) / (x1 - x0) + y0;
    plotSeg(x0, y0, x, Math.floor(yy + 0.5), x, y, ww, plot);
    yy = (xx - x2) * (y1 - y2) / (x1 - x2) + y2;
    y1 = Math.floor(yy + 0.5); x0 = x1 = x; y0 = y;
  }
  if ((y0 - y1) * (y2 - y1) > 0) {                // y 向要切？
    y = y0 - 2 * y1 + y2;
    if (y0 === y2 || w === 1.0) t = (y0 - y1) / y;
    else {
      q = Math.sqrt(4.0 * w * w * (y0 - y1) * (y2 - y1) + (y2 - y0) * (y2 - y0));
      if (y1 < y0) q = -q;
      t = (2.0 * w * (y0 - y1) - y0 + y2 + q) / (2.0 * (1.0 - w) * (y2 - y0));
    }
    q = 1.0 / (2.0 * t * (1.0 - t) * (w - 1.0) + 1.0);
    xx = (t * t * (x0 - 2.0 * w * x1 + x2) + 2.0 * t * (w * x1 - x0) + x0) * q;
    yy = (t * t * (y0 - 2.0 * w * y1 + y2) + 2.0 * t * (w * y1 - y0) + y0) * q;
    ww = t * (w - 1.0) + 1.0; ww *= ww * q;
    w = ((1.0 - t) * (w - 1.0) + 1.0) * Math.sqrt(q);
    x = Math.floor(xx + 0.5); y = Math.floor(yy + 0.5);
    xx = (x1 - x0) * (yy - y0) / (y1 - y0) + x0;
    plotSeg(x0, y0, Math.floor(xx + 0.5), y, x, y, ww, plot);
    xx = (x1 - x2) * (yy - y2) / (y1 - y2) + x2;
    x1 = Math.floor(xx + 0.5); x0 = x; y0 = y1 = y;
  }
  plotSeg(x0, y0, x1, y1, x2, y2, w * w, plot);
}

const COORD_LIMIT = 1e5;   // 角点飞向地平线的护栏：超界走逃生门

// 四边形内切 conic（= 单位圆经 unit-square→quad homography 的像）的逐像素环。
//   返回像素中心坐标（i+0.5），去重。quad 顺序同 quadFromCorners。
export function bresenhamConicInQuad(quad: [Pt, Pt, Pt, Pt]): Pt[] {
  const H = homographyUnitSquare(quad);
  if (!H) return [];
  const T = (u: number, v: number) => applyMat3(H, u, v);
  const seen = new Set<string>();
  const out: Pt[] = [];
  const plot = (px: number, py: number) => {
    const k = px + "," + py;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ x: px + 0.5, y: py + 0.5 });
  };
  // 切点 = 边中点的像；控制点 = 角点的像（两切线交点）；45° 弧中点的像解权重。
  const SQ = Math.SQRT1_2 / 2;   // 0.5·cos45°
  const tang = [T(0.5, 0), T(1, 0.5), T(0.5, 1), T(0, 0.5)];
  const ctrl = [T(1, 0), T(1, 1), T(0, 1), T(0, 0)];
  const mid = [
    T(0.5 + SQ, 0.5 - SQ), T(0.5 + SQ, 0.5 + SQ),
    T(0.5 - SQ, 0.5 + SQ), T(0.5 - SQ, 0.5 - SQ),
  ];
  let ok = true;
  const pts = [...tang, ...ctrl, ...mid];
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > COORD_LIMIT || Math.abs(p.y) > COORD_LIMIT) { ok = false; break; }
  }
  if (ok) {
    const px = (p: Pt) => Math.round(p.x - 0.5);   // doc 坐标 → 像素索引（+0.5 中心制）
    const py = (p: Pt) => Math.round(p.y - 0.5);
    for (let i = 0; i < 4 && ok; i++) {
      const P0 = tang[i], P1 = ctrl[i], P2 = tang[(i + 1) % 4], M = mid[i];
      // 权重：B(1/2) = (P0 + 2wP1 + P2)/(2+2w) = M → w = dot(P0+P2−2M, 2(M−P1)) / |2(M−P1)|²
      const nx = P0.x + P2.x - 2 * M.x, ny = P0.y + P2.y - 2 * M.y;
      const dxv = 2 * (M.x - P1.x), dyv = 2 * (M.y - P1.y);
      const den = dxv * dxv + dyv * dyv;
      const w = den > 1e-12 ? (nx * dxv + ny * dyv) / den : NaN;
      if (!Number.isFinite(w) || w <= 0 || w >= 4) { ok = false; break; }
      plotAny(px(P0), py(P0), px(P1), py(P1), px(P2), py(P2), w, plot);
    }
  }
  if (!ok) {
    // 逃生门：密采样真 conic → Bresenham 连线 + 去重（视觉等价，非"每步整数"纯血）
    seen.clear(); out.length = 0;
    const N = 256;
    let prev: { x: number; y: number } | null = null;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const p = T(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > COORD_LIMIT || Math.abs(p.y) > COORD_LIMIT) { prev = null; continue; }
      const ix = Math.round(p.x - 0.5), iy = Math.round(p.y - 0.5);
      if (prev) for (const q of bresenhamLine(prev.x, prev.y, ix, iy)) plot(q.x - 0.5, q.y - 0.5);
      else plot(ix, iy);
      prev = { x: ix, y: iy };
    }
  }
  return out;
}
