// 套索引擎 (v55 phase 1 + v56 phase 2)：
//
// phase 1：自由曲线选区 → lift floating canvas → 平移 → commit。
// phase 2：3 种变形模式 + gizmo（warp 已删——旧 4×4 实现是错数学屎山，待正确重加，见 ADR/CONTEXT「TransformMode」）
//   - free      (4 角，平行四边形约束 = 仿射 TRS，S 可非均匀)
//   - uniform   (同 free 但锁长宽比)
//   - distort   (4 角自由，一般四边形 / 透视)
//
// 数据模型（v0.4.7 S6）：float 像素 + transform metadata 在 **workpiece internals**
//   （workpiece/float-ops.ts）；本类经 FloatingTransform 编排 operator（lift/拖动整点/stamp/
//   accept/reject 全入 undo 栈），渲染视图 = _ft.current()（懒物化 canvas + live mesh）。
//
// 渲染：2×2 mesh → GPU warp（gl-compositor WARP_FRAG，per-pixel inverse homography + 双三次/双线性），
//   数学精确（无 PS1 三角化 artifact）。display/commit 全 GPU（board._glFloatInputs / glBoard.warpToCanvas）。
//
// 模式切换：保留当前 mesh 形状，只换约束。
//   free → uniform：不动 mesh，后续 drag 才有锁比约束
//   free → distort：mesh 仍是 2×2，distort 时给真正的透视
//
// 选区值 + mask 操作（compose/invert/outline/applyMaskPostStroke/fill/clear/crop）已搬到
// selection.js 的 Selection 类。lasso 只负责手势光栅化（产 Selection）+ 自由变换 gizmo。

import { Selection, rasterizePolygonGray8 } from "./backend/selection.ts";
import { FlatColoringOracle } from "./flat-coloring-oracle.ts";
import { floodRegionFrom, similarRegionFrom } from "./backend/algorithms/magic-wand.ts";
import type { ColorMetric } from "./common/color-dist.ts";
import { makeBitmap } from "./bitmap.ts";
import { FloatingTransform } from "./floating-transform.ts";
import type { WarpBakeFn } from "./floating-transform.ts";
import type { ViewLeaf, ViewGroup, PaintingView } from "./backend/workpiece/painting-view.ts";
import type { History } from "./backend/workpiece/history.ts";
import type { FloatLayerComponent } from "./backend/workpiece/float-component.ts";
import type { SelectionComponent } from "./backend/workpiece/selection-component.ts";
import { SelectionPreviewTx } from "./backend/workpiece/selection-component.ts";

// ---- 本文件用到的最小局部类型（selection/doc/layer 的真类型在各自模块；此处只描述本类消费面）----
interface Point { x: number; y: number; }
interface DraftRect { x0: number; y0: number; x1: number; y1: number; }
// Selection 实例的消费面（bbox + tile mask；真类型在 selection.ts。v0.4.6：maskCanvas 死，
// 光栅器出 gray8 tile Selection；中间产物消费后就地 dispose——所有权纪律见 selection.ts 头注释）
type SelectionLike = Selection;
// doc 的消费面：选区是 doc 的一等公民
interface LassoDoc {
  width: number;
  height: number;
  selection: SelectionLike | null;
}
type LassoNode = ViewLeaf | ViewGroup;
type LiftOpts = { cut?: boolean; fallbackFullLayer?: boolean; ignoreSelection?: boolean };
type LassoState =
  | "idle"
  | "drawing-freehand"
  | "drawing-rect"
  | "drawing-ellipse"
  | "magic-tentative"
  | "magic-drag"
  | "drawing-polygon"
  | "floating";
// v0.7.25 pen=选区笔（与魔棒平级，user 拍板）：手势生命周期在 input 侧走笔刷引擎（lasso 状态机零介入），
//   抬笔经 _applySelectionUpdate 回到本类的选区合成契约。老版本读到 "pen" → beginPath fallthrough 软坏不崩。
type SubTool = "freehand" | "rect" | "ellipse" | "polygon" | "magic" | "pen";
type SetOpMode = "new" | "union" | "subtract" | "intersect";
export type MagicAlgorithm = "classic" | "lineart" | "similar";
// 魔棒算法下拉的 SSoT（transform 采样 RESAMPLE_MODES 同款）：以后加算法（EDT-Dijkstra/AI）只改这里+引擎分叉
// v0.7.21 similar=全图同色（user 2026-07-30：「魔术棒但不选 continuous」，批量改色用——
//   选完直接走 fill 预览换色；容差独立持久化，度量默认 OKLab）
export const MAGIC_ALGORITHMS: { id: MagicAlgorithm; labelKey: string }[] = [
  { id: "classic", labelKey: "la.algoClassic" },
  { id: "lineart", labelKey: "la.lineartAlgo" },
  { id: "similar", labelKey: "la.algoSimilar" },
];

