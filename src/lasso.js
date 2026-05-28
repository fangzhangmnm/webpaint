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
    this._state = "idle";         // idle | drawing-freehand | drawing-rect | drawing-ellipse | floating
    this._subTool = "freehand";   // freehand | rect | ellipse | magic
    this._setOpMode = "new";      // new | union | subtract | intersect
    this._constrainSquare = false; // rect / ellipse 是否强制 1:1（正方形 / 圆）
    this._magicThreshold = 20;    // 0..100；魔术棒颜色相似度
    this._magicGapPx = 4;         // 0..10 px；缝隙容隙（容隙），> 0 时启用 gap closing
    this._sampleMode = "bilinear";// nearest | bilinear | bicubic（transform 重采样质量）
    this._points = [];            // freehand draft
    this._rect = null;            // {x0, y0, x1, y1} during rect / ellipse draw
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
  setMagicGapPx(v) { this._magicGapPx = Math.max(0, Math.min(10, v | 0)); }
  getMagicGapPx() { return this._magicGapPx; }
  setSampleMode(m) {
    if (m === "nearest" || m === "bilinear" || m === "bicubic") {
      this._sampleMode = m;
      if (this._floating) { this._floating._renderCache = null; this.onChange(); }
    }
  }
  getSampleMode() { return this._sampleMode; }
  setConstrainSquare(on) { this._constrainSquare = !!on; this.onChange(); }
  getConstrainSquare() { return this._constrainSquare; }

  // -------- 选区路径（按 subTool 路由）--------
  beginPath(x, y) {
    if (this._floating) return;        // transform 期间不能再画
    if (this._subTool === "freehand") {
      this._state = "drawing-freehand";
      this._points = [{ x, y }];
    } else if (this._subTool === "rect") {
      this._state = "drawing-rect";
      this._rect = { x0: x, y0: y, x1: x, y1: y };
    } else if (this._subTool === "ellipse") {
      this._state = "drawing-ellipse";
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
    } else if (this._state === "drawing-rect" || this._state === "drawing-ellipse") {
      let nx = x, ny = y;
      // 正方 / 圆 约束：让 (x1-x0) 和 (y1-y0) 绝对值相等（取较大者）
      if (this._constrainSquare) {
        const dx = x - this._rect.x0, dy = y - this._rect.y0;
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        nx = this._rect.x0 + (dx >= 0 ? m : -m);
        ny = this._rect.y0 + (dy >= 0 ? m : -m);
      }
      this._rect.x1 = nx;
      this._rect.y1 = ny;
      this.onChange();
    }
  }
  // 收笔：rasterize → combine with doc.selection per setOpMode → 更新 doc.selection
  // 返回 history entry（caller push）或 null（选区无效 / 没动）
  endPath(sourceLayer) {
    let newSel = null;
    if (this._state === "drawing-freehand") {
      newSel = this._rasterizeFreehandToSelection(this._points);
      this._points = [];
    } else if (this._state === "drawing-rect") {
      newSel = this._rasterizeRectToSelection(this._rect);
      this._rect = null;
    } else if (this._state === "drawing-ellipse") {
      newSel = this._rasterizeEllipseToSelection(this._rect);
      this._rect = null;
    } else if (this._state === "magic-tentative") {
      newSel = this._magicWandToSelection(this._magicStart, sourceLayer);
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
    // 新 selection 还没缓存 outline；history undo / redo 拿回旧 sel 时 outline 还在那
    if (sel && !sel._outline) sel._outline = null;
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
  _rasterizeEllipseToSelection(r) {
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
    mctx.beginPath();
    mctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    mctx.fill();
    return { bboxX: x0, bboxY: y0, bboxW: w, bboxH: h, maskCanvas };
  }
  // 魔术棒：tap → flood fill → 颜色差 ≤ threshold 的相邻像素入选。
  //
  // 经典 bug 1（v66）+ 又犯一次（v69）：迭代局限在 layer.bbox 内
  // → 点空白处只能选到 bbox 矩形。修：迭代 **整 doc 尺寸**，layer bbox 外
  // 视为 (0,0,0,0) 透明像素。点空白时 flood 能跨出 layer bbox 选到全部相连透明。
  //
  // 容隙模式（gapPx > 0，WebPaint 独有）：处理线稿不闭合的小缝。
  //   step 1: 标 barrier（颜色差 > threshold = 「线」）
  //   step 2: dilate barrier N px，缝隙 ≤ 2N 自动封口
  //   step 3: flood fill in non-barrier
  //   step 4: dilate fill mask N px，让选区贴回原线
  _magicWandToSelection(start, sourceLayer) {
    if (!start || !this.doc) return null;
    const docW = this.doc.width, docH = this.doc.height;
    const sx = Math.floor(start.x);
    const sy = Math.floor(start.y);
    if (sx < 0 || sx >= docW || sy < 0 || sy >= docH) return null;

    // 取 source layer pixels（可能小于 doc）；layer 外当透明
    const lbX = sourceLayer?.bboxX ?? 0;
    const lbY = sourceLayer?.bboxY ?? 0;
    const lbW = sourceLayer?.bboxW ?? 0;
    const lbH = sourceLayer?.bboxH ?? 0;
    let layerData = null;
    if (sourceLayer && lbW > 0 && lbH > 0) {
      layerData = sourceLayer.ctx.getImageData(0, 0, lbW, lbH).data;
    }

    // tap 点颜色（layer 外 → 透明）
    let sr = 0, sg = 0, sb = 0, sa = 0;
    if (layerData && sx >= lbX && sx < lbX + lbW && sy >= lbY && sy < lbY + lbH) {
      const idx = ((sy - lbY) * lbW + (sx - lbX)) * 4;
      sr = layerData[idx]; sg = layerData[idx + 1]; sb = layerData[idx + 2]; sa = layerData[idx + 3];
    }
    const tCh = this._magicThreshold * 2.55;
    const N = this._magicGapPx | 0;
    const total = docW * docH;

    // step 1: barrier 整 doc 尺寸。layer 外按透明 diff 决定一次：透明 vs tap
    const outsideDiff = Math.max(sr, sg, sb, sa);  // = max(|0-sr|, |0-sg|, |0-sb|, |0-sa|)
    const outsideIsBarrier = outsideDiff > tCh ? 1 : 0;
    const barrier = new Uint8Array(total);
    if (outsideIsBarrier) barrier.fill(1);
    // layer 内：per-pixel barrier
    if (layerData) {
      for (let y = 0; y < lbH; y++) {
        const docY = lbY + y;
        if (docY < 0 || docY >= docH) continue;
        for (let x = 0; x < lbW; x++) {
          const docX = lbX + x;
          if (docX < 0 || docX >= docW) continue;
          const i4 = (y * lbW + x) * 4;
          const dr = Math.abs(layerData[i4]     - sr);
          const dg = Math.abs(layerData[i4 + 1] - sg);
          const db = Math.abs(layerData[i4 + 2] - sb);
          const da = Math.abs(layerData[i4 + 3] - sa);
          barrier[docY * docW + docX] = Math.max(dr, dg, db, da) > tCh ? 1 : 0;
        }
      }
    }
    // step 2: dilate barrier
    const effBarrier = N > 0 ? dilateBinary(barrier, docW, docH, N) : barrier;
    if (effBarrier[sx + sy * docW]) return null;
    // step 3: flood fill；同时 track mask bbox 省后面扫一遍
    const visited = new Uint8Array(total);
    let mask = new Uint8Array(total);
    const stack = [sx + sy * docW];
    visited[sx + sy * docW] = 1;
    let mnx = docW, mny = docH, mxx = -1, mxy = -1;
    while (stack.length) {
      const p = stack.pop();
      if (effBarrier[p]) continue;
      mask[p] = 255;
      const px = p % docW;
      const py = (p - px) / docW;
      if (px < mnx) mnx = px; if (px > mxx) mxx = px;
      if (py < mny) mny = py; if (py > mxy) mxy = py;
      if (px > 0        && !visited[p - 1])    { visited[p - 1] = 1; stack.push(p - 1); }
      if (px < docW - 1 && !visited[p + 1])    { visited[p + 1] = 1; stack.push(p + 1); }
      if (py > 0        && !visited[p - docW]) { visited[p - docW] = 1; stack.push(p - docW); }
      if (py < docH - 1 && !visited[p + docW]) { visited[p + docW] = 1; stack.push(p + docW); }
    }
    if (mxx < 0) return null;
    // step 4: dilate mask；bbox 跟着外扩 N
    if (N > 0) {
      mask = dilateBinary(mask, docW, docH, N);
      mnx = Math.max(0, mnx - N);
      mny = Math.max(0, mny - N);
      mxx = Math.min(docW - 1, mxx + N);
      mxy = Math.min(docH - 1, mxy + N);
    }
    // Build maskCanvas from [mnx..mxx, mny..mxy]
    const tw = mxx - mnx + 1, th = mxy - mny + 1;
    const maskCanvas = makeBitmap(tw, th);
    const mctx = maskCanvas.getContext("2d");
    const out = mctx.createImageData(tw, th);
    const odata = out.data;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const src = mask[(mny + y) * docW + (mnx + x)];
      const o = (y * tw + x) * 4;
      odata[o] = 255; odata[o + 1] = 255; odata[o + 2] = 255; odata[o + 3] = src;
    }
    mctx.putImageData(out, 0, 0);
    // mnx/mny 已经是 doc 坐标（迭代是整 doc 尺寸）
    return { bboxX: mnx, bboxY: mny, bboxW: tw, bboxH: th, maskCanvas };
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

  // Stamp：当前 float 写入 layer，但 KEEP float 在原状态。
  // 不 push history（stamp 是 float session 内部动作）；最终 commit 时一次性 push。
  // 多次 stamp + commit/cancel：cancel 会 restoreFromSnapshot(preLift) 把所有 stamp 一并撤回。
  stamp() {
    const f = this._floating;
    if (!f) return false;
    const layer = f.layer;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const row of f.mesh) for (const p of row) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    layer.ensureBbox(Math.floor(minX), Math.floor(minY), Math.ceil(maxX), Math.ceil(maxY));
    const lbX = layer.bboxX, lbY = layer.bboxY;
    if (f.meshN === 2) {
      const rendered = renderQuadPerPixel(f.imageData, f.srcW, f.srcH, f.mesh, this._sampleMode);
      if (rendered) layer.ctx.drawImage(rendered.canvas, rendered.dstX - lbX, rendered.dstY - lbY);
    } else {
      layer.ctx.save();
      layer.ctx.translate(-lbX, -lbY);
      drawMesh(layer.ctx, f.canvas, f.srcW, f.srcH, f.mesh, { smooth: this._sampleMode !== "nearest" });
      layer.ctx.restore();
    }
    this.onChange();
    return true;
  }

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
      const rendered = renderQuadPerPixel(f.imageData, f.srcW, f.srcH, f.mesh, this._sampleMode);
      if (rendered) {
        layer.ctx.drawImage(rendered.canvas, rendered.dstX - lbX, rendered.dstY - lbY);
      }
    } else {
      layer.ctx.save();
      layer.ctx.translate(-lbX, -lbY);
      drawMesh(layer.ctx, f.canvas, f.srcW, f.srcH, f.mesh, { smooth: this._sampleMode !== "nearest" });
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
  getDrawingEllipse() { return this._state === "drawing-ellipse" ? this._rect : null; }
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

// Marching squares：从 selection 的 maskCanvas 抽出轮廓 polyline 段。
// 输入：selection = { bboxX, bboxY, bboxW, bboxH, maskCanvas }
// 输出：Float32Array 平铺 [x0, y0, x1, y1, ...]（每 4 个数一条线段，doc 坐标）
// 复杂度：O(bboxW × bboxH)。500×500 ≈ 250K cells ≈ 10ms（一次性，cache 到 sel）
export function extractMaskOutline(sel) {
  const w = sel.bboxW, h = sel.bboxH;
  if (w <= 1 || h <= 1) return new Float32Array(0);
  const ctx = sel.maskCanvas.getContext("2d");
  const data = ctx.getImageData(0, 0, w, h).data;
  const segs = [];
  // 每个 (x, y) cell 用 4 邻角组 4-bit index：TL=bit0 TR=bit1 BR=bit2 BL=bit3
  // 边中点：T=(x+0.5, y), R=(x+1, y+0.5), B=(x+0.5, y+1), L=(x, y+0.5)
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const a00 = data[(y       * w + x      ) * 4 + 3] > 128 ? 1 : 0;
      const a10 = data[(y       * w + (x + 1)) * 4 + 3] > 128 ? 1 : 0;
      const a01 = data[((y + 1) * w + x      ) * 4 + 3] > 128 ? 1 : 0;
      const a11 = data[((y + 1) * w + (x + 1)) * 4 + 3] > 128 ? 1 : 0;
      const idx = a00 | (a10 << 1) | (a11 << 2) | (a01 << 3);
      if (idx === 0 || idx === 15) continue;
      const xL = sel.bboxX + x,       xR = sel.bboxX + x + 1, xM = sel.bboxX + x + 0.5;
      const yT = sel.bboxY + y,       yB = sel.bboxY + y + 1, yM = sel.bboxY + y + 0.5;
      // 4-bit lookup → 0/1/2 段（saddle case 5/10 拆两段）
      switch (idx) {
        case 1:  segs.push(xM, yT,  xL, yM); break;
        case 2:  segs.push(xM, yT,  xR, yM); break;
        case 3:  segs.push(xL, yM,  xR, yM); break;
        case 4:  segs.push(xR, yM,  xM, yB); break;
        case 5:  segs.push(xM, yT,  xR, yM);
                 segs.push(xM, yB,  xL, yM); break;
        case 6:  segs.push(xM, yT,  xM, yB); break;
        case 7:  segs.push(xM, yB,  xL, yM); break;
        case 8:  segs.push(xL, yM,  xM, yB); break;
        case 9:  segs.push(xM, yT,  xM, yB); break;
        case 10: segs.push(xM, yT,  xL, yM);
                 segs.push(xR, yM,  xM, yB); break;
        case 11: segs.push(xR, yM,  xM, yB); break;
        case 12: segs.push(xL, yM,  xR, yM); break;
        case 13: segs.push(xM, yT,  xR, yM); break;
        case 14: segs.push(xM, yT,  xL, yM); break;
      }
    }
  }
  return new Float32Array(segs);
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

