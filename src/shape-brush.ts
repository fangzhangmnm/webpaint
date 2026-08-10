// 形状笔引擎（ADR-0005 + ADR-0006 透视 frame）——CONTEXT [[Engine]] 名册里 ShapesEngine 的落位。
//
// 心智模型（user 2026-07-25）：形状笔是**笔**（对标滤镜笔），不是带 gizmo 的可编辑对象。
//   一个 shape = 一个 stroke：按下→拖动（live 预览 = 每 move 按当前几何整形重合成）→抬手落像素。
//   中断（切子工具/手势接管）= cancel 不进 undo，同笔刷画一半（input._abortStroke）。
//
// 子工具：line / rect / circle(圆·弧) / grid(尺笔退化版：nu×nv 平行线格，outer border 可开关，
//   默认 2×6 = 6 头身 + 中线；参考线画在图层上，不是 gizmo)。
//
// frame（形状笔全局，ADR-0006）：align-to-viewport（默认，几何相对视口轴）或 透视平面
//   （desk.persp：VP 0-3 个 + 平面选择）。透视下 rect=梯形/四边形、grid=透视缩短格、
//   circle 徒手拟合在平面 chart 里做、line 约束吸向 VP（透视辅助线）。
//   约束键在透视下全子工具有效（UI v2.4）：line=吸 VP；rect=平面欧氏正方、circle=平面欧氏圆
//   ——度量由经典约定重建视点（planeMetric：三点=垂心/二点=中心投影+Thales/一点=d=H），
//   推翻早先"无度量不可定义"的判断（那时漏了经典透视的正交方向约定这最后一块拼图）。
//
// 渲染路径：
//   · buffered 笔刷：几何 → 一组 polyline（grid 是多条！）→ 逐条驱动私有 BrushEngine →
//     merge 成单个 StampCollect（一条 undo）→ 现有 GPU stamp overlay / commitBrushStroke。
//   · pixelMode（像素画特化）：端点 clamp 整数像素中线、忽略视口旋转（透视 frame 照用——
//     user：像素也透视）；每像素恰好一颗（Bresenham 线/周界/Zingl 盒椭圆/Zingl 有理 Bézier
//     透视 conic + stampAt），全形状统一 seen-set 去重（格线交叉不双叠）；每帧
//     restoreFromSnapshot 擦上一帧再整形重画。
//   · 恒压 0.5、强制无 taper（覆写冻结 ResolvedBrush）。
import { BrushEngine } from "./backend/brush.ts";
import { disposeViewSnap as disposeLayerSnap } from "./backend/workpiece/painting-view.ts";
import {
  snapLineEnd, rectCorners, fitEllipse,
  linePolyline, rectPolyline, ellipseArcPolyline, maxSegLenFor,
  clampPixelCenter, bresenhamLine, bresenhamRectPerimeter, bresenhamEllipseRect,
  clipSegToBox, clipPolylineToBox,
} from "./shape-geometry.ts";
import type { ClipBox } from "./shape-geometry.ts";
import {
  planeFamilies, quadFromCorners, homographyUnitSquare, applyMat3,
  planeChart, snapDirections, snapToDirections,
  planeMetric, constrainSquareOnPlane, metricCirclePolyline,
} from "./perspective-frame.ts";
import { bresenhamConicInQuad } from "./pixel-conic.ts";
import type { Family, PerspConfig, Mat3 } from "./perspective-frame.ts";
import type { ViewLeafSnap as LayerSnap } from "./backend/workpiece/painting-view.ts";
import type { ViewLeaf } from "./backend/workpiece/painting-view.ts";
import type { ResolvedBrush } from "./resolved-brush.ts";
import type { Pt } from "./shape-geometry.ts";

export type ShapeSubTool = "line" | "rect" | "circle" | "grid";

export interface GridConfig { nu: number; nv: number; border: boolean; }

// 恒压值 = 鼠标主路径的既有常量（input.effectivePressureFor mouse 分支同款 0.5）
const SHAPE_PRESSURE = 0.5;