export class LassoEngine {
  _state: LassoState;
  _subTool: SubTool;
  _setOpMode: SetOpMode;
  _constrainSquare: boolean;
  _magicThreshold: number;
  _similarThreshold = 20;
  _colorMetric: ColorMetric = "oklab";
  _fillGapPx = 0;
  _magicAutoExpandPx: number;
  _magicAlgorithm: MagicAlgorithm = "classic";
  _flatColoringOracle = new FlatColoringOracle();
  _points: Point[];
  _rect: DraftRect | null;
  _magicStart: Point | null;
  _polyVerts: Point[];
  _polyPreview: Point | null;
  _ft: FloatingTransform;
  doc: LassoDoc | null;
  onChange: () => void;

  constructor() {
    this._state = "idle";         // idle | drawing-freehand | drawing-rect | drawing-ellipse | floating
    this._subTool = "freehand";   // freehand | rect | ellipse | magic
    this._setOpMode = "new";      // new | union | subtract | intersect
    this._constrainSquare = false; // rect / ellipse 是否强制 1:1（正方形 / 圆）
    this._magicThreshold = 20;    // 0..100；魔术棒颜色相似度
    // v242：扩展/收缩从魔术棒拆走 → 改成「选区编辑 op」(Selection.morphed)，详 toolbar 选区编辑齿轮。
    //   魔术棒不再 bake 任何 expand（之前默认 +2 是错误——魔术棒就该是纯净的颜色 flood）。
    // #31（v0.5，user 拍板）：重新提供**可选**的 flood 后自动扩张（toggle，默认 0=关，per-doc 配置由
    //   toolbar 从 desk 灌入）。与 v242 不冲突：默认仍是纯净 flood，手动「扩张…」op 保留。
    this._magicAutoExpandPx = 0;
    this._points = [];            // freehand draft
    this._rect = null;            // {x0, y0, x1, y1} during rect / ellipse draw
    this._magicStart = null;      // for magic-tap path
    // v0.6.19 多边形套索会话（跨多笔 transient）：顶点=会话级，段预览=笔级——
    //   cancelDrawing 只丢段（双指/掌触救回会话）；polygonCancelSession 才清顶点。
    this._polyVerts = [];
    this._polyPreview = null;
    // 自由变换浮层 = FloatingTransform 深模块。本类只管 lasso 状态机（_state）+ 选区构造，
    //   变换全委托 _ft；onChange 晚绑定（input.js 之后才赋 this.onChange）。
    this._ft = new FloatingTransform(() => this.onChange());
    this.doc = null;              // 由 input.js 注入；选区是 doc 的一等公民
    this.onChange = () => {};
  }
  setDoc(doc: LassoDoc | null) {
    this.doc = doc;
    this._flatColoringOracle.invalidate();   // 换文档释放 label map（16MB 级）；key 本身安全，这里纯腾内存
  }
  // v0.4.7（S6）：float 状态在 workpiece——lift/变换/stamp/accept/reject 全走 operator，接线在此注入。
  attachWorkpiece(doc: PaintingView, history: History, float: FloatLayerComponent, sel: SelectionComponent) { this._ft.attach(doc, history, float, sel); }
  // undo/redo 可能让浮层出现/消失（lift/drop 都在栈上）：把 _state 与 workpiece 对齐 + 引擎重采纳
  // transform metadata。app 侧 reconciler（transient-panels.syncFloatTransient）每次 histchange 后调。
  syncFloating() {
    this._ft.syncFromWorkpiece();
    const active = this._ft.isActive();
    if (active && this._state !== "floating") this._state = "floating";
    else if (!active && this._state === "floating") this._state = "idle";
    this.onChange();
  }
  setSubTool(name: SubTool) {
    if (this._subTool === name) return;
    this._subTool = name;
    this._points = []; this._rect = null; this._magicStart = null;
    this._polyVerts = []; this._polyPreview = null;   // 切子工具 = 会话级 abort
    this._state = "idle";
    this.onChange();
  }
  getSubTool() { return this._subTool; }
  setSetOpMode(mode: SetOpMode) { this._setOpMode = mode; this.onChange(); }
  getSetOpMode() { return this._setOpMode; }
  setMagicThreshold(v: number) { this._magicThreshold = Math.max(0, Math.min(100, v)); }
  getMagicThreshold() { return this._magicThreshold; }
  // v0.7.21 同色全图容差（与 classic 容差分开存：flood barrier 和全图纳入是两种手感，互调不打架）
  setSimilarThreshold(v: number) { this._similarThreshold = Math.max(0, Math.min(100, v)); }
  getSimilarThreshold() { return this._similarThreshold; }
  // v0.7.21 颜色度量（classic/similar 共用；lineart 不吃——它按亮度二值化）。默认 OKLab（user 拍板）。
  setColorMetric(m: ColorMetric) { this._colorMetric = m === "rgb" ? "rgb" : "oklab"; }
  getColorMetric(): ColorMetric { return this._colorMetric; }
  setMagicAutoExpand(px: number) { this._magicAutoExpandPx = Math.max(0, Math.min(100, Math.round(px) || 0)); }
  getMagicAutoExpand() { return this._magicAutoExpandPx; }
  // v0.7.24 容隙（classic 专属；lineart 自带论文闭合、similar 无连通）：0=关，>0=封宽<gapPx 的缺口
  setFillGap(px: number) { this._fillGapPx = Math.max(0, Math.min(32, Math.round(px) || 0)); }
  getFillGap() { return this._fillGapPx; }
  // 魔棒算法（v0.7 线稿填色）：classic=像素精确 flood；lineart=论文分区 oracle（断口自动闭合+填到线下）。
  //   交互完全同构，tap → Selection。v0.7.17 起 per-tool 持久化（desk.lassoTool/fillTool.algo，
  //   toolbar._pushSelToolToEngine 灌入；油漆桶默认 lineart、选区默认 classic，user 拍板）。
  setMagicAlgorithm(v: MagicAlgorithm) { this._magicAlgorithm = v === "lineart" || v === "similar" ? v : "classic"; }
  getMagicAlgorithm(): MagicAlgorithm { return this._magicAlgorithm; }
  /** 线稿分区缓存是否已就绪（首次 tap 前 UI 可提示「分析线稿中…」） */
  lineartReady(sourceLayer: ViewLeaf | null): boolean {
    return !this.doc || this._flatColoringOracle.isReady(this.doc, sourceLayer);
  }
  // 线稿算法 knob 透传（扳手弹出用；RAM-only，改了 oracle 自己丢缓存）
  setLineartCloseDist(px: number) { this._flatColoringOracle.setCloseDist(px); }
  getLineartCloseDist() { return this._flatColoringOracle.getCloseDist(); }
  setLineartInkThreshold(pct: number) { this._flatColoringOracle.setInkThreshold(pct); }
  getLineartInkThreshold() { return this._flatColoringOracle.getInkThreshold(); }
  /** 稠密源提示透传（一次性消费；input.ts 在魔棒收笔点 flush 到状态栏）。 */
  takeLineartDenseSourceHint() { return this._flatColoringOracle.takeDenseSourceHint(); }
  setLineartMinRegion(px: number) { this._flatColoringOracle.setMinRegion(px); }
  getLineartMinRegion() { return this._flatColoringOracle.getMinRegion(); }
  setLineartTipSensitivity(pct: number) { this._flatColoringOracle.setTipSensitivity(pct); }
  getLineartTipSensitivity() { return this._flatColoringOracle.getTipSensitivity(); }
  setLineartBleed(px: number) { this._flatColoringOracle.setBleed(px); }
  getLineartBleed() { return this._flatColoringOracle.getBleed(); }
  // 调试视图（v0.7.4）：端点+候选桥 overlay。开着且分区已缓存才有数据（渲染路径绝不触发重建）。
  _lineartDebugView = false;
  setLineartDebugView(on: unknown) { this._lineartDebugView = !!on; }
  getLineartDebugView() { return this._lineartDebugView; }
  lineartDebugInfo(sourceLayer: ViewLeaf | null) {
    if (!this._lineartDebugView || this._magicAlgorithm !== "lineart" || !this.doc) return null;
    return this._flatColoringOracle.debugInfo(this.doc, sourceLayer);
  }
  setSampleMode(m: string) { this._ft.setSampleMode(m); }
  getSampleMode() { return this._ft.getSampleMode(); }
  setConstrainSquare(on: unknown) { this._constrainSquare = !!on; this.onChange(); }
  getConstrainSquare() { return this._constrainSquare; }

