// 浮层变换（Float / FloatingTransform）深模块。见 CONTEXT「浮层变换」。
//
// 选区像素被「抬起 → 自由变换（move/scale/rotate/perspective）→ 落回」的瞬态。
// 2026-06-19 从 lasso.js 抽出：lasso.js 只产 Selection + 经 LassoEngine facade 驱动本模块；
// input.js / board.js / app.js 不直接 import 本模块，全走 LassoEngine（接缝不变）。
//
// v0.4.7（S6）：float 状态（像素 tiles + transform metadata）**移入 workpiece internals**
// （workpiece/float-ops.ts 的 3 个 operator）。本类降级为：
//   - gizmo/单应性数学（MODES adapter + quadWarp/sourceWarpMatrix，原样保留）；
//   - live 网格视图 _live（拖动中的热路径：每 move 只动本地网格，抬手才把 metadata 整点入栈——
//     同 stroke 的事务型节奏；undo/redo 后经 syncFromWorkpiece 重新采纳）；
//   - lift/stamp/accept/reject 的 operator 编排（lift=LiftFloatOp 整点；stamp/accept/reject =
//     pre-applied ops.pixels × N + DropFloatOp 收摊，compound 封一个整点）。
// reject（cancel）≠ undo：identity 写回 operator——float 像素在原位 source-over 落到当前内容上
// （stamp 保留、无重采样，spec:220-225），可再撤销。
//
// 变形模式 = adapter（MODES）：free / uniform / distort 各定 meshN、是否露 rotate handle、
//   corner/edge 约束数学、切入本模式时的 mesh 投影。warp 已删（旧 4×4 是错数学）。
//
// 渲染：2×2 mesh → GPU warp（gl-compositor，per-pixel inverse homography；本文件只出 warp 矩阵，
//   栅格在 GPU）。浮层源纹理 = workpiece float tiles 的懒物化 canvas（WeakMap 缓存，S7 bridge 前过渡）。

import { makeBitmap } from "./bitmap.ts";
import { findNodeById } from "./doc.ts";
import type { Layer, LayerGroup } from "./doc.ts";
import type { FloatFrame, Workpiece, FloatTransformMeta, WorkpieceFloat, FloatState } from "./workpiece/workpiece.ts";
import type { UndoHistory } from "./workpiece/undo-history.ts";
import type { OperatorRegistry } from "./workpiece/operators.ts";
import { cloneFloatMeta, composeIdentityWriteback, applyRegionBuf } from "./workpiece/float-ops.ts";

// ---- 局部几何/数据类型（type-strip 后纯运行时无变化）----
type Node = Layer | LayerGroup;
type Bitmap = OffscreenCanvas | HTMLCanvasElement;
interface Point { x: number; y: number; }
type Mesh = Point[][];                          // 2×2：[[TL,TR],[BL,BR]]
interface Rect { x: number; y: number; w: number; h: number; }
type SampleMode = "nearest" | "bilinear" | "bicubic";

// commit 烤定的 GPU warp fn（board.glWarpBakeFn 注入）：warp 源 → straight RGBA canvas + doc 坐标位置。
//   mode：0=nearest 1=bilinear 2=bicubic（对齐 WARP shader）。GL 失败=null（commit 不烤）。
export type WarpBakeFn = (srcCanvas: CanvasImageSource, srcW: number, srcH: number, hinv: number[], mode: number, bx: number, by: number, bw: number, bh: number) => { canvas: HTMLCanvasElement; dstX: number; dstY: number } | null;

type TransformModeKind = "free" | "uniform" | "distort";

// 渲染消费面（board._glFloatInputs / app lassoProvider）：workpiece float + 懒物化 canvas 的只读视图。
export interface FloatViewSource { layerId: number; canvas: Bitmap; rect: Rect }
export interface FloatView {
  sources: FloatViewSource[];
  gizmoFrame: FloatFrame;
  mesh: Mesh;
  meshN: number;
  mode: TransformModeKind | null;
}

interface Hit {
  kind: "translate" | "corner" | "edge" | "rotate" | "basisRotate";
  row?: number;
  col?: number;
  edge?: string;
  pos?: Point;
  anchor?: Point;
}

interface Drag extends Hit {
  startX: number;
  startY: number;
  meshSnap: Mesh;
  frameSnap: FloatFrame;
}

interface LiftOpts { fallbackFullLayer?: boolean; cut?: boolean; ignoreSelection?: boolean; }

interface Homography {
  a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number;
}

interface TransformMode {
  kind: TransformModeKind;
  meshN: number;
  showsRotate: boolean;
  corner: (mesh: Mesh, snap: Mesh, drag: Drag, r: number, c: number, x: number, y: number, asp: number) => void;
  edge: (mesh: Mesh, snap: Mesh, drag: Drag, e: string, x: number, y: number, asp: number) => void;
  projectOnEnter: (mesh: Mesh, fromKind: TransformModeKind | null, asp: number) => Mesh | null;
}

// live 网格（拖动热路径的本地副本；SSoT = workpiece.readFloatState().transform）。
interface LiveMeta {
  gizmoFrame: FloatFrame;
  mesh: Mesh;
  meshN: number;
  mode: TransformModeKind | null;
  uniformAspect: number;
}

// float tiles → GPU 源纹理的懒物化缓存（float 像素不可变 → 按对象身份缓存即自失效；S7 bridge 化后死）。
const _floatCanvasCache = new WeakMap<WorkpieceFloat, Bitmap>();
function floatSourceCanvas(f: WorkpieceFloat): Bitmap {
  let c = _floatCanvasCache.get(f);
  if (!c) {
    c = makeBitmap(f.rect.w, f.rect.h);
    const ctx = c.getContext("2d") as CanvasRenderingContext2D;
    ctx.putImageData(new ImageData(f.pixels.getRegion(f.rect.x, f.rect.y, f.rect.w, f.rect.h), f.rect.w, f.rect.h), 0, 0);
    _floatCanvasCache.set(f, c);
  }
  return c;
}
// FloatView.sources 按 FloatState 身份缓存（每帧 provider 调 current()，别每帧重建数组）。
const _floatViewCache = new WeakMap<FloatState, FloatViewSource[]>();

