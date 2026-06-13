// Board = 显示层。把 PaintDoc 合成到屏幕 <canvas> 上 + 视口 pan/zoom + cursor 预览。
import { drawMesh, renderQuadPerPixel } from "./lasso.js";
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
const MAX_SCALE = 64;   // v163：放大上限提到 64，给像素画 + 像素栅格留空间
// 像素栅格淡入：scale < LO 全隐（释放 backing）；LO→FULL 之间 alpha 线性渐隐；≥ FULL 满强度。
// 渐隐避免缩放时栅格"啪"地消失，且往低 zoom 多留一段。
const PIXEL_GRID_FADE_LO = 4;
const PIXEL_GRID_FULL = 7;
const PIXEL_GRID_ALPHA = 0.4;   // 满强度 alpha（线已是 1 device px 最细，靠 alpha 调细的观感）

export class Board {
  constructor(canvas, doc) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
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
    this.gridCanvas = document.getElementById("boardGrid");
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
  setPixelGridEnabled(on) {
    this._pixelGridEnabled = !!on;
    this._gridSig = "";        // 强制下次 _syncGrid 重算
    this.requestRender();
  }
  getPixelGridEnabled() { return this._pixelGridEnabled; }
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

  // v131: liquify / filter brush 等没用 overlay 但仍需禁 partial。fn 返回 truthy = 强全屏
  setStrokeActiveHint(fn) { this._strokeActiveHint = fn; }