  // -------- 选区路径（按 subTool 路由）--------
  beginPath(x: number, y: number) {
    if (this._ft.isActive()) return;   // transform 期间不能再画
    if (this._subTool === "freehand") {
      this._state = "drawing-freehand";
      this._points = [{ x, y }];
    } else if (this._subTool === "rect") {
      this._state = "drawing-rect";
      this._rect = { x0: x, y0: y, x1: x, y1: y };
    } else if (this._subTool === "ellipse") {
      this._state = "drawing-ellipse";
      this._rect = { x0: x, y0: y, x1: x, y1: y };
    } else if (this._subTool === "polygon") {
      // 多边形：本 down 只开段预览；顶点在 up 落（input._polygonUp）。会话跨多笔存活。
      this._state = "drawing-polygon";
      this._polyPreview = { x, y };
    } else if (this._subTool === "magic") {
      // 单击：不进 drawing 状态；input.js 的 _endLasso 看 magicStart 做 flood fill
      this._state = "magic-tentative";
      this._magicStart = { x, y };
    }
    this.onChange();
  }
  extendPath(x: number, y: number) {
    if (this._state === "drawing-freehand") {
      const p = this._points[this._points.length - 1];
      if (p && Math.abs(p.x - x) < 1 && Math.abs(p.y - y) < 1) return;
      this._points.push({ x, y });
      this.onChange();
    } else if (this._state === "drawing-polygon") {
      this._polyPreview = { x, y };
      this.onChange();
    } else if (this._state === "drawing-rect" || this._state === "drawing-ellipse") {
      let nx = x, ny = y;
      // 正方 / 圆 约束：让 (x1-x0) 和 (y1-y0) 绝对值相等（取较大者）
      if (this._constrainSquare) {
        const dx = x - this._rect!.x0, dy = y - this._rect!.y0;
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        nx = this._rect!.x0 + (dx >= 0 ? m : -m);
        ny = this._rect!.y0 + (dy >= 0 ? m : -m);
      }
      this._rect!.x1 = nx;
      this._rect!.y1 = ny;
      this.onChange();
    }
  }
  // 收笔：rasterize → combine with doc.selection per setOpMode → 更新 doc.selection
  // 返回 history entry（caller push）或 null（选区无效 / 没动）
  // v125 (user：「lasso 全在外面时行为奇怪，应该自动清掉在外面，然后判断没选中任何」)
  //   rasterize 出 newSel 后先 clip 到 doc 边界。完全在外 → 返 null
  endPath(sourceLayer: ViewLeaf | null) {
    if (this._state === "drawing-polygon") return null;   // polygon 走 polygonAddVertex/polygonClose，不在此收笔
    let newSel = null;
    if (this._state === "drawing-freehand") {
      newSel = this._rasterizeFreehandToSelection(this._points);
      this._points = [];
    } else if (this._state === "drawing-rect") {
      newSel = this._rasterizeRectToSelection(this._rect);
      this._rect = null;
    } else if (this._state === "drawing-ellipse") {
      newSel = this._rasterizeEllipseToSelection(this._rect);
      this._rect = null;
    } else if (this._state === "magic-tentative") {
      newSel = this._magicWandToSelection(this._magicStart, sourceLayer);
      this._magicStart = null;
    }
    this._state = "idle";
    newSel = this._clipSelectionToDoc(newSel);   // v125
    if (!newSel) { this.onChange(); return null; }
    return this._applySelectionUpdate(newSel);
  }
  // v125: 把 selection 裁到 doc 矩形内。完全在外 → null。
  // v0.4.6：走 Selection.croppedTo（tile 级）；产生新对象时旧的就地 dispose（中间产物无人接手）。
  _clipSelectionToDoc(sel: SelectionLike | null): SelectionLike | null {
    if (!sel || !this.doc) return sel;
    const docW = this.doc.width, docH = this.doc.height;
    if (sel.bboxX >= 0 && sel.bboxY >= 0 && sel.bboxX + sel.bboxW <= docW && sel.bboxY + sel.bboxH <= docH) return sel;
    const clipped = sel.croppedTo(0, 0, docW, docH);
    if (clipped !== sel) sel.dispose();
    return clipped;
  }
  // 编程入口（取消选区 / 反选 / 由 history undo 调用恢复）
  setSelection(sel: SelectionLike | null) {
    if (!this.doc) return null;
    const oldSel = this.doc.selection;
    if (oldSel === sel) return null;
    this.doc.selection = sel;
    this.onChange();
    return { type: "selectionChange", before: oldSel, after: sel };
  }
  hasSelection() { return !!this.doc?.selection; }
  getSelection() { return this.doc?.selection || null; }
  cancelDrawing() {
    if (this._state === "magic-drag") { this.magicDragCancel(); return; }   // v0.7：drag 会话无痕还原
    if (this._subTool === "polygon") {
      // 笔级 abort（双指手势/掌触 purge/pointercancel）：只丢当前段预览，顶点会话保留——
      //   画到第 7 个顶点被误触双指清空 = 灾难（abortStroke ≠ abortSession）。
      this._polyPreview = null;
      if (!this._polyVerts.length) this._state = "idle";
      this.onChange();
      return;
    }
    this._state = "idle";
    this._points = []; this._rect = null; this._magicStart = null;
    this.onChange();
  }

