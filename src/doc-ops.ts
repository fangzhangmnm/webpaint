// 职责（单一）：文档级变换 op —— 裁切（裁到选区 / 自由 8-handle）、水平翻转、重采样（调整尺寸）。
// 共同脊柱 runDocTransform：before 快照 → 改 doc(+viewport shift) → after 快照 → 压 docTransform。
// 守卫（无选区/尺寸非法/没变化）留调用方。crop/resample 是 EditMode transient（enter/apply/cancel 走 editMode）。
//
// 旧 app.js 的 v110/114 crop / resample / adjust 区里**纯文档变换**的部分全搬来（filter/调色 panel 不属本类）。
// app.js 短路成：import { initDocOps, _updateMenuCropLabel } + setRuntime 后调 initDocOps()。

import { els } from "./els.ts";
import { bumpDoc } from "./signals.ts";
import { resizeCropRect, cropRectToInts } from "./crop-geometry.js";

// ctx 绑入：core 单例
let editMode: any, doc: any, board: any, history: any, setStatus: any;
// 命令 = 拥有它的模块的接口（显式 import，不经 ctx）
import { setMenuOpen } from "./settings-menu.ts";
import { setAdjustOpen } from "./filters-adjust.ts";
// ctx 绑入：仍在 app.js 的编排件（app-local function）
let _suppressTransientPanels: any, _restoreTransientPanels: any;

// ===== v110/114 crop / resample / adjust =====
// 通用：op 前先 commit floating + 把当前 doc + viewport snapshot 当 before
function _captureDocBefore() {
  editMode.applyPendingTransient();
  return { doc: doc.snapshotAll(), viewport: { ...board.viewport } };
}
function _captureDocAfter() {
  return { doc: doc.snapshotAll(), viewport: { ...board.viewport } };
}
function _pushDocTransform(before: any, after: any, label: string) {
  history.push({ type: "docTransform", before, after });   // history.push 同步派 wp:histchange → 编辑门已标游标+云脏（无需再标）
  if (els.canvasSizeLabel) els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
  board.invalidateAll();
  bumpDoc();
  setStatus(label);
}

// 文档变换的提交信封：把「before 快照 → 改 doc → after 快照 → 压 docTransform」这条
// 四处重复的脊柱收一处。结构上保证不会漏掉 undo 事务（漏了 = 这步静默不可撤销）。
// 守卫（无选区/尺寸非法/没变化）留在调用方——helper 只管「已决定要做」的那次变换的提交。
// applyFn 内改 doc + 可选 viewport shift（必须在 after 快照前完成，故放进 applyFn）。
export function runDocTransform(label: string, applyFn: () => void) {
  const before = _captureDocBefore();
  applyFn();
  const after = _captureDocAfter();
  _pushDocTransform(before, after, label);
}

// v114: 裁切后让原 (rect.x, rect.y) 像素在屏上不挪 → viewport.tx/ty 减去 (rect.x, rect.y) × scale
// 数学：old 屏位 = old_tx + rect.x × scale；new 屏位 = new_tx + 0 × scale = new_tx
// 要等 → new_tx = old_tx + rect.x × scale
function _shiftViewportAfterCrop(rect: any) {
  const v = board.viewport;
  v.tx = v.tx + rect.x * v.scale;
  v.ty = v.ty + rect.y * v.scale;
}

