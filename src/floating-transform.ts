// 浮层变换（Float / FloatingTransform）深模块。见 CONTEXT「浮层变换」。
//
// 选区像素被「抬起 → 自由变换（move/scale/rotate/perspective）→ 落回」的瞬态。
// 2026-06-19 从 lasso.js 抽出：lasso.js 只产 Selection + 经 LassoEngine facade 驱动本模块；
// input.js / board.js / app.js 不直接 import 本模块，全走 LassoEngine（接缝不变）。
//
// v0.4.7（S6）float 状态移入 workpiece；v0.8.15（T4b）组件化：FloatLayerComponent 持状态与记账，
// 本类 = 引擎编排：
//   - gizmo/单应性数学（MODES adapter + quadWarp/sourceWarpMatrix，原样保留）；
//   - live 网格视图 _live（拖动中的热路径：每 move 只动本地网格，抬手才把 metadata 整点入栈——
//     同 stroke 的事务型节奏；undo/redo 后经 syncFromWorkpiece 重新采纳）；
//   - lift/stamp/accept/reject 的令牌编排（history.withPoint 一个整点：挖洞/烤层像素由
//     LayerTiles 写时扣押、选区由 SelectionComponent、浮层状态由 FloatLayerComponent 分账——
//     旧 pre-applied ops.pixels 快照 × N + DropFloatOp 微步链死，三处 _initialBefore 双记账随之消灭）。
// reject（cancel）≠ undo：identity 写回 operator——float 像素在原位 source-over 落到当前内容上
// （stamp 保留、无重采样，spec:220-225），可再撤销。
//
// 变形模式 = adapter（MODES）：free / uniform / distort 各定 meshN、是否露 rotate handle、
//   corner/edge 约束数学。模式切换 = usedClass 记账制（v0.6.34，projectOnEnter 投影已删——
//   切模式不悄悄改 mesh，降不回去的模式 UI 置灰）。warp 已删（旧 4×4 是错数学）。
//
// 渲染：2×2 mesh → GPU warp（gl-compositor，per-pixel inverse homography；本文件只出 warp 矩阵，
//   栅格在 GPU）。浮层源 = straight 字节平面 typed-array 直传（v0.6.38 去 canvas 化；WeakMap 缓存）。

import { findViewNodeById, eachViewLeaf } from "./backend/workpiece/painting-view.ts";
import type { ViewLeaf, ViewGroup, PaintingView } from "./backend/workpiece/painting-view.ts";
import { cloneFloatMeta } from "./backend/workpiece/float-component.ts";
import type { FloatFrame, FloatTransformMeta, WorkpieceFloat, FloatState, TransformClass, FloatLayerComponent } from "./backend/workpiece/float-component.ts";
import type { SelectionComponent } from "./backend/workpiece/selection-component.ts";
import { extractFloatPixels, makeFloatFromBytes, composeCutHole, composeIdentityWriteback, composeRigidWriteback, composeOverWriteback, applyRegionBuf } from "./backend/workpiece/float-ops.ts";
import type { RigidMap } from "./backend/workpiece/float-ops.ts";
import type { History } from "./backend/workpiece/history.ts";
import { prefilterToSplinePlane } from "./backend/algorithms/bspline.ts";
import type { SplinePlane } from "./backend/algorithms/bspline.ts";
import { rotspriteUpscale } from "./backend/algorithms/rotsprite.ts";
import type { U8Plane } from "./backend/algorithms/rotsprite.ts";

// ---- 局部几何/数据类型（type-strip 后纯运行时无变化）----
type Node = ViewLeaf | ViewGroup;
interface Point { x: number; y: number; }
type Mesh = Point[][];                          // 2×2：[[TL,TR],[BL,BR]]
interface Rect { x: number; y: number; w: number; h: number; }
type SampleMode = "nearest" | "bilinear" | "bicubic" | "spline" | "rotsprite";

// commit 烤定的 GPU warp fn（board.glWarpBakeFn 注入）：warp 源 → straight RGBA **字节** + doc 坐标位置。
//   mode：0=nearest 1=bilinear 2=bicubic 3=spline（对齐 WARP shader）。GL 失败=null（commit 不烤）。
//   源一律 typed array（v0.6.38 去 canvas 化，修柔边 premult 黑边）：mode 3 = B 样条系数平面
//   （SplinePlane）；rotsprite = EPX 放大 U8Plane + mode 0 + 放大后尺寸；其余 = 源 straight 字节 U8Plane。
export type WarpBakeFn = (src: SplinePlane | U8Plane, srcW: number, srcH: number, hinv: number[], mode: number, bx: number, by: number, bw: number, bh: number) => { data: Uint8ClampedArray; w: number; h: number; dstX: number; dstY: number } | null;

type TransformModeKind = "free" | "uniform" | "distort";

// 渲染消费面（board._glFloatInputs / app lassoProvider）：workpiece float 的只读视图。
// bytes = 源 straight 字节（typed array 直传 GPU，零 canvas premult 往返——v0.6.38 修柔边黑边）；
// spline / rotsprite：对应采样模式激活时附带的派生平面（current() 懒算，per-float 缓存）。
export interface FloatViewSource { layerId: number; bytes: U8Plane; rect: Rect; spline?: SplinePlane; rotsprite?: U8Plane }
export interface FloatView {
  sources: FloatViewSource[];
  gizmoFrame: FloatFrame;
  mesh: Mesh;
  meshN: number;
  mode: TransformModeKind | null;
}

export interface Hit {
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
  snapInt?: boolean;   // translate 拖动整数取整（起手时处于整数刚体态 → 平移保持无损，WYSIWYG）
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
}

