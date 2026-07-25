// 形状笔引擎（ADR-0005）——CONTEXT [[Engine]] 名册里 ShapesEngine 的落位。
//
// 心智模型（user 2026-07-25）：形状笔是**笔**（对标滤镜笔），不是带 gizmo 的可编辑对象。
//   一个 shape = 一个 stroke：按下→拖动（live 预览 = 每 move 按当前几何整条重合成）→抬手落像素。
//   中断（切子工具/手势接管）= cancel 不进 undo，同笔刷画一半（input._abortStroke）。
//
// 实现 = 几何(shape-geometry 纯函数) + 私有 BrushEngine 重合成：
//   · buffered 笔刷：合成 stamps → collectStamps 走现有 GPU stamp overlay（live==commit 同一份）；
//     endStroke 返回 StampCollect 由 input 走 board.commitBrushStroke（与主笔刷同路径）。
//   · pixelMode 笔刷：immediate in-place——每帧 restoreFromSnapshot(preSnap) 擦掉上一帧再整条
//     重驱动（快照 = tile 句柄共享零拷贝，可反复 restore；液化同款 in-place + live-sync 节律）。
//   · 恒压 0.5（user 拍板：不记录笔压，专注形状 = 鼠标矢量绘图体验）；**强制无视 taper**
//     （taper 是笔压修饰，笔压已禁用；机械绘制要粗细均匀）——覆写冻结 ResolvedBrush，不碰引擎。
//   · smoother 直通（tau=0/deadzone=0，t=null 走 FALLBACK_DT）：几何已精确，平滑只会拖后腿。
import { BrushEngine } from "./brush.ts";
import { disposeLayerSnap } from "./doc.ts";
import {
  snapLineEnd, rectCorners, fitEllipse,
  linePolyline, rectPolyline, ellipseArcPolyline, maxSegLenFor,
} from "./shape-geometry.ts";
import type { Layer, LayerSnap } from "./doc.ts";
import type { ResolvedBrush } from "./resolved-brush.ts";
import type { Pt } from "./shape-geometry.ts";

export type ShapeSubTool = "line" | "rect" | "circle";

// 恒压值 = 鼠标主路径的既有常量（input.effectivePressureFor mouse 分支同款 0.5）
const SHAPE_PRESSURE = 0.5;

type Rect4 = [number, number, number, number];

interface ShapeStroke {
  layer: Layer;
  settings: ResolvedBrush;     // 已覆写 taperIn/Out=0 的冻结值
  mode: string;                // "brush" | "erase"
  rot: number;                 // begin 时冻结的 viewport.rot（视口相对几何用；描边中转视口 = 手势接管即 abort）
  x0: number; y0: number;      // 起点（line/rect 的锚）
  x1: number; y1: number;      // 当前点
  pts: Pt[];                   // circle：freehand raw 点列（拟合输入）
  preSnap: LayerSnap | null;   // pixelMode：每帧 restore 的基准
  lastPaint: Rect4 | null;     // pixelMode：上一帧画过的区（restore 后也要重渲）
  dirty: Rect4 | null;         // flushDirty 累计（input 每 move 取走喂 board.markDocDirty）
}

export class ShapeBrushEngine {
  _inner = new BrushEngine();
  _subTool: ShapeSubTool = "line";
  _constrain = false;
  _rotProvider: (() => number) | null = null;
  _st: ShapeStroke | null = null;

  setSubTool(s: ShapeSubTool) { this._subTool = s; }
  getSubTool(): ShapeSubTool { return this._subTool; }
  setConstrain(b: boolean) { this._constrain = !!b; }
  getConstrain(): boolean { return this._constrain; }
  // 视口 rot 注入（app 接线 board.viewport；引擎不认识 Board）
  setViewportRotProvider(fn: (() => number) | null) { this._rotProvider = fn; }

