// 浮层变换（Float / FloatingTransform）深模块。见 CONTEXT「浮层变换」。
//
// 选区像素被「抬起 → 自由变换（move/scale/rotate/perspective）→ 落回」的瞬态。
// 2026-06-19 从 lasso.js 抽出：lasso.js 只产 Selection + 经 LassoEngine facade 驱动本模块；
// input.js / board.js / app.js 不直接 import 本模块，全走 LassoEngine（接缝不变）。
//
// 变形模式 = adapter（MODES）：free / uniform / distort 各定 meshN、是否露 rotate handle、
//   corner/edge 约束数学、切入本模式时的 mesh 投影。free/uniform 共用一份平行四边形 solve
//   （uniform 多一步锁比），distort 自走简单分支。warp 已删（旧 4×4 是错数学）——以后
//   用正确数学回来时，就是第 4 个 adapter（带自己的 meshN/handles/约束/render），不是 god-method 里的分支。
//
// 渲染：2×2 mesh 走 renderQuadPerPixel（per-pixel inverse homography + 双三次/双线性采样）。
//   math-exact，无 PS1 三角化 artifact。caller drawImage 渲染结果（board export 在文件末）。

import { Selection } from "./selection.ts";
import { makeBitmap } from "./bitmap.ts";
import { eachLeaf } from "./doc.ts";
import type { Layer, LayerGroup } from "./doc.ts";

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

// 一个浮层源：未 warp 的 lift 像素（canvas/imageData，trim 到 selection bbox）+ 落回它哪个 layer。
//   display/commit 的 warp 全走 GPU（board._glFloatInputs→_floatPass / glBoard.warpToCanvas），无 CPU render 缓存。
interface Source {
  layer: Layer;
  canvas: Bitmap;
  imageData: ImageData;
  rect: Rect;
  preSnap: ReturnType<Layer["snapshot"]>;
}

interface Floating {
  sources: Source[];
  gizmoBbox: Rect;
  mode: TransformModeKind | null;
  meshN: number;
  mesh: Mesh;
  uniformAspect: number;
}

type TransformModeKind = "free" | "uniform" | "distort";

interface Hit {
  kind: "translate" | "corner" | "edge" | "rotate";
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
}

interface LiftOpts { fallbackFullLayer?: boolean; cut?: boolean; }

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

interface DocLike { selection: unknown; }

export class FloatingTransform {
  _floating: Floating | null;
  _drag: Drag | null;
  _sampleMode: SampleMode;
  onChange: () => void;

  // onChange 晚绑定（LassoEngine 构造时传 () => this.onChange()，因为 input.js 之后才赋 onChange）。
  constructor(onChange: () => void = () => {}) {
    this._floating = null;
    this._drag = null;
    this._sampleMode = "bicubic";   // nearest | bilinear | bicubic（transform 重采样质量；v125 默认双三次）
    this.onChange = onChange;
  }

  setSampleMode(m: string) {
    if (m === "nearest" || m === "bilinear" || m === "bicubic") {
      this._sampleMode = m;
      if (this._floating) this.onChange();   // GPU 每帧按 mode 重 warp，无 CPU 缓存可清
    }
  }
  getSampleMode() { return this._sampleMode; }

  isActive() { return !!this._floating; }
  current() { return this._floating; }

  // 把 active 节点 lift 成浮层。leaf → 单 source；group → **组内所有叶子(含隐藏)各一 source**
  //   共享一个 gizmo（CONTEXT「浮层变换」：整组一起动；隐藏随组移动、不参与定框）。进 free 模式。
  // selection 为 null 且 opts.fallbackFullLayer → 隐式全选（leaf=整层；group=每叶整层）。
  // opts.cut: true(默认) = 挖空源层（Ctrl+T）；false = 不挖洞（Ctrl+D 复制为浮层）。
  // 返回 bool（false = 没东西可变换）。
  lift(selection: Selection | null, node: Node | null, opts: LiftOpts = {}) {
    if (this._floating) return false;
    const sources = node && node.isGroup
      ? this._liftGroupSources(selection, node, opts)
      : this._liftLeafSources(selection, node, opts);
    if (!sources.length) return false;
    // gizmo 包围盒 = **可见** source rect 的并集（= 组可见 composite 的 content bbox：composite content
    //   就是各叶 content 的并；隐藏叶不参与定框但随组变换）。全隐藏兜底 = 全部 source。
    const vis = sources.filter((s) => s.layer.visible);
    const gizmoBbox = unionRects((vis.length ? vis : sources).map((s) => s.rect));
    this._floating = {
      sources,
      gizmoBbox,
      mode: "free",
      meshN: 2,
      mesh: bboxToQuad(gizmoBbox),
      uniformAspect: gizmoBbox.w / Math.max(1, gizmoBbox.h),
    };
    this.onChange();
    return true;
  }