// 自由裁切（8-handle）----
let _cropState: any = null;     // { rect:{x,y,w,h} in doc, drag:'nw'|'n'|'ne'|...|'move'|null, startMouse, startRect }
function _docRectToScreen(r: any) {
  const { tx, ty, scale } = board.viewport;
  return { x: r.x * scale + tx, y: r.y * scale + ty, w: r.w * scale, h: r.h * scale };
}
function _renderCropOverlay() {
  if (!_cropState) return;
  const r = _docRectToScreen(_cropState.rect);
  const el = document.getElementById("cropRect")!;
  el.style.left = r.x + "px";
  el.style.top  = r.y + "px";
  el.style.width  = Math.max(2, r.w) + "px";
  el.style.height = Math.max(2, r.h) + "px";
  // L69：实时显示裁切后分辨率（doc 像素，非屏幕）
  const dim = document.getElementById("cropDim");
  if (dim) dim.textContent = `${Math.round(_cropState.rect.w)} × ${Math.round(_cropState.rect.h)}`;
}
function _openCropMode() {
  // v154 (user)：自由裁切要求 rot=0（裁切框是屏幕轴对齐 DOM，doc 旋转会错位）。
  //   以前弹提示让用户手动按 0；改成自动复位旋转（保 zoom/位置，只归零 rot），直接进。
  if (board.viewport.rot && Math.abs(board.viewport.rot) > 0.01) {
    board.setViewport(board.viewport.tx, board.viewport.ty, board.viewport.scale, 0);
    setStatus("已复位画布旋转以进入自由裁切");
  }
  _cropState = {
    rect: { x: 0, y: 0, w: doc.width, h: doc.height },
    drag: null, startMouse: null, startRect: null,
  };
  document.getElementById("cropOverlay")!.classList.remove("hidden");
  document.getElementById("cropToolbar")!.classList.remove("hidden");
  _renderCropOverlay();
  _suppressTransientPanels("crop");
  // crop transient：apply/abort 都 = 丢弃裁切框（真裁只走 Apply 按钮）。决定性动作/ctrl-z 不会误裁。
  editMode.enterTransient("crop", { apply: _closeCropMode, abort: _closeCropMode });
}
function _closeCropMode() {
  _cropState = null;
  document.getElementById("cropOverlay")!.classList.add("hidden");
  document.getElementById("cropToolbar")!.classList.add("hidden");
  _restoreTransientPanels();
  editMode.exitTransient();   // sync 点：任何关闭路径（按钮/decisive）都清 EditMode 的 transient
}

export function _updateMenuCropLabel() {
  const lbl = document.getElementById("menuCropLabel");
  if (!lbl) return;
  lbl.textContent = doc.selection ? "裁切到选区" : "裁切（自由）";
}

// 重采样对话框 ----
function _openResampleDialog() {
  els.resampleBackdrop.classList.remove("hidden");
  els.resampleSheet.classList.remove("hidden");
  els.resampleW.value = String(doc.width);
  els.resampleH.value = String(doc.height);
  els.resampleW.focus();
  // 锁比例：变 W 自动改 H
  const aspect = doc.width / doc.height;
  const onW = () => {
    if (!els.resampleLock.checked) return;
    const w = parseFloat(els.resampleW.value) | 0;
    if (w > 0) els.resampleH.value = String(Math.max(1, Math.round(w / aspect)));
  };
  const onH = () => {
    if (!els.resampleLock.checked) return;
    const h = parseFloat(els.resampleH.value) | 0;
    if (h > 0) els.resampleW.value = String(Math.max(1, Math.round(h * aspect)));
  };
  els.resampleW.oninput = onW;
  els.resampleH.oninput = onH;
}
function _closeResampleDialog() {
  els.resampleBackdrop.classList.add("hidden");
  els.resampleSheet.classList.add("hidden");
}