export class FloatingTransform {
  _live: LiveMeta | null;
  _drag: Drag | null;
  _sampleMode: SampleMode;
  onChange: () => void;
  private _w: Workpiece | null = null;
  private _history: UndoHistory | null = null;
  private _ops: OperatorRegistry | null = null;

  // onChange 晚绑定（LassoEngine 构造时传 () => this.onChange()，因为 input.js 之后才赋 onChange）。
  constructor(onChange: () => void = () => {}) {
    this._live = null;
    this._drag = null;
    this._sampleMode = "bicubic";   // nearest | bilinear | bicubic（transform 重采样质量；v125 默认双三次）
    this.onChange = onChange;
  }

  // workpiece/undo 接线（input.ts 构造后注入；lift/stamp/commit/cancel 全走 operator）。
  attach(w: Workpiece, history: UndoHistory, ops: OperatorRegistry) {
    this._w = w;
    this._history = history;
    this._ops = ops;
  }

  setSampleMode(m: string) {
    if (m === "nearest" || m === "bilinear" || m === "bicubic") {
      this._sampleMode = m;
      if (this._live) this.onChange();   // GPU 每帧按 mode 重 warp，无 CPU 缓存可清
    }
  }
  getSampleMode() { return this._sampleMode; }

  isActive() { return !!this._w?.readFloatState(); }

  // 只读视图（app lassoProvider → board：GPU warp 输入 + gizmo overlay）。
  // _live 落后于 workpiece（undo/redo 刚动完、reconciler 未跑）时就地补同步——渲染永远吃一致态。
  current(): FloatView | null {
    const fs = this._w?.readFloatState();
    if (!fs) return null;
    if (!this._live) this.syncFromWorkpiece();
    const lv = this._live;
    if (!lv) return null;
    let sources = _floatViewCache.get(fs);
    if (!sources) {
      sources = fs.floats.map((f) => ({ layerId: f.sourceLayerId, canvas: floatSourceCanvas(f), rect: f.rect }));
      _floatViewCache.set(fs, sources);
    }
    return { sources, gizmoFrame: lv.gizmoFrame, mesh: lv.mesh, meshN: lv.meshN, mode: lv.mode };
  }

  // undo/redo/lift 后：live 网格重新采纳 workpiece 的 transform metadata。拖动中不采纳（防御）。
  syncFromWorkpiece() {
    if (this._drag) return;
    const fs = this._w?.readFloatState();
    if (!fs) { this._live = null; return; }
    const t = cloneFloatMeta(fs.transform);
    this._live = { gizmoFrame: t.gizmoFrame, mesh: t.mesh as Mesh, meshN: t.meshN, mode: t.mode, uniformAspect: t.uniformAspect };
  }

  // 把 active 节点 lift 成浮层（LiftFloatOp 整点：清选区 + 建 float tiles + 挖洞，全可撤销）。
  // leaf → 单 float；group → 组内所有叶(含隐藏)各一 float，共享一个 gizmo（隐藏随组动、不定框）。
  // 选区为 null 且 opts.fallbackFullLayer → 隐式整层全选。opts.cut: true(默认)=挖空源层（Ctrl+T）；
  // false=不挖洞（Ctrl+D 复制为浮层）。返回 bool（false = 没东西可变换，栈未动）。
  lift(node: Node | null, opts: LiftOpts = {}) {
    if (!node || !this._w || !this._history || !this._ops) return false;
    if (this._w.readFloatState()) return false;
    const st = this._history.run(this._w, this._ops.liftFloat, {
      nodeId: node.id,
      cut: opts.cut !== false,
      fallbackFullLayer: !!opts.fallbackFullLayer,
      ignoreSelection: !!opts.ignoreSelection,
    });
    if (!st.ok) return false;
    this.syncFromWorkpiece();
    this.onChange();
    return true;
  }

  // -------- 模式切换 --------
  // mode = null（"selected"：只显轮廓、拖内 = 平移）或 "free" | "uniform" | "distort"。
  // 投影改网格 → metadata 整点入栈（FloatTransformOp）。
  setMode(mode: TransformModeKind | null) {
    const lv = this._live;
    if (!lv) return;
    if (mode === lv.mode) return;
    const mdef = MODES[mode as TransformModeKind];
    if (mdef && mdef.projectOnEnter) {
      const projected = mdef.projectOnEnter(lv.mesh, lv.mode, lv.uniformAspect);
      if (projected) lv.mesh = projected;
    }
    lv.mode = mode;
    this._pushTransformCheckpoint();
    this.onChange();
  }
  getMode() { return this._live?.mode || null; }

  // -------- 拖动 --------
  // 拖动中只动 _live（热路径零 operator）；endDrag 把最终 metadata 一个整点入栈。
  // v125 (user：「transform 拖外面也能移动，gizmo 安全区大一点」)：handle 半径 18 doc-px；quad 外按下默认 translate。
  hitTest(x: number, y: number, screenScale = 1): Hit | null {
    const f = this._live;
    if (!f) return null;
    if (f.mode === null) {
      return this._pointInQuad(x, y) ? { kind: "translate" } : null;
    }
    const r = 18 / screenScale;
    const handles = this._visibleHandles(screenScale);
    for (const h of handles) {
      const dx = x - h.pos!.x, dy = y - h.pos!.y;
      if (dx * dx + dy * dy < r * r) return h;
    }
    return { kind: "translate" };
  }

