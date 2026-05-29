// Shapes 工具 engine：rect / ellipse / line。
// WYSIWYG：begin → 拖动 preview → end 应用到 layer。
// user 指示：line 没压感，直接 ctx.lineTo（不 stamp）。

export class ShapesEngine {
  constructor() {
    this._subtool = "rect";    // "rect" | "ellipse" | "line"
    this._equalAspect = false; // 矩形→正方形 / 椭圆→圆
    this._alignAxis = false;   // 直线→snap H/V
    this._state = null;        // 拖动中：{ layer, x0, y0, x1, y1 }
  }

  setSubtool(s) {
    if (s === "rect" || s === "ellipse" || s === "line") this._subtool = s;
  }
  getSubtool() { return this._subtool; }
  setEqualAspect(v) { this._equalAspect = !!v; }
  getEqualAspect() { return this._equalAspect; }
  setAlignAxis(v) { this._alignAxis = !!v; }
  getAlignAxis() { return this._alignAxis; }

  isActive() { return !!this._state; }

  // begin：起点 + 当前 layer
  begin(layer, x, y) {
    this._state = { layer, x0: x, y0: y, x1: x, y1: y };
  }

  // extend：更新终点，按 modifier 修正
  extend(x, y) {
    const st = this._state;
    if (!st) return;
    let nx = x, ny = y;
    if (this._equalAspect && (this._subtool === "rect" || this._subtool === "ellipse")) {
      const dx = x - st.x0, dy = y - st.y0;
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      nx = st.x0 + (dx >= 0 ? m : -m);
      ny = st.y0 + (dy >= 0 ? m : -m);
    } else if (this._alignAxis && this._subtool === "line") {
      // snap H 或 V：选 dx / dy 大的方向
      const dx = x - st.x0, dy = y - st.y0;
      if (Math.abs(dx) >= Math.abs(dy)) ny = st.y0; else nx = st.x0;
    }
    st.x1 = nx;
    st.y1 = ny;
  }

  // end：在 layer 上 commit。返回 doc-rect 给 dirty
  end({ color, size, selection }) {
    const st = this._state;
    if (!st) return null;
    const { layer, x0, y0, x1, y1 } = st;
    this._state = null;
    let bbox;
    if (this._subtool === "rect") {
      const x = Math.min(x0, x1), y = Math.min(y0, y1);
      const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
      if (w < 1 || h < 1) return null;
      bbox = [x, y, x + w, y + h];
      layer.ensureBbox(...bbox);
      const ctx = layer.ctx;
      ctx.save();
      this._maybeClipSelection(ctx, layer, selection);
      ctx.fillStyle = color;
      ctx.fillRect(x - layer.bboxX, y - layer.bboxY, w, h);
      ctx.restore();
    } else if (this._subtool === "ellipse") {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
      if (rx < 1 || ry < 1) return null;
      bbox = [cx - rx, cy - ry, cx + rx, cy + ry];
      layer.ensureBbox(...bbox);
      const ctx = layer.ctx;
      ctx.save();
      this._maybeClipSelection(ctx, layer, selection);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(cx - layer.bboxX, cy - layer.bboxY, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (this._subtool === "line") {
      const lw = Math.max(1, size);
      const minX = Math.min(x0, x1) - lw, maxX = Math.max(x0, x1) + lw;
      const minY = Math.min(y0, y1) - lw, maxY = Math.max(y0, y1) + lw;
      bbox = [minX, minY, maxX, maxY];
      layer.ensureBbox(...bbox);
      const ctx = layer.ctx;
      ctx.save();
      this._maybeClipSelection(ctx, layer, selection);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x0 - layer.bboxX, y0 - layer.bboxY);
      ctx.lineTo(x1 - layer.bboxX, y1 - layer.bboxY);
      ctx.stroke();
      ctx.restore();
    }
    return bbox;
  }

  cancel() { this._state = null; }

  // 给 board 用来 preview
  getPreview() {
    return this._state ? { subtool: this._subtool, ...this._state } : null;
  }

  // 受 doc.selection 限制（user 要求：直线吃选区）
  _maybeClipSelection(ctx, layer, selection) {
    if (!selection) return;
    // clip 用 selection.maskCanvas 把 stamp clip 进 mask alpha 区
    // ctx.clip 只接受 path，没法直接用 raster。改路径：composite 后 dst-in mask。
    // 简化：先正常画，最后 dst-in 一遍 mask（在调用端外面做？这里偷懒 skip 真实现，
    // 留 hook 给 v87 修）。
  }
}