  // ---- 多边形套索会话（v0.6.19）----
  polygonAddVertex(x: number, y: number) {
    const v = { x: Math.round(x), y: Math.round(y) };   // 顶点锁整数格点（锁像素格点边缘）
    const last = this._polyVerts[this._polyVerts.length - 1];
    if (!last || last.x !== v.x || last.y !== v.y) this._polyVerts.push(v);
    this._state = "drawing-polygon";
    this._polyPreview = null;
    this.onChange();
  }
  polygonVertexCount() { return this._polyVerts.length; }
  // v0.6.25 hover 跟随（桌面鼠标/悬停笔）：会话活着时段预览跟光标走（无按下）
  polygonHover(x: number, y: number) {
    if (!this.polygonSessionActive()) return;
    this._state = "drawing-polygon";
    this._polyPreview = { x, y };
    this.onChange();
  }
  polygonFirstVertex(): Point | null { return this._polyVerts[0] ?? null; }
  polygonSessionActive() { return this._subTool === "polygon" && this._polyVerts.length > 0; }
  // 闭合：栅格化（整数扫描线，无 AA）→ setOp 合并。<3 顶点/零面积/全在画布外 → null（会话已清）。
  polygonClose() {
    const verts = this._polyVerts;
    this._polyVerts = []; this._polyPreview = null; this._state = "idle";
    if (verts.length < 3) { this.onChange(); return null; }
    const r = rasterizePolygonGray8(verts);
    let newSel: SelectionLike | null = r ? Selection.fromGray8Region(r.x0, r.y0, r.w, r.h, r.g) : null;
    newSel = this._clipSelectionToDoc(newSel);
    if (!newSel) { this.onChange(); return null; }
    return this._applySelectionUpdate(newSel);
  }
  // 会话级 abort（Esc / 切工具 / 换文档）。
  polygonCancelSession() {
    if (!this._polyVerts.length && !this._polyPreview) return;
    this._polyVerts = []; this._polyPreview = null;
    if (this._state === "drawing-polygon") this._state = "idle";
    this.onChange();
  }

