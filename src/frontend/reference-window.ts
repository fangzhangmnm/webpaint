// <wp-reference-window> —— 参考图浮动小窗，家族 web component 约定试点（C9）。
// 约定全文见 ai-docs/20260810-family-web-component-convention.md。要点：
//   - 组件自带 chrome（shadow DOM：样式/图标/手势），宿主 store 零知识——不 import desk/i18n/backend。
//   - 入向 = 属性/property 下灌（**程序性 set 不发事件**，同原生 <input>.value 语义）；
//     出向 = CustomEvent（只有**用户交互**发：pan/pinch/wheel/拖窗/resize/按钮/吸色）。
//     宿主对回声事件做值比较（RO 在程序性改动后也会 fire）——见 side-windows.ts 适配层。
//   - 主题 = CSS 变量穿透（--bg/--ink/--line/--radius/--shadow/--z-window，全带 fallback，
//     裸挂也能看）；文案 = slot（title/empty，宿主 light DOM 走自家 i18n）+ labels property（
//     shadow 内按钮 tooltip，slot 够不到）。
//   - 图标烤进 shadow（<use href="#id"> 不穿 shadow 边界）：folder / picture-in-picture /
//     maximize-viewport / x，源=家族 sprite（20260708 SVG Icons），对账时以这四个 id 对上游。
//   - live 镜像的**合成知识在宿主**（backend/doc-render）：组件只吃 setLiveProvider(() => canvas)。
//
// 行为 = 旧 src/reference.ts（v154 吸色/v134 resize/v216 同步重画/v267-268b 位置钳制/S9 live 节流）
// 逐条搬入，手势数学仍走 common/pointer-gesture（与主画布同一套三角）。
//
// 数据流：ImageBitmap（文件）或 liveProvider（宿主合成 canvas）→ 自家 canvas drawImage 走独立 viewport。
// 手势：单指拖 pan / 双指 pinch+rotate（anchor=两指中点）/ wheel zoom（光标锚）/ 双击适应。

import { pinchScaleRot, solveAnchorTranslation } from "../common/pointer-gesture.ts";
import type { GestureViewport } from "../common/pointer-gesture.ts";

export type RefViewport = GestureViewport;
export interface RefPanelRect { left: number; top: number; width: number; height: number; }
// setBitmap 源：鸭子 union（只用 .close?.()/.width/.height/drawImage）。
export type RefBitmapSource = (ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas) & { close?: () => void };
export interface SetBitmapOpts { persistBlob?: Blob | null; skipFit?: boolean; }   // skipFit：doc 恢复时保住载入的 vp
export type RefLiveSource = HTMLCanvasElement | OffscreenCanvas | ImageBitmap;
export interface RefLabels { load?: string; cloud?: string; live?: string; fit?: string; close?: string; resize?: string; resizeAria?: string; }

const REF_LONG_PRESS_MS = 450;                // 长按吸色延迟（对齐 input.ts）
const REF_LONG_PRESS_CANCEL_SQ = 64;          // 8px²：长按期间移动超此 → 取消，回 pan
const LIVE_THROTTLE_MS = 300;                 // S9：live 全量合成节流；到期 timer 补帧收尾
// WebPaint 布局事实（组件自有默认；宿主布局大改时同步这里）：
const SPAWN_LEFT = 112, SPAWN_TOP = 104;      // v112/v267：默认避开 topbar(56)+左栏(80)+iPad 状态栏
const CLAMP_MIN_LEFT = 96, CLAMP_MIN_TOP = 96;   // v268b：旧持久化位置钳进安全区
const DRAG_TOP_FLOOR = 60;                    // 拖窗 top 地板=出血区（v0.4.11，同 layers-panel）

interface PanelDragState { id: number; sx: number; sy: number; ol: number; ot: number; }
interface ResizeDragState { id: number; sx: number; sy: number; w0: number; h0: number; }
interface GestureStartState { midX: number; midY: number; dist: number; angle: number; vp: RefViewport; }
interface PointerPos { x: number; y: number; }

