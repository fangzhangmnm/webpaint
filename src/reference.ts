// 参考图浮动小窗。独立 viewport（不跟主画布耦合），可 pinch / zoom / rotate / pan。
// 数据流：ImageBitmap（来自文件 / 主画布 snapshot）→ canvas drawImage 走自家 viewport。
//
// 设计取舍：
// - 不复用 Board —— Board 强耦合 PaintDoc / brush overlay / dirty 系统。参考窗只是 "画一张图"。
// - 复用 .float-panel 拖动模式（标题栏拖整窗），手势只在内部画布区域生效。
// - 状态持久化到 localStorage：上一次的图（缩略 dataURL）+ panel 位置 + 大小。重启 PWA 也回得来。
//
// 手势：
//   单指拖 / 鼠标左键拖 = pan 内部 image
//   双指 pinch + rotate（anchor 在两指中点）
//   wheel = zoom（以光标为锚）
//   双击 = 适应窗口（fitToPanel）
//
// 吸色（v154）：eyedropper 工具在参考窗上 tap/拖 → 吸窗内显示色；touch 长按(若开启)同理。
//   直接读自家 canvas 像素（所见即所吸），复用主吸色的 pin（wp:pickerShow）。其余仍不参与笔刷/undo。
// 不持久化原图（dataURL 占空间）—— 关掉 panel = 释放图。下次开要重新选

// 参考窗用独立 viewport（image-origin 约定），但双指变换的三角与主画布同一套：
// 共享 pinchScaleRot + solveAnchorTranslation（见 pointer-gesture.js / K3）。
import { pinchScaleRot, solveAnchorTranslation } from "./pointer-gesture.ts";
import type { GestureViewport } from "./pointer-gesture.ts";
import { raiseWindow } from "./surfaces.ts";
import type { PaintDoc, Layer } from "./doc.ts";

// 参考窗内部 viewport（image-origin 约定）。形同 GestureViewport。
type RefViewport = GestureViewport;

// 构造参数（来自 side-windows：DOM 元素 + app 注入回调）。
// canvas 边界处用 HTMLElement（els.referenceCanvas 经 byId 默认窄到 HTMLElement，
// 运行期实为 <canvas>），构造期 cast 到 HTMLCanvasElement。
interface ReferenceWindowOpts {
  panel: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  canvas: HTMLElement;
  closeBtn: HTMLElement;
  emptyHint: HTMLElement | null;
  status?: (msg: string, isError?: boolean) => void;
  getTool?: () => string | null;
  getLongPressPickEnabled?: () => boolean;
  onColorSampled?: (hex: string) => void;
}

// setBitmap 接受的源：ImageBitmap，或 resample 出的 canvas（side-windows 传 fit.source）。
// 运行期只用 .close?.()/.width/.height/drawImage —— 鸭子 union，避免引 resample 私有类型。
// close? 可选：非 ImageBitmap 的 canvas 源没有 close（代码用 ?. 守）。
type RefBitmapSource = (ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas) & { close?: () => void };

// setBitmap 的 opts：原始文件 Blob（跟 doc 一起进 .ora）。
interface SetBitmapOpts { persistBlob?: Blob | null; }

// getSerializedState / applySerializedState 的 painting-scoped 状态。
interface RefSerializedState {
  open: boolean;
  viewport: RefViewport;
}

// 拖整窗 / 手势 state。
interface PanelDragState { id: number; sx: number; sy: number; ol: number; ot: number; }
interface GestureStartState { midX: number; midY: number; dist: number; angle: number; vp: RefViewport; }
interface PointerPos { x: number; y: number; }

const LS_POS = "webpaint.refPanel.pos";       // {left, top, width, height}
const LS_VP  = "webpaint.refPanel.vp";        // {tx, ty, scale, rot}
const LS_OPEN = "webpaint.refPanel.open";     // "1" | "0"
const REF_LONG_PRESS_MS = 450;                // 长按吸色延迟（对齐 input.js）
const REF_LONG_PRESS_CANCEL_SQ = 64;          // 8px²：长按期间移动超此 → 取消，回 pan