  // 用 doc.selection 作 mask source，把对应 layer 像素 lift 到 floating（lift 令牌整点：
  // 清选区 + 建 float tiles + 挖洞，可撤销）。完成后进 floating 状态（transform 子状态）。
  // opts.cut: true(默认) = 挖空源层（Ctrl+T 变换）；false = 不挖洞，源层保留（Ctrl+D 复制为浮层）
  // opts.fallbackFullLayer: 没选区时用整层做隐式全选（v218；operator 内部构造，不写 doc.selection）
  liftSelectionForTransform(layer: LassoNode | null, opts: LiftOpts = {}) {
    const ok = this._ft.lift(layer, opts);
    if (ok) this._state = "floating";
    return ok;
  }

  // 字节直接 lift 成浮层（导入「保持原尺寸」；rect 可越出画布 —— 经图层落地会被 doc 边界吃掉）。
  // layer 应为刚建的空层；同 lift 一个令牌整点。详 FloatingTransform.liftFromBytes。
  liftFloatFromBytes(layer: LassoNode | null, bytes: Uint8ClampedArray, rect: { x: number; y: number; w: number; h: number }) {
    const leaf = layer && !layer.isGroup ? layer as ViewLeaf : null;   // 组不接（浮层源必须是叶）
    const ok = this._ft.liftFromBytes(leaf, bytes, rect);
    if (ok) this._state = "floating";
    return ok;
  }