// 模式 ↔ 自由度类（记账制）：corner/edge 拖动把 usedClass 升到所在模式的类；切模式只比类别
// （零几何判定 → basisRotate 转轴态不误判、浮点渣不积累过线）。
const MODE_CLASS: Record<TransformModeKind, TransformClass> = { uniform: "similarity", free: "affine", distort: "projective" };
const CLASS_LEVEL: Record<TransformClass, number> = { similarity: 1, affine: 2, projective: 3 };

// live 网格（拖动热路径的本地副本；SSoT = floatLayer.view().transform）。
interface LiveMeta {
  gizmoFrame: FloatFrame;
  mesh: Mesh;
  meshN: number;
  mode: TransformModeKind | null;
  uniformAspect: number;
  usedClass?: TransformClass;   // 像素变换用过的最高自由度类（模式切换记账制；缺省 similarity）
}

// float tiles → straight 字节平面的懒物化缓存（float 像素不可变 → 按对象身份缓存即自失效）。
// v0.6.38：取代旧 floatSourceCanvas（putImageData→canvas→texImage2D 的 premult 往返在 Safari
// 上会把半透明柔边变黑——typed array 直传，UNPACK flag 对 typed array 不适用，字节 verbatim 上卡）。
const _floatBytesCache = new WeakMap<WorkpieceFloat, U8Plane>();
function floatBytes(f: WorkpieceFloat): U8Plane {
  let p = _floatBytesCache.get(f);
  if (!p) {
    // 浮层像素是**本地坐标**（网格 = rect 尺寸，内容在本地 (0,0)）——v0.9.2 起 rect 可越出画布，
    // 按 rect.x/y 读会读到画布外的空 tile。落位交给 rect，这里只管取整块。
    p = { data: f.pixels.getRegion(0, 0, f.rect.w, f.rect.h), w: f.rect.w, h: f.rect.h };
    _floatBytesCache.set(f, p);
  }
  return p;
}
// FloatView.sources 按 FloatState 身份缓存（每帧 provider 调 current()，别每帧重建数组）。
const _floatViewCache = new WeakMap<FloatState, FloatViewSource[]>();
// spline 系数平面缓存（float 像素不可变 → 按身份缓存自失效；只在 spline 模式下懒算，一次 O(n) IIR）。
const _floatSplineCache = new WeakMap<WorkpieceFloat, SplinePlane>();
function floatSplinePlane(f: WorkpieceFloat): SplinePlane {
  let p = _floatSplineCache.get(f);
  if (!p) {
    const b = floatBytes(f);
    p = prefilterToSplinePlane(b.data, b.w, b.h);
    _floatSplineCache.set(f, p);
  }
  return p;
}
// rotsprite EPX 放大平面缓存（同款节奏；只在 rotsprite 模式下懒算，浮层收摊即随 f 释放）。
const _floatRotspriteCache = new WeakMap<WorkpieceFloat, U8Plane>();
function floatRotspritePlane(f: WorkpieceFloat): U8Plane {
  let p = _floatRotspriteCache.get(f);
  if (!p) {
    const b = floatBytes(f);
    p = rotspriteUpscale(b.data, b.w, b.h);
    _floatRotspriteCache.set(f, p);
  }
  return p;
}

export class FloatingTransform {
  _live: LiveMeta | null;
  _drag: Drag | null;
  _sampleMode: SampleMode;
  onChange: () => void;
  private _doc: PaintingView | null = null;
  private _history: History | null = null;
  private _float: FloatLayerComponent | null = null;
  private _sel: SelectionComponent | null = null;

  // onChange 晚绑定（LassoEngine 构造时传 () => this.onChange()，因为 input.js 之后才赋 onChange）。
  constructor(onChange: () => void = () => {}) {
    this._live = null;
    this._drag = null;
    this._sampleMode = "bicubic";   // 默认双三次（v0.6.45 真机裁决：spline+限幅后无显著优势且微卡，降为自选档）
    this.onChange = onChange;
  }

  // workpiece/undo 接线（input.ts 构造后注入；lift/stamp/commit/cancel 全走令牌编排）。
  attach(doc: PaintingView, history: History, float: FloatLayerComponent, sel: SelectionComponent) {
    this._doc = doc;
    this._history = history;
    this._float = float;
    this._sel = sel;
  }

  setSampleMode(m: string) {
    if (m === "nearest" || m === "bilinear" || m === "bicubic" || m === "spline" || m === "rotsprite") {
      this._sampleMode = m;
      if (this._live) this.onChange();   // GPU 每帧按 mode 重 warp，无 CPU 缓存可清
    }
  }
  getSampleMode() { return this._sampleMode; }

  isActive() { return !!this._float?.view(); }

  // 只读视图（app lassoProvider → board：GPU warp 输入 + gizmo overlay）。
  // _live 落后于 workpiece（undo/redo 刚动完、reconciler 未跑）时就地补同步——渲染永远吃一致态。
  current(): FloatView | null {
    const fs = this._float?.view();
    if (!fs) return null;
    if (!this._live) this.syncFromWorkpiece();
    const lv = this._live;
    if (!lv) return null;
    let sources = _floatViewCache.get(fs);
    if (!sources) {
      sources = fs.floats.map((f) => ({ layerId: f.sourceLayerId, bytes: floatBytes(f), rect: f.rect }));
      _floatViewCache.set(fs, sources);
    }
    // spline / rotsprite 模式：附带派生平面（懒算 + per-float 缓存；切回其它模式留着无害，board 按 mode 消费）
    if (this._sampleMode === "spline") {
      fs.floats.forEach((f, i) => { if (!sources![i].spline) sources![i].spline = floatSplinePlane(f); });
    } else if (this._sampleMode === "rotsprite") {
      fs.floats.forEach((f, i) => { if (!sources![i].rotsprite) sources![i].rotsprite = floatRotspritePlane(f); });
    }
    return { sources, gizmoFrame: lv.gizmoFrame, mesh: lv.mesh, meshN: lv.meshN, mode: lv.mode };
  }