  _liftLeafSources(selection: Selection | null, layer: Layer | null, opts: LiftOpts): Source[] {
    let sel = selection;
    if (!sel && opts.fallbackFullLayer && layer && layer.bboxW > 0 && layer.bboxH > 0) {
      sel = Selection.full(layer.bboxW, layer.bboxH, layer.bboxX, layer.bboxY);
    }
    if (!sel || !layer) return [];
    const src = bakeSource(sel, layer, opts);
    return src ? [src] : [];
  }

  _liftGroupSources(selection: Selection | null, group: LayerGroup, opts: LiftOpts): Source[] {
    const leaves: Layer[] = [];
    eachLeaf(group.children, (L) => leaves.push(L));   // 含隐藏叶（整组一起动）
    const sources = [];
    for (const leaf of leaves) {
      let sel = selection;
      if (!sel) {
        // 无选区：fallback = 每叶整层全选（整组按各自内容一起动）。无 fallback → 不动该叶。
        if (!opts.fallbackFullLayer || leaf.bboxW <= 0 || leaf.bboxH <= 0) continue;
        sel = Selection.full(leaf.bboxW, leaf.bboxH, leaf.bboxX, leaf.bboxY);
      }
      const src = bakeSource(sel!, leaf, opts);
      if (src) sources.push(src);
    }
    return sources;
  }

  // -------- 模式切换 --------
  // mode = null（"selected"：只显轮廓、拖内 = 平移）或 "free" | "uniform" | "distort"。
  setMode(mode: TransformModeKind | null) {
    const f = this._floating;
    if (!f) return;
    if (mode === f.mode) return;
    const mdef = MODES[mode as TransformModeKind];
    if (mdef && mdef.projectOnEnter) {
      const projected = mdef.projectOnEnter(f.mesh, f.mode, f.uniformAspect);
      if (projected) f.mesh = projected;
    }
    f.mode = mode;
    this.onChange();
  }
  getMode() { return this._floating?.mode || null; }