// 图标：家族 sprite 烤入（id 注记 = 对账 key）。stroke 属性同 sprite 头（1.7/round/round）。
const SVG_ATTRS = `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
const ICON_FOLDER = `<svg ${SVG_ATTRS}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
const ICON_PIP = `<svg ${SVG_ATTRS}><rect x="3" y="4" width="18" height="14" rx="2"/><rect x="12" y="10" width="7" height="5" rx="1"/></svg>`;
const ICON_MAXVP = `<svg ${SVG_ATTRS}><polyline points="4 9 4 4 9 4"/><polyline points="20 9 20 4 15 4"/><polyline points="4 15 4 20 9 20"/><polyline points="20 15 20 20 15 20"/></svg>`;
const ICON_X = `<svg ${SVG_ATTRS}><path d="M6.5 6.5 L17.5 17.5 M17.5 6.5 L6.5 17.5"/></svg>`;
const ICON_CLOUD = `<svg ${SVG_ATTRS}><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`;   // sprite#cloud（从云盘选参考图，spec 20260820 §4）

// chrome 样式 = 旧 styles.css 的 .float-panel(-head/-title/-close) + .reference-* 逐条翻入 shadow；
// 宿主文档样式对 host 元素（position/z-index 覆盖等）仍然生效——document 规则赢过 :host 默认。
const TEMPLATE = `<style>
:host {
  position: fixed;
  top: 60px; left: 16px;
  display: flex; flex-direction: column;
  width: 280px; height: 360px;
  min-width: 160px; min-height: 160px;
  resize: both;              /* 桌面鼠标拖右下角；touch 走 .grip */
  overflow: hidden;
  background: color-mix(in srgb, var(--bg, #202124) 92%, transparent);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  border: 1px solid var(--line, #3c4043);
  border-radius: var(--radius, 10px);
  box-shadow: var(--shadow, 0 8px 24px rgba(0, 0, 0, 0.4));
  z-index: var(--z-window, 100);
  -webkit-tap-highlight-color: transparent;
  font-size: 13px;
}
:host(:not([open])) { display: none; }
.head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 8px;
  border-bottom: 1px solid var(--line, #3c4043);
  cursor: grab; user-select: none; -webkit-user-select: none;
  color: var(--ink-soft, #9aa0a6);
  touch-action: none;
}
.head:active { cursor: grabbing; }
.title { font-weight: 600; color: var(--ink, #e8eaed); }
.act {
  background: transparent; border: none; color: var(--ink-soft, #9aa0a6);
  cursor: pointer; padding: 4px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
}
.act svg { width: 18px; height: 18px; display: block; }
.act:hover { background: color-mix(in srgb, var(--ink, #e8eaed) 8%, transparent); color: var(--ink, #e8eaed); }
.act[aria-pressed="true"] { background: color-mix(in srgb, var(--accent, #4c8bf5) 18%, transparent); color: var(--accent, #4c8bf5); }
.close { background: transparent; border: none; color: var(--ink-soft, #9aa0a6); cursor: pointer; padding: 0 4px; }
.close svg { width: 16px; height: 16px; display: block; }
.grip {
  position: absolute; right: 2px; bottom: 2px; width: 22px; height: 22px;
  cursor: nwse-resize; touch-action: none; z-index: 2;
  display: flex; align-items: center; justify-content: center;
  color: var(--ink-soft, #9aa0a6); opacity: 0.55;
}
.grip:hover { opacity: 1; }
.grip::after {
  content: ""; position: absolute; inset: 3px;
  background: repeating-linear-gradient(-45deg, currentColor 0 1.6px, transparent 1.6px 5px);
  clip-path: polygon(100% 0, 100% 100%, 0 100%);
}
.body {
  position: relative; flex: 1; min-height: 0;
  background: #1a1a1a;
  border-radius: 0 0 var(--radius, 10px) var(--radius, 10px);
  overflow: hidden;
  touch-action: none;        /* 不让 iPad 系统抢双指手势 */
}
canvas {
  position: absolute; inset: 0; display: block;
  width: 100%; height: 100%;
  touch-action: none; cursor: grab;
}
canvas:active { cursor: grabbing; }
:host([pick]) canvas, :host([pick]) canvas:active { cursor: crosshair; }
.empty {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; text-align: center; color: var(--ink-soft, #9aa0a6);
  pointer-events: none; padding: 12px; font-size: 12px;
}
.empty.hidden { display: none; }
.empty ::slotted(*), .empty p { margin: 0; }
</style>
<div class="head" part="head">
  <span class="title" part="title"><slot name="title">参考</slot></span>
  <button class="act" data-act="load" type="button">${ICON_FOLDER}</button>
  <button class="act" data-act="cloud" type="button">${ICON_CLOUD}</button>
  <button class="act" data-act="live" type="button" aria-pressed="false">${ICON_PIP}</button>
  <button class="act" data-act="fit" type="button">${ICON_MAXVP}</button>
  <button class="close" data-act="close" type="button">${ICON_X}</button>
</div>
<div class="grip" part="grip"></div>
<div class="body" part="body">
  <canvas></canvas>
  <div class="empty"><slot name="empty">
    <p>选个图当参考</p>
  </slot></div>
</div>`;

