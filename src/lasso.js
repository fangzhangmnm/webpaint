// 套索引擎 (v55 phase 1)：自由曲线选区 → lift floating → translate → commit。
//
// 数据流：
//   1) 用户用 lasso 工具拖一条自由路径 (points = [{x,y}])
//   2) endPath：
//       a. 在 docW×docH 上 rasterize 多边形 → mask (Uint8Array(docW*docH), 0/255)
//          - Even-odd 填充：scanline 每 y 找 polygon 与 line 的交点 x 集合，配对 fill
//          - 用 ctx 路径 + canvas fill + getImageData(alpha channel) 取 mask（GPU 加速 + bbox 切片）
//       b. 在 mask bbox 内：
//          - 从 active layer 取出被 mask 选中的像素 → floating canvas（同 bbox 大小）
//          - 同区域在 active layer 上 dst-out（挖空）
//          - 记 floating.bbox = doc 坐标（初始 = mask bbox），float.offset = (0, 0)
//   3) 用户拖 floating：offset += (dx, dy)
//   4) commit：drawImage(floating) 到 active layer 当前位置（含 offset），结束 floating 状态
//      - history 1 个 entry：before = layer pre-lift，after = layer post-commit
//   5) cancel：把 floating 像素 putBack 到原位置，恢复 active layer
//
// 性能：
//   - mask rasterize 走原生 canvas fill（O(brush footprint)，毫秒级）
//   - lift = 一次 drawImage + putImageData clear；commit 同理
//   - translate 不动 layer，只更新 offset；render 时 board 把 floating 画在偏移位置
//
// phase 2 待加：scale / rotate / skew gizmo（offset 升级到 affine）

export class LassoEngine {
  constructor() {
    this._state = "idle";    // idle | drawing | floating
    this._points = [];       // 选区 polygon 顶点（doc 坐标）
    this._floating = null;   // { canvas, bboxX, bboxY, bboxW, bboxH, offsetX, offsetY, layer, preSnap }
    this._dragStart = null;  // { x, y, baseOffsetX, baseOffsetY } 拖 floating 时
    this.onChange = () => {};
  }

  // 选区路径
  beginPath(x, y) {
    this._state = "drawing";
    this._points = [{ x, y }];
    this.onChange();
  }
  extendPath(x, y) {
    if (this._state !== "drawing") return;
    const p = this._points[this._points.length - 1];
    if (p && (Math.abs(p.x - x) < 1 && Math.abs(p.y - y) < 1)) return;   // 跳重复
    this._points.push({ x, y });
    this.onChange();
  }
  // 闭合 + lift。返回 true = 成功 lift，false = 选区无效（点太少 / 面积 0 / 全在 doc 外）
  endPath(layer) {
    if (this._state !== "drawing") return false;
    const pts = this._points;
    this._points = [];
    if (pts.length < 3) { this._state = "idle"; this.onChange(); return false; }

    // bbox（doc 坐标）
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    // clip 到 layer.bbox（layer 外的像素 lift 是没意义的）
    const lbX = layer.bboxX, lbY = layer.bboxY, lbW = layer.bboxW, lbH = layer.bboxH;
    const x0 = Math.max(lbX, Math.floor(minX));
    const y0 = Math.max(lbY, Math.floor(minY));
    const x1 = Math.min(lbX + lbW, Math.ceil(maxX));
    const y1 = Math.min(lbY + lbH, Math.ceil(maxY));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) { this._state = "idle"; this.onChange(); return false; }

    // pre-snapshot：commit / cancel 都靠这个还原 / 对比
    const preSnap = layer.snapshot();