// ============ 选区应用到 layer 的操作 ============

// 笔刷 / 橡皮 / 液化结束后调用：把 layer 在 selection 外的像素 revert 到 preSnap。
// 等价"stroke 只在 selection 内生效"。post-process 比 in-stroke clip 简单 + 与
// brush engine 解耦。代价：用户拖动时看到完整 stroke，松手时才 snap 到选区内（v1 接受）
//
// 走 per-pixel JS：选区外 → 取 pre 像素；选区内 → 取 after 像素。
// 同时适用 brush（additive）和 eraser（destructive）—— 因为是"按 mask 选 pre 还是 after"，
// 不是用 composite 模式组合，所以 erase 模式（stroke 让某些像素变透明）也正确
export function applySelectionMaskPostStroke(layer, preSnap, selection) {
  if (!selection || !preSnap) return;
  const afterSnap = layer.snapshot();
  // 联合 bbox = max(pre, after) in doc coords
  const px0 = preSnap.bboxX, py0 = preSnap.bboxY;
  const px1 = px0 + preSnap.bboxW, py1 = py0 + preSnap.bboxH;
  const ax0 = afterSnap.bboxX, ay0 = afterSnap.bboxY;
  const ax1 = ax0 + afterSnap.bboxW, ay1 = ay0 + afterSnap.bboxH;
  const ux0 = Math.min(px0, ax0), uy0 = Math.min(py0, ay0);
  const ux1 = Math.max(px1, ax1), uy1 = Math.max(py1, ay1);
  const uw = ux1 - ux0, uh = uy1 - uy0;
  if (uw <= 0 || uh <= 0) return;

  // 读 mask 全像素到 ImageData
  let maskData = null;
  if (selection.bboxW > 0 && selection.bboxH > 0) {
    const mctx = selection.maskCanvas.getContext("2d");
    maskData = mctx.getImageData(0, 0, selection.bboxW, selection.bboxH).data;
  }

  const preData = preSnap.imageData ? preSnap.imageData.data : null;
  const afterData = afterSnap.imageData ? afterSnap.imageData.data : null;

  const out = new ImageData(uw, uh);
  const odata = out.data;
  for (let y = 0; y < uh; y++) {
    for (let x = 0; x < uw; x++) {
      const docX = ux0 + x;
      const docY = uy0 + y;
      // mask lookup
      let maskAlpha = 0;
      const mx = docX - selection.bboxX;
      const my = docY - selection.bboxY;
      if (maskData && mx >= 0 && mx < selection.bboxW && my >= 0 && my < selection.bboxH) {
        maskAlpha = maskData[(my * selection.bboxW + mx) * 4 + 3];
      }
      const oi = (y * uw + x) * 4;
      // 选区内取 after；选区外取 pre。两个都没数据 = 透明（odata 默认 0）
      const useAfter = maskAlpha > 0;
      if (useAfter && afterData) {
        const aix = docX - ax0, aiy = docY - ay0;
        if (aix >= 0 && aix < afterSnap.bboxW && aiy >= 0 && aiy < afterSnap.bboxH) {
          const i = (aiy * afterSnap.bboxW + aix) * 4;
          odata[oi] = afterData[i]; odata[oi + 1] = afterData[i + 1];
          odata[oi + 2] = afterData[i + 2]; odata[oi + 3] = afterData[i + 3];
        }
      } else if (!useAfter && preData) {
        const pix = docX - px0, piy = docY - py0;
        if (pix >= 0 && pix < preSnap.bboxW && piy >= 0 && piy < preSnap.bboxH) {
          const i = (piy * preSnap.bboxW + pix) * 4;
          odata[oi] = preData[i]; odata[oi + 1] = preData[i + 1];
          odata[oi + 2] = preData[i + 2]; odata[oi + 3] = preData[i + 3];
        }
      }
    }
  }
  // 写回 layer（先 ensureBbox 容纳 union）
  layer.ensureBbox(ux0, uy0, ux1, uy1);
  layer.ctx.putImageData(out, ux0 - layer.bboxX, uy0 - layer.bboxY);
}