  beginDrag(hit: Hit | null, x: number, y: number) {
    const f = this._live;
    if (!f || !hit) return;
    this._drag = {
      ...hit,
      startX: x, startY: y,
      meshSnap: f.mesh.map((row) => row.map((p) => ({ x: p.x, y: p.y }))),
      frameSnap: { origin: { ...f.gizmoFrame.origin }, ux: { ...f.gizmoFrame.ux }, uy: { ...f.gizmoFrame.uy } },
    };
  }
  extendDrag(x: number, y: number) {
    const f = this._live;
    const d = this._drag;
    if (!f || !d) return;
    const dx = x - d.startX;
    const dy = y - d.startY;
    if (d.kind === "translate") {
      applyTranslate(f.mesh, d.meshSnap, dx, dy);
    } else if (d.kind === "corner") {
      const md = MODES[f.mode as TransformModeKind];
      if (md) md.corner(f.mesh, d.meshSnap, d, d.row!, d.col!, x, y, f.uniformAspect);
    } else if (d.kind === "edge") {
      const md = MODES[f.mode as TransformModeKind];
      if (md) md.edge(f.mesh, d.meshSnap, d, d.edge!, x, y, f.uniformAspect);
    } else if (d.kind === "rotate") {
      applyRotate(f.mesh, d.meshSnap, d, x, y);
    } else if (d.kind === "basisRotate") {
      applyBasisRotate(f, d, x, y);
    }
    this.onChange();                  // mesh 变 → board 每帧用新 mesh 重算 Hinv 重 warp（GPU，无 CPU 缓存）
  }
  endDrag() {
    const d = this._drag;
    this._drag = null;
    const f = this._live;
    if (!d || !f) return;
    // 网格真动了才入栈（点一下就松 ≠ 空整点）
    const moved = f.mesh.some((row, i) => row.some((p, j) => p.x !== d.meshSnap[i][j].x || p.y !== d.meshSnap[i][j].y));
    if (moved) this._pushTransformCheckpoint();
  }

  // #12（v0.5）：浮层整体水平翻转 / 逆时针转 90°。绕当前 mesh 四外角的质心变换，
  //   一次一个 undo 整点（同 endDrag 的事务节奏）。画布级 flip/rotate 在 doc-ops，那是整文档，别混。
  private _transformLivePoints(fn: (p: Point, cx: number, cy: number) => Point) {
    const lv = this._live;
    if (!lv || !this.isActive()) return;
    const n = lv.meshN - 1;
    const corners = [lv.mesh[0][0], lv.mesh[0][n], lv.mesh[n][0], lv.mesh[n][n]];
    const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
    const cy = corners.reduce((s, p) => s + p.y, 0) / 4;
    lv.mesh = lv.mesh.map((row) => row.map((p) => fn(p, cx, cy)));
    this._pushTransformCheckpoint();
    this.onChange();
  }
  flipHorizontal() { this._transformLivePoints((p, cx, _cy) => ({ x: 2 * cx - p.x, y: p.y })); }
  rotate90CCW()    { this._transformLivePoints((p, cx, cy) => ({ x: cx + (p.y - cy), y: cy - (p.x - cx) })); }

  private _pushTransformCheckpoint() {
    if (!this._w || !this._history || !this._ops || !this._live) return;
    const lv = this._live;
    this._history.run(this._w, this._ops.floatTransform, {
      after: cloneFloatMeta({
        gizmoFrame: lv.gizmoFrame, mesh: lv.mesh, meshN: lv.meshN, mode: lv.mode, uniformAspect: lv.uniformAspect,
      } as FloatTransformMeta),
    });
  }

  // 把一个 float 的像素落回源 layer（stamp/accept 共用）。GPU 烤定：sourceWarpMatrix 算 Hinv+bbox →
  //   bakeFn（board.glWarpBakeFn = GPU warp readback）→ straight canvas → editRegion 落层。与 live warp 同采样器，
  //   零 preview/commit 漂移。bakeFn 缺省（GL 失败）→ 不烤（app 已显「需 WebGL2」）。
  private _bakeDown(f: WorkpieceFloat, leaf: Layer, bakeFn: WarpBakeFn | null) {
    if (!bakeFn || !this._live) return;
    const lv = this._live;
    const wp = sourceWarpMatrix(f, lv.gizmoFrame, lv.mesh);
    if (!wp || wp.bw <= 0 || wp.bh <= 0) return;
    const mode = this._sampleMode === "nearest" ? 0 : this._sampleMode === "bicubic" ? 2 : 1;
    const rendered = bakeFn(floatSourceCanvas(f) as CanvasImageSource, f.rect.w, f.rect.h, wp.hinv, mode, wp.bx, wp.by, wp.bw, wp.bh);
    if (!rendered) return;
    const rx0 = Math.floor(rendered.dstX), ry0 = Math.floor(rendered.dstY);
    const rx1 = Math.ceil(rendered.dstX + rendered.canvas.width), ry1 = Math.ceil(rendered.dstY + rendered.canvas.height);
    leaf.editRegion(rx0, ry0, rx1 - rx0, ry1 - ry0, (ctx, ox, oy) => {
      ctx.drawImage(rendered.canvas, rendered.dstX - ox, rendered.dstY - oy);
    });
  }

  // 源层 id → 活叶（消失容忍：跳过该 float，别的照常）。
  private _leafFor(f: WorkpieceFloat): Layer | null {
    const doc = this._w!.readDoc();
    const n = findNodeById(doc.layers, f.sourceLayerId);
    return n && !n.isGroup ? (n as Layer) : null;
  }

  // Stamp：各 float 按当前 mesh 烤进源层，KEEP float。一个 compound 整点（pre-applied ops.pixels）。
  stamp(bakeFn?: WarpBakeFn | null) {
    const fs = this._w?.readFloatState();
    if (!fs || !this._history || !this._ops || !bakeFn) return false;
    const r = this._history.compound(this._w!, () => {
      for (const f of fs.floats) {
        const leaf = this._leafFor(f);
        if (!leaf) continue;
        const before = leaf.snapshot();          // 归属转给 ops.pixels
        this._bakeDown(f, leaf, bakeFn);
        const st = this._history!.run(this._w!, this._ops!.pixels, { layerId: leaf.id, _initialBefore: before }, { checkpoint: false });
        if (!st.ok) throw new Error(st.msg);
      }
    });
    this.onChange();
    return r.ok;
  }

