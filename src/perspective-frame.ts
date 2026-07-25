// 透视 frame 纯函数层（ADR-0006，形状笔全局透视）。node 直测，无 DOM/board。
//
// 模型（user 2026-07-25 grill 定案）：
//   · 消失点 0-3 个：vp1/vp2 = 水平对（按 x 排序，左=1 右=2；lockHorizon 开 = 锁同一条
//     doc 水平地平线，默认开）；vp3 = 竖直族消失点（只有位置，在地平线下=俯视/上=仰视）。
//   · 平面 = 两个「方向族」的配对（族 = 过某 VP 的 pencil，或平行族）。清单：
//     1 VP：ground(VP×水平) / wall(VP×竖直)；2/3 VP：ground(VP1×VP2) /
//     wallL(VP1×竖直或×VP3) / wallR(VP2×竖直或×VP3)。0 VP = 只有「关」。
//   · 两个对角点唯一确定四边形（各角点上过两族的线，四交点）→「单位正方形→四边形」
//     homography 唯一 → 透视矩形=四边、透视椭圆=内切圆的像、grid 间距=cross-ratio，
//     深度缩放自由度在四角固定后不存在（不需要显式"缩短率"参数）。
//   · 地平线奇点（user：像越过史瓦西半径——另一张 manifold patch，不 make sense）：
//     rect/grid/像素椭圆全走角点+homography（doc 锚定，结构上不碰奇点）；只有徒手拟合
//     需要 chart（doc→plane 逆映射），按 ε 规则护栏（见 planeChart）。
import type { Pt } from "./shape-geometry.ts";

export interface Vp { x: number; y: number; }

export type PlaneId = "off" | "ground" | "wall" | "wallL" | "wallR";

// 透视配置（editorState per-ora；VP 坐标 snap 像素中线 +0.5 与形状端点同格系——
//   VP 到任意端点连线斜率是整数比，Bresenham 对称）
export interface PerspConfig {
  vp1: Vp | null;
  vp2: Vp | null;
  vp3: Vp | null;
  lockHorizon: boolean;   // 默认 true：vp2.y 锁 = vp1.y（极端场景关掉可歪地平线）
  refPoint: Vp | null;    // 参考点：数学无用，VP 编辑模式里向各 VP 发淡射线帮美工立框架
  plane: PlaneId;
}

// 方向族：pencil = 过 VP 的线束；parallel = 平行族（dir 单位向量）
export type Family =
  | { kind: "pencil"; vp: Vp }
  | { kind: "parallel"; dir: Pt };

const H_DIR: Pt = { x: 1, y: 0 };
const V_DIR: Pt = { x: 0, y: 1 };

// 地平线奇点 ε（doc px）：pencil 枚举坐标的 1/w 饱和阈值（user：过线后梯度按 1/ε 不按 1/z）。
export const HORIZON_EPS = 2;
// parallel 枚举坐标（真发散方向）的 clamp（"按无穷大算"的有限替身；过线不翻负、钉在 +BIG）
const DEPTH_BIG = 1e6;

// 当前配置下某平面的两个方向族。配置凑不齐该平面 → null（UI 应据此过滤菜单）。
export function planeFamilies(cfg: PerspConfig): [Family, Family] | null {
  const { vp1, vp2, vp3, plane } = cfg;
  switch (plane) {
    case "ground":
      if (vp1 && vp2) return [{ kind: "pencil", vp: vp1 }, { kind: "pencil", vp: vp2 }];
      if (vp1) return [{ kind: "pencil", vp: vp1 }, { kind: "parallel", dir: H_DIR }];
      return null;
    case "wall":   // 1 VP 专用：纵深墙
      if (vp1 && !vp2) return [{ kind: "pencil", vp: vp1 }, vp3 ? { kind: "pencil", vp: vp3 } : { kind: "parallel", dir: V_DIR }];
      return null;
    case "wallL":
      if (vp1 && vp2) return [{ kind: "pencil", vp: vp1 }, vp3 ? { kind: "pencil", vp: vp3 } : { kind: "parallel", dir: V_DIR }];
      return null;
    case "wallR":
      if (vp1 && vp2) return [{ kind: "pencil", vp: vp2 }, vp3 ? { kind: "pencil", vp: vp3 } : { kind: "parallel", dir: V_DIR }];
      return null;
    default:
      return null;
  }
}