type Rect4 = [number, number, number, number];
type StampCollect = NonNullable<ReturnType<BrushEngine["collectStamps"]>>;

// begin 时冻结的 frame：viewport（rot）或已解析的透视平面（两族 + 可选 chart）
type Frame =
  | { kind: "viewport"; rot: number }
  | { kind: "persp"; cfg: PerspConfig; famA: Family; famB: Family };

interface ShapeStroke {
  layer: ViewLeaf;
  settings: ResolvedBrush;     // 已覆写 taperIn/Out=0 的冻结值
  mode: string;                // "brush" | "erase"
  frame: Frame;
  x0: number; y0: number;      // 起点（line/rect/grid 的锚）
  x1: number; y1: number;      // 当前点
  pts: Pt[];                   // circle 徒手拟合的 raw 点列（pixelMode 圆 = AABB 拖拽，不收集）
  preSnap: LayerSnap | null;   // pixelMode：每帧 restore 的基准
  lastPaint: Rect4 | null;     // pixelMode：上一帧画过的区（restore 后也要重渲）
  dirty: Rect4 | null;         // flushDirty 累计（input 每 move 取走喂 board.markDocDirty）
  cs: StampCollect | null;     // buffered：本帧合成缓存（多 polyline merge；live==commit 同一份）
}

export class ShapeBrushEngine {
  _inner = new BrushEngine();
  _subTool: ShapeSubTool = "line";
  // per-图形约束（user：分别持久化，默认全不锁）；grid 无约束语义
  _constrain: Record<"line" | "rect" | "circle", boolean> = { line: false, rect: false, circle: false };
  _constrainInvert = false;   // Shift hold 临时反转（行业惯例；描边中切换即时重合成）
  _grid: GridConfig = { nu: 2, nv: 6, border: false };   // 默认 6 头身 + 中线（user 拍板）
  _rotProvider: (() => number) | null = null;
  _perspProvider: (() => PerspConfig | null) | null = null;
  _st: ShapeStroke | null = null;

  setSubTool(s: ShapeSubTool) { this._subTool = s; }
  getSubTool(): ShapeSubTool { return this._subTool; }
  setConstrain(b: boolean) { if (this._subTool !== "grid") this._constrain[this._subTool] = !!b; }
  getConstrain(): boolean { return this._subTool === "grid" ? false : this._constrain[this._subTool]; }
  setConstrainFor(sub: "line" | "rect" | "circle", b: boolean) { this._constrain[sub] = !!b; }
  // Shift hold = 临时反转约束（PS/Figma 同族语义）；描边进行中切换立即重合成
  setConstrainInvert(b: boolean) {
    if (this._constrainInvert === !!b) return;
    this._constrainInvert = !!b;
    if (this._st) this._resynth();
  }
  _effConstrain(): boolean { return this.getConstrain() !== this._constrainInvert; }
  setGridConfig(g: Partial<GridConfig>) { this._grid = { ...this._grid, ...g }; }
  getGridConfig(): GridConfig { return { ...this._grid }; }
  // 视口 rot / 透视配置注入（app 接线 board.viewport 与 desk；引擎不认识两者）
  setViewportRotProvider(fn: (() => number) | null) { this._rotProvider = fn; }
  setPerspProvider(fn: (() => PerspConfig | null) | null) { this._perspProvider = fn; }

  _resolveFrame(pixel: boolean): Frame {
    const cfg = this._perspProvider?.();
    if (cfg && cfg.plane !== "off") {
      const fams = planeFamilies(cfg);
      if (fams) return { kind: "persp", cfg, famA: fams[0], famB: fams[1] };
    }
    // 像素格是 doc 轴的 → pixelMode 忽略视口旋转（透视 frame 不受此限——user：像素也透视）
    return { kind: "viewport", rot: pixel ? 0 : (this._rotProvider?.() ?? 0) };
  }

