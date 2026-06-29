// 套索引擎 (v55 phase 1 + v56 phase 2)：
//
// phase 1：自由曲线选区 → lift floating canvas → 平移 → commit。
// phase 2：3 种变形模式 + gizmo（warp 已删——旧 4×4 实现是错数学屎山，待正确重加，见 ADR/CONTEXT「TransformMode」）
//   - free      (4 角，平行四边形约束 = 仿射 TRS，S 可非均匀)
//   - uniform   (同 free 但锁长宽比)
//   - distort   (4 角自由，一般四边形 / 透视)
//
// 数据模型：
//   floating = {
//     canvas, imageData,   // 源像素（不变；lift 时一次性烤好）
//     srcW, srcH,          // canvas 的像素尺寸
//     layer, preSnap,      // undo / cancel 用
//     mode,                // "free" | "uniform" | "distort"
//     meshN,               // 恒 = 2（2×2 四角网格）
//     mesh,                // [2][2] doc 坐标点；初始 = src bbox 对齐
//     uniformAspect,       // uniform 模式锁定的 W/H 比（lift 时记一次）
//   }
//
// 渲染：2×2 mesh 走 renderQuadPerPixel（per-pixel inverse homography + 双三次/双线性采样），
//   数学精确（无 PS1 三角化 artifact）。caller drawImage 渲染结果。
//
// 模式切换：保留当前 mesh 形状，只换约束。
//   free → uniform：不动 mesh，后续 drag 才有锁比约束
//   free → distort：mesh 仍是 2×2，distort 时给真正的透视
//
// 选区值 + mask 操作（compose/invert/outline/applyMaskPostStroke/fill/clear/crop）已搬到
// selection.js 的 Selection 类。lasso 只负责手势光栅化（产 Selection）+ 自由变换 gizmo。

import { Selection } from "./selection.ts";
import { makeBitmap } from "./bitmap.ts";
import { FloatingTransform } from "./floating-transform.ts";
import type { WarpBakeFn } from "./floating-transform.ts";
import type { Layer, LayerGroup } from "./doc.ts";

// ---- 本文件用到的最小局部类型（selection/doc/layer 的真类型在各自模块；此处只描述本类消费面）----
interface Point { x: number; y: number; }
interface DraftRect { x0: number; y0: number; x1: number; y1: number; }
// Selection 实例的消费面（bbox + maskCanvas；真类型在 selection.ts）
type SelectionLike = Selection;
// doc 的消费面：选区是 doc 的一等公民
interface LassoDoc {
  width: number;
  height: number;
  selection: SelectionLike | null;
}
type LassoNode = Layer | LayerGroup;
type LiftOpts = { cut?: boolean; fallbackFullLayer?: boolean };
type LassoState =
  | "idle"
  | "drawing-freehand"
  | "drawing-rect"
  | "drawing-ellipse"
  | "magic-tentative"
  | "floating";
type SubTool = "freehand" | "rect" | "ellipse" | "magic";
type SetOpMode = "new" | "union" | "subtract" | "intersect";

export class LassoEngine {
  _state: LassoState;
  _subTool: SubTool;
  _setOpMode: SetOpMode;
  _constrainSquare: boolean;
  _magicThreshold: number;
  _points: Point[];
  _rect: DraftRect | null;
  _magicStart: Point | null;
  _ft: FloatingTransform;
  doc: LassoDoc | null;
  onChange: () => void;

