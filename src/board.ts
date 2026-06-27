// Board = 显示层。把 PaintDoc 合成到屏幕 <canvas> 上 + 视口 pan/zoom + cursor 预览。
import { renderSource } from "./floating-transform.ts";
import { compositeLayers } from "./layer-composite.ts";
import { makeBitmap } from "./bitmap.ts";
import { GLBoard, glBoardEnabled } from "./gl/gl-board.ts";
import { poolCapacityForBudget } from "./gl/gl-doc-renderer.ts";
import type { OverlayInput } from "./gl/gl-doc-renderer.ts";
import type { GLDoc } from "./gl/gl-board.ts";
import type { PaintDoc, Layer } from "./doc.ts";

// ---- 本文件用到的结构类型（局部定义，只覆盖 board 实际访问的成员）----

// viewport: screen = R(rot, doc_center) ∘ scale ∘ translate(tx,ty)
interface Viewport { tx: number; ty: number; scale: number; rot: number; }

// 光标预览（screen CSS px；size 是 doc px）
interface Cursor { x: number; y: number; size: number; square?: boolean; }

// 选区（doc.selection）：alpha mask + bbox（与 selection-ops 的形状一致）
interface Selection {
  bboxX: number; bboxY: number; bboxW: number; bboxH: number;
  maskCanvas: CanvasImageSource;
  outline(): number[][];
}

// 笔刷 live overlay 描述（compositeLayers 的 overlayFor 接缝；canvas 指向裁过的离屏）
interface OverlayDesc {
  layer: Layer;
  canvas: CanvasImageSource;
  bboxX: number; bboxY: number; bboxW: number; bboxH: number;
}

// 自由变换浮层网格点 / source / float 描述（lassoInfo.floating）
interface MeshPt { x: number; y: number; }
// renderSource() 的回值缓存（{canvas, dstX, dstY} | null），形状对 board 不透明
type RenderCache = { canvas: CanvasImageSource; dstX: number; dstY: number } | null;
interface FloatSource { layer: Layer; _renderCache?: RenderCache; }
interface FloatInfo {
  sources: FloatSource[];
  gizmoBbox: unknown;
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
  floating?: FloatInfo | null;
  drawingPath?: MeshPt[] | null;
  drawingRect?: { x0: number; y0: number; x1: number; y1: number } | null;
  drawingEllipse?: { x0: number; y0: number; x1: number; y1: number } | null;
  handles?: Handle[] | null;
  sampleMode?: string;
}