  // -------- 拖动 --------
  // v125 (user：「transform 拖外面也能移动，gizmo 安全区大一点」)：handle 半径 18 doc-px；quad 外按下默认 translate。
  hitTest(x: number, y: number, screenScale = 1): Hit | null {
    const f = this._floating;
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
    const f = this._floating;
    if (!f || !hit) return;
    this._drag = {
      ...hit,
      startX: x, startY: y,
      meshSnap: f.mesh.map((row) => row.map((p) => ({ x: p.x, y: p.y }))),
    };
  }
  extendDrag(x: number, y: number) {
    const f = this._floating;
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
    }
    this.onChange();                  // mesh 变 → board 每帧用新 mesh 重算 Hinv 重 warp（GPU，无 CPU 缓存）
  }
  endDrag() { this._drag = null; }

  // 把一个 source 的浮层像素落回它自己的 layer（commit/stamp 共用）。GPU 烤定：sourceWarpMatrix 算 Hinv+bbox →
  //   bakeFn（board.glWarpBakeFn = GPU warp readback）→ straight canvas → editRegion 落层。与 live warp 同采样器，
  //   零 preview/commit 漂移。bakeFn 缺省（GL 失败）→ 不烤（app 已显「需 WebGL2」）。
  _bakeDown(src: Source, bakeFn?: WarpBakeFn | null) {
    if (!bakeFn) return;
    const f = this._floating!;
    const wp = sourceWarpMatrix(src, f.gizmoBbox, f.mesh);
    if (!wp || wp.bw <= 0 || wp.bh <= 0) return;
    const mode = this._sampleMode === "nearest" ? 0 : this._sampleMode === "bicubic" ? 2 : 1;
    const rendered = bakeFn(src.canvas, src.rect.w, src.rect.h, wp.hinv, mode, wp.bx, wp.by, wp.bw, wp.bh);
    if (!rendered) return;
    const rx0 = Math.floor(rendered.dstX), ry0 = Math.floor(rendered.dstY);
    const rx1 = Math.ceil(rendered.dstX + rendered.canvas.width), ry1 = Math.ceil(rendered.dstY + rendered.canvas.height);
    src.layer.editRegion(rx0, ry0, rx1 - rx0, ry1 - ry0, (ctx, ox, oy) => {
      ctx.drawImage(rendered.canvas, rendered.dstX - ox, rendered.dstY - oy);
    });
  }

  // Stamp：各 source 写回各自 layer，KEEP float（不 push history；commit 时一次性 push）。
  stamp(bakeFn?: WarpBakeFn | null) {
    const f = this._floating;
    if (!f) return false;
    for (const src of f.sources) this._bakeDown(src, bakeFn);
    this.onChange();
    return true;
  }

  // -------- commit / cancel --------
  // commit(doc, bakeFn)：各 source 落回各自 layer，返回多层 "lasso" history entry；自动清 doc.selection（v119）。
  commit(doc: DocLike | null, bakeFn?: WarpBakeFn | null) {
    const f = this._floating;
    if (!f) return null;
    const layers: Array<{ layerId: number; before: Source["preSnap"]; after: ReturnType<Layer["snapshot"]>; beforeBlob: null; afterBlob: null }> = [];
    for (const src of f.sources) {
      this._bakeDown(src, bakeFn);
      layers.push({ layerId: src.layer.id, before: src.preSnap, after: src.layer.snapshot(), beforeBlob: null, afterBlob: null });
    }
    const prevSelection = doc?.selection || null;
    if (doc) doc.selection = null;
    const entry = { type: "lasso", layers, prevSelection };
    this._floating = null;
    this._drag = null;
    this.onChange();
    return entry;
  }
  cancel() {
    const f = this._floating;
    if (!f) return null;
    for (const src of f.sources) src.layer.restoreFromSnapshot(src.preSnap);
    this._floating = null;
    this._drag = null;
    this.onChange();
    return true;
  }

  // -------- 外部查询 --------
  // （renderForLayer 已删：浮层 display 走 GPU warp [board._glFloatInputs→_floatPass]，不再有 CPU per-layer render。）

  getFloatingScreenBbox() {
    const f = this._floating;
    if (!f) return null;
    const [minX, minY, maxX, maxY] = meshBbox(f.mesh);
    return [minX, minY, maxX, maxY];
  }
  // 给 board overlay 用：当前可拖的 handle 列表（位置 + 类型）。screenScale 让 rotate handle 按屏幕 px 偏移定位。
  visibleHandles(screenScale = 1) { return this._visibleHandles(screenScale); }

  // ---------- 内部 ----------
  _visibleHandles(screenScale = 1): Hit[] {
    const f = this._floating;
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
    // v117: rotate handle —— 只 free/uniform 露（distort 4 角任意拖不需要）。
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
    return out;
  }

  _pointInQuad(x: number, y: number) {
    const f = this._floating;
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
    kind: "distort", meshN: 2, showsRotate: false,
    corner: (mesh, snap, drag, r, c, x, y, _asp) => applyDistortCorner(mesh, snap, drag, r, c, x, y),
    edge:   (mesh, snap, drag, e, x, y, _asp) => applyDistortEdge(mesh, snap, drag, e, x, y),
    projectOnEnter: () => null,
  },
};
export const TRANSFORM_MODE_KINDS = ["free", "uniform", "distort"];

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
// 作废所有 source 的 cached render（mesh / mode 变了）。
// 矩形并集（{x,y,w,h}）。
function unionRects(rects: Rect[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    if (r.x < x0) x0 = r.x;
    if (r.y < y0) y0 = r.y;
    if (r.x + r.w > x1) x1 = r.x + r.w;
    if (r.y + r.h > y1) y1 = r.y + r.h;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// 矩形 {x,y,w,h} → 2×2 mesh（[[TL,TR],[BL,BR]]）。
function bboxToQuad(b: Rect): Mesh {
  return [
    [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }],
    [{ x: b.x, y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h }],
  ];
}
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

// ============ Source bake / render ============
// 把 layer ∩ selection mask 烤成一个 source（{layer, canvas, imageData, rect, preSnap, _renderCache}）。
//   trim 到非透明内容紧 bbox（v217 handles 贴内容）；不足 2×2 → null（v232 误触级别）。
//   opts.cut !== false → 从源层挖空（destination-out）。返回 source 或 null。
export function bakeSource(sel: Selection, layer: Layer, opts: LiftOpts = {}): Source | null {
  const lbX = layer.bboxX, lbY = layer.bboxY, lbW = layer.bboxW, lbH = layer.bboxH;
  // 选区可能跨 layer.bbox 外；clip 到交集
  const x0 = Math.max(lbX, sel.bboxX);
  const y0 = Math.max(lbY, sel.bboxY);
  const x1 = Math.min(lbX + lbW, sel.bboxX + sel.bboxW);
  const y1 = Math.min(lbY + lbH, sel.bboxY + sel.bboxH);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;

  const preSnap = layer.snapshot();

  // floating canvas = layer ∩ selection mask（在交集 bbox 内）
  const floating = makeBitmap(w, h);
  const fctx = floating.getContext("2d")!;
  fctx.drawImage(layer.canvas, x0 - lbX, y0 - lbY, w, h, 0, 0, w, h);
  fctx.globalCompositeOperation = "destination-in";
  fctx.drawImage(sel.maskCanvas, sel.bboxX - x0, sel.bboxY - y0);
  fctx.globalCompositeOperation = "source-over";
  const floatingImageData = fctx.getImageData(0, 0, w, h);

  // trim 到非透明内容紧 bbox（canvas + imageData 同裁 → srcW/srcH 1:1 无缩放）
  let srcCanvas = floating, srcImageData = floatingImageData;
  let srcW = w, srcH = h, tx0 = x0, ty0 = y0;
  {
    const d = floatingImageData.data;
    let mnX = w, mnY = h, mxX = -1, mxY = -1;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        if (d[(r * w + c) * 4 + 3] > 0) {
          if (c < mnX) mnX = c;
          if (c > mxX) mxX = c;
          if (r < mnY) mnY = r;
          if (r > mxY) mxY = r;
        }
      }
    }
    if (mxX < mnX || mxY < mnY) return null;           // 选区内全透明
    const tw = mxX - mnX + 1, th = mxY - mnY + 1;
    if (tw * th < 4) return null;                       // 不足 2×2
    tx0 = x0 + mnX; ty0 = y0 + mnY;
    srcW = tw; srcH = th;
    const cropped = makeBitmap(tw, th);
    const cctx = cropped.getContext("2d")!;
    cctx.drawImage(floating, mnX, mnY, tw, th, 0, 0, tw, th);
    srcCanvas = cropped;
    srcImageData = cctx.getImageData(0, 0, tw, th);
  }

  // 挖空源层（cut=false 跳过 → 复制为浮层，源层不动）
  if (opts.cut !== false) {
    layer.editRegion(sel.bboxX, sel.bboxY, sel.bboxW, sel.bboxH, (ctx, ox, oy) => {
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(sel.maskCanvas, sel.bboxX - ox, sel.bboxY - oy);
    });
  }

  return { layer, canvas: srcCanvas, imageData: srcImageData, rect: { x: tx0, y: ty0, w: srcW, h: srcH }, preSnap };
}

