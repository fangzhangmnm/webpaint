// 形状笔几何层（纯函数，node 直测；crop-geometry 的姊妹模块）。ADR-0005。
//
// 坐标约定：全部 doc 坐标。「视口相对」不需要 screen 坐标——只需 viewport.rot：
//   屏幕轴对齐的形状 = doc 空间里转了 -rot 的形状。frame 变换 q = R(rot)·p 把点旋进
//   屏幕轴向的坐标系，在 q 空间做 AABB/约束，再 R(-rot) 映回（平移/scale 与轴向无关）。
//
// 拟合哲学（user 2026-07-25）：用户对「圆的切线边界在哪」掌握最精确——**闭合**形状用
//   **max 范数**（AABB 极值点 = 用户画到的切线），不用最小二乘的 mean 平均（全笔触平均会把
//   边界抖糊）。切线语义只对闭合成立：**弧**（部分笔迹）的 AABB 是半截框、中心/半径全错，
//   弧改用拟合（弧贴着笔迹走 = 弧场景下的「精确」）：轴对齐 LSQ **椭圆**（user 2026-07-25
//   「圆弧突然从圆变成椭圆不好」→ 弧期就得是椭圆弧，闭合瞬间才不跳）→ 退化回落 Kasa 圆。
// 弧判定（user 拍板）：绕弧模型中心记 winding（累计有向参数角）；|扫角| ≥ 2π → 闭合
//   （过冲多绕没关系）→ AABB max 范数出椭圆；< 2π → 拟合椭圆/圆上从起笔扫 sweep 出弧
//   （355° 想留口子就留得住）。winding 中心不用 AABB 中心（对弧偏得离谱：半圆的在弦上）。

export interface Pt { x: number; y: number; }

// 椭圆/弧拟合结果（frame 坐标系：cx/cy/rx/ry 是 q 空间值，rot 是 frame 角）
export interface EllipseFit {
  cx: number; cy: number;      // q 空间中心
  rx: number; ry: number;      // 半轴（≥ MIN_RADIUS）
  rot: number;                 // frame 角（= 拟合时的 viewport.rot）
  startAng: number;            // 起笔参数角（q 空间）
  sweep: number;               // 累计有向扫角（rad，带符号；|sweep|≥2π 视为闭合）
  closed: boolean;
}

const MIN_RADIUS = 0.5;
const TWO_PI = Math.PI * 2;