  // -------- accept / reject --------
  // accept（commit）：各 float 烤进源层 + DropFloatOp 收摊，一个 compound 整点。
  //   选区在 lift 时已清（spec:213）——accept 不再碰 selection（现状「清」保持，UX 待人类拍板）。
  commit(bakeFn?: WarpBakeFn | null): boolean {
    const fs = this._w?.readFloatState();
    if (!fs || !this._history || !this._ops) return false;
    const r = this._history.compound(this._w!, () => {
      for (const f of fs.floats) {
        const leaf = this._leafFor(f);
        if (!leaf) continue;
        const before = leaf.snapshot();
        this._bakeDown(f, leaf, bakeFn ?? null);
        const st = this._history!.run(this._w!, this._ops!.pixels, { layerId: leaf.id, _initialBefore: before }, { checkpoint: false });
        if (!st.ok) throw new Error(st.msg);
      }
      const st2 = this._history!.run(this._w!, this._ops!.dropFloat, { reason: "accept" }, { checkpoint: false });
      if (!st2.ok) throw new Error(st2.msg);
    });
    this._drag = null;
    this.syncFromWorkpiece();
    this.onChange();
    return r.ok;
  }
  // reject（cancel）：**不是 undo**（spec:220-225）——identity 写回 operator：float 像素在原 rect
  //   source-over 落到当前内容上（stamp 保留、float 在其上），不走 warp 采样器（无重采样）。
  //   本身是一个可撤销整点（Ctrl+Z 可把 reject 撤回来）。选区保持 lift 后的空态。
  cancel(): boolean {
    const fs = this._w?.readFloatState();
    if (!fs || !this._history || !this._ops) return false;
    const r = this._history.compound(this._w!, () => {
      for (const f of fs.floats) {
        const leaf = this._leafFor(f);
        if (!leaf) continue;
        const before = leaf.snapshot();
        applyRegionBuf(leaf, composeIdentityWriteback(leaf, f));
        const st = this._history!.run(this._w!, this._ops!.pixels, { layerId: leaf.id, _initialBefore: before }, { checkpoint: false });
        if (!st.ok) throw new Error(st.msg);
      }
      const st2 = this._history!.run(this._w!, this._ops!.dropFloat, { reason: "reject" }, { checkpoint: false });
      if (!st2.ok) throw new Error(st2.msg);
    });
    this._drag = null;
    this.syncFromWorkpiece();
    this.onChange();
    return r.ok;
  }

  // -------- 外部查询 --------
  // （renderForLayer 已删：浮层 display 走 GPU warp [board._glFloatInputs→_floatPass]，不再有 CPU per-layer render。）

  getFloatingScreenBbox() {
    const f = this._live;
    if (!f) return null;
    const [minX, minY, maxX, maxY] = meshBbox(f.mesh);
    return [minX, minY, maxX, maxY];
  }
  // 给 board overlay 用：当前可拖的 handle 列表（位置 + 类型）。screenScale 让 rotate handle 按屏幕 px 偏移定位。
  visibleHandles(screenScale = 1) { return this._visibleHandles(screenScale); }

  // ---------- 内部 ----------
  _visibleHandles(screenScale = 1): Hit[] {
    const f = this._live;
    if (!f) return [];
    if (f.mode === null) return [];     // selected 状态：不暴露 handles
    const out: Hit[] = [];
    const m = f.mesh;
    out.push({ kind: "corner", row: 0, col: 0, pos: m[0][0] });
    out.push({ kind: "corner", row: 0, col: 1, pos: m[0][1] });
    out.push({ kind: "corner", row: 1, col: 0, pos: m[1][0] });
    out.push({ kind: "corner", row: 1, col: 1, pos: m[1][1] });
    // 4 边中点：free/uniform = 1D 缩放（对边锚定）；distort = 平移该边两端点。
    out.push({ kind: "edge", edge: "top",    pos: mid(m[0][0], m[0][1]) });
    out.push({ kind: "edge", edge: "right",  pos: mid(m[0][1], m[1][1]) });
    out.push({ kind: "edge", edge: "bottom", pos: mid(m[1][0], m[1][1]) });
    out.push({ kind: "edge", edge: "left",   pos: mid(m[0][0], m[1][0]) });
    // v117: rotate handle（圆=转像素）；v0.6.21 全模式露（distort 也要——Procreate 双手柄语义）。
    if (MODES[f.mode] && MODES[f.mode].showsRotate) {
      const topMid = mid(m[0][0], m[0][1]);
      const ayU = norm(sub(m[1][0], m[0][0]));   // 单位向量：TL → BL（向下）
      const offset = 28 / Math.max(0.01, screenScale);
      out.push({
        kind: "rotate",
        pos: { x: topMid.x - ayU.x * offset, y: topMid.y - ayU.y * offset },
        anchor: topMid,
      });
    }
    // v0.6.21 方手柄（basisRotate）：只 distort + mesh 仍仿射时露——转参考 frame 的轴不动像素；
    //   一旦拖过透视角（g,h≠0 ⇔ 非平行四边形）判据自动收回；圆手柄旋转保持仿射 → 永不误收。
    if (f.mode === "distort" && isAffineQuad(f.mesh)) {
      const botMid = mid(m[1][0], m[1][1]);
      const ayU = norm(sub(m[1][0], m[0][0]));
      const offset = 28 / Math.max(0.01, screenScale);
      out.push({
        kind: "basisRotate",
        pos: { x: botMid.x + ayU.x * offset, y: botMid.y + ayU.y * offset },
        anchor: botMid,
      });
    }
    return out;
  }

  _pointInQuad(x: number, y: number) {
    const f = this._live;
    if (!f) return false;
    const N = f.meshN;
    const m = f.mesh;
    const poly = [m[0][0], m[0][N - 1], m[N - 1][N - 1], m[N - 1][0]];
    return pointInPoly(poly, x, y);
  }
}