export class ReferenceWindow {
  panel: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  canvas: HTMLCanvasElement;
  closeBtn: HTMLElement;
  emptyHint: HTMLElement | null;
  status: (msg: string, isError?: boolean) => void;
  getTool: () => string | null;
  getLongPressPickEnabled: () => boolean;
  onColorSampled: (hex: string) => void;
  _picking: boolean;
  _longPressTimer: ReturnType<typeof setTimeout> | null;
  _lpStart: PointerPos | null;
  ctx: CanvasRenderingContext2D;
  bitmap: RefBitmapSource | null;
  _bitmapBlob!: Blob | null;   // 在 setBitmap/clearBitmap 赋值（构造期不设）
  _liveDoc: PaintDoc | null;
  _composeCanvas: HTMLCanvasElement | null;
  _liveDirty: boolean;
  vp: RefViewport;
  _raf: number | null;
  _panelDrag: PanelDragState | null;
  _resizeDrag: unknown;
  _pointers: Map<number, PointerPos>;
  _gestureStart: GestureStartState | null;

  constructor(opts: ReferenceWindowOpts) {
    this.panel   = opts.panel;                 // .float-panel
    this.head    = opts.head;                  // 拖动标题栏
    this.body    = opts.body;                  // 装 canvas 的 div
    this.canvas  = opts.canvas as HTMLCanvasElement;   // 内部画图 canvas（els 默认窄到 HTMLElement）
    this.closeBtn = opts.closeBtn;
    this.emptyHint = opts.emptyHint;           // "选个图…" 占位文字
    this.status  = opts.status || (() => {});
    // 吸色（v154）：从 app 注入，和主吸色共用一套
    this.getTool = opts.getTool || (() => null);
    this.getLongPressPickEnabled = opts.getLongPressPickEnabled || (() => false);
    this.onColorSampled = opts.onColorSampled || (() => {});
    this._picking = false;                     // 当前指在吸色（非 pan）
    this._longPressTimer = null;
    this._lpStart = null;
    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";

    // 显示源 = 二选一：
    //   bitmap (ImageBitmap)：静态加载的图，setBitmap()
    //   liveDoc (PaintDoc) + _composeCanvas：实时镜像主画布，setLiveSource()
    // event-driven 重合成：board.markDocDirty() 触发 "wp:docpixeldirty" →
    // markLiveDirty() 置 flag + schedule rAF；rAF 里 _render() 见 flag 才合成。
    // 没改动 = 不合成，开销近 0。
    this.bitmap = null;
    this._liveDoc = null;
    this._composeCanvas = null;
    this._liveDirty = false;
    this.vp = { tx: 0, ty: 0, scale: 1, rot: 0 };
    this._raf = null;
    this._panelDrag = null;                    // 拖整窗 state
    this._resizeDrag = null;                   // 右下角 resize state
    this._pointers = new Map();
    this._gestureStart = null;

    this._bind();
    this._loadPos();
    this._loadVp();
  }

  // ---- 外部 API ----
  setBitmap(bitmap: RefBitmapSource | null, opts: SetBitmapOpts = {}) {
    // 切静态源 → 退出 live 模式
    this._stopLive();
    if (this.bitmap && this.bitmap !== bitmap) this.bitmap.close?.();
    this.bitmap = bitmap;
    // 持久化的原始 Blob（PNG / JPEG / 不管什么 mime），跟 doc 一起进 .ora。
    // opts.persistBlob 是调用方给的"原始文件" Blob。
    this._bitmapBlob = opts.persistBlob || null;
    if (bitmap) this.fitToPanel();
    this._updateEmptyHint();
    this._invalidate();
  }
  // 给 saveSession 用：拿当前静态 ref 的原始 Blob（live 模式返 null）
  getPersistBlob() {
    return this._liveDoc ? null : this._bitmapBlob;
  }
  // 没图时清空
  clearBitmap() {
    if (this.bitmap) this.bitmap.close?.();
    this.bitmap = null;
    this._bitmapBlob = null;
    this._updateEmptyHint();
    this._invalidate();
  }