  // undo/redo/lift 后：live 网格重新采纳 workpiece 的 transform metadata。拖动中不采纳（防御）。
  syncFromWorkpiece() {
    if (this._drag) return;
    const fs = this._float?.view();
    if (!fs) { this._live = null; return; }
    const t = cloneFloatMeta(fs.transform);
    this._live = { gizmoFrame: t.gizmoFrame, mesh: t.mesh as Mesh, meshN: t.meshN, mode: t.mode, uniformAspect: t.uniformAspect, usedClass: t.usedClass };
  }

  // 把 active 节点 lift 成浮层（一个令牌整点：清选区 + 建 float tiles + 挖洞，全可撤销——
  // 挖洞像素走 LayerTiles 写时扣押、选区走 SelectionComponent、浮层状态走 FloatLayerComponent 分账）。
  // leaf → 单 float；group → 组内所有叶(含隐藏)各一 float，共享一个 gizmo（隐藏随组动、不定框）。
  // 选区为 null 且 opts.fallbackFullLayer → 隐式整层全选。opts.cut: true(默认)=挖空源层（Ctrl+T）；
  // false=不挖洞（Ctrl+D 复制为浮层）。返回 bool（false = 没东西可变换，栈未动）。
  lift(node: Node | null, opts: LiftOpts = {}) {
    if (!node || !this._history || !this._float || !this._sel) return false;
    if (this._float.view()) return false;
    // bake（纯读，令牌外）：全部成功才 mutate（原子；没东西可变换 → 栈未动）
    const sel = opts.ignoreSelection ? null : this._sel.view();
    if (!sel && !opts.fallbackFullLayer) return false;
    const leaves: ViewLeaf[] = [];
    if (node.isGroup) eachViewLeaf(node.children, (L) => leaves.push(L));   // 含隐藏叶（整组一起动）
    else leaves.push(node as ViewLeaf);
    const baked: { leaf: ViewLeaf; float: WorkpieceFloat }[] = [];
    for (const leaf of leaves) {
      const f = extractFloatPixels(leaf, sel);
      if (f) baked.push({ leaf, float: f });
    }
    if (!baked.length) return false;
    const r = this._history.withPoint("liftFloat", {}, () => {
      if (opts.cut !== false) {
        for (const b of baked) {
          // 洞区域 = 内容∩选区 bbox（trim 掉的边缘本就透明，挖不挖等价——旧 LiftFloatOp 语义原样）
          const content = b.leaf.pixels.contentBounds(true);
          if (!content) continue;
          const x0 = sel ? Math.max(content.x, sel.bboxX) : content.x;
          const y0 = sel ? Math.max(content.y, sel.bboxY) : content.y;
          const x1 = sel ? Math.min(content.x + content.w, sel.bboxX + sel.bboxW) : content.x + content.w;
          const y1 = sel ? Math.min(content.y + content.h, sel.bboxY + sel.bboxH) : content.y + content.h;
          const hole = composeCutHole(b.leaf, sel, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
          if (hole) applyRegionBuf(b.leaf, hole);
        }
      }
      this._installBaked(baked);
    });
    if (!r.ok) {
      // install 是令牌内最后一步：失败 = 浮层从未上台（cancel 已回滚挖洞/选区）→ 提取物归本函数释放
      for (const b of baked) b.float.pixels.dispose();
      return false;
    }
    this.syncFromWorkpiece();
    this.onChange();
    return true;
  }

  // 令牌内的上台收尾（lift / liftFromBytes 共用）：清选区 + 初始 gizmo + install。
  private _installBaked(baked: { leaf: ViewLeaf; float: WorkpieceFloat }[]) {
    // gizmo 框 = 可见 source rect 并集（隐藏叶随组动但不定框；全隐藏兜底 = 全部）
    const vis = baked.filter((b) => b.leaf.visible);
    const rects = (vis.length ? vis : baked).map((b) => b.float.rect);
    let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
    for (const rc of rects) {
      if (rc.x < gx0) gx0 = rc.x;
      if (rc.y < gy0) gy0 = rc.y;
      if (rc.x + rc.w > gx1) gx1 = rc.x + rc.w;
      if (rc.y + rc.h > gy1) gy1 = rc.y + rc.h;
    }
    const gw = gx1 - gx0, gh = gy1 - gy0;
    this._sel!.set(null);   // 旧选区进 selection record（ignoreSelection 也照清——旧 lift 语义）
    this._float!.install({
      floats: baked.map((b) => b.float),
      transform: {
        // 初始 frame = AABB（轴对齐）；方手柄转轴后才是一般平行四边形（v0.6.21）
        gizmoFrame: { origin: { x: gx0, y: gy0 }, ux: { x: gw, y: 0 }, uy: { x: 0, y: gh } },
        mesh: [
          [{ x: gx0, y: gy0 }, { x: gx1, y: gy0 }],
          [{ x: gx0, y: gy1 }, { x: gx1, y: gy1 }],
        ],
        meshN: 2,
        mode: "uniform",   // v0.10.1 (user：「等比最高频，特别是导入图片」)：默认等比；uniform=similarity 是最低类，仍可升 free/distort

        uniformAspect: gw / Math.max(1, gh),
        usedClass: "similarity",
      },
    });
  }

  // 字节直接 lift 成浮层（导入「保持原尺寸」：图比画布大时，经图层落地会被 doc 边界吃掉
  // 越界像素——这条路不碰图层像素，字节直接成浮层）。rect 允许越出画布（x/y 负、w/h > doc）。
  // leaf 应为空层（不挖洞）；令牌纪律同 lift（一个整点：清选区 + install，可撤销）。
  liftFromBytes(leaf: ViewLeaf | null, bytes: Uint8ClampedArray, rect: Rect): boolean {
    if (!leaf || !this._history || !this._float || !this._sel) return false;
    if (this._float.view()) return false;
    const float = makeFloatFromBytes(leaf.id, bytes, rect);   // 令牌外纯构造（失败 = 栈未动）
    if (!float) return false;
    const baked = [{ leaf, float }];
    const r = this._history.withPoint("liftFloat", {}, () => { this._installBaked(baked); });
    if (!r.ok) { float.pixels.dispose(); return false; }
    this.syncFromWorkpiece();
    this.onChange();
    return true;
  }

  // -------- 模式切换 --------
  // mode = null（"selected"：只显轮廓、拖内 = 平移）或 "free" | "uniform" | "distort"。
  // 投影改网格 → metadata 整点入栈（FloatLayerComponent.setTransform）。
  // 模式切换 = 记账制（v0.6.34，取代 projectOnEnter 投影）：目标模式的类 ≥ 已用过的最高类才允许切，
  //   不悄悄改 mesh（投影 = 预览外的突变，user 否决）。降不回去的模式由 UI 置灰（canSetMode）。
  setMode(mode: TransformModeKind | null) {
    const lv = this._live;
    if (!lv) return;
    if (mode === lv.mode) return;
    if (!this.canSetMode(mode)) return;
    lv.mode = mode;
    this._pushTransformCheckpoint();
    this.onChange();
  }
  canSetMode(mode: TransformModeKind | null): boolean {
    const lv = this._live;
    if (!lv || mode === null) return true;
    const used = lv.usedClass ?? "similarity";
    return CLASS_LEVEL[MODE_CLASS[mode]] >= CLASS_LEVEL[used];
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
      // 起手处于整数刚体态（identity/整平移/90°族）→ 平移拖动取整：预览=落地（WYSIWYG，反煤气灯），
      // commit 恒走置换快路。已旋转/缩放态不取整（反正重采样，别损摆位精度）。
      snapInt: hit.kind === "translate" ? this._isIntegerRigidState() : false,
    };
  }
  extendDrag(x: number, y: number) {
    const f = this._live;
    const d = this._drag;
    if (!f || !d) return;
    let dx = x - d.startX;
    let dy = y - d.startY;
    if (d.kind === "translate") {
      if (d.snapInt) { dx = Math.round(dx); dy = Math.round(dy); }
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
      applyBasisRotate(f, d, x, y, this._contentRects());
    }
    this.onChange();                  // mesh 变 → board 每帧用新 mesh 重算 Hinv 重 warp（GPU，无 CPU 缓存）
  }
  // basisRotate 外接用的内容 rect 集（workpiece floats；测试直接播种 _live 时为空 → 退化用 mesh 角）
  _contentRects(): Rect[] {
    const fs = this._float?.view();
    return fs ? fs.floats.map((fl) => ({ ...fl.rect })) : [];
  }