  // ---- rasterize helpers（返回 selection-shaped object 或 null）----
  _rasterizeFreehandToSelection(pts: Point[]): SelectionLike | null {
    if (pts.length < 3) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    // v0.6.43（user 拍板：选区全家二值，羽化=以后的后处理）：自由套索改走 rasterizePolygonGray8
    //   （像素中心 even-odd，0/255 硬边——与多边形套索/魔棒/蚂蚁线同一判据族；顺手消 canvas 光栅）。
    const r = rasterizePolygonGray8(pts);
    if (!r) return null;
    return Selection.fromGray8Region(r.x0, r.y0, r.w, r.h, r.g);
  }
  _rasterizeRectToSelection(r: DraftRect | null): SelectionLike | null {
    if (!r) return null;
    const x0 = Math.floor(Math.min(r.x0, r.x1));
    const y0 = Math.floor(Math.min(r.y0, r.y1));
    const x1 = Math.ceil(Math.max(r.x0, r.x1));
    const y1 = Math.ceil(Math.max(r.y0, r.y1));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    return Selection.full(w, h, x0, y0);   // 整数硬边矩形：直接全 255（旧 fillRect 同语义，省 canvas）
  }
  _rasterizeEllipseToSelection(r: DraftRect | null): SelectionLike | null {
    if (!r) return null;
    const x0 = Math.floor(Math.min(r.x0, r.x1));
    const y0 = Math.floor(Math.min(r.y0, r.y1));
    const x1 = Math.ceil(Math.max(r.x0, r.x1));
    const y1 = Math.ceil(Math.max(r.y0, r.y1));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    // v0.6.43 二值椭圆：像素中心在椭圆内 → 255（解析判据，消 canvas AA 光栅）
    const g = new Uint8Array(w * h);
    const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
    let any = false;
    for (let py = 0; py < h; py++) {
      const dy = (py + 0.5 - cy) / ry;
      for (let px = 0; px < w; px++) {
        const dx = (px + 0.5 - cx) / rx;
        if (dx * dx + dy * dy <= 1) { g[py * w + px] = 255; any = true; }
      }
    }
    if (!any) return null;
    return Selection.fromGray8Region(x0, y0, w, h, g);
  }
  // 魔术棒：tap → flood fill 颜色差 ≤ threshold 的相邻像素入选。
  //
  // 经典 bug（v66 + v69 又犯）：iteration 局限在 layer.bbox 内 → 点空白只选到
  // bbox 矩形。修：迭代**整 doc 尺寸**，layer.bbox 外当 (0,0,0,0) 透明像素。
  //
  // 历史「容隙」功能 v71→v79 撤掉：barrier dilate N px 会盖住 user 的 tap 点
  // 让小区域整片不可点。详 ai-docs/20260528-lessons-magic-wand-gap-closing.md。
  //
  // 内存（2048² doc）：layerData 16MB + visited buffer 4MB + maskCanvas
  // 仅 bbox 大小。barrier 不再单独 alloc（diff 算在 flood fill 里 inline）。
  _magicWandToSelection(start: Point | null, sourceLayer: ViewLeaf | null): SelectionLike | null {
    if (!this.doc) return null;
    // v0.7 线稿模式：tap → 分区 label 查表（缓存 miss 时同步构建，见 flat-coloring-oracle.ts）。
    //   与 flood 完全同构：产原始选区，后续 auto-expand / setOp 合并共用同一条路。
    // v0.7.23（user 2026-07-30）：classic + union 模式下**已选区当墙**——先套索糊一条「临时线」
    //   或先圈邻区，flood 撞选区即停（前线稿时代的缺线止痛；lineart 分区预计算不吃选区、similar
    //   无连通概念，都不参与）。drag 中 doc.selection=orig+accum 预览 → 本笔已选也顺势成墙，语义一致。
    const stopMask = this._magicAlgorithm === "classic" && this._setOpMode === "union" && this.doc.selection
      ? this.doc.selection.bboxMask()
      : null;
    let sel: SelectionLike | null = this._magicAlgorithm === "lineart" && start
      ? this._flatColoringOracle.selectAt(this.doc, sourceLayer, start.x, start.y)
      : this._magicAlgorithm === "similar"
        ? similarSelectFrom(this.doc, start, sourceLayer, this._similarThreshold, this._colorMetric)
        : floodSelectFrom(this.doc, start, sourceLayer, this._magicThreshold, this._colorMetric, stopMask, this._fillGapPx);
    // #31：可选 flood 后自动扩张（默认关）。在 setOp 合并**之前**做，語义 = 「这一下点出来的区域」本身变胖。
    // v0.7.8：auto-expand 收窄为 classic flood 的子管线 param——线稿分区自带墨线下扩语义，
    // 再叠形态学扩张是双重补偿（UI 侧线稿算法时也藏扩张钮）。
    // v0.7.21：similar 也吃 auto-expand——全图同色选完扩 1px 可盖住 AA 白边再填（穷人版防 halo）。
    if (sel && this._magicAutoExpandPx > 0 && this._magicAlgorithm !== "lineart") {
      const m = sel.morphed(this._magicAutoExpandPx, this.doc.width, this.doc.height);
      if (m) { sel.dispose(); sel = m; }
    }
    return sel;
  }
  // （flood 内核本体在文件尾 floodSelectFrom——#22 提取为模块级纯函数）

  // ---- 魔棒 drag 连续选（v0.7 UX：按住拖动沿路径把扫过的区域逐个并进来，一笔=一条 undo）----
  // 会话态（C6 户3，census §6.3 路 a）：预览托管 = SelectionPreviewTx（origin 保管/换手 dispose/
  //   commit·abort 收口全走 vetted 深模块，旧手搓托管退役）。预览仍住 selection substrate
  //   （_rawWrite 声明态经 doc 端口适配）——stopMask「本笔已选也成墙」/蚂蚁线/fill 预览读面语义
  //   不变。_magicAccum = 本笔各查询区域的 union（引擎自持物）。预览 = compose(origin, accum,
  //   setOp) → tx.write；end = tx.commit 产 entry（记账在 input._pushSelEntry），cancel = tx.abort。
  //   省钱关键：采样点已被 accum 盖住 → 跳过查询（拖动大多数点落在刚选完的区域里）。
  _magicTx: SelectionPreviewTx | null = null;
  _magicAccum: SelectionLike | null = null;
  _magicDragLastX = -1;
  _magicDragLastY = -1;

