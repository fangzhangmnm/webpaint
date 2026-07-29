// Board = 显示层。把 PaintDoc 合成到屏幕 <canvas> 上 + 视口 pan/zoom + cursor 预览。
import { sourceWarpMatrix, sourceDestQuad, integerRigidOf } from "./floating-transform.ts";
import type { WarpBakeFn } from "./floating-transform.ts";
import { PREF_DEFAULTS } from "./app-prefs.ts";   // pixel-grid 默认值 SSoT（别在本文件硬编码第二份）
import { reportError } from "./error-badge.ts";
import { GLBoard } from "./gl/gl-board.ts";
import { poolCapacityForBudget } from "./gl/render-tree-gl.ts";
import type { FloatInput, StampOverlayInput, FillOverlayInput, OverlayInput, SurrogateInput } from "./gl/render-tree-gl.ts";
import type { Stamp, StrokeShape } from "./gl/gl-stamp.ts";

// brush.collectStamps() 的返回形（board 不 import BrushEngine，结构化接）。
type StampCollect = { stamps: Stamp[]; shape: StrokeShape; layer: Layer; mode: string; opacity: number; blendMode: string; bx: number; by: number; bw: number; bh: number } | null;
import type { GLDoc, GLLeaf } from "./gl/gl-board.ts";
import type { PaintDoc, Layer } from "./doc.ts";
import { eachLeaf, layerByteBudget } from "./doc.ts";

// ---- 本文件用到的结构类型（局部定义，只覆盖 board 实际访问的成员）----

// viewport: screen = R(rot, doc_center) ∘ scale ∘ translate(tx,ty)
interface Viewport { tx: number; ty: number; scale: number; rot: number; }

// 光标预览（screen CSS px；size 是 doc px）
interface Cursor { x: number; y: number; size: number; square?: boolean; aspect?: number; rotation?: number; }   // aspect=椭圆度(0..1)、rotation=斜度(弧度，resolved 值)：footprint 预览
// ADR-0006 VP 编辑 gizmo 数据（doc 坐标；persp-edit 算好，board 只画）
export interface PerspGizmoData {
  horizon: [{ x: number; y: number }, { x: number; y: number }] | null;
  rays: Array<[{ x: number; y: number }, { x: number; y: number }]>;
  vps: Array<{ x: number; y: number }>;
  boxEdges?: Array<[{ x: number; y: number }, { x: number; y: number }]>;   // 参考 box 12 棱（编辑模式）
}

// 选区（doc.selection）：gray8 tile mask + 紧 bbox（真类型在 selection.ts；v0.4.6 maskCanvas 死）
import type { Selection } from "./selection.ts";
import { antsOutline } from "./marching-ants.ts";
import { clipSegToBox } from "./shape-geometry.ts";

// 自由变换浮层网格点 / source / float 描述（lassoInfo.floating = FloatingTransform.current() 视图；
//   v0.4.7 S6：源像素在 workpiece float tiles，这里拿到的是懒物化 canvas + identity rect）
interface MeshPt { x: number; y: number; }
interface FloatSource { layerId: number; bytes: { data: Uint8ClampedArray; w: number; h: number }; rect: { x: number; y: number; w: number; h: number }; spline?: { data: Float32Array; w: number; h: number }; rotsprite?: { data: Uint8ClampedArray; w: number; h: number } }
interface FloatInfo {
  sources: FloatSource[];
  gizmoFrame: unknown;
  mesh: MeshPt[][];
  meshN: number;
}

// 变换 gizmo handle（screen 坐标画）
interface Handle {
  pos: MeshPt;
  kind?: string;
  anchor?: MeshPt;
}

// _lassoProvider 返回：选区蚂蚁线 / drawing path / shape / floating / handles
interface LassoInfo {
  selection?: Selection | null;
  showAnts?: boolean;      // false = 静止选区不画蚂蚁线（fill 模式 toggle；拖拽中虚线不受影响）
  floating?: FloatInfo | null;
  drawingPath?: MeshPt[] | null;
  polyFirst?: MeshPt | null;   // 多边形会话首顶点（v0.6.25 闭合提示：常显小方点/进范围实心圆）
  drawingRect?: { x0: number; y0: number; x1: number; y1: number } | null;
  drawingEllipse?: { x0: number; y0: number; x1: number; y1: number } | null;
  handles?: Handle[] | null;
  sampleMode?: string;
}

// 采样模式字符串 → GPU warp shader 的 int（0=nearest 1=bilinear 2=bicubic 3=spline；默认 bilinear）。
function _sampleModeInt(mode?: string): number {
  return mode === "nearest" ? 0 : mode === "bicubic" ? 2 : mode === "spline" ? 3 : 1;
}

type Ctx2D = CanvasRenderingContext2D;