  // 当前是否整数刚体态：所有 float 的 destQuad 都是各自 rect 的整数刚体像（平移取整/90°奇偶取整的门）。
  // 测试播种（无 workpiece）退化：frame 轴对齐时用 frame 单位方格自身当 rect。
  private _isIntegerRigidState(): boolean {
    const lv = this._live;
    if (!lv) return false;
    let rects = this._contentRects();
    if (!rects.length) {
      const fr = lv.gizmoFrame;
      if (Math.abs(fr.ux.y) > RIGID_EPS || Math.abs(fr.uy.x) > RIGID_EPS) return false;
      rects = [{ x: fr.origin.x, y: fr.origin.y, w: fr.ux.x, h: fr.uy.y }];
    }
    for (const r of rects) {
      if (r.w <= 0 || r.h <= 0) continue;
      const dq = sourceDestQuad(r, lv.gizmoFrame, lv.mesh);
      if (!dq || !integerRigidOf(r, dq)) return false;
    }
    return true;
  }

  endDrag() {
    const d = this._drag;
    this._drag = null;
    const f = this._live;
    if (!d || !f) return;
    // 网格真动了才入栈（点一下就松 ≠ 空整点）
    const moved = f.mesh.some((row, i) => row.some((p, j) => p.x !== d.meshSnap[i][j].x || p.y !== d.meshSnap[i][j].y));
    if (moved) {
      // 自由度记账：corner/edge 拖动把 usedClass 升到所在模式的类（uniform=相似、free=仿射、distort=透视）。
      // translate/rotate/basisRotate/flip/rotate90 不升级（相似类内 / 不动像素）。只升不降，随 undo 整点回退。
      if (d.kind === "corner" || d.kind === "edge") this._escalateClass(MODE_CLASS[f.mode as TransformModeKind] ?? "similarity");
      this._pushTransformCheckpoint();
    }
  }

  private _escalateClass(target: TransformClass) {
    const f = this._live;
    if (!f) return;
    const cur = f.usedClass ?? "similarity";
    if (CLASS_LEVEL[target] > CLASS_LEVEL[cur]) f.usedClass = target;
  }

