// 套索引擎 (v55 phase 1 + v56 phase 2)：
//
// phase 1：自由曲线选区 → lift floating canvas → 平移 → commit。
// phase 2：4 种变形模式 + gizmo
//   - free      (4 角，平行四边形约束 = 仿射 TRS，S 可非均匀)
//   - uniform   (同 free 但锁长宽比)
//   - distort   (4 角自由，一般四边形 / 透视)
//   - warp      (3×3 控制点网格，每点独立)
//
// 数据模型：
//   floating = {
//     canvas,              // 源像素（不变；lift 时一次性烤好）
//     srcW, srcH,          // canvas 的像素尺寸
//     layer, preSnap,      // undo / cancel 用
//     mode,                // "free" | "uniform" | "distort" | "warp"
//     meshN,               // 2 (前 3 模式) / 3 (warp)
//     mesh,                // [meshN][meshN] doc 坐标点；初始 = src bbox 对齐
//     uniformAspect,       // uniform 模式锁定的 W/H 比（lift 时记一次）
//   }
//
// 渲染：每个 cell (i,j)→(i+1,j+1) 切两个三角，逐三角 affine drawImage 把
// 源像素映射到 doc。原生 Canvas2D 三角形纹理映射技巧（path + clip + transform）。
// 8 个三角 / 帧（warp 3×3）在 iPad mini A15 上 5ms 内。
//
// 模式切换：保留当前 mesh 形状，只换约束。
//   free → uniform：不动 mesh，后续 drag 才有锁比约束
//   free → distort：扩 mesh 到 2×2 通用四边形（free 已经是）
//   anything → warp：把当前 mesh 升采样到 3×3（双线性内插）

export class LassoEngine {
  constructor() {
    this._state = "idle";         // idle | drawing-freehand | drawing-rect | floating
    this._subTool = "freehand";   // freehand | rect | magic
    this._setOpMode = "new";      // new | union | subtract | intersect
    this._magicThreshold = 20;    // 0..100；魔术棒颜色相似度
    this._points = [];            // freehand draft
    this._rect = null;            // {x0, y0, x1, y1} during rect draw
    this._magicStart = null;      // for magic-tap path
    this._floating = null;
    this._drag = null;
    this.doc = null;              // 由 input.js 注入；选区是 doc 的一等公民
    this.onChange = () => {};
  }
  setDoc(doc) { this.doc = doc; }
  setSubTool(name) {
    if (this._subTool === name) return;
    this._subTool = name;
    this._points = []; this._rect = null; this._magicStart = null;
    this._state = "idle";
    this.onChange();
  }
  getSubTool() { return this._subTool; }
  setSetOpMode(mode) { this._setOpMode = mode; this.onChange(); }
  getSetOpMode() { return this._setOpMode; }
  setMagicThreshold(v) { this._magicThreshold = Math.max(0, Math.min(100, v)); }
  getMagicThreshold() { return this._magicThreshold; }

  // -------- 选区路径（按 subTool 路由）--------
  beginPath(x, y) {
    if (this._floating) return;        // transform 期间不能再画
    if (this._subTool === "freehand") {
      this._state = "drawing-freehand";
      this._points = [{ x, y }];
    } else if (this._subTool === "rect") {
      this._state = "drawing-rect";
      this._rect = { x0: x, y0: y, x1: x, y1: y };
    } else if (this._subTool === "magic") {
      // 单击：不进 drawing 状态；input.js 的 _endLasso 看 magicStart 做 flood fill
      this._state = "magic-tentative";
      this._magicStart = { x, y };
    }
    this.onChange();
  }
  extendPath(x, y) {
    if (this._state === "drawing-freehand") {
      const p = this._points[this._points.length - 1];
      if (p && Math.abs(p.x - x) < 1 && Math.abs(p.y - y) < 1) return;
      this._points.push({ x, y });
      this.onChange();
    } else if (this._state === "drawing-rect") {
      this._rect.x1 = x;
      this._rect.y1 = y;
      this.onChange();
    }
  }
  // 收笔：rasterize → combine with doc.selection per setOpMode → 更新 doc.selection
  // 返回 history entry（caller push）或 null（选区无效 / 没动）
  endPath(activeLayer) {
    let newSel = null;
    if (this._state === "drawing-freehand") {
      newSel = this._rasterizeFreehandToSelection(this._points);
      this._points = [];
    } else if (this._state === "drawing-rect") {
      newSel = this._rasterizeRectToSelection(this._rect);
      this._rect = null;
    } else if (this._state === "magic-tentative") {
      newSel = this._magicWandToSelection(this._magicStart, activeLayer);
      this._magicStart = null;
    }
    this._state = "idle";
    if (!newSel) { this.onChange(); return null; }
    return this._applySelectionUpdate(newSel);
  }
  // 编程入口（取消选区 / 反选 / 由 history undo 调用恢复）
  setSelection(sel) {
    if (!this.doc) return null;
    const oldSel = this.doc.selection;
    if (oldSel === sel) return null;
    this.doc.selection = sel;
    this.onChange();
    return { type: "selectionChange", before: oldSel, after: sel };
  }
  hasSelection() { return !!this.doc?.selection; }
  getSelection() { return this.doc?.selection || null; }
  cancelDrawing() {
    this._state = "idle";
    this._points = []; this._rect = null; this._magicStart = null;
    this.onChange();
  }

  // 用 doc.selection 作 mask source，把对应 layer 像素 lift 到 floating。
  // 完成后进 floating 状态（transform 子状态）。
  // 默认进入 free 模式（不再走 v56 那种"selected sub-state"）
  liftSelectionForTransform(layer) {
    if (this._floating) return false;
    const sel = this.doc?.selection;
    if (!sel) return false;
    const lbX = layer.bboxX, lbY = layer.bboxY, lbW = layer.bboxW, lbH = layer.bboxH;
    // 选区可能跨 layer.bbox 外；clip 到交集
    const x0 = Math.max(lbX, sel.bboxX);
    const y0 = Math.max(lbY, sel.bboxY);
    const x1 = Math.min(lbX + lbW, sel.bboxX + sel.bboxW);
    const y1 = Math.min(lbY + lbH, sel.bboxY + sel.bboxH);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return false;

    const preSnap = layer.snapshot();

    // floating canvas = layer ∩ selection mask（在交集 bbox 内）
    const floating = makeBitmap(w, h);
    const fctx = floating.getContext("2d");
    fctx.drawImage(layer.canvas, x0 - lbX, y0 - lbY, w, h, 0, 0, w, h);
    fctx.globalCompositeOperation = "destination-in";
    fctx.drawImage(sel.maskCanvas, sel.bboxX - x0, sel.bboxY - y0);
    fctx.globalCompositeOperation = "source-over";
    const floatingImageData = fctx.getImageData(0, 0, w, h);

    // 挖空 layer
    const lctx = layer.ctx;
    lctx.save();
    lctx.globalCompositeOperation = "destination-out";
    lctx.drawImage(sel.maskCanvas, sel.bboxX - lbX, sel.bboxY - lbY);
    lctx.restore();

    this._floating = {
      canvas: floating,
      imageData: floatingImageData,
      srcW: w, srcH: h,
      layer, preSnap,
      mode: "free",                  // 默认就是 free 模式（不再有 selected sub-state）
      meshN: 2,
      mesh: [
        [{ x: x0,     y: y0     }, { x: x0 + w, y: y0     }],
        [{ x: x0,     y: y0 + h }, { x: x0 + w, y: y0 + h }],
      ],
      uniformAspect: w / Math.max(1, h),
      _renderCache: null,
    };
    this._state = "floating";
    this.onChange();
    return true;
  }

