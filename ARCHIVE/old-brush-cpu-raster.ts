// ARCHIVE —— brush CPU 栅格路径（v351/2026-06-28 从 src/brush.ts 摘除）。
//
// 这是参考件，**不编译、不打包**（不在 tsconfig include、无人 import）。WebGL board 转默认后
// （v350），GL 模式下 brush live+commit 全走 GPU（collectStamps→GLStampRasterizer），下列 CPU
// 栅格函数全死（#2/v349 已在 GL 模式弃用，#3/v351 删之）。完整原文见 git: `git show v350:src/brush.ts`
// （commit fa9dab5，最后一个 CPU 栅格仍 live 的版本）。
//
// 删除的函数（按职责）：
//   - _getStamp / _stampCache：Build-Up colored stamp 预渲染缓存（baseSize 烤一次，drawImage 缩放）。
//   - _emitFrozen + _ensureBufferBbox + _growRect：把已冻结中心线段烤进 frozen buffer（wash Uint8 / buildup canvas）。
//   - _washMaxInto / _buildupOverInto：单颗 stamp 解析 falloff 累积进 buffer（wash=max / buildup=over）。
//   - _renderWashToCanvas / _compositeBufferToLayer：抬笔把 buffer 合成成 RGBA canvas → commit 进 layer。
//   - _renderTail / _ensureTailBbox / _composeOverlay / _blitFrozen / _blitTail：每帧 live overlay = frozen ⊕ tail。
//
// ★ #4 GPU frozen/tail 缓存的 SPEC：下面 _renderTail + _composeOverlay + _blitFrozen/_blitTail 的
//   「frozen buffer（已定 stamp 累积）+ 每帧只重画 tail（前沿→笔尖）」双 buffer 思路，正是 #4 要在 GPU
//   上复刻的（持久 frozen overlay FBO 累积已定 stamp，每帧只把新 tail 画上去），故 verbatim 留底参考。
//
// ─────────────────────────────────────────────────────────────────────────────
// 以下为 v350 src/brush.ts 原文（StrokeState 的 frozen/tail/overlay buffer 字段亦随之删除）：

