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
//     所有跨线路径都要 ε 护栏。徒手拟合走 chart（doc→plane 逆映射，见 planeChart）；
//     rect/grid/像素椭圆的两角定形只有**用户角点** doc 锚定，导出角是族线交点、
//     跨线时正落在奇点上（真机：天空里长出第二个矩形，2026-07-28）——quadFromCorners
//     在任一角进 ε 带/越线时改走 chart 平面坐标（同一套 ε 规则）钉回锚点 patch。
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
  plane: PlaneId;
  // isometric（v0.6.20）：纯平行三轴。有 axes = iso 模式，vp1-3 恒 null；
  //   平行×平行无消失线（vanishingLineOf→null）→ 全管线走仿射路径，零奇点。
  axes?: [Family, Family, Family] | null;
}

// 方向族：pencil = 过 VP 的线束；parallel = 平行族（dir 单位向量）
export type Family =
  | { kind: "pencil"; vp: Vp }
  | { kind: "parallel"; dir: Pt };

const H_DIR: Pt = { x: 1, y: 0 };
const V_DIR: Pt = { x: 0, y: 1 };

// ---- isometric（2:1 像素惯例，ADR-0006「排队」项 → v0.6.20 落地）----
// 方向：对角 ±(2,∓1)/√5 + 竖直——2:1 斜率是有理数，格点连线 Bresenham 对称（非 22.5°/30°，user 拍板）。
// 世界单位屏向量（正方/正圆度量用）：对角 (±2,−1)、竖直 (0,2)——单位立方 = 顶面菱形 4×2 + 侧高 2
//   （经典 2:1 像素 iso 立方，sprite 恰 4×4）。
const ISO_S5 = Math.sqrt(5);
export const ISO_AXES: [Family, Family, Family] = [
  { kind: "parallel", dir: { x: 2 / ISO_S5, y: -1 / ISO_S5 } },   // 轴1 右上对角
  { kind: "parallel", dir: { x: -2 / ISO_S5, y: -1 / ISO_S5 } },  // 轴2 左上对角
  { kind: "parallel", dir: V_DIR },                                // 轴3 竖直
];
const ISO_UNIT: [Pt, Pt, Pt] = [{ x: 2, y: -1 }, { x: -2, y: -1 }, { x: 0, y: 2 }];
function isoUnitFor(fam: Family): Pt | null {
  if (fam.kind !== "parallel") return null;
  for (let i = 0; i < 3; i++) {
    const d = (ISO_AXES[i] as { kind: "parallel"; dir: Pt }).dir;
    if (Math.abs(d.x - fam.dir.x) < 1e-9 && Math.abs(d.y - fam.dir.y) < 1e-9) return ISO_UNIT[i];
  }
  return null;
}

// 地平线奇点 ε：pencil 枚举坐标的 1/w 饱和阈值。
// v0.6.23（user 拍板）：ε **无量纲化** = 杠杆封顶——ε_lat = max(2px, w0/HORIZON_LEVER)，
//   w0 = 锚点到消失线距离。绝对 px 是错量纲（杠杆 = w0/ε 随构图无界：锚点 300px 时 2px ε
//   = 150× 放大，1px 拖拽近边跳 150px——真机"太小"的根源）。封顶 5× 后构图自适应、缩放不变。
export const HORIZON_EPS = 2;
export const HORIZON_LEVER = 5;
export function horizonEpsFor(w0: number): number { return Math.max(HORIZON_EPS, w0 / HORIZON_LEVER); }
// 越线回缩的发丝带（sub-pixel ≈ 就钉在施瓦西半径上）：纵深 1/PIN → BIG（"跑到 infinity"），
//   横向由 ε_lat 饱和跟手。与 ε_lat 解耦（v0.6.23 拍板）——ε_lat 管梯度、PIN 管远边钉哪。
export const HORIZON_PIN = 0.5;
// parallel 枚举坐标（真发散方向）的 clamp（"按无穷大算"的有限替身；过线不翻负、钉在 +BIG）
const DEPTH_BIG = 1e6;