  // 签名与 BrushEngine.beginStroke 一致 → input._beginStroke 按 engineKey 通用调用。
  //   pressure/smooth/t 有意忽略（恒压 + 直通 + 合成时间戳）。
  beginStroke(layer: ViewLeaf, settings: ResolvedBrush, x: number, y: number, _pressure: number,
              mode: string = "brush", _smooth: object = {}, _t: number | null = null) {
    const s = { ...settings, taperIn: 0, taperOut: 0 } as ResolvedBrush;
    Object.freeze(s);
    if (s.pixelMode) { x = clampPixelCenter(x); y = clampPixelCenter(y); }
    this._st = {
      layer, settings: s, mode,
      frame: this._resolveFrame(!!s.pixelMode),
      x0: x, y0: y, x1: x, y1: y,
      pts: [{ x, y }],
      preSnap: s.pixelMode ? layer.snapshot() : null,
      lastPaint: null,
      dirty: null,
      cs: null,
    };
    this._resynth();
  }

  extendStroke(x: number, y: number, _pressure: number, _t: number | null = null) {
    const st = this._st;
    if (!st) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;   // NaN 护栏（同 BrushEngine）
    if (st.settings.pixelMode) { x = clampPixelCenter(x); y = clampPixelCenter(y); }
    st.x1 = x; st.y1 = y;
    // 圆的徒手拟合只在非像素模式收点（像素圆 = AABB 拖拽）
    if (this._subTool === "circle" && !st.settings.pixelMode) st.pts.push({ x, y });
    this._resynth();
  }

  // 抬手：buffered → 本帧合成缓存（与 live 同一份 StampCollect，input 走 board.commitBrushStroke）；
  //   pixelMode → 像素已写进写靶（C6 起 = StrokeSession 替身叶，落账真层由 session 收口做），清态返 null。
  endStroke(): StampCollect | null {
    const st = this._st;
    if (!st) return null;
    const out = st.settings.pixelMode ? null : st.cs;
    this._inner.cancelStroke();
    disposeLayerSnap(st.preSnap);
    this._st = null;
    return out;
  }

  // cancel = 无痕：pixelMode 把画上的擦回写靶。C6 起写靶 = session 替身叶（随即被丢弃）——
  //   这里的 preSnap restore 从「双保险」退役成无害冗余，真层无痕由 session 丢替身保证。
  cancelStroke() {
    const st = this._st;
    if (!st) return;
    if (st.preSnap) {
      st.layer.restoreFromSnapshot(st.preSnap);
      disposeLayerSnap(st.preSnap);
      if (st.lastPaint) this._mergeDirty(st, st.lastPaint);
    }
    this._inner.cancelStroke();
    this._st = null;
  }

  // GPU stamp overlay 拉取口（live 预览）。pixelMode 走 stroke 替身显示（C6，board.setStrokeShadow），无 stamps。
  collectStamps(): StampCollect | null {
    if (!this._st || this._st.settings.pixelMode) return null;
    return this._st.cs;
  }

  flushDirty(): Rect4 | null {
    const st = this._st;
    if (!st || !st.dirty) return null;
    const d = st.dirty;
    st.dirty = null;
    return d;
  }

  // ---- 几何（buffered）：当前拖拽 → 一组 polyline ----

  // 统一四边形：viewport = 旋转 AABB 四角；persp = 两角定形（病态 → null）。
  //   constrain 在 persp 下 = **平面欧氏正方**（UI v2.4，user：正方也 respect 透视 frame——
  //   度量由经典约定重建视点得到，见 planeMetric；度量不可实现时静默回退不约束）。
  _quad(st: ShapeStroke, constrain: boolean): [Pt, Pt, Pt, Pt] | null {
    const c0 = { x: st.x0, y: st.y0 }, c1 = { x: st.x1, y: st.y1 };
    if (st.frame.kind === "persp") {
      let cc = c1;
      if (constrain) {
        const m = planeMetric(st.frame.cfg, st.frame.famA, st.frame.famB, c0, st.layer.docW, st.layer.docH);
        const adj = m && constrainSquareOnPlane(m, c1);
        if (adj) cc = adj;
      }
      return quadFromCorners(c0, cc, st.frame.famA, st.frame.famB);
    }
    return rectCorners(c0, c1, st.frame.rot, constrain);
  }

