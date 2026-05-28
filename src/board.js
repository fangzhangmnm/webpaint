// Board = 显示层。把 PaintDoc 合成到屏幕 <canvas> 上 + 视口 pan/zoom + cursor 预览。
import { drawMesh, renderQuadPerPixel, extractMaskOutline } from "./lasso.js";
import { computeClipBaseFor } from "./doc.js";
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
    // viewport: tx/ty = screen-px offset of doc top-left (in scale=1, rot=0 frame),
    // scale = zoom, rot = radians (旋转锚点 = doc center). 见 _docToScreenAffine。
    this.viewport = { tx: 0, ty: 0, scale: 1, rot: 0 };
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

    // Live overlay provider：渲染时调一次，返回 {canvas, layer, opacity, mode} 或 null。
    // 笔触进行中由 brush.getLiveOverlay() 提供。paint 模式：layer 之上 composite buffer×opacity。
    // erase 模式：把 layer 画进 _eraseComposite，对它 dst-out buffer×opacity，再画到屏幕。
    this._overlayProvider = null;
    this._eraseComposite = null;
    this._eraseCompositeKey = null;

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

    // 首次：把 doc 居中适配
    this.fitToScreen();
  }

  setDoc(doc) {
    this.doc = doc;
    this._dirtyFull = true;
    this.fitToScreen();
  }

  setShowCheckerboard(on) {
    this._showCheckerboard = !!on;
    this._dirtyFull = true;
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
  screenToDoc(sx, sy) {
    const { scale, rot } = this.viewport;
    const { cx, cy } = this._docCenterScreen();
    const dx = sx - cx, dy = sy - cy;
    const c = Math.cos(-rot), s = Math.sin(-rot);
    const rx = dx * c - dy * s;
    const ry = dx * s + dy * c;
    return { x: rx / scale + this.doc.width / 2, y: ry / scale + this.doc.height / 2 };
  }
  docToScreen(dx, dy) {
    const { scale, rot } = this.viewport;
    const { cx, cy } = this._docCenterScreen();
    const x = (dx - this.doc.width / 2) * scale;
    const y = (dy - this.doc.height / 2) * scale;
    const c = Math.cos(rot), s = Math.sin(rot);
    return { x: x * c - y * s + cx, y: x * s + y * c + cy };
  }

  // ---- 视口 ----（任何视口变都是全屏 dirty）
  pan(dx, dy) {
    this.viewport.tx += dx;
    this.viewport.ty += dy;
    this._dirtyFull = true;
    this.requestRender();
  }
  // anchor 在 screen 坐标。zoom 时保 anchor 在 screen 上的 doc 点不变。
  zoomAt(anchorX, anchorY, factor) {
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
  rotateAt(anchorX, anchorY, deltaRot) {
    const docPt = this.screenToDoc(anchorX, anchorY);
    this.viewport.rot += deltaRot;
    const after = this.docToScreen(docPt.x, docPt.y);
    this.viewport.tx += anchorX - after.x;
    this.viewport.ty += anchorY - after.y;
    this._dirtyFull = true;
    this.requestRender();
  }

  setViewport(tx, ty, scale, rot) {
    this.viewport.tx = tx;
    this.viewport.ty = ty;
    this.viewport.scale = clamp(scale, this.minScale, this.maxScale);
    if (typeof rot === "number") this.viewport.rot = rot;
    this._dirtyFull = true;
    this.requestRender();
  }

  // 适配屏幕：让 doc 居中并铺满（留一点边）。同时复位 rotation。
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
    this.setViewport(tx, ty, scale, 0);   // 复位 rotation
  }

  // 公共 API：layer 像素被改了（图层结构变 / 切换 / putImageData 等）
  invalidateAll() {
    this._dirtyFull = true;
    this.requestRender();
  }

  setOverlayProvider(fn) {
    this._overlayProvider = fn;
  }
  // 套索 overlay：在 layer 像素之上画一条 polygon (drawing) 或 floating canvas + marching ants
  setLassoProvider(fn) {
    this._lassoProvider = fn;
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
  // Clipping mask 临时合成 canvas。grow-only：取所有用过的 layer.bbox 最大值。
  // 不和 _eraseComposite 共用（同一帧可能两者都要）。
  _getClipTmp(w, h) {
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
  _getOverlayClipTmp(w, h) {
    if (!this._overlayClipTmp || this._overlayClipTmp.width < w || this._overlayClipTmp.height < h) {
      const nw = Math.max(this._overlayClipTmp?.width || 0, w);
      const nh = Math.max(this._overlayClipTmp?.height || 0, h);
      this._overlayClipTmp = document.createElement("canvas");
      this._overlayClipTmp.width = nw;
      this._overlayClipTmp.height = nh;
    }
    return this._overlayClipTmp;
  }
  // 把笔刷 live overlay 按 doc.selection mask 裁一遍，让画中实时看到选区限制。
  // 返回一个**新 overlay 描述**，canvas 指向裁过的临时 canvas；bbox 保持不变（局部坐标不变）。
  // 落笔后 applySelectionMaskPostStroke 会做最终持久化裁；这里只是 preview。
  _clipOverlayToSelection(overlay, selection) {
    const tmp = this._getOverlayClipTmp(overlay.bboxW, overlay.bboxH);
    const tctx = tmp.getContext("2d");
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, overlay.bboxW, overlay.bboxH);
    tctx.drawImage(overlay.canvas, 0, 0);
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(
      selection.maskCanvas,
      selection.bboxX - overlay.bboxX,
      selection.bboxY - overlay.bboxY,
    );
    tctx.globalCompositeOperation = "source-over";
    return { ...overlay, canvas: tmp };
  }
  // 给一颗 clipping mask 层做 dst-in 剪裁 + composite 到 ctx。
  // 算法：在 tmp 上先以 layer.bbox 局部坐标渲染 (layer + overlay) → dst-in base alpha
  //       → 把 tmp 当一张 (bboxW × bboxH) image drawImage 到 ctx 的 doc 坐标 bbox 位置。
  // 注意：tmp 复用，先 clearRect(0, 0, bboxW, bboxH) 防上一次脏数据残留。
  _renderLayerClipped(ctx, layer, baseLayer, overlay) {
    const tmp = this._getClipTmp(layer.bboxW, layer.bboxH);
    const tctx = tmp.getContext("2d");
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, layer.bboxW, layer.bboxH);
    // 平移使 layer.bboxX/Y 对齐到 tmp (0,0) → _drawLayerWithOverlay 用的
    // drawImage(layer.canvas, layer.bboxX, layer.bboxY) 落到 tmp (0,0)
    tctx.setTransform(1, 0, 0, 1, -layer.bboxX, -layer.bboxY);
    this._drawLayerWithOverlay(tctx, layer, overlay);
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(baseLayer.canvas, baseLayer.bboxX - layer.bboxX, baseLayer.bboxY - layer.bboxY);
    tctx.globalCompositeOperation = "source-over";
    ctx.drawImage(
      tmp, 0, 0, layer.bboxW, layer.bboxH,
      layer.bboxX, layer.bboxY, layer.bboxW, layer.bboxH,
    );
  }

  // 把 (layer, overlay) 在 ctx 上 composite。ctx 已经被调用方 setTransform
  // 到 **doc 坐标系**（doc (0,0) = ctx origin，doc (W,H) = (W,H) in ctx）。
  // 所以这里 drawImage 的 dest 直接用 layer.bboxX/Y/W/H（doc 坐标）。
  _drawLayerWithOverlay(ctx, layer, overlay) {
    if (!overlay || overlay.mode !== "erase") {
      ctx.drawImage(
        layer.canvas, 0, 0, layer.bboxW, layer.bboxH,
        layer.bboxX, layer.bboxY, layer.bboxW, layer.bboxH,
      );
      if (overlay) {
        const prevA = ctx.globalAlpha;
        ctx.globalAlpha = ctx.globalAlpha * overlay.opacity;
        ctx.drawImage(
          overlay.canvas, 0, 0, overlay.bboxW, overlay.bboxH,
          overlay.bboxX, overlay.bboxY, overlay.bboxW, overlay.bboxH,
        );
        ctx.globalAlpha = prevA;
      }
      return;
    }
    // erase 通路
    const ec = this._getEraseComposite(layer.bboxW, layer.bboxH);
    const ectx = ec.getContext("2d");
    ectx.clearRect(0, 0, ec.width, ec.height);
    ectx.drawImage(layer.canvas, 0, 0);
    ectx.globalAlpha = overlay.opacity;
    ectx.globalCompositeOperation = "destination-out";
    ectx.drawImage(overlay.canvas, overlay.bboxX - layer.bboxX, overlay.bboxY - layer.bboxY);
    ectx.globalAlpha = 1;
    ectx.globalCompositeOperation = "source-over";
    ctx.drawImage(
      ec, 0, 0, ec.width, ec.height,
      layer.bboxX, layer.bboxY, ec.width, ec.height,
    );
  }

  // 把 ctx 设到 "doc 坐标系"：doc (0,0) 映射到 ctx 当前 origin，含 dpr +
  // viewport (tx,ty,scale,rot) 全部。setTransform 接 6 浮点 a,b,c,d,e,f：
  //   screen.x = a*doc.x + c*doc.y + e
  //   screen.y = b*doc.x + d*doc.y + f
  // 我们的视口：先平移 -W/2 (-H/2) → 缩放 scale → 旋转 rot → 平移到屏幕上
  // doc center。dpr 在所有之外（用 setTransform 顶层再乘）。
  _applyDocTransform(ctx) {
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
    ctx.setTransform(dpr * a, dpr * b, dpr * c, dpr * d, dpr * e, dpr * f);
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

    // 2) 切到 doc 坐标系（含 dpr / scale / rot / translate）
    this._applyDocTransform(ctx);
    const { scale } = this.viewport;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = scale < 0.5 ? "low" : "high";

    // doc 背景：默认 backgroundColor；开了棋盘则画半透明灰白格（Procreate 透明背景同款）
    if (this._showCheckerboard) {
      this._drawCheckerboard(ctx, this.doc.width, this.doc.height);
    } else {
      ctx.fillStyle = this.doc.backgroundColor || "#ffffff";
      ctx.fillRect(0, 0, this.doc.width, this.doc.height);
    }

    // 逐 layer（带 clipping mask 处理）
    this._renderLayers(ctx);

    // 套索 overlay（在 doc 坐标系下画 polygon / floating）
    this._drawLassoOverlay(ctx, scale);

    // doc 边框（doc 坐标系下；lineWidth 在缩放 / 旋转下会变粗细，
    // 需要 inverse-scale lineWidth）
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, this.doc.width, this.doc.height);

    // cursor 预览（切回 screen 坐标）
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this._showCursor && this._cursor) this._drawCursor();
  }

  // 只重画 docRect 覆盖的区域。**rot != 0 时直接走 full**（旋转 dirty rect
  // 在 screen 上是斜矩形，clip + 算屏幕 bbox 复杂度不值，stamp 路径少见旋转后画）
  _renderPartial(docRect) {
    // 套索浮层 / drawing path 走全屏（overlay 在 dirty rect 外的覆盖需重画）
    if (this._lassoProvider) {
      const info = this._lassoProvider();
      if (info && (info.drawingPath?.length || info.floating)) { this._renderFull(); return; }
    }
    if (this.viewport.rot !== 0) {
      this._renderFull();
      return;
    }
    const ctx = this.ctx;
    const { tx, ty, scale } = this.viewport;

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
    if (sx + sw < 0 || sy + sh < 0 || sx > w || sy > h) return;

    ctx.save();
    // Clip 用 screen 坐标
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(sx, sy, sw, sh);
    ctx.clip();
    // 重底色 (screen)
    ctx.fillStyle = this._voidColor;
    ctx.fillRect(sx, sy, sw, sh);

    // 切到 doc 坐标系画 layer
    this._applyDocTransform(ctx);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = scale < 0.5 ? "low" : "high";
    if (this._showCheckerboard) {
      this._drawCheckerboard(ctx, this.doc.width, this.doc.height);
    } else {
      ctx.fillStyle = this.doc.backgroundColor || "#ffffff";
      ctx.fillRect(0, 0, this.doc.width, this.doc.height);
    }
    this._renderLayers(ctx);

    ctx.restore();
  }
  // 一段逻辑两处用（_renderFull / _renderPartial）。带 clipping mask 处理。
  // ctx 已经在 doc 坐标系（drawImage 的 dest 用 doc 坐标）。
  _renderLayers(ctx) {
    const overlay = this._overlayProvider?.();
    const layers = this.doc.layers;
    const baseFor = computeClipBaseFor(layers);
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (!layer.visible) continue;
      if (layer.bboxW <= 0 || layer.bboxH <= 0) continue;
      const prevAlpha = ctx.globalAlpha;
      const prevComp = ctx.globalCompositeOperation;
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.mode || "source-over";
      let lOverlay = overlay && overlay.layer === layer ? overlay : null;
      // 笔刷 live overlay 也要 respect 选区：在画里实时看到限制范围
      if (lOverlay && this.doc.selection) {
        lOverlay = this._clipOverlayToSelection(lOverlay, this.doc.selection);
      }
      const baseIdx = baseFor[i];
      if (baseIdx < 0) {
        this._drawLayerWithOverlay(ctx, layer, lOverlay);
      } else {
        this._renderLayerClipped(ctx, layer, layers[baseIdx], lOverlay);
      }
      ctx.globalAlpha = prevAlpha;
      ctx.globalCompositeOperation = prevComp;
    }
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

  // 套索 overlay：
  //   drawing 期间：画 polyline overlay
  //   floating：用 mesh 三角剖分画浮层；画 mesh 边框 + 内部线 + handles
  // 边框 / mesh 线在 doc 坐标系（随缩放）；handles 在 screen 坐标（恒定像素大小）
  _drawLassoOverlay(ctx, scale) {
    if (!this._lassoProvider) return;
    const info = this._lassoProvider();
    if (!info) return;
    // (a) 选区蚂蚁线：marching squares 抽 mask 轮廓 → 黑白相间虚线。
    // 真"相间"：dash 和 gap 等长，白色 dashOffset 偏一个 dash，正好填黑的空位。
    // 不要动画（user 反馈太干扰）。线宽 1 / scale = 1 CSS px。
    if (info.selection && !info.floating) {
      const s = info.selection;
      if (!s._outline) s._outline = extractMaskOutline(s);
      const segs = s._outline;
      ctx.save();
      // outline segs 是 mask 局部坐标；平移到 selection bbox 在 doc 坐标的位置
      ctx.translate(s.bboxX, s.bboxY);
      ctx.lineWidth = 1 / scale;
      ctx.lineCap = "butt";
      const dash = 4 / scale;
      ctx.beginPath();
      for (let i = 0; i < segs.length; i += 4) {
        ctx.moveTo(segs[i],     segs[i + 1]);
        ctx.lineTo(segs[i + 2], segs[i + 3]);
      }
      ctx.setLineDash([dash, dash]);
      ctx.lineDashOffset = 0;
      ctx.strokeStyle = "#000";
      ctx.stroke();
      ctx.lineDashOffset = dash;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      ctx.restore();
    }
    // (b) 正在画的 path
    if (info.drawingPath && info.drawingPath.length >= 2) {
      ctx.save();
      ctx.lineWidth = Math.max(1, 1.5 / scale);
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.beginPath();
      const pts = info.drawingPath;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineDashOffset = 5 / scale;
      ctx.stroke();
      ctx.restore();
    }
    // (c) 正在拖的矩形 / 椭圆
    const drawShape = info.drawingRect || info.drawingEllipse;
    if (drawShape) {
      const r = drawShape;
      ctx.save();
      ctx.lineWidth = Math.max(1, 1.5 / scale);
      ctx.setLineDash([6 / scale, 4 / scale]);
      const x = Math.min(r.x0, r.x1), y = Math.min(r.y0, r.y1);
      const w = Math.abs(r.x1 - r.x0), h = Math.abs(r.y1 - r.y0);
      const isEllipse = !!info.drawingEllipse;
      const stroke2x = () => {
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.lineDashOffset = 0;
        ctx.stroke();
        ctx.strokeStyle = "rgba(255,255,255,0.8)";
        ctx.lineDashOffset = 5 / scale;
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
      const isWarp = f.mode === "warp";
      ctx.save();
      // 1) 浮层像素
      //   - 2×2 mesh：per-pixel inverse homography（math-exact，~50ms / 帧 in drag）
      //     缓存到 f._renderCache；mesh 变了 lasso.js 那边 invalidate
      //   - 4×4 mesh (warp)：暂走 Catmull-Rom + 三角化。下个 PR 替成 forward splat
      if (f.meshN === 2) {
        if (!f._renderCache) {
          f._renderCache = renderQuadPerPixel(f.imageData, f.srcW, f.srcH, f.mesh);
        }
        if (f._renderCache) {
          ctx.drawImage(f._renderCache.canvas, f._renderCache.dstX, f._renderCache.dstY);
        }
      } else {
        drawMesh(ctx, f.canvas, f.srcW, f.srcH, f.mesh, { smooth: isWarp });
      }
      // 2) mesh 网格线 + 外框
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
      // warp 内部网格：低调（细 + 半透明 + 无 dash），不要抢戏
      if (isWarp && f.mode !== null) {
        ctx.setLineDash([]);
        ctx.lineWidth = Math.max(0.5, 0.75 / scale);
        ctx.strokeStyle = "rgba(128,128,128,0.35)";
        ctx.beginPath();
        for (let i = 1; i < N - 1; i++) {
          ctx.moveTo(f.mesh[i][0].x, f.mesh[i][0].y);
          for (let j = 1; j < N; j++) ctx.lineTo(f.mesh[i][j].x, f.mesh[i][j].y);
        }
        for (let j = 1; j < N - 1; j++) {
          ctx.moveTo(f.mesh[0][j].x, f.mesh[0][j].y);
          for (let i = 1; i < N; i++) ctx.lineTo(f.mesh[i][j].x, f.mesh[i][j].y);
        }
        ctx.stroke();
      }
      ctx.restore();
      // 3) handles 切屏幕坐标画。warp 用小填点（不画圈），其余画白圆+黑边
      if (info.handles && info.handles.length) {
        ctx.save();
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        for (const h of info.handles) {
          const s = this.docToScreen(h.pos.x, h.pos.y);
          if (h.kind === "warp-point") {
            // 小填点 + 极细外圈，不抢眼
            ctx.beginPath();
            ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(0,0,0,0.6)";
            ctx.fill();
            ctx.beginPath();
            ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(255,255,255,0.8)";
            ctx.lineWidth = 1;
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
  _drawCheckerboard(ctx, W, H) {
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
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