// ============ TransformMode adapters ============
// 每个 mode 一个 adapter：meshN / 是否露 rotate handle / corner·edge 约束 / 切入投影。
// free/uniform 共用 solveAffineCorner·solveAffineEdge（uniform=true 多一步锁比）；distort 自走简单分支。
const MODES: Record<TransformModeKind, TransformMode> = {
  free: {
    kind: "free", meshN: 2, showsRotate: true,
    corner: (mesh, snap, drag, r, c, x, y, _asp) => solveAffineCorner(mesh, snap, drag, r, c, x, y, false),
    edge:   (mesh, snap, drag, e, x, y, asp) => solveAffineEdge(mesh, snap, drag, e, x, y, false, asp),
    projectOnEnter: (mesh, fromKind, _asp) => fromKind === "distort" ? projectToRectangle(mesh) : null,
  },
  uniform: {
    kind: "uniform", meshN: 2, showsRotate: true,
    corner: (mesh, snap, drag, r, c, x, y, _asp) => solveAffineCorner(mesh, snap, drag, r, c, x, y, true),
    edge:   (mesh, snap, drag, e, x, y, asp) => solveAffineEdge(mesh, snap, drag, e, x, y, true, asp),
    projectOnEnter: (mesh, fromKind, asp) =>
      (fromKind === "distort" || fromKind === "free") ? projectToUniformRect(mesh, asp) : null,
  },
  distort: {
    kind: "distort", meshN: 2, showsRotate: true,   // v0.6.21：透视前圆（转像素）方（转轴）双手柄
    corner: (mesh, snap, drag, r, c, x, y, _asp) => applyDistortCorner(mesh, snap, drag, r, c, x, y),
    edge:   (mesh, snap, drag, e, x, y, _asp) => applyDistortEdge(mesh, snap, drag, e, x, y),
    projectOnEnter: () => null,
  },
};
// （TRANSFORM_MODE_KINDS 已删 v415：零调用者。模式在 TransformMode 类型里，运行时不需要这份字符串表。）

// ---- 约束数学（mode-independent）----
function applyTranslate(mesh: Mesh, meshSnap: Mesh, dx: number, dy: number) {
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    mesh[i][j].x = meshSnap[i][j].x + dx;
    mesh[i][j].y = meshSnap[i][j].y + dy;
  }
}

// v117: rotate —— 绕 centroid（4 角平均）转 dθ = atan2(finger−c) − atan2(start−c)。
function applyRotate(mesh: Mesh, meshSnap: Mesh, drag: Drag, x: number, y: number) {
  const m = meshSnap;
  const cx = (m[0][0].x + m[0][1].x + m[1][0].x + m[1][1].x) / 4;
  const cy = (m[0][0].y + m[0][1].y + m[1][0].y + m[1][1].y) / 4;
  const a0 = Math.atan2(drag.startY - cy, drag.startX - cx);
  const a1 = Math.atan2(y - cy, x - cx);
  const dθ = a1 - a0;
  const cos = Math.cos(dθ), sin = Math.sin(dθ);
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const px = m[i][j].x - cx;
    const py = m[i][j].y - cy;
    mesh[i][j] = { x: cx + px * cos - py * sin, y: cy + px * sin + py * cos };
  }
}

// v0.6.21 方手柄：**转参考 frame 的轴、不动像素**（Procreate 语义，user 拍板 2026-07-28）。
//   mesh 绕质心转 dθ（同圆手柄）+ frame 复合 H⁻¹∘R∘H（H=旧 mesh 的仿射映射）→ 每个 source 的
//   destQuad 恒等（display = H′∘F′⁻¹ = R∘H∘(F∘H⁻¹∘R∘H)⁻¹ = H∘F⁻¹）。仅仿射 mesh 可用。
function applyBasisRotate(f: LiveMeta, d: Drag, x: number, y: number) {
  const m = d.meshSnap;
  if (!isAffineQuad(m)) return;
  const cx = (m[0][0].x + m[0][1].x + m[1][0].x + m[1][1].x) / 4;
  const cy = (m[0][0].y + m[0][1].y + m[1][0].y + m[1][1].y) / 4;
  const a0 = Math.atan2(d.startY - cy, d.startX - cx);
  const a1 = Math.atan2(y - cy, x - cx);
  const cos = Math.cos(a1 - a0), sin = Math.sin(a1 - a0);
  const rot = (p: Point): Point => {
    const px = p.x - cx, py = p.y - cy;
    return { x: cx + px * cos - py * sin, y: cy + px * sin + py * cos };
  };
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) f.mesh[i][j] = rot(m[i][j]);
  // A = H⁻¹∘R∘H 作用在单位方（H 仿射：tl + u·e1 + v·e2；back-solve 用 e1/e2 基）
  const tl = m[0][0];
  const e1 = { x: m[0][1].x - tl.x, y: m[0][1].y - tl.y };
  const e2 = { x: m[1][0].x - tl.x, y: m[1][0].y - tl.y };
  const det = e1.x * e2.y - e1.y * e2.x;
  if (Math.abs(det) < 1e-9) return;
  const A = (u: number, v: number): Point => {
    const pr = rot({ x: tl.x + u * e1.x + v * e2.x, y: tl.y + u * e1.y + v * e2.y });
    const rx = pr.x - tl.x, ry = pr.y - tl.y;
    return { x: (rx * e2.y - ry * e2.x) / det, y: (ry * e1.x - rx * e1.y) / det };
  };
  const fs = d.frameSnap;
  const F = (q: Point): Point => ({
    x: fs.origin.x + q.x * fs.ux.x + q.y * fs.uy.x,
    y: fs.origin.y + q.x * fs.ux.y + q.y * fs.uy.y,
  });
  const o = F(A(0, 0)), pu = F(A(1, 0)), pv = F(A(0, 1));
  f.gizmoFrame = { origin: o, ux: { x: pu.x - o.x, y: pu.y - o.y }, uy: { x: pv.x - o.x, y: pv.y - o.y } };
}

// mesh 是否仿射（平行四边形；⇔ Heckbert g=h=0）：br−tr−bl+tl 残差 < 0.01px。
export function isAffineQuad(mesh: Mesh): boolean {
  const m = mesh;
  return Math.abs(m[1][1].x - m[0][1].x - m[1][0].x + m[0][0].x) < 0.01 &&
         Math.abs(m[1][1].y - m[0][1].y - m[1][0].y + m[0][0].y) < 0.01;
}

// ---- distort：4 角 / 边端点自由 ----
function applyDistortCorner(mesh: Mesh, meshSnap: Mesh, drag: Drag, row: number, col: number, x: number, y: number) {
  mesh[row][col].x = meshSnap[row][col].x + (x - drag.startX);
  mesh[row][col].y = meshSnap[row][col].y + (y - drag.startY);
}
function applyDistortEdge(mesh: Mesh, meshSnap: Mesh, drag: Drag, edge: string, x: number, y: number) {
  const dx = x - drag.startX, dy = y - drag.startY;
  const idx = ({
    top:    [[0, 0], [0, 1]],
    bottom: [[1, 0], [1, 1]],
    left:   [[0, 0], [1, 0]],
    right:  [[0, 1], [1, 1]],
  } as Record<string, number[][]>)[edge];
  for (const [r, c] of idx) {
    mesh[r][c] = { x: meshSnap[r][c].x + dx, y: meshSnap[r][c].y + dy };
  }
}