  // 裁剪盒（ADR-0006 奇点护栏的采样面）：透视交点在地平线附近会飞到 1e5+ doc px，
  //   不裁剪 = 百万点级 polyline/Bresenham 卡死。pad 给足笔宽 + 出血。
  _clipBox(st: ShapeStroke): ClipBox {
    const pad = (st.settings.size || 4) + 64;
    return { x0: -pad, y0: -pad, x1: st.layer.docW + pad, y1: st.layer.docH + pad };
  }

  _polylines(st: ShapeStroke): Pt[][] {
    const seg = maxSegLenFor(st.settings.size, st.settings.spacing);
    const box = this._clipBox(st);
    if (this._subTool === "line") {
      let end: Pt = { x: st.x1, y: st.y1 };
      if (this._effConstrain()) {
        end = st.frame.kind === "persp"
          ? snapToDirections(st.x0, st.y0, st.x1, st.y1, snapDirections(st.frame.cfg, { x: st.x0, y: st.y0 }))
          : snapLineEnd(st.x0, st.y0, st.x1, st.y1);
      }
      return [linePolyline({ x: st.x0, y: st.y0 }, end, seg)];
    }
    if (this._subTool === "rect") {
      const q = this._quad(st, this._effConstrain());
      if (!q) return [];
      if (st.frame.kind === "viewport") return [rectPolyline(q, seg)];
      // 透视：四边逐段裁剪（角点可能在盒外很远）→ 各自一条 polyline
      const out: Pt[][] = [];
      for (let i = 0; i < 4; i++) {
        const c = clipSegToBox(q[i], q[(i + 1) % 4], box);
        if (c) out.push(linePolyline(c[0], c[1], seg));
      }
      return out;
    }
    if (this._subTool === "grid") {
      const q = this._quad(st, false);
      if (!q) return [];
      const H = homographyUnitSquare(q);
      if (!H) return [];
      const out: Pt[][] = [];
      for (const [a, b] of this._gridSegments(H)) {
        const c = clipSegToBox(a, b, box);
        if (c) out.push(linePolyline(c[0], c[1], seg));
      }
      return out;
    }
    // circle 正圆约束（user 两轮改规则）：**圆心拖半径**——起点=圆心，拖多远半径多大（仅非像素笔；
    //   像素笔永远 AABB）。透视 frame 下 = **平面欧氏圆的像**（UI v2.4：正圆也 respect 透视——
    //   半径按平面度量、圆在场景平面上；度量不可实现/拖点越地平线 → 回退 doc 空间完美圆）。
    if (this._effConstrain()) {
      if (st.frame.kind === "persp") {
        const m = planeMetric(st.frame.cfg, st.frame.famA, st.frame.famB, { x: st.x0, y: st.y0 }, st.layer.docW, st.layer.docH);
        if (m) {
          const coarse = metricCirclePolyline(m, { x: st.x1, y: st.y1 }, 48);
          if (coarse.length >= 8) {
            let perim = 0;
            for (let i = 1; i < coarse.length; i++) perim += Math.hypot(coarse[i].x - coarse[i - 1].x, coarse[i].y - coarse[i - 1].y);
            const n = Math.min(512, Math.max(24, Math.ceil(perim / seg)));
            return clipPolylineToBox(metricCirclePolyline(m, { x: st.x1, y: st.y1 }, n), box);
          }
        }
      }
      const r = Math.hypot(st.x1 - st.x0, st.y1 - st.y0);
      if (r < 0.5) return [[{ x: st.x0, y: st.y0 }]];
      const n = Math.min(512, Math.max(24, Math.ceil((2 * Math.PI * r) / seg)));
      const out: Pt[] = new Array(n + 1);
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        out[i] = { x: st.x0 + r * Math.cos(a), y: st.y0 + r * Math.sin(a) };
      }
      out[n] = { ...out[0] };
      return [out];
    }
    // circle：徒手拟合。persp → 在平面 chart 里做（ε 护栏在 chart 内），映回 doc。
    if (st.frame.kind === "persp") {
      const chart = planeChart(st.frame.famA, st.frame.famB, { x: st.x0, y: st.y0 });
      if (!chart) return [];
      const planePts = st.pts.map((p) => chart.toPlane(p));
      const fit = fitEllipse(planePts, 0, false);   // 平面内约束无度量（ADR-0006）→ constrain 忽略
      if (!fit) return [];
      // 平面 polyline → doc：密度按 doc 弧长控制（先粗映射估周长，再按 maxSegLen 重采样）；
      //   映射点可能飞远（近地平线）→ 裁剪盒截成若干 run
      const coarse = ellipseArcPolyline(fit, Math.max(perimOf(fit) / 64, 1e-6));
      const coarseDoc = coarse.map((p) => chart.toDoc(p.x, p.y)).filter((p): p is Pt => !!p);
      if (coarseDoc.length < 3) return [];
      let perim = 0;
      for (let i = 1; i < coarseDoc.length; i++) {
        const d = Math.hypot(coarseDoc[i].x - coarseDoc[i - 1].x, coarseDoc[i].y - coarseDoc[i - 1].y);
        perim += Math.min(d, st.layer.docW + st.layer.docH);   // 飞远段不计满（防 n 打顶失真）
      }
      const n = Math.min(512, Math.max(24, Math.ceil(perim / seg)));
      const fine = ellipseArcPolyline(fit, Math.max(perimOf(fit) / n, 1e-6));
      const fineDoc = fine.map((p) => chart.toDoc(p.x, p.y)).filter((p): p is Pt => !!p);
      return clipPolylineToBox(fineDoc, box);
    }
    const fit = fitEllipse(st.pts, st.frame.rot, false);   // 正圆已在上方走圆心拖半径，拟合恒椭圆
    return fit ? [ellipseArcPolyline(fit, seg)] : [[{ x: st.x0, y: st.y0 }]];
  }

  // grid 的线段集（单位方坐标 → H 映射；H 把线段映成线段，端点映完连直线即可）：
  //   内部分割线 nu-1 竖 + nv-1 横；border 开再加 4 边。
  _gridSegments(H: Mat3): Array<[Pt, Pt]> {
    const segs: Array<[Pt, Pt]> = [];
    const T = (u: number, v: number) => applyMat3(H, u, v);
    const { nu, nv, border } = this._grid;
    for (let i = 1; i < nu; i++) segs.push([T(i / nu, 0), T(i / nu, 1)]);
    for (let j = 1; j < nv; j++) segs.push([T(0, j / nv), T(1, j / nv)]);
    if (border) {
      segs.push([T(0, 0), T(1, 0)], [T(1, 0), T(1, 1)], [T(1, 1), T(0, 1)], [T(0, 1), T(0, 0)]);
    }
    return segs;
  }

  // ---- 合成 ----

  // 整形重合成：buffered 把每条 polyline 各驱动一遍私有 BrushEngine，merge 成单个
  //   StampCollect（grid 多线一条 undo）；O(点数+stamps)/move，与手绘同量级。
  _resynth() {
    const st = this._st!;
    if (st.settings.pixelMode) { this._resynthPixel(st); return; }
    const lists: StampCollect[] = [];
    for (const pts of this._polylines(st)) {
      if (!pts.length) continue;
      this._inner.cancelStroke();
      this._inner.beginStroke(st.layer, st.settings, pts[0].x, pts[0].y, SHAPE_PRESSURE, st.mode, { tau: 0, deadzone: 0 }, null);
      for (let i = 1; i < pts.length; i++) {
        this._inner.extendStroke(pts[i].x, pts[i].y, SHAPE_PRESSURE, null);
      }
      const cs = this._inner.endStroke();
      if (cs && cs.stamps.length) lists.push(cs);
    }
    st.cs = mergeCollects(lists);
  }

  // 像素模式：全形状统一 seen-set 去重（格线交叉/共享角不双叠）→ 每像素恰好一颗 stampAt。
  _resynthPixel(st: ShapeStroke) {
    st.layer.restoreFromSnapshot(st.preSnap!);
    this._inner.cancelStroke();
    const raw = this._pixelPixels(st);
    const seen = new Set<string>();
    const pts: Pt[] = [];
    for (const p of raw) {
      const k = p.x + "," + p.y;
      if (seen.has(k)) continue;
      seen.add(k);
      pts.push(p);
    }
    if (pts.length) {
      this._inner.beginStroke(st.layer, st.settings, pts[0].x, pts[0].y, SHAPE_PRESSURE, st.mode, { tau: 0, deadzone: 0 }, null);
      // 批量落点（begin 已 immediate 画第一颗）：128px 桶批 editRegion，替代逐像素 stampAt
      //   ——像素透视大圆拖拽卡顿的修法（user 批准 2026-07-25）
      this._inner.stampPixels(pts.slice(1), SHAPE_PRESSURE);
    }
    const painted = this._inner.flushDirty();
    if (st.lastPaint) this._mergeDirty(st, st.lastPaint);
    if (painted) this._mergeDirty(st, painted);
    st.lastPaint = painted;
  }

  // 像素模式几何（doc 格点；透视 frame 照用）：line=Bresenham（45° 倍数约束整数空间精确；
  //   透视约束吸 VP 方向后取整）；rect=周界/四边形四边；circle=**AABB/两角拖拽**（Zingl 盒椭圆
  //   或透视 conic）；grid=格线 Bresenham。
  _pixelPixels(st: ShapeStroke): Pt[] {
    const i0 = Math.floor(st.x0), j0 = Math.floor(st.y0);
    let i1 = Math.floor(st.x1), j1 = Math.floor(st.y1);
    const persp = st.frame.kind === "persp";
    if (this._subTool === "line") {
      if (this._effConstrain() && (i1 !== i0 || j1 !== j0)) {
        if (persp) {
          const e = snapToDirections(st.x0, st.y0, st.x1, st.y1, snapDirections((st.frame as { cfg: PerspConfig }).cfg, { x: st.x0, y: st.y0 }));
          i1 = Math.floor(e.x); j1 = Math.floor(e.y);
        } else {
          const k = Math.round(Math.atan2(j1 - j0, i1 - i0) / (Math.PI / 12));
          if (k % 3 === 0) {
            if (k % 12 === 0) j1 = j0;                                   // 水平
            else if (k % 6 === 0) i1 = i0;                               // 竖直
            else {                                                        // 对角 |di|==|dj|
              const L = Math.max(Math.abs(i1 - i0), Math.abs(j1 - j0));
              i1 = i0 + Math.sign(i1 - i0 || 1) * L;
              j1 = j0 + Math.sign(j1 - j0 || 1) * L;
            }
          } else {
            const e = snapLineEnd(st.x0, st.y0, st.x1, st.y1);
            i1 = Math.floor(e.x); j1 = Math.floor(e.y);
          }
        }
      }
      return bresenhamLine(i0, j0, i1, j1);
    }
    if (this._subTool === "circle" || this._subTool === "rect" || this._subTool === "grid") {
      if (!persp) {
        // 非透视：整数 AABB（constrain = 正方盒；grid 不吃 constrain）
        if (this._effConstrain() && this._subTool !== "grid") {
          const side = Math.max(Math.abs(i1 - i0), Math.abs(j1 - j0));
          i1 = i0 + Math.sign(i1 - i0 || 1) * side;
          j1 = j0 + Math.sign(j1 - j0 || 1) * side;
        }
        if (this._subTool === "rect") return bresenhamRectPerimeter(i0, j0, i1, j1);
        if (this._subTool === "circle") return bresenhamEllipseRect(i0, j0, i1, j1);
        // grid：轴对齐盒 + H（仿射）出格线端点 → Bresenham
        const q: [Pt, Pt, Pt, Pt] = [
          { x: i0 + 0.5, y: j0 + 0.5 }, { x: i1 + 0.5, y: j0 + 0.5 },
          { x: i1 + 0.5, y: j1 + 0.5 }, { x: i0 + 0.5, y: j1 + 0.5 },
        ];
        return this._gridPixels(q);
      }
      // 透视：两角定形 → 四边形（病态 → 空）。全部过裁剪盒（交点近地平线会飞远）。
      //   constrain（Shift 同样生效）→ 平面欧氏正方角点调整（UI v2.4；正圆盒 = 平面正方盒的内切 conic）
      const box = this._clipBox(st);
      const fr = st.frame as { cfg: PerspConfig; famA: Family; famB: Family };
      let c1p = { x: i1 + 0.5, y: j1 + 0.5 };
      if (this._effConstrain() && this._subTool !== "grid") {
        const m = planeMetric(fr.cfg, fr.famA, fr.famB, { x: i0 + 0.5, y: j0 + 0.5 }, st.layer.docW, st.layer.docH);
        const adj = m && constrainSquareOnPlane(m, c1p);
        if (adj) c1p = { x: Math.floor(adj.x) + 0.5, y: Math.floor(adj.y) + 0.5 };
      }
      const q = quadFromCorners(
        { x: i0 + 0.5, y: j0 + 0.5 }, c1p,
        fr.famA, fr.famB);
      if (!q) return [];
      if (this._subTool === "circle") return bresenhamConicInQuad(q, box);
      if (this._subTool === "rect") return quadPerimeterPixels(q, box);
      return this._gridPixels(q, box);
    }
    return [];
  }

  _gridPixels(q: [Pt, Pt, Pt, Pt], box?: ClipBox): Pt[] {
    const H = homographyUnitSquare(q);
    if (!H) return [];
    const out: Pt[] = [];
    for (let [a, b] of this._gridSegments(H)) {
      if (![a, b].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
      if (box) {
        const c = clipSegToBox(a, b, box);
        if (!c) continue;
        [a, b] = c;
      }
      out.push(...bresenhamLine(Math.floor(a.x), Math.floor(a.y), Math.floor(b.x), Math.floor(b.y)));
    }
    return out;
  }

  _mergeDirty(st: ShapeStroke, r: Rect4) {
    const d = st.dirty;
    if (!d) { st.dirty = [r[0], r[1], r[2], r[3]]; return; }
    if (r[0] < d[0]) d[0] = r[0];
    if (r[1] < d[1]) d[1] = r[1];
    if (r[2] > d[2]) d[2] = r[2];
    if (r[3] > d[3]) d[3] = r[3];
  }
}