  constructor() {
    this._state = "idle";         // idle | drawing-freehand | drawing-rect | drawing-ellipse | floating
    this._subTool = "freehand";   // freehand | rect | ellipse | magic
    this._setOpMode = "new";      // new | union | subtract | intersect
    this._constrainSquare = false; // rect / ellipse 是否强制 1:1（正方形 / 圆）
    this._magicThreshold = 20;    // 0..100；魔术棒颜色相似度（魔术棒唯一参数）
    // v242：扩展/收缩从魔术棒拆走 → 改成「选区编辑 op」(Selection.morphed)，详 toolbar 选区编辑齿轮。
    //   魔术棒不再 bake 任何 expand（之前默认 +2 是错误——魔术棒就该是纯净的颜色 flood）。
    this._points = [];            // freehand draft
    this._rect = null;            // {x0, y0, x1, y1} during rect / ellipse draw
    this._magicStart = null;      // for magic-tap path
    // 自由变换浮层 = FloatingTransform 深模块。本类只管 lasso 状态机（_state）+ 选区构造，
    //   变换全委托 _ft；onChange 晚绑定（input.js 之后才赋 this.onChange）。
    this._ft = new FloatingTransform(() => this.onChange());
    this.doc = null;              // 由 input.js 注入；选区是 doc 的一等公民
    this.onChange = () => {};
  }
  setDoc(doc: LassoDoc | null) { this.doc = doc; }
  setSubTool(name: SubTool) {
    if (this._subTool === name) return;
    this._subTool = name;
    this._points = []; this._rect = null; this._magicStart = null;
    this._state = "idle";
    this.onChange();
  }
  getSubTool() { return this._subTool; }
  setSetOpMode(mode: SetOpMode) { this._setOpMode = mode; this.onChange(); }
  getSetOpMode() { return this._setOpMode; }
  setMagicThreshold(v: number) { this._magicThreshold = Math.max(0, Math.min(100, v)); }
  getMagicThreshold() { return this._magicThreshold; }
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
  endPath(sourceLayer: Layer | null) {
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
  // v125: 把 selection bbox 与 doc 矩形相交。完全在外 → null
  _clipSelectionToDoc(sel: SelectionLike | null): SelectionLike | null {
    if (!sel || !this.doc) return sel;
    const docW = this.doc.width, docH = this.doc.height;
    const x0 = Math.max(0, sel.bboxX);
    const y0 = Math.max(0, sel.bboxY);
    const x1 = Math.min(docW, sel.bboxX + sel.bboxW);
    const y1 = Math.min(docH, sel.bboxY + sel.bboxH);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    if (x0 === sel.bboxX && y0 === sel.bboxY && w === sel.bboxW && h === sel.bboxH) return sel;
    const c = makeBitmap(w, h);
    const cctx = c.getContext("2d")!;
    cctx.drawImage(sel.maskCanvas, sel.bboxX - x0, sel.bboxY - y0);
    return new Selection(x0, y0, w, h, c);
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
    this._state = "idle";
    this._points = []; this._rect = null; this._magicStart = null;
    this.onChange();
  }

  // 用 doc.selection 作 mask source，把对应 layer 像素 lift 到 floating。
  // 完成后进 floating 状态（transform 子状态）。
  // 默认进入 free 模式（不再走 v56 那种"selected sub-state"）
  // opts.cut: true(默认) = 挖空源层（Ctrl+T 变换）；false = 不挖洞，源层保留（Ctrl+D 复制为浮层）
  // opts.fallbackFullLayer: 没选区时用整层做隐式全选（v218；selection 局部构造，不写 doc.selection）
  liftSelectionForTransform(layer: LassoNode | null, opts: LiftOpts = {}) {
    const ok = this._ft.lift(this.doc?.selection as Selection | null, layer, opts);
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
    const x0 = Math.floor(minX), y0 = Math.floor(minY);
    const x1 = Math.ceil(maxX),  y1 = Math.ceil(maxY);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    const maskCanvas = makeBitmap(w, h);
    const mctx = maskCanvas.getContext("2d")!;
    mctx.fillStyle = "#fff";
    mctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i].x - x0;
      const py = pts[i].y - y0;
      if (i === 0) mctx.moveTo(px, py); else mctx.lineTo(px, py);
    }
    mctx.closePath();
    mctx.fill("evenodd");
    return new Selection(x0, y0, w, h, maskCanvas);
  }
  _rasterizeRectToSelection(r: DraftRect | null): SelectionLike | null {
    if (!r) return null;
    const x0 = Math.floor(Math.min(r.x0, r.x1));
    const y0 = Math.floor(Math.min(r.y0, r.y1));
    const x1 = Math.ceil(Math.max(r.x0, r.x1));
    const y1 = Math.ceil(Math.max(r.y0, r.y1));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    const maskCanvas = makeBitmap(w, h);
    const mctx = maskCanvas.getContext("2d")!;
    mctx.fillStyle = "#fff";
    mctx.fillRect(0, 0, w, h);
    return new Selection(x0, y0, w, h, maskCanvas);
  }
  _rasterizeEllipseToSelection(r: DraftRect | null): SelectionLike | null {
    if (!r) return null;
    const x0 = Math.floor(Math.min(r.x0, r.x1));
    const y0 = Math.floor(Math.min(r.y0, r.y1));
    const x1 = Math.ceil(Math.max(r.x0, r.x1));
    const y1 = Math.ceil(Math.max(r.y0, r.y1));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    const maskCanvas = makeBitmap(w, h);
    const mctx = maskCanvas.getContext("2d")!;
    mctx.fillStyle = "#fff";
    mctx.beginPath();
    mctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    mctx.fill();
    return new Selection(x0, y0, w, h, maskCanvas);
  }
  // 魔术棒：tap → flood fill 颜色差 ≤ threshold 的相邻像素入选。
  //
  // 经典 bug（v66 + v69 又犯）：iteration 局限在 layer.bbox 内 → 点空白只选到
  // bbox 矩形。修：迭代**整 doc 尺寸**，layer.bbox 外当 (0,0,0,0) 透明像素。
  //
  // 历史「容隙」功能 v71→v79 撤掉：barrier dilate N px 会盖住 user 的 tap 点
  // 让小区域整片不可点。详 docs/lessons-magic-wand-gap-closing.md。
  //
  // 内存（2048² doc）：layerData 16MB + visited buffer 4MB + maskCanvas
  // 仅 bbox 大小。barrier 不再单独 alloc（diff 算在 flood fill 里 inline）。
  _magicWandToSelection(start: Point | null, sourceLayer: Layer | null): SelectionLike | null {
    if (!start || !this.doc) return null;
    const docW = this.doc.width, docH = this.doc.height;
    const sx = Math.floor(start.x);
    const sy = Math.floor(start.y);
    if (sx < 0 || sx >= docW || sy < 0 || sy >= docH) return null;

    const lbX = sourceLayer?.bboxX ?? 0;
    const lbY = sourceLayer?.bboxY ?? 0;
    const lbW = sourceLayer?.bboxW ?? 0;
    const lbH = sourceLayer?.bboxH ?? 0;
    let layerData: Uint8ClampedArray | null = null;
    if (sourceLayer && lbW > 0 && lbH > 0) {
      layerData = sourceLayer.ctx.getImageData(0, 0, lbW, lbH).data;
    }
    // tap 点颜色（layer 外 → 透明）
    let sr = 0, sg = 0, sb = 0, sa = 0;
    if (layerData && sx >= lbX && sx < lbX + lbW && sy >= lbY && sy < lbY + lbH) {
      const idx = ((sy - lbY) * lbW + (sx - lbX)) * 4;
      sr = layerData[idx]; sg = layerData[idx + 1]; sb = layerData[idx + 2]; sa = layerData[idx + 3];
    }
    const tCh = this._magicThreshold * 2.55;
    const total = docW * docH;

    // 「layer 外」的 barrier 算一次：透明 (0,0,0,0) 跟 tap 色的 max-diff
    const outsideIsBarrier = Math.max(sr, sg, sb, sa) > tCh;
    // inline barrier 检查：返回 true = 是 barrier = flood 不能进
    const isBarrier = (p: number) => {
      const py = (p / docW) | 0;
      const px = p - py * docW;
      if (!layerData || px < lbX || px >= lbX + lbW || py < lbY || py >= lbY + lbH) {
        return outsideIsBarrier;
      }
      const i4 = ((py - lbY) * lbW + (px - lbX)) * 4;
      const dr = Math.abs(layerData[i4]     - sr);
      const dg = Math.abs(layerData[i4 + 1] - sg);
      const db = Math.abs(layerData[i4 + 2] - sb);
      const da = Math.abs(layerData[i4 + 3] - sa);
      return Math.max(dr, dg, db, da) > tCh;
    };

    // combined buffer：0 = 未访问；1 = 进入 mask；2 = 访问过但是 barrier
    // 比之前的 barrier + visited + mask 三个数组省 8MB
    const combined = new Uint8Array(total);
    const startIdx = sx + sy * docW;
    if (isBarrier(startIdx)) return null;

    const stack = [startIdx];
    let mnx = docW, mny = docH, mxx = -1, mxy = -1;
    while (stack.length) {
      const p = stack.pop()!;
      if (combined[p] !== 0) continue;
      if (isBarrier(p)) { combined[p] = 2; continue; }
      combined[p] = 1;
      const px = p % docW;
      const py = (p - px) / docW;
      if (px < mnx) mnx = px; if (px > mxx) mxx = px;
      if (py < mny) mny = py; if (py > mxy) mxy = py;
      if (px > 0        && combined[p - 1]    === 0) stack.push(p - 1);
      if (px < docW - 1 && combined[p + 1]    === 0) stack.push(p + 1);
      if (py > 0        && combined[p - docW] === 0) stack.push(p - docW);
      if (py < docH - 1 && combined[p + docW] === 0) stack.push(p + docW);
    }
    if (mxx < 0) return null;

    // v242：魔术棒只产生「贴着 AA 边缘半透明处停下」的原始选区，不再 bake 任何膨胀。
    //   白边修法 = 对选区跑「扩张」编辑 op（Selection.morphed），用户自己把控量。
    const tw = mxx - mnx + 1, th = mxy - mny + 1;
    const maskCanvas = makeBitmap(tw, th);
    const mctx = maskCanvas.getContext("2d")!;
    const out = mctx.createImageData(tw, th);
    const odata = out.data;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const accepted = combined[(mny + y) * docW + (mnx + x)] === 1;
      const o = (y * tw + x) * 4;
      odata[o] = 255; odata[o + 1] = 255; odata[o + 2] = 255;
      odata[o + 3] = accepted ? 255 : 0;
    }
    mctx.putImageData(out, 0, 0);
    return new Selection(mnx, mny, tw, th, maskCanvas);
  }
  // 把新 mask 按 setOpMode 合并进 doc.selection，返回 history entry
  _applySelectionUpdate(newSel: SelectionLike) {
    if (!this.doc) return null;
    const oldSel = this.doc.selection;
    const merged = Selection.compose(oldSel, newSel, this._setOpMode);
    if (oldSel === merged) { this.onChange(); return null; }
    this.doc.selection = merged;
    this.onChange();
    return { type: "selectionChange", before: oldSel, after: merged };
  }

  // -------- 模式切换 --------
  // ---- 自由变换：全委托 FloatingTransform 深模块（floating-transform.js / CONTEXT「浮层变换」）。
  //      本类只在 lift/commit/cancel 维护 lasso 状态机 _state；其余纯转发。----
  setMode(mode: Parameters<FloatingTransform["setMode"]>[0]) { this._ft.setMode(mode); }
  getMode() { return this._ft.getMode(); }
  hitTest(x: number, y: number, screenScale = 1) { return this._ft.hitTest(x, y, screenScale); }
  beginDrag(hit: Parameters<FloatingTransform["beginDrag"]>[0], x: number, y: number) { this._ft.beginDrag(hit, x, y); }
  extendDrag(x: number, y: number) { this._ft.extendDrag(x, y); }
  endDrag() { this._ft.endDrag(); }
  // GPU 烤定 fn 注入（app: () => board.glWarpBakeFn()）；commit/stamp 落层时 warp 走 GPU。lasso 仍 GL-blind。
  _warpBakeProvider: (() => WarpBakeFn | null) | null = null;
  setWarpBakeProvider(fn: (() => WarpBakeFn | null) | null) { this._warpBakeProvider = fn; }
  stamp() { return this._ft.stamp(this._warpBakeProvider?.() ?? null); }
  commit() {
    const wasActive = this._ft.isActive();
    const entry = this._ft.commit(this.doc, this._warpBakeProvider?.() ?? null);
    if (wasActive) this._state = "idle";
    return entry;
  }
  cancel() {
    const wasActive = this._ft.isActive();
    const snap = this._ft.cancel();
    if (wasActive) this._state = "idle";
    return snap;
  }

  // -------- 外部查询 --------
  hasFloating() { return this._ft.isActive(); }
  getDrawingPath() { return this._state === "drawing-freehand" ? this._points : null; }
  getDrawingRect() { return this._state === "drawing-rect" ? this._rect : null; }
  getDrawingEllipse() { return this._state === "drawing-ellipse" ? this._rect : null; }
  getFloating() { return this._ft.current(); }
  state() { return this._state; }
  getFloatingScreenBbox() { return this._ft.getFloatingScreenBbox(); }
  // 给 board overlay 用：当前可拖的 handle 列表（v117: screenScale 让 rotate handle 按屏幕 px 偏移定位）
  visibleHandles(screenScale = 1) { return this._ft.visibleHandles(screenScale); }
  // 渲染 floating 用 renderQuadPerPixel（在 floating-transform.js）。
}