  // 跟着 .ora 进 / 出 webpaint/state.json（painting-scoped 状态）。
  // 不带 panel 位置 / 大小（那是 device-scoped，留 localStorage）。
  getSerializedState(): RefSerializedState {
    return {
      open: this.isOpen(),
      viewport: { ...this.vp },
    };
  }
  applySerializedState(state: unknown): void {
    if (!state || typeof state !== "object") return;
    const st = state as { viewport?: Partial<RefViewport>; open?: unknown };
    if (st.viewport) {
      if (Number.isFinite(st.viewport.tx)) this.vp.tx = st.viewport.tx!;
      if (Number.isFinite(st.viewport.ty)) this.vp.ty = st.viewport.ty!;
      if (Number.isFinite(st.viewport.scale)) this.vp.scale = st.viewport.scale!;
      if (Number.isFinite(st.viewport.rot)) this.vp.rot = st.viewport.rot!;
    }
    if (st.open) this.open(); else this.close();
    this._invalidate();
  }
  // 实时镜像主画布：board.markDocDirty 触发 wp:docpixeldirty → markLiveDirty
  setLiveSource(doc: PaintDoc) {
    if (this.bitmap) { this.bitmap.close?.(); this.bitmap = null; }
    this._liveDoc = doc;
    if (!this._composeCanvas) this._composeCanvas = document.createElement("canvas");
    this._liveDirty = true;                  // 初次进 live 立刻合成一次
    this.fitToPanel();
    this._updateEmptyHint();
    this._invalidate();
  }
  isLive() { return !!this._liveDoc; }
  toggleLive(doc: PaintDoc) {
    if (this.isLive()) {
      this._stopLive();
      this._updateEmptyHint();
      this._invalidate();
    } else {
      this.setLiveSource(doc);
    }
  }
  _stopLive() {
    this._liveDoc = null;
    this._liveDirty = false;
  }
  // 外部（board.markDocDirty / wp:histchange）调用：标脏 + 触发渲染。
  // 真合成发生在 _render 里，且只在 _liveDirty=true 时合成。
  markLiveDirty() {
    if (!this._liveDoc) return;
    this._liveDirty = true;
    this._invalidate();
  }
  _recomposeLive() {
    const doc = this._liveDoc;
    if (!doc) return;
    const W = doc.width, H = doc.height;
    if (this._composeCanvas!.width !== W || this._composeCanvas!.height !== H) {
      this._composeCanvas!.width = W;
      this._composeCanvas!.height = H;
    }
    const cx = this._composeCanvas!.getContext("2d")!;
    cx.clearRect(0, 0, W, H);
    cx.fillStyle = doc.backgroundColor || "#ffffff";
    cx.fillRect(0, 0, W, H);
    for (const node of doc.layers) {
      const layer = node as Layer;   // live 合成假设扁平叶层（运行期既有约定）
      if (!layer.visible) continue;
      if (!(layer.bboxW > 0 && layer.bboxH > 0)) continue;
      cx.globalAlpha = layer.opacity ?? 1;
      cx.globalCompositeOperation = (layer.mode || "source-over") as GlobalCompositeOperation;
      cx.drawImage(layer.canvas, layer.bboxX, layer.bboxY);
    }
    cx.globalAlpha = 1; cx.globalCompositeOperation = "source-over";
  }
  open() {
    this.panel.classList.remove("hidden");
    raiseWindow(this.panel);   // v232：开窗即置顶（surfaces window band）
    // v112: 默认位置避开 topbar + 左 sidebar（user：「不要 spawn 在左上角贴顶，那样难点」）
    // 仅在 panel 没被拖过 / 没 applySerializedState 时设默认；保留 user 调过的位置
    if (!this.panel.style.left || !this.panel.style.top) {
      // v267 (user)：再往里收一点，避开 iPad 顶部日期/状态栏（左上角）。
      const topbarH = 56;
      const sidebarW = 80;
      this.panel.style.left = (sidebarW + 32) + "px";   // = 112
      this.panel.style.top  = (topbarH + 48) + "px";    // = 104
    }
    this._resizeCanvasToBody();
    this._updateEmptyHint();
    if (this._liveDoc) this._liveDirty = true;   // 重新打开 = 默认重画一次
    this._invalidate();
  }
  close() {
    this.panel.classList.add("hidden");
  }
  isOpen() { return !this.panel.classList.contains("hidden"); }
  toggle() { this.isOpen() ? this.close() : this.open(); }