  // ---- rasterize helpers（返回 selection-shaped object 或 null）----
  _rasterizeFreehandToSelection(pts) {
    if (pts.length < 3) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const x0 = Math.floor(minX), y0 = Math.floor(minY);
    const x1 = Math.ceil(maxX),  y1 = Math.ceil(maxY);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    const maskCanvas = makeBitmap(w, h);
    const mctx = maskCanvas.getContext("2d");
    mctx.fillStyle = "#fff";
    mctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i].x - x0;
      const py = pts[i].y - y0;
      if (i === 0) mctx.moveTo(px, py); else mctx.lineTo(px, py);
    }
    mctx.closePath();
    mctx.fill("evenodd");
    return { bboxX: x0, bboxY: y0, bboxW: w, bboxH: h, maskCanvas };
  }
  _rasterizeRectToSelection(r) {
    if (!r) return null;
    const x0 = Math.floor(Math.min(r.x0, r.x1));
    const y0 = Math.floor(Math.min(r.y0, r.y1));
    const x1 = Math.ceil(Math.max(r.x0, r.x1));
    const y1 = Math.ceil(Math.max(r.y0, r.y1));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    const maskCanvas = makeBitmap(w, h);
    const mctx = maskCanvas.getContext("2d");
    mctx.fillStyle = "#fff";
    mctx.fillRect(0, 0, w, h);
    return { bboxX: x0, bboxY: y0, bboxW: w, bboxH: h, maskCanvas };
  }
  // 魔术棒：从点击像素开始 flood fill，颜色差 ≤ threshold 的相邻像素都被选中
  _magicWandToSelection(start, layer) {
    if (!start || !layer || !(layer.bboxW > 0 && layer.bboxH > 0)) return null;
    const lbX = layer.bboxX, lbY = layer.bboxY;
    const lbW = layer.bboxW, lbH = layer.bboxH;
    const sx = Math.floor(start.x) - lbX;
    const sy = Math.floor(start.y) - lbY;
    if (sx < 0 || sx >= lbW || sy < 0 || sy >= lbH) return null;
    // 读 layer 像素
    const img = layer.ctx.getImageData(0, 0, lbW, lbH);
    const data = img.data;
    const startIdx = (sy * lbW + sx) * 4;
    const sr = data[startIdx], sg = data[startIdx + 1], sb = data[startIdx + 2], sa = data[startIdx + 3];
    // threshold: 0..100 → max squared RGB+A distance（每通道 max 255）
    // 用 max-norm（max diff per channel）更符合直觉
    const tCh = this._magicThreshold * 2.55;       // 0 = exact，100 ≈ any
    const visited = new Uint8Array(lbW * lbH);     // 0 = not visited
    const mask = new Uint8Array(lbW * lbH);
    const stack = [sx + sy * lbW];
    visited[sx + sy * lbW] = 1;
    while (stack.length) {
      const p = stack.pop();
      const i4 = p * 4;
      const dr = Math.abs(data[i4] - sr);
      const dg = Math.abs(data[i4 + 1] - sg);
      const db = Math.abs(data[i4 + 2] - sb);
      const da = Math.abs(data[i4 + 3] - sa);
      if (Math.max(dr, dg, db, da) > tCh) continue;
      mask[p] = 255;
      const px = p % lbW;
      const py = (p - px) / lbW;
      // 4-connected
      if (px > 0       && !visited[p - 1])   { visited[p - 1] = 1; stack.push(p - 1); }
      if (px < lbW - 1 && !visited[p + 1])   { visited[p + 1] = 1; stack.push(p + 1); }
      if (py > 0       && !visited[p - lbW]) { visited[p - lbW] = 1; stack.push(p - lbW); }
      if (py < lbH - 1 && !visited[p + lbW]) { visited[p + lbW] = 1; stack.push(p + lbW); }
    }
    // trim bbox 紧到 mask 实际区域
    let mnx = lbW, mny = lbH, mxx = -1, mxy = -1;
    for (let y = 0; y < lbH; y++) for (let x = 0; x < lbW; x++) {
      if (mask[y * lbW + x]) {
        if (x < mnx) mnx = x; if (y < mny) mny = y;
        if (x > mxx) mxx = x; if (y > mxy) mxy = y;
      }
    }
    if (mxx < 0) return null;
    const tw = mxx - mnx + 1, th = mxy - mny + 1;
    const maskCanvas = makeBitmap(tw, th);
    const mctx = maskCanvas.getContext("2d");
    const out = mctx.createImageData(tw, th);
    const odata = out.data;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const src = mask[(mny + y) * lbW + (mnx + x)];
      const o = (y * tw + x) * 4;
      odata[o] = 255; odata[o + 1] = 255; odata[o + 2] = 255; odata[o + 3] = src;
    }
    mctx.putImageData(out, 0, 0);
    return { bboxX: lbX + mnx, bboxY: lbY + mny, bboxW: tw, bboxH: th, maskCanvas };
  }
  // 把新 mask 按 setOpMode 合并进 doc.selection，返回 history entry
  _applySelectionUpdate(newSel) {
    if (!this.doc) return null;
    const oldSel = this.doc.selection;
    const merged = combineSelections(oldSel, newSel, this._setOpMode);
    if (oldSel === merged) { this.onChange(); return null; }
    this.doc.selection = merged;
    this.onChange();
    return { type: "selectionChange", before: oldSel, after: merged };
  }

  // -------- 模式切换 --------
  // mode 可以是 null（selected：只显轮廓 + 拖内 = 平移）
  //         或 "free" | "uniform" | "distort" | "warp"
  setMode(mode) {
    const f = this._floating;
    if (!f) return;
    if (mode === f.mode) return;
    // 2x2 ↔ 4x4 mesh 升 / 降采样
    if (mode === "warp" && f.meshN === 2) {
      f.mesh = upsampleMesh2to4(f.mesh);
      f.meshN = 4;
      f._renderCache = null;
    } else if (mode !== "warp" && f.meshN === 4) {
      f.mesh = downsampleMesh4to2(f.mesh);
      f.meshN = 2;
      f._renderCache = null;
    }
    f.mode = mode;
    this.onChange();
  }
  getMode() { return this._floating?.mode || null; }

  // -------- 拖动 --------
  // 鼠标 / 手指 down 时调：判断点击在哪里 → 设 _drag。返回 hit 类型。
  hitTest(x, y, screenScale = 1) {
    const f = this._floating;
    if (!f) return null;
    // selected 状态（mode=null）：不暴露 handles，仅内部 = 平移
    if (f.mode === null) {
      return this._pointInQuad(x, y) ? { kind: "translate" } : null;
    }
    // 优先 mesh 控制点（按 mode 决定哪些点暴露）。半径 = 10 / screenScale doc-px
    const r = 10 / screenScale;
    const handles = this._visibleHandles();
    for (const h of handles) {
      const dx = x - h.pos.x, dy = y - h.pos.y;
      if (dx * dx + dy * dy < r * r) return h;
    }
    // warp 模式：内部任意点 = 软拖（分布到最近 cell 4 角）
    if (f.mode === "warp") {
      const cell = this._findWarpCell(x, y);
      if (cell) return { kind: "warp-soft", ...cell };
    }
    // 内部 = translate
    if (this._pointInQuad(x, y)) {
      return { kind: "translate" };
    }
    return null;
  }

  beginDrag(hit, x, y) {
    const f = this._floating;
    if (!f || !hit) return;
    this._drag = {
      ...hit,
      startX: x, startY: y,
      meshSnap: f.mesh.map((row) => row.map((p) => ({ x: p.x, y: p.y }))),
    };
  }
  extendDrag(x, y) {
    const f = this._floating;
    const d = this._drag;
    if (!f || !d) return;
    const dx = x - d.startX;
    const dy = y - d.startY;
    if (d.kind === "translate") {
      this._applyTranslate(d.meshSnap, dx, dy);
    } else if (d.kind === "corner") {
      this._applyCornerDrag(d.row, d.col, d.meshSnap, x, y);
    } else if (d.kind === "edge") {
      this._applyEdgeDrag(d.edge, d.meshSnap, x, y);
    } else if (d.kind === "warp-point") {
      this._applyWarpPoint(d.row, d.col, d.meshSnap, dx, dy);
    } else if (d.kind === "warp-soft") {
      this._applyWarpSoft(d, dx, dy);
    }
    if (f) f._renderCache = null;            // mesh 变了，作废 cached render
    this.onChange();
  }
  endDrag() { this._drag = null; }

  // -------- commit / cancel --------
  commit() {
    const f = this._floating;
    if (!f) return null;
    const layer = f.layer;
    // 把 mesh 包出的 bbox 推给 layer.ensureBbox
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const row of f.mesh) for (const p of row) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    layer.ensureBbox(Math.floor(minX), Math.floor(minY), Math.ceil(maxX), Math.ceil(maxY));
    const lbX = layer.bboxX, lbY = layer.bboxY;
    // 2×2 mesh：per-pixel inverse homography（math-exact，无 PS1 artifact）
    // 4×4 mesh：暂时还是 Catmull-Rom 升采样 + 三角化。下个 PR 改 Newton inverse
    if (f.meshN === 2) {
      const rendered = renderQuadPerPixel(f.imageData, f.srcW, f.srcH, f.mesh);
      if (rendered) {
        layer.ctx.drawImage(rendered.canvas, rendered.dstX - lbX, rendered.dstY - lbY);
      }
    } else {
      layer.ctx.save();
      layer.ctx.translate(-lbX, -lbY);
      drawMesh(layer.ctx, f.canvas, f.srcW, f.srcH, f.mesh, { smooth: true });
      layer.ctx.restore();
    }

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
    this._drag = null;
    this.onChange();
    return entry;
  }
  cancel() {
    const f = this._floating;
    if (!f) return null;
    f.layer.restoreFromSnapshot(f.preSnap);
    this._floating = null;
    this._state = "idle";
    this._drag = null;
    this.onChange();
    return f.preSnap;
  }

  // -------- 外部查询 --------
  hasFloating() { return this._state === "floating"; }
  getDrawingPath() { return this._state === "drawing-freehand" ? this._points : null; }
  getDrawingRect() { return this._state === "drawing-rect" ? this._rect : null; }
  getFloating() { return this._floating; }
  state() { return this._state; }

  // bbox in doc coords（含 mesh 变形后的最大矩形，给 board markDirty 用）
  getFloatingScreenBbox() {
    const f = this._floating;
    if (!f) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const row of f.mesh) for (const p of row) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return [minX, minY, maxX, maxY];
  }

  // 给 board overlay 用：返回当前可拖的 handle 列表（位置 + 类型）
  visibleHandles() { return this._visibleHandles(); }
  // 给 board overlay：渲染 floating 用
  // 调 drawMesh(ctx, canvas, srcW, srcH, mesh) 接到 board 里更方便，所以也 export drawMesh

  // ---------- 内部 ----------

  _visibleHandles() {
    const f = this._floating;
    if (!f) return [];
    // selected 状态：不暴露
    if (f.mode === null) return [];
    const out = [];
    if (f.meshN === 2) {
      const m = f.mesh;
      out.push({ kind: "corner", row: 0, col: 0, pos: m[0][0] });
      out.push({ kind: "corner", row: 0, col: 1, pos: m[0][1] });
      out.push({ kind: "corner", row: 1, col: 0, pos: m[1][0] });
      out.push({ kind: "corner", row: 1, col: 1, pos: m[1][1] });
      // 4 边中点：所有 2×2 mode 都暴露
      //   free / uniform：1D 缩放（对边锚定）
      //   distort：拖边 = 平移该边两端点（保 4 角自由，但给"整边一起拖"的快捷出口）
      out.push({ kind: "edge", edge: "top",    pos: mid(m[0][0], m[0][1]) });
      out.push({ kind: "edge", edge: "right",  pos: mid(m[0][1], m[1][1]) });
      out.push({ kind: "edge", edge: "bottom", pos: mid(m[1][0], m[1][1]) });
      out.push({ kind: "edge", edge: "left",   pos: mid(m[0][0], m[1][0]) });
    } else {
      // 4×4 = 16 个 warp 点
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        out.push({ kind: "warp-point", row: i, col: j, pos: f.mesh[i][j] });
      }
    }
    return out;
  }

  _pointInQuad(x, y) {
    const f = this._floating;
    if (!f) return false;
    const N = f.meshN;
    const m = f.mesh;
    // 用 4 个外角的包络（warp 也用这个，足够检测"在不在选区内"）
    const poly = [m[0][0], m[0][N - 1], m[N - 1][N - 1], m[N - 1][0]];
    return pointInPoly(poly, x, y);
  }

  _applyTranslate(meshSnap, dx, dy) {
    const f = this._floating;
    for (let i = 0; i < f.meshN; i++) for (let j = 0; j < f.meshN; j++) {
      f.mesh[i][j].x = meshSnap[i][j].x + dx;
      f.mesh[i][j].y = meshSnap[i][j].y + dy;
    }
  }

  // 角点拖动：
  //   free / uniform: 平行四边形约束（对角锚定，调整 ax / ay）
  //   distort: 自由四边形（只动这一角）
  _applyCornerDrag(row, col, meshSnap, x, y) {
    const f = this._floating;
    // 保 finger-handle 偏移：corner 的新位置 = 原位置 + (drag delta)，而不是直接 = finger 位置
    const d = this._drag;
    const targetX = meshSnap[row][col].x + (x - d.startX);
    const targetY = meshSnap[row][col].y + (y - d.startY);
    if (f.mode === "distort") {
      f.mesh[row][col].x = targetX;
      f.mesh[row][col].y = targetY;
      return;
    }
    // 平行四边形约束：以对角为锚。算 origin/ax/ay 满足新角位置。
    // 4 角约定：TL=[0][0], TR=[0][1], BL=[1][0], BR=[1][1]
    // 对角线表：TL↔BR, TR↔BL
    const opp = { "0,0": [1,1], "0,1": [1,0], "1,0": [0,1], "1,1": [0,0] };
    const [or, oc] = opp[`${row},${col}`];
    const anchor = meshSnap[or][oc];   // 对角锚点（变换中不动）
    // 同行 / 同列邻居：决定 ax / ay 方向
    // 例：drag TR ([0][1])，邻居 TL([0][0]) 和 BR([1][1])。BR 不动（对角），TL 锚定。
    // 但若 anchor=BR，TL 不锚 → TL 跟着调？还是 TL 保持不变？
    // 用户语义：拖一个角 = 该角动，对角不动，其他两角 derived 出来。
    // 平行四边形要求 TR - TL = BR - BL（横向边相等）。所以拖 TR 时：
    //   TL_new = ? 我们选 TL 不动（用户拖 TR 通常不想动 TL）→ ax 改了
    //   BL_new = ? BR 不动；BL = BR - ax_new；所以 BL 跟着调
    // 这个方案：drag 一个角 = 该角动 + 同行/同列另一角不动 + 第四角 derived
    // 但这意味着对角 (BR) 也不变，等于"对角锚定"恰好成立。
    // 然后 TL 不变 → ax 改、BL 跟着调？等等：TL 不动 + BR 不动 + ax = TR_new - TL → BL = BR - ax = BR - (TR_new - TL)
    // OK 我们用："对角不变 + 同行邻居不变" 推出第四角。
    // 同行邻居（i.e., same row）：
    const sameRowCol = col === 0 ? 1 : 0;
    const sameColRow = row === 0 ? 1 : 0;
    // 用同行邻居 = [row][sameRowCol]，同列邻居 = [sameColRow][col]，对角 = [sameColRow][sameRowCol]
    // 简单方案：对角锚定 + 同行邻居锚定，第四角 derive
    // 这里 "拖 TR"：TR 移动，TL 锚定（同行）BR 锚定（对角），BL = TL + (BR - TR_new)
    // 但 BL 是同列邻居。所以它会动 —— 用户预期"拖 TR 时 BL 不动"也许更自然？
    // 经过权衡，按 Procreate 习惯：对角锚定 + 单变量驱动（ax 或 ay）。
    // 让我们规则定为：拖一个角 = 该角动 + 对角不动 + ax 和 ay 各自缩放（保持原方向）
    // 这能正确处理 uniform 锁定（按比例缩放）
    const origAx = sub(meshSnap[0][1], meshSnap[0][0]);
    const origAy = sub(meshSnap[1][0], meshSnap[0][0]);
    // 当前 corner 对应的 origin（TL）= [0][0]
    // dragCorner 在 (TL + sx*ax + sy*ay) 上，其中 sx, sy ∈ {0, 1}
    const sx = col, sy = row;   // [0][0]=(0,0), [0][1]=(1,0), [1][0]=(0,1), [1][1]=(1,1)
    // 我们要 newAx, newAy（方向同原始），新 origin 使得：
    //   newOrigin + (1-sx_anchor)*newAx + (1-sy_anchor)*newAy = anchor
    //   newOrigin + sx*newAx + sy*newAy = (x, y)
    // 4 个未知（origin.x, origin.y, |ax|, |ay|），2 个向量方程 = 4 标量方程 → 可解
    // 简化思路：把 anchor 当 fixed pivot，drag 端为 (x,y)。anchor 在 [or][oc] = (1-sx, 1-sy) 的角。
    // 算从 anchor 到 drag 的向量 = newAx * (sx - (1-sx)) + newAy * (sy - (1-sy)) = newAx*(2sx-1) + newAy*(2sy-1)
    // 即 newAx * αx + newAy * αy = (x,y) - anchor，其中 αx = 2sx-1, αy = 2sy-1 ∈ {-1, +1}
    // 因为 αx, αy ∈ {±1}，可以代入：newAx = αx * (x_along_axU)、newAy = αy * (y_along_ayU)
    // 即把 (drag - anchor) 分解到 (axU, ayU) 基底下，分量就是 newAx 和 newAy（带符号）
    const drag = { x: targetX, y: targetY };
    const dragVec = sub(drag, anchor);
    const axU = norm(origAx);   // 单位向量
    const ayU = norm(origAy);
    // 解 newAx (沿 axU) 和 newAy (沿 ayU)：dragVec = sαx * axU * lenAx + sαy * ayU * lenAy
    // 其中 αx, αy ∈ {±1}（绝对值是长度）。求 lenAx, lenAy。
    // dragVec · axU = αx * lenAx + αy * lenAy * (ayU · axU)
    // 用 2×2 矩阵 [αx*axU, αy*ayU] 解
    const αx = 2 * sx - 1;
    const αy = 2 * sy - 1;
    const M11 = αx * axU.x, M12 = αy * ayU.x;
    const M21 = αx * axU.y, M22 = αy * ayU.y;
    const det = M11 * M22 - M12 * M21;
    if (Math.abs(det) < 1e-6) return;   // 退化（ax / ay 平行）；放弃这帧
    let lenAx = (dragVec.x * M22 - dragVec.y * M12) / det;
    let lenAy = (-dragVec.x * M21 + dragVec.y * M11) / det;
    // uniform 模式：把 finger 沿"原对角方向"投影，等比例缩放两轴。
    // 角"滑"在原对角线上 → 锁长宽比；垂直于对角的拖动不改 scale（更稳）
    if (f.mode === "uniform") {
      const origCorner = meshSnap[row][col];
      const Dvec = sub(origCorner, anchor);       // 原对角向量
      const Dlen2 = Dvec.x * Dvec.x + Dvec.y * Dvec.y;
      if (Dlen2 > 1e-6) {
        const fingerFromAnchor = sub({ x: targetX, y: targetY }, anchor);
        const scale = (fingerFromAnchor.x * Dvec.x + fingerFromAnchor.y * Dvec.y) / Dlen2;
        const origLenAx = Math.hypot(origAx.x, origAx.y);
        const origLenAy = Math.hypot(origAy.x, origAy.y);
        // 用原 αx / αy 决定方向（lenAx 在 free 解算中带的符号）
        lenAx = αx * scale * origLenAx;
        lenAy = αy * scale * origLenAy;
      }
    }
    const newAx = { x: axU.x * lenAx, y: axU.y * lenAx };
    const newAy = { x: ayU.x * lenAy, y: ayU.y * lenAy };
    // 重建 4 角：origin = target - sx*newAx - sy*newAy
    const origin = { x: targetX - sx * newAx.x - sy * newAy.x, y: targetY - sx * newAx.y - sy * newAy.y };
    f.mesh[0][0] = origin;
    f.mesh[0][1] = { x: origin.x + newAx.x, y: origin.y + newAx.y };
    f.mesh[1][0] = { x: origin.x + newAy.x, y: origin.y + newAy.y };
    f.mesh[1][1] = { x: origin.x + newAx.x + newAy.x, y: origin.y + newAx.y + newAy.y };
  }

  // 边中点拖动（free/uniform）：沿对应轴 1D 缩放，对边锚定
  _applyEdgeDrag(edge, meshSnap, x, y) {
    const f = this._floating;
    const m = meshSnap;
    // distort 模式：拖边 = 平移该边两个端点（其他两角不动）
    if (f.mode === "distort") {
      const d = this._drag;
      const dx = x - d.startX, dy = y - d.startY;
      // 边对应的两个角索引
      const idx = {
        top:    [[0,0],[0,1]],
        bottom: [[1,0],[1,1]],
        left:   [[0,0],[1,0]],
        right:  [[0,1],[1,1]],
      }[edge];
      for (const [r, c] of idx) {
        f.mesh[r][c] = { x: m[r][c].x + dx, y: m[r][c].y + dy };
      }
      return;
    }
    const origAx = sub(m[0][1], m[0][0]);
    const origAy = sub(m[1][0], m[0][0]);
    const axU = norm(origAx);
    const ayU = norm(origAy);
    // 当前边的两个端点 + 对边的两个端点
    let dragMid, oppMidStart, oppMidEnd;
    let axis;       // 哪个轴在变（"ax" 或 "ay"）
    if (edge === "top") {
      dragMid = mid(m[0][0], m[0][1]); oppMidStart = m[1][0]; oppMidEnd = m[1][1]; axis = "ay-shrink"; // 减小 ay
    } else if (edge === "bottom") {
      dragMid = mid(m[1][0], m[1][1]); oppMidStart = m[0][0]; oppMidEnd = m[0][1]; axis = "ay-grow";
    } else if (edge === "left") {
      dragMid = mid(m[0][0], m[1][0]); oppMidStart = m[0][1]; oppMidEnd = m[1][1]; axis = "ax-shrink";
    } else {
      dragMid = mid(m[0][1], m[1][1]); oppMidStart = m[0][0]; oppMidEnd = m[1][0]; axis = "ax-grow";
    }
    // drag delta = (drag end - drag start)，不是 (drag end - edge midpoint)
    // 这样 finger 起手不在边中点正中也能正确响应
    const d = this._drag;
    const dragDelta = { x: x - d.startX, y: y - d.startY };
    let lenAx = Math.hypot(origAx.x, origAx.y);
    let lenAy = Math.hypot(origAy.x, origAy.y);
    if (axis.startsWith("ax")) {
      const proj = dragDelta.x * axU.x + dragDelta.y * axU.y;
      lenAx = axis === "ax-grow" ? lenAx + proj : lenAx - proj;
    } else {
      const proj = dragDelta.x * ayU.x + dragDelta.y * ayU.y;
      lenAy = axis === "ay-grow" ? lenAy + proj : lenAy - proj;
    }
    if (f.mode === "uniform") {
      // 等比例缩放：以变了的轴为主轴推导另一轴
      if (axis.startsWith("ax")) lenAy = lenAx / f.uniformAspect;
      else lenAx = lenAy * f.uniformAspect;
    }
    // 重建。对边锚定 → origin 也可能变（拖 top 时对边是 bottom，所以 BL 锚定 = origin + ay = old BL）
    // 但 origin = old TL = m[0][0]，如果 ay 缩短，TL 必须沿 ay 方向移动以保持 BL 不动
    // BL_anchor = m[1][0] = m[0][0] + lenAy_old * ayU
    // 新 origin: BL_anchor - lenAy_new * ayU
    const blAnchor = m[1][0];
    const newAy = { x: ayU.x * lenAy, y: ayU.y * lenAy };
    const newAx = { x: axU.x * lenAx, y: axU.y * lenAx };
    let origin;
    if (axis.startsWith("ay")) {
      // 上 / 下边拖 → ay 在变。底边锚 = blAnchor（bottom）当 axis="ay-grow"；顶边锚 = m[0][0] 当 "ay-shrink"
      if (axis === "ay-grow") {
        // bottom edge anchored → origin = blAnchor - newAy
        origin = { x: blAnchor.x - newAy.x, y: blAnchor.y - newAy.y };
      } else {
        // top edge anchored → origin = m[0][0]（不变）
        origin = { x: m[0][0].x, y: m[0][0].y };
      }
    } else {
      // 左 / 右边拖 → ax 在变。左边锚 = m[0][0] 当 "ax-grow"；右边锚 = m[0][1] 当 "ax-shrink"
      if (axis === "ax-grow") {
        origin = { x: m[0][0].x, y: m[0][0].y };
      } else {
        // origin = trAnchor - newAx
        origin = { x: m[0][1].x - newAx.x, y: m[0][1].y - newAx.y };
      }
    }
    f.mesh[0][0] = origin;
    f.mesh[0][1] = { x: origin.x + newAx.x, y: origin.y + newAx.y };
    f.mesh[1][0] = { x: origin.x + newAy.x, y: origin.y + newAy.y };
    f.mesh[1][1] = { x: origin.x + newAx.x + newAy.x, y: origin.y + newAx.y + newAy.y };
  }

  // Warp 单点拖：那一个点 += delta
  _applyWarpPoint(row, col, meshSnap, dx, dy) {
    const f = this._floating;
    f.mesh[row][col] = {
      x: meshSnap[row][col].x + dx,
      y: meshSnap[row][col].y + dy,
    };
  }

  // Warp 软拖：拖任意点 → 邻近 cell 的 4 角按 bilinear 权重分配 delta
  // (cell.row, cell.col) = 4×4 mesh 中 cell 的 TL 索引（0..2）
  // (u, v) ∈ [0,1] = cell 内部的 bilinear 坐标
  _applyWarpSoft(d, dx, dy) {
    const f = this._floating;
    const r = d.row, c = d.col;
    const u = d.u, v = d.v;
    const wTL = (1 - u) * (1 - v);
    const wTR = u * (1 - v);
    const wBL = (1 - u) * v;
    const wBR = u * v;
    // 把 (dx, dy) 按权重分给 4 角（注意：用户拖到的点位移 = dx, dy，
    // 等于 4 角各自位移 × 各自权重之和 = dx, dy。所以每个角各位移 dx*w）
    f.mesh[r    ][c    ] = { x: d.meshSnap[r    ][c    ].x + dx * wTL, y: d.meshSnap[r    ][c    ].y + dy * wTL };
    f.mesh[r    ][c + 1] = { x: d.meshSnap[r    ][c + 1].x + dx * wTR, y: d.meshSnap[r    ][c + 1].y + dy * wTR };
    f.mesh[r + 1][c    ] = { x: d.meshSnap[r + 1][c    ].x + dx * wBL, y: d.meshSnap[r + 1][c    ].y + dy * wBL };
    f.mesh[r + 1][c + 1] = { x: d.meshSnap[r + 1][c + 1].x + dx * wBR, y: d.meshSnap[r + 1][c + 1].y + dy * wBR };
  }

  // 给定 doc 坐标 (x, y) 找它落在 4×4 mesh 的哪个 cell + bilinear (u, v)
  _findWarpCell(x, y) {
    const f = this._floating;
    if (!f || f.meshN !== 4) return null;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const tl = f.mesh[r][c], tr = f.mesh[r][c + 1];
        const bl = f.mesh[r + 1][c], br = f.mesh[r + 1][c + 1];
        const uv = inverseBilinear(x, y, tl, tr, bl, br);
        if (uv && uv.u >= 0 && uv.u <= 1 && uv.v >= 0 && uv.v <= 1) {
          return { row: r, col: c, u: uv.u, v: uv.v };
        }
      }
    }
    return null;
  }
}