  // #12（v0.5）：浮层整体水平翻转 / 逆时针转 90°。绕当前 mesh 四外角的质心变换，
  //   一次一个 undo 整点（同 endDrag 的事务节奏）。画布级 flip/rotate 在 doc-ops，那是整文档，别混。
  private _transformLivePoints(fn: (p: Point, cx: number, cy: number) => Point) {
    const lv = this._live;
    if (!lv || !this.isActive()) return;
    const wasRigid = this._isIntegerRigidState();
    const n = lv.meshN - 1;
    const corners = [lv.mesh[0][0], lv.mesh[0][n], lv.mesh[n][0], lv.mesh[n][n]];
    const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
    const cy = corners.reduce((s, p) => s + p.y, 0) / 4;
    lv.mesh = lv.mesh.map((row) => row.map((p) => fn(p, cx, cy)));
    // 整数刚体态下的 flip/rotate90 必须回整数格：绕质心转 90° 在 w、h 奇偶性不同时落 0.5 网格
    //   （恰好半相位 = 最糊情形）。四角的小数部分一致 → 统一 round 只平移 ±0.5px、尺寸不变，
    //   保住置换快路。非刚体态（任意角/缩放中）不取整，别毁摆位。
    if (wasRigid) lv.mesh = lv.mesh.map((row) => row.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })));
    this._pushTransformCheckpoint();
    this.onChange();
  }
  flipHorizontal() { this._transformLivePoints((p, cx, _cy) => ({ x: 2 * cx - p.x, y: p.y })); }
  rotate90CCW()    { this._transformLivePoints((p, cx, cy) => ({ x: cx + (p.y - cy), y: cy - (p.x - cx) })); }
  // 方向键像素微调（user：「变换的时候可以用上下左右键进行像素坐标精调」）：整树平移 (dx,dy)。
  //   步长单位 = doc px——"像素坐标精调"的语义就是文档像素，不做屏幕 px 换算（缩放视图下 1px 就是
  //   1 个 texel，这正是精调要的）。整数步长在整数刚体态下天然保刚体（wasRigid 的 round 是恒等），
  //   置换快路不丢。已知取舍：每按一下 = 一个 undo 整点（同 flip/rotate90 的事务节奏），长按连发
  //   会攒一串整点，无 coalescing——接受，先按简单做。
  nudge(dx: number, dy: number) { this._transformLivePoints((p) => ({ x: p.x + dx, y: p.y + dy })); }

  // v0.7.37（user：「reset scale + rot + align to center」）：一键复位——尺寸回 float 原始 rect
  // （union AABB，同 lift 初始），画布居中，缩放/旋转/透视全清。全整数坐标 → 整数刚体态 →
  // commit 走置换快路逐字节无损（跨 doc 导入对齐的手动兜底：同尺寸 roundtrip 本就居中=(0,0)）。
  // 一个 undo 整点（同 flip/rotate90 的事务节奏）。
  resetToCenterOriginal(): boolean {
    const lv = this._live;
    const fs = this._float?.view();
    if (!lv || !fs || !fs.floats.length) return false;
    let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
    for (const f of fs.floats) {
      if (f.rect.x < gx0) gx0 = f.rect.x;
      if (f.rect.y < gy0) gy0 = f.rect.y;
      if (f.rect.x + f.rect.w > gx1) gx1 = f.rect.x + f.rect.w;
      if (f.rect.y + f.rect.h > gy1) gy1 = f.rect.y + f.rect.h;
    }
    const w0 = gx1 - gx0, h0 = gy1 - gy0;
    const doc = this._doc!;
    const x0 = Math.round(doc.width / 2 - w0 / 2), y0 = Math.round(doc.height / 2 - h0 / 2);
    const x1 = x0 + w0, y1 = y0 + h0;
    // 映射约定（sourceDestQuad）：gizmoFrame = source 归一化参考系 → 必须复位成 source union AABB
    // （basisRotate 可能转过它）；mesh = dest quad = 居中矩形。合成 = 纯整数平移。
    lv.gizmoFrame = { origin: { x: gx0, y: gy0 }, ux: { x: w0, y: 0 }, uy: { x: 0, y: h0 } };
    lv.mesh = [
      [{ x: x0, y: y0 }, { x: x1, y: y0 }],
      [{ x: x0, y: y1 }, { x: x1, y: y1 }],
    ];
    lv.meshN = 2;
    lv.usedClass = "similarity";   // 自由度记账清零（同 lift 初始；随本整点 undo 回退）
    lv.uniformAspect = w0 / Math.max(1, h0);
    this._pushTransformCheckpoint();
    this.onChange();
    return true;
  }

  private _pushTransformCheckpoint() {
    if (!this._history || !this._float || !this._live) return;
    const lv = this._live;
    this._history.withPoint("floatTransform", {}, () => {
      this._float!.setTransform({
        gizmoFrame: lv.gizmoFrame, mesh: lv.mesh, meshN: lv.meshN, mode: lv.mode, uniformAspect: lv.uniformAspect, usedClass: lv.usedClass,
      } as FloatTransformMeta);   // 组件内克隆——live 网格不被 record 引用
    });
  }

  // 把一个 float 的像素落回源 layer（stamp/accept 共用）。GPU 烤定：sourceWarpMatrix 算 Hinv+bbox →
  //   bakeFn（board.glWarpBakeFn = GPU warp readback）→ straight canvas → editRegion 落层。与 live warp 同采样器，
  //   零 preview/commit 漂移。bakeFn 缺省（GL 失败）→ 不烤（app 已显「需 WebGL2」）。
  private _bakeDown(f: WorkpieceFloat, leaf: ViewLeaf, bakeFn: WarpBakeFn | null) {
    if (!this._live) return;
    const lv = this._live;
    // 整数刚体快路（v0.6.34：identity/整数平移/90°倍数旋转/翻转 全族）：destQuad = rect 的整数刚体像
    //   → 跳过 GPU warp，typed-array 像素置换 source-over 写回。绕开 GPU float 误差 +
    //   putImageData/drawImage 的 premultiply 往返 → 「摆正状态的 commit 逐字节无损」，与采样模式无关。
    //   不需要 bakeFn（GL 失败也能落）。
    const dq = sourceDestQuad(f.rect, lv.gizmoFrame, lv.mesh);
    const rigid = dq ? integerRigidOf(f.rect, dq) : null;
    if (rigid) {
      applyRegionBuf(leaf, composeRigidWriteback(leaf, f, rigid));
      return;
    }
    if (!bakeFn) return;
    const wp = sourceWarpMatrix(f, lv.gizmoFrame, lv.mesh);
    if (!wp || wp.bw <= 0 || wp.bh <= 0) return;
    let rendered;
    if (this._sampleMode === "rotsprite") {
      // 像素完美：EPX 放大平面 + nearest（mode 0）+ 放大后尺寸（hinv 不变——尺寸在 shader 里乘）
      const up = floatRotspritePlane(f);
      rendered = bakeFn(up, up.w, up.h, wp.hinv, 0, wp.bx, wp.by, wp.bw, wp.bh);
    } else {
      const mode = this._sampleMode === "nearest" ? 0 : this._sampleMode === "bicubic" ? 2 : this._sampleMode === "spline" ? 3 : 1;
      const src = this._sampleMode === "spline" ? floatSplinePlane(f) : floatBytes(f);
      rendered = bakeFn(src, f.rect.w, f.rect.h, wp.hinv, mode, wp.bx, wp.by, wp.bw, wp.bh);
    }
    if (!rendered) return;
    // typed-array source-over 落层（v0.6.38：取代 editRegion/drawImage 的 canvas premult 往返）。
    // dstX/dstY = bbox 左上（整数，quadWarp floor/ceil 产）。
    applyRegionBuf(leaf, composeOverWriteback(leaf, rendered.dstX, rendered.dstY, rendered.w, rendered.h, rendered.data));
  }

  // 源层 id → 活叶（消失容忍：跳过该 float，别的照常）。
  private _leafFor(f: WorkpieceFloat): ViewLeaf | null {
    const n = findViewNodeById(this._doc!.layers, f.sourceLayerId);
    return n && !n.isGroup ? (n as ViewLeaf) : null;
  }

  // Stamp：各 float 按当前 mesh 烤进源层，KEEP float。一个令牌整点（烤层像素 = LayerTiles
  // 写时扣押；全 no-op 时 collector 空 → 不占 undo 步）。
  stamp(bakeFn?: WarpBakeFn | null) {
    const fs = this._float?.view();
    if (!fs || !this._history || !bakeFn) return false;
    const r = this._history.withPoint("stampFloat", {}, () => {
      for (const f of fs.floats) {
        const leaf = this._leafFor(f);
        if (leaf) this._bakeDown(f, leaf, bakeFn);
      }
    });
    this.onChange();
    return r.ok;
  }

  // v0.9.28 只读烤制（user 2026-08-20：「浮层的时候应该也能 ctrl c」）：与 _bakeDown 同一套采样
  //   路径（刚体快路零重采样 / GPU warp），但**不落层、不进栈、零副作用**——各 float 烤成独立字节块
  //   后 source-over 合成到透明底，返回 doc 坐标 rect + straight RGBA。浮层可越出画布：**不夹 doc**，
  //   复制带走全部像素（这正是它比"先 commit 再复制"强的地方——commit 会把画布外那圈裁死）。
  //   非刚体且 bakeFn 缺席（GL 不可用）→ 返回 null，调用方给明确 toast（不出半个结果=不说谎）。
  bakeStandalone(bakeFn: WarpBakeFn | null): { x: number; y: number; w: number; h: number; data: Uint8ClampedArray } | null {
    const fs = this._float?.view();
    if (!fs || !this._live || !fs.floats.length) return null;
    const lv = this._live;
    const parts: { x: number; y: number; w: number; h: number; data: Uint8ClampedArray }[] = [];
    for (const f of fs.floats) {
      const dq = sourceDestQuad(f.rect, lv.gizmoFrame, lv.mesh);
      const rigid = dq ? integerRigidOf(f.rect, dq) : null;
      if (rigid) {
        if (rigid.dw <= 0 || rigid.dh <= 0) continue;
        const src = floatBytes(f);
        const out = new Uint8ClampedArray(rigid.dw * rigid.dh * 4);
        for (let v = 0; v < rigid.dh; v++) {
          for (let u = 0; u < rigid.dw; u++) {
            const sx = rigid.m11 * u + rigid.m12 * v + rigid.s0x;
            const sy = rigid.m21 * u + rigid.m22 * v + rigid.s0y;
            if (sx < 0 || sx >= src.w || sy < 0 || sy >= src.h) continue;
            const si = (sy * src.w + sx) * 4, di = (v * rigid.dw + u) * 4;
            out[di] = src.data[si]; out[di + 1] = src.data[si + 1]; out[di + 2] = src.data[si + 2]; out[di + 3] = src.data[si + 3];
          }
        }
        parts.push({ x: rigid.dx0, y: rigid.dy0, w: rigid.dw, h: rigid.dh, data: out });
        continue;
      }
      if (!bakeFn) return null;
      const wp = sourceWarpMatrix(f, lv.gizmoFrame, lv.mesh);
      if (!wp || wp.bw <= 0 || wp.bh <= 0) continue;
      let rendered;
      if (this._sampleMode === "rotsprite") {
        const up = floatRotspritePlane(f);
        rendered = bakeFn(up, up.w, up.h, wp.hinv, 0, wp.bx, wp.by, wp.bw, wp.bh);
      } else {
        const mode = this._sampleMode === "nearest" ? 0 : this._sampleMode === "bicubic" ? 2 : this._sampleMode === "spline" ? 3 : 1;
        const src = this._sampleMode === "spline" ? floatSplinePlane(f) : floatBytes(f);
        rendered = bakeFn(src, f.rect.w, f.rect.h, wp.hinv, mode, wp.bx, wp.by, wp.bw, wp.bh);
      }
      if (rendered && rendered.w > 0 && rendered.h > 0) parts.push({ x: rendered.dstX, y: rendered.dstY, w: rendered.w, h: rendered.h, data: rendered.data });
    }
    if (!parts.length) return null;
    if (parts.length === 1) return parts[0];
    // 多 float：并集 bbox 透明底逐块 source-over（straight alpha，与 composeOverWriteback 同式；顺序=floats 序）
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of parts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h); }
    const W = x1 - x0, H = y1 - y0;
    const out = new Uint8ClampedArray(W * H * 4);
    for (const p of parts) {
      for (let v = 0; v < p.h; v++) {
        for (let u = 0; u < p.w; u++) {
          const si = (v * p.w + u) * 4;
          const sa = p.data[si + 3];
          if (!sa) continue;
          const di = ((v + p.y - y0) * W + (u + p.x - x0)) * 4;
          const da = out[di + 3];
          if (sa === 255 || !da) { out[di] = p.data[si]; out[di + 1] = p.data[si + 1]; out[di + 2] = p.data[si + 2]; out[di + 3] = sa; continue; }
          const oa = sa + da * (255 - sa) / 255;
          out[di]     = Math.round((p.data[si]     * sa + out[di]     * da * (255 - sa) / 255) / oa);
          out[di + 1] = Math.round((p.data[si + 1] * sa + out[di + 1] * da * (255 - sa) / 255) / oa);
          out[di + 2] = Math.round((p.data[si + 2] * sa + out[di + 2] * da * (255 - sa) / 255) / oa);
          out[di + 3] = Math.round(oa);
        }
      }
    }
    return { x: x0, y: y0, w: W, h: H, data: out };
  }

  // -------- accept / reject --------
  // accept（commit）：各 float 烤进源层 + FloatLayerComponent.drop 收摊，一个令牌整点。
  //   选区在 lift 时已清（spec:213）——accept 不再碰 selection（现状「清」保持，UX 待人类拍板）。
  commit(bakeFn?: WarpBakeFn | null): boolean {
    const fs = this._float?.view();
    if (!fs || !this._history) return false;
    const r = this._history.withPoint("acceptFloat", {}, () => {
      for (const f of fs.floats) {
        const leaf = this._leafFor(f);
        if (leaf) this._bakeDown(f, leaf, bakeFn ?? null);
      }
      this._float!.drop();
    });
    this._drag = null;
    this.syncFromWorkpiece();
    this.onChange();
    return r.ok;
  }
  // reject（cancel）：**不是 undo**（spec:220-225）——identity 写回：float 像素在原 rect
  //   source-over 落到当前内容上（stamp 保留、float 在其上），不走 warp 采样器（无重采样）。
  //   本身是一个可撤销整点（Ctrl+Z 可把 reject 撤回来）。选区保持 lift 后的空态。
  cancel(): boolean {
    const fs = this._float?.view();
    if (!fs || !this._history) return false;
    const r = this._history.withPoint("rejectFloat", {}, () => {
      for (const f of fs.floats) {
        const leaf = this._leafFor(f);
        if (leaf) applyRegionBuf(leaf, composeIdentityWriteback(leaf, f));
      }
      this._float!.drop();
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
  },
  uniform: {
    kind: "uniform", meshN: 2, showsRotate: true,
    corner: (mesh, snap, drag, r, c, x, y, _asp) => solveAffineCorner(mesh, snap, drag, r, c, x, y, true),
    edge:   (mesh, snap, drag, e, x, y, asp) => solveAffineEdge(mesh, snap, drag, e, x, y, true, asp),
  },
  distort: {
    kind: "distort", meshN: 2, showsRotate: true,   // v0.6.21：透视前圆（转像素）方（转轴）双手柄
    corner: (mesh, snap, drag, r, c, x, y, _asp) => applyDistortCorner(mesh, snap, drag, r, c, x, y),
    edge:   (mesh, snap, drag, e, x, y, _asp) => applyDistortEdge(mesh, snap, drag, e, x, y),
  },
};
// （projectOnEnter 投影已删 v0.6.34：切模式不悄悄改 mesh——降自由度改为 canSetMode 记账制置灰。）
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
function applyBasisRotate(f: LiveMeta, d: Drag, x: number, y: number, rects: Rect[]) {
  const m = d.meshSnap;
  if (!isAffineQuad(m)) return;
  const cx = (m[0][0].x + m[0][1].x + m[1][0].x + m[1][1].x) / 4;
  const cy = (m[0][0].y + m[0][1].y + m[1][0].y + m[1][1].y) / 4;
  const a0 = Math.atan2(d.startY - cy, d.startX - cx);
  const a1 = Math.atan2(y - cy, x - cx);
  const cos = Math.cos(a1 - a0), sin = Math.sin(a1 - a0);
  // v0.6.23（user 真机："选区大小没有自动变化，你不是说外切吗"）：转轴后**重新求外接**——
  //   新 mesh = 内容（各 source destQuad 角点；display 映射在本操作下不变）在旋转基下的
  //   有向包围平行四边形；新 frame = 新 mesh 经 display 映射 D=H∘F⁻¹（仿射可逆）的原像。
  //   像素不动、框随角度呼吸、始终外接内容（45° 最大）。
  // 1) 内容角点（display 固定 = 用 SNAP frame/mesh 算）
  const pts: Point[] = [];
  if (rects.length) {
    for (const r of rects) {
      const q = sourceDestQuad(r, d.frameSnap, m);
      if (q) for (const row of q) for (const p of row) pts.push(p);
    }
  }
  if (!pts.length) for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) pts.push(m[i][j]);
  // 2) 旋转基（把 SNAP mesh 的两条边向量转 dθ；不平移）
  const e1 = { x: m[0][1].x - m[0][0].x, y: m[0][1].y - m[0][0].y };
  const e2 = { x: m[1][0].x - m[0][0].x, y: m[1][0].y - m[0][0].y };
  const r1 = { x: e1.x * cos - e1.y * sin, y: e1.x * sin + e1.y * cos };
  const r2 = { x: e2.x * cos - e2.y * sin, y: e2.x * sin + e2.y * cos };
  const det = r1.x * r2.y - r1.y * r2.x;
  if (Math.abs(det) < 1e-9) return;
  // 3) 内容在旋转基下的坐标范围（相对 SNAP 质心；基可非正交——平行四边形包络）
  let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
  for (const p of pts) {
    const rx = p.x - cx, ry = p.y - cy;
    const a = (rx * r2.y - ry * r2.x) / det;
    const b = (ry * r1.x - rx * r1.y) / det;
    if (a < amin) amin = a; if (a > amax) amax = a;
    if (b < bmin) bmin = b; if (b > bmax) bmax = b;
  }
  if (!(amax > amin) || !(bmax > bmin)) return;
  const at = (a: number, b: number): Point => ({ x: cx + a * r1.x + b * r2.x, y: cy + a * r1.y + b * r2.y });
  const tl2 = at(amin, bmin), tr2 = at(amax, bmin), bl2 = at(amin, bmax), br2 = at(amax, bmax);
  // 4) 新 frame = Dinv(新 mesh 角)。D：source→dest 仿射，由三对已知点定
  //    （F_snap 的 (0,0)/(1,0)/(0,1) 角 ↦ SNAP mesh 的 TL/TR/BL）；Dinv 反解。
  const fsn = d.frameSnap;
  const s0 = fsn.origin;
  const s1 = { x: fsn.origin.x + fsn.ux.x, y: fsn.origin.y + fsn.ux.y };
  const s2 = { x: fsn.origin.x + fsn.uy.x, y: fsn.origin.y + fsn.uy.y };
  const d1 = { x: m[0][1].x - m[0][0].x, y: m[0][1].y - m[0][0].y };   // = e1（dest 基）
  const d2 = { x: m[1][0].x - m[0][0].x, y: m[1][0].y - m[0][0].y };
  const dd = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(dd) < 1e-9) return;
  const Dinv = (p: Point): Point => {
    const rx = p.x - m[0][0].x, ry = p.y - m[0][0].y;
    const a = (rx * d2.y - ry * d2.x) / dd;
    const b = (ry * d1.x - rx * d1.y) / dd;
    return { x: s0.x + a * (s1.x - s0.x) + b * (s2.x - s0.x), y: s0.y + a * (s1.y - s0.y) + b * (s2.y - s0.y) };
  };
  f.mesh = [[tl2, tr2], [bl2, br2]];
  const o = Dinv(tl2), pu = Dinv(tr2), pv = Dinv(bl2);
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