export function initDocOps(ctx) {
  ({ editMode, doc, board, history, setStatus,
     _suppressTransientPanels, _restoreTransientPanels } = ctx);

  // 裁到选区 ----
  document.getElementById("adjustCropToSelection")!.addEventListener("click", () => {
    setMenuOpen(false);
    setAdjustOpen(false);
    if (!doc.selection) { setStatus("没选区——画一个 lasso 选区先", true); return; }
    const s = doc.selection;
    const x = Math.max(0, s.bboxX | 0), y = Math.max(0, s.bboxY | 0);
    const w = Math.min(doc.width - x, s.bboxW | 0), h = Math.min(doc.height - y, s.bboxH | 0);
    if (w < 1 || h < 1) { setStatus("选区太小或在画布外", true); return; }
    runDocTransform(`已裁到选区：${w}×${h}`, () => {
      doc.cropTo({ x, y, w, h });
      _shiftViewportAfterCrop({ x, y });
    });
  });

  // crop 时画布 pan/zoom（两指 / 滚轮）→ rect SSoT 是 doc 坐标，重投影到屏幕跟随 viewport
  board.onViewportChange = () => { if (_cropState) _renderCropOverlay(); };

  document.getElementById("adjustCropFree")!.addEventListener("click", () => {
    setMenuOpen(false);
    setAdjustOpen(false);
    _openCropMode();
  });

  // v124 合并裁切入口：有选区 → 裁到选区；无选区 → 自由裁切。label 在 setMenuOpen(true) 时动态切
  const _menuCropBtn = document.getElementById("menuCrop");
  if (_menuCropBtn) {
    _menuCropBtn.addEventListener("click", () => {
      if (doc.selection) (document.getElementById("adjustCropToSelection") as HTMLElement).click();
      else                (document.getElementById("adjustCropFree") as HTMLElement).click();
    });
  }

  // 水平翻转整个画布（所有层 + 选区）。一次 docTransform op，可撤销。
  const _menuFlipHBtn = document.getElementById("menuFlipH");
  if (_menuFlipHBtn) {
    _menuFlipHBtn.addEventListener("click", () => {
      setMenuOpen(false);
      setAdjustOpen(false);
      runDocTransform("已水平翻转", () => doc.flipHorizontal());
    });
  }

  document.getElementById("cropToolbarCancel")!.addEventListener("click", () => _closeCropMode());
  document.getElementById("cropToolbarApply")!.addEventListener("click", () => {
    if (!_cropState) return;
    // v127 (user：「裁切还可以扩张」)：允许 x/y 负（向左/向上扩），允许 w/h > doc（向右/向下扩）
    //   只保最小 1 + 最大 8192；doc.cropTo 已支持负 dx/dy
    const { x, y, w, h } = cropRectToInts(_cropState.rect, { min: 1, max: 8192 });
    runDocTransform(`已裁切：${w}×${h}`, () => {
      doc.cropTo({ x, y, w, h });
      _shiftViewportAfterCrop({ x, y });
    });
    _closeCropMode();
  });

  // 裁切 overlay 拖拽 (handle / rect 内 = move)
  (function bindCropOverlayPointer() {
    const overlay = document.getElementById("cropOverlay")!;
    overlay.addEventListener("pointerdown", (e: any) => {
      if (!_cropState) return;
      e.preventDefault();
      e.stopPropagation();
      // v125 (user：「crop 的时候 选区不应该点击空白时可拖动，只有拖动 handler 才行」)
      //   只有 [data-handle] 命中才进 drag；rect 内空白 → no-op（防误碰整体移动）
      const handle = e.target?.dataset?.handle || null;
      if (!handle) return;
      // 捕获在 handle 上（overlay 现在 pointer-events:none，捕在它身上不稳）。pointerup 自动释放。
      try { e.target.setPointerCapture(e.pointerId); } catch {}
      _cropState.drag = handle;
      _cropState.startMouse = { x: e.clientX, y: e.clientY };
      _cropState.startRect = { ...(_cropState.rect) };
    });
    overlay.addEventListener("pointermove", (e: any) => {
      if (!_cropState || !_cropState.drag) return;
      const dx_screen = e.clientX - _cropState.startMouse.x;
      const dy_screen = e.clientY - _cropState.startMouse.y;
      const scale = board.viewport.scale;
      const dx = dx_screen / scale;
      const dy = dy_screen / scale;
      // 8-handle resize 几何（含「缩到下限对边不动」+ v127 向外扩张）抽到 crop-geometry.js
      _cropState.rect = resizeCropRect(_cropState.drag, _cropState.startRect, dx, dy, { min: 4, max: 8192 });
      _renderCropOverlay();
    });
    overlay.addEventListener("pointerup", (e: any) => {
      if (!_cropState) return;
      try { overlay.releasePointerCapture(e.pointerId); } catch {}
      _cropState.drag = null;
    });
    overlay.addEventListener("pointercancel", (e: any) => {
      if (!_cropState) return;
      try { overlay.releasePointerCapture(e.pointerId); } catch {}
      _cropState.drag = null;
    });
  })();

  // 重采样 ----
  document.getElementById("adjustResample")!.addEventListener("click", () => {
    setMenuOpen(false);
    setAdjustOpen(false);
    editMode.applyPendingTransient();   // 决定性命令：先 commit 掉浮动变换/调色，再改 doc 尺寸（否则浮层错位+undo 不一致）
    _openResampleDialog();
  });
  els.resampleCancel.addEventListener("click", () => _closeResampleDialog());
  els.resampleBackdrop.addEventListener("click", () => _closeResampleDialog());
  els.resampleConfirm.addEventListener("click", () => {
    const nw = parseFloat(els.resampleW.value) | 0;
    const nh = parseFloat(els.resampleH.value) | 0;
    const mode = els.resampleMode.value || "bicubic";
    if (nw < 1 || nh < 1 || nw > 8192 || nh > 8192) { setStatus("尺寸超出 [1, 8192]", true); return; }
    if (nw === doc.width && nh === doc.height) { _closeResampleDialog(); return; }
    runDocTransform(`已重采样到 ${nw}×${nh}（${mode}）`, () => doc.resampleTo(nw, nh, mode));
    _closeResampleDialog();
  });
}