// ============ Selection 合成 ============

// 把 newSel 按 mode 合并到 oldSel。selection = {bboxX, bboxY, bboxW, bboxH, maskCanvas}
// 各 mode：
//   new       —— 直接替换为 newSel
//   union     —— old ∪ new                  (max alpha, equivalent to draw both)
//   subtract  —— old \ new                  (old AND NOT new = destination-out)
//   intersect —— old ∩ new                  (destination-in)
// 退化结果（mask 全空）→ 返回 null
function combineSelections(oldSel, newSel, mode) {
  if (!newSel) return oldSel;
  if (mode === "new" || !oldSel) return newSel;
  // 计算合成 bbox
  let x0, y0, x1, y1;
  if (mode === "intersect") {
    x0 = Math.max(oldSel.bboxX, newSel.bboxX);
    y0 = Math.max(oldSel.bboxY, newSel.bboxY);
    x1 = Math.min(oldSel.bboxX + oldSel.bboxW, newSel.bboxX + newSel.bboxW);
    y1 = Math.min(oldSel.bboxY + oldSel.bboxH, newSel.bboxY + newSel.bboxH);
    if (x1 <= x0 || y1 <= y0) return null;           // 不交 = 空选区
  } else {
    // union / subtract：union bbox
    x0 = Math.min(oldSel.bboxX, newSel.bboxX);
    y0 = Math.min(oldSel.bboxY, newSel.bboxY);
    x1 = Math.max(oldSel.bboxX + oldSel.bboxW, newSel.bboxX + newSel.bboxW);
    y1 = Math.max(oldSel.bboxY + oldSel.bboxH, newSel.bboxY + newSel.bboxH);
    if (mode === "subtract") {
      // 结果不会比 oldSel 大；用 oldSel 的 bbox 即可
      x0 = oldSel.bboxX; y0 = oldSel.bboxY;
      x1 = oldSel.bboxX + oldSel.bboxW; y1 = oldSel.bboxY + oldSel.bboxH;
    }
  }
  const w = x1 - x0, h = y1 - y0;
  const canvas = makeBitmap(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(oldSel.maskCanvas, oldSel.bboxX - x0, oldSel.bboxY - y0);
  if (mode === "union") {
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(newSel.maskCanvas, newSel.bboxX - x0, newSel.bboxY - y0);
  } else if (mode === "subtract") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(newSel.maskCanvas, newSel.bboxX - x0, newSel.bboxY - y0);
  } else if (mode === "intersect") {
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(newSel.maskCanvas, newSel.bboxX - x0, newSel.bboxY - y0);
  }
  ctx.globalCompositeOperation = "source-over";
  // TODO（P2 完善）：trim bbox 到 mask 实际范围。暂用合成 bbox（可能略大）
  return { bboxX: x0, bboxY: y0, bboxW: w, bboxH: h, maskCanvas: canvas };
}

