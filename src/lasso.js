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
    this._state = "idle";    // idle | drawing | floating
    this._points = [];
    this._floating = null;
    this._drag = null;       // { kind: "translate" | "corner" | "edge" | "warp-point", ... }
    this.onChange = () => {};
  }

  // -------- 选区路径 --------
  beginPath(x, y) {
    this._state = "drawing";
    this._points = [{ x, y }];
    this.onChange();
  }
  extendPath(x, y) {
    if (this._state !== "drawing") return;
    const p = this._points[this._points.length - 1];
    if (p && Math.abs(p.x - x) < 1 && Math.abs(p.y - y) < 1) return;
    this._points.push({ x, y });
    this.onChange();
  }
  // 闭合 + lift。返回 true = 成功 lift。
  endPath(layer) {
    if (this._state !== "drawing") return false;
    const pts = this._points;
    this._points = [];
    if (pts.length < 3) { this._state = "idle"; this.onChange(); return false; }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const lbX = layer.bboxX, lbY = layer.bboxY, lbW = layer.bboxW, lbH = layer.bboxH;
    const x0 = Math.max(lbX, Math.floor(minX));
    const y0 = Math.max(lbY, Math.floor(minY));
    const x1 = Math.min(lbX + lbW, Math.ceil(maxX));
    const y1 = Math.min(lbY + lbH, Math.ceil(maxY));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) { this._state = "idle"; this.onChange(); return false; }

    const preSnap = layer.snapshot();

    // mask
    const maskCanvas = makeBitmap(w, h);
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

    // floating canvas = layer ∩ mask
    const floating = makeBitmap(w, h);
    const fctx = floating.getContext("2d");
    fctx.drawImage(layer.canvas, x0 - lbX, y0 - lbY, w, h, 0, 0, w, h);
    fctx.globalCompositeOperation = "destination-in";
    fctx.drawImage(maskCanvas, 0, 0);
    fctx.globalCompositeOperation = "source-over";

    // 挖空 layer
    const lctx = layer.ctx;
    lctx.save();
    lctx.globalCompositeOperation = "destination-out";
    lctx.drawImage(maskCanvas, x0 - lbX, y0 - lbY);
    lctx.restore();

    // mesh: 2×2 对齐到 src bbox（doc 坐标）
    this._floating = {
      canvas: floating,
      srcW: w, srcH: h,
      layer, preSnap,
      mode: "free",
      meshN: 2,
      mesh: [
        [{ x: x0,     y: y0     }, { x: x0 + w, y: y0     }],
        [{ x: x0,     y: y0 + h }, { x: x0 + w, y: y0 + h }],
      ],
      uniformAspect: w / Math.max(1, h),
    };
    this._state = "floating";
    this.onChange();
    return true;
  }

  // -------- 模式切换 --------
  setMode(mode) {
    const f = this._floating;
    if (!f) return;
    if (mode === f.mode) return;
    // free / uniform / distort 间切换：mesh 是 2×2 → 不变
    // 切去 warp：升采样 2×2 → 3×3
    // 切回 2×2 模式（从 warp）：取 4 角，丢中间 5 点
    if (mode === "warp" && f.meshN === 2) {
      f.mesh = upsampleMesh2to3(f.mesh);
      f.meshN = 3;
    } else if (mode !== "warp" && f.meshN === 3) {
      f.mesh = downsampleMesh3to2(f.mesh);
      f.meshN = 2;
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
    // 优先 mesh 控制点（按 mode 决定哪些点暴露）。半径 = 10 / screenScale doc-px
    const r = 10 / screenScale;
    const handles = this._visibleHandles();
    for (const h of handles) {
      const dx = x - h.pos.x, dy = y - h.pos.y;
      if (dx * dx + dy * dy < r * r) return h;
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
    }
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
    // 直接画到 layer 的 ctx（doc 坐标 - layer.bbox 偏移）
    layer.ctx.save();
    layer.ctx.translate(-lbX, -lbY);
    drawMesh(layer.ctx, f.canvas, f.srcW, f.srcH, f.mesh);
    layer.ctx.restore();

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
  getDrawingPath() { return this._state === "drawing" ? this._points : null; }
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
    const out = [];
    if (f.meshN === 2) {
      // 4 角
      const m = f.mesh;
      out.push({ kind: "corner", row: 0, col: 0, pos: m[0][0] });
      out.push({ kind: "corner", row: 0, col: 1, pos: m[0][1] });
      out.push({ kind: "corner", row: 1, col: 0, pos: m[1][0] });
      out.push({ kind: "corner", row: 1, col: 1, pos: m[1][1] });
      // 4 边中点（free/uniform 才暴露；distort 不暴露 —— 用 4 角自由就够了）
      if (f.mode !== "distort") {
        out.push({ kind: "edge", edge: "top",    pos: mid(m[0][0], m[0][1]) });
        out.push({ kind: "edge", edge: "right",  pos: mid(m[0][1], m[1][1]) });
        out.push({ kind: "edge", edge: "bottom", pos: mid(m[1][0], m[1][1]) });
        out.push({ kind: "edge", edge: "left",   pos: mid(m[0][0], m[1][0]) });
      }
    } else {
      // 3×3 = 9 个 warp 点
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        out.push({ kind: "warp-point", row: i, col: j, pos: f.mesh[i][j] });
      }
    }
    return out;
  }

  _pointInQuad(x, y) {
    const f = this._floating;
    if (!f) return false;
    if (f.meshN === 2) {
      // 4 角四边形点内检测（winding-test on the 4-corner quad）
      const m = f.mesh;
      const poly = [m[0][0], m[0][1], m[1][1], m[1][0]];
      return pointInPoly(poly, x, y);
    } else {
      // 3×3：用 4 角包络（最简单，准确性够用）
      const m = f.mesh;
      const poly = [m[0][0], m[0][2], m[2][2], m[2][0]];
      return pointInPoly(poly, x, y);
    }
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
    // uniform 模式：锁长宽比 = f.uniformAspect = |ax|/|ay|。
    // 用主导轴决定新 scale，另一轴按比例跟随。"主导"= 相对变化量大的那个轴。
    if (f.mode === "uniform") {
      const origLenAx = Math.hypot(origAx.x, origAx.y);
      const origLenAy = Math.hypot(origAy.x, origAy.y);
      const sX = origLenAx > 1e-6 ? lenAx / origLenAx : 1;
      const sY = origLenAy > 1e-6 ? lenAy / origLenAy : 1;
      const s = Math.abs(sX) >= Math.abs(sY) ? sX : sY;
      lenAx = s * origLenAx;
      lenAy = s * origLenAy;
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

function upsampleMesh2to3(m) {
  // 2×2 → 3×3：4 角保留，4 个边中点 + 1 个中心新增
  const tl = m[0][0], tr = m[0][1], bl = m[1][0], br = m[1][1];
  return [
    [{ ...tl }, mid(tl, tr), { ...tr }],
    [mid(tl, bl), midOfFour(tl, tr, bl, br), mid(tr, br)],
    [{ ...bl }, mid(bl, br), { ...br }],
  ];
}
function downsampleMesh3to2(m) {
  return [
    [{ ...m[0][0] }, { ...m[0][2] }],
    [{ ...m[2][0] }, { ...m[2][2] }],
  ];
}
function midOfFour(a, b, c, d) {
  return { x: (a.x + b.x + c.x + d.x) / 4, y: (a.y + b.y + c.y + d.y) / 4 };
}

// ============ 三角剖分 mesh 渲染 ============
// export 给 board.js 也用同一份代码画 floating 浮层
//
// 渲染策略：mesh 切成 (N-1)×(N-1) 个 cell；每 cell 切 2 个三角。
// 对每三角：src 三角（pixel 空间）→ dst 三角（doc 空间）的 affine drawImage。
// 单元 (i,j) 的 cell 4 角：
//   src: (j/(N-1)*srcW, i/(N-1)*srcH) 配对 4 角的 mesh 索引
//   dst: f.mesh[i][j], [i][j+1], [i+1][j], [i+1][j+1]
// 三角化：tri1 = [TL, TR, BL], tri2 = [TR, BR, BL]
export function drawMesh(ctx, srcCanvas, srcW, srcH, mesh) {
  const N = mesh.length;
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < N - 1; j++) {
      const sxL = j     * srcW / (N - 1);
      const sxR = (j + 1) * srcW / (N - 1);
      const syT = i     * srcH / (N - 1);
      const syB = (i + 1) * srcH / (N - 1);
      const dTL = mesh[i][j],     dTR = mesh[i][j + 1];
      const dBL = mesh[i + 1][j], dBR = mesh[i + 1][j + 1];
      drawTextureTri(ctx, srcCanvas,
        sxL, syT, sxR, syT, sxL, syB,
        dTL.x, dTL.y, dTR.x, dTR.y, dBL.x, dBL.y);
      drawTextureTri(ctx, srcCanvas,
        sxR, syT, sxR, syB, sxL, syB,
        dTR.x, dTR.y, dBR.x, dBR.y, dBL.x, dBL.y);
    }
  }
}

// 把源图的一个三角形（在 src 像素坐标里）映射到 dst 三角形（在当前 ctx 坐标里）
// 通过 ctx.transform 设 affine（src → dst）+ ctx.clip 限范围 + ctx.drawImage 整张源。
// 标准 Canvas2D texture-mapping 技巧；O(三角形像素面积) GPU 复合。
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