export class WpReferenceWindow extends HTMLElement {
  static get observedAttributes() { return ["open"]; }

  // 宿主可换的 pull 端口（手势中查询宿主态；见约定 doc「pull 例外」）
  queryLongPressPick: () => boolean = () => false;

  private _headEl: HTMLElement;
  private _bodyEl: HTMLElement;
  private _canvas: HTMLCanvasElement;
  private _cctx: CanvasRenderingContext2D;
  private _emptyEl: HTMLElement;
  private _liveBtn: HTMLButtonElement;

  private _bitmap: RefBitmapSource | null = null;
  private _bitmapBlob: Blob | null = null;
  private _liveProvider: (() => RefLiveSource | null) | null = null;
  private _liveSource: RefLiveSource | null = null;
  private _liveDirty = false;
  private _lastLiveComposeT: number | undefined;
  private _liveThrottle: ReturnType<typeof setTimeout> | null = null;

  private _vp: RefViewport = { tx: 0, ty: 0, scale: 1, rot: 0 };
  private _raf: number | null = null;
  private _panelDrag: PanelDragState | null = null;
  private _resizeDrag: ResizeDragState | null = null;
  private _pointers = new Map<number, PointerPos>();
  private _gestureStart: GestureStartState | null = null;
  private _picking = false;
  private _longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private _lpStart: PointerPos | null = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = TEMPLATE;
    this._headEl = root.querySelector(".head")!;
    this._bodyEl = root.querySelector(".body")!;
    this._canvas = root.querySelector("canvas")!;
    this._emptyEl = root.querySelector(".empty")!;
    this._liveBtn = root.querySelector('[data-act="live"]')!;
    this._cctx = this._canvas.getContext("2d")!;
    this._cctx.imageSmoothingEnabled = true;
    this._cctx.imageSmoothingQuality = "high";
    this._bind(root);
  }

  // ---- 属性面（入向；程序性 set 不发事件）----
  get open(): boolean { return this.hasAttribute("open"); }
  set open(v: boolean) { this.toggleAttribute("open", !!v); }
  attributeChangedCallback(name: string, oldV: string | null, newV: string | null) {
    if (name === "open" && oldV !== newV && newV != null) this._afterShow();
  }
  close() { this.open = false; }   // ReferenceWindowHandle 兼容（程序性）

  get live(): boolean { return !!this._liveProvider; }
  isLive(): boolean { return this.live; }

  get viewport(): RefViewport { return { ...this._vp }; }
  set viewport(v: RefViewport | null | undefined) {
    if (!v) return;
    if (Number.isFinite(v.tx)) this._vp.tx = v.tx;
    if (Number.isFinite(v.ty)) this._vp.ty = v.ty;
    if (Number.isFinite(v.scale)) this._vp.scale = v.scale;
    if (Number.isFinite(v.rot)) this._vp.rot = v.rot;
    this._invalidate();
  }

  get rect(): RefPanelRect {
    const r = this.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  set rect(o: Partial<RefPanelRect> | null | undefined) {
    if (o && o.left != null && o.top != null) {
      // v268b：旧的(或越界的)持久化位置钳进安全区（iPad 顶部日期栏 + 左侧工具栏）
      this.style.left = Math.max(CLAMP_MIN_LEFT, o.left) + "px";
      this.style.top = Math.max(CLAMP_MIN_TOP, o.top) + "px";
      if (o.width) this.style.width = o.width + "px";
      if (o.height) this.style.height = o.height + "px";
    } else if (!this.style.left || !this.style.top) {
      this.style.left = SPAWN_LEFT + "px";
      this.style.top = SPAWN_TOP + "px";
    }
  }

  set labels(l: RefLabels) {
    const set = (sel: string, title?: string, aria?: string) => {
      const b = this.shadowRoot!.querySelector(sel) as HTMLElement | null;
      if (!b) return;
      if (title) b.title = title;
      if (aria || title) b.setAttribute("aria-label", aria || title!);
    };
    set('[data-act="load"]', l.load);
    set('[data-act="cloud"]', l.cloud);
    set('[data-act="live"]', l.live);
    set('[data-act="fit"]', l.fit);
    set('[data-act="close"]', l.close);
    set(".grip", l.resize, l.resizeAria);
  }

  // ---- 内容 API（宿主灌注）----
  setBitmap(bitmap: RefBitmapSource | null, opts: SetBitmapOpts = {}) {
    this._stopLiveInternal();
    if (this._bitmap && this._bitmap !== bitmap) this._bitmap.close?.();
    this._bitmap = bitmap;
    this._bitmapBlob = opts.persistBlob || null;   // 原始文件 Blob（宿主拿去跟 doc 进 .ora）
    if (bitmap && !opts.skipFit) this.fitToPanel();
    this._updateEmptyHint();
    this._invalidate();
  }
  clearBitmap() {
    if (this._bitmap) this._bitmap.close?.();
    this._bitmap = null;
    this._bitmapBlob = null;
    this._updateEmptyHint();
    this._invalidate();
  }
  getPersistBlob(): Blob | null { return this._liveProvider ? null : this._bitmapBlob; }

  // live 镜像：合成知识在宿主（provider 返回合成好的 canvas；null = 合成不可用 → 保留上帧）。
  setLiveProvider(provider: () => RefLiveSource | null) {
    if (this._bitmap) { this._bitmap.close?.(); this._bitmap = null; this._bitmapBlob = null; }
    this._liveProvider = provider;
    this._liveSource = provider();          // 立刻合成一次（拿尺寸 + 首帧）
    this._lastLiveComposeT = performance.now();
    this._liveDirty = false;
    this.fitToPanel();
    this._reflectLive();
    this._updateEmptyHint();
    this._invalidate();
  }
  stopLive() {
    this._stopLiveInternal();
    this._updateEmptyHint();
    this._invalidate();
  }
  private _stopLiveInternal() {
    this._liveProvider = null;
    this._liveSource = null;
    this._liveDirty = false;
    if (this._liveThrottle != null) { clearTimeout(this._liveThrottle); this._liveThrottle = null; }
    this._reflectLive();
  }
  private _reflectLive() {
    this.toggleAttribute("live", this.live);
    this._liveBtn.setAttribute("aria-pressed", this.live ? "true" : "false");
  }
  // 宿主在 doc 像素/结构变化时调（组件不监听宿主全局事件）。真合成在 _render 里按脏标+节流做。
  markLiveDirty() {
    if (!this._liveProvider) return;
    this._liveDirty = true;
    this._invalidate();
  }

  fitToPanel() {
    const src = this._sourceSize();
    if (!src) return;
    const bw = this._canvas.width / (window.devicePixelRatio || 1);
    const bh = this._canvas.height / (window.devicePixelRatio || 1);
    if (src.w <= 0 || src.h <= 0 || bw <= 0 || bh <= 0) return;
    const s = Math.min(bw / src.w, bh / src.h) * 0.95;
    this._vp = { tx: bw / 2, ty: bh / 2, scale: s, rot: 0 };
    this._emitViewport();   // 状态真变（fit 按钮/载图自适应）→ 宿主该持久化；非属性回灌
    this._invalidate();
  }
  private _sourceSize(): { w: number; h: number } | null {
    if (this._liveProvider) return this._liveSource ? { w: this._liveSource.width, h: this._liveSource.height } : null;
    if (this._bitmap) return { w: this._bitmap.width, h: this._bitmap.height };
    return null;
  }

  // ---- 出向事件 ----
  private _emit(name: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
  private _emitViewport() { this._emit("viewportchange", { ...this._vp }); }
  private _emitRect() { this._emit("rectchange", this.rect); }

  // ---- 内部 ----
  private _afterShow() {
    // 默认位置：仅在没被拖过/没回灌位置时设（保留 user 调过的位置）
    if (!this.style.left || !this.style.top) {
      this.style.left = SPAWN_LEFT + "px";
      this.style.top = SPAWN_TOP + "px";
    }
    this._resizeCanvasToBody();
    this._updateEmptyHint();
    if (this._liveProvider) this._liveDirty = true;   // 重新打开 = 默认重画一次
    this._invalidate();
  }

  private _bind(root: ShadowRoot) {
    // 头部按钮（closest 找 data-act；head 拖窗对按钮点击让路）
    root.querySelector('[data-act="load"]')!.addEventListener("click", () => this._emit("requestload"));
    root.querySelector('[data-act="cloud"]')!.addEventListener("click", () => this._emit("requestcloudload"));   // 云盘选图：组件只发意图，picker 是宿主知识
    root.querySelector('[data-act="live"]')!.addEventListener("click", () => this._emit("requestlivetoggle"));
    root.querySelector('[data-act="fit"]')!.addEventListener("click", () => this.fitToPanel());
    root.querySelector('[data-act="close"]')!.addEventListener("click", () => {
      this.open = false;
      this._emit("openchange", { open: false });   // 用户关窗（× 键）→ 事件；程序性 close() 不发
    });

    // 拖整窗（标题栏）。按钮不参与拖窗——否则 setPointerCapture 吞掉按钮 click（v154 修）
    this._headEl.addEventListener("pointerdown", (e) => {
      if ((e.target as Element).closest("button")) return;
      const r = this.getBoundingClientRect();
      this._panelDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
      try { this._headEl.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    this._headEl.addEventListener("pointermove", (e) => {
      if (!this._panelDrag || e.pointerId !== this._panelDrag.id) return;
      const w = this.offsetWidth, h = this.offsetHeight;
      const left = clamp(this._panelDrag.ol + (e.clientX - this._panelDrag.sx), 0, window.innerWidth - w);
      const top = clamp(this._panelDrag.ot + (e.clientY - this._panelDrag.sy), DRAG_TOP_FLOOR, window.innerHeight - h);
      this.style.left = left + "px";
      this.style.top = top + "px";
      this._emitRect();
    });
    this._headEl.addEventListener("pointerup", (e) => {
      if (this._panelDrag && e.pointerId === this._panelDrag.id) {
        try { this._headEl.releasePointerCapture(e.pointerId); } catch {}
        this._panelDrag = null;
      }
    });

    // v134 touch resize 手柄（CSS resize:both 只支持鼠标）
    const grip = root.querySelector(".grip") as HTMLElement;
    grip.addEventListener("pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try { grip.setPointerCapture(e.pointerId); } catch {}
      const r = this.getBoundingClientRect();
      this._resizeDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, w0: r.width, h0: r.height };
    });
    grip.addEventListener("pointermove", (e: PointerEvent) => {
      if (!this._resizeDrag || e.pointerId !== this._resizeDrag.id) return;
      const w = Math.max(160, Math.min(window.innerWidth - 40, this._resizeDrag.w0 + (e.clientX - this._resizeDrag.sx)));
      const h = Math.max(160, Math.min(window.innerHeight - 80, this._resizeDrag.h0 + (e.clientY - this._resizeDrag.sy)));
      this.style.width = w + "px";
      this.style.height = h + "px";
      this._emitRect();
    });
    const endResize = (e: PointerEvent) => {
      if (this._resizeDrag && e.pointerId === this._resizeDrag.id) {
        try { grip.releasePointerCapture(e.pointerId); } catch {}
        this._resizeDrag = null;
      }
    };
    grip.addEventListener("pointerup", endResize);
    grip.addEventListener("pointercancel", endResize);

    // 内部画布手势（pan / pinch / rotate / wheel / 双击 / 吸色）
    this._canvas.addEventListener("pointerdown", (e) => this._onDown(e), { passive: false });
    this._canvas.addEventListener("pointermove", (e) => this._onMove(e), { passive: false });
    this._canvas.addEventListener("pointerup", (e) => this._onUp(e), { passive: false });
    this._canvas.addEventListener("pointercancel", (e) => this._onUp(e), { passive: false });
    this._canvas.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    this._canvas.addEventListener("dblclick", () => this.fitToPanel());

    // 窗口大小变 → 重画。v216：canvas.width 赋值立即清空画布——同步 _render 而非 rAF defer，
    // 避免 resize 时 1 帧空白闪屏。rectchange 在这里也发（桌面 CSS resize:both 没有拖 handle 事件，
    // RO 是唯一出口）；程序性 rect 下灌产生的回声由宿主值比较吸收。
    const ro = new ResizeObserver(() => {
      this._resizeCanvasToBody();
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
      this._render();
      this._emitRect();
    });
    ro.observe(this._bodyEl);
  }

  private _onDown(e: PointerEvent) {
    try { this._canvas.setPointerCapture?.(e.pointerId); } catch {}
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // 吸色：pick 属性（宿主同步吸管工具态）→ 立即吸；touch + 长按吸色开启 → 起 timer
    if (this._pointers.size === 1) {
      if (this.hasAttribute("pick")) { this._beginPick(e); e.preventDefault(); return; }
      if (e.pointerType === "touch" && this.queryLongPressPick()) {
        this._lpStart = { x: e.clientX, y: e.clientY };
        this._longPressTimer = setTimeout(() => { this._longPressTimer = null; this._beginPick(e); }, REF_LONG_PRESS_MS);
      }
    }
    if (this._pointers.size === 2) {
      // 第二指进来 → 取消吸色/长按，进 gesture
      this._cancelLongPress();
      this._endPick();
      const arr = [...this._pointers.values()];
      const dx = arr[1].x - arr[0].x, dy = arr[1].y - arr[0].y;
      this._gestureStart = {
        midX: (arr[0].x + arr[1].x) / 2,
        midY: (arr[0].y + arr[1].y) / 2,
        dist: Math.hypot(dx, dy) || 1,
        angle: Math.atan2(dy, dx),
        vp: { ...this._vp },
      };
    }
    e.preventDefault();
  }
  private _onMove(e: PointerEvent) {
    const p = this._pointers.get(e.pointerId);
    if (!p) return;
    const px = p.x, py = p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this._longPressTimer && this._lpStart) {
      const ddx = e.clientX - this._lpStart.x, ddy = e.clientY - this._lpStart.y;
      if (ddx * ddx + ddy * ddy > REF_LONG_PRESS_CANCEL_SQ) this._cancelLongPress();
    }
    if (this._picking && this._pointers.size === 1) {
      this._pickAt(e.clientX, e.clientY);
      e.preventDefault();
      return;
    }
    if (this._pointers.size === 1) {
      this._vp.tx += (e.clientX - px);
      this._vp.ty += (e.clientY - py);
      this._emitViewport();
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
      const rect = this._canvas.getBoundingClientRect();
      const ip = screenToImg(g.midX - rect.left, g.midY - rect.top, g.vp);
      const t = solveAnchorTranslation(ip, scale, rot, midX - rect.left, midY - rect.top);
      this._vp = { tx: t.tx, ty: t.ty, scale, rot };
      this._emitViewport();
      this._invalidate();
    }
    e.preventDefault();
  }
  private _onUp(e: PointerEvent) {
    this._pointers.delete(e.pointerId);
    this._cancelLongPress();
    if (this._pointers.size === 0) this._endPick();
    if (this._pointers.size < 2) this._gestureStart = null;
    e.preventDefault?.();
  }
  private _onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = this._canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const ip = screenToImg(sx, sy, this._vp);
    const factor = e.ctrlKey || e.metaKey ? Math.exp(-e.deltaY * 0.01) : Math.exp(-e.deltaY * 0.005);
    const newScale = clamp(this._vp.scale * factor, 0.02, 50);
    const t = solveAnchorTranslation(ip, newScale, this._vp.rot, sx, sy);
    this._vp.tx = t.tx; this._vp.ty = t.ty; this._vp.scale = newScale;
    this._emitViewport();
    this._invalidate();
  }

  // ---- 吸色（v154；宿主拿事件接主吸色 setColor + pin）----
  private _cancelLongPress() {
    if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; }
    this._lpStart = null;
  }
  private _beginPick(e: PointerEvent) {
    this._picking = true;
    this._cancelLongPress();
    this._emit("colorpickstart");
    this._pickAt(e.clientX, e.clientY);
  }
  private _endPick() {
    if (!this._picking) return;
    this._picking = false;
    this._emit("colorpickend");
  }
  // 读自家 canvas 像素（所见即所吸）。透明区 hex=null（宿主收 pin）。半透明合成到白底。
  private _pickAt(clientX: number, clientY: number) {
    const rect = this._canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    let px = Math.round((clientX - rect.left) * dpr);
    let py = Math.round((clientY - rect.top) * dpr);
    px = Math.max(0, Math.min(this._canvas.width - 1, px));
    py = Math.max(0, Math.min(this._canvas.height - 1, py));
    let d;
    try { d = this._cctx.getImageData(px, py, 1, 1).data; } catch { return; }
    let r = d[0], g = d[1], b = d[2]; const a = d[3];
    if (a === 0) { this._emit("colorpick", { hex: null, screenX: clientX, screenY: clientY }); return; }
    if (a < 255) { const f = a / 255; r = Math.round(r * f + 255 * (1 - f)); g = Math.round(g * f + 255 * (1 - f)); b = Math.round(b * f + 255 * (1 - f)); }
    const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    this._emit("colorpick", { hex, screenX: clientX, screenY: clientY });
  }

  // ---- 渲染 ----
  private _resizeCanvasToBody() {
    const dpr = window.devicePixelRatio || 1;
    const w = this._bodyEl.clientWidth;
    const h = this._bodyEl.clientHeight;
    if (w <= 0 || h <= 0) return;
    this._canvas.width = Math.round(w * dpr);
    this._canvas.height = Math.round(h * dpr);
    this._canvas.style.width = w + "px";
    this._canvas.style.height = h + "px";
  }
  private _invalidate() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._render();
    });
  }
  // live 合成：只在脏标真起时问 provider；节流内保留脏标等 timer 补帧（S9）。
  private _recomposeLive(): boolean {
    if (!this._liveProvider) return true;
    const now = performance.now();
    const since = now - (this._lastLiveComposeT ?? -Infinity);
    if (since < LIVE_THROTTLE_MS) {
      if (this._liveThrottle == null) {
        this._liveThrottle = setTimeout(() => { this._liveThrottle = null; this._invalidate(); }, LIVE_THROTTLE_MS + 20 - since);
      }
      return false;
    }
    const src = this._liveProvider();
    if (!src) return true;   // 合成不可用（GL lost）→ 保留上帧（丢脏标，避免空转）
    this._lastLiveComposeT = now;
    this._liveSource = src;
    return true;
  }
  private _render() {
    if (this._liveProvider && this._liveDirty) {
      if (this._recomposeLive()) this._liveDirty = false;
    }
    const dpr = window.devicePixelRatio || 1;
    const W = this._canvas.width, H = this._canvas.height;
    const ctx = this._cctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const source = this._liveProvider ? this._liveSource : this._bitmap;
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
    // viewport：tx/ty 是 CSS 像素，要 × dpr；scale/rot 不动
    const v = this._vp;
    const c = Math.cos(v.rot), s = Math.sin(v.rot);
    ctx.setTransform(
      v.scale * c * dpr, v.scale * s * dpr,
      -v.scale * s * dpr, v.scale * c * dpr,
      v.tx * dpr, v.ty * dpr,
    );
    ctx.drawImage(source as CanvasImageSource, -source.width / 2, -source.height / 2);
  }

  private _updateEmptyHint() {
    const has = !!(this._bitmap || this._liveProvider);
    this._emptyEl.classList.toggle("hidden", has);
  }
}

function clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)); }

// 屏幕→图像坐标逆变换（anchor-preserving 用）。正变换：screen = R(rot)·S(scale)·img + (tx,ty)
function screenToImg(sx: number, sy: number, vp: RefViewport) {
  const c = Math.cos(-vp.rot), s = Math.sin(-vp.rot);
  const dx = sx - vp.tx, dy = sy - vp.ty;
  return { x: (dx * c - dy * s) / vp.scale, y: (dx * s + dy * c) / vp.scale };
}

export const WP_REFERENCE_WINDOW_TAG = "wp-reference-window";
if (!customElements.get(WP_REFERENCE_WINDOW_TAG)) {
  customElements.define(WP_REFERENCE_WINDOW_TAG, WpReferenceWindow);
}