// ---- 齐次线/交点原语 ----

type H3 = [number, number, number];

const cross3 = (a: H3, b: H3): H3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

// 过点 p、属于族 fam 的那条线（齐次）
export function familyLineThrough(p: Pt, fam: Family): H3 {
  const ph: H3 = [p.x, p.y, 1];
  const q: H3 = fam.kind === "pencil" ? [fam.vp.x, fam.vp.y, 1] : [fam.dir.x, fam.dir.y, 0];
  return cross3(ph, q);
}

// 两线交点。平行/病态（w≈0，比如角点撞上 VP）→ null。
export function intersectLines(l1: H3, l2: H3): Pt | null {
  const p = cross3(l1, l2);
  const scale = Math.max(Math.abs(p[0]), Math.abs(p[1]), 1);
  if (Math.abs(p[2]) < 1e-9 * scale) return null;
  return { x: p[0] / p[2], y: p[1] / p[2] };
}

// 两个对角点 → 四边形（顺序 c0 → A(c0)∩B(c1) → c1 → A(c1)∩B(c0)，对应单位方
//   (0,0)(1,0)(1,1)(0,1)：famA 线 = v=const 边族，famB 线 = u=const 边族）。
//   任一交点病态（角点贴 VP / 跨地平线撕裂）→ null，caller 按无效拖拽处理。
export function quadFromCorners(c0: Pt, c1: Pt, famA: Family, famB: Family): [Pt, Pt, Pt, Pt] | null {
  const a0 = familyLineThrough(c0, famA), a1 = familyLineThrough(c1, famA);
  const b0 = familyLineThrough(c0, famB), b1 = familyLineThrough(c1, famB);
  const p10 = intersectLines(a0, b1);
  const p01 = intersectLines(a1, b0);
  if (!p10 || !p01) return null;
  return [c0, p10, c1, p01];
}

// ---- 单位正方形 → 四边形 homography（Heckbert 投影贴图闭式）----

export type Mat3 = [number, number, number, number, number, number, number, number, number];

// (0,0)→q[0]，(1,0)→q[1]，(1,1)→q[2]，(0,1)→q[3]。退化（三点共线）→ null。
export function homographyUnitSquare(q: [Pt, Pt, Pt, Pt]): Mat3 | null {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dy1 = p1.y - p2.y;
  const dx2 = p3.x - p2.x, dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  const det = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(sx) > 1e-12 || Math.abs(sy) > 1e-12) {
    if (Math.abs(det) < 1e-12) return null;
    g = (sx * dy2 - sy * dx2) / det;
    h = (dx1 * sy - dy1 * sx) / det;
  }
  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + h * p3.x;
  const c = p0.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + h * p3.y;
  const f = p0.y;
  return [a, b, c, d, e, f, g, h, 1];
}

export function applyMat3(m: Mat3, u: number, v: number): Pt {
  const w = m[6] * u + m[7] * v + m[8];
  return { x: (m[0] * u + m[1] * v + m[2]) / w, y: (m[3] * u + m[4] * v + m[5]) / w };
}

export function invertMat3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
  const D = f * g - d * i, E = a * i - c * g, F = c * d - a * f;
  const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
  const det = a * A + b * D + c * G;
  if (Math.abs(det) < 1e-12) return null;
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
}

// ---- chart：doc → plane 的逆映射（只有徒手拟合用；ε 护栏在这）----
//
// 构造：把平面的消失线 ℓ 送到无穷远（射影 chart），再线性归一让两族方向对齐坐标轴。
// ε 规则（user 定案）：**枚举 pencil 族的坐标**（如 1 点透视的路宽/横向）1/w 用
//   max(w, ε) 饱和——过线后梯度 1/ε 不发散；**枚举 parallel 族的坐标**（纵深）用真
//   1/w、可到 +BIG，过线 clamp 在 +BIG 不翻负（不进另一张 patch）。
//   两族都是 pencil（两点地面）→ 两个坐标都饱和（拟合稳定性优先）。
export interface PlaneChart {
  toPlane(p: Pt): Pt;            // ε 护栏版（拟合输入用）
  toDoc(u: number, v: number): Pt | null;   // 逆回 doc（w≤0 = 无穷远侧 → null）
}