// ---- free / uniform：平行四边形约束 ----
// 角点拖：对角锚定 + ax/ay 各自缩放（保原方向）。uniform=true → 沿对角线等比锁比。
function solveAffineCorner(mesh: Mesh, meshSnap: Mesh, drag: Drag, row: number, col: number, x: number, y: number, uniform: boolean) {
  let targetX = meshSnap[row][col].x + (x - drag.startX);
  let targetY = meshSnap[row][col].y + (y - drag.startY);
  // 4 角约定：TL=[0][0], TR=[0][1], BL=[1][0], BR=[1][1]；对角表
  const opp: Record<string, number[]> = { "0,0": [1, 1], "0,1": [1, 0], "1,0": [0, 1], "1,1": [0, 0] };
  const [or, oc] = opp[`${row},${col}`];
  const anchor = meshSnap[or][oc];                 // 对角锚点（变换中不动）
  const origAx = sub(meshSnap[0][1], meshSnap[0][0]);
  const origAy = sub(meshSnap[1][0], meshSnap[0][0]);
  // dragCorner 在 (TL + sx·ax + sy·ay)，sx,sy ∈ {0,1}
  const sx = col, sy = row;
  const dragPt = { x: targetX, y: targetY };
  const dragVec = sub(dragPt, anchor);
  const axU = norm(origAx);
  const ayU = norm(origAy);
  // (drag − anchor) = αx·axU·lenAx + αy·ayU·lenAy，αx,αy ∈ {±1}；2×2 解 lenAx/lenAy
  const αx = 2 * sx - 1;
  const αy = 2 * sy - 1;
  const M11 = αx * axU.x, M12 = αy * ayU.x;
  const M21 = αx * axU.y, M22 = αy * ayU.y;
  const det = M11 * M22 - M12 * M21;
  if (Math.abs(det) < 1e-6) return;                // 退化（ax/ay 平行）；放弃这帧
  let lenAx = (dragVec.x * M22 - dragVec.y * M12) / det;
  let lenAy = (-dragVec.x * M21 + dragVec.y * M11) / det;
  if (uniform) {
    // 把 finger 沿"原对角方向"投影，等比例缩放两轴（v119：严格沿对角线，anchor 不歪）。
    const origCorner = meshSnap[row][col];
    const Dvec = sub(origCorner, anchor);
    const Dlen2 = Dvec.x * Dvec.x + Dvec.y * Dvec.y;
    if (Dlen2 > 1e-6) {
      const fingerFromAnchor = sub({ x: targetX, y: targetY }, anchor);
      const scale = (fingerFromAnchor.x * Dvec.x + fingerFromAnchor.y * Dvec.y) / Dlen2;
      const origLenAx = Math.hypot(origAx.x, origAx.y);
      const origLenAy = Math.hypot(origAy.x, origAy.y);
      lenAx = scale * origLenAx;
      lenAy = scale * origLenAy;
      targetX = anchor.x + scale * Dvec.x;
      targetY = anchor.y + scale * Dvec.y;
    }
  }
  const newAx = { x: axU.x * lenAx, y: axU.y * lenAx };
  const newAy = { x: ayU.x * lenAy, y: ayU.y * lenAy };
  const origin = { x: targetX - sx * newAx.x - sy * newAy.x, y: targetY - sx * newAx.y - sy * newAy.y };
  mesh[0][0] = origin;
  mesh[0][1] = { x: origin.x + newAx.x, y: origin.y + newAx.y };
  mesh[1][0] = { x: origin.x + newAy.x, y: origin.y + newAy.y };
  mesh[1][1] = { x: origin.x + newAx.x + newAy.x, y: origin.y + newAx.y + newAy.y };
}

// 边中点拖（free/uniform）：沿对应轴 1D 缩放，对边锚定。uniform → 两轴一起按锁比缩放、对边中点锚定。
function solveAffineEdge(mesh: Mesh, meshSnap: Mesh, drag: Drag, edge: string, x: number, y: number, uniform: boolean, uniformAspect: number) {
  const m = meshSnap;
  const origAx = sub(m[0][1], m[0][0]);
  const origAy = sub(m[1][0], m[0][0]);
  const axU = norm(origAx);
  const ayU = norm(origAy);
  const axis = edge === "top" ? "ay-shrink"
             : edge === "bottom" ? "ay-grow"
             : edge === "left" ? "ax-shrink"
             : "ax-grow";
  // drag delta = (drag end − drag start)，finger 起手不在边中点正中也正确响应。
  const dragDelta = { x: x - drag.startX, y: y - drag.startY };
  let lenAx = Math.hypot(origAx.x, origAx.y);
  let lenAy = Math.hypot(origAy.x, origAy.y);
  if (axis.startsWith("ax")) {
    const proj = dragDelta.x * axU.x + dragDelta.y * axU.y;
    lenAx = axis === "ax-grow" ? lenAx + proj : lenAx - proj;
  } else {
    const proj = dragDelta.x * ayU.x + dragDelta.y * ayU.y;
    lenAy = axis === "ay-grow" ? lenAy + proj : lenAy - proj;
  }
  if (uniform) {
    if (axis.startsWith("ax")) lenAy = lenAx / uniformAspect;
    else lenAx = lenAy * uniformAspect;
  }
  const blAnchor = m[1][0];
  const newAy = { x: ayU.x * lenAy, y: ayU.y * lenAy };
  const newAx = { x: axU.x * lenAx, y: axU.y * lenAx };
  let origin: Point;
  if (uniform) {
    // uniform 拖边：锚 = 对边中点（antipodal），反解 origin。
    const a = (axis === "ay-shrink") ? { p: mid(m[1][0], m[1][1]), ox: newAx.x / 2 + newAy.x, oy: newAx.y / 2 + newAy.y }   // top
            : (axis === "ay-grow")   ? { p: mid(m[0][0], m[0][1]), ox: newAx.x / 2,           oy: newAx.y / 2 }             // bottom
            : (axis === "ax-shrink") ? { p: mid(m[0][1], m[1][1]), ox: newAx.x + newAy.x / 2, oy: newAx.y + newAy.y / 2 }   // left
            :                          { p: mid(m[0][0], m[1][0]), ox: newAy.x / 2,           oy: newAy.y / 2 };            // right
    origin = { x: a.p.x - a.ox, y: a.p.y - a.oy };
    mesh[0][0] = origin;
    mesh[0][1] = { x: origin.x + newAx.x, y: origin.y + newAx.y };
    mesh[1][0] = { x: origin.x + newAy.x, y: origin.y + newAy.y };
    mesh[1][1] = { x: origin.x + newAx.x + newAy.x, y: origin.y + newAx.y + newAy.y };
    return;
  }
  // free 拖边：对边锚定（v117 修：drag top 锚 bottom、drag bottom 锚 top）。
  if (axis.startsWith("ay")) {
    if (axis === "ay-grow") origin = { x: m[0][0].x, y: m[0][0].y };          // 拖 bottom → 锚 top
    else origin = { x: blAnchor.x - newAy.x, y: blAnchor.y - newAy.y };       // 拖 top → 锚 bottom (BL)
  } else {
    if (axis === "ax-grow") origin = { x: m[0][0].x, y: m[0][0].y };          // 拖 right → 锚 left
    else origin = { x: m[0][1].x - newAx.x, y: m[0][1].y - newAx.y };         // 拖 left → 锚 right (TR)
  }
  mesh[0][0] = origin;
  mesh[0][1] = { x: origin.x + newAx.x, y: origin.y + newAx.y };
  mesh[1][0] = { x: origin.x + newAy.x, y: origin.y + newAy.y };
  mesh[1][1] = { x: origin.x + newAx.x + newAy.x, y: origin.y + newAx.y + newAy.y };
}