// 反选：在 docW×docH 上 全白 - 选区 mask
export function invertSelection(sel, docW, docH) {
  const canvas = makeBitmap(docW, docH);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, docW, docH);
  if (sel) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(sel.maskCanvas, sel.bboxX, sel.bboxY);
    ctx.globalCompositeOperation = "source-over";
  }
  return { bboxX: 0, bboxY: 0, bboxW: docW, bboxH: docH, maskCanvas: canvas };
}

// ============ 几何工具 ============

function makeBitmap(w, h) {
  return (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(w, h)
    : (() => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; })();
}
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function norm(v) {
  const len = Math.hypot(v.x, v.y);
  return len > 1e-6 ? { x: v.x / len, y: v.y / len } : { x: 1, y: 0 };
}
function pointInPoly(poly, x, y) {
  // ray casting
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// 2×2 → 4×4：4 角保留，按 bilinear 内插填 12 个中间点
// 索引 (i, j) ∈ [0..3]，参数 u=j/3, v=i/3
function upsampleMesh2to4(m) {
  const tl = m[0][0], tr = m[0][1], bl = m[1][0], br = m[1][1];
  const out = [];
  for (let i = 0; i < 4; i++) {
    out[i] = [];
    const v = i / 3;
    for (let j = 0; j < 4; j++) {
      const u = j / 3;
      out[i][j] = {
        x: (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + (1 - u) * v * bl.x + u * v * br.x,
        y: (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + (1 - u) * v * bl.y + u * v * br.y,
      };
    }
  }
  return out;
}
// 4×4 → 2×2：只留 4 角，丢中间 12 点
function downsampleMesh4to2(m) {
  return [
    [{ ...m[0][0] }, { ...m[0][3] }],
    [{ ...m[3][0] }, { ...m[3][3] }],
  ];
}

// 逆 bilinear：给定四边形 (tl, tr, bl, br) 和点 (x, y)，求 (u, v) ∈ [0,1] 使得
// (1-u)(1-v)tl + u(1-v)tr + (1-u)v bl + uv br = (x, y)
// 一般是二次方程。这里用迭代逼近（数值稳健 + 对小扭曲准）
function inverseBilinear(x, y, tl, tr, bl, br) {
  // 初值：投影到 TL-TR-BL 三角的 affine 逆映射
  // affine: (x, y) = tl + u*(tr - tl) + v*(bl - tl)
  const ex = tr.x - tl.x, ey = tr.y - tl.y;
  const fx = bl.x - tl.x, fy = bl.y - tl.y;
  const det = ex * fy - ey * fx;
  if (Math.abs(det) < 1e-6) return null;
  const px = x - tl.x, py = y - tl.y;
  let u = (px * fy - py * fx) / det;
  let v = (-px * ey + py * ex) / det;
  // Newton 迭代精修（最多 4 步，残差 << 1px 就停）
  for (let k = 0; k < 4; k++) {
    const fx_ = (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + (1 - u) * v * bl.x + u * v * br.x - x;
    const fy_ = (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + (1 - u) * v * bl.y + u * v * br.y - y;
    if (Math.abs(fx_) < 0.5 && Math.abs(fy_) < 0.5) break;
    // Jacobian
    const Jux = -(1 - v) * tl.x + (1 - v) * tr.x - v * bl.x + v * br.x;
    const Juy = -(1 - v) * tl.y + (1 - v) * tr.y - v * bl.y + v * br.y;
    const Jvx = -(1 - u) * tl.x - u * tr.x + (1 - u) * bl.x + u * br.x;
    const Jvy = -(1 - u) * tl.y - u * tr.y + (1 - u) * bl.y + u * br.y;
    const jdet = Jux * Jvy - Juy * Jvx;
    if (Math.abs(jdet) < 1e-6) break;
    u -= (fx_ * Jvy - fy_ * Jvx) / jdet;
    v -= (-fx_ * Juy + fy_ * Jux) / jdet;
  }
  return { u, v };
}

// ============ 三角剖分 mesh 渲染 ============
// export 给 board.js 也用同一份代码画 floating 浮层
//
// 2×2 mesh（free / uniform / distort）：用 homography 把 src 单位方格映射到 dst 四边形
//   → 在 dst 上按 homography 取密集子格点 → 每子格切 2 三角 affine drawImage
//   等价于让小三角足够小，使得 perspective ≈ affine（PS1 经典 artifact 消失）
// 4×4 mesh（warp）：tensor-product Catmull-Rom 升采样到密集网格再画。Catmull-Rom 控
//   制点处 C1（切线连续），密集子格下渲染 C0 折角小到肉眼难察。
const PERSP_SUBDIV = 12;   // 2×2 quad 切 12×12 子格 = 144 cell = 288 三角
const SMOOTH_SUBDIV = 6;   // 4×4 mesh 每 cell 切 6 段 = (3×6+1)² = 361 顶点 = 648 三角
export function drawMesh(ctx, srcCanvas, srcW, srcH, mesh, opts = {}) {
  let renderMesh;
  let densifySrc = false;
  if (mesh.length === 4 && opts.smooth) {
    renderMesh = subdivideCatmullRom4x4(mesh, SMOOTH_SUBDIV);
    densifySrc = true;
  } else if (mesh.length === 2) {
    // 任何 2×2 都走 homography 子格化（free / uniform 平行四边形时它退化到 affine；
    // distort 时给出真正的透视）
    renderMesh = subdivideQuadByHomography(mesh, PERSP_SUBDIV);
    densifySrc = true;
  } else {
    renderMesh = mesh;
  }
  const N = renderMesh.length;
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < N - 1; j++) {
      const sxL = j       * srcW / (N - 1);
      const sxR = (j + 1) * srcW / (N - 1);
      const syT = i       * srcH / (N - 1);
      const syB = (i + 1) * srcH / (N - 1);
      const dTL = renderMesh[i][j],     dTR = renderMesh[i][j + 1];
      const dBL = renderMesh[i + 1][j], dBR = renderMesh[i + 1][j + 1];
      drawTextureTri(ctx, srcCanvas,
        sxL, syT, sxR, syT, sxL, syB,
        dTL.x, dTL.y, dTR.x, dTR.y, dBL.x, dBL.y);
      drawTextureTri(ctx, srcCanvas,
        sxR, syT, sxR, syB, sxL, syB,
        dTR.x, dTR.y, dBR.x, dBR.y, dBL.x, dBL.y);
    }
  }
}

// 单位方格 (0,0)-(1,1) → 一般四边形 (TL, TR, BR, BL) 的 homography。
// 用 Heckbert 1989 闭式解。返回 8 系数 + 隐含 i=1：
//   x = (a*u + b*v + c) / (g*u + h*v + 1)
//   y = (d*u + e*v + f) / (g*u + h*v + 1)
// 当四角是平行四边形时 g=h=0，退化为纯 affine
function homographyFromUnitSquareToQuad(tl, tr, br, bl) {
  const dx1 = tr.x - br.x, dy1 = tr.y - br.y;
  const dx2 = bl.x - br.x, dy2 = bl.y - br.y;
  const sx = tl.x - tr.x + br.x - bl.x;
  const sy = tl.y - tr.y + br.y - bl.y;
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) < 1e-9) return null;        // 退化
  const g = (sx * dy2 - dx2 * sy) / det;
  const h = (dx1 * sy - sx * dy1) / det;
  return {
    a: tr.x - tl.x + g * tr.x,
    b: bl.x - tl.x + h * bl.x,
    c: tl.x,
    d: tr.y - tl.y + g * tr.y,
    e: bl.y - tl.y + h * bl.y,
    f: tl.y,
    g, h,
  };
}
function homographySample(H, u, v) {
  const w = H.g * u + H.h * v + 1;
  return {
    x: (H.a * u + H.b * v + H.c) / w,
    y: (H.d * u + H.e * v + H.f) / w,
  };
}
// 2×2 mesh → (sub+1)×(sub+1) 密集网格（沿真 homography 取样，非简单 bilinear）
function subdivideQuadByHomography(m, sub) {
  const H = homographyFromUnitSquareToQuad(m[0][0], m[0][1], m[1][1], m[1][0]);
  if (!H) return m;
  const N = sub + 1;
  const out = [];
  for (let i = 0; i < N; i++) {
    out[i] = new Array(N);
    const v = i / sub;
    for (let j = 0; j < N; j++) {
      const u = j / sub;
      out[i][j] = homographySample(H, u, v);
    }
  }
  return out;
}

// 4×4 控制网格 → 密集网格（tensor-product Catmull-Rom）。
// 一行 4 个 control point → 3 段曲线 (P0-P1, P1-P2, P2-P3)
// 端点反射当 phantom P-1 / P4，让曲线在端点处有连续切线
// 输出网格：每方向 (3 * sub + 1) 个点，过原 control point 时插值精确
function subdivideCatmullRom4x4(m, sub) {
  // 先按行升采样（每行 4 点 → 3*sub+1 点）
  const rowDense = [];
  for (let i = 0; i < 4; i++) {
    rowDense.push(catmullRomSegments(m[i], sub));
  }
  // 再按列升采样
  const cols = rowDense[0].length;
  const out = [];
  for (let bi = 0; bi < 3 * sub + 1; bi++) {
    out[bi] = new Array(cols);
  }
  for (let j = 0; j < cols; j++) {
    const colPts = [rowDense[0][j], rowDense[1][j], rowDense[2][j], rowDense[3][j]];
    const denseCol = catmullRomSegments(colPts, sub);
    for (let i = 0; i < denseCol.length; i++) {
      out[i][j] = denseCol[i];
    }
  }
  return out;
}

// 4 control points → 3 segments * sub 子段 + 1 endpoint
function catmullRomSegments([p0, p1, p2, p3], sub) {
  // phantom 端点：反射
  const pm1 = { x: 2 * p0.x - p1.x, y: 2 * p0.y - p1.y };
  const pp4 = { x: 2 * p3.x - p2.x, y: 2 * p3.y - p2.y };
  const out = [];
  out.push({ ...p0 });
  // seg 0: pm1, p0, p1, p2 between p0 and p1
  for (let s = 1; s <= sub; s++) {
    out.push(catmullRomPoint(pm1, p0, p1, p2, s / sub));
  }
  for (let s = 1; s <= sub; s++) {
    out.push(catmullRomPoint(p0, p1, p2, p3, s / sub));
  }
  for (let s = 1; s <= sub; s++) {
    out.push(catmullRomPoint(p1, p2, p3, pp4, s / sub));
  }
  return out;
}
function catmullRomPoint(P0, P1, P2, P3, t) {
  const t2 = t * t, t3 = t2 * t;
  // Standard Catmull-Rom basis（tau = 0.5）
  return {
    x: 0.5 * ((2 * P1.x) + (-P0.x + P2.x) * t + (2*P0.x - 5*P1.x + 4*P2.x - P3.x) * t2 + (-P0.x + 3*P1.x - 3*P2.x + P3.x) * t3),
    y: 0.5 * ((2 * P1.y) + (-P0.y + P2.y) * t + (2*P0.y - 5*P1.y + 4*P2.y - P3.y) * t2 + (-P0.y + 3*P1.y - 3*P2.y + P3.y) * t3),
  };
}

// ============ Per-pixel inverse-homography render (free / uniform / distort) ============
// 2×2 mesh 走真正的 per-pixel inverse mapping，不再用三角化近似。
// 数学正确：每个 dst pixel 通过 inverse homography 算回 src 单位方格的 (u, v)，
// 再 bilinear 采样源像素。零 PS1 artifact，零 C0 折角（quad 内是 1 个连续映射）。
//
// 返回 { canvas: <bitmap>, dstX, dstY } 表示渲染出的图 + 它在 doc 坐标的左上角。
// caller 负责 drawImage 到合适的上下文。
//
// 性能：500×500 输出 ≈ 250K pixels × ~20 ops = 5M ops ≈ 50ms on iPad mini。preview 可接受。
export function renderQuadPerPixel(srcImageData, srcW, srcH, mesh) {
  const tl = mesh[0][0], tr = mesh[0][1], bl = mesh[1][0], br = mesh[1][1];
  const minX = Math.floor(Math.min(tl.x, tr.x, bl.x, br.x));
  const minY = Math.floor(Math.min(tl.y, tr.y, bl.y, br.y));
  const maxX = Math.ceil(Math.max(tl.x, tr.x, bl.x, br.x));
  const maxY = Math.ceil(Math.max(tl.y, tr.y, bl.y, br.y));
  const dstW = maxX - minX, dstH = maxY - minY;
  if (dstW <= 0 || dstH <= 0) return null;

  // Forward H: unit square → quad（Heckbert）
  const Hfwd = homographyFromUnitSquareToQuad(tl, tr, br, bl);
  if (!Hfwd) return null;
  const H9 = [Hfwd.a, Hfwd.b, Hfwd.c, Hfwd.d, Hfwd.e, Hfwd.f, Hfwd.g, Hfwd.h, 1];
  // Inverse: quad → unit square
  const Hinv = invertMat3(H9);
  if (!Hinv) return null;

  const out = new ImageData(dstW, dstH);
  const odata = out.data;
  const sdata = srcImageData.data;

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const docX = minX + dx + 0.5;     // pixel center
      const docY = minY + dy + 0.5;
      const w = Hinv[6] * docX + Hinv[7] * docY + Hinv[8];
      if (Math.abs(w) < 1e-9) continue;
      const u = (Hinv[0] * docX + Hinv[1] * docY + Hinv[2]) / w;
      const v = (Hinv[3] * docX + Hinv[4] * docY + Hinv[5]) / w;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const sx = u * srcW;
      const sy = v * srcH;
      bilinearSample(sdata, srcW, srcH, sx, sy, odata, (dy * dstW + dx) * 4);
    }
  }

  const canvas = makeBitmap(dstW, dstH);
  const c = canvas.getContext("2d");
  c.putImageData(out, 0, 0);
  return { canvas, dstX: minX, dstY: minY };
}

