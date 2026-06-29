// Board = 显示层。把 PaintDoc 合成到屏幕 <canvas> 上 + 视口 pan/zoom + cursor 预览。
import { sourceWarpMatrix } from "./floating-transform.ts";
import type { WarpBakeFn } from "./floating-transform.ts";
import { compositeLayers } from "./layer-composite.ts";
import { makeBitmap } from "./bitmap.ts";
import { GLBoard } from "./gl/gl-board.ts";
import { poolCapacityForBudget } from "./gl/gl-doc-renderer.ts";
import type { FloatInput, StampOverlayInput, SurrogateInput } from "./gl/gl-doc-renderer.ts";
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
interface Cursor { x: number; y: number; size: number; square?: boolean; }

// 选区（doc.selection）：alpha mask + bbox（与 selection-ops 的形状一致）
interface Selection {
  bboxX: number; bboxY: number; bboxW: number; bboxH: number;
  maskCanvas: CanvasImageSource;
  outline(): number[][];
}

// 自由变换浮层网格点 / source / float 描述（lassoInfo.floating）
interface MeshPt { x: number; y: number; }
interface FloatSource { layer: Layer; }   // float 像素 warp 全走 GPU（_glFloatInputs→_floatPass），board 端不持 render 缓存
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

// 采样模式字符串 → GPU warp shader 的 int（0=nearest 1=bilinear 2=bicubic；默认 bilinear）。
function _sampleModeInt(mode?: string): number {
  return mode === "nearest" ? 0 : mode === "bicubic" ? 2 : 1;
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
  _voidColor: string;
  _showCheckerboard: boolean;
  _pixelGridEnabled: boolean;
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
  // GL live-sync：原地改像素的笔描边中要重传 GPU 的活动叶（无=不重传，buffered brush/无描边）。
  _liveSyncProvider?: (() => Layer | null) | null;
  _wasFloatActive?: boolean;   // 上帧是否有活动浮层（检测 lift 过渡帧 → forceSync 一次，同步挖洞）
  _lassoProvider?: (() => LassoInfo | null | undefined) | null;
  _activeSurrogateLayerId?: number | null;
  _activeSurrogateCanvas?: CanvasImageSource | null;
  _activeSurrogateBx?: number;   // 替身 canvas 的 doc 左上（GL 上传 tiles 用）
  _activeSurrogateBy?: number;
  _clipTmp?: HTMLCanvasElement;
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
    this._pixelGridEnabled = true;

    this._eraseComposite = null;
    this._eraseCompositeKey = null;

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
      this.doc.configureMemory(Math.min(this._glBoard.memory.committedBytes, layerByteBudget()), false);
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
      console.warn("[board] GL 初始化失败（无 WebGL2）→ 显「需 WebGL2」：", e);
      if (this._glCanvas) { this._glCanvas.remove(); this._glCanvas = null; }
      this._glBoard = null;
    }
  }

  setDoc(doc: PaintDoc) {
    this.doc = doc;
    this._configureDocMemory();
    this._compositeCacheDirty = true;   // 新 doc → 合成缓存作废
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
  setThemeColors({ voidColor }: { voidColor?: string }) {
    if (voidColor) this._voidColor = voidColor;
    this.requestRender();
  }

  // 由 BrushEngine 报告："layer 像素被改"（脏 bbox 参数现仅语义/旁观者用；GL-only 后无 partial-blit 消费它）。
  markDocDirty(_x0: number, _y0: number, _x1: number, _y1: number) {
    this._compositeCacheDirty = true;   // 像素改 → 合成缓存作废（吸管 composite 缓存；commit 后重建）
    this._glBoard?.markContentDirty();   // GL：内容脏（描边中 livePreview 守门不重传，抬笔 commit 后才同步）
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
    const s = Math.min(sx, sy);
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
    const tx = (w - this.doc.width * scale) / 2;
    const ty = (h - this.doc.height * scale) / 2;
    this.setViewport(tx, ty, scale, 0);   // 复位 rotation
  }

  // 公共 API：layer 像素被改了（图层结构变 / 切换 / putImageData 等）
  invalidateAll() {
    this._compositeCacheDirty = true;   // 图层/结构/doc-transform 变 → 合成缓存作废
    this._glBoard?.markContentDirty();   // GL：图层/结构变 → 全量重传
    this.requestRender();
  }

  // 盖印（stamp）落层后但 float 仍活：盖印经 _bakeDown 改了源层 tile，但 livePreview 门控会挡住 syncAll
  //   → 盖印像素卡在 CPU tile、要等 commit 结束 float 才显。这里把"上帧无浮层"伪装出来，让下一帧重走 lift 的
  //   forceSync 一次（_renderFullGL: floatActive && !_wasFloatActive），把盖印写进的源层 tile 同步上 GPU。
  //   拖动中源层再次静止 → 不增加 per-帧成本（与 lift forceSync 同一机制）。
  forceGLResyncUnderFloat() {
    this._wasFloatActive = false;
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
  // 颜色调整 live preview 走 surrogate canvas（per-pixel JS 滤镜结果塞进来）。GL 模式：该替身经 _glSurrogate
  //   上传成活动层 GPU tiles 显示（非破坏）。(layerId, canvas, bx, by) 启动；(null, null) 关。
  //   invalidateAll → markContentDirty：关闭时下一帧（非 livePreview）syncAll 从真像素恢复 GPU。
  setActiveLayerSurrogate(layerId: number | null, canvas: CanvasImageSource | null, bx = 0, by = 0) {
    this._activeSurrogateLayerId = layerId;
    this._activeSurrogateCanvas = canvas;
    this._activeSurrogateBx = bx;
    this._activeSurrogateBy = by;
    this.invalidateAll();
  }

  // GL 渲染用：当前活动层替身（颜色调整 preview）→ SurrogateInput（无替身=null）。
  _glSurrogate(): SurrogateInput | null {
    const c = this._activeSurrogateCanvas;
    if (!c || this._activeSurrogateLayerId == null) return null;
    const w = (c as HTMLCanvasElement).width, h = (c as HTMLCanvasElement).height;
    if (!w || !h) return null;
    return { layerId: this._activeSurrogateLayerId, canvas: c, bx: this._activeSurrogateBx ?? 0, by: this._activeSurrogateBy ?? 0, w, h };
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
  // 注：层合成（含 clip dst-in 基底、erase/混合复合通路）在 src/layer-composite.ts（deep module A）；
  //   board 仅经 _layerCompositeOpts 给 ensureCompositeCache（吸管）注入 surrogate / tmp 池。display 全走 GL。
  //   （CPU 笔刷 live overlay 裁剪 _clipOverlayMasks 已删——brush live 走 GPU stamp overlay，shader 内裁选区/锁α。）

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
    const line2 = s ? `\n${s.passes}p ${s.floatPasses}f ${this._lastStampCount}s` : "";
    this._ensureFpsEl().textContent = `${this._fps ? this._fps.toFixed(0) : "--"} fps${line2}`;
  }

  // v351 起 GL board 是唯一 display 路径（2D display 归档进 ARCHIVE/old-board-2d-display.ts）。
  //   GL init 失败（无 WebGL2）→ 不回退 2D，显「需 WebGL2」提示（吸管/导出/缩略图的 CPU compositeLayers 仍保留，
  //   见 ensureCompositeCache）。
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
    // live-sync：原地改像素的笔（liquify/filterBrush/pixelMode）描边中把活动叶每帧重传 GPU（否则 live 门控挡住 syncAll → 预览不动）。
    const liveSync = this._liveSyncProvider?.() ?? null;
    // 自由变换 lift 那帧强制全量同步一次：lift 挖洞改了源层 tile，但 float 激活 → livePreview 真 → syncAll 被门控挡住
    //   → GPU 仍是无洞源层（源内容+浮层双显）。检测 float 由无变有的过渡帧 forceSync 一次；拖动中源层静止不再同步。
    const floatActive = !!this._lassoProvider?.()?.floating;
    const forceSync = floatActive && !this._wasFloatActive;
    this._wasFloatActive = floatActive;
    const stampOverlay = this._glStampOverlay();
    this._lastStampCount = this._showFps ? (stampOverlay?.stamps.length ?? 0) : 0;   // HUD only
    this._glBoard!.render(
      this.doc as unknown as GLDoc,
      this._docTransformParams(),
      W, H, this.viewport.scale, this._voidColor, docBg,
      this._isLivePreview(), this._glFloatInputs(), stampOverlay,
      liveSync as unknown as GLLeaf | null, forceSync, this._glSurrogate(),
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
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, this.doc.width, this.doc.height);
  }

  // Stage 3：brush stamp 列表提供者（app 注入 = () => input.brush.collectStamps()）。
  _stampProvider: (() => StampCollect) | null = null;
  setStampProvider(fn: () => StampCollect) { this._stampProvider = fn; }

  // GPU brush stamp overlay（Stage 3，替 CPU overlayCanvas）。selection/lockAlpha 在 GPU overlay shader 内裁
  //   （setStampOverlay 上传选区 mask + base.a 锁α），与 commit 一致；commit 始终 GPU（选区另由 applyMaskPostStroke 兜）。
  _glStampOverlay(): StampOverlayInput | null {
    const cs = this._stampProvider?.();
    if (!cs || !cs.stamps.length) return null;
    const sel = this.doc.selection;
    return {
      stamps: cs.stamps, shape: cs.shape, bx: cs.bx, by: cs.by, bw: cs.bw, bh: cs.bh,
      layerId: cs.layer.id, opacity: cs.opacity, erase: cs.mode === "erase", blendMode: cs.blendMode,
      lockAlpha: !!cs.layer.lockAlpha,
      selMask: sel ? { canvas: sel.maskCanvas as unknown as CanvasImageSource, ox: sel.bboxX, oy: sel.bboxY, ow: sel.bboxW, oh: sel.bboxH } : null,
    };
  }

  // GL board 是否启用（brush beginStroke 据此设 glMode；与 glStrokeRasterizeFn 同源）。
  isGLBoard(): boolean { return !!this._glBoard; }

  // commit 用：GL 模式返回「stamp 列表 → straight canvas」的 GPU 栅格 fn；否则 null（brush.endStroke 走 CPU buffer）。
  glStrokeRasterizeFn(): ((stamps: Stamp[], shape: StrokeShape, bx: number, by: number, bw: number, bh: number) => { canvas: HTMLCanvasElement; dstX: number; dstY: number } | null) | null {
    if (!this._glBoard) return null;
    return (stamps, shape, bx, by, bw, bh) => this._glBoard!.rasterizeStrokeToCanvas(stamps, shape, bx, by, bw, bh);
  }

  // 自由变换 commit 烤定用：GPU warp 源 → straight canvas（_bakeDown 注入；GL 失败=null，commit 不烤）。
  glWarpBakeFn(): WarpBakeFn | null {
    if (!this._glBoard) return null;
    return (srcCanvas, srcW, srcH, hinv, mode, bx, by, bw, bh) => this._glBoard!.warpToCanvas(srcCanvas as unknown as TexImageSource, srcW, srcH, hinv, mode, bx, by, bw, bh);
  }

  // 自由变换浮层 → GL warp 输入（floatFor 接缝）：每源层传**未 warp 源纹理 + Hinv**（GPU 在 shader 里 gather
  //   warp，源纹理只在内容变时重传）。替代旧 CPU renderSource。落源层 z（floatFor 按 leaf.id 匹配）。
  _glFloatInputs(): FloatInput[] {
    const lassoInfo = this._lassoProvider?.();
    const float = (lassoInfo && lassoInfo.floating) ? lassoInfo.floating : null;
    if (!float) return [];
    const mode = _sampleModeInt(lassoInfo!.sampleMode);
    const out: FloatInput[] = [];
    for (const src of float.sources) {
      const wp = sourceWarpMatrix(src as unknown as Parameters<typeof sourceWarpMatrix>[0], float.gizmoBbox as Parameters<typeof sourceWarpMatrix>[1], float.mesh as Parameters<typeof sourceWarpMatrix>[2]);
      if (!wp) continue;
      const s = src as unknown as { canvas: CanvasImageSource; rect: { w: number; h: number } };
      out.push({ layerId: src.layer.id, srcCanvas: s.canvas, srcW: s.rect.w, srcH: s.rect.h, hinv: wp.hinv, mode });
    }
    return out;
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

  // 规范合成器 opts —— **现仅 ensureCompositeCache（吸管 composite 取色）用**，非 display（display 全走 GL）。
  //   source：活动层若有调整 surrogate 则用替身。overlay/float 已去（display 浮层/描边 overlay 全在 GL 合成器；
  //   吸管不会在描边/变换进行中触发，gizmo/笔占指针）。clipTmp/eraseTmp：clip-mask/erase 合成的复用离屏池。
  _layerCompositeOpts() {
    return {
      source: (layer: Layer) =>
        (this._activeSurrogateLayerId === layer.id && this._activeSurrogateCanvas)
          ? this._activeSurrogateCanvas : layer.canvas,
      clipTmp: (w: number, h: number) => this._getClipTmp(w, h),
      eraseTmp: (w: number, h: number) => this._getEraseComposite(w, h),
    };
  }
  // 实时预览中？= 调整 surrogate / stroke 进行中 / 活动浮层。GL 路径用它门控 syncAll/release。
  _isLivePreview() {
    return !!(this._activeSurrogateCanvas
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