// "#rrggbb" → [r,g,b] 0..255（fill overlay 1×1 纹理字节；容错回退黑，同 brush/gl-board 的私有解析器惯例）。
function hexToRgb255(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec((hex || "").trim());
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
type ViewportChangeCb = (() => void) | null;
//
// 坐标系：
//   doc 坐标 = 像素左上原点，单位 = doc 像素（document px）
//   screen 坐标 = CSS px（不是 device px）
//   viewport: {tx, ty, scale} 满足 screen = doc * scale + (tx, ty)
//   显示 <canvas> 内部分辨率 = CSS * dpr（HiDPI）
//
// 合成顺序：
//   1) 屏幕底色 --void（画布外的空地）
//   2) doc 矩形：先填 doc.backgroundColor（一期固定白）
//   3) 逐 layer drawImage（globalAlpha = layer.opacity, comp = layer.mode）
//   4) cursor 预览（笔尖圈圈，可选）

const MIN_SCALE = 0.05;
const MAX_SCALE = 64;   // v163：放大上限提到 64，给像素画 + 像素栅格留空间
// 像素栅格淡入：scale < LO 全隐（释放 backing）；LO→FULL 之间 alpha 线性渐隐；≥ FULL 满强度。
// 渐隐避免缩放时栅格"啪"地消失，且往低 zoom 多留一段。
const PIXEL_GRID_FADE_LO = 4;
const PIXEL_GRID_FULL = 7;
const PIXEL_GRID_ALPHA = 0.4;   // 满强度 alpha（线已是 1 device px 最细，靠 alpha 调细的观感）
// #10 主栅格（tilemap 对齐）：中性灰同款、比像素栅格醒目一档、**一直显示**（不渐隐）。
//   grill 拍板：反色/difference 要读合成像素，破坏「独立 canvas 零成本」设计 → 用 128 灰（黑白画面等对比）。
const MAIN_GRID_ALPHA = 0.35;
const MAIN_GRID_MIN_SPACING = 6;   // cell 在屏幕上密于此 px → 退化成每 2/4/8… 格一根
const PAN_KEEP_VISIBLE = 48;    // 平移时至少留这么多 px 画布在屏内（防拖出屏幕抓不回）

export class Board {
  canvas: HTMLCanvasElement;
  ctx: Ctx2D;
  doc: PaintDoc;
  dpr: number;
  viewport: Viewport;
  onViewportChange: ViewportChangeCb;
  minScale: number;
  maxScale: number;
  _raf: number | null;
  _cursor: Cursor | null;
  _showCursor: boolean;
  _voidColor: string;
  _showCheckerboard: boolean;
  _pixelGridEnabled: boolean;
  _docGridOn: boolean;      // #10 主栅格（per-doc，editorState.grid）
  _docGridCell: number;
  gridCanvas: HTMLCanvasElement | null;
  gctx: Ctx2D | null;
  cursorEl: HTMLElement | null;
  _gridSig: string;
  // 按需创建 / 延迟初始化的字段
  _strokeActiveHint?: (() => unknown) | null;
  // GL live-sync：原地改像素的笔描边中要重传 GPU 的活动叶（无=不重传，buffered brush/无描边）。
  _liveSyncProvider?: (() => Layer | null) | null;
  _lassoProvider?: (() => LassoInfo | null | undefined) | null;
  _activeSurrogateLayerId?: number | null;
  _activeSurrogateBytes?: { data: Uint8ClampedArray; w: number; h: number } | null;
  _activeSurrogateBx?: number;   // 替身 canvas 的 doc 左上（GL 上传 tiles 用）
  _activeSurrogateBy?: number;
  _showFps?: boolean;
  _lastFrameT?: number | null;
  _fps?: number | null;
  _fpsEl?: HTMLElement;
  _lastStampCount = 0;   // 上帧 overlay stamp 数（HUD；§1 长描边二次爆炸的直读量，仅 _showFps 时填）
  static _dispatchingDirty?: boolean;
  // WebGL2 渲染（v351 起唯一 display 路径）。init 失败 → _glBoard=null → _renderFull 显「需 WebGL2」。
  _glBoard?: GLBoard | null;
  _glCanvas?: HTMLCanvasElement | null;

  constructor(canvas: HTMLCanvasElement, doc: PaintDoc) {
    this.canvas = canvas;
    // 本 2D canvas 恒 alpha:true（透明，只画 lasso overlay/边框，GL canvas 在后透出 doc）。GL 是唯一 display 路径。
    this.ctx = canvas.getContext("2d", { alpha: true })!;
    this.doc = doc;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    // viewport: tx/ty = screen-px offset of doc top-left (in scale=1, rot=0 frame),
    // scale = zoom, rot = radians (旋转锚点 = doc center). 见 _docToScreenAffine。
    this.viewport = { tx: 0, ty: 0, scale: 1, rot: 0 };
    this.onViewportChange = null;   // 可选回调：viewport 变时同步屏幕坐标 DOM overlay（crop rect）
    this.minScale = MIN_SCALE;
    this.maxScale = MAX_SCALE;
    this._raf = null;
    this._cursor = null;            // {x, y, size} in screen px，可选
    this._showCursor = false;

    // 主题色：从 CSS 变量取
    this._voidColor = "#e6e2d6";
    // 棋盘背景：开后底层用半透明灰白格替代 doc.backgroundColor。
    // 适合做透明素材 / 看图层 alpha 通道。
    this._showCheckerboard = false;
    // v163 像素栅格：放大到 PIXEL_GRID_FADE_LO 以上渐显 1 doc-px 网格（像素画对齐）。
    //   只画可见区域格线（性能）；很细很淡；全局开关可关。
    //   真值由 app.ts 的 fixup 相经 settings-menu 的 renderSettingsFromPrefs() 灌入（SSoT = PREF_DEFAULTS["pixel-grid"]）；
    //   这里只是构造期占位，别在这硬编码第二份默认值。
    this._pixelGridEnabled = PREF_DEFAULTS["pixel-grid"];
    // #10 主栅格：per-doc 配置（editorState.grid），由 settings-menu 经 setDocGrid 灌入；这里只是占位默认。
    this._docGridOn = false;
    this._docGridCell = 16;

    // v163 瞬态 UI 分层（省 hot-path + 显存，详 docs/20260604-overlay-grid-cursor-layers.md）：
    //   像素栅格 = 独立 canvas，**仅视口变时重画**（_syncGrid sig 守卫）→ 画笔行进时不碰它，零逐帧成本；
    //     device-px 对齐画线（CSS gradient 在浮点 zoom 下 sub-pixel 糊：少线/粗细不一，业界都用 canvas）。
    //     backing 按需分配，隐藏/缩小时释放（width=0）→ 只在高 zoom 看栅格时占一张屏的显存。
    //   光标 = DOM div（transform 移动）：hover 不再 full render。
    //   蚂蚁线 / floating 仍在主 canvas（需 canvas；只有选区时才逐帧，旧行为）。
    this.gridCanvas = document.getElementById("boardGrid") as HTMLCanvasElement | null;
    this.gctx = null;
    this.cursorEl = document.getElementById("boardCursor");
    this._gridSig = "";

    this.resize();
    window.addEventListener("resize", () => this.resize());
    // iOS / iPad PWA：地址栏 / 状态栏推送或键盘弹出会改 visualViewport，但不一定触发
    // window resize。如果不响应，canvas 内部 pixel buffer 仍是旧尺寸，被 CSS 拉伸到新
    // viewport → 渲染像素和 clientX/Y 错位 → 笔触和光标的偏移。详见 v54 反馈。
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => this.resize());
      window.visualViewport.addEventListener("scroll", () => this.resize());
    }
    // 兜底：直接观察 canvas 的 CSS 尺寸变化（PWA 容器 reflow / Safari URL bar 等）
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(this.canvas);
    }

    // GL 渲染器（唯一 display 路径）：建 GL canvas 垫在 #board 之下 + GLBoard。失败 → _glBoard=null → _renderFull 显「需 WebGL2」。
    this._glBoard = null;
    this._glCanvas = null;
    this._setupGLBoard();
    this._configureDocMemory();

    // 首次：把 doc 居中适配
    this.fitToScreen();
  }

  // 按渲染模式给 doc 设内存预算档（doc.maxLayers 动态字节预算用）：
  //   GL 模式——合成直读 tile + 每帧 release 物化 canvas → 单份 tile 计费；预算 = min(GPU tile 池容量, 设备 RAM 预算)
  //     （CPU cap 不得超 GPU 池容量，否则池满丢 tile = 合成漏块）。
  //   2D 模式——_mat 常驻 → tile + 物化 canvas 双份计费；预算 = 设备 RAM 预算（诚实计 actual bytes，防 OOM）。
  _configureDocMemory() {
    if (this._glBoard) {
      // S7：GPU 池惰性增长——预算口径用 quota（增长上限），别用 committed（初始才 16MiB）。
      this.doc.configureMemory(Math.min(this._glBoard.memory.quotaBytes, layerByteBudget()), false);
    } else {
      this.doc.configureMemory(layerByteBudget(), true);
    }
  }

  // 建 GL canvas（同 .board CSS 定位，DOM 插在 #board 前→在其下；pointer-events:none 不吃事件）+ GLBoard。
  _setupGLBoard() {
    try {
      const gl = document.createElement("canvas");
      gl.className = "board";            // 同 fixed inset:0 100% 定位 + gallery 隐藏
      gl.id = "boardGL";
      gl.style.pointerEvents = "none";   // 事件归 #board
      gl.width = this.canvas.width; gl.height = this.canvas.height;
      this.canvas.parentNode?.insertBefore(gl, this.canvas);
      this._glCanvas = gl;
      this._glBoard = new GLBoard(gl, poolCapacityForBudget(256 * 1024 * 1024));
    } catch (e) {
      reportError(new Error("[board] GL 初始化失败（无 WebGL2）→ 显「需 WebGL2」：" + String(e)), "log");
      if (this._glCanvas) { this._glCanvas.remove(); this._glCanvas = null; }
      this._glBoard = null;
    }
  }

  setDoc(doc: PaintDoc) {
    this.doc = doc;
    this._configureDocMemory();
    this._glBoard?.markContentDirty();   // GL：新 doc → 全量重传
    this.fitToScreen();
  }

  setShowCheckerboard(on: boolean) {
    this._showCheckerboard = !!on;
  }
  setPixelGridEnabled(on: boolean) {
    this._pixelGridEnabled = !!on;
    this._gridSig = "";        // 强制下次 _syncGrid 重算
    this.requestRender();
  }
  getPixelGridEnabled() { return this._pixelGridEnabled; }
  // #10 主栅格：per-doc 配置灌入口（settings-menu 从 editorState.grid 调）
  setDocGrid(on: boolean, cell: number) {
    this._docGridOn = !!on;
    this._docGridCell = Math.max(2, Math.round(cell) || 16);
    this._gridSig = "";
    this.requestRender();
  }
  setThemeColors({ voidColor }: { voidColor?: string }) {
    if (voidColor) this._voidColor = voidColor;
    this.requestRender();
  }

  // 由 BrushEngine 报告："layer 像素被改"（脏 bbox 参数现仅语义/旁观者用；GL-only 后无 partial-blit 消费它）。
  markDocDirty(_x0: number, _y0: number, _x1: number, _y1: number) {
    // S8e：原地引擎（液化/滤镜笔/像素笔）描边中每 move 都到这里——活动叶已在执行器 updated 集
    //   （liveSyncProvider），contentVersion 快路径只重传变更 tile；此时若 markContentDirty 会把
    //   全部段缓存每帧掀翻（S7 承诺的「液化每帧 sb0」被它打破）。描边中只请求重渲，
    //   抬笔 commit 的 invalidateAll 才全失效。
    if (!this._liveSyncProvider?.()) this._glBoard?.markContentDirty();
    // 通知挂在 doc 上的旁观者（如 reference live 镜像）。每个 brush stamp 都会触发，
    // 但 reference 端 markLiveDirty 仅置 flag + 走 rAF，不真合成，开销 ≪ 1ms。
    if (!Board._dispatchingDirty) {
      Board._dispatchingDirty = true;
      window.dispatchEvent(new CustomEvent("wp:docpixeldirty"));
      Board._dispatchingDirty = false;
    }
  }

  // ---- 坐标 ----
  // 视口变换：
  //   screen = R(rot, doc_center_screen) ∘ scale ∘ translate_by_(tx,ty)
  // 其中 doc_center_screen = (tx + W*scale/2, ty + H*scale/2)（rot=0 时即 doc 中心
  // 在屏幕上的位置）。rotation 围绕 doc center 转 = 用户直观的"原地旋转画布"。
  _docCenterScreen() {
    const { tx, ty, scale } = this.viewport;
    return { cx: tx + this.doc.width * scale / 2, cy: ty + this.doc.height * scale / 2 };
  }
  screenToDoc(sx: number, sy: number) {
    const { scale, rot } = this.viewport;
    const { cx, cy } = this._docCenterScreen();
    const dx = sx - cx, dy = sy - cy;
    const c = Math.cos(-rot), s = Math.sin(-rot);
    const rx = dx * c - dy * s;
    const ry = dx * s + dy * c;
    return { x: rx / scale + this.doc.width / 2, y: ry / scale + this.doc.height / 2 };
  }
  docToScreen(dx: number, dy: number) {
    const { scale, rot } = this.viewport;
    const { cx, cy } = this._docCenterScreen();
    const x = (dx - this.doc.width / 2) * scale;
    const y = (dy - this.doc.height / 2) * scale;
    const c = Math.cos(rot), s = Math.sin(rot);
    return { x: x * c - y * s + cx, y: x * s + y * c + cy };
  }

  // ---- 视口 ----（任何视口变都是全屏 dirty）
  pan(dx: number, dy: number) {
    this.viewport.tx += dx;
    this.viewport.ty += dy;
    this._clampPan();
    this.requestRender();
  }

  // 防止把画布拖到屏幕外抓不回来：保证画布（含旋转后的 bbox）至少留 PAN_KEEP_VISIBLE
  // px 在屏内。整体平移 tx/ty 不改变 bbox 形状，所以只需算一次 bbox 再补一个平移量。
  _clampPan() {
    if (!this.doc) return;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const W = this.doc.width, H = this.doc.height;
    const pts = [
      this.docToScreen(0, 0), this.docToScreen(W, 0),
      this.docToScreen(0, H), this.docToScreen(W, H),
    ];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const m = PAN_KEEP_VISIBLE;
    let sx = 0, sy = 0;
    if (maxX < m) sx = m - maxX;                 // 整体跑出左边 → 拉回
    else if (minX > w - m) sx = (w - m) - minX;  // 跑出右边
    if (maxY < m) sy = m - maxY;                 // 跑出上边
    else if (minY > h - m) sy = (h - m) - minY;  // 跑出下边
    this.viewport.tx += sx;
    this.viewport.ty += sy;
  }
  // anchor 在 screen 坐标。zoom 时保 anchor 在 screen 上的 doc 点不变。
  zoomAt(anchorX: number, anchorY: number, factor: number) {
    const oldScale = this.viewport.scale;
    const newScale = clamp(oldScale * factor, this.minScale, this.maxScale);
    if (newScale === oldScale) return;
    // 先把 anchor 转 doc 坐标，再 zoom，再补 tx/ty 让 anchor 处 doc 点不动
    const docPt = this.screenToDoc(anchorX, anchorY);
    this.viewport.scale = newScale;
    const after = this.docToScreen(docPt.x, docPt.y);
    this.viewport.tx += anchorX - after.x;
    this.viewport.ty += anchorY - after.y;
    this.requestRender();
  }

  // rotateAt 围绕 screen anchor 旋转视口（delta 是 radian 增量）
  rotateAt(anchorX: number, anchorY: number, deltaRot: number) {
    const docPt = this.screenToDoc(anchorX, anchorY);
    this.viewport.rot += deltaRot;
    const after = this.docToScreen(docPt.x, docPt.y);
    this.viewport.tx += anchorX - after.x;
    this.viewport.ty += anchorY - after.y;
    this.requestRender();
  }

  setViewport(tx: number, ty: number, scale: number, rot?: number) {
    this.viewport.tx = tx;
    this.viewport.ty = ty;
    this.viewport.scale = clamp(scale, this.minScale, this.maxScale);
    if (typeof rot === "number") this.viewport.rot = rot;
    this._clampPan();   // 双指 pan / 程序设位也受边界约束（fitToScreen 居中 → no-op）
    this.requestRender();
  }

  // 适配屏幕：让 doc 居中并铺满（留一点边）。同时复位 rotation。
  fitToScreen(padding: number = 24) {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (!this.doc) return;
    const sx = (w - padding * 2) / this.doc.width;
    const sy = (h - padding * 2) / this.doc.height;
    let s = Math.min(sx, sy);
    // #26（v0.5）：小画布（像素画）fit 出 ≥2 的倍率时向下取整到整数倍——像素格与屏幕像素对齐，
    //   开 16²/512² 模板不再落在 13.7× 这类倍率上。大画布 fit（<2×）不受影响。
    if (s >= 2) s = Math.floor(s);
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
    const tx = (w - this.doc.width * scale) / 2;
    const ty = (h - this.doc.height * scale) / 2;
    this.setViewport(tx, ty, scale, 0);   // 复位 rotation
  }

  // 公共 API：layer 像素被改了（图层结构变 / 切换 / putImageData 等）
  invalidateAll() {
    this._glBoard?.markContentDirty();   // GL：图层/结构变 → 全量重传
    this.requestRender();
  }

  // v131: liquify / filter brush 等没用 overlay 但仍需禁 partial。fn 返回 truthy = 强全屏
  setStrokeActiveHint(fn: (() => unknown) | null) { this._strokeActiveHint = fn; }

  // GL live-sync：返回描边中原地改像素、需每帧重传 GPU 的活动叶（无=null）。仅 GL 路径消费。
  setLiveSyncProvider(fn: (() => Layer | null) | null) { this._liveSyncProvider = fn; }

  // 套索 overlay：在 layer 像素之上画一条 polygon (drawing) 或 floating canvas + marching ants
  setLassoProvider(fn: (() => LassoInfo | null | undefined) | null) {
    this._lassoProvider = fn;
  }
  // 颜色调整 live preview 走 surrogate **字节平面**（per-pixel JS 滤镜结果就地写入；v0.6.39 去 canvas 化）。
  //   GL 模式：该替身经 _glSurrogate 上传成活动层 GPU tiles 显示（非破坏）。(layerId, bytes, bx, by) 启动；(null, null) 关。
  //   invalidateAll → markContentDirty：关闭时下一帧（非 livePreview）syncAll 从真像素恢复 GPU。
  setActiveLayerSurrogate(layerId: number | null, bytes: { data: Uint8ClampedArray; w: number; h: number } | null, bx = 0, by = 0) {
    this._activeSurrogateLayerId = layerId;
    this._activeSurrogateBytes = bytes;
    this._activeSurrogateBx = bx;
    this._activeSurrogateBy = by;
    this.invalidateAll();
  }

  // GL 渲染用：当前活动层替身（颜色调整 preview）→ SurrogateInput（无替身=null）。
  _glSurrogate(): SurrogateInput | null {
    const b = this._activeSurrogateBytes;
    if (!b || this._activeSurrogateLayerId == null || !b.w || !b.h) return null;
    return { layerId: this._activeSurrogateLayerId, bytes: b, bx: this._activeSurrogateBx ?? 0, by: this._activeSurrogateBy ?? 0, w: b.w, h: b.h };
  }

  // 注：层合成全在 GL（render-tree 执行器）。旧 2D 规范合成器接缝（ensureCompositeCache/_layerCompositeOpts/
  //   erase/clip tmp 池）已随吸管迁 GL 一并退役（S8c）——board 与 layer-composite.ts 断开。

  // 把 ctx 设到 "doc 坐标系"：doc (0,0) 映射到 ctx 当前 origin，含 dpr +
  // viewport (tx,ty,scale,rot) 全部。setTransform 接 6 浮点 a,b,c,d,e,f：
  //   screen.x = a*doc.x + c*doc.y + e
  //   screen.y = b*doc.x + d*doc.y + f
  // 我们的视口：先平移 -W/2 (-H/2) → 缩放 scale → 旋转 rot → 平移到屏幕上
  // doc center。dpr 在所有之外（用 setTransform 顶层再乘）。
  // doc px → device px 的 6 仿射参（setTransform 的 a,b,c,d,e,f）。2D setTransform 与 GL present 共用。
  _docTransformParams(): [number, number, number, number, number, number] {
    const { scale, rot } = this.viewport;
    const dpr = this.dpr;
    const { cx, cy } = this._docCenterScreen();
    const W = this.doc.width, H = this.doc.height;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    // 复合矩阵 = T(cx,cy) · R(rot) · S(scale) · T(-W/2,-H/2)，再乘 dpr 给 device px
    const a = scale * cosR;
    const b = scale * sinR;
    const c = -scale * sinR;
    const d = scale * cosR;
    const e = cx - a * (W / 2) - c * (H / 2);
    const f = cy - b * (W / 2) - d * (H / 2);
    return [dpr * a, dpr * b, dpr * c, dpr * d, dpr * e, dpr * f];
  }
  _applyDocTransform(ctx: Ctx2D) {
    const [a, b, c, d, e, f] = this._docTransformParams();
    ctx.setTransform(a, b, c, d, e, f);
  }

  // ---- 渲染 ----
  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const tw = Math.round(w * dpr);
    const th = Math.round(h * dpr);
    // 没变就不动 —— ResizeObserver / visualViewport 频繁触发也不浪费
    if (tw === this.canvas.width && th === this.canvas.height && dpr === this.dpr) return;
    this.dpr = dpr;
    this.canvas.width = tw;
    this.canvas.height = th;
    if (this._glCanvas) { this._glCanvas.width = tw; this._glCanvas.height = th; }   // GL canvas 跟随 device px
    this._gridSig = "";   // 尺寸变 → 强制重算栅格 div
    this._clampPan();     // #27：屏幕尺寸/旋转变小后画布可能整体落屏外，同一约束一并夹回
    this.requestRender();
  }

  requestRender() {
    // viewport 变（pan/zoom/rotate/fit 都先改 viewport 再 requestRender）→ 同步屏幕坐标的 DOM overlay
    // （如 crop rect gizmo）。放早退之前：pinch 一帧内 pan+zoom 各调一次都同步，不脱位。非 crop 时回调 no-op。
    this.onViewportChange?.();
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.render();
    });
  }

  setCursor(c: Cursor | null) {
    // v163：光标是独立 DOM div，移动只改 transform（GPU 合成），不碰 canvas → hover 也不再 full render。
    //   Stroke 期间 input.js 仍调 setCursor(null) 隐藏光标。
    this._cursor = c;
    this._showCursor = !!c;
    this._updateCursorEl();
  }
  // 把光标 DOM div 同步到 _cursor（screen CSS px）。size 是 doc px → 半径 = size×scale/2。
  _updateCursorEl() {
    const el = this.cursorEl;
    if (!el) return;
    if (this._showCursor && this._cursor) {
      const c = this._cursor;
      const r = Math.max(2, c.size * this.viewport.scale / 2);
      el.style.width = el.style.height = (2 * r) + "px";
      // 椭圆度(aspect)/斜度(rotation) 反映 resolved-brush 的 footprint：绕中心 rotate + scaleY(aspect)。
      //   translate 定位左上角、transform-origin 默认=中心 → 复合变换绕光标中心（矩阵已验），仍纯 transform（不触发 layout，v163）。
      const aspect = (c.aspect != null && c.aspect > 0) ? c.aspect : 1;
      const rotDeg = c.rotation ? c.rotation * 180 / Math.PI : 0;
      const shape = (!c.square && (aspect !== 1 || rotDeg !== 0)) ? ` rotate(${rotDeg}deg) scale(1, ${aspect})` : "";
      el.style.transform = `translate(${c.x - r}px, ${c.y - r}px)${shape}`;
      el.classList.toggle("square", !!c.square);   // v232：像素笔方形 preview（方笔不套椭圆/斜度）
      el.style.display = "block";
    } else {
      el.style.display = "none";
    }
  }

  render() {
    if (!this.doc) return;
    // v275：拥抱 full-composite —— 删 partial/clip-window + 黑缝补丁。每帧 _renderFull：
    //   实时（描边/调整预览）直接合成到屏幕；静态走 1:1 doc 合成缓存（命中只 blit）。
    //   **缓存失效只跟内容/结构变**（markDocDirty / invalidateAll / setDoc 置 _compositeCacheDirty），
    //   不跟视口变 → pan/zoom 不重建缓存（修卡顿根因：旧版 _dirtyFull 含视口 → 每帧重建 2048²）。
    this._renderFull();
    this._syncGrid();   // 每帧一次：sig 守卫，视口没变（如 stroke 中）→ 立即 no-op
    this._tickFps();
  }

  // ---- FPS 计（dev 性能读数，防煤气灯）----
  setShowFps(on: boolean) {
    this._showFps = !!on;
    this._lastFrameT = null;            // 重置 → 第一帧 dt 不算
    if (this._showFps) { this._ensureFpsEl().style.display = "block"; this.requestRender(); }
    else if (this._fpsEl) this._fpsEl.style.display = "none";
  }
  getShowFps() { return !!this._showFps; }
  _ensureFpsEl() {
    if (this._fpsEl) return this._fpsEl;
    const el = document.createElement("div");
    el.id = "fpsMeter";
    el.style.cssText = "position:fixed;top:4px;left:4px;z-index:99999;pointer-events:none;"
      + "font:11px/1.3 ui-monospace,monospace;color:#0f0;background:rgba(0,0,0,.55);"
      + "padding:1px 6px;border-radius:4px;white-space:pre;";
    document.body.appendChild(el);
    this._fpsEl = el;
    return el;
  }
  // render() 末尾调。只在开了 FPS 时计：render 是 rAF 驱动 → 交互（pan/draw）时每帧跑一次，
  //   dt 的 EMA = 交互帧率。空闲无 render → 读数冻在上次（我们只关心交互帧率）。
  _tickFps() {
    if (!this._showFps) return;
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    if (this._lastFrameT != null) {
      const dt = now - this._lastFrameT;
      if (dt > 0) {
        const inst = 1000 / dt;
        this._fps = this._fps == null ? inst : this._fps * 0.8 + inst * 0.2;
      }
    }
    this._lastFrameT = now;
    // 第二行 = 每帧合成归因（§2 layer-count / §3 float / §1 长描边）：Np=blend pass 数、Nf=浮层 warp pass、Ns=stamp 数。
    //   pan/zoom 不重合成 → p/f 冻在上次合成帧（预期）。读这三个数即可定位掉帧在哪条，不必靠猜。
    const s = this._glBoard?.stats;
    const pool = this._glBoard?.fboPoolStats;
    // 第二行末尾加 FBO 池占用（确认有界不单增）：Nfbo 张 / Mmb。
    const poolStr = pool ? ` ${pool.count}fbo/${Math.round(pool.bytes / 1048576)}mb` : "";
    // S7 段缓存读数：sb=本帧建段 sh=段命中 !=降级（quota 塞不下段缓存）。描边中理想形态 = sb0 shN。
    const fs = this._glBoard?.frameStats;
    const segStr = fs ? ` sb${fs.segBuilds} sh${fs.segHits}${fs.cachingDegraded ? "!" : ""}` : "";
    const line2 = s ? `\n${s.passes}p ${s.floatPasses}f ${this._lastStampCount}s${poolStr}${segStr}` : "";
    this._ensureFpsEl().textContent = `${this._fps ? this._fps.toFixed(0) : "--"} fps${line2}`;
  }

  // v351 起 GL board 是唯一 display 路径（2D display 归档进 ARCHIVE/old-board-2d-display.ts）。
  //   GL init 失败（无 WebGL2）→ 不回退 2D，显「需 WebGL2」提示。
  _renderFull() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    if (!this._glBoard) { this._drawGLRequiredMessage(ctx, W, H); return; }
    this._renderFullGL(ctx, W, H);
  }

  // GL 初始化失败兜底画面（无 WebGL2 设备）。void 底 + 居中中文提示。
  _drawGLRequiredMessage(ctx: Ctx2D, W: number, H: number) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this._voidColor;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#7a756a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const s = Math.max(14, Math.round(16 * this.dpr));
    ctx.font = `${s}px system-ui, -apple-system, sans-serif`;
    ctx.fillText("此设备不支持 WebGL2 —— 无法运行画布", W / 2, H / 2 - s);
    ctx.fillText("请用支持 WebGL2 的浏览器/设备打开", W / 2, H / 2 + s);
  }

  // GL 渲染路径：GL canvas 渲 doc（void 底 + doc 背景 + 图层 + live overlay，视口仿射）；
  //   本 2D canvas 清透明、只画 lasso overlay + doc 边框（GL 透出 doc）。
  _renderFullGL(ctx: Ctx2D, W: number, H: number) {
    const docBg = this._showCheckerboard ? "checker" : (this.doc.backgroundColor || "#ffffff");   // 棋盘背景接缝（GL 合成器 doc 空间棋盘）
    // live-sync：原地改像素的笔（liquify/filterBrush/pixelMode）描边中把活动叶标 updated
    //   （执行器 contentVersion 快路径每帧只重传变更 tile）。
    const liveSync = this._liveSyncProvider?.() ?? null;
    const stampOverlay = this._glStampOverlay();
    this._lastStampCount = this._showFps ? ((stampOverlay && !("kind" in stampOverlay)) ? stampOverlay.stamps.length : 0) : 0;   // HUD only（fill overlay 无 stamps）
    this._glBoard!.render(
      this.doc as unknown as GLDoc,
      this._docTransformParams(),
      W, H, this.viewport.scale, this._voidColor, docBg,
      this._glFloatInputs(), stampOverlay,
      liveSync as unknown as GLLeaf | null, this._glSurrogate(),
    );
    // 切片②：GL 合成直读 tile（不碰 layer.canvas）→ 物化 canvas 是纯冗余的第二份像素拷贝。
    //   非 live-preview 帧（已 syncAll 把 tile 传 GPU）后释放各层物化缓存 → GL 模式不常驻第二份拷贝。
    //   （live-preview 中不释放：活动层 surrogate / 叠层路径可能仍读 canvas。getter 命中会按需重建。）
    if (!this._isLivePreview()) eachLeaf(this.doc.layers, (l) => l.releaseMaterialized());
    // 2D 叠层（透明底）：lasso 蚂蚁线/handles + doc 边框
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this._applyDocTransform(ctx);
    const { scale } = this.viewport;
    this._drawLassoOverlay(ctx, scale);
    this._drawPerspGizmo(ctx, scale);
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, this.doc.width, this.doc.height);
  }

  // ADR-0006 VP 编辑模式的 gizmo（淡地平线 + 参考点射线 + VP 圈；只在编辑模式非空，
  //   平时 provider 返 null 零成本）。拖拽手柄是 DOM（persp-edit），这里只画线。
  setPerspGizmoProvider(fn: (() => PerspGizmoData | null) | null) { this._perspGizmoProvider = fn; }
  _drawPerspGizmo(ctx: Ctx2D, scale: number) {
    const g = this._perspGizmoProvider?.();
    if (!g) return;
    // 线段裁到可见 doc 区（弱 VP 时地平线端点可到 1e5 doc px，高倍 zoom 下 canvas 坐标
    //   到 1e6+，部分浏览器极端坐标丢线/抖动——gizmo 线没走形状几何的 _clipBox，这里自己裁）
    const cw = this.canvas.clientWidth || window.innerWidth;
    const ch = this.canvas.clientHeight || window.innerHeight;
    let vx0 = Infinity, vy0 = Infinity, vx1 = -Infinity, vy1 = -Infinity;
    for (const [sx, sy] of [[0, 0], [cw, 0], [0, ch], [cw, ch]]) {
      const p = this.screenToDoc(sx, sy);
      if (p.x < vx0) vx0 = p.x; if (p.x > vx1) vx1 = p.x;
      if (p.y < vy0) vy0 = p.y; if (p.y > vy1) vy1 = p.y;
    }
    const pad = 16 / scale;
    const vbox = { x0: vx0 - pad, y0: vy0 - pad, x1: vx1 + pad, y1: vy1 + pad };
    ctx.save();
    ctx.lineCap = "round";
    if (g.horizon) {
      const seg = clipSegToBox(g.horizon[0], g.horizon[1], vbox);
      if (seg) {
        ctx.strokeStyle = "rgba(64,140,255,0.55)";
        ctx.lineWidth = 1.4 / scale;
        ctx.beginPath();
        ctx.moveTo(seg[0].x, seg[0].y);
        ctx.lineTo(seg[1].x, seg[1].y);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = "rgba(64,140,255,0.28)";
    ctx.lineWidth = 1 / scale;
    for (const [a, b] of g.rays) {
      const seg = clipSegToBox(a, b, vbox);
      if (!seg) continue;
      ctx.beginPath(); ctx.moveTo(seg[0].x, seg[0].y); ctx.lineTo(seg[1].x, seg[1].y); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(64,140,255,0.8)";
    ctx.lineWidth = 1.4 / scale;
    for (const v of g.vps) {
      ctx.beginPath(); ctx.arc(v.x, v.y, 5 / scale, 0, Math.PI * 2); ctx.stroke();
    }
    if (g.boxEdges) {
      ctx.strokeStyle = "rgba(255,165,0,0.75)";
      ctx.lineWidth = 1.4 / scale;
      for (const [a, b] of g.boxEdges) {
        const seg = clipSegToBox(a, b, vbox);
        if (!seg) continue;
        ctx.beginPath(); ctx.moveTo(seg[0].x, seg[0].y); ctx.lineTo(seg[1].x, seg[1].y); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Stage 3：brush stamp 列表提供者（app 注入 = () => input.brush.collectStamps()）。
  _stampProvider: (() => StampCollect) | null = null;
  setStampProvider(fn: () => StampCollect) { this._stampProvider = fn; }

  // StampCollect → GPU overlay 输入（live 每帧 + commit 共用一个构造 = 同源输入喂同一 shader）。
  //   selection/lockAlpha/erase/blendMode/Π-outer opacity 全在 shader 内（live 即 commit 所见）。
  _overlayInputFrom(cs: NonNullable<StampCollect>): StampOverlayInput {
    const sel = this.doc.selection;
    return {
      stamps: cs.stamps, shape: cs.shape, bx: cs.bx, by: cs.by, bw: cs.bw, bh: cs.bh,
      layerId: cs.layer.id, opacity: cs.opacity, erase: cs.mode === "erase", blendMode: cs.blendMode,
      lockAlpha: !!cs.layer.lockAlpha,
      selMask: sel ? (() => { const m = (sel as Selection).bboxMask(); return { data: m.data, ox: m.x, oy: m.y, ow: m.w, oh: m.h }; })() : null,
    };
  }

  // GPU brush stamp overlay（live 每帧；替 CPU overlayCanvas）。
  //   v0.5.11：同一 overlay 槽复用给 fill 预览（brush 优先；lasso 模式下 brush 必空 → 结构上互斥）。
  _glStampOverlay(): OverlayInput | null {
    const cs = this._stampProvider?.();
    const brush = (cs && cs.stamps.length) ? this._overlayInputFrom(cs) : null;
    const fill = this._glFillOverlay();
    if (brush && fill) {
      // 结构上不可达（fill 只在 lasso 模式 active，lasso canDraw=false 起不了 stroke）。真到了=接线坏了，
      //   响亮报错并取 brush（别哑着渲染错误合成）。
      reportError(new Error("[board] stamp overlay 与 fill overlay 同时非空——edit-mode 互斥被破坏"), "warning");
      return brush;
    }
    return brush ?? fill;
  }

  // v0.5.11 fill-mode：填色预览 provider（fill-mode.ts 注入；active 才返 {color, layer}）。
  _fillProvider: (() => { color: string; layer: Layer } | null) | null = null;
  _perspGizmoProvider: (() => PerspGizmoData | null) | null = null;   // ADR-0006 VP 编辑 gizmo
  setFillProvider(fn: (() => { color: string; layer: Layer } | null) | null) { this._fillProvider = fn; }

  // fill 输入构造（live 每帧 + commit 共用 = 同源输入喂同一 shader，对齐 _overlayInputFrom 的 SSoT 纪律）。
  _glFillOverlay(): FillOverlayInput | null {
    const f = this._fillProvider?.();
    if (!f) return null;
    return this._fillInputFrom(f);
  }
  _fillInputFrom(f: { color: string; layer: Layer }): FillOverlayInput | null {
    const sel = this.doc.selection as Selection | null;
    if (!sel) return null;
    const m = sel.bboxMask();
    return {
      kind: "fill", color: hexToRgb255(f.color),
      bx: m.x, by: m.y, bw: m.w, bh: m.h,
      layerId: f.layer.id, lockAlpha: !!f.layer.lockAlpha,   // user 拍板：填色尊重锁α（预览=commit 同 shader 同参）
      selMask: { data: m.data, ox: m.x, oy: m.y, ow: m.w, oh: m.h },
    };
  }

  // GL board 是否启用（brush beginStroke 据此设 glMode）。
  isGLBoard(): boolean { return !!this._glBoard; }

  // S8 brush commit：抬笔的最终 stamps（含 tail/taper）→ GPU merge（live 同一 shader）→ 只封真变 tile 落层
  //   → 变更 tile GPU 收养。返回 false = 没提交（GL 失败/池到顶保底），调用方别当成功。
  commitBrushStroke(cs: NonNullable<StampCollect>): boolean {
    if (!this._glBoard || !cs.stamps.length) return false;
    const layer = cs.layer;
    return this._glBoard.commitBrushStroke(
      layer.id, layer.pixels, this._overlayInputFrom(cs), this.doc.width, this.doc.height,
      (px, x, y, w, h) => layer.applyRegionDiff(x, y, w, h, px),
    );
  }

  // v0.5.11 fill commit：镜像 commitBrushStroke——同一 GPU merge→tile diff→applyRegionDiff 路径，
  //   输入构造与 live 共用 _fillInputFrom（SSoT：预览所见即 commit 所得，含 lockAlpha）。
  //   返回 false = 没提交（无选区/GL 失败/池到顶），调用方别当成功。
  commitFill(f: { color: string; layer: Layer }): boolean {
    if (!this._glBoard) return false;
    const ov = this._fillInputFrom(f);
    if (!ov) return false;
    return this._glBoard.commitBrushStroke(
      f.layer.id, f.layer.pixels, ov, this.doc.width, this.doc.height,
      (px, x, y, w, h) => f.layer.applyRegionDiff(x, y, w, h, px),
    );
  }

  // 自由变换 commit 烤定用：GPU warp 源 → straight canvas（_bakeDown 注入；GL 失败=null，commit 不烤）。
  glWarpBakeFn(): WarpBakeFn | null {
    if (!this._glBoard) return null;
    return (src, srcW, srcH, hinv, mode, bx, by, bw, bh) => this._glBoard!.warpToBytes(src, srcW, srcH, hinv, mode, bx, by, bw, bh);
  }

  // 自由变换浮层 → GL warp 输入（floatFor 接缝）：每源层传**未 warp 源纹理 + Hinv**（GPU 在 shader 里 gather
  //   warp，源纹理只在内容变时重传）。落源层 z（floatFor 按 leaf.id 匹配）。
  //   v0.4.7：源 = workpiece float 的懒物化 canvas（FloatViewSource），layerId 直读。
  _glFloatInputs(): FloatInput[] {
    const lassoInfo = this._lassoProvider?.();
    const float = (lassoInfo && lassoInfo.floating) ? lassoInfo.floating : null;
    if (!float) return [];
    const smode = lassoInfo!.sampleMode;
    const mode = _sampleModeInt(smode);
    const out: FloatInput[] = [];
    for (const src of float.sources) {
      const wp = sourceWarpMatrix(src, float.gizmoFrame as Parameters<typeof sourceWarpMatrix>[1], float.mesh as Parameters<typeof sourceWarpMatrix>[2]);
      if (!wp) continue;
      // 像素完美（rotsprite）：整数刚体态 → 裸 nearest 1×（逐字节，与 commit 置换快路一致）；
      //   真旋转/缩放 → EPX 放大平面 + nearest（shader 只见 mode 0 + 大纹理，无独立 mode）。
      if (smode === "rotsprite" && src.rotsprite) {
        const dq = sourceDestQuad(src.rect, float.gizmoFrame as Parameters<typeof sourceDestQuad>[1], float.mesh as Parameters<typeof sourceDestQuad>[2]);
        const rigid = dq ? integerRigidOf(src.rect, dq as Parameters<typeof integerRigidOf>[1]) : null;
        if (rigid) {
          out.push({ layerId: src.layerId, srcW: src.rect.w, srcH: src.rect.h, hinv: wp.hinv, mode: 0, u8Plane: src.bytes });
        } else {
          out.push({ layerId: src.layerId, srcW: src.rotsprite.w, srcH: src.rotsprite.h, hinv: wp.hinv, mode: 0, u8Plane: src.rotsprite });
        }
        continue;
      }
      // spline（mode 3）需要系数平面（floating-transform.current() 在 spline 模式下附带）；缺了退 bicubic
      const m = (mode === 3 && !src.spline) ? 2 : mode;
      out.push({ layerId: src.layerId, srcW: src.rect.w, srcH: src.rect.h, hinv: wp.hinv, mode: m, splinePlane: src.spline ?? null, u8Plane: src.bytes });
    }
    return out;
  }

  // （旧 _renderPartial / clip-window + Windows 黑缝 floor-ceil 补丁已删：v275 拥抱 full-composite，
  //   静态走 1:1 缓存、实时直接合成。partial 的两类缝隙问题（白缝/黑缝）随之消失。）

  // 实时预览中？= 调整 surrogate / stroke 进行中 / 活动浮层 / fill 预览挂着。GL 路径用它门控 syncAll/release。
  _isLivePreview() {
    return !!(this._activeSurrogateBytes
      || (this._strokeActiveHint && this._strokeActiveHint())
      // 活动浮层（自由变换）→ 走实时合成（浮层经 floatFor 插在源层 z；mesh 每帧变，不能用静态缓存）。
      || this._lassoProvider?.()?.floating
      // fill 预览（v0.5.11）：overlay 插在活动层 slot，同 floating 待遇（渲染仍按需触发，静置零成本）。
      || this._fillProvider?.());
  }
  // S9 导出/缩略图/mergedimage/镜像的合成面（doc-render.setDocCompositor 的后端）：透明底。
  compositeNodesToCanvas(nodes: unknown[], docW: number, docH: number): HTMLCanvasElement | null {
    if (!this._glBoard) return null;
    return this._glBoard.compositeToCanvas(nodes as unknown as Parameters<GLBoard["compositeToCanvas"]>[0], docW, docH);
  }
  // 字节合成面（doc-render.setDocCompositorBytes 的后端；merge-down 等字节 op 用）。
  compositeNodesToBytes(nodes: unknown[], docW: number, docH: number): { data: Uint8ClampedArray; w: number; h: number } | null {
    if (!this._glBoard) return null;
    return this._glBoard.compositeToBytes(nodes as unknown as Parameters<GLBoard["compositeToBytes"]>[0], docW, docH);
  }

  // 吸管 composite 取色（S8c，spec:243-244）：GL 一次性合成（compositeOnce，不建缓存）+ 1px readback。
  //   走 GPU 的动机：合成组是没有 CPU tile 的（spec:244），CPU 全量 compositeLayers 缓存随之退役。
  //   GL 失败态返 null（v351 起无 WebGL2 = 无画布）。底与显示同源（棋盘/背景色）。
  pickCompositeColor(ix: number, iy: number): [number, number, number, number] | null {
    if (!this._glBoard) return null;
    const docBg = this._showCheckerboard ? "checker" : (this.doc.backgroundColor || "#ffffff");
    // v0.4.11（拍板#8）：调整预览开着时取替身（WYSIWYG——吸到的=眼睛看到的）。
    // v0.5.11（user 拍板）：fill 预览挂着时同款待遇——吸到的=预览色，不是底下真实像素。
    return this._glBoard.pickColor(this.doc as unknown as GLDoc, docBg, ix, iy, this._glSurrogate(), this._glFillOverlay());
  }
  // 套索 overlay：
  //   drawing 期间：画 polyline overlay
  //   floating：用 mesh 三角剖分画浮层；画 mesh 边框 + 内部线 + handles
  // 边框 / mesh 线在 doc 坐标系（随缩放）；handles 在 screen 坐标（恒定像素大小）
  _drawLassoOverlay(ctx: Ctx2D, scale: number) {
    if (!this._lassoProvider) return;
    const info = this._lassoProvider();
    if (!info) return;
    // (a) 选区蚂蚁线：marching squares 抽 mask 轮廓 → 黑白相间虚线。
    // 真"相间"：dash 和 gap 等长，白色 dashOffset 偏一个 dash，正好填黑的空位。
    // 不要动画（user 反馈太干扰）。线宽 1 / scale = 1 CSS px。
    if (info.selection && !info.floating && info.showAnts !== false) {
      const s = info.selection;
      const chains = antsOutline(s as Selection);
      ctx.save();
      // 用 polyline chains（每条 = 一个 subpath）让 dash 沿整条边流。
      // 否则 marching squares 几百段都是 ~1 doc px 短 subpath，dash 在每段
      // 重置 → 段内永远 "on" 阶段 → 看不到相间。
      // 屏幕常量大小：lineWidth / dash 都 / scale，渲到 doc-transform ctx 之后
      // 都是固定 CSS px 宽（缩放不变）。
      const dash = 4 / scale;
      ctx.lineWidth = 1.2 / scale;
      ctx.lineCap = "butt";
      ctx.setLineDash([dash, dash]);
      ctx.beginPath();
      for (const ch of chains) {
        ctx.moveTo(ch[0], ch[1]);
        for (let i = 2; i < ch.length; i += 2) ctx.lineTo(ch[i], ch[i + 1]);
      }
      ctx.lineDashOffset = 0;
      ctx.strokeStyle = "#000";
      ctx.stroke();
      ctx.lineDashOffset = dash;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      ctx.restore();
    }
    // (b) 正在画的 path —— 风格跟蚂蚁线一致（user：drawing → endPath 不要突变）
    if (info.drawingPath && info.drawingPath.length >= 2) {
      const dash = 4 / scale;
      ctx.save();
      ctx.lineWidth = 1.2 / scale;
      ctx.lineCap = "butt";
      ctx.setLineDash([dash, dash]);
      ctx.beginPath();
      const pts = info.drawingPath;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.lineDashOffset = 0;
      ctx.strokeStyle = "#000";
      ctx.stroke();
      ctx.lineDashOffset = dash;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      ctx.restore();
    }
    // (b2) v0.6.25 多边形闭合提示（user 拍板）：首顶点常显小方点；光标/预览端进 14 screen px
    //   闭合范围（同 input._polygonUp 的判定半径，视口坐标）→ 变 transform 手柄同款实心圆
    if (info.polyFirst) {
      const f0 = info.polyFirst;
      const path = info.drawingPath;
      const tip = path && path.length >= 2 ? path[path.length - 1] : null;
      const inRange = !!tip && Math.hypot(tip.x - f0.x, tip.y - f0.y) * scale <= 14;
      ctx.save();
      if (inRange) {
        ctx.beginPath();
        ctx.arc(f0.x, f0.y, 7 / scale, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.lineWidth = 1.5 / scale;
        ctx.stroke();
      } else {
        const r = 3.5 / scale;
        ctx.beginPath();
        ctx.rect(f0.x - r, f0.y - r, r * 2, r * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.lineWidth = 1.2 / scale;
        ctx.stroke();
      }
      ctx.restore();
    }
    // (c) 正在拖的矩形 / 椭圆 —— 同 style
    const drawShape = info.drawingRect || info.drawingEllipse;
    if (drawShape) {
      const r = drawShape;
      const dash = 4 / scale;
      ctx.save();
      ctx.lineWidth = 1.2 / scale;
      ctx.setLineDash([dash, dash]);
      const x = Math.min(r.x0, r.x1), y = Math.min(r.y0, r.y1);
      const w = Math.abs(r.x1 - r.x0), h = Math.abs(r.y1 - r.y0);
      const isEllipse = !!info.drawingEllipse;
      const stroke2x = () => {
        ctx.strokeStyle = "#000";
        ctx.lineDashOffset = 0;
        ctx.stroke();
        ctx.strokeStyle = "#fff";
        ctx.lineDashOffset = dash;
        ctx.stroke();
      };
      ctx.beginPath();
      if (isEllipse) ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      else ctx.rect(x, y, w, h);
      stroke2x();
      ctx.restore();
    }
    if (info.floating) {
      const f = info.floating;
      ctx.save();
      // 浮层**像素**已移到规范合成器（compositeLayers 的 floatFor，插在源层 z；note #2）。
      //   这里只画 gizmo chrome（框线 + handles）——工具 UI 永在所有层之上。
      // 1) mesh 网格线 + 外框
      const N = f.meshN;
      // 外框（4 角连成的"包络"），所有模式都画一条主线
      ctx.lineWidth = Math.max(1, 1.5 / scale);
      ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.beginPath();
      ctx.moveTo(f.mesh[0][0].x, f.mesh[0][0].y);
      for (let j = 1; j < N; j++) ctx.lineTo(f.mesh[0][j].x, f.mesh[0][j].y);
      for (let i = 1; i < N; i++) ctx.lineTo(f.mesh[i][N-1].x, f.mesh[i][N-1].y);
      for (let j = N - 2; j >= 0; j--) ctx.lineTo(f.mesh[N-1][j].x, f.mesh[N-1][j].y);
      for (let i = N - 2; i >= 1; i--) ctx.lineTo(f.mesh[i][0].x, f.mesh[i][0].y);
      ctx.closePath();
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineDashOffset = 5 / scale;
      ctx.stroke();
      ctx.restore();
      // 3) handles 切屏幕坐标画：白圆 + 黑边；rotate handle 带连接线
      if (info.handles && info.handles.length) {
        ctx.save();
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        for (const h of info.handles) {
          const s = this.docToScreen(h.pos.x, h.pos.y);
          if (h.kind === "rotate") {
            // v117/118 rotate handle：白圆 + 黑边 + 从 anchor (top mid) 画一条连接线
            // v118: 删内部小弧 icon (user：「rotation handle 上面不需要那个小弧线 icon」)
            if (h.anchor) {
              const a = this.docToScreen(h.anchor.x, h.anchor.y);
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(s.x, s.y);
              ctx.strokeStyle = "rgba(0,0,0,0.6)";
              ctx.lineWidth = 1;
              ctx.stroke();
            }
            ctx.beginPath();
            ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
            ctx.fillStyle = "#fff";
            ctx.fill();
            ctx.strokeStyle = "rgba(0,0,0,0.85)";
            ctx.lineWidth = 1.5;
            ctx.stroke();
          } else if (h.kind === "basisRotate") {
            // v0.6.21 方手柄（转参考 frame 轴不动像素）：白方 + 黑边 + anchor 连接线，与圆手柄成对
            if (h.anchor) {
              const a = this.docToScreen(h.anchor.x, h.anchor.y);
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(s.x, s.y);
              ctx.strokeStyle = "rgba(0,0,0,0.6)";
              ctx.lineWidth = 1;
              ctx.stroke();
            }
            ctx.beginPath();
            ctx.rect(s.x - 6, s.y - 6, 12, 12);
            ctx.fillStyle = "#fff";
            ctx.fill();
            ctx.strokeStyle = "rgba(0,0,0,0.85)";
            ctx.lineWidth = 1.5;
            ctx.stroke();
          } else {
            // free / uniform / distort：白圆 + 黑边明显 handle
            ctx.beginPath();
            ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
            ctx.fillStyle = "#fff";
            ctx.fill();
            ctx.strokeStyle = "rgba(0,0,0,0.85)";
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }
  }

  // 像素栅格：独立 canvas，仅视口变（sig 变）才重画。stroke 中视口不变 → no-op → 零逐帧成本（所有笔型）。
  _syncGrid() {
    const cv = this.gridCanvas;
    if (!cv || !this.doc) return;
    const v = this.viewport;
    const sig = `${v.scale}|${v.tx}|${v.ty}|${v.rot}|${this._pixelGridEnabled}|${this._docGridOn}|${this._docGridCell}|${this.doc.width}|${this.doc.height}|${this.canvas.width}`;
    if (sig === this._gridSig) return;
    this._gridSig = sig;
    this._drawGrid();
    this._updateCursorEl();   // scale 变 → 光标尺寸也跟着变
  }
  _drawGrid() {
    const cv = this.gridCanvas;
    if (!cv || !this.doc) return;
    const { scale, tx, ty, rot } = this.viewport;
    const pixelOn = this._pixelGridEnabled && scale >= PIXEL_GRID_FADE_LO;   // 像素栅格：保留自动隐藏/渐显
    const mainOn = this._docGridOn && this._docGridCell >= 2;                // #10 主栅格：一直显示
    // 两套都不显 → 释放 backing（width=0）不占显存
    if (!pixelOn && !mainOn) {
      cv.style.display = "none";
      if (cv.width) { cv.width = 0; cv.height = 0; }
      return;
    }
    const cw = this.canvas.width, ch = this.canvas.height;   // device px（同主 canvas）
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    cv.style.display = "block";
    const g = this.gctx || (this.gctx = cv.getContext("2d")!);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cw, ch);
    // 可见 doc 区间（screen 四角逆变换 → doc AABB，裁到画布）
    const W = this.doc.width, H = this.doc.height;
    const sw = this.canvas.clientWidth || cw / this.dpr, sh = this.canvas.clientHeight || ch / this.dpr;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of [[0, 0], [sw, 0], [0, sh], [sw, sh]]) {
      const p = this.screenToDoc(c[0], c[1]);
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const dpr = this.dpr;
    // 画一族间隔 step doc-px 的网格线（像素/主栅格共用；线对齐 doc 原点的 step 倍数格）
    const drawLines = (step: number, stroke: string) => {
      const x0 = Math.max(0, Math.floor(minX / step) * step), x1 = Math.min(W, Math.ceil(maxX / step) * step);
      const y0 = Math.max(0, Math.floor(minY / step) * step), y1 = Math.min(H, Math.ceil(maxY / step) * step);
      if (x1 < x0 || y1 < y0) return;
      const cy0 = Math.max(0, minY), cy1 = Math.min(H, maxY);   // 线段在 doc 内的可见跨度
      const cx0 = Math.max(0, minX), cx1 = Math.min(W, maxX);
      g.fillStyle = stroke;
      if (!rot) {
        // rot=0：device-px 取整 fillRect → 1 device px 清晰均匀（无 AA、无 sub-pixel 糊）
        const vy0 = Math.max(0, Math.round((ty + cy0 * scale) * dpr));
        const vy1 = Math.min(ch, Math.round((ty + cy1 * scale) * dpr));
        const vx0 = Math.max(0, Math.round((tx + cx0 * scale) * dpr));
        const vx1 = Math.min(cw, Math.round((tx + cx1 * scale) * dpr));
        for (let x = x0; x <= x1; x += step) g.fillRect(Math.round((tx + x * scale) * dpr), vy0, 1, vy1 - vy0);
        for (let y = y0; y <= y1; y += step) g.fillRect(vx0, Math.round((ty + y * scale) * dpr), vx1 - vx0, 1);
      } else {
        // rot≠0（罕见）：斜线走 stroke（AA），不强求 device 对齐
        g.strokeStyle = stroke;
        g.lineWidth = 1;
        g.beginPath();
        for (let x = x0; x <= x1; x += step) {
          const a = this.docToScreen(x, Math.max(0, y0)), b = this.docToScreen(x, Math.min(H, y1));
          g.moveTo(a.x * dpr, a.y * dpr); g.lineTo(b.x * dpr, b.y * dpr);
        }
        for (let y = y0; y <= y1; y += step) {
          const a = this.docToScreen(Math.max(0, x0), y), b = this.docToScreen(Math.min(W, x1), y);
          g.moveTo(a.x * dpr, a.y * dpr); g.lineTo(b.x * dpr, b.y * dpr);
        }
        g.stroke();
      }
    };
    if (pixelOn) {
      // LO→FULL 线性渐隐
      const fade = Math.min(1, (scale - PIXEL_GRID_FADE_LO) / (PIXEL_GRID_FULL - PIXEL_GRID_FADE_LO));
      drawLines(1, `rgba(128,128,128,${PIXEL_GRID_ALPHA * fade})`);
    }
    if (mainOn) {
      // #10：不渐隐——缩小到 cell 间距 < MAIN_GRID_MIN_SPACING 屏幕px 时退化成每 2/4/8… 格画一根，防糊成片
      let step = this._docGridCell;
      while (step * scale < MAIN_GRID_MIN_SPACING && step < 1 << 20) step *= 2;
      drawLines(step, `rgba(128,128,128,${MAIN_GRID_ALPHA})`);
    }
  }
}

function clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)); }