// bilinear sample（同 liquify.js 那份；private copy 避免跨模块依赖）
function bilinearSample(sdat, w, h, sx, sy, ddat, dstIdx) {
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  const fx = sx - ix;
  const fy = sy - iy;
  const x0 = ix, x1 = ix + 1;
  const y0 = iy, y1 = iy + 1;
  const p00 = (x0 >= 0 && x0 < w && y0 >= 0 && y0 < h) ? (y0 * w + x0) * 4 : -1;
  const p10 = (x1 >= 0 && x1 < w && y0 >= 0 && y0 < h) ? (y0 * w + x1) * 4 : -1;
  const p01 = (x0 >= 0 && x0 < w && y1 >= 0 && y1 < h) ? (y1 * w + x0) * 4 : -1;
  const p11 = (x1 >= 0 && x1 < w && y1 >= 0 && y1 < h) ? (y1 * w + x1) * 4 : -1;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  for (let c = 0; c < 4; c++) {
    let v = 0;
    if (p00 >= 0) v += sdat[p00 + c] * w00;
    if (p10 >= 0) v += sdat[p10 + c] * w10;
    if (p01 >= 0) v += sdat[p01 + c] * w01;
    if (p11 >= 0) v += sdat[p11 + c] * w11;
    ddat[dstIdx + c] = v;
  }
}