// 填色：在 selection 内填 layer 当前颜色（layer 改前 push history snap）
// 调用方负责 push history entry
export function fillSelectionOnLayer(layer, selection, color) {
  if (!selection || !layer) return;
  layer.ensureBbox(
    selection.bboxX, selection.bboxY,
    selection.bboxX + selection.bboxW, selection.bboxY + selection.bboxH,
  );
  // 先建一张 selection-shape 的 colored canvas，再 drawImage 到 layer
  const tmp = makeBitmap(selection.bboxW, selection.bboxH);
  const tctx = tmp.getContext("2d");
  tctx.fillStyle = color;
  tctx.fillRect(0, 0, selection.bboxW, selection.bboxH);
  tctx.globalCompositeOperation = "destination-in";
  tctx.drawImage(selection.maskCanvas, 0, 0);
  tctx.globalCompositeOperation = "source-over";
  layer.ctx.drawImage(tmp,
    selection.bboxX - layer.bboxX,
    selection.bboxY - layer.bboxY);
}

// 清除选区内像素（dst-out mask）
export function clearSelectionOnLayer(layer, selection) {
  if (!selection || !layer) return;
  const lctx = layer.ctx;
  lctx.save();
  lctx.globalCompositeOperation = "destination-out";
  lctx.drawImage(selection.maskCanvas,
    selection.bboxX - layer.bboxX,
    selection.bboxY - layer.bboxY);
  lctx.restore();
}