// ============ 几何工具 ============
// （unionRects/bboxToQuad 已随 lift 内联进 lift() 编排——初始 gizmo/mesh 在令牌内产。）
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
// ---- 整数刚体判定（v0.6.34 90° 族置换快路）----
// destQuad 是否 = rect 的整数刚体像（整数平移 × 90° 倍数旋转 × 翻转，8 朝向）。
// 是 → 返回置换写回映射（commit/stamp 跳过 GPU 重采样，typed-array 逐字节）；否则 null。
// ε=0.05px：吸收转过又转回/翻转组合留下的浮点渣（视觉零差），拖出的真小数平移不入（走 warp）。
const RIGID_EPS = 0.05;
export function integerRigidOf(rect: Rect, dq: Mesh): RigidMap | null {
  const p00 = dq[0][0], p10 = dq[0][1], p01 = dq[1][0], p11 = dq[1][1];
  // 平行四边形（排除透视残留）
  if (Math.abs(p11.x - p10.x - p01.x + p00.x) > RIGID_EPS ||
      Math.abs(p11.y - p10.y - p01.y + p00.y) > RIGID_EPS) return null;
  const { w, h } = rect;
  const ux = p10.x - p00.x, uy = p10.y - p00.y;   // rect +x 边的像
  const vx = p01.x - p00.x, vy = p01.y - p00.y;   // rect +y 边的像
  // 角点在整数格上
  if (Math.abs(p00.x - Math.round(p00.x)) > RIGID_EPS || Math.abs(p00.y - Math.round(p00.y)) > RIGID_EPS) return null;
  const dx0 = Math.round(Math.min(p00.x, p10.x, p01.x, p11.x));
  const dy0 = Math.round(Math.min(p00.y, p10.y, p01.y, p11.y));
  if (Math.abs(uy) <= RIGID_EPS && Math.abs(vx) <= RIGID_EPS) {
    // 轴对齐（0°/180°/翻转族）：u 沿 x 长 w、v 沿 y 长 h
    if (Math.abs(Math.abs(ux) - w) > RIGID_EPS || Math.abs(Math.abs(vy) - h) > RIGID_EPS) return null;
    const su = ux > 0 ? 1 : -1, sv = vy > 0 ? 1 : -1;
    return {
      dx0, dy0, dw: w, dh: h,
      m11: su, m12: 0, s0x: su > 0 ? 0 : w - 1,
      m21: 0, m22: sv, s0y: sv > 0 ? 0 : h - 1,
    };
  }
  if (Math.abs(ux) <= RIGID_EPS && Math.abs(vy) <= RIGID_EPS) {
    // 四分之一转族（90°/270° × 翻转）：u 沿 y 长 w、v 沿 x 长 h → dest 尺寸 h×w
    if (Math.abs(Math.abs(uy) - w) > RIGID_EPS || Math.abs(Math.abs(vx) - h) > RIGID_EPS) return null;
    const su = uy > 0 ? 1 : -1, sv = vx > 0 ? 1 : -1;
    return {
      dx0, dy0, dw: h, dh: w,
      m11: 0, m12: su, s0x: su > 0 ? 0 : w - 1,
      m21: sv, m22: 0, s0y: sv > 0 ? 0 : h - 1,
    };
  }
  return null;
}

// destQuad 是否 = rect 的**纯整数平移**（含 identity；integerRigidOf 的朝向 0 无翻转特例）。
export function integerTranslationOf(rect: Rect, dq: Mesh): { x: number; y: number } | null {
  const m = integerRigidOf(rect, dq);
  if (!m || m.m11 !== 1 || m.m22 !== 1 || m.m12 !== 0 || m.m21 !== 0 || m.s0x !== 0 || m.s0y !== 0) return null;
  return { x: m.dx0 - rect.x, y: m.dy0 - rect.y };
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