// 3×3 matrix invert (canonical form：output normalize so [8] = 1)
function invertMat3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return null;
  const inv = [
    (e * i - f * h) / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    -(d * i - f * g) / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    (d * h - e * g) / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
  if (Math.abs(inv[8]) > 1e-9) {
    const k = 1 / inv[8];
    for (let n = 0; n < 9; n++) inv[n] *= k;
  }
  return inv;
}

// 把源图的一个三角形（在 src 像素坐标里）映射到 dst 三角形（在当前 ctx 坐标里）
// 通过 ctx.transform 设 affine（src → dst）+ ctx.clip 限范围 + ctx.drawImage 整张源。
// 标准 Canvas2D texture-mapping 技巧；O(三角形像素面积) GPU 复合。
// warp 模式（4×4 mesh）暂时仍走这个。下个 PR 走 Newton inverse + forward splat。
function drawTextureTri(ctx, src,
                        sx0, sy0, sx1, sy1, sx2, sy2,
                        dx0, dy0, dx1, dy1, dx2, dy2) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(dx0, dy0);
  ctx.lineTo(dx1, dy1);
  ctx.lineTo(dx2, dy2);
  ctx.closePath();
  ctx.clip();
  // 求 affine [a,b,c,d,e,f] 满足：
  //   dx = a*sx + c*sy + e
  //   dy = b*sx + d*sy + f
  // 三个 src→dst 对解 2 个 3×3 线性方程组。Cramer's rule。
  const denom = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0);
  if (Math.abs(denom) < 1e-9) { ctx.restore(); return; }   // 退化三角
  const a = ((dx1 - dx0) * (sy2 - sy0) - (dx2 - dx0) * (sy1 - sy0)) / denom;
  const c = ((dx2 - dx0) * (sx1 - sx0) - (dx1 - dx0) * (sx2 - sx0)) / denom;
  const b = ((dy1 - dy0) * (sy2 - sy0) - (dy2 - dy0) * (sy1 - sy0)) / denom;
  const d = ((dy2 - dy0) * (sx1 - sx0) - (dy1 - dy0) * (sx2 - sx0)) / denom;
  const e = dx0 - a * sx0 - c * sy0;
  const f = dy0 - b * sx0 - d * sy0;
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(src, 0, 0);
  ctx.restore();
}