  fitToPanel() {
    const src = this._sourceSize();
    if (!src) return;
    const bw = this.canvas.width / (window.devicePixelRatio || 1);
    const bh = this.canvas.height / (window.devicePixelRatio || 1);
    if (src.w <= 0 || src.h <= 0 || bw <= 0 || bh <= 0) return;
    const s = Math.min(bw / src.w, bh / src.h) * 0.95;
    this.vp = { tx: bw / 2, ty: bh / 2, scale: s, rot: 0 };
    this._saveVp();
    this._invalidate();
  }
  _sourceSize() {
    if (this._liveDoc) return { w: this._liveDoc.width, h: this._liveDoc.height };
    if (this.bitmap) return { w: this.bitmap.width, h: this.bitmap.height };
    return null;
  }

  // ---- 内部 ----
  _bind() {
    // 关
    this.closeBtn.addEventListener("click", () => this.close());

    // doc 像素或图层结构变 → 标 live 脏（不强行渲染：_invalidate rAF 自己处理）
    window.addEventListener("wp:docpixeldirty", () => this.markLiveDirty());
    window.addEventListener("wp:histchange", () => this.markLiveDirty());

    // 拖整窗（标题栏）
    this.head.addEventListener("pointerdown", (e) => {
      // 标题栏里的按钮（载入 / 镜像画布 / 适应 / 关闭）不参与拖窗——否则 head 的
      // setPointerCapture 吞掉按钮 click，导入/镜像按钮就「点了没反应」（v154 修，user 反映又不弹）
      if ((e.target as Element).closest("button")) return;
      const r = this.panel.getBoundingClientRect();
      this._panelDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
      this.head.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.head.addEventListener("pointermove", (e) => {
      if (!this._panelDrag || e.pointerId !== this._panelDrag.id) return;
      const w = this.panel.offsetWidth, h = this.panel.offsetHeight;
      const left = clamp(this._panelDrag.ol + (e.clientX - this._panelDrag.sx), 0, window.innerWidth - w);
      const top  = clamp(this._panelDrag.ot + (e.clientY - this._panelDrag.sy), 0, window.innerHeight - h);
      this.panel.style.left = left + "px";
      this.panel.style.top = top + "px";
      this._savePos();
    });
    this.head.addEventListener("pointerup", (e) => {
      if (this._panelDrag && e.pointerId === this._panelDrag.id) {
        try { this.head.releasePointerCapture(e.pointerId); } catch {}
        this._panelDrag = null;
      }
    });

    // 内部画布手势（pan / pinch / rotate / wheel / 双击）
    this.canvas.addEventListener("pointerdown", (e) => this._onDown(e), { passive: false });
    this.canvas.addEventListener("pointermove", (e) => this._onMove(e), { passive: false });
    this.canvas.addEventListener("pointerup", (e) => this._onUp(e), { passive: false });
    this.canvas.addEventListener("pointercancel", (e) => this._onUp(e), { passive: false });
    this.canvas.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    this.canvas.addEventListener("dblclick", () => this.fitToPanel());

    // 窗口大小变 → 重画
    // v216: canvas.width 赋值立即清空画布；同步 _render 而非 rAF defer，
    // 避免 resize 时 1 帧空白闪屏。
    const ro = new ResizeObserver(() => {
      this._resizeCanvasToBody();
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
      this._render();
      this._savePos();
    });
    ro.observe(this.body);
  }

  _onDown(e: PointerEvent) {
    this.canvas.setPointerCapture?.(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // 吸色（v154）：eyedropper 工具 → 立即吸；touch + 长按吸色开启 → 起 timer（不动才吸，动了回 pan）
    if (this._pointers.size === 1) {
      if (this.getTool() === "picker") { this._beginPick(e); e.preventDefault(); return; }
      if (e.pointerType === "touch" && this.getLongPressPickEnabled()) {
        this._lpStart = { x: e.clientX, y: e.clientY };
        this._longPressTimer = setTimeout(() => { this._longPressTimer = null; this._beginPick(e); }, REF_LONG_PRESS_MS);
      }
    }
    if (this._pointers.size === 2) {
      // 第二指进来 → 取消吸色 / 长按，进 gesture
      this._cancelLongPress();
      this._endPick();
      // 进 gesture
      const arr = [...this._pointers.values()];
      const dx = arr[1].x - arr[0].x, dy = arr[1].y - arr[0].y;
      this._gestureStart = {
        midX: (arr[0].x + arr[1].x) / 2,
        midY: (arr[0].y + arr[1].y) / 2,
        dist: Math.hypot(dx, dy) || 1,
        angle: Math.atan2(dy, dx),
        vp: { ...this.vp },
      };
    }
    e.preventDefault();
  }
  _onMove(e: PointerEvent) {
    const p = this._pointers.get(e.pointerId);
    if (!p) return;
    const px = p.x, py = p.y;
    p.x = e.clientX; p.y = e.clientY;
    // 长按 timer 期间移动超阈值 → 取消，回 pan
    if (this._longPressTimer && this._lpStart) {
      const ddx = e.clientX - this._lpStart.x, ddy = e.clientY - this._lpStart.y;
      if (ddx * ddx + ddy * ddy > REF_LONG_PRESS_CANCEL_SQ) this._cancelLongPress();
    }
    // 吸色中（单指）→ 连续吸，不 pan
    if (this._picking && this._pointers.size === 1) {
      this._pickAt(e.clientX, e.clientY);
      e.preventDefault();
      return;
    }
    if (this._pointers.size === 1) {
      // pan
      this.vp.tx += (e.clientX - px);
      this.vp.ty += (e.clientY - py);
      this._saveVp();
      this._invalidate();
    } else if (this._pointers.size >= 2 && this._gestureStart) {
      const arr = [...this._pointers.values()];
      const dx = arr[1].x - arr[0].x, dy = arr[1].y - arr[0].y;
      const dist = Math.hypot(dx, dy) || 1;
      const midX = (arr[0].x + arr[1].x) / 2;
      const midY = (arr[0].y + arr[1].y) / 2;
      const angle = Math.atan2(dy, dx);
      const g = this._gestureStart;
      // 共享 scale/rot + anchor 解（image-origin 约定）：起手按住的 image 点保持在当前两指中点
      const { scale, rot } = pinchScaleRot(g, dist, angle, 0.02, 50);
      const rect = this.canvas.getBoundingClientRect();
      const ip = screenToImg(g.midX - rect.left, g.midY - rect.top, g.vp);
      const t = solveAnchorTranslation(ip, scale, rot, midX - rect.left, midY - rect.top);
      this.vp = { tx: t.tx, ty: t.ty, scale, rot };
      this._saveVp();
      this._invalidate();
    }
    e.preventDefault();
  }
  _onUp(e: PointerEvent) {
    this._pointers.delete(e.pointerId);
    this._cancelLongPress();
    if (this._pointers.size === 0) this._endPick();
    if (this._pointers.size < 2) this._gestureStart = null;
    if (this._pointers.size === 1) {
      // 还有一指 → 不进 gesture，单指 pan 接续。先 reset start
      this._gestureStart = null;
    }
    e.preventDefault?.();
  }

  // ---- 吸色（v154）----
  _cancelLongPress() {
    if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; }
    this._lpStart = null;
  }
  _beginPick(e: PointerEvent) {
    this._picking = true;
    this._cancelLongPress();
    this.status("吸色（参考）");
    this._pickAt(e.clientX, e.clientY);
  }
  _endPick() {
    if (!this._picking) return;
    this._picking = false;
    window.dispatchEvent(new CustomEvent("wp:pickerHide"));
  }
  // 读自家 canvas 像素（所见即所吸）。透明区（没图）不吸。半透明合成到白底。
  _pickAt(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    let px = Math.round((clientX - rect.left) * dpr);
    let py = Math.round((clientY - rect.top) * dpr);
    px = Math.max(0, Math.min(this.canvas.width - 1, px));
    py = Math.max(0, Math.min(this.canvas.height - 1, py));
    let d;
    try { d = this.ctx.getImageData(px, py, 1, 1).data; } catch { return; }
    let r = d[0], g = d[1], b = d[2]; const a = d[3];
    if (a === 0) { window.dispatchEvent(new CustomEvent("wp:pickerHide")); return; }   // 透明 → 没东西吸
    if (a < 255) { const f = a / 255; r = Math.round(r * f + 255 * (1 - f)); g = Math.round(g * f + 255 * (1 - f)); b = Math.round(b * f + 255 * (1 - f)); }
    const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    this.onColorSampled(hex);
    window.dispatchEvent(new CustomEvent("wp:pickerShow", { detail: { sx: clientX, sy: clientY, hex } }));
  }
  _onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const ip = screenToImg(sx, sy, this.vp);
    const factor = e.ctrlKey || e.metaKey ? Math.exp(-e.deltaY * 0.01) : Math.exp(-e.deltaY * 0.005);
    const newScale = clamp(this.vp.scale * factor, 0.02, 50);
    // anchor-preserving 以光标为锚（同 pinch 的解，复用 solveAnchorTranslation）
    const t = solveAnchorTranslation(ip, newScale, this.vp.rot, sx, sy);
    this.vp.tx = t.tx; this.vp.ty = t.ty; this.vp.scale = newScale;
    this._saveVp();
    this._invalidate();
  }

  _resizeCanvasToBody() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.body.clientWidth;
    const h = this.body.clientHeight;
    if (w <= 0 || h <= 0) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
  }
  _invalidate() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._render();
    });
  }
  _render() {
    // live 模式下：只在 _liveDirty=true 时才重新合成 layers → compose canvas
    if (this._liveDoc && this._liveDirty) {
      this._recomposeLive();
      this._liveDirty = false;
    }
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.width, H = this.canvas.height;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const source = this._liveDoc ? this._composeCanvas : this.bitmap;
    if (!source) return;
    // 棋盘格底（暗示透明 / 浮在主画布上的感觉）
    const cell = 8 * dpr;
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#3a3a3a";
    for (let y = 0; y < H; y += cell) {
      for (let x = ((y / cell) | 0) % 2 ? 0 : cell; x < W; x += cell * 2) {
        ctx.fillRect(x, y, cell, cell);
      }
    }
    // 应用 viewport：tx/ty 是 CSS 像素，要 × dpr；scale 和 rot 不动
    const v = this.vp;
    const c = Math.cos(v.rot), s = Math.sin(v.rot);
    ctx.setTransform(
      v.scale * c * dpr, v.scale * s * dpr,
      -v.scale * s * dpr, v.scale * c * dpr,
      v.tx * dpr, v.ty * dpr,
    );
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
  }

  _updateEmptyHint() {
    if (!this.emptyHint) return;
    const has = !!(this.bitmap || this._liveDoc);
    this.emptyHint.classList.toggle("hidden", has);
  }
  _savePos() {
    try {
      const r = this.panel.getBoundingClientRect();
      localStorage.setItem(LS_POS, JSON.stringify({
        left: r.left, top: r.top, width: r.width, height: r.height,
      }));
    } catch {}
  }
  _loadPos() {
    try {
      const s = localStorage.getItem(LS_POS);
      if (!s) return;
      const o = JSON.parse(s);
      // v268b (user)：钳进安全区——旧的(或越界的)持久化位置会把窗停在左上角，和 iPad 顶部
      //   日期栏 + 左侧工具栏打架。floor 清掉 topbar(56)/左栏(80)/safe-area 余量。
      const MIN_LEFT = 96, MIN_TOP = 96;
      if (o.left != null) this.panel.style.left = Math.max(MIN_LEFT, o.left) + "px";
      if (o.top != null) this.panel.style.top = Math.max(MIN_TOP, o.top) + "px";
      if (o.width)  this.panel.style.width = o.width + "px";
      if (o.height) this.panel.style.height = o.height + "px";
    } catch {}
  }
  _saveVp() {
    try { localStorage.setItem(LS_VP, JSON.stringify(this.vp)); } catch {}
  }
  _loadVp() {
    try {
      const s = localStorage.getItem(LS_VP);
      if (!s) return;
      const o = JSON.parse(s);
      if (Number.isFinite(o.tx)) this.vp.tx = o.tx;
      if (Number.isFinite(o.ty)) this.vp.ty = o.ty;
      if (Number.isFinite(o.scale)) this.vp.scale = o.scale;
      if (Number.isFinite(o.rot)) this.vp.rot = o.rot;
    } catch {}
  }
}

function clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)); }

// 屏幕→图像坐标的逆变换（用于 anchor-preserving）。屏幕坐标 sx/sy = relative to canvas top-left
// 正变换：screen = R(rot) · S(scale) · img + (tx, ty)；逆变换 img = S^-1 · R^-1 · (screen - tx, ty)
function screenToImg(sx: number, sy: number, vp: RefViewport) {
  const c = Math.cos(-vp.rot), s = Math.sin(-vp.rot);
  const dx = sx - vp.tx, dy = sy - vp.ty;
  return { x: (dx * c - dy * s) / vp.scale, y: (dx * s + dy * c) / vp.scale };
}