// ---- 切入 mode 时的 mesh 投影 ----
// v118：distort (任意 quad) → free (旋转矩形，shearless)。u=平均水平向量，v=u 转 90°（去 shear）。
function projectToRectangle(mesh: Mesh): Mesh {
  const tl = mesh[0][0], tr = mesh[0][1];
  const bl = mesh[1][0], br = mesh[1][1];
  const cx = (tl.x + tr.x + bl.x + br.x) / 4;
  const cy = (tl.y + tr.y + bl.y + br.y) / 4;
  const ux = ((tr.x - tl.x) + (br.x - bl.x)) / 2;
  const uy = ((tr.y - tl.y) + (br.y - bl.y)) / 2;
  const uLen = Math.hypot(ux, uy);
  const uDirX = uLen > 0.01 ? ux / uLen : 1;
  const uDirY = uLen > 0.01 ? uy / uLen : 0;
  const vDirX = -uDirY, vDirY = uDirX;             // v ⊥ u（顺时针 90°）
  const halfU = uLen / 2;
  const vx = ((bl.x - tl.x) + (br.x - tr.x)) / 2;
  const vy = ((bl.y - tl.y) + (br.y - tr.y)) / 2;
  const halfV = (vx * vDirX + vy * vDirY) / 2;      // 原 vertical 投影到 vDir（带符号保 ↑/↓）
  return [
    [{ x: cx - halfU * uDirX - halfV * vDirX, y: cy - halfU * uDirY - halfV * vDirY },
     { x: cx + halfU * uDirX - halfV * vDirX, y: cy + halfU * uDirY - halfV * vDirY }],
    [{ x: cx - halfU * uDirX + halfV * vDirX, y: cy - halfU * uDirY + halfV * vDirY },
     { x: cx + halfU * uDirX + halfV * vDirX, y: cy + halfU * uDirY + halfV * vDirY }],
  ];
}
// v111: parallelogram → rectangle 锁纵横比（uniform）。v 长度 = u 长度 / aspect（保 v 投影符号）。
function projectToUniformRect(mesh: Mesh, aspect: number): Mesh {
  const tl = mesh[0][0], tr = mesh[0][1];
  const bl = mesh[1][0], br = mesh[1][1];
  const cx = (tl.x + tr.x + bl.x + br.x) / 4;
  const cy = (tl.y + tr.y + bl.y + br.y) / 4;
  const ux = ((tr.x - tl.x) + (br.x - bl.x)) / 2;
  const uy = ((tr.y - tl.y) + (br.y - bl.y)) / 2;
  const uLen = Math.hypot(ux, uy);
  const uDirX = uLen > 0.01 ? ux / uLen : 1;
  const uDirY = uLen > 0.01 ? uy / uLen : 0;
  const vDirX = -uDirY, vDirY = uDirX;
  const vx = ((bl.x - tl.x) + (br.x - tr.x)) / 2;
  const vy = ((bl.y - tl.y) + (br.y - tr.y)) / 2;
  const vProj = vx * vDirX + vy * vDirY;
  const halfU = uLen / 2;
  const halfV = (uLen / Math.max(0.01, aspect)) / 2 * (vProj >= 0 ? 1 : -1);
  return [
    [{ x: cx - halfU * uDirX - halfV * vDirX, y: cy - halfU * uDirY - halfV * vDirY },
     { x: cx + halfU * uDirX - halfV * vDirX, y: cy + halfU * uDirY - halfV * vDirY }],
    [{ x: cx - halfU * uDirX + halfV * vDirX, y: cy - halfU * uDirY + halfV * vDirY },
     { x: cx + halfU * uDirX + halfV * vDirX, y: cy + halfU * uDirY + halfV * vDirY }],
  ];
}