    // mask: 在 w×h 上画多边形，取 alpha 当 mask
    const maskCanvas = (typeof OffscreenCanvas !== "undefined")
      ? new OffscreenCanvas(w, h)
      : (() => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; })();
    const mctx = maskCanvas.getContext("2d");
    mctx.clearRect(0, 0, w, h);
    mctx.fillStyle = "#fff";
    mctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i].x - x0;
      const py = pts[i].y - y0;
      if (i === 0) mctx.moveTo(px, py); else mctx.lineTo(px, py);
    }
    mctx.closePath();
    mctx.fill("evenodd");

    // floating canvas = layer 像素 ∩ mask（保留 alpha）
    const floating = (typeof OffscreenCanvas !== "undefined")
      ? new OffscreenCanvas(w, h)
      : (() => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; })();
    const fctx = floating.getContext("2d");
    // 先画 layer 在该区域的像素
    fctx.drawImage(layer.canvas, x0 - lbX, y0 - lbY, w, h, 0, 0, w, h);
    // 再用 mask 做 dst-in（保留 mask=非0 的像素，其余清掉）
    fctx.globalCompositeOperation = "destination-in";
    fctx.drawImage(maskCanvas, 0, 0);
    fctx.globalCompositeOperation = "source-over";

    // 同区域在 layer 上挖空：先 dst-out by mask
    const lctx = layer.ctx;
    lctx.save();
    lctx.globalCompositeOperation = "destination-out";
    lctx.drawImage(maskCanvas, x0 - lbX, y0 - lbY);
    lctx.restore();

    this._floating = {
      canvas: floating,
      bboxX: x0, bboxY: y0, bboxW: w, bboxH: h,
      offsetX: 0, offsetY: 0,
      layer,
      preSnap,
    };
    this._state = "floating";
    this.onChange();
    return true;
  }

  // 拖 floating
  hasFloating() { return this._state === "floating"; }
  hitFloating(x, y) {
    const f = this._floating;
    if (!f) return false;
    const cx = x - f.offsetX;
    const cy = y - f.offsetY;
    return cx >= f.bboxX && cx < f.bboxX + f.bboxW &&
           cy >= f.bboxY && cy < f.bboxY + f.bboxH;
  }
  beginDrag(x, y) {
    if (!this._floating) return;
    this._dragStart = {
      x, y,
      baseOffsetX: this._floating.offsetX,
      baseOffsetY: this._floating.offsetY,
    };
  }
  extendDrag(x, y) {
    if (!this._dragStart || !this._floating) return;
    this._floating.offsetX = this._dragStart.baseOffsetX + (x - this._dragStart.x);
    this._floating.offsetY = this._dragStart.baseOffsetY + (y - this._dragStart.y);
    this.onChange();
  }
  endDrag() { this._dragStart = null; }

  // 把 floating 烤回 layer 在 (offsetX, offsetY) 偏移后的位置。返回 history entry（caller push）。
  commit() {
    const f = this._floating;
    if (!f) return null;
    const layer = f.layer;
    const dstX = f.bboxX + f.offsetX;
    const dstY = f.bboxY + f.offsetY;
    // layer 可能要扩 bbox 以容纳新位置
    layer.ensureBbox(dstX, dstY, dstX + f.bboxW, dstY + f.bboxH);
    const lbX = layer.bboxX, lbY = layer.bboxY;
    layer.ctx.drawImage(f.canvas, dstX - lbX, dstY - lbY);
    const after = layer.snapshot();
    const entry = {
      type: "lasso",
      layerId: layer.id,
      before: f.preSnap,
      after,
      beforeBlob: null,
      afterBlob: null,
    };
    this._floating = null;
    this._state = "idle";
    this._dragStart = null;
    this.onChange();
    return entry;
  }

  // 取消 = 还原 pre-lift 状态
  cancel() {
    const f = this._floating;
    if (!f) return null;
    f.layer.restoreFromSnapshot(f.preSnap);
    this._floating = null;
    this._state = "idle";
    this._dragStart = null;
    this.onChange();
    return f.preSnap;     // caller 可以从 snap 知道 bbox 用来 markDirty
  }

  // board / overlay 用
  getDrawingPath() { return this._state === "drawing" ? this._points : null; }
  getFloating() { return this._floating; }
  state() { return this._state; }

  // floating dirty bbox（含 offset 后的 doc 坐标）
  getFloatingScreenBbox() {
    const f = this._floating;
    if (!f) return null;
    return [
      f.bboxX + f.offsetX,
      f.bboxY + f.offsetY,
      f.bboxX + f.offsetX + f.bboxW,
      f.bboxY + f.offsetY + f.bboxH,
    ];
  }
}
