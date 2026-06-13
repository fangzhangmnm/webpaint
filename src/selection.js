// Selection —— 选区，doc 的一等公民。**不可变值对象 + mask 操作**。
//
// 设计见 CONTEXT.md (Selection) / docs/lasso-and-selection.md。给下个 AI：
//
// - 之前选区是裸结构体 { bboxX,bboxY,bboxW,bboxH, maskCanvas }，6 个 mask 操作以自由函数
//   散在 lasso.js（combineSelections / invert / extractMaskOutline / chainMaskOutline /
//   applySelectionMaskPostStroke / fill / clearSelectionOnLayer），结构体上还偷挂 _outline/_chains
//   缓存、doc.js 手动失效。全收进这个类。
// - **不可变**：构造后 bbox/maskCanvas 不再原地改；compose/invert/croppedTo/resampledTo 返回新 Selection。
//   所以 undo 只存引用、不深拷（删了 doc._cloneSelection）。outline() 懒算缓存进对象内部。
// - 纯 in-process（内存 canvas）：拿已知 mask canvas 造 Selection 即可测 compose/invert/outline /
//   applyMaskPostStroke，不碰 board/DOM。
// - 实例字段 bboxX/bboxY/bboxW/bboxH/maskCanvas 保持公开（board/filters drawImage 直接读）。
//   lasso 的自由变换/mesh gizmo 不在这里（另一个 concern，留 lasso）。

function makeBitmap(w, h) {
  return (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(w, h)
    : (() => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; })();
}

// 硬形态学（pixel-art 逻辑）：grid 上 8-连通 膨胀(grow)/腐蚀(!grow)，radius 轮。
//   每轮「先收集再应用」(double-buffer) 保证恰好 radius 像素环，不在同轮内自传播。
//   grid 外侧：膨胀时当「空」(continue)，腐蚀时当「非选区」(touch=把贴边的腐蚀掉)。
//   ← 从 lasso.js _morphMask 搬来（v242：expand/shrink 改成选区编辑 op，不再 bake 进魔术棒）。
function morphBinary(grid, w, h, radius, grow) {
  if (radius <= 0) return;
  for (let k = 0; k < radius; k++) {
    const changes = [];
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const p = row + x;
        const isAcc = grid[p] === 1;
        if (grow ? isAcc : !isAcc) continue;
        let touch = false;
        for (let dy = -1; dy <= 1 && !touch; dy++) {
          const ny = y + dy;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) { if (!grow) { touch = true; break; } continue; }
            const nAcc = grid[ny * w + nx] === 1;
            if (grow ? nAcc : !nAcc) { touch = true; break; }
          }
        }
        if (touch) changes.push(p);
      }
    }
    if (!changes.length) break;
    const val = grow ? 1 : 0;
    for (let i = 0; i < changes.length; i++) grid[changes[i]] = val;
  }
}

export class Selection {
  constructor(bboxX, bboxY, bboxW, bboxH, maskCanvas) {
    this.bboxX = bboxX; this.bboxY = bboxY;
    this.bboxW = bboxW; this.bboxH = bboxH;
    this.maskCanvas = maskCanvas;
    this._outlineChains = null;   // 懒算缓存（行军蚁 polyline）
  }

  // ---- 工厂 ----

  // 全白选区（select all / 反选-无选区 / 整层选区）。x/y 给 layer 偏移用。
  static full(docW, docH, x = 0, y = 0) {
    const w = docW | 0, h = docH | 0;
    if (w <= 0 || h <= 0) return null;
    const mask = makeBitmap(w, h);
    const mctx = mask.getContext("2d");
    mctx.fillStyle = "#fff";
    mctx.fillRect(0, 0, w, h);
    return new Selection(x, y, w, h, mask);
  }

  // ---- 组合 ----