  setOverlayProvider(fn) {
    this._overlayProvider = fn;
  }
  // 套索 overlay：在 layer 像素之上画一条 polygon (drawing) 或 floating canvas + marching ants
  setLassoProvider(fn) {
    this._lassoProvider = fn;
  }
  // v110: 给某 layer 在 board 渲染时套 ctx.filter（颜色调整 live preview）—— v113 撤
  // ctx.filter on iPad Safari Canvas2D 偶发不渲染 (user：「颜色调整预览，apply 都没用」)
  setActiveLayerFilter() { /* no-op, replaced by surrogate */ }
  // v113: 颜色调整 live preview 走 surrogate canvas（per-pixel JS BCSH 之后塞进来）
  // (layerId, canvas) 启动；(null, null) 关
  setActiveLayerSurrogate(layerId, canvas) {
    this._activeSurrogateLayerId = layerId;
    this._activeSurrogateCanvas = canvas;
    this.invalidateAll();
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
  // 把笔刷 live overlay 按 选区 mask + 锁α layer alpha 裁，让画中实时看到限制范围。
  // 返回一个**新 overlay 描述**，canvas 指向裁过的临时 canvas；bbox 保持不变（局部坐标不变）。
  // 落笔后 Selection.applyMaskPostStroke / source-atop 做最终持久化裁；这里只是 preview。
  //   单 tmp 内多个 dst-in 顺序求交（先读原 overlay 一次，再叠 mask）——不会自绘清空。
  _clipOverlayMasks(overlay, selection, lockLayer) {
    const tmp = this._getOverlayClipTmp(overlay.bboxW, overlay.bboxH);
    const tctx = tmp.getContext("2d");
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
  // 给一颗 clipping mask 层做 dst-in 剪裁 + composite 到 ctx。
  // 算法：在 tmp 上先以 layer.bbox 局部坐标渲染 (layer + overlay) → dst-in base alpha
  //       → 把 tmp 当一张 (bboxW × bboxH) image drawImage 到 ctx 的 doc 坐标 bbox 位置。
  // 注意：tmp 复用，先 clearRect(0, 0, bboxW, bboxH) 防上一次脏数据残留。
  _renderLayerClipped(ctx, layer, baseLayer, overlay) {
    // 区域 = layer bbox ∪ overlay bbox。layer 空(第一笔)、或 overlay 超出 layer bbox(笔触进行中
    //   buffer 比 layer 大) 时，都要让区域覆盖 overlay，否则 overlay 被 tmp 尺寸裁掉。
    let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
    if (layer.bboxW > 0 && layer.bboxH > 0) {
      rx0 = layer.bboxX; ry0 = layer.bboxY; rx1 = layer.bboxX + layer.bboxW; ry1 = layer.bboxY + layer.bboxH;
    }
    if (overlay) {
      rx0 = Math.min(rx0, overlay.bboxX); ry0 = Math.min(ry0, overlay.bboxY);
      rx1 = Math.max(rx1, overlay.bboxX + overlay.bboxW); ry1 = Math.max(ry1, overlay.bboxY + overlay.bboxH);
    }
    const rw = rx1 - rx0, rh = ry1 - ry0;
    if (rw <= 0 || rh <= 0) return;
    const tmp = this._getClipTmp(rw, rh);
    const tctx = tmp.getContext("2d");
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, rw, rh);
    // 平移使区域左上 (rx0,ry0) 对齐到 tmp (0,0) → _drawLayerWithOverlay 用 doc 绝对坐标画
    tctx.setTransform(1, 0, 0, 1, -rx0, -ry0);
    this._drawLayerWithOverlay(tctx, layer, overlay);
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(baseLayer.canvas, baseLayer.bboxX - rx0, baseLayer.bboxY - ry0);
    tctx.globalCompositeOperation = "source-over";
    ctx.drawImage(tmp, 0, 0, rw, rh, rx0, ry0, rw, rh);
  }

  // 把 (layer, overlay) 在 ctx 上 composite。ctx 已经被调用方 setTransform
  // 到 **doc 坐标系**（doc (0,0) = ctx origin，doc (W,H) = (W,H) in ctx）。
  // 所以这里 drawImage 的 dest 直接用 layer.bboxX/Y/W/H（doc 坐标）。
  _drawLayerWithOverlay(ctx, layer, overlay) {
    // v113: 颜色调整 live preview 走 surrogate canvas（per-pixel BCSH 烤好的）
    const sourceCanvas = (this._activeSurrogateLayerId === layer.id && this._activeSurrogateCanvas)
      ? this._activeSurrogateCanvas : layer.canvas;
    // 空 layer(bbox=0) 没像素：drawImage 0 宽会抛 IndexSizeError → 跳过层像素，只画 overlay
    const hasLayerPixels = layer.bboxW > 0 && layer.bboxH > 0;
    // overlay 落到本层的合成算子：erase=destination-out；否则 per-brush blendMode（默认 source-over）。
    const overlayOp = !overlay ? "source-over"
      : overlay.mode === "erase" ? "destination-out"
      : (overlay.blendMode || "source-over");
    // 快通路：无 overlay，或普通叠加 → 直接落到 ctx
    if (overlayOp === "source-over") {
      if (hasLayerPixels) {
        ctx.drawImage(
          sourceCanvas, 0, 0, layer.bboxW, layer.bboxH,
          layer.bboxX, layer.bboxY, layer.bboxW, layer.bboxH,
        );
      }
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
    // 复合通路（erase / 混合模式）：overlay 必须只对**本层像素**做合成（不能直接落 ctx——
    //   ctx 已带 layer.mode + 下方所有层）。在临时画布上 (layer ⊕ overlay) 烤好，再整体按 ctx 当前
    //   (layer.mode / opacity) blit。结果 = commit 后的样子（_compositeBufferToLayer 同 op）。
    // erase 空 layer 没像素可擦 → 跳过；混合模式在空 layer 上 = 直接显示 stroke（仍要画）。
    if (!hasLayerPixels && overlay.mode === "erase") return;
    // 区域 = layer bbox ∪ overlay bbox（overlay 可能比 layer 大 / layer 空）
    let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
    if (hasLayerPixels) {
      rx0 = layer.bboxX; ry0 = layer.bboxY; rx1 = layer.bboxX + layer.bboxW; ry1 = layer.bboxY + layer.bboxH;
    }
    rx0 = Math.min(rx0, overlay.bboxX); ry0 = Math.min(ry0, overlay.bboxY);
    rx1 = Math.max(rx1, overlay.bboxX + overlay.bboxW); ry1 = Math.max(ry1, overlay.bboxY + overlay.bboxH);
    const rw = rx1 - rx0, rh = ry1 - ry0;
    if (rw <= 0 || rh <= 0) return;
    const ec = this._getEraseComposite(rw, rh);
    const ectx = ec.getContext("2d");
    ectx.setTransform(1, 0, 0, 1, 0, 0);
    ectx.clearRect(0, 0, rw, rh);
    ectx.globalCompositeOperation = "source-over";
    if (hasLayerPixels) ectx.drawImage(sourceCanvas, layer.bboxX - rx0, layer.bboxY - ry0);
    ectx.globalAlpha = overlay.opacity;
    ectx.globalCompositeOperation = overlayOp;
    ectx.drawImage(overlay.canvas, overlay.bboxX - rx0, overlay.bboxY - ry0);
    ectx.globalAlpha = 1;
    ectx.globalCompositeOperation = "source-over";
    ctx.drawImage(ec, 0, 0, rw, rh, rx0, ry0, rw, rh);
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

  setCursor(c) {
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
    if (this._dirtyFull || !this._dirtyDocRect) {
      this._renderFull();
    } else {
      this._renderPartial(this._dirtyDocRect);
    }
    this._dirtyDocRect = null;
    this._dirtyFull = false;
    this._syncGrid();   // 每帧一次：sig 守卫，视口没变（如 stroke 中）→ 立即 no-op
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

    // v100：放大查看（scale > 1）走 nearest-neighbor，看像素级细节
    // user：「画布当放缩 > 1 的时候改成 nearest neighbor」
    if (scale > 1) {
      ctx.imageSmoothingEnabled = false;
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = scale < 0.5 ? "low" : "high";
    }

    // doc 背景：默认 backgroundColor；开了棋盘则画半透明灰白格（Procreate 透明背景同款）
    if (this._showCheckerboard) {
      this._drawCheckerboard(ctx, this.doc.width, this.doc.height);
    } else {
      ctx.fillStyle = this.doc.backgroundColor || "#ffffff";
      ctx.fillRect(0, 0, this.doc.width, this.doc.height);
    }

    // 逐 layer（带 clipping mask 处理）
    this._renderLayers(ctx);

    // 套索 overlay（蚂蚁线 / drawing path / floating / handles，doc 坐标系）
    this._drawLassoOverlay(ctx, scale);

    // doc 边框（doc 坐标系下；lineWidth 在缩放 / 旋转下会变粗细，需要 inverse-scale lineWidth）
    // 栅格 = CSS div（_syncGrid），光标 = DOM div（_updateCursorEl），都不在这条 canvas hot path。
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, this.doc.width, this.doc.height);
  }

  // 只重画 docRect 覆盖的区域。**rot != 0 时直接走 full**（旋转 dirty rect
  // 在 screen 上是斜矩形，clip + 算屏幕 bbox 复杂度不值，stamp 路径少见旋转后画）
  _renderPartial(docRect) {
    // 套索浮层 / drawing path / **选区** 走全屏。
    // 选区也要：否则蚂蚁线在 partial 区域里被擦掉（_drawLassoOverlay 不在 partial 路径）
    if (this._lassoProvider) {
      const info = this._lassoProvider();
      if (info && (info.drawingPath?.length || info.floating || info.selection)) {
        this._renderFull(); return;
      }
    }
    if (this.viewport.rot !== 0) {
      this._renderFull();
      return;
    }
    // v124 (user：「windows stamps 出现小黑框」第二尝试)：
    // 第一招 (clip 边界 floor/ceil) 失败。**兜底**：有 live overlay (= stroke 进行中) 直接全屏。
    // 一帧多个 fillRect 在 hidpi 上微秒级，不会影响 60fps；换 partial render clip 边沿 sliver bug 不再可能。
    // v131 (user：「液化又出现白框」)：液化没用 overlayProvider（直接改 layer 像素），
    //   regression。补 strokeActiveHint：任何 stroke-in-progress 都强 full。
    if (this._overlayProvider?.() || this._strokeActiveHint?.()) {
      this._renderFull(); return;
    }
    const ctx = this.ctx;
    const { tx, ty, scale } = this.viewport;

    const pad = Math.max(1, 2 / scale);
    const dx0 = docRect[0] - pad;
    const dy0 = docRect[1] - pad;
    const dx1 = docRect[2] + pad;
    const dy1 = docRect[3] + pad;

    // v124 (user：「Windows 上画画 stamps 出现小黑框，commit 后消失」)
    // 根因：浮点 sx/sw 让 clip 与 fillRect 的边界落到亚像素 → Windows Skia GPU 在
    // DPR>1 时 clip rounds outward 但 fillRect rounds inward (或反过来) → 1 px sliver
    // 没被任何东西画过 → 主 canvas {alpha:false} 初始黑色露出 = 黑色边线
    // 修：整 pixel 取整 + 1 px 外扩，让 clip 与 fill 都严格覆盖到底
    const rawSx = dx0 * scale + tx;
    const rawSy = dy0 * scale + ty;
    const rawSx1 = dx1 * scale + tx;
    const rawSy1 = dy1 * scale + ty;
    const sx = Math.floor(rawSx) - 1;
    const sy = Math.floor(rawSy) - 1;
    const sw = Math.ceil(rawSx1) - sx + 1;
    const sh = Math.ceil(rawSy1) - sy + 1;

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
    // v100：scale > 1 走 nearest-neighbor 同 _renderFull
    if (scale > 1) {
      ctx.imageSmoothingEnabled = false;
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = scale < 0.5 ? "low" : "high";
    }
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
      let lOverlay = overlay && overlay.layer === layer ? overlay : null;
      // v154 修：空 layer(bbox=0) 也要画 live overlay。新 buffered beginStroke 不碰 layer →
      //   新建层 / 新作品的**第一笔**画时 layer 仍空；旧逻辑在这 continue 掉 → 第一笔画时不显示、
      //   抬笔 commit 才出。overlay 是 doc 坐标的，不依赖 layer bbox。空 layer 且无 overlay 才真没东西画。
      if ((layer.bboxW <= 0 || layer.bboxH <= 0) && !lOverlay) continue;
      const prevAlpha = ctx.globalAlpha;
      const prevComp = ctx.globalCompositeOperation;
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.mode || "source-over";
      // 笔刷 live overlay 也要 respect 选区 + 锁定不透明度：画里实时看到限制范围
      //   v242：锁α 时按 layer 现有 alpha 裁，预览与 pen-up 的 source-atop 一致（不再"先溢出后回缩"）
      if (lOverlay && (this.doc.selection || layer.lockAlpha)) {
        lOverlay = this._clipOverlayMasks(lOverlay, this.doc.selection, layer.lockAlpha ? layer : null);
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
      const isWarp = f.mode === "warp";
      ctx.save();
      // 1) 浮层像素
      //   - 2×2 mesh：per-pixel inverse homography（math-exact，~50ms / 帧 in drag）
      //     缓存到 f._renderCache；mesh 变了 lasso.js 那边 invalidate
      //   - 4×4 mesh (warp)：暂走 Catmull-Rom + 三角化。下个 PR 替成 forward splat
      if (f.meshN === 2) {
        if (!f._renderCache) {
          f._renderCache = renderQuadPerPixel(f.imageData, f.srcW, f.srcH, f.mesh, info.sampleMode);
        }
        if (f._renderCache) {
          ctx.drawImage(f._renderCache.canvas, f._renderCache.dstX, f._renderCache.dstY);
        }
      } else {
        drawMesh(ctx, f.canvas, f.srcW, f.srcH, f.mesh, { smooth: info.sampleMode !== "nearest" });
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
          } else if (h.kind === "rotate") {
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
    const g = this.gctx || (this.gctx = cv.getContext("2d"));
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

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