export function rotatePt(p: Pt, ang: number): Pt {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

// ---- 直线 ----

// 角度吸附（画布相对，不是视口——user 拍板）：把终点投影到最近的 k·step 方向上。
//   投影而非保长：光标沿吸附轴滑动时终点跟手（常见绘图软件语义）。
//   step 先试 15°（user：45+30+60 备选，像素画/isometric 手感观察后再定）。
export function snapLineEnd(x0: number, y0: number, x: number, y: number, stepRad: number = Math.PI / 12): Pt {
  const dx = x - x0, dy = y - y0;
  const L = Math.hypot(dx, dy);
  if (L === 0) return { x, y };
  const ang = Math.atan2(dy, dx);
  const snapped = Math.round(ang / stepRad) * stepRad;
  const ux = Math.cos(snapped), uy = Math.sin(snapped);
  const proj = dx * ux + dy * uy;   // 拖拽向量在吸附方向上的投影
  return { x: x0 + ux * proj, y: y0 + uy * proj };
}

// ---- 矩形（视口相对 AABB；斜的 = 转视口画）----

// 两对角 → 4 角（doc 坐标，绕行序）。constrain = 屏幕系 1:1 正方（对齐 lasso _constrainSquare：
//   边长取 max(|dw|,|dh|)，方向跟拖拽象限）。
export function rectCorners(p0: Pt, p1: Pt, rot: number, constrain: boolean): [Pt, Pt, Pt, Pt] {
  const q0 = rotatePt(p0, rot);
  let q1 = rotatePt(p1, rot);
  if (constrain) {
    const dw = q1.x - q0.x, dh = q1.y - q0.y;
    const side = Math.max(Math.abs(dw), Math.abs(dh));
    q1 = { x: q0.x + Math.sign(dw || 1) * side, y: q0.y + Math.sign(dh || 1) * side };
  }
  const corners: Pt[] = [
    { x: q0.x, y: q0.y }, { x: q1.x, y: q0.y },
    { x: q1.x, y: q1.y }, { x: q0.x, y: q1.y },
  ];
  return corners.map((q) => rotatePt(q, -rot)) as [Pt, Pt, Pt, Pt];
}

// ---- 圆/弧（鼠绘拟合）----

// freehand 点列 → 椭圆/圆弧 + winding。O(n) 全量重算（n ≤ 数千，每 move 一次可忽略；
//   增量态会因拟合中心漂移而路径依赖，全量重算 = 确定性、可测）。
export function fitEllipse(pts: Pt[], rot: number, constrain: boolean): EllipseFit | null {
  if (pts.length < 2) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const q: Pt[] = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const p = rotatePt(pts[i], rot);
    q[i] = p;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  // 弧模型（三级回落）：constrain=正圆 → Kasa 圆；否则先试**轴对齐 LSQ 椭圆**（消「画椭圆时
  //   过 360° 从圆突跳成椭圆」的断裂——弧期预览就已是椭圆弧）；LSQ 退化（短弧/近直线/病态）→
  //   Kasa 圆；再退化 → AABB 中心兜底（sweep≈0，反正出不了像样的弧）。
  const kasa = kasaCircle(q);
  const lsq = constrain ? null : alignedEllipseLSQ(q, minX, maxX, minY, maxY);
  const arc = lsq
    ?? (kasa ? { cx: kasa.cx, cy: kasa.cy, rx: kasa.r, ry: kasa.r } : null)
    ?? { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, rx: MIN_RADIUS, ry: MIN_RADIUS };
  // winding：绕弧模型中心累计参数角增量（正圆时 = 几何角）
  const ang0 = paramAng(q[0], arc);
  let prev = ang0, sweep = 0;
  for (let i = 1; i < q.length; i++) {
    const a = paramAng(q[i], arc);
    let d = a - prev;
    if (d > Math.PI) d -= TWO_PI;
    else if (d < -Math.PI) d += TWO_PI;
    sweep += d;
    prev = a;
  }
  if (Math.abs(sweep) >= TWO_PI) {
    // 闭合：AABB max 范数出椭圆（切线边界哲学；LSQ 只是弧期模型，闭合了极值点=用户画的切线更权威）。
    //   闭合前后同为椭圆、参数差在抖动量级 → 无可见跳变。起角对全圆无观感影响，取起笔点参数角。
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    let rx = Math.max(MIN_RADIUS, (maxX - minX) / 2);
    let ry = Math.max(MIN_RADIUS, (maxY - minY) / 2);
    if (constrain) { const r = Math.max(rx, ry); rx = r; ry = r; }   // 正圆 = max 范数
    const startAng = paramAng(q[0], { cx, cy, rx, ry });
    return { cx, cy, rx, ry, rot, startAng, sweep, closed: true };
  }
  return { cx: arc.cx, cy: arc.cy, rx: Math.max(MIN_RADIUS, arc.rx), ry: Math.max(MIN_RADIUS, arc.ry), rot, startAng: ang0, sweep, closed: false };
}

function paramAng(p: Pt, e: { cx: number; cy: number; rx: number; ry: number }): number {
  return Math.atan2((p.y - e.cy) / (e.ry || 1), (p.x - e.cx) / (e.rx || 1));
}

// 轴对齐椭圆最小二乘（A x² + C y² + D x + E y + F = 0，规范化 A+C=2 → A=1+t, C=1−t）。
//   线性最小二乘：min Σ((u²+v²) + t(u²−v²) + Du + Ev + F)²，4×4 正规方程。
//   我们的椭圆天然轴对齐视口 frame（斜的转视口画）→ 不需要一般二次曲线的 5 参数拟合，
//   少两个自由度 = 短弧下稳得多。中心化提数值稳定。
//   有效性护栏（短弧/近直线时 LSQ 会飞）：A,C>0（椭圆非双曲线）、G0>0、长宽比 ≤ 8、
//   半轴 ≤ 4× AABB 对角线。不过关 → null（caller 回落 Kasa 圆）。
function alignedEllipseLSQ(q: Pt[], minX: number, maxX: number, minY: number, maxY: number):
    { cx: number; cy: number; rx: number; ry: number } | null {
  const n = q.length;
  if (n < 8) return null;   // 起手几个点不够定 4 参数，先让 Kasa 圆顶着
  let mx = 0, my = 0;
  for (const p of q) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  // 正规方程 M·(t,D,E,F)ᵀ = b，回归元 r=(u²−v², u, v, 1)，目标 −(u²+v²)
  const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const b = [0, 0, 0, 0];
  for (const p of q) {
    const u = p.x - mx, v = p.y - my;
    const r = [u * u - v * v, u, v, 1];
    const y = -(u * u + v * v);
    for (let i = 0; i < 4; i++) {
      b[i] += r[i] * y;
      for (let j = i; j < 4; j++) M[i][j] += r[i] * r[j];
    }
  }
  for (let i = 1; i < 4; i++) for (let j = 0; j < i; j++) M[i][j] = M[j][i];
  const sol = solve4(M, b);
  if (!sol) return null;
  const [t, D, E, F] = sol;
  const A = 1 + t, C = 1 - t;
  if (A <= 1e-6 || C <= 1e-6) return null;                    // 双曲线/抛物线退化
  const cu = -D / (2 * A), cv = -E / (2 * C);
  const G0 = A * cu * cu + C * cv * cv - F;
  if (G0 <= 0) return null;
  const rx = Math.sqrt(G0 / A), ry = Math.sqrt(G0 / C);
  if (rx / ry > 8 || ry / rx > 8) return null;                // 病态长宽比 → 不如圆稳
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  if (rx > 4 * diag || ry > 4 * diag) return null;            // 半径远超笔迹尺度 = 近直线
  return { cx: cu + mx, cy: cv + my, rx, ry };
}

// 4×4 高斯消元（部分主元）。奇异 → null。
function solve4(M: number[][], b: number[]): number[] | null {
  const a = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null;
    if (piv !== col) { const tmp = a[col]; a[col] = a[piv]; a[piv] = tmp; }
    for (let r = col + 1; r < 4; r++) {
      const f = a[r][col] / a[col][col];
      for (let c = col; c < 5; c++) a[r][c] -= f * a[col][c];
    }
  }
  const x = [0, 0, 0, 0];
  for (let r = 3; r >= 0; r--) {
    let s = a[r][4];
    for (let c = r + 1; c < 4; c++) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
}

// Kasa 代数圆拟合（最小二乘 x²+y²+Dx+Ey+F=0，中心化提数值稳定）。近共线 → null。
function kasaCircle(q: Pt[]): { cx: number; cy: number; r: number } | null {
  const n = q.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (const p of q) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of q) {
    const u = p.x - mx, v = p.y - my;
    suu += u * u; suv += u * v; svv += v * v;
    suuu += u * u * u; svvv += v * v * v;
    suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  const scale = (suu + svv) || 1;
  if (Math.abs(det) < 1e-9 * scale * scale) return null;   // 近共线
  const b1 = (suuu + suvv) / 2, b2 = (svvv + svuu) / 2;
  const uc = (svv * b1 - suv * b2) / det;
  const vc = (suu * b2 - suv * b1) / det;
  return { cx: uc + mx, cy: vc + my, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
}

// ---- 点列采样（喂 BrushEngine 合成描边）----

// 段长上限：< stamp 间距（size×spacing）→ 折线在 stamp 粒度下不可见；下限 2 doc-px 防细笔过密。
export function maxSegLenFor(size: number, spacing: number): number {
  return Math.max(2, size * spacing * 0.75);
}

// 直线：两端点 + 等距中间点（统一过采样：taper 干走/平滑器对三种形状同路径，少一个特例）
export function linePolyline(p0: Pt, p1: Pt, maxSegLen: number): Pt[] {
  const L = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const n = Math.max(1, Math.ceil(L / maxSegLen));
  const out: Pt[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out[i] = { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
  }
  return out;
}

// 矩形：4 边各自等距插点，闭合（末点 == 首点）
export function rectPolyline(corners: [Pt, Pt, Pt, Pt], maxSegLen: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const seg = linePolyline(corners[i], corners[(i + 1) % 4], maxSegLen);
    if (i > 0) seg.shift();   // 相邻边共享角点，去重
    out.push(...seg);
  }
  return out;
}

// Ramanujan 椭圆周长近似（采样密度用，误差远小于段长粒度）
export function perimeterRamanujan(rx: number, ry: number): number {
  const h = ((rx - ry) * (rx - ry)) / ((rx + ry) * (rx + ry));
  return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

// 椭圆/弧：参数域均匀采样。闭合 → 从 startAng 走整圈（首==末）；弧 → 从 startAng 走 sweep。
//   n 按整圈周长折算到弧长，clamp [24, 512]（圆看不出多边形、极端大圆有界）。
export function ellipseArcPolyline(fit: EllipseFit, maxSegLen: number): Pt[] {
  const span = fit.closed ? TWO_PI : Math.abs(fit.sweep);
  if (span === 0) return [];
  const perim = perimeterRamanujan(fit.rx, fit.ry) * (span / TWO_PI);
  const n = Math.min(512, Math.max(24, Math.ceil(perim / maxSegLen)));
  const dir = fit.closed ? Math.sign(fit.sweep || 1) : Math.sign(fit.sweep);
  const out: Pt[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const u = fit.startAng + dir * span * (i / n);
    const qx = fit.cx + fit.rx * Math.cos(u);
    const qy = fit.cy + fit.ry * Math.sin(u);
    out[i] = rotatePt({ x: qx, y: qy }, -fit.rot);
  }
  if (fit.closed) out[n] = { ...out[0] };   // 数值闭合：末点钉到首点
  return out;
}