type Ctx2D = CanvasRenderingContext2D;
type ViewportChangeCb = (() => void) | null;
// makeBitmap 的回值：OffscreenCanvas（优先）或 HTMLCanvasElement（回退）
type Bitmap = HTMLCanvasElement | OffscreenCanvas;
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
  _dirtyDocRect: [number, number, number, number] | null;
  _dirtyFull: boolean;
  _voidColor: string;
  _showCheckerboard: boolean;
  _pixelGridEnabled: boolean;
  _overlayProvider: (() => OverlayDesc | null | undefined) | null;
  _eraseComposite: HTMLCanvasElement | null;
  _eraseCompositeKey: string | null;
  gridCanvas: HTMLCanvasElement | null;
  gctx: Ctx2D | null;
  cursorEl: HTMLElement | null;
  _gridSig: string;
  // 按需创建 / 延迟初始化的字段
  _compositeCacheDirty?: boolean;
  _compositeCache?: Bitmap | null;
  _strokeActiveHint?: (() => unknown) | null;
  _lassoProvider?: (() => LassoInfo | null | undefined) | null;
  _activeSurrogateLayerId?: number | null;
  _activeSurrogateCanvas?: CanvasImageSource | null;
  _clipTmp?: HTMLCanvasElement;
  _overlayClipTmp?: HTMLCanvasElement;
  _showFps?: boolean;
  _lastFrameT?: number | null;
  _fps?: number | null;
  _fpsEl?: HTMLElement;
  static _dispatchingDirty?: boolean;
  // WebGL2 渲染（?glboard=1 开关后；默认关 → 全 null，2D 路径不变）。
  _glOn?: boolean;
  _glBoard?: GLBoard | null;
  _glCanvas?: HTMLCanvasElement | null;

  constructor(canvas: HTMLCanvasElement, doc: PaintDoc) {
    this.canvas = canvas;
    // GL 模式（?glboard=1）：2D canvas 用 alpha:true（透明，只画 overlay/边框，GL canvas 在后透出 doc）。
    //   默认关 → alpha:false，2D 路径逐字不变。（alpha=true ⟺ glOn：GL 模式要透明叠层）
    this._glOn = glBoardEnabled();
    this.ctx = canvas.getContext("2d", { alpha: this._glOn })!;
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

    // Dirty tracking：
    // _dirtyDocRect = 笔触改了的 doc-px bbox（[x0,y0,x1,y1]），渲染时只 blit 这一片
    // _dirtyFull    = 视口 / 主题 / 光标 / 图层结构改了 → 整张重画
    this._dirtyDocRect = null;
    this._dirtyFull = true;

    // 主题色：从 CSS 变量取
    this._voidColor = "#e6e2d6";
    // 棋盘背景：开后底层用半透明灰白格替代 doc.backgroundColor。
    // 适合做透明素材 / 看图层 alpha 通道。
    this._showCheckerboard = false;
    // v163 像素栅格：放大到 PIXEL_GRID_FADE_LO 以上渐显 1 doc-px 网格（像素画对齐）。
    //   只画可见区域格线（性能）；很细很淡；全局开关可关。
    this._pixelGridEnabled = true;

    // Live overlay provider：渲染时调一次，返回 {canvas, layer, opacity, mode} 或 null。
    // 笔触进行中由 brush.getLiveOverlay() 提供。paint 模式：layer 之上 composite buffer×opacity。
    // erase 模式：把 layer 画进 _eraseComposite，对它 dst-out buffer×opacity，再画到屏幕。
    this._overlayProvider = null;
    this._eraseComposite = null;
    this._eraseCompositeKey = null;

    // v163 瞬态 UI 分层（省 hot-path + 显存，详 docs/overlay-grid-cursor-layers.md）：
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

    // GL 渲染器（开关开时）：建 GL canvas 垫在 #board 之下 + GLBoard。失败则回退 2D（_glBoard=null）。
    this._glBoard = null;
    this._glCanvas = null;
    if (this._glOn) this._setupGLBoard();

    // 首次：把 doc 居中适配
    this.fitToScreen();
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
      console.warn("[board] GL 初始化失败，回退 2D：", e);
      if (this._glCanvas) { this._glCanvas.remove(); this._glCanvas = null; }
      this._glBoard = null;
    }
  }

  setDoc(doc: PaintDoc) {
    this.doc = doc;
    this._dirtyFull = true;
    this._compositeCacheDirty = true;   // 新 doc → 合成缓存作废
    this._glBoard?.markContentDirty();   // GL：新 doc → 全量重传
    this.fitToScreen();
  }

  setShowCheckerboard(on: boolean) {
    this._showCheckerboard = !!on;
    this._dirtyFull = true;
  }
  setPixelGridEnabled(on: boolean) {
    this._pixelGridEnabled = !!on;
    this._gridSig = "";        // 强制下次 _syncGrid 重算
    this.requestRender();
  }
  getPixelGridEnabled() { return this._pixelGridEnabled; }
  setThemeColors({ voidColor }: { voidColor?: string }) {
    if (voidColor) this._voidColor = voidColor;
    this._dirtyFull = true;
    this.requestRender();
  }

  // 由 BrushEngine 报告："这一帧 layer 像素被改在这片 doc-px bbox 里"
  markDocDirty(x0: number, y0: number, x1: number, y1: number) {
    this._compositeCacheDirty = true;   // 像素改 → 合成缓存作废（描边中走直接合成，commit 后才重建）
    this._glBoard?.markContentDirty();   // GL：内容脏（描边中 livePreview 守门不重传，抬笔 commit 后才同步）
    if (this._dirtyDocRect) {
      const d = this._dirtyDocRect;
      if (x0 < d[0]) d[0] = x0;
      if (y0 < d[1]) d[1] = y0;
      if (x1 > d[2]) d[2] = x1;
      if (y1 > d[3]) d[3] = y1;
    } else {
      this._dirtyDocRect = [x0, y0, x1, y1];
    }
    // 通知挂在 doc 上的旁观者（如 reference live 镜像）。每个 brush stamp 都会触发，
    // 但 reference 端 markLiveDirty 仅置 flag + 走 rAF，不真合成，开销 ≪ 1ms。
    if (!Board._dispatchingDirty) {
      Board._dispatchingDirty = true;
      window.dispatchEvent(new CustomEvent("wp:docpixeldirty"));
      Board._dispatchingDirty = false;
    }
  }
  // 视口 / 主题 / 光标 / 图层结构改了 → 整张重画
  markFullDirty() {
    this._dirtyFull = true;
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
    this._dirtyFull = true;
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
    this._dirtyFull = true;
    this.requestRender();
  }

  // rotateAt 围绕 screen anchor 旋转视口（delta 是 radian 增量）
  rotateAt(anchorX: number, anchorY: number, deltaRot: number) {
    const docPt = this.screenToDoc(anchorX, anchorY);
    this.viewport.rot += deltaRot;
    const after = this.docToScreen(docPt.x, docPt.y);
    this.viewport.tx += anchorX - after.x;
    this.viewport.ty += anchorY - after.y;
    this._dirtyFull = true;
    this.requestRender();
  }

  setViewport(tx: number, ty: number, scale: number, rot?: number) {
    this.viewport.tx = tx;
    this.viewport.ty = ty;
    this.viewport.scale = clamp(scale, this.minScale, this.maxScale);
    if (typeof rot === "number") this.viewport.rot = rot;
    this._clampPan();   // 双指 pan / 程序设位也受边界约束（fitToScreen 居中 → no-op）
    this._dirtyFull = true;
    this.requestRender();
  }

  // 适配屏幕：让 doc 居中并铺满（留一点边）。同时复位 rotation。
  fitToScreen(padding: number = 24) {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (!this.doc) return;
    const sx = (w - padding * 2) / this.doc.width;
    const sy = (h - padding * 2) / this.doc.height;
    const s = Math.min(sx, sy);
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
    const tx = (w - this.doc.width * scale) / 2;
    const ty = (h - this.doc.height * scale) / 2;
    this.setViewport(tx, ty, scale, 0);   // 复位 rotation
  }

  // 公共 API：layer 像素被改了（图层结构变 / 切换 / putImageData 等）
  invalidateAll() {
    this._dirtyFull = true;
    this._compositeCacheDirty = true;   // 图层/结构/doc-transform 变 → 合成缓存作废
    this._glBoard?.markContentDirty();   // GL：图层/结构变 → 全量重传
    this.requestRender();
  }

  // v131: liquify / filter brush 等没用 overlay 但仍需禁 partial。fn 返回 truthy = 强全屏
  setStrokeActiveHint(fn: (() => unknown) | null) { this._strokeActiveHint = fn; }

  setOverlayProvider(fn: (() => OverlayDesc | null | undefined) | null) {
    this._overlayProvider = fn;
  }
  // 套索 overlay：在 layer 像素之上画一条 polygon (drawing) 或 floating canvas + marching ants
  setLassoProvider(fn: (() => LassoInfo | null | undefined) | null) {
    this._lassoProvider = fn;
  }
  // v110: 给某 layer 在 board 渲染时套 ctx.filter（颜色调整 live preview）—— v113 撤
  // ctx.filter on iPad Safari Canvas2D 偶发不渲染 (user：「颜色调整预览，apply 都没用」)
  setActiveLayerFilter() { /* no-op, replaced by surrogate */ }
  // v113: 颜色调整 live preview 走 surrogate canvas（per-pixel JS BCSH 之后塞进来）
  // (layerId, canvas) 启动；(null, null) 关
  setActiveLayerSurrogate(layerId: number | null, canvas: CanvasImageSource | null) {
    this._activeSurrogateLayerId = layerId;
    this._activeSurrogateCanvas = canvas;
    this.invalidateAll();
  }

  // 复用 erase 临时合成 canvas（同 doc 尺寸；改了重新分配）
  _getEraseComposite(w: number, h: number) {
    const key = `${w}x${h}`;
    if (!this._eraseComposite || this._eraseCompositeKey !== key) {
      this._eraseComposite = document.createElement("canvas");
      this._eraseComposite.width = w;
      this._eraseComposite.height = h;
      this._eraseCompositeKey = key;
    }
    return this._eraseComposite;
  }
  // Clipping mask 临时合成 canvas。grow-only：取所有用过的 layer.bbox 最大值。
  // 不和 _eraseComposite 共用（同一帧可能两者都要）。
  _getClipTmp(w: number, h: number) {
    if (!this._clipTmp || this._clipTmp.width < w || this._clipTmp.height < h) {
      const nw = Math.max(this._clipTmp?.width || 0, w);
      const nh = Math.max(this._clipTmp?.height || 0, h);
      this._clipTmp = document.createElement("canvas");
      this._clipTmp.width = nw;
      this._clipTmp.height = nh;
    }
    return this._clipTmp;
  }
  // Overlay 选区裁剪临时 canvas。同一帧 ≤ 1 颗 active 层有 overlay，独占用。
  _getOverlayClipTmp(w: number, h: number) {
    if (!this._overlayClipTmp || this._overlayClipTmp.width < w || this._overlayClipTmp.height < h) {
      const nw = Math.max(this._overlayClipTmp?.width || 0, w);
      const nh = Math.max(this._overlayClipTmp?.height || 0, h);
      this._overlayClipTmp = document.createElement("canvas");
      this._overlayClipTmp.width = nw;
      this._overlayClipTmp.height = nh;
    }
    return this._overlayClipTmp;
  }
  // 把笔刷 live overlay 按 选区 mask + 锁α layer alpha 裁，让画中实时看到限制范围。
  // 返回一个**新 overlay 描述**，canvas 指向裁过的临时 canvas；bbox 保持不变（局部坐标不变）。
  // 落笔后 Selection.applyMaskPostStroke / source-atop 做最终持久化裁；这里只是 preview。
  //   单 tmp 内多个 dst-in 顺序求交（先读原 overlay 一次，再叠 mask）——不会自绘清空。
  _clipOverlayMasks(overlay: OverlayDesc, selection: Selection | null, lockLayer: Layer | null) {
    const tmp = this._getOverlayClipTmp(overlay.bboxW, overlay.bboxH);
    const tctx = tmp.getContext("2d")!;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, overlay.bboxW, overlay.bboxH);
    tctx.drawImage(overlay.canvas, 0, 0);
    if (selection) {
      tctx.globalCompositeOperation = "destination-in";
      tctx.drawImage(selection.maskCanvas, selection.bboxX - overlay.bboxX, selection.bboxY - overlay.bboxY);
    }
    if (lockLayer) {
      // 锁α：dst-in layer 现有像素的 alpha。空层（无像素）→ 清空（没有可着色的地方）。
      if (lockLayer.bboxW > 0 && lockLayer.bboxH > 0) {
        tctx.globalCompositeOperation = "destination-in";
        tctx.drawImage(lockLayer.canvas, lockLayer.bboxX - overlay.bboxX, lockLayer.bboxY - overlay.bboxY);
      } else {
        tctx.clearRect(0, 0, overlay.bboxW, overlay.bboxH);
      }
    }
    tctx.globalCompositeOperation = "source-over";
    return { ...overlay, canvas: tmp };
  }
  // 注：层合成（含 clip dst-in 基底、erase/混合 overlay 复合通路）已下沉到 src/layer-composite.js
  //   （deep module A）。board 经 _renderLayers 的 opts 注入 surrogate / overlay 裁剪 / tmp 池。

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
    this._dirtyFull = true;
    this._gridSig = "";   // 尺寸变 → 强制重算栅格 div
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
      const r = Math.max(2, this._cursor.size * this.viewport.scale / 2);
      el.style.width = el.style.height = (2 * r) + "px";
      el.style.transform = `translate(${this._cursor.x - r}px, ${this._cursor.y - r}px)`;
      el.classList.toggle("square", !!this._cursor.square);   // v232：像素笔方形 preview
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
    this._dirtyDocRect = null;
    this._dirtyFull = false;
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
    this._ensureFpsEl().textContent = `${this._fps ? this._fps.toFixed(0) : "--"} fps`;
  }

  _renderFull() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;

    // GL 模式：doc(底+背景+图层) 走 GL canvas；本 2D canvas 只画 overlay/边框（透明底，GL 透出）。
    if (this._glBoard) { this._renderFullGL(ctx, W, H); return; }

    // 1) 底色
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this._voidColor;
    ctx.fillRect(0, 0, W, H);

    // 2) 切到 doc 坐标系（含 dpr / scale / rot / translate）
    this._applyDocTransform(ctx);
    const { scale } = this.viewport;

    // v100：放大查看（scale > 1）走 nearest-neighbor，看像素级细节
    // user：「画布当放缩 > 1 的时候改成 nearest neighbor」
    if (scale > 1) {
      ctx.imageSmoothingEnabled = false;
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = scale < 0.5 ? "low" : "high";
    }

    // doc 背景 + 图层。**一致性铁律**：实时与缓存都让 layer blend 落在**同一底**（doc bg）上，
    //   否则混合模式（multiply 等）实时(over bg) ≠ 缓存(over 透明) → 抬笔"弹回"（v275 回归 bug）。
    //   白边修：静态走 1:1 doc 合成缓存（bg+layers 整数对齐）+ 单次缩放 blit；实时直接合成保手感。
    if (this._isLivePreview()) {
      this._drawDocBg(ctx);
      this._renderLayers(ctx);
    } else {
      this._blitCompositeCache(ctx);   // 缓存已含 doc bg（与实时同底）
    }

    // 套索 overlay（蚂蚁线 / drawing path / floating / handles，doc 坐标系）
    this._drawLassoOverlay(ctx, scale);

    // doc 边框（doc 坐标系下；lineWidth 在缩放 / 旋转下会变粗细，需要 inverse-scale lineWidth）
    // 栅格 = CSS div（_syncGrid），光标 = DOM div（_updateCursorEl），都不在这条 canvas hot path。
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, this.doc.width, this.doc.height);
  }

  // GL 渲染路径：GL canvas 渲 doc（void 底 + doc 背景 + 图层 + live overlay，视口仿射）；
  //   本 2D canvas 清透明、只画 lasso overlay + doc 边框（GL 透出 doc）。
  _renderFullGL(ctx: Ctx2D, W: number, H: number) {
    const docBg = this._showCheckerboard ? null : (this.doc.backgroundColor || "#ffffff");   // 棋盘 first cut 显 void
    this._glBoard!.render(
      this.doc as unknown as GLDoc,
      this._docTransformParams(),
      W, H, this.viewport.scale, this._voidColor, docBg,
      this._isLivePreview(), this._glOverlayInput(),
    );
    // 2D 叠层（透明底）：lasso 蚂蚁线/handles + doc 边框
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this._applyDocTransform(ctx);
    const { scale } = this.viewport;
    this._drawLassoOverlay(ctx, scale);
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, this.doc.width, this.doc.height);
  }

  // live 描边 overlay → GL 输入（选区/锁α 裁剪与 2D 路径一致；blendMode-overlay 暂按 source-over）。
  _glOverlayInput(): OverlayInput | null {
    let overlay = this._overlayProvider?.();
    if (!overlay) return null;
    const layer = overlay.layer;
    if (this.doc.selection || layer.lockAlpha) {
      overlay = this._clipOverlayMasks(overlay, this.doc.selection as unknown as Selection | null, layer.lockAlpha ? layer : null) as OverlayDesc | undefined;
    }
    if (!overlay) return null;
    const o = overlay as OverlayDesc & { opacity?: number; mode?: string };
    return { canvas: o.canvas, bboxX: o.bboxX, bboxY: o.bboxY, bboxW: o.bboxW, bboxH: o.bboxH, layerId: o.layer.id, opacity: o.opacity ?? 1, erase: o.mode === "erase" };
  }

  // doc 底色（棋盘 = 透明指示；否则 backgroundColor）。实时路径画到屏幕、缓存路径画到离屏——
  //   两处用同一底，保混合模式合成一致（见 _renderFull / ensureCompositeCache）。
  _drawDocBg(ctx: Ctx2D) {
    if (this._showCheckerboard) {
      this._drawCheckerboard(ctx, this.doc.width, this.doc.height);
    } else {
      ctx.fillStyle = this.doc.backgroundColor || "#ffffff";
      ctx.fillRect(0, 0, this.doc.width, this.doc.height);
    }
  }

  // （旧 _renderPartial / clip-window + Windows 黑缝 floor-ceil 补丁已删：v275 拥抱 full-composite，
  //   静态走 1:1 缓存、实时直接合成。partial 的两类缝隙问题（白缝/黑缝）随之消失。）

  // board 注入规范合成器（deep module A）的实时特性 opts：
  //   - source: 颜色调整 live preview 的 surrogate canvas 替换
  //   - overlayFor: 笔刷 live overlay（含 选区 + 锁α 的 preview 裁剪，与 pen-up 的 source-atop 一致）
  //   - clipTmp / eraseTmp: board 的复用离屏池（grow-only，避免每帧分配）
  _layerCompositeOpts() {
    const overlay = this._overlayProvider?.();
    // 自由变换浮层：渲染插在源层 z 位（compositeLayers 的 floatFor 接缝）。render 缓存到 f._renderCache，
    //   mesh 变了 FloatingTransform 那边 invalidate。Slice 3 起 float 可有多 source → 按 node 匹配多次返回。
    const lassoInfo = this._lassoProvider?.();
    const float = (lassoInfo && lassoInfo.floating) ? lassoInfo.floating : null;
    return {
      source: (layer: Layer) =>
        (this._activeSurrogateLayerId === layer.id && this._activeSurrogateCanvas)
          ? this._activeSurrogateCanvas : layer.canvas,
      overlayFor: (layer: Layer) => {
        let lOverlay: OverlayDesc | null = overlay && overlay.layer === layer ? overlay : null;
        if (lOverlay && (this.doc.selection || layer.lockAlpha)) {
          lOverlay = this._clipOverlayMasks(lOverlay, this.doc.selection as unknown as Selection | null, layer.lockAlpha ? layer : null);
        }
        return lOverlay;
      },
      floatFor: float ? (node: Layer) => {
        // 多 source（组变换）：按 node 找它的 source；各 source 渲染缓存在自己身上（mesh 变了 FT invalidate）。
        const src = float.sources.find((s) => s.layer === node);
        if (!src) return null;
        if (!src._renderCache) {
          src._renderCache = renderSource(src as unknown as Parameters<typeof renderSource>[0], float.gizmoBbox as Parameters<typeof renderSource>[1], float.mesh as Parameters<typeof renderSource>[2], lassoInfo!.sampleMode as Parameters<typeof renderSource>[3]);
        }
        return src._renderCache;
      } : undefined,
      clipTmp: (w: number, h: number) => this._getClipTmp(w, h),
      eraseTmp: (w: number, h: number) => this._getEraseComposite(w, h),
    };
  }
  // 直接合成到 ctx（ctx 已在 doc 坐标）。实时（描边/调整预览）路径用。
  _renderLayers(ctx: Ctx2D) {
    compositeLayers(ctx, this.doc.layers, this._layerCompositeOpts() as unknown as Parameters<typeof compositeLayers>[2]);
  }
  // 实时预览中？= 有笔刷 overlay / 调整 surrogate / stroke 进行中。实时走直接合成（保手感）；
  //   静态走 1:1 缓存（白边修）。
  _isLivePreview() {
    return !!(this._overlayProvider?.() || this._activeSurrogateCanvas
      || (this._strokeActiveHint && this._strokeActiveHint())
      // 活动浮层（自由变换）→ 走实时合成（浮层经 floatFor 插在源层 z；mesh 每帧变，不能用静态缓存）。
      || this._lassoProvider?.()?.floating);
  }
  // 白边修：把全 doc 合成到 1:1 doc 像素离屏缓存（层间整数对齐，无亚像素缝），再单次缩放 blit。
  //   缓存只在内容脏时重建；pan/zoom（视口变、内容没变）→ 命中缓存只 re-blit（比旧逐层缩放更快）。
  //   吸管取色也读这块缓存（= 最终合成像素，respect mode/clip）。
  ensureCompositeCache() {
    const W = this.doc.width, H = this.doc.height;
    let off = this._compositeCache;
    if (!off || off.width !== W || off.height !== H) {
      off = this._compositeCache = makeBitmap(W, H);
      this._compositeCacheDirty = true;
    }
    if (this._compositeCacheDirty) {
      const octx = (off as HTMLCanvasElement).getContext("2d", { willReadFrequently: true })!;
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.clearRect(0, 0, W, H);
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = "low";
      this._drawDocBg(octx);   // 缓存含 doc bg → 混合模式 over bg，与实时同底（修抬笔"弹回"）
      compositeLayers(octx, this.doc.layers, this._layerCompositeOpts() as unknown as Parameters<typeof compositeLayers>[2]);
      this._compositeCacheDirty = false;
    }
    return off!;
  }
  _blitCompositeCache(ctx: Ctx2D) {
    const off = this.ensureCompositeCache();
    // ctx 已在 doc 坐标（含 dpr/scale/rot）；off 是 doc 1:1 → 单次缩放 blit，层间已整数对齐 = 无白缝。
    ctx.drawImage(off, 0, 0);
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
    if (info.selection && !info.floating) {
      const s = info.selection;
      const chains = s.outline();
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

  // 画 doc 区半透明灰白格背景。在 doc 坐标系下画（cell = 16 doc-px）。
  _drawCheckerboard(ctx: Ctx2D, W: number, H: number) {
    const cell = 16;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#c8c8c8";
    for (let y = 0; y < H; y += cell) {
      for (let x = ((y / cell) | 0) % 2 ? 0 : cell; x < W; x += cell * 2) {
        ctx.fillRect(x, y, cell, cell);
      }
    }
  }
  // 像素栅格：独立 canvas，仅视口变（sig 变）才重画。stroke 中视口不变 → no-op → 零逐帧成本（所有笔型）。
  _syncGrid() {
    const cv = this.gridCanvas;
    if (!cv || !this.doc) return;
    const v = this.viewport;
    const sig = `${v.scale}|${v.tx}|${v.ty}|${v.rot}|${this._pixelGridEnabled}|${this.doc.width}|${this.doc.height}|${this.canvas.width}`;
    if (sig === this._gridSig) return;
    this._gridSig = sig;
    this._drawGrid();
    this._updateCursorEl();   // scale 变 → 光标尺寸也跟着变
  }
  _drawGrid() {
    const cv = this.gridCanvas;
    if (!cv) return;
    const { scale, tx, ty, rot } = this.viewport;
    // 隐藏：释放 backing（width=0）→ 不占显存
    if (!this._pixelGridEnabled || scale < PIXEL_GRID_FADE_LO) {
      cv.style.display = "none";
      if (cv.width) { cv.width = 0; cv.height = 0; }
      return;
    }
    // LO→FULL 线性渐隐
    const fade = Math.min(1, (scale - PIXEL_GRID_FADE_LO) / (PIXEL_GRID_FULL - PIXEL_GRID_FADE_LO));
    const alpha = PIXEL_GRID_ALPHA * fade;
    const stroke = `rgba(128,128,128,${alpha})`;
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
    const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(W, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H, Math.ceil(maxY));
    if (x1 <= x0 || y1 <= y0) return;
    const dpr = this.dpr;
    g.fillStyle = stroke;
    if (!rot) {
      // rot=0：device-px 取整 fillRect → 1 device px 清晰均匀（无 AA、无 sub-pixel 糊）
      const vy0 = Math.max(0, Math.round((ty + y0 * scale) * dpr));
      const vy1 = Math.min(ch, Math.round((ty + y1 * scale) * dpr));
      const vx0 = Math.max(0, Math.round((tx + x0 * scale) * dpr));
      const vx1 = Math.min(cw, Math.round((tx + x1 * scale) * dpr));
      for (let x = x0; x <= x1; x++) g.fillRect(Math.round((tx + x * scale) * dpr), vy0, 1, vy1 - vy0);
      for (let y = y0; y <= y1; y++) g.fillRect(vx0, Math.round((ty + y * scale) * dpr), vx1 - vx0, 1);
    } else {
      // rot≠0（罕见）：斜线走 stroke（AA），不强求 device 对齐
      g.strokeStyle = stroke;
      g.lineWidth = 1;
      g.beginPath();
      for (let x = x0; x <= x1; x++) {
        const a = this.docToScreen(x, y0), b = this.docToScreen(x, y1);
        g.moveTo(a.x * dpr, a.y * dpr); g.lineTo(b.x * dpr, b.y * dpr);
      }
      for (let y = y0; y <= y1; y++) {
        const a = this.docToScreen(x0, y), b = this.docToScreen(x1, y);
        g.moveTo(a.x * dpr, a.y * dpr); g.lineTo(b.x * dpr, b.y * dpr);
      }
      g.stroke();
    }
  }
}

function clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)); }