export function planeChart(famA: Family, famB: Family, anchor: Pt): PlaneChart | null {
  // 消失线 ℓ = 两族无穷远点的连线（parallel 族的点在无穷远，pencil 族的点 = VP）
  const pa: H3 = famA.kind === "pencil" ? [famA.vp.x, famA.vp.y, 1] : [famA.dir.x, famA.dir.y, 0];
  const pb: H3 = famB.kind === "pencil" ? [famB.vp.x, famB.vp.y, 1] : [famB.dir.x, famB.dir.y, 0];
  let l = cross3(pa, pb);
  const n = Math.hypot(l[0], l[1]);
  if (n < 1e-12) l = [0, 0, 1];               // 两族都 parallel（0 VP）→ 仿射 frame
  else l = [l[0] / n, l[1] / n, l[2] / n];    // 归一：w(p) = 到消失线的**有向 doc 距离**（px）
  let w0 = l[0] * anchor.x + l[1] * anchor.y + l[2];
  if (w0 < 0) { l = [-l[0], -l[1], -l[2]]; w0 = -w0; }   // 锚点侧为正
  if (w0 < 1e-9) return null;   // 锚点就在消失线上：病态
  const wOf = (p: Pt) => l[0] * p.x + l[1] * p.y + l[2];
  // 射影 chart T = [r1; r2; ℓ]：r1/r2 从 {e1,e2,e3} 里选掉 |ℓ| 分量最大的那个坐标
  //   （det[T] = ±ℓ_k，选最大保良态——地平线过原点时 (x/w, y/w) 会塌成一条线，教训）。
  const absL = [Math.abs(l[0]), Math.abs(l[1]), Math.abs(l[2])];
  const drop = absL[0] >= absL[1] && absL[0] >= absL[2] ? 0 : absL[1] >= absL[2] ? 1 : 2;
  const rows: H3[] = [];
  for (let i = 0; i < 3; i++) if (i !== drop) rows.push([i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0] as H3);
  const [r1, r2] = rows;
  const T: Mat3 = [r1[0], r1[1], r1[2], r2[0], r2[1], r2[2], l[0], l[1], l[2]];
  const Tinv = invertMat3(T);
  if (!Tinv) return null;
  // chart 坐标（分量各自允许不同的 w 处理——ε 规则的落点）
  const projC = (p: Pt, w: number): Pt => ({
    x: (r1[0] * p.x + r1[1] * p.y + r1[2]) / w,
    y: (r2[0] * p.x + r2[1] * p.y + r2[2]) / w,
  });
  // 族在 chart 像里精确平行（射影事实）→ 在锚点取一次方向即全局方向。
  const dirInChart = (fam: Family): Pt => {
    const d = fam.kind === "pencil"
      ? { x: fam.vp.x - anchor.x, y: fam.vp.y - anchor.y }
      : fam.dir;
    const L = Math.hypot(d.x, d.y) || 1;
    const step = Math.max(1, w0 / 4);   // 小步防跨线
    const p2 = { x: anchor.x + (d.x / L) * step, y: anchor.y + (d.y / L) * step };
    const q1 = projC(anchor, w0), q2 = projC(p2, wOf(p2));
    return { x: q2.x - q1.x, y: q2.y - q1.y };
  };
  const da = dirInChart(famA), db = dirInChart(famB);
  const det = da.x * db.y - da.y * db.x;
  if (Math.abs(det) < 1e-12) return null;
  // M：chart 方向 → 坐标轴。u 沿 famA 方向增长（u 枚举 famB 族的线），v 沿 famB 方向增长（枚举 famA 族）。
  const m11 = db.y / det, m12 = -db.x / det;    // → u
  const m21 = -da.y / det, m22 = da.x / det;    // → v
  // ε 规则：枚举 pencil 族的坐标饱和（u 枚举 famB、v 枚举 famA）；parallel 枚举坐标真发散 + clamp。
  const uSat = famB.kind === "pencil";
  const vSat = famA.kind === "pencil";
  const anchorChart = projC(anchor, w0);
  const toPlane = (p: Pt): Pt => {
    const w = wOf(p);
    const coord = (sat: boolean): Pt => {
      const we = sat ? Math.max(w, HORIZON_EPS) : Math.max(w, 1e-9);
      const c = projC(p, we);
      return { x: c.x - anchorChart.x, y: c.y - anchorChart.y };
    };
    const cSat = coord(true), cTrue = coord(false);
    const cu = uSat ? cSat : cTrue;
    const cv = vSat ? cSat : cTrue;
    let u = m11 * cu.x + m12 * cu.y;
    let v = m21 * cv.x + m22 * cv.y;
    if (!Number.isFinite(u)) u = DEPTH_BIG;
    if (!Number.isFinite(v)) v = DEPTH_BIG;
    return {
      x: Math.max(-DEPTH_BIG, Math.min(DEPTH_BIG, u)),
      y: Math.max(-DEPTH_BIG, Math.min(DEPTH_BIG, v)),
    };
  };
  // 逆映射（无 ε——生成几何时只喂有效域）：(u,v) → chart → T⁻¹ 齐次还原 → doc；异侧/无穷远 → null。
  const toDoc = (u: number, v: number): Pt | null => {
    const cx = da.x * u + db.x * v + anchorChart.x;
    const cy = da.y * u + db.y * v + anchorChart.y;
    const p = applyMat3(Tinv, cx, cy);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    if (wOf(p) <= 0) return null;
    return p;
  };
  return { toPlane, toDoc };
}

