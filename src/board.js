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

    // Dirty tracking：
    // _dirtyDocRect = 笔触改了的 doc-px bbox（[x0,y0,x1,y1]），渲染时只 blit 这一片
    // _dirtyFull    = 视口 / 主题 / 光标 / 图层结构改了 → 整张重画
    this._dirtyDocRect = null;
    this._dirtyFull = true;

    // 主题色：从 CSS 变量取
    this._voidColor = "#e6e2d6";

    // Live overlay provider：渲染时调一次，返回 {canvas, layer, opacity, mode} 或 null。
    // 笔触进行中由 brush.getLiveOverlay() 提供。paint 模式：layer 之上 composite buffer×opacity。
    // erase 模式：把 layer 画进 _eraseComposite，对它 dst-out buffer×opacity，再画到屏幕。
    this._overlayProvider = null;
    this._eraseComposite = null;
    this._eraseCompositeKey = null;

    this.resize();
    window.addEventListener("resize", () => this.resize());

    // 首次：把 doc 居中适配
    this.fitToScreen();
  }

  setDoc(doc) {
    this.doc = doc;
    this._dirtyFull = true;
    this.fitToScreen();
  }

  setThemeColors({ voidColor }) {
    if (voidColor) this._voidColor = voidColor;
    this._dirtyFull = true;
    this.requestRender();
  }

  // 由 BrushEngine 报告："这一帧 layer 像素被改在这片 doc-px bbox 里"
  markDocDirty(x0, y0, x1, y1) {
    if (this._dirtyDocRect) {
      const d = this._dirtyDocRect;
      if (x0 < d[0]) d[0] = x0;
      if (y0 < d[1]) d[1] = y0;
      if (x1 > d[2]) d[2] = x1;
      if (y1 > d[3]) d[3] = y1;
    } else {
      this._dirtyDocRect = [x0, y0, x1, y1];
    }
  }
  // 视口 / 主题 / 光标 / 图层结构改了 → 整张重画
  markFullDirty() {
    this._dirtyFull = true;
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

  // ---- 视口 ----（任何视口变都是全屏 dirty）
  pan(dx, dy) {
    this.viewport.tx += dx;
    this.viewport.ty += dy;
    this._dirtyFull = true;
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
    this._dirtyFull = true;
    this.requestRender();
  }
  setViewport(tx, ty, scale) {
    this.viewport.tx = tx;
    this.viewport.ty = ty;
    this.viewport.scale = clamp(scale, this.minScale, this.maxScale);
    this._dirtyFull = true;
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

  // 公共 API：layer 像素被改了（图层结构变 / 切换 / putImageData 等）
  invalidateAll() {
    this._dirtyFull = true;
    this.requestRender();
  }

  setOverlayProvider(fn) {
    this._overlayProvider = fn;
  }

  // 复用 erase 临时合成 canvas（同 doc 尺寸；改了重新分配）
  _getEraseComposite(w, h) {
    const key = `${w}x${h}`;
    if (!this._eraseComposite || this._eraseCompositeKey !== key) {
      this._eraseComposite = document.createElement("canvas");
      this._eraseComposite.width = w;
      this._eraseComposite.height = h;
      this._eraseCompositeKey = key;
    }
    return this._eraseComposite;
  }

  // 把 (layer, overlay) 在屏幕上 composite。layer 和 overlay 都带 doc 坐标
  // 的 bbox（bboxX/Y/W/H），可以位于 doc 内任何位置 / 任意尺寸。
  // paint = layer.canvas 画到屏幕 + overlay.canvas 在它之上画 × opacity
  // erase = 临时画布做 (layer dst-out overlay×opacity)，再画上去
  _drawLayerWithOverlay(ctx, layer, overlay, tx, ty, scale) {
    if (!overlay || overlay.mode !== "erase") {
      ctx.drawImage(
        layer.canvas, 0, 0, layer.bboxW, layer.bboxH,
        tx + layer.bboxX * scale, ty + layer.bboxY * scale,
        layer.bboxW * scale, layer.bboxH * scale,
      );
      if (overlay) {
        const prevA = ctx.globalAlpha;
        ctx.globalAlpha = ctx.globalAlpha * overlay.opacity;
        ctx.drawImage(
          overlay.canvas, 0, 0, overlay.bboxW, overlay.bboxH,
          tx + overlay.bboxX * scale, ty + overlay.bboxY * scale,
          overlay.bboxW * scale, overlay.bboxH * scale,
        );
        ctx.globalAlpha = prevA;
      }
      return;
    }
    // erase 通路：临时 canvas 用 layer 的 bbox 尺寸（buffer 可能更大，但 layer
    // bbox 已被 stamp 路径 ensureBbox 扩到 ⊇ buffer，所以 layer.bbox ⊇ buffer.bbox 总成立）
    const ec = this._getEraseComposite(layer.bboxW, layer.bboxH);
    const ectx = ec.getContext("2d");
    ectx.clearRect(0, 0, ec.width, ec.height);
    ectx.drawImage(layer.canvas, 0, 0);
    ectx.globalAlpha = overlay.opacity;
    ectx.globalCompositeOperation = "destination-out";
    // overlay → layer-local（在 ec 这张图上的位置）
    ectx.drawImage(overlay.canvas, overlay.bboxX - layer.bboxX, overlay.bboxY - layer.bboxY);
    ectx.globalAlpha = 1;
    ectx.globalCompositeOperation = "source-over";
    ctx.drawImage(
      ec, 0, 0, ec.width, ec.height,
      tx + layer.bboxX * scale, ty + layer.bboxY * scale,
      ec.width * scale, ec.height * scale,
    );
  }

  // ---- 渲染 ----
  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this._dirtyFull = true;
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
    // 光标改了 → 整张 dirty（光标是 screen-space，无法做 doc-rect dirty；好在 hover
    // 不是绘画 hot path）。Stroke 期间 input.js 会调 setCursor(null)，所以画的时候
    // 不会触发这条全屏 invalidation。
    const wasShown = this._showCursor;
    this._cursor = c;
    this._showCursor = !!c;
    if (wasShown || this._showCursor) this._dirtyFull = true;
    this.requestRender();
  }

  render() {
    if (!this.doc) return;
    if (this._dirtyFull || !this._dirtyDocRect) {
      this._renderFull();
    } else {
      this._renderPartial(this._dirtyDocRect);
    }
    this._dirtyDocRect = null;
    this._dirtyFull = false;
  }

  _renderFull() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;

    // 1) 底色
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this._voidColor;
    ctx.fillRect(0, 0, W, H);

    // 2) 切到 CSS px 坐标
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const { tx, ty, scale } = this.viewport;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = scale < 0.5 ? "low" : "high";

    // doc 背景
    ctx.fillStyle = this.doc.backgroundColor || "#ffffff";
    ctx.fillRect(tx, ty, this.doc.width * scale, this.doc.height * scale);

    // 逐 layer
    const overlay = this._overlayProvider?.();
    for (const layer of this.doc.layers) {
      if (!layer.visible) continue;
      const prevAlpha = ctx.globalAlpha;
      const prevComp = ctx.globalCompositeOperation;
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.mode || "source-over";
      const lOverlay = overlay && overlay.layer === layer ? overlay : null;
      this._drawLayerWithOverlay(ctx, layer, lOverlay, tx, ty, scale);
      ctx.globalAlpha = prevAlpha;
      ctx.globalCompositeOperation = prevComp;
    }

    // doc 边框
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(tx) + 0.5,
      Math.round(ty) + 0.5,
      Math.round(this.doc.width * scale),
      Math.round(this.doc.height * scale),
    );

    // cursor 预览
    if (this._showCursor && this._cursor) this._drawCursor();
  }

  // 只重画 docRect = [x0,y0,x1,y1]（doc-px）覆盖的屏幕区域。
  // GPU 端依然要采样 layer 的源 texel，但只在 dirty 屏幕像素上算 + blit。
  // 笔触越细 / 视口越缩小，这边省得越多。
  _renderPartial(docRect) {
    const ctx = this.ctx;
    const { tx, ty, scale } = this.viewport;

    // 多 pad 几个 doc-px 给 AA / 缩放 bleed
    const pad = Math.max(1, 2 / scale);
    const dx0 = docRect[0] - pad;
    const dy0 = docRect[1] - pad;
    const dx1 = docRect[2] + pad;
    const dy1 = docRect[3] + pad;

    const sx = dx0 * scale + tx;
    const sy = dy0 * scale + ty;
    const sw = (dx1 - dx0) * scale;
    const sh = (dy1 - dy0) * scale;

    const w = this.canvas.clientWidth || this.canvas.width / this.dpr;
    const h = this.canvas.clientHeight || this.canvas.height / this.dpr;
    // 完全在视口外 → no-op
    if (sx + sw < 0 || sy + sh < 0 || sx > w || sy > h) return;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = scale < 0.5 ? "low" : "high";

    ctx.beginPath();
    ctx.rect(sx, sy, sw, sh);
    ctx.clip();

    // 重画：底色 → doc bg → 逐 layer。clip 把它们裁到 dirty 矩形里
    ctx.fillStyle = this._voidColor;
    ctx.fillRect(sx, sy, sw, sh);
    ctx.fillStyle = this.doc.backgroundColor || "#ffffff";
    ctx.fillRect(tx, ty, this.doc.width * scale, this.doc.height * scale);
    const overlay = this._overlayProvider?.();
    for (const layer of this.doc.layers) {
      if (!layer.visible) continue;
      const prevAlpha = ctx.globalAlpha;
      const prevComp = ctx.globalCompositeOperation;
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.mode || "source-over";
      const lOverlay = overlay && overlay.layer === layer ? overlay : null;
      this._drawLayerWithOverlay(ctx, layer, lOverlay, tx, ty, scale);
      ctx.globalAlpha = prevAlpha;
      ctx.globalCompositeOperation = prevComp;
    }

    ctx.restore();
    // 注意：partial render 不重画 doc 边框 / cursor，它们保留上一帧的像素就行。
    // 任何视口 / 主题 / cursor 变化都会触发 _dirtyFull，下一帧会全画一次。
  }

  _drawCursor() {
    const ctx = this.ctx;
    const c = this._cursor;
    const { scale } = this.viewport;
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

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