// ============ 几何工具 ============

// Chebyshev / 方块 kernel dilate（可分离：横一次 + 纵一次 = 2N 比 N×N 快得多）
// 输入 / 输出：Uint8Array(w*h)，每个像素 0 或 ≥1（值不区分；输出全 0 / 1）
function dilateBinary(src, w, h, n) {
  if (n <= 0) return src;
  const tmp = new Uint8Array(w * h);
  // horizontal pass：tmp[y, x] = max(src[y, x-n..x+n])
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    // sliding count: 维护窗口内 src=1 的数量
    for (let x = 0; x < Math.min(n, w); x++) if (src[row + x]) count++;
    for (let x = 0; x < w; x++) {
      const right = x + n;
      if (right < w && src[row + right]) count++;
      tmp[row + x] = count > 0 ? 1 : 0;
      const left = x - n;
      if (left >= 0 && src[row + left]) count--;
    }
  }
  // vertical pass：out[y, x] = max(tmp[y-n..y+n, x])
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(n, h); y++) if (tmp[y * w + x]) count++;
    for (let y = 0; y < h; y++) {
      const bot = y + n;
      if (bot < h && tmp[bot * w + x]) count++;
      out[y * w + x] = count > 0 ? 1 : 0;
      const top = y - n;
      if (top >= 0 && tmp[top * w + x]) count--;
    }
  }
  return out;
}

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
export function renderQuadPerPixel(srcImageData, srcW, srcH, mesh, sampleMode = "bilinear") {
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
      if (sampleMode === "nearest") {
        nearestSample(sdata, srcW, srcH, sx, sy, odata, (dy * dstW + dx) * 4);
      } else if (sampleMode === "bicubic") {
        bicubicSample(sdata, srcW, srcH, sx, sy, odata, (dy * dstW + dx) * 4);
      } else {
        bilinearSample(sdata, srcW, srcH, sx, sy, odata, (dy * dstW + dx) * 4);
      }
    }
  }

  const canvas = makeBitmap(dstW, dstH);
  const c = canvas.getContext("2d");
  c.putImageData(out, 0, 0);
  return { canvas, dstX: minX, dstY: minY };
}