// ---- 直线约束的吸附方向（透视辅助线）----
//
// 吸向所有已配置 VP 的方向 + 尚存的平行族（有水平 VP 对 → 水平族已收敛、退场；
// 有 vp3 → 竖直族退场；三点透视只剩三个 VP 方向）。离拖拽方向最近者胜（caller 做投影）。
export function snapDirections(cfg: PerspConfig, from: Pt): Pt[] {
  const dirs: Pt[] = [];
  const addVp = (vp: Vp | null) => {
    if (!vp) return;
    const d = { x: vp.x - from.x, y: vp.y - from.y };
    const L = Math.hypot(d.x, d.y);
    if (L > 1e-6) dirs.push({ x: d.x / L, y: d.y / L });
  };
  addVp(cfg.vp1); addVp(cfg.vp2); addVp(cfg.vp3);
  if (!(cfg.vp1 && cfg.vp2)) dirs.push(H_DIR);   // 水平族尚存（0/1 个水平 VP）
  if (!cfg.vp3) dirs.push(V_DIR);                 // 竖直族尚存
  return dirs;
}

// 终点投影到最近吸附方向（对齐 snapLineEnd 的「投影跟手」语义）
export function snapToDirections(x0: number, y0: number, x: number, y: number, dirs: Pt[]): Pt {
  const dx = x - x0, dy = y - y0;
  const L = Math.hypot(dx, dy);
  if (L === 0 || !dirs.length) return { x, y };
  let best: Pt = dirs[0], bestDot = -1;
  for (const d of dirs) {
    const dot = Math.abs((dx * d.x + dy * d.y) / L);
    if (dot > bestDot) { bestDot = dot; best = d; }
  }
  const proj = dx * best.x + dy * best.y;
  return { x: x0 + best.x * proj, y: y0 + best.y * proj };
}

// ---- VP1/VP2 规范化（左=1 右=2；lockHorizon 锁 y）----
export function normalizeConfig(cfg: PerspConfig): PerspConfig {
  let { vp1, vp2 } = cfg;
  if (vp1 && vp2) {
    if (vp2.x < vp1.x) { const t = vp1; vp1 = vp2; vp2 = t; }
    if (cfg.lockHorizon) vp2 = { x: vp2.x, y: vp1.y };
  }
  return { ...cfg, vp1, vp2 };
}