  // 把 newSel 按 mode 合并到 oldSel（两者皆 Selection|null）。退化（空）→ null。
  //   new → 替换；union → ∪；subtract → \；intersect → ∩
  static compose(oldSel, newSel, mode) {
    if (!newSel) return oldSel;
    if (mode === "new" || !oldSel) return newSel;
    let x0, y0, x1, y1;
    if (mode === "intersect") {
      x0 = Math.max(oldSel.bboxX, newSel.bboxX);
      y0 = Math.max(oldSel.bboxY, newSel.bboxY);
      x1 = Math.min(oldSel.bboxX + oldSel.bboxW, newSel.bboxX + newSel.bboxW);
      y1 = Math.min(oldSel.bboxY + oldSel.bboxH, newSel.bboxY + newSel.bboxH);
      if (x1 <= x0 || y1 <= y0) return null;           // 不交 = 空选区
    } else {
      x0 = Math.min(oldSel.bboxX, newSel.bboxX);
      y0 = Math.min(oldSel.bboxY, newSel.bboxY);
      x1 = Math.max(oldSel.bboxX + oldSel.bboxW, newSel.bboxX + newSel.bboxW);
      y1 = Math.max(oldSel.bboxY + oldSel.bboxH, newSel.bboxY + newSel.bboxH);
      if (mode === "subtract") {
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
    // TODO（P2）：trim bbox 到 mask 实际范围。暂用合成 bbox（可能略大）
    return new Selection(x0, y0, w, h, canvas);
  }

  // 反选：在 docW×docH 上 全白 - 本选区 mask。返回新 Selection。
  invert(docW, docH) {
    const canvas = makeBitmap(docW, docH);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, docW, docH);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(this.maskCanvas, this.bboxX, this.bboxY);
    ctx.globalCompositeOperation = "source-over";
    return new Selection(0, 0, docW, docH, canvas);
  }

  // 硬形态学 扩张(radius>0)/收缩(radius<0)：选区编辑 op。返回新 Selection（或 null=收没了）。
  //   - 二值化阈值 128（与蚂蚁线 outline 的 >128 一致——选区"在不在"按半透明分界）。
  //   - 8-连通（Chebyshev/方形增长），|radius| 轮，pixel-art 逻辑（硬边，不羽化）。
  //   - 膨胀时 bbox 每边外扩 radius 并 clamp 到 doc；收缩沿用原 bbox。
  //   白边场景：魔术棒停在线稿 AA 半透明处 → 对选区 expand 几 px 钻到线下 → 填色无白边。
  morphed(radius, docW, docH) {
    const r = Math.round(radius);
    if (r === 0) return this;
    if (this.bboxW <= 0 || this.bboxH <= 0) return this;
    const grow = r > 0;
    const a = Math.abs(r);
    const pad = grow ? a : 0;
    let nx0 = this.bboxX - pad, ny0 = this.bboxY - pad;
    let nx1 = this.bboxX + this.bboxW + pad, ny1 = this.bboxY + this.bboxH + pad;
    nx0 = Math.max(0, nx0); ny0 = Math.max(0, ny0);
    nx1 = Math.min(docW, nx1); ny1 = Math.min(docH, ny1);
    const nw = nx1 - nx0, nh = ny1 - ny0;
    if (nw <= 0 || nh <= 0) return null;
    // 旧 mask → 二值网格（放进新 bbox 的对应位置）
    const srcCtx = this.maskCanvas.getContext("2d");
    const srcData = srcCtx.getImageData(0, 0, this.bboxW, this.bboxH).data;
    const grid = new Uint8Array(nw * nh);
    for (let y = 0; y < this.bboxH; y++) {
      for (let x = 0; x < this.bboxW; x++) {
        if (srcData[(y * this.bboxW + x) * 4 + 3] >= 128) {
          const gx = this.bboxX + x - nx0, gy = this.bboxY + y - ny0;
          if (gx >= 0 && gx < nw && gy >= 0 && gy < nh) grid[gy * nw + gx] = 1;
        }
      }
    }
    morphBinary(grid, nw, nh, a, grow);
    // 网格 → mask canvas（硬边 0/255）
    const m = makeBitmap(nw, nh);
    const mctx = m.getContext("2d");
    const out = mctx.createImageData(nw, nh);
    const od = out.data;
    let any = false;
    for (let i = 0; i < nw * nh; i++) {
      const al = grid[i] ? 255 : 0;
      if (al) any = true;
      od[i * 4] = 255; od[i * 4 + 1] = 255; od[i * 4 + 2] = 255; od[i * 4 + 3] = al;
    }
    if (!any) return null;          // 收缩到空 = 没选区
    mctx.putImageData(out, 0, 0);
    return new Selection(nx0, ny0, nw, nh, m);
  }

  // ---- 行军蚁描边（懒算缓存）----
  // 返回 Array<Float32Array>，每条 = 一条 polyline（doc 坐标，[x,y,x,y,...]）。board 画虚线用。
  outline() {
    if (!this._outlineChains) {
      this._outlineChains = chainMaskOutline(extractMaskOutline(this));
    }
    return this._outlineChains;
  }

  // ---- 作用到 layer（改 layer 像素，不改自身）----

  // 笔刷/橡皮/液化结束后：把 layer 在选区外的像素 revert 到 preSnap（"stroke 只在选区内生效"）。
  // per-pixel：选区外取 pre，选区内取 after。brush/eraser 都对（按 mask 选 pre/after，不是 composite）。
  applyMaskPostStroke(layer, preSnap) {
    if (!preSnap) return;
    const afterSnap = layer.snapshot();
    const px0 = preSnap.bboxX, py0 = preSnap.bboxY;
    const px1 = px0 + preSnap.bboxW, py1 = py0 + preSnap.bboxH;
    const ax0 = afterSnap.bboxX, ay0 = afterSnap.bboxY;
    const ax1 = ax0 + afterSnap.bboxW, ay1 = ay0 + afterSnap.bboxH;
    const ux0 = Math.min(px0, ax0), uy0 = Math.min(py0, ay0);
    const ux1 = Math.max(px1, ax1), uy1 = Math.max(py1, ay1);
    const uw = ux1 - ux0, uh = uy1 - uy0;
    if (uw <= 0 || uh <= 0) return;

    let maskData = null;
    if (this.bboxW > 0 && this.bboxH > 0) {
      const mctx = this.maskCanvas.getContext("2d");
      maskData = mctx.getImageData(0, 0, this.bboxW, this.bboxH).data;
    }
    const preData = preSnap.imageData ? preSnap.imageData.data : null;
    const afterData = afterSnap.imageData ? afterSnap.imageData.data : null;

    const out = new ImageData(uw, uh);
    const odata = out.data;
    for (let y = 0; y < uh; y++) {
      for (let x = 0; x < uw; x++) {
        const docX = ux0 + x, docY = uy0 + y;
        let maskAlpha = 0;
        const mx = docX - this.bboxX, my = docY - this.bboxY;
        if (maskData && mx >= 0 && mx < this.bboxW && my >= 0 && my < this.bboxH) {
          maskAlpha = maskData[(my * this.bboxW + mx) * 4 + 3];
        }
        const oi = (y * uw + x) * 4;
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
    layer.ensureBbox(ux0, uy0, ux1, uy1);
    layer.ctx.putImageData(out, ux0 - layer.bboxX, uy0 - layer.bboxY);
  }

  // 选区内填色（调用方负责 push history）。
  fillOnLayer(layer, color) {
    if (!layer) return;
    layer.ensureBbox(this.bboxX, this.bboxY, this.bboxX + this.bboxW, this.bboxY + this.bboxH);
    const tmp = makeBitmap(this.bboxW, this.bboxH);
    const tctx = tmp.getContext("2d");
    tctx.fillStyle = color;
    tctx.fillRect(0, 0, this.bboxW, this.bboxH);
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(this.maskCanvas, 0, 0);
    tctx.globalCompositeOperation = "source-over";
    layer.ctx.drawImage(tmp, this.bboxX - layer.bboxX, this.bboxY - layer.bboxY);
  }

  // 清除选区内像素（dst-out mask）。
  clearOnLayer(layer) {
    if (!layer) return;
    const lctx = layer.ctx;
    lctx.save();
    lctx.globalCompositeOperation = "destination-out";
    lctx.drawImage(this.maskCanvas, this.bboxX - layer.bboxX, this.bboxY - layer.bboxY);
    lctx.restore();
  }

  // ---- crop / resample 时变换自身 → 新 Selection（doc.cropTo/resampleTo 用）----

  // 裁剪：doc 原点平移 (dx,dy)，新画布 nw×nh。clamp 到画布内，全裁掉 → null。
  croppedTo(dx, dy, nw, nh) {
    const tL = this.bboxX - dx, tT = this.bboxY - dy;
    const tR = tL + this.bboxW, tB = tT + this.bboxH;
    const newL = Math.max(0, tL), newT = Math.max(0, tT);
    const newR = Math.min(nw, tR), newB = Math.min(nh, tB);
    const newW = newR - newL, newH = newB - newT;
    if (newW <= 0 || newH <= 0) return null;
    const srcX = newL - tL, srcY = newT - tT;
    const m = makeBitmap(newW, newH);
    m.getContext("2d").drawImage(this.maskCanvas, srcX, srcY, newW, newH, 0, 0, newW, newH);
    return new Selection(newL, newT, newW, newH, m);
  }

  // 水平翻转：mask 左右镜像，bbox 在 docW 内镜像。返回新 Selection。
  flippedHorizontal(docW) {
    const m = makeBitmap(this.bboxW, this.bboxH);
    const mctx = m.getContext("2d");
    mctx.setTransform(-1, 0, 0, 1, this.bboxW, 0);
    mctx.drawImage(this.maskCanvas, 0, 0);
    return new Selection(docW - (this.bboxX + this.bboxW), this.bboxY, this.bboxW, this.bboxH, m);
  }

  // 重采样：mask 同步缩放 (sx,sy)。
  resampledTo(sx, sy, smooth, quality) {
    const oW = this.bboxW, oH = this.bboxH;
    const nbw = Math.max(1, Math.round(oW * sx));
    const nbh = Math.max(1, Math.round(oH * sy));
    const m = makeBitmap(nbw, nbh);
    const mctx = m.getContext("2d");
    mctx.imageSmoothingEnabled = smooth;
    mctx.imageSmoothingQuality = quality;
    mctx.drawImage(this.maskCanvas, 0, 0, oW, oH, 0, 0, nbw, nbh);
    return new Selection(Math.round(this.bboxX * sx), Math.round(this.bboxY * sy), nbw, nbh, m);
  }
}

// ============ 内部：marching squares 描边 ============

// 从 maskCanvas 抽轮廓 polyline 段。输出 Float32Array 平铺 [x0,y0,x1,y1,...]（doc 坐标）。
// O(bboxW×bboxH)，一次性（outline() 缓存）。
function extractMaskOutline(sel) {
  const w = sel.bboxW, h = sel.bboxH;
  if (w <= 1 || h <= 1) return new Float32Array(0);
  const ctx = sel.maskCanvas.getContext("2d");
  const data = ctx.getImageData(0, 0, w, h).data;
  const segs = [];
  // v113: virtual padding —— canvas 外侧一圈 alpha=0，让 mask 占满边时也能 detect transition。
  const alpha = (x, y) => (x < 0 || x >= w || y < 0 || y >= h) ? 0 : (data[(y * w + x) * 4 + 3] > 128 ? 1 : 0);
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const a00 = alpha(x, y), a10 = alpha(x + 1, y), a01 = alpha(x, y + 1), a11 = alpha(x + 1, y + 1);
      const idx = a00 | (a10 << 1) | (a11 << 2) | (a01 << 3);
      if (idx === 0 || idx === 15) continue;
      const cxL = Math.max(0, Math.min(w, x)), cxR = Math.max(0, Math.min(w, x + 1));
      const cyT = Math.max(0, Math.min(h, y)), cyB = Math.max(0, Math.min(h, y + 1));
      const xL = sel.bboxX + cxL, xR = sel.bboxX + cxR, xM = (xL + xR) / 2;
      const yT = sel.bboxY + cyT, yB = sel.bboxY + cyB, yM = (yT + yB) / 2;
      switch (idx) {
        case 1:  segs.push(xM, yT, xL, yM); break;
        case 2:  segs.push(xM, yT, xR, yM); break;
        case 3:  segs.push(xL, yM, xR, yM); break;
        case 4:  segs.push(xR, yM, xM, yB); break;
        case 5:  segs.push(xM, yT, xR, yM); segs.push(xM, yB, xL, yM); break;
        case 6:  segs.push(xM, yT, xM, yB); break;
        case 7:  segs.push(xM, yB, xL, yM); break;
        case 8:  segs.push(xL, yM, xM, yB); break;
        case 9:  segs.push(xM, yT, xM, yB); break;
        case 10: segs.push(xM, yT, xL, yM); segs.push(xR, yM, xM, yB); break;
        case 11: segs.push(xR, yM, xM, yB); break;
        case 12: segs.push(xL, yM, xR, yM); break;
        case 13: segs.push(xM, yT, xR, yM); break;
        case 14: segs.push(xM, yT, xL, yM); break;
      }
    }
  }
  return new Float32Array(segs);
}

// 把碎段链成连续 polyline（dash 才能沿整条边流，否则每段当 subpath dash 重置）。
function chainMaskOutline(segs) {
  const out = [];
  if (segs.length < 4) return out;
  const n = segs.length / 4;
  const key = (x, y) => `${Math.round(x * 2)},${Math.round(y * 2)}`;
  const endpoints = new Map();
  for (let i = 0; i < n; i++) {
    const k0 = key(segs[i * 4], segs[i * 4 + 1]);
    const k1 = key(segs[i * 4 + 2], segs[i * 4 + 3]);
    if (!endpoints.has(k0)) endpoints.set(k0, []);
    if (!endpoints.has(k1)) endpoints.set(k1, []);
    endpoints.get(k0).push(i * 2);
    endpoints.get(k1).push(i * 2 + 1);
  }
  const used = new Uint8Array(n);
  const findUnused = (k) => {
    const arr = endpoints.get(k);
    if (!arr) return -1;
    for (const slot of arr) if (!used[slot >> 1]) return slot;
    return -1;
  };
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const chain = [segs[i * 4], segs[i * 4 + 1], segs[i * 4 + 2], segs[i * 4 + 3]];
    while (true) {
      const ex = chain[chain.length - 2], ey = chain[chain.length - 1];
      const slot = findUnused(key(ex, ey));
      if (slot < 0) break;
      const segIdx = slot >> 1; used[segIdx] = 1; const si = segIdx * 4;
      if (slot & 1) chain.push(segs[si], segs[si + 1]);
      else          chain.push(segs[si + 2], segs[si + 3]);
    }
    while (true) {
      const sx = chain[0], sy = chain[1];
      const slot = findUnused(key(sx, sy));
      if (slot < 0) break;
      const segIdx = slot >> 1; used[segIdx] = 1; const si = segIdx * 4;
      if (slot & 1) chain.unshift(segs[si], segs[si + 1]);
      else          chain.unshift(segs[si + 2], segs[si + 3]);
    }
    out.push(new Float32Array(chain));
  }
  return out;
}