  beginMagicDrag() {
    if (!this.doc) return;
    const doc = this.doc;
    this._magicTx = new SelectionPreviewTx({ view: () => doc.selection, _rawWrite: (v) => { doc.selection = v; } });
    this._magicAccum = null;
    this._magicDragLastX = this._magicDragLastY = -1;
    this._state = "magic-drag";
  }
  /** 采样一点；选区真变了返回 true（调用方重绘）。 */
  magicDragStep(x: number, y: number, sourceLayer: ViewLeaf | null): boolean {
    if (!this.doc || this._state !== "magic-drag") return false;
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi === this._magicDragLastX && yi === this._magicDragLastY) return false;
    this._magicDragLastX = xi; this._magicDragLastY = yi;
    if (this._magicAccum && this._magicAccum.sampleAt(xi, yi) > 0) return false;
    const q = this._magicWandToSelection({ x, y }, sourceLayer);
    if (!q) return false;
    const merged = this._magicAccum ? Selection.compose(this._magicAccum, q, "union") : q;
    if (merged !== q) q.dispose();
    if (this._magicAccum && merged !== this._magicAccum) this._magicAccum.dispose();
    this._magicAccum = merged as SelectionLike;
    // compose 不消费输入 → 喂 accum 的 clone，防 "new" 模式返回同一对象造成双所有权
    //   （accum 归引擎、substrate 侧归 tx 托管，各自 dispose 不打架）。
    const tx = this._magicTx!;
    const accumView = this._magicAccum.clone();
    const preview = Selection.compose(tx.origin(), accumView, this._setOpMode);
    if (preview !== accumView) accumView.dispose();
    tx.write(preview);   // 上一个预览产物由 tx 就地 dispose（origin 除外）
    this.onChange();
    return true;
  }
  /** 收笔：产单条 history entry（before 所有权随 entry 交给 SelectionComponent 记账，同 _applySelectionUpdate 契约）。 */
  magicDragEnd() {
    if (!this.doc || this._state !== "magic-drag") return null;
    const tx = this._magicTx!;
    this._magicTx = null;
    this._magicAccum?.dispose(); this._magicAccum = null;
    this._state = "idle";
    const r = tx.commit();   // 净变化为零 → changed:false（不产 entry 不占步）
    this.onChange();
    if (!r.changed) return null;
    return { type: "selectionChange", before: r.before, after: this.doc.selection };
  }
  /** 中断（双指手势/pointercancel/出错）：tx.abort 无痕还原起笔选区，预览产物就地 dispose。 */
  magicDragCancel() {
    if (this._state !== "magic-drag") return;
    this._magicTx?.abort();
    this._magicTx = null;
    this._magicAccum?.dispose(); this._magicAccum = null;
    this._state = "idle";
    this.onChange();
  }

  // 把新 mask 按 setOpMode 合并进 doc.selection，返回 history entry
  _applySelectionUpdate(newSel: SelectionLike) {
    if (!this.doc) return null;
    const oldSel = this.doc.selection;
    const merged = Selection.compose(oldSel, newSel, this._setOpMode);
    if (merged !== newSel) newSel.dispose();   // v0.4.6：union/subtract/intersect 只读消费 newSel → 就地释放
    if (oldSel === merged) { this.onChange(); return null; }
    this.doc.selection = merged;
    this.onChange();
    return { type: "selectionChange", before: oldSel, after: merged };
    // before(=oldSel) 所有权随 entry 交给 SelectionComponent（input._pushSelEntry）；merged 归 doc.selection。
  }

  // -------- 模式切换 --------
  // ---- 自由变换：全委托 FloatingTransform 深模块（floating-transform.js / CONTEXT「浮层变换」）。
  //      本类只在 lift/commit/cancel 维护 lasso 状态机 _state；其余纯转发。----
  setMode(mode: Parameters<FloatingTransform["setMode"]>[0]) { this._ft.setMode(mode); }
  getMode() { return this._ft.getMode(); }
  canSetMode(mode: Parameters<FloatingTransform["setMode"]>[0]) { return this._ft.canSetMode(mode); }
  // #12：浮层整体 水平翻转 / 逆时针 90° / 方向键像素微调（facade 纯转发）
  flipFloatHorizontal() { this._ft.flipHorizontal(); }
  rotateFloat90() { this._ft.rotate90CCW(); }
  nudgeFloat(dx: number, dy: number) { this._ft.nudge(dx, dy); }
  resetFloatTransform() { return this._ft.resetToCenterOriginal(); }
  hitTest(x: number, y: number, screenScale = 1) { return this._ft.hitTest(x, y, screenScale); }
  beginDrag(hit: Parameters<FloatingTransform["beginDrag"]>[0], x: number, y: number) { this._ft.beginDrag(hit, x, y); }
  extendDrag(x: number, y: number) { this._ft.extendDrag(x, y); }
  endDrag() { this._ft.endDrag(); }
  // GPU 烤定 fn 注入（app: () => board.glWarpBakeFn()）；commit/stamp 落层时 warp 走 GPU。lasso 仍 GL-blind。
  _warpBakeProvider: (() => WarpBakeFn | null) | null = null;
  setWarpBakeProvider(fn: (() => WarpBakeFn | null) | null) { this._warpBakeProvider = fn; }
  stamp() { return this._ft.stamp(this._warpBakeProvider?.() ?? null); }
  // v0.9.28 只读烤制（Ctrl+C 复制浮层）：当前浮层烤成透明底字节（doc 坐标 rect），零副作用
  //   （不落层不进栈）。非刚体且 GL 不可用 → null（调用方明确 toast）。
  renderFloatingBytes() { return this._ft.bakeStandalone(this._warpBakeProvider?.() ?? null); }
  // accept：烤层 + 收摊浮层，一个 compound 整点（operator 编排全在 FloatingTransform；
  //   旧「手拼 entry → input 再 push」链 v0.4.7 死）。返回是否真提交了。
  commit(): boolean {
    const wasActive = this._ft.isActive();
    const ok = this._ft.commit(this._warpBakeProvider?.() ?? null);
    if (wasActive) this._state = "idle";
    return ok;
  }
  // reject：identity 写回 operator（非 undo；stamp 保留）。返回是否真回滚了。
  cancel(): boolean {
    const wasActive = this._ft.isActive();
    const ok = this._ft.cancel();
    if (wasActive) this._state = "idle";
    return ok;
  }

  // -------- 外部查询 --------
  hasFloating() { return this._ft.isActive(); }
  getDrawingPath() {
    if (this._state === "drawing-freehand") return this._points;
    if (this._state === "drawing-polygon") {
      const pts = this._polyVerts.slice();
      if (this._polyPreview) pts.push(this._polyPreview);
      return pts.length >= 2 ? pts : null;   // 单点画不出线
    }
    return null;
  }
  getDrawingRect() { return this._state === "drawing-rect" ? this._rect : null; }
  getDrawingEllipse() { return this._state === "drawing-ellipse" ? this._rect : null; }
  getFloating() { return this._ft.current(); }
  state() { return this._state; }
  getFloatingScreenBbox() { return this._ft.getFloatingScreenBbox(); }
  // 给 board overlay 用：当前可拖的 handle 列表（v117: screenScale 让 rotate handle 按屏幕 px 偏移定位）
  visibleHandles(screenScale = 1) { return this._ft.visibleHandles(screenScale); }
  // 渲染 floating：GPU warp（board._glFloatInputs→gl-compositor _floatPass）。
}