// 椭圆整圈周长（采样密度用）
function perimOf(fit: { rx: number; ry: number; sweep: number; closed: boolean }): number {
  const h = ((fit.rx - fit.ry) ** 2) / ((fit.rx + fit.ry) ** 2);
  const full = Math.PI * (fit.rx + fit.ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  return fit.closed ? full : full * Math.abs(fit.sweep) / (Math.PI * 2);
}

// 透视四边形周界（像素）：四边裁剪后 Bresenham（角点重复由上层 seen-set 去重）
function quadPerimeterPixels(q: [Pt, Pt, Pt, Pt], box: ClipBox): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const c = clipSegToBox(q[i], q[(i + 1) % 4], box);
    if (!c) continue;
    out.push(...bresenhamLine(Math.floor(c[0].x), Math.floor(c[0].y), Math.floor(c[1].x), Math.floor(c[1].y)));
  }
  return out;
}

// 多 polyline 的 StampCollect 合并（grid 多线一条 undo；shape/layer/mode 同源取首个）
function mergeCollects(lists: StampCollect[]): StampCollect | null {
  if (!lists.length) return null;
  if (lists.length === 1) return lists[0];
  const base = lists[0];
  const stamps = lists.flatMap((c) => c.stamps);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const c of lists) {
    bx0 = Math.min(bx0, c.bx); by0 = Math.min(by0, c.by);
    bx1 = Math.max(bx1, c.bx + c.bw); by1 = Math.max(by1, c.by + c.bh);
  }
  return { ...base, stamps, bx: bx0, by: by0, bw: bx1 - bx0, bh: by1 - by0 };
}