  // 签名与 BrushEngine.beginStroke 一致 → input._beginStroke 按 engineKey 通用调用。
  //   pressure/smooth/t 有意忽略（恒压 + 直通 + 合成时间戳）。
  beginStroke(layer: Layer, settings: ResolvedBrush, x: number, y: number, _pressure: number,
              mode: string = "brush", _smooth: object = {}, _t: number | null = null) {
    const s = { ...settings, taperIn: 0, taperOut: 0 } as ResolvedBrush;
    Object.freeze(s);
    this._st = {
      layer, settings: s, mode,
      rot: this._rotProvider?.() ?? 0,
      x0: x, y0: y, x1: x, y1: y,
      pts: [{ x, y }],
      preSnap: s.pixelMode ? layer.snapshot() : null,
      lastPaint: null,
      dirty: null,
    };
    this._resynth();
  }

  extendStroke(x: number, y: number, _pressure: number, _t: number | null = null) {
    const st = this._st;
    if (!st) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;   // NaN 护栏（同 BrushEngine）
    st.x1 = x; st.y1 = y;
    if (this._subTool === "circle") st.pts.push({ x, y });
    this._resynth();
  }

  // 抬手：buffered → 终版 StampCollect（input 走 board.commitBrushStroke，与主笔刷同路径）；
  //   pixelMode → 像素已 in-place 落层，清态返 null。
  endStroke(): ReturnType<BrushEngine["collectStamps"]> {
    const st = this._st;
    if (!st) return null;
    let out: ReturnType<BrushEngine["collectStamps"]> = null;
    if (!st.settings.pixelMode) out = this._inner.endStroke();
    else this._inner.cancelStroke();
    disposeLayerSnap(st.preSnap);
    this._st = null;
    return out;
  }

  // cancel = 无痕：pixelMode 把画上的擦回去（caller 的 tx.abort 也会还原，双保险不依赖调用序）。
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

  // GPU stamp overlay 拉取口（live 预览）。pixelMode 走 live-sync（in-place），无 stamps。
  collectStamps(): ReturnType<BrushEngine["collectStamps"]> {
    if (!this._st || this._st.settings.pixelMode) return null;
    return this._inner.collectStamps();
  }

  flushDirty(): Rect4 | null {
    const st = this._st;
    if (!st || !st.dirty) return null;
    const d = st.dirty;
    st.dirty = null;
    return d;
  }

  // 当前几何 → 采样点列。circle 拟合不足（起手几个点）→ 只出起点一颗（预览从小处长出来）。
  _polyline(): Pt[] {
    const st = this._st!;
    const seg = maxSegLenFor(st.settings.size, st.settings.spacing);
    if (this._subTool === "line") {
      const end = this._constrain ? snapLineEnd(st.x0, st.y0, st.x1, st.y1) : { x: st.x1, y: st.y1 };
      return linePolyline({ x: st.x0, y: st.y0 }, end, seg);
    }
    if (this._subTool === "rect") {
      return rectPolyline(rectCorners({ x: st.x0, y: st.y0 }, { x: st.x1, y: st.y1 }, st.rot, this._constrain), seg);
    }
    const fit = fitEllipse(st.pts, st.rot, this._constrain);
    return fit ? ellipseArcPolyline(fit, seg) : [{ x: st.x0, y: st.y0 }];
  }

  // 整条重合成：pixelMode 先 restore 擦上一帧，再从头驱动私有 BrushEngine。
  //   buffered 只重建 stamps（无像素落地）；O(点数+stamps)/move，与手绘同量级。
  _resynth() {
    const st = this._st!;
    if (st.preSnap) st.layer.restoreFromSnapshot(st.preSnap);
    this._inner.cancelStroke();
    const pts = this._polyline();
    this._inner.beginStroke(st.layer, st.settings, pts[0].x, pts[0].y, SHAPE_PRESSURE, st.mode, { tau: 0, deadzone: 0 }, null);
    for (let i = 1; i < pts.length; i++) {
      this._inner.extendStroke(pts[i].x, pts[i].y, SHAPE_PRESSURE, null);
    }
    if (st.preSnap) {
      // in-place：上一帧画过的区（已被 restore 擦掉）+ 本帧画的区 都要重渲
      const painted = this._inner.flushDirty();
      if (st.lastPaint) this._mergeDirty(st, st.lastPaint);
      if (painted) this._mergeDirty(st, painted);
      st.lastPaint = painted;
    }
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