// ---- 魔棒/同色出口（C3：算法内核析出 backend/algorithms/magic-wand.ts，本处只做 Selection 包装）----
// 行为锚：两出口签名与 v242 起历史语义不变（test/flood-select、test/similar-select 从这里进）。
// 内核零 Selection/UI 知识（窄 I/O：像素平面进 → gray8 region 出）；ViewLeaf 结构兼容内核的
// WandSourceLayer 最小面（bboxX/Y/W/H + getImageData tiles 直读）。
export type { FloodStopMask } from "./backend/algorithms/magic-wand.ts";

export function floodSelectFrom(
  doc: { width: number; height: number },
  start: Point | null,
  sourceLayer: ViewLeaf | null,
  thresholdPct: number,
  metric: ColorMetric = "rgb",
  stopMask: import("./backend/algorithms/magic-wand.ts").FloodStopMask | null = null,
  gapPx = 0,
): Selection | null {
  const r = floodRegionFrom(doc, start, sourceLayer, thresholdPct, metric, stopMask, gapPx);
  return r ? Selection.fromGray8Region(r.x, r.y, r.w, r.h, r.gray8) : null;
}

export function similarSelectFrom(
  doc: { width: number; height: number },
  start: Point | null,
  sourceLayer: ViewLeaf | null,
  thresholdPct: number,
  metric: ColorMetric = "rgb",
): Selection | null {
  const r = similarRegionFrom(doc, start, sourceLayer, thresholdPct, metric);
  return r ? Selection.fromGray8Region(r.x, r.y, r.w, r.h, r.gray8) : null;
}

