// ARCHIVE —— board 的 2D Canvas display 路径（v351/2026-06-28 从 src/board.ts 摘除）。
//
// 参考件，**不编译、不打包**。GL board 转唯一 display 路径后（v351），下列 2D 直接合成/缓存 blit 全死。
// 完整原文见 git: `git show v350:src/board.ts`（commit fa9dab5）。
//
// **注意——没删的（仍活，给吸管/导出/缩略图）**：`ensureCompositeCache`（1:1 doc 合成缓存，吸管 composite
//   取色 input.ts:_pickAt 读它）、`_layerCompositeOpts`/`_drawDocBg`/`_drawCheckerboard`/`_getClipTmp`/
//   `_getEraseComposite`、`compositeLayers`(layer-composite.ts)。这些「长在 2D 分支旁」但是 CPU 合成工具，非 display。
//
// 删除的（纯 2D display）：_renderFull 的 2D 分支体 + _renderLayers + _blitCompositeCache。
//
// ─────────────────────────────────────────────────────────────────────────────
/*
// _renderFull 的 2D 分支（GL 不可用时的旧 display）：
//   底色 fillRect(void) → _applyDocTransform → scale>1 时 nearest-neighbor →
//   live: _drawDocBg + _renderLayers（直接合成保手感）/ static: _blitCompositeCache（1:1 缓存缩放 blit，白边修）→
//   _drawLassoOverlay + doc 边框。

_renderLayers(ctx) {
  compositeLayers(ctx, this.doc.layers, this._layerCompositeOpts());   // 实时直接合成到屏
}

_blitCompositeCache(ctx) {
  const off = this.ensureCompositeCache();   // 1:1 doc 合成缓存（层间整数对齐，无亚像素缝）
  ctx.drawImage(off, 0, 0);                  // ctx 已在 doc 坐标 → 单次缩放 blit
}
*/