// 一个 source rect 经共享 gizmo（gizmoBbox 初始帧 → 当前 mesh quad 的 homography）映出的 dest quad。
//   单 source 时 rect === gizmoBbox → destQuad === mesh（逐点等同旧单层），故单层行为不变。
export function sourceDestQuad(rect: Rect, gizmoBbox: Rect, mesh: Mesh): Mesh | null {
  const H = homographyFromUnitSquareToQuad(mesh[0][0], mesh[0][1], mesh[1][1], mesh[1][0]);
  if (!H) return null;
  const gw = gizmoBbox.w || 1, gh = gizmoBbox.h || 1;
  const map = (x: number, y: number) => homographySample(H, (x - gizmoBbox.x) / gw, (y - gizmoBbox.y) / gh);
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
//   **CPU renderQuadPerPixel 与 GPU warp shader 共用此函数** → 同一矩阵、零漂移（golden 才对得上）。
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
//   board._glFloatInputs 用它喂 GPU（源纹理 src.canvas 只传一次，每帧只更 hinv），替代 CPU renderSource。
export function sourceWarpMatrix(source: Source, gizmoBbox: Rect, mesh: Mesh): { hinv: number[]; bx: number; by: number; bw: number; bh: number } | null {
  const destQuad = sourceDestQuad(source.rect, gizmoBbox, mesh);
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
