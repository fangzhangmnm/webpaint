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
// 不做（避免和主画布混淆）：
// - 不参与吸色 / 笔刷 / undo
// - 不持久化原图（dataURL 占空间）—— 关掉 panel = 释放图。下次开要重新选

const LS_POS = "webpaint.refPanel.pos";       // {left, top, width, height}
const LS_VP  = "webpaint.refPanel.vp";        // {tx, ty, scale, rot}

export class ReferenceWindow {
  constructor(opts) {
    this.panel   = opts.panel;                 // .float-panel
    this.head    = opts.head;                  // 拖动标题栏
    this.body    = opts.body;                  // 装 canvas 的 div
    this.canvas  = opts.canvas;                // 内部画图 canvas
    this.closeBtn = opts.closeBtn;
    this.emptyHint = opts.emptyHint;           // "选个图…" 占位文字
    this.status  = opts.status || (() => {});
    this.ctx = this.canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";

    this.bitmap = null;                        // 当前显示的 ImageBitmap
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
  setBitmap(bitmap) {
    if (this.bitmap && this.bitmap !== bitmap) this.bitmap.close?.();
    this.bitmap = bitmap;
    if (bitmap) this.fitToPanel();
    this._updateEmptyHint();
    this._invalidate();
  }
  open() {
    this.panel.classList.remove("hidden");
    this._resizeCanvasToBody();
    this._updateEmptyHint();
    this._invalidate();
  }
  close() {
    this.panel.classList.add("hidden");
  }
  isOpen() { return !this.panel.classList.contains("hidden"); }
  toggle() { this.isOpen() ? this.close() : this.open(); }

  fitToPanel() {
    if (!this.bitmap) return;
    const bw = this.canvas.width / (window.devicePixelRatio || 1);
    const bh = this.canvas.height / (window.devicePixelRatio || 1);
    const iw = this.bitmap.width, ih = this.bitmap.height;
    if (iw <= 0 || ih <= 0 || bw <= 0 || bh <= 0) return;
    const s = Math.min(bw / iw, bh / ih) * 0.95;
    this.vp = { tx: bw / 2, ty: bh / 2, scale: s, rot: 0 };
    this._saveVp();
    this._invalidate();
  }

  // ---- 内部 ----
  _bind() {
    // 关
    this.closeBtn.addEventListener("click", () => this.close());

    // 拖整窗（标题栏）
    this.head.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".float-panel-close")) return;
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
    const ro = new ResizeObserver(() => {
      this._resizeCanvasToBody();
      this._invalidate();
      this._savePos();
    });
    ro.observe(this.body);
  }

  _onDown(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pointers.size === 2) {
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
  _onMove(e) {
    const p = this._pointers.get(e.pointerId);
    if (!p) return;
    const px = p.x, py = p.y;
    p.x = e.clientX; p.y = e.clientY;
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
      const k = dist / g.dist;
      let dRot = angle - g.angle;
      if (dRot > Math.PI) dRot -= 2 * Math.PI;
      if (dRot < -Math.PI) dRot += 2 * Math.PI;
      // anchor-preserving: 把 g.midX/Y 那个 image 坐标在新 viewport 下保持在 midX/Y
      const newScale = clamp(g.vp.scale * k, 0.02, 50);
      const newRot = g.vp.rot + dRot;
      // 求 newTx, newTy 使 image-point(=screenToImg(g.midX, g.midY, g.vp)) 落到 (midX, midY)
      const rect = this.canvas.getBoundingClientRect();
      const sm0 = g.midX - rect.left;
      const sm1 = g.midY - rect.top;
      const sx = midX - rect.left;
      const sy = midY - rect.top;
      // image point under g.vp
      const ip = screenToImg(sm0, sm1, g.vp);
      // 求 newTx newTy: imgToScreen(ip, vp') == (sx, sy)
      // imgToScreen: (img.x * scale * cos - img.y * scale * sin + tx, ... + ty)
      const c = Math.cos(newRot), si = Math.sin(newRot);
      const newTx = sx - (ip.x * newScale * c - ip.y * newScale * si);
      const newTy = sy - (ip.x * newScale * si + ip.y * newScale * c);
      this.vp = { tx: newTx, ty: newTy, scale: newScale, rot: newRot };
      this._saveVp();
      this._invalidate();
    }
    e.preventDefault();
  }
  _onUp(e) {
    this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) this._gestureStart = null;
    if (this._pointers.size === 1) {
      // 还有一指 → 不进 gesture，单指 pan 接续。先 reset start
      this._gestureStart = null;
    }
    e.preventDefault?.();
  }
  _onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const ip = screenToImg(sx, sy, this.vp);
    const factor = e.ctrlKey || e.metaKey ? Math.exp(-e.deltaY * 0.01) : Math.exp(-e.deltaY * 0.005);
    const newScale = clamp(this.vp.scale * factor, 0.02, 50);
    const c = Math.cos(this.vp.rot), si = Math.sin(this.vp.rot);
    this.vp.tx = sx - (ip.x * newScale * c - ip.y * newScale * si);
    this.vp.ty = sy - (ip.x * newScale * si + ip.y * newScale * c);
    this.vp.scale = newScale;
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
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.width, H = this.canvas.height;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!this.bitmap) return;
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
    // image 中心对齐 viewport 原点（rotate 围绕中心而非左上角）
    ctx.drawImage(this.bitmap, -this.bitmap.width / 2, -this.bitmap.height / 2);
  }

  _updateEmptyHint() {
    if (!this.emptyHint) return;
    this.emptyHint.classList.toggle("hidden", !!this.bitmap);
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
      if (o.left != null) this.panel.style.left = o.left + "px";
      if (o.top != null) this.panel.style.top = o.top + "px";
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

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// 屏幕→图像坐标的逆变换（用于 anchor-preserving）。屏幕坐标 sx/sy = relative to canvas top-left
// 正变换：screen = R(rot) · S(scale) · img + (tx, ty)；逆变换 img = S^-1 · R^-1 · (screen - tx, ty)
function screenToImg(sx, sy, vp) {
  const c = Math.cos(-vp.rot), s = Math.sin(-vp.rot);
  const dx = sx - vp.tx, dy = sy - vp.ty;
  return { x: (dx * c - dy * s) / vp.scale, y: (dx * s + dy * c) / vp.scale };
}