// ============ 几何工具 ============
// （unionRects/bboxToQuad 已随 lift 下沉进 LiftFloatOp——初始 gizmo/mesh 归 operator 产。）
function sub(a: Point, b: Point): Point { return { x: a.x - b.x, y: a.y - b.y }; }
function mid(a: Point, b: Point): Point { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function norm(v: Point): Point {
  const len = Math.hypot(v.x, v.y);
  return len > 1e-6 ? { x: v.x / len, y: v.y / len } : { x: 1, y: 0 };
}
function pointInPoly(poly: Point[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function meshBbox(mesh: Mesh): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const row of mesh) for (const p of row) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return [minX, minY, maxX, maxY];
}

// ============ Source bake ============
// （bakeSource 已死 v0.4.7：lift 的像素提取/挖洞下沉进 workpiece/float-ops.ts 的 LiftFloatOp——
//   typed-array 路径，materializeMaskCanvas 过渡口在 lift 链上退场。）

// 一个 source rect 经共享 gizmo（gizmoFrame 参数化 → 当前 mesh quad 的 homography）映出的 dest quad。
//   frame 逆仿射把 doc 点变 (u,v)；轴对齐 frame 时 = 旧 (x−bbox)/w 归一（行为不变）；
//   单 source + 轴对齐时 rect 角 ↦ (0,0)..(1,1) → destQuad === mesh（单层行为不变的保证）。
export function sourceDestQuad(rect: Rect, frame: FloatFrame, mesh: Mesh): Mesh | null {
  const H = homographyFromUnitSquareToQuad(mesh[0][0], mesh[0][1], mesh[1][1], mesh[1][0]);
  if (!H) return null;
  const det = frame.ux.x * frame.uy.y - frame.ux.y * frame.uy.x;
  if (Math.abs(det) < 1e-9) return null;
  const map = (x: number, y: number) => {
    const rx = x - frame.origin.x, ry = y - frame.origin.y;
    return homographySample(H, (rx * frame.uy.y - ry * frame.uy.x) / det, (ry * frame.ux.x - rx * frame.ux.y) / det);
  };
  return [
    [map(rect.x, rect.y), map(rect.x + rect.w, rect.y)],
    [map(rect.x, rect.y + rect.h), map(rect.x + rect.w, rect.y + rect.h)],
  ];
}
// 单位方格 → quad 的前向求值（sourceDestQuad 把 source 角投到 dest 用）。
function homographySample(H: Homography, u: number, v: number): Point {
  const w = H.g * u + H.h * v + 1;
  return { x: (H.a * u + H.b * v + H.c) / w, y: (H.d * u + H.e * v + H.f) / w };
}

// ============ Per-pixel inverse-homography render (free / uniform / distort) ============
// 2×2 mesh → { 逆单应性 Hinv（doc→src 单位方格，9 数 row-major）, dst bbox }。
//   **GPU warp shader 与 golden 的 CPU 参照（harness）共用此函数** → 同一矩阵、零漂移（golden 才对得上）。
export function quadWarp(mesh: Mesh): { hinv: number[]; minX: number; minY: number; maxX: number; maxY: number } | null {
  const tl = mesh[0][0], tr = mesh[0][1], bl = mesh[1][0], br = mesh[1][1];
  const minX = Math.floor(Math.min(tl.x, tr.x, bl.x, br.x));
  const minY = Math.floor(Math.min(tl.y, tr.y, bl.y, br.y));
  const maxX = Math.ceil(Math.max(tl.x, tr.x, bl.x, br.x));
  const maxY = Math.ceil(Math.max(tl.y, tr.y, bl.y, br.y));
  if (maxX - minX <= 0 || maxY - minY <= 0) return null;
  const Hfwd = homographyFromUnitSquareToQuad(tl, tr, br, bl);
  if (!Hfwd) return null;
  const Hinv = invertMat3([Hfwd.a, Hfwd.b, Hfwd.c, Hfwd.d, Hfwd.e, Hfwd.f, Hfwd.g, Hfwd.h, 1]);
  if (!Hinv) return null;
  return { hinv: Hinv, minX, minY, maxX, maxY };
}

// 一个 source（经共享 gizmo 映出自己的 dest quad）→ GPU warp 参数：Hinv + dst bbox（doc 坐标）。
//   board._glFloatInputs 用它喂 GPU（源纹理只传一次，每帧只更 hinv）。source 只消费 rect（identity 位置）。
export function sourceWarpMatrix(source: { rect: Rect }, gizmoFrame: FloatFrame, mesh: Mesh): { hinv: number[]; bx: number; by: number; bw: number; bh: number } | null {
  const destQuad = sourceDestQuad(source.rect, gizmoFrame, mesh);
  if (!destQuad) return null;
  const q = quadWarp(destQuad);
  if (!q) return null;
  return { hinv: q.hinv, bx: q.minX, by: q.minY, bw: q.maxX - q.minX, bh: q.maxY - q.minY };
}

// CPU 逐像素 warp（renderQuadPerPixel）+ 三采样器（nearest/bilinear/bicubic）已归档（v355）：display+commit 全
//   走 GPU warp（gl-compositor WARP_FRAG/WARP_BAKE_FRAG，复用 quadWarp 同矩阵）。golden 的 CPU 对照基准搬进
//   test/gl-smoke/harness.ts（test-only，非运行时路径）。下面的 homography/invertMat3 是 quadWarp 的依赖，留下。

// 单位方格 (0,0)-(1,1) → 一般四边形 (TL,TR,BR,BL) 的 homography（Heckbert 1989 闭式解）。
//   x = (a·u + b·v + c) / (g·u + h·v + 1)；平行四边形时 g=h=0 退化为 affine。
function homographyFromUnitSquareToQuad(tl: Point, tr: Point, br: Point, bl: Point): Homography | null {
  const dx1 = tr.x - br.x, dy1 = tr.y - br.y;
  const dx2 = bl.x - br.x, dy2 = bl.y - br.y;
  const sx = tl.x - tr.x + br.x - bl.x;
  const sy = tl.y - tr.y + br.y - bl.y;
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) < 1e-9) return null;        // 退化
  const g = (sx * dy2 - dx2 * sy) / det;
  const h = (dx1 * sy - sx * dy1) / det;
  return {
    a: tr.x - tl.x + g * tr.x,
    b: bl.x - tl.x + h * bl.x,
    c: tl.x,
    d: tr.y - tl.y + g * tr.y,
    e: bl.y - tl.y + h * bl.y,
    f: tl.y,
    g, h,
  };
}

// 3×3 matrix invert（normalize so [8] = 1）
function invertMat3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return null;
  const inv = [
    (e * i - f * h) / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    -(d * i - f * g) / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    (d * h - e * g) / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
  if (Math.abs(inv[8]) > 1e-9) {
    const k = 1 / inv[8];
    for (let n = 0; n < 9; n++) inv[n] *= k;
  }
  return inv;
}