// 最近邻 sample：pixel art / 硬边
function nearestSample(sdat, w, h, sx, sy, ddat, dstIdx) {
  const ix = Math.floor(sx), iy = Math.floor(sy);
  if (ix < 0 || ix >= w || iy < 0 || iy >= h) return;
  const p = (iy * w + ix) * 4;
  ddat[dstIdx]     = sdat[p];
  ddat[dstIdx + 1] = sdat[p + 1];
  ddat[dstIdx + 2] = sdat[p + 2];
  ddat[dstIdx + 3] = sdat[p + 3];
}
// Catmull-Rom bicubic（B=0, C=0.5）。4×4 taps，钝锐适中。
function bicubicSample(sdat, w, h, sx, sy, ddat, dstIdx) {
  const ix = Math.floor(sx), iy = Math.floor(sy);
  // Catmull-Rom kernel
  const k = (t) => {
    const a = -0.5;
    const at = Math.abs(t);
    if (at < 1) return (a + 2) * at * at * at - (a + 3) * at * at + 1;
    if (at < 2) return a * at * at * at - 5 * a * at * at + 8 * a * at - 4 * a;
    return 0;
  };
  // 4 taps: x = ix-1, ix, ix+1, ix+2；t = tap_x - sx
  const kx = [k((ix - 1) - sx), k(ix - sx), k((ix + 1) - sx), k((ix + 2) - sx)];
  const ky = [k((iy - 1) - sy), k(iy - sy), k((iy + 1) - sy), k((iy + 2) - sy)];
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < 4; j++) {
    const yy = iy - 1 + j;
    if (yy < 0 || yy >= h) continue;
    for (let i = 0; i < 4; i++) {
      const xx = ix - 1 + i;
      if (xx < 0 || xx >= w) continue;
      const p = (yy * w + xx) * 4;
      const ww = kx[i] * ky[j];
      r += sdat[p]     * ww;
      g += sdat[p + 1] * ww;
      b += sdat[p + 2] * ww;
      a += sdat[p + 3] * ww;
    }
  }
  ddat[dstIdx]     = Math.max(0, Math.min(255, r));
  ddat[dstIdx + 1] = Math.max(0, Math.min(255, g));
  ddat[dstIdx + 2] = Math.max(0, Math.min(255, b));
  ddat[dstIdx + 3] = Math.max(0, Math.min(255, a));
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
