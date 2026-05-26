// Board = 显示层。把 PaintDoc 合成到屏幕 <canvas> 上 + 视口 pan/zoom + cursor 预览。
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
const MAX_SCALE = 32;

export class Board {
  constructor(canvas, doc) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.doc = doc;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.viewport = { tx: 0, ty: 0, scale: 1 };
    this.minScale = MIN_SCALE;
    this.maxScale = MAX_SCALE;
    this._raf = null;
    this._cursor = null;            // {x, y, size} in screen px，可选
    this._showCursor = false;

    // 主题色：从 CSS 变量取
    this._voidColor = "#e6e2d6";

    this.resize();
    window.addEventListener("resize", () => this.resize());

    // 首次：把 doc 居中适配
    this.fitToScreen();
  }

  setDoc(doc) {
    this.doc = doc;
    this.fitToScreen();
  }

  setThemeColors({ voidColor }) {
    if (voidColor) this._voidColor = voidColor;
    this.requestRender();
  }

  // ---- 坐标 ----
  screenToDoc(sx, sy) {
    const { tx, ty, scale } = this.viewport;
    return { x: (sx - tx) / scale, y: (sy - ty) / scale };
  }
  docToScreen(dx, dy) {
    const { tx, ty, scale } = this.viewport;
    return { x: dx * scale + tx, y: dy * scale + ty };
  }

  // ---- 视口 ----
  pan(dx, dy) {
    this.viewport.tx += dx;
    this.viewport.ty += dy;
    this.requestRender();
  }
  zoomAt(anchorX, anchorY, factor) {
    const oldScale = this.viewport.scale;
    const newScale = clamp(oldScale * factor, this.minScale, this.maxScale);
    if (newScale === oldScale) return;
    const k = newScale / oldScale;
    this.viewport.tx = anchorX - (anchorX - this.viewport.tx) * k;
    this.viewport.ty = anchorY - (anchorY - this.viewport.ty) * k;
    this.viewport.scale = newScale;
    this.requestRender();
  }
  setViewport(tx, ty, scale) {
    this.viewport.tx = tx;
    this.viewport.ty = ty;
    this.viewport.scale = clamp(scale, this.minScale, this.maxScale);
    this.requestRender();
  }

  // 适配屏幕：让 doc 居中并铺满（留一点边）。
  fitToScreen(padding = 24) {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (!this.doc) return;
    const sx = (w - padding * 2) / this.doc.width;
    const sy = (h - padding * 2) / this.doc.height;
    const s = Math.min(sx, sy);
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
    const tx = (w - this.doc.width * scale) / 2;
    const ty = (h - this.doc.height * scale) / 2;
    this.setViewport(tx, ty, scale);
  }

  // ---- 渲染 ----
  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.requestRender();
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.render();
    });
  }

  setCursor(c) {
    this._cursor = c;
    this._showCursor = !!c;
    this.requestRender();
  }

  render() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;

    // 1) 底色
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this._voidColor;
    ctx.fillRect(0, 0, W, H);

    if (!this.doc) return;

    // 2) 切到 CSS px 坐标
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const { tx, ty, scale } = this.viewport;

    // 视口下采样优化：scale 远小于 1 时让浏览器用低品质 image smoothing（默认即可）
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = scale < 0.5 ? "low" : "high";

    // doc 背景
    ctx.fillStyle = this.doc.backgroundColor || "#ffffff";
    ctx.fillRect(tx, ty, this.doc.width * scale, this.doc.height * scale);

    // 3) 逐 layer
    for (const layer of this.doc.layers) {
      if (!layer.visible) continue;
      const prevAlpha = ctx.globalAlpha;
      const prevComp = ctx.globalCompositeOperation;
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.mode || "source-over";
      ctx.drawImage(
        layer.canvas,
        0, 0, layer.width, layer.height,
        tx, ty, layer.width * scale, layer.height * scale,
      );
      ctx.globalAlpha = prevAlpha;
      ctx.globalCompositeOperation = prevComp;
    }

    // 4) doc 边框
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(tx) + 0.5,
      Math.round(ty) + 0.5,
      Math.round(this.doc.width * scale),
      Math.round(this.doc.height * scale),
    );

    // 5) cursor 预览（笔尖）
    if (this._showCursor && this._cursor) {
      const c = this._cursor;
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(2, c.size * scale / 2), 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(2, c.size * scale / 2) + 1, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