// 当前配置下某平面的两个方向族。配置凑不齐该平面 → null（UI 应据此过滤菜单）。
export function planeFamilies(cfg: PerspConfig): [Family, Family] | null {
  const { vp1, vp2, vp3, plane } = cfg;
  if (cfg.axes) {   // iso：ground=顶面(轴1×轴2) / wallL=左面(轴2×竖直) / wallR=右面(轴1×竖直)
    const [f1, f2, f3] = cfg.axes;
    if (plane === "ground") return [f1, f2];
    if (plane === "wallL") return [f2, f3];
    if (plane === "wallR") return [f1, f3];
    return null;
  }
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

// 两族的消失线（归一化齐次，w(p)=ℓ·p = 到消失线的有向 doc 距离）。
//   两族都 parallel（0 VP，仿射）→ null = 无奇点。
function vanishingLineOf(famA: Family, famB: Family): H3 | null {
  const pa: H3 = famA.kind === "pencil" ? [famA.vp.x, famA.vp.y, 1] : [famA.dir.x, famA.dir.y, 0];
  const pb: H3 = famB.kind === "pencil" ? [famB.vp.x, famB.vp.y, 1] : [famB.dir.x, famB.dir.y, 0];
  const l = cross3(pa, pb);
  const n = Math.hypot(l[0], l[1]);
  if (n < 1e-12) return null;
  return [l[0] / n, l[1] / n, l[2] / n];
}

// 两个对角点 → 四边形（顺序 c0 → A(c0)∩B(c1) → c1 → A(c1)∩B(c0)，对应单位方
//   (0,0)(1,0)(1,1)(0,1)：famA 线 = v=const 边族，famB 线 = u=const 边族）。
//   c0 贴 VP/消失线（病态）→ null，caller 按无效拖拽处理。
//   跨地平线（任一角 w < ε）不再解析延拓（旧行为 = 导出角翻到对侧 → bowtie →
//   天空里长出第二个矩形）：改走 chart 平面坐标（ε 规则），quad 恒在 c0 的
//   manifold patch 内——过线的角钉在无穷远的有限替身上、收敛进 VP。
export function quadFromCorners(c0: Pt, c1: Pt, famA: Family, famB: Family): [Pt, Pt, Pt, Pt] | null {
  const l = vanishingLineOf(famA, famB);
  if (l) {
    const w0raw = l[0] * c0.x + l[1] * c0.y + l[2];
    const s = w0raw < 0 ? -1 : 1;                      // 锚点(c0)侧为正
    const w0 = s * w0raw;
    const w1 = s * (l[0] * c1.x + l[1] * c1.y + l[2]);
    const bothPencil = famA.kind === "pencil" && famB.kind === "pencil";
    const band = bothPencil ? HORIZON_EPS : HORIZON_PIN;   // 双 pencil：回缩带=饱和带（旧行为，见 planeChart 注）
    if (w0 < HORIZON_EPS || w1 < (bothPencil ? HORIZON_EPS : horizonEpsFor(w0))) {
      const chart = planeChart(famA, famB, c0);
      if (!chart) return null;                          // c0 就在消失线上：病态
      // c1 进饱和带 → chart 平面坐标（横向被 ε_lat 饱和，杠杆 ≤5×）；越线 → 先垂直回缩：
      //   有平行族 → **发丝带 PIN=0.5px**（≈ 钉在施瓦西半径上）——纵深 1/PIN→BIG（"跑到
      //   infinity"）、横向按回缩点分子在 ε_lat 下跟手；双 pencil → 回缩到 2px 带（纠缠，
      //   见 planeChart 注）。深天空原始分子可变号，直接喂 toPlane 会翻面/出负坐标
      //   （v0.6.18/v0.6.23 两轮教训），回缩后符号恒稳。
      const c1e = w1 < band
        ? { x: c1.x + s * l[0] * (band - w1), y: c1.y + s * l[1] * (band - w1) }
        : c1;
      const P1 = chart.toPlane(c1e);
      const p10 = chart.toDoc(P1.x, 0);
      const p01 = chart.toDoc(0, P1.y);
      const c1p = chart.toDoc(P1.x, P1.y);
      if (!p10 || !p01 || !c1p) return null;
      return [c0, p10, c1p, p01];
    }
  }
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
  // 消失线 ℓ = 两族无穷远点的连线（parallel 族的点在无穷远，pencil 族的点 = VP）；
  //   归一后 w(p) = 到消失线的**有向 doc 距离**（px）。0 VP → 仿射 frame。
  let l: H3 = vanishingLineOf(famA, famB) ?? [0, 0, 1];
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
  // **尺度归一 ×w0**：射影 chart 天然把坐标缩到 ~1/w0，锚点附近 1 plane 单位 ≈ 1/w0 doc px——
  //   下游 fitEllipse 的 MIN_RADIUS/护栏阈值全是 doc px 语义，不归一小圆会被 MIN_RADIUS 撑爆
  //   （真机现象：透视圆画出来不对，2026-07-25 修）。乘 w0 后锚点处 1 plane 单位 ≈ 1 doc px。
  const m11 = w0 * db.y / det, m12 = -w0 * db.x / det;    // → u
  const m21 = -w0 * da.y / det, m22 = w0 * da.x / det;    // → v
  // ε 规则：枚举 pencil 族的坐标饱和（u 枚举 famB、v 枚举 famA）；parallel 枚举坐标真发散 + clamp。
  //   v0.6.23：ε = 杠杆封顶版（horizonEpsFor）；纵深(非饱和)坐标越线（w≤0）**强制钉 +BIG**——
  //   user 原意"跑到 infinity 钉在施瓦西半径上，只要不跳到 -infinity"；不能用 max(w,1e-9) 除法，
  //   对侧深处分子会变号翻 -BIG = 翻面复活（v0.6.18 教训）。w→0⁺ 真值本就 clamp +BIG，衔接连续。
  const uSat = famB.kind === "pencil";
  const vSat = famA.kind === "pencil";
  // 双 pencil 平面（二/三点地面）：纵深与横向纠缠（两轴都收敛地平线），杠杆封顶的大 ε 会把
  //   饱和坐标对拉出 patch（p10 出负坐标 toDoc null，2026-07-28 晚踩过）→ 保持 2px 带旧行为；
  //   有平行族的模式（一点地面/各墙面）才享受 w0/5 无量纲封顶。
  const epsLat = (uSat && vSat) ? HORIZON_EPS : horizonEpsFor(w0);
  const anchorChart = projC(anchor, w0);
  const toPlane = (p: Pt): Pt => {
    const w = wOf(p);
    const coord = (sat: boolean): Pt => {
      const we = sat ? Math.max(w, epsLat) : Math.max(w, 1e-9);
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
    if (w <= 0) {
      if (!uSat) u = DEPTH_BIG;   // 纵深越线：钉无穷远替身（正向），横向仍按 1/ε 跟手
      if (!vSat) v = DEPTH_BIG;
    }
    return {
      x: Math.max(-DEPTH_BIG, Math.min(DEPTH_BIG, u)),
      y: Math.max(-DEPTH_BIG, Math.min(DEPTH_BIG, v)),
    };
  };
  // 逆映射（无 ε——生成几何时只喂有效域）：(u,v) → chart → T⁻¹ 齐次还原 → doc；异侧/无穷远 → null。
  const toDoc = (u: number, v: number): Pt | null => {
    const su = u / w0, sv = v / w0;   // 尺度归一的逆
    const cx = da.x * su + db.x * sv + anchorChart.x;
    const cy = da.y * su + db.y * sv + anchorChart.y;
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
  if (cfg.axes) return cfg.axes.map((f) => (f as { dir: Pt }).dir);   // iso：只吸三轴
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

// ---- 透视模式（UI 重做 2026-07-25：显式四态 subtool 取代"按 VP 数隐式判"）----

export type PerspMode = "off" | "p1" | "p2" | "p3" | "iso";

// 各模式的合法平面（p1 无左右墙——user 拍板；纵深墙叫「墙」）
export function planesForMode(mode: PerspMode): PlaneId[] {
  if (mode === "p1") return ["ground", "wall"];
  if (mode === "p2" || mode === "p3") return ["ground", "wallL", "wallR"];
  if (mode === "iso") return ["ground", "wallL", "wallR"];   // 顶面/左面/右面（复用 UI 行）
  return [];
}

// per-mode VP 槽位（user 拍板：一/二/三点透视分开存，切模式互不污染）
export interface PerspModeState {
  mode: string; lockHorizon: boolean; plane: string;
  p1: { vp1: Vp | null };
  p2: { vp1: Vp | null; vp2: Vp | null };
  p3: { vp1: Vp | null; vp2: Vp | null; vp3: Vp | null };
}

// 模式 + 该模式槽位的 VP → 引擎吃的 PerspConfig（off/缺 VP → null=视口对齐）。
//   plane 不合法时 coerce 到 ground。纯函数可测。
export function configFromModeState(g: PerspModeState): PerspConfig | null {
  const mode = g.mode as PerspMode;
  if (mode === "iso") {
    const planes = planesForMode("iso") as string[];
    const plane = planes.includes(g.plane) ? (g.plane as PlaneId) : "ground";
    return { vp1: null, vp2: null, vp3: null, lockHorizon: g.lockHorizon, plane, axes: ISO_AXES };
  }
  if (mode !== "p1" && mode !== "p2" && mode !== "p3") return null;
  const slot = mode === "p1" ? { ...g.p1, vp2: null, vp3: null }
    : mode === "p2" ? { ...g.p2, vp3: null } : g.p3;
  if (!slot.vp1) return null;
  if ((mode === "p2" || mode === "p3") && !slot.vp2) return null;
  if (mode === "p3" && !slot.vp3) return null;
  const planes = planesForMode(mode);
  const plane = (planes as string[]).includes(g.plane) ? (g.plane as PlaneId) : "ground";
  return normalizeConfig({
    vp1: slot.vp1, vp2: slot.vp2, vp3: slot.vp3,
    lockHorizon: g.lockHorizon,
    plane,
  });
}

// 各模式的 VP 默认位（user 拍板两轮：一点=画布正中；二点 VP1-VP2 **总间隔 2×H**（每侧 ±1H；
//   曾误给每侧 2H 被打回「太开」）；VP3 上方 1.5×H 仰视，俯视拖下去即可）。坐标 snap 像素中线。
export function defaultVpsForMode(mode: PerspMode, docW: number, docH: number): { vp1: Vp | null; vp2: Vp | null; vp3: Vp | null } {
  const c = (v: number) => Math.floor(v) + 0.5;
  const cx = c(docW / 2), cy = c(docH / 2);
  if (mode === "p1") return { vp1: { x: cx, y: cy }, vp2: null, vp3: null };
  if (mode === "p2") return { vp1: { x: c(docW / 2 - 1.0 * docH), y: cy }, vp2: { x: c(docW / 2 + 1.0 * docH), y: cy }, vp3: null };
  if (mode === "p3") return {
    vp1: { x: c(docW / 2 - 1.0 * docH), y: cy },
    vp2: { x: c(docW / 2 + 1.0 * docH), y: cy },
    vp3: { x: cx, y: c(docH / 2 - 1.5 * docH) },
  };
  return { vp1: null, vp2: null, vp3: null };
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

// ═══ 参考 box（UI v2.1，user 拍板：与 VP 手柄同时启用，VP = SSoT，box 只是控制面）═══
//
// 弱透视（尤其三点）时 VP 在 10×H 外，拖 VP 本体控制灵敏度全在远端；box 把灵敏度搬回
// 画布内：拖 box 的角点 → 非线性求解（阻尼 Gauss-Newton，数值 Jacobian）反算 VP。
// box 参数化保证「透视可实现」：锚角 A + 三个轴向行程 t（pencil 轴 = 走向 VP 的分数，
// parallel 轴 = doc px 长度），八角全部由族线交点构造——不存在摆不成 box 的自由角点。

export interface BoxParams { A: Vp; t: [number, number, number]; }

export function boxAxesForMode(mode: PerspMode, vp1: Vp | null, vp2: Vp | null, vp3: Vp | null): [Family, Family, Family] | null {
  if (mode === "iso") return ISO_AXES;   // 轴固定（2:1 惯例），无 VP
  if (mode === "p1" && vp1) return [{ kind: "pencil", vp: vp1 }, { kind: "parallel", dir: { x: 1, y: 0 } }, { kind: "parallel", dir: { x: 0, y: 1 } }];
  if (mode === "p2" && vp1 && vp2) return [{ kind: "pencil", vp: vp1 }, { kind: "pencil", vp: vp2 }, { kind: "parallel", dir: { x: 0, y: 1 } }];
  if (mode === "p3" && vp1 && vp2 && vp3) return [{ kind: "pencil", vp: vp1 }, { kind: "pencil", vp: vp2 }, { kind: "pencil", vp: vp3 }];
  return null;
}

function _alongAxis(A: Pt, axis: Family, t: number): Pt {
  return axis.kind === "pencil"
    ? { x: A.x + t * (axis.vp.x - A.x), y: A.y + t * (axis.vp.y - A.y) }
    : { x: A.x + t * axis.dir.x, y: A.y + t * axis.dir.y };
}

// 八角：A, B1, B2, B3, C12, C13, C23, D123（任一交点病态 → null）
export function boxCorners(axes: [Family, Family, Family], box: BoxParams): Pt[] | null {
  const [a1, a2, a3] = axes;
  const A = box.A;
  const B1 = _alongAxis(A, a1, box.t[0]);
  const B2 = _alongAxis(A, a2, box.t[1]);
  const B3 = _alongAxis(A, a3, box.t[2]);
  const C12 = intersectLines(familyLineThrough(B1, a2), familyLineThrough(B2, a1));
  const C13 = intersectLines(familyLineThrough(B1, a3), familyLineThrough(B3, a1));
  const C23 = intersectLines(familyLineThrough(B2, a3), familyLineThrough(B3, a2));
  if (!C12 || !C13 || !C23) return null;
  const D = intersectLines(familyLineThrough(C12, a3), familyLineThrough(C13, a2));
  if (!D) return null;
  return [A, B1, B2, B3, C12, C13, C23, D];
}

// box 的 12 条棱（画 gizmo 用；索引对 boxCorners 的顺序）
export const BOX_EDGES: Array<[number, number]> = [
  [0, 1], [0, 2], [0, 3],
  [1, 4], [2, 4], [1, 5], [3, 5], [2, 6], [3, 6],
  [4, 7], [5, 7], [6, 7],
];

// n×n 高斯消元（部分主元）。奇异 → null。
function solveN(M: number[][], b: number[]): number[] | null {
  const n = b.length;
  const a = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null;
    if (piv !== col) { const t = a[col]; a[col] = a[piv]; a[piv] = t; }
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = a[r][n];
    for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
}

export interface BoxDragState {
  mode: PerspMode;
  lockHorizon: boolean;
  vp1: Vp; vp2: Vp | null; vp3: Vp | null;
  box: BoxParams;
}

// 拖 box 角 → 阻尼 Gauss-Newton 反算 (VP, box)。cornerIdx 目标权重 1，其余角权重 0.15
//   （既跟手又不让 box 整体乱跑）。解不动/病态 → 返原状态（拖拽无响应但不崩）。
export function solveBoxDrag(st: BoxDragState, cornerIdx: number, target: Pt): BoxDragState {
  const pack = (s: BoxDragState): number[] => {
    const p = [s.box.A.x, s.box.A.y, s.box.t[0], s.box.t[1], s.box.t[2], s.vp1.x, s.vp1.y];
    if (s.mode !== "p1" && s.vp2) { p.push(s.vp2.x); if (!s.lockHorizon) p.push(s.vp2.y); }
    if (s.mode === "p3" && s.vp3) { p.push(s.vp3.x, s.vp3.y); }
    return p;
  };
  const unpack = (p: number[]): BoxDragState => {
    let i = 0;
    const A = { x: p[i++], y: p[i++] };
    const t: [number, number, number] = [p[i++], p[i++], p[i++]];
    const vp1 = { x: p[i++], y: p[i++] };
    let vp2: Vp | null = null, vp3: Vp | null = null;
    if (st.mode !== "p1" && st.vp2) {
      const x = p[i++];
      const y = st.lockHorizon ? vp1.y : p[i++];
      vp2 = { x, y };
    }
    if (st.mode === "p3" && st.vp3) vp3 = { x: p[i++], y: p[i++] };
    return { mode: st.mode, lockHorizon: st.lockHorizon, vp1, vp2, vp3, box: { A, t } };
  };
  const cornersOf = (s: BoxDragState): Pt[] | null => {
    const axes = boxAxesForMode(s.mode, s.vp1, s.vp2, s.vp3);
    return axes ? boxCorners(axes, s.box) : null;
  };
  const base = cornersOf(st);
  if (!base) return st;
  const HOLD = 0.15;
  const residuals = (s: BoxDragState): number[] | null => {
    const cs = cornersOf(s);
    if (!cs) return null;
    const r: number[] = [];
    for (let k = 0; k < 8; k++) {
      const w = k === cornerIdx ? 1 : HOLD;
      const ref = k === cornerIdx ? target : base[k];
      r.push(w * (cs[k].x - ref.x), w * (cs[k].y - ref.y));
    }
    return r;
  };
  let p = pack(st);
  const n = p.length;
  for (let iter = 0; iter < 4; iter++) {
    const s0 = unpack(p);
    const r0 = residuals(s0);
    if (!r0) break;
    // 数值 Jacobian（前向差分；坐标步长 0.5px、行程步长 0.002）
    const J: number[][] = [];
    for (let j = 0; j < n; j++) {
      const h = j >= 2 && j <= 4 && st.mode !== "p1" ? 0.002 : (j >= 2 && j <= 4 ? 0.5 : 0.5);
      const pj = [...p]; pj[j] += h;
      const rj = residuals(unpack(pj));
      if (!rj) { J.push(new Array(r0.length).fill(0)); continue; }
      J.push(r0.map((v, k) => (rj[k] - v) / h));
    }
    // (JᵀJ + λI) δ = −Jᵀr
    const M: number[][] = [], b: number[] = [];
    for (let i2 = 0; i2 < n; i2++) {
      b.push(-J[i2].reduce((acc, v, k) => acc + v * r0[k], 0));
      const row: number[] = [];
      for (let j2 = 0; j2 < n; j2++) {
        row.push(J[i2].reduce((acc, v, k) => acc + v * J[j2][k], 0));
      }
      row[i2] += 1e-3 * (row[i2] || 1);
      M.push(row);
    }
    const delta = solveN(M, b);
    if (!delta || delta.some((d) => !Number.isFinite(d))) break;
    for (let j = 0; j < n; j++) p[j] += delta[j];
    // 行程护栏：pencil 轴 t ∈ [0.02, 0.9]（越过 VP = 翻面）；parallel 轴不限号
    const s1 = unpack(p);
    const axes = boxAxesForMode(s1.mode, s1.vp1, s1.vp2, s1.vp3);
    if (axes) {
      for (let ax = 0; ax < 3; ax++) {
        if (axes[ax].kind === "pencil") p[2 + ax] = Math.max(0.02, Math.min(0.9, p[2 + ax]));
      }
    }
  }
  const out = unpack(p);
  return cornersOf(out) ? out : st;
}

// ═══ 平面欧氏度量（UI v2.4，user：正方/正圆也 respect 透视 frame）═══
//
// 之前判「平面内正方/正圆无度量」——升级：度量由**经典透视约定**确定（三族方向在 3D 互相
// 垂直 + 主点约定），重建视点 E 即得平面真欧氏度量：
//   · 三点：主点 P0 = VP 三角形垂心（经典），d² = −(vp1−P0)·(vp2−P0)（Thales/垂直关系）；
//     钝角三角形 d²≤0 = 配置不可实现为三正交方向 → null（引擎回退）。
//   · 二点：P0 = 画布中心在地平线上的投影（夹进 VP 区间 5% margin），d² = s·(len−s)。
//   · 一点：P0 = VP，视距 d = docH（约定，与默认 VP 间距的观感一致）。
// 有 E 就有 3D：族方向 D = (vp−P0, d) / 平行族 (dir, 0)；场景平面过锚点(锚在画板 z=0 上)、
// 法线 = DA×DB。unproject = 视线∩平面；project = 3D→画板。正圆 = 平面上的欧氏圆的像；
// 正方 = 平面内 |du|==|dv| 的四边形。

type V3 = [number, number, number];
const _sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const _dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const _scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const _add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const _cross3v = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const _len3 = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

// 垂心（两条高线的交点；2×2 线性解）
function _orthocenter(a: Vp, b: Vp, c: Vp): Vp | null {
  // 过 a ⊥ (b−c)：(b−c)·P = (b−c)·a；过 b ⊥ (a−c)：(a−c)·P = (a−c)·b
  const r1x = b.x - c.x, r1y = b.y - c.y, k1 = r1x * a.x + r1y * a.y;
  const r2x = a.x - c.x, r2y = a.y - c.y, k2 = r2x * b.x + r2y * b.y;
  const det = r1x * r2y - r1y * r2x;
  if (Math.abs(det) < 1e-9) return null;
  return { x: (k1 * r2y - r1y * k2) / det, y: (r1x * k2 - k1 * r2x) / det };
}

export interface PlaneMetric {
  project(P: V3): Pt | null;          // 3D → 画板（视线反向 → null）
  unproject(q: Pt): V3 | null;        // 画板 → 场景平面（越地平线/背面 → null）
  U: V3; V: V3;                       // 平面内正交单位基（U ∥ famA 方向）
  A3: V3;                             // 锚点（在画板上，场景平面过它）
}

export function planeMetric(cfg: PerspConfig, famA: Family, famB: Family, anchor: Pt, docW: number, docH: number): PlaneMetric | null {
  if (cfg.axes) {
    // iso：平行投影（视点在无穷远）——经典约定的视点重建发散，改**解析仿射度量**。
    // 3D 坐标系直接取平面坐标 (u,v,0)：project = 仿射映回屏；unproject = 2×2 线性解。
    // 接口不变 → constrainSquareOnPlane / metricCirclePolyline 下游零改动。
    const wA = isoUnitFor(famA), wB = isoUnitFor(famB);
    if (!wA || !wB) return null;
    const det = wA.x * wB.y - wA.y * wB.x;
    if (Math.abs(det) < 1e-9) return null;
    const ax = anchor.x, ay = anchor.y;
    return {
      project: (P: V3): Pt => ({ x: ax + P[0] * wA.x + P[1] * wB.x, y: ay + P[0] * wA.y + P[1] * wB.y }),
      unproject: (q: Pt): V3 => {
        const rx = q.x - ax, ry = q.y - ay;
        return [(rx * wB.y - ry * wB.x) / det, (ry * wA.x - rx * wA.y) / det, 0];
      },
      U: [1, 0, 0], V: [0, 1, 0], A3: [0, 0, 0],
    };
  }
  const { vp1, vp2, vp3 } = cfg;
  let P0: Vp | null = null;
  let d2 = 0;
  if (vp1 && vp2 && vp3) {
    P0 = _orthocenter(vp1, vp2, vp3);
    if (!P0) return null;
    d2 = -((vp1.x - P0.x) * (vp2.x - P0.x) + (vp1.y - P0.y) * (vp2.y - P0.y));
  } else if (vp1 && vp2) {
    const ex = vp2.x - vp1.x, ey = vp2.y - vp1.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) return null;
    const ux = ex / len, uy = ey / len;
    let s = (docW / 2 - vp1.x) * ux + (docH / 2 - vp1.y) * uy;
    s = Math.max(0.05 * len, Math.min(0.95 * len, s));
    P0 = { x: vp1.x + s * ux, y: vp1.y + s * uy };
    d2 = s * (len - s);
  } else if (vp1) {
    P0 = vp1;
    d2 = docH * docH;
  } else return null;
  if (!(d2 > 1)) return null;   // 不可实现（钝角三点配置等）
  const d = Math.sqrt(d2);
  const E: V3 = [P0.x, P0.y, -d];
  const dir3 = (fam: Family): V3 => {
    const v: V3 = fam.kind === "pencil" ? [fam.vp.x - P0!.x, fam.vp.y - P0!.y, d] : [fam.dir.x, fam.dir.y, 0];
    const L = _len3(v);
    return L > 1e-9 ? _scale3(v, 1 / L) : [1, 0, 0];
  };
  const U = dir3(famA);
  const DB = dir3(famB);
  let Vv = _sub3(DB, _scale3(U, _dot3(DB, U)));   // 约定下近正交，Gram-Schmidt 兜数值
  const vl = _len3(Vv);
  if (vl < 1e-6) return null;
  Vv = _scale3(Vv, 1 / vl);
  const n = _cross3v(U, Vv);
  const A3: V3 = [anchor.x, anchor.y, 0];
  const project = (P: V3): Pt | null => {
    const dz = P[2] - E[2];
    if (Math.abs(dz) < 1e-9) return null;
    const t = (0 - E[2]) / dz;
    if (t <= 1e-6) return null;   // 背面
    return { x: E[0] + t * (P[0] - E[0]), y: E[1] + t * (P[1] - E[1]) };
  };
  const unproject = (q: Pt): V3 | null => {
    const dir: V3 = [q.x - E[0], q.y - E[1], 0 - E[2]];
    const denom = _dot3(dir, n);
    if (Math.abs(denom) < 1e-12) return null;
    const t = _dot3(_sub3(A3, E), n) / denom;
    if (t <= 1e-6) return null;   // 越地平线/背面
    return _add3(E, _scale3(dir, t));
  };
  return { project, unproject, U, V: Vv, A3 };
}

// 正方约束：把拖拽角 c1 调整到平面内 |du|==|dv|（边长取 max，象限跟拖拽——同 _constrainSquare 语义）
export function constrainSquareOnPlane(m: PlaneMetric, c1: Pt): Pt | null {
  const C1 = m.unproject(c1);
  if (!C1) return null;
  const off = _sub3(C1, m.A3);
  const du = _dot3(off, m.U), dv = _dot3(off, m.V);
  const side = Math.max(Math.abs(du), Math.abs(dv));
  if (side < 1e-6) return null;
  const C = _add3(m.A3, _add3(_scale3(m.U, Math.sign(du || 1) * side), _scale3(m.V, Math.sign(dv || 1) * side)));
  return m.project(C);
}

// 正圆：平面欧氏圆（圆心=锚点、半径=到拖点的平面距离）的像，采样返回 doc 折线（背面点滤掉）
export function metricCirclePolyline(m: PlaneMetric, drag: Pt, n: number): Pt[] {
  const B = m.unproject(drag);
  if (!B) return [];
  const R = _len3(_sub3(B, m.A3));
  if (R < 1e-6) return [];
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const P = _add3(m.A3, _add3(_scale3(m.U, R * Math.cos(a)), _scale3(m.V, R * Math.sin(a))));
    const q = m.project(P);
    if (q) out.push(q);
  }
  return out;
}