/*
// 每帧重画 tail（frozen 前沿 → 笔尖）。两趟：先收集 stamp 算 bbox，再 ensure buffer + 光栅化。
_renderTail() {
  const st = this._stroke!;
  const sm = st.sm!;
  sm.update();                                // 确保 C 最新（begin 后首帧也对）
  const last = sm.count - 1;
  if (last < 0) { st.tailW = 0; st.tailH = 0; return; }
  // tail walk = frozenWalk 的临时拷贝（不动真游标）
  const walk = {
    ci: st.frozenWalk.ci, started: st.frozenWalk.started,
    accumDist: st.frozenWalk.accumDist, lastP: st.frozenWalk.lastP,
    strokeDist: st.frozenWalk.strokeDist,
  };
  // 1) 收集 tail stamp（culling doc 外）
  const stamps = [];
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  this._walkStamps(walk, last, (x, y, p, sd) => {
    const params = this._stampParams(p, sd);
    if (!params) return;
    const { size, stampAlpha } = params;
    const r = size / 2;
    const sx0 = x - r - 1, sy0 = y - r - 1, sx1 = x + r + 1, sy1 = y + r + 1;
    if (sx1 < 0 || sy1 < 0 || sx0 > st.layer.docW || sy0 > st.layer.docH) return;
    stamps.push({ x, y, size, stampAlpha });
    if (sx0 < bx0) bx0 = sx0; if (sy0 < by0) by0 = sy0;
    if (sx1 > bx1) bx1 = sx1; if (sy1 > by1) by1 = sy1;
  });
  if (!stamps.length) { st.tailW = 0; st.tailH = 0; return; }
  // doc 坐标 tail bbox（整数化 + clamp 到 doc，和 frozen buffer 的 clamp 一致 → overlay 不越界）
  const tx = Math.max(0, Math.floor(bx0));
  const ty = Math.max(0, Math.floor(by0));
  const tx1 = Math.min(st.layer.docW, Math.ceil(bx1));
  const ty1 = Math.min(st.layer.docH, Math.ceil(by1));
  const tw = tx1 - tx, th = ty1 - ty;
  if (tw <= 0 || th <= 0) { st.tailW = 0; st.tailH = 0; return; }
  st.tailX = tx; st.tailY = ty; st.tailW = tw; st.tailH = th;
  // overlay 必须覆盖 tail → 把 frozen bbox 预扩到含 tail（frozen buffer 那块为 0，无害）
  this._ensureBufferBbox(tx, ty, tx + tw, ty + th);
  // 2) ensure tail buffer + 清 + 光栅
  this._ensureTailBbox(tw, th);
  if (st.isBuildup) {
    st.tailCtx!.clearRect(0, 0, tw, th);
    for (const s of stamps) this._buildupOverInto(st.tailCtx!, tx, ty, s.x, s.y, s.size, s.stampAlpha);
  } else {
    st.tailData!.fill(0, 0, tw * th);
    for (const s of stamps) this._washMaxInto(st.tailData!, tw, th, tx, ty, s.x, s.y, s.size, s.stampAlpha);
  }
  this._markDirty(tx, ty, tx + tw, ty + th);
}

// 合成 overlay = frozen ⊕ tail（wash:max / buildup:over）。只补 (prevTail ∪ frozenDirty) 与 tail 区。
_composeOverlay() {
  const st = this._stroke!;
  const W = st.bufBboxW, H = st.bufBboxH;
  if (W <= 0 || H <= 0) return;
  let rebuilt = false;
  if (!st.overlayCanvas) {
    st.overlayCanvas = document.createElement("canvas");
    st.overlayCanvas.width = W; st.overlayCanvas.height = H;
    st.overlayCtx = st.overlayCanvas.getContext("2d")!;
    rebuilt = true;
  } else if (st.overlayCanvas.width !== W || st.overlayCanvas.height !== H) {
    st.overlayCanvas.width = W; st.overlayCanvas.height = H;
    rebuilt = true;
  }
  if (rebuilt) {
    this._blitFrozen(0, 0, W, H);                 // 全幅刷 frozen
    st.prevTailW = 0; st.frozenDirty = null;
  } else {
    // 还原 (上帧 tail ∪ 新冻结) 区域为纯 frozen
    let r = null;
    if (st.prevTailW > 0) r = [st.prevTailX, st.prevTailY, st.prevTailX + st.prevTailW, st.prevTailY + st.prevTailH];
    if (st.frozenDirty) {
      const d = st.frozenDirty;
      r = r ? [Math.min(r[0], d[0]), Math.min(r[1], d[1]), Math.max(r[2], d[2]), Math.max(r[3], d[3])] : d.slice();
    }
    if (r) {
      const lx0 = Math.max(0, Math.floor(r[0] - st.bufBboxX));
      const ly0 = Math.max(0, Math.floor(r[1] - st.bufBboxY));
      const lx1 = Math.min(W, Math.ceil(r[2] - st.bufBboxX));
      const ly1 = Math.min(H, Math.ceil(r[3] - st.bufBboxY));
      if (lx1 > lx0 && ly1 > ly0) this._blitFrozen(lx0, ly0, lx1 - lx0, ly1 - ly0);
    }
    st.frozenDirty = null;
  }
  // tail 叠上去（已 ensure bufBbox ⊇ tail）
  if (st.tailW > 0) {
    const lx = st.tailX - st.bufBboxX, ly = st.tailY - st.bufBboxY;
    this._blitTail(lx, ly);
  }
  st.prevTailX = st.tailX; st.prevTailY = st.tailY;
  st.prevTailW = st.tailW; st.prevTailH = st.tailH;
}

// _blitFrozen(lx,ly,lw,lh)：frozen buffer 局部 → overlay（替换，frozen 权威）。wash 把 Uint8 α + color 转 RGBA。
// _blitTail(lx,ly)：tail 叠到 overlay。wash = max(frozen,tail)（Alpha Darken）；buildup = tail over frozen。
// （完整两函数 + _emitFrozen/_washMaxInto/_buildupOverInto/_ensureBufferBbox/_getStamp 见 git show v350:src/brush.ts）
*/
