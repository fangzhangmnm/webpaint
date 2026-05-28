// Orchestrator：装配 + UI 绑定 + SW + theme。
//
// 一期约束：固定 2048×2048 doc，单图层，无持久化。手感优先。
// 后期：layers UI / IDB / OneDrive / brush presets / 选区 / 液化 / ...
//
// 状态归属：
//   PaintDoc        ← 画布像素（layers），由 input/brush 写入
//   Board           ← 视口 + 渲染
//   BrushSettings   ← 当前笔刷参数（这里持有，传给 input.brush）
//   App state       ← 工具 / 颜色 / 主题 / 压感开关

import { PaintDoc } from "./doc.js";
import { Board } from "./board.js";
import { InputController, compressPixelSnap, applyPixelSnap } from "./input.js";
import { BrushSettings } from "./brush.js";
import { UndoStack } from "./history.js";
import { ReferenceWindow } from "./reference.js";
import {
  saveSession, loadCurrentSession, openSession, removeSession, listSessions,
  getCurrentSessionName, setCurrentSessionName,
  exportOraDownload, exportPsdDownload, shareOrDownloadImage,
  copyImageToClipboard, readImageFromClipboard,
} from "./session.js";
import { decodeOraToDoc, encodeDocToOra } from "./ora.js";
import {
  isAuthConfigured, initAuth, signIn, signOut, isSignedIn, getActiveAccount,
  pushSession, pullSessionByPath, listCloudSessionsRecursive, deleteCloudSession,
  isCloudDirty, setCloudDirty, CloudConflictError,
} from "./cloud.js";

const THEMES = ["auto", "day", "night"];
const THEME_LABEL = { auto: "跟随系统", day: "日", night: "夜" };

const els = {
  board: document.getElementById("board"),
  topBar: document.getElementById("topBar"),
  zoomLabel: document.getElementById("zoomLabel"),
  canvasSizeLabel: document.getElementById("canvasSizeLabel"),
  statusLabel: document.getElementById("statusLabel"),
  versionLabel: document.getElementById("versionLabel"),
  sizeSlider: document.getElementById("sizeSlider"),
  opacitySlider: document.getElementById("opacitySlider"),
  undoBtn: document.getElementById("undoButton"),
  redoBtn: document.getElementById("redoButton"),
  layersBtn: document.getElementById("layersButton"),
  layersPanel: document.getElementById("layersPanel"),
  layersPanelHead: document.getElementById("layersPanelHead"),
  layersPanelClose: document.getElementById("layersPanelClose"),
  layersList: document.getElementById("layersList"),
  layersCountLabel: document.getElementById("layersCountLabel"),
  layerAddBtn: document.getElementById("layerAddBtn"),
  layerDelBtn: document.getElementById("layerDelBtn"),
  layerUpBtn: document.getElementById("layerUpBtn"),
  layerDownBtn: document.getElementById("layerDownBtn"),
  menuBtn: document.getElementById("menuButton"),
  menuPanel: document.getElementById("menuPanel"),
  menuLongPressPick: document.getElementById("menuLongPressPick"),
  menuPressureSize: document.getElementById("menuPressureSize"),
  menuPressureOpacity: document.getElementById("menuPressureOpacity"),
  menuTheme: document.getElementById("menuTheme"),
  menuClear: document.getElementById("menuClear"),
  menuImport: document.getElementById("menuImport"),
  menuExportPng: document.getElementById("menuExportPng"),
  menuExportJpg: document.getElementById("menuExportJpg"),
  menuExportOra: document.getElementById("menuExportOra"),
  menuExportPsd: document.getElementById("menuExportPsd"),
  menuClipboardCopy: document.getElementById("menuClipboardCopy"),
  menuClipboardPaste: document.getElementById("menuClipboardPaste"),
  menuFit: document.getElementById("menuFit"),
  menuBrushSettings: document.getElementById("menuBrushSettings"),
  brushPanel: document.getElementById("brushPanel"),
  brushPanelHead: document.getElementById("brushPanelHead"),
  brushPanelClose: document.getElementById("brushPanelClose"),
  brushStreamline: document.getElementById("brushStreamline"),
  brushStreamlineVal: document.getElementById("brushStreamlineVal"),
  brushStabilization: document.getElementById("brushStabilization"),
  brushStabilizationVal: document.getElementById("brushStabilizationVal"),
  brushPullStabilizer: document.getElementById("brushPullStabilizer"),
  brushPullStabilizerVal: document.getElementById("brushPullStabilizerVal"),
  brushMotionFilter: document.getElementById("brushMotionFilter"),
  brushMotionFilterVal: document.getElementById("brushMotionFilterVal"),
  topSaveBtn: document.getElementById("topSaveBtn"),
  topAdjustBtn: document.getElementById("topAdjustBtn"),
  adjustPopup: document.getElementById("adjustPopup"),
  adjustLiquify: document.getElementById("adjustLiquify"),
  menuGallery: document.getElementById("menuGallery"),
  liquifyPanel: document.getElementById("liquifyPanel"),
  liquifyPanelHead: document.getElementById("liquifyPanelHead"),
  liquifyPanelClose: document.getElementById("liquifyPanelClose"),
  liquifyMode: document.getElementById("liquifyMode"),
  liquifySize: document.getElementById("liquifySize"),
  liquifySizeVal: document.getElementById("liquifySizeVal"),
  liquifyStrength: document.getElementById("liquifyStrength"),
  liquifyStrengthVal: document.getElementById("liquifyStrengthVal"),
  menuReference: document.getElementById("menuReference"),
  referencePanel: document.getElementById("referencePanel"),
  referencePanelHead: document.getElementById("referencePanelHead"),
  referencePanelClose: document.getElementById("referencePanelClose"),
  referenceBody: document.getElementById("referenceBody"),
  referenceCanvas: document.getElementById("referenceCanvas"),
  referenceEmpty: document.getElementById("referenceEmpty"),
  referenceLoadBtn: document.getElementById("referenceLoadBtn"),
  referenceLiveBtn: document.getElementById("referenceLiveBtn"),
  referenceFitBtn: document.getElementById("referenceFitBtn"),
  referenceFileInput: document.getElementById("referenceFileInput"),
  galleryFull: document.getElementById("galleryFull"),
  galleryCloseBtn: document.getElementById("galleryCloseBtn"),
  galleryGrid: document.getElementById("galleryGrid"),
  galleryEmpty: document.getElementById("galleryEmpty"),
  galleryAddBtn: document.getElementById("galleryAddBtn"),
  galleryAddPopup: document.getElementById("galleryAddPopup"),
  addNew: document.getElementById("addNew"),
  addImportPhoto: document.getElementById("addImportPhoto"),
  cloudIconBtn: document.getElementById("cloudIconBtn"),
  cloudAccountPopup: document.getElementById("cloudAccountPopup"),
  cloudAccountInfo: document.getElementById("cloudAccountInfo"),
  cloudSignInBtn: document.getElementById("cloudSignInBtn"),
  cloudSignOutBtn: document.getElementById("cloudSignOutBtn"),
  cloudRefreshBtn: document.getElementById("cloudRefreshBtn"),
  galleryFootUsage: document.getElementById("galleryFootUsage"),
  newDocBackdrop: document.getElementById("newDocBackdrop"),
  newDocSheet: document.getElementById("newDocSheet"),
  newDocName: document.getElementById("newDocName"),
  newDocPreset: document.getElementById("newDocPreset"),
  newDocCustomRow: document.getElementById("newDocCustomRow"),
  newDocW: document.getElementById("newDocW"),
  newDocH: document.getElementById("newDocH"),
  newDocConfirm: document.getElementById("newDocConfirm"),
  newDocCancel: document.getElementById("newDocCancel"),
  menuRename: document.getElementById("menuRename"),
  menuCheckerboard: document.getElementById("menuCheckerboard"),
  menuCheckUpdate: document.getElementById("menuCheckUpdate"),
  oraFileInput: document.getElementById("oraFileInput"),
  genericBackdrop: document.getElementById("genericBackdrop"),
  genericSheet: document.getElementById("genericSheet"),
  genericSheetTitle: document.getElementById("genericSheetTitle"),
  genericSheetMessage: document.getElementById("genericSheetMessage"),
  genericSheetInput: document.getElementById("genericSheetInput"),
  genericSheetConfirm: document.getElementById("genericSheetConfirm"),
  genericSheetCancel: document.getElementById("genericSheetCancel"),
  toolBtns: [...document.querySelectorAll(".tool[data-tool]")],
  activeSwatch: document.getElementById("activeSwatch"),
  // 浮动色板
  colorPanel: document.getElementById("colorPanel"),
  colorPanelHead: document.getElementById("colorPanelHead"),
  colorPanelClose: document.getElementById("colorPanelClose"),
  svPad: document.getElementById("svPad"),
  hueSlider: document.getElementById("hueSlider"),
  hexInput: document.getElementById("hexInput"),
  previewSwatch: document.getElementById("previewSwatch"),
  // clear sheet
  clearSheet: document.getElementById("clearSheet"),
  clearBackdrop: document.getElementById("clearBackdrop"),
  // update toast
  updateToast: document.getElementById("updateToast"),
  updateReload: document.getElementById("updateToastReload"),
  updateDismiss: document.getElementById("updateToastDismiss"),
};

function safeLS(key, fallback) {
  try { return localStorage.getItem(key); } catch { return fallback; }
}
function safeLSSet(key, val) {
  try { localStorage.setItem(key, val); } catch {}
}

// ---- 启动 ----
const doc = new PaintDoc({ width: 2048, height: 2048 });
const board = new Board(els.board, doc);
els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
els.versionLabel.textContent = window.WEBPAINT_VERSION || "?";

const state = {
  tool: "brush",
  color: safeLS("webpaint.color") || "#1b1b1b",
  brush: new BrushSettings({
    size: parseFloat(safeLS("webpaint.size") || "12"),
    opacity: parseFloat(safeLS("webpaint.opacity") || "1"),
    color: safeLS("webpaint.color") || "#1b1b1b",
    pressureToSize: safeLS("webpaint.pToSize") !== "0",     // 默认开
    pressureToOpacity: safeLS("webpaint.pToOpacity") !== "0",
    streamline: parseFloat(safeLS("webpaint.streamline") || "0.3"),
    stabilization: parseFloat(safeLS("webpaint.stabilization") || "0"),
    pullStabilizer: parseFloat(safeLS("webpaint.pullStabilizer") || "0"),
    motionFilter: parseFloat(safeLS("webpaint.motionFilter") || "0"),
  }),
  longPressPick: safeLS("webpaint.longPressPick") === "1", // 默认关，user 担心误触
  checkerboard: safeLS("webpaint.checkerboard") === "1",   // 默认关；开后用半透明灰白格替代纯背景
  // 液化设置（独立于 brush，见 src/liquify.js + docs/artist-priorities.md v46）
  liquify: {
    mode: safeLS("webpaint.liquify.mode") || "push",
    size: parseFloat(safeLS("webpaint.liquify.size") || "60"),
    strength: parseFloat(safeLS("webpaint.liquify.strength") || "0.4"),
  },
};

// brush settings keep color in sync
function syncBrushColor() {
  state.brush.color = state.color;
  // brush engine 会自动 invalidate stamp（_getStamp key 包含 color）
}
syncBrushColor();

// Undo / redo 共享栈（command pattern + 注册 handler，详见
// docs/undo-architecture.md）。input.js 注册 "stroke" handler；layer
// 操作的 5 个 handler 在下方 boot 段集中注册（四条纪律 #1）。
const history = new UndoStack({ max: 50 });

const input = new InputController(board, doc, {
  getTool: () => state.tool,
  getBrushSettings: () => state.brush,
  getLiquifySettings: () => state.liquify,
  getLongPressPickEnabled: () => state.longPressPick,
  onColorSampled: (hex) => setColor(hex),
  status: setStatus,
  history,
});

// 笔触 buffer live overlay：board 每帧问 brush 要，layer 之上 composite × s.opacity
// 预览（实际像素在 endStroke 才烧进 layer）。
board.setOverlayProvider(() => input.brush.getLiveOverlay());
board.setLassoProvider(() => ({
  drawingPath: input.lasso.getDrawingPath(),
  floating:    input.lasso.getFloating(),
  handles:     input.lasso.visibleHandles(),
}));

// 套索工具栏（两态：selected = 4 模式 picker；transforming = mode label + 应用 / 取消）
const lassoToolbar = document.getElementById("lassoToolbar");
const lassoPicker = document.getElementById("lassoPicker");
const lassoTransformCtrl = document.getElementById("lassoTransformCtrl");
const lassoModeLabel = document.getElementById("lassoModeLabel");
const lassoModeBtns = [...lassoPicker.querySelectorAll("[data-lasso-mode]")];
const LASSO_MODE_LABEL = { free: "自由", uniform: "等比", distort: "透视", warp: "变形" };

function updateLassoToolbar() {
  const has = input.lasso.hasFloating();
  lassoToolbar.classList.toggle("hidden", !has);
  if (!has) return;
  const mode = input.lasso.getMode();
  if (mode === null) {
    // selected：只显 picker
    lassoPicker.classList.remove("hidden");
    lassoTransformCtrl.classList.add("hidden");
  } else {
    // transforming：只显 mode label + 应用 / 取消
    lassoPicker.classList.add("hidden");
    lassoTransformCtrl.classList.remove("hidden");
    lassoModeLabel.textContent = LASSO_MODE_LABEL[mode] || mode;
  }
}
for (const b of lassoModeBtns) {
  b.addEventListener("click", () => {
    input.lasso.setMode(b.dataset.lassoMode);
    updateLassoToolbar();
  });
}
document.getElementById("lassoCommitBtn").addEventListener("click", () => {
  input.commitLassoIfFloating();
  updateLassoToolbar();
});
document.getElementById("lassoCancelBtn").addEventListener("click", () => {
  if (input.lasso.hasFloating()) {
    input.lasso.cancel();
    board.invalidateAll();
    updateLassoToolbar();
  }
});
document.getElementById("lassoSelectedCancelBtn").addEventListener("click", () => {
  if (input.lasso.hasFloating()) {
    input.lasso.cancel();
    board.invalidateAll();
    updateLassoToolbar();
  }
});
window.addEventListener("wp:lassochange", updateLassoToolbar);

// ---- 主题 ----
function readCssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function applyThemeColorsToBoard() {
  board.setThemeColors({ voidColor: readCssColor("--void") });
}

let theme = safeLS("webpaint.theme") || "auto";
if (!THEMES.includes(theme)) theme = "auto";
function applyTheme(t) {
  theme = t;
  document.documentElement.setAttribute("data-theme", t);
  safeLSSet("webpaint.theme", t);
  els.menuTheme.querySelector('[data-state-for="theme"]').textContent = THEME_LABEL[t];
  requestAnimationFrame(applyThemeColorsToBoard);
}
applyTheme(theme);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (theme === "auto") requestAnimationFrame(applyThemeColorsToBoard);
});

// ---- 工具 ----
function setTool(t) {
  // 切走 lasso 时，把当前 floating 选区 commit（避免遗漏；用户预期切工具 = 确认）
  if (state.tool === "lasso" && t !== "lasso") {
    input.commitLassoIfFloating();
  }
  state.tool = t;
  for (const b of els.toolBtns) b.setAttribute("aria-pressed", b.dataset.tool === t ? "true" : "false");
  // 液化没有独立 data-tool topbar 按钮，但 adjust 按钮在该工具下高亮
  els.topAdjustBtn.setAttribute("aria-pressed", t === "liquify" ? "true" : "false");
  document.body.dataset.tool = t;
}
for (const b of els.toolBtns) {
  b.addEventListener("click", () => setTool(b.dataset.tool));
}
window.addEventListener("wp:settool", (e) => setTool(e.detail));
// pencil 模式下双击 → 笔↔橡皮。但 floating 选区存在时屏蔽（避免误触切工具 = 自动 apply 变换）
window.addEventListener("wp:doubletap", () => {
  if (input.lasso.hasFloating()) {
    setStatus("套索浮层进行中，双击切换暂停（点应用 / 取消 / 返回工具栏）");
    return;
  }
  const next = state.tool === "eraser" ? "brush" : "eraser";
  setTool(next);
  setStatus(`双击 · ${next === "eraser" ? "橡皮" : "笔刷"}`);
});
setTool(state.tool);

// ---- 颜色 ----
// picker 内部触发的 setColor 不要再 round-trip 回 pickerSetFromHex —— 因为
// HSV→RGB→HSV 在低饱和/低明度处 hue 是 undefined（数学上没定义），
// hexToHsv 默认返回 h=0，回灌就把 hue slider 弹回去了（旧 bug）。
// 外部源（吸色、HEX 输入）才需要 sync。
let _suppressPickerSync = false;
function setColor(hex) {
  state.color = hex;
  safeLSSet("webpaint.color", hex);
  els.activeSwatch.style.background = hex;
  syncBrushColor();
  if (!_suppressPickerSync && !els.colorPanel.classList.contains("hidden")) {
    pickerSetFromHex(hex);
  }
}
els.activeSwatch.addEventListener("click", () => toggleColorPanel());
setColor(state.color);

// ---- size / opacity ----
function setSize(v) {
  state.brush.size = v;
  safeLSSet("webpaint.size", String(v));
  els.sizeSlider.value = String(v);
}
function setOpacity(v) {
  state.brush.opacity = v;
  safeLSSet("webpaint.opacity", String(v));
  els.opacitySlider.value = String(Math.round(v * 100));
}
els.sizeSlider.addEventListener("input", () => setSize(parseFloat(els.sizeSlider.value)));
els.opacitySlider.addEventListener("input", () => setOpacity(parseFloat(els.opacitySlider.value) / 100));
setSize(state.brush.size);
setOpacity(state.brush.opacity);
// 键盘 [ ] 调粗
window.addEventListener("wp:adjsize", (e) => {
  const delta = e.detail;
  setSize(Math.max(1, Math.min(200, state.brush.size + delta)));
  setStatus(`笔粗 ${state.brush.size}px`);
});

// ---- 汉堡菜单 ----
function setMenuItem(btn, on, stateLabel = on ? "开" : "关") {
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  const st = btn.querySelector('.menu-item-state');
  if (st) st.textContent = stateLabel;
}

function applyPressureSize(on) {
  state.brush.pressureToSize = !!on;
  setMenuItem(els.menuPressureSize, on);
  safeLSSet("webpaint.pToSize", on ? "1" : "0");
}
function applyPressureOpacity(on) {
  state.brush.pressureToOpacity = !!on;
  setMenuItem(els.menuPressureOpacity, on);
  safeLSSet("webpaint.pToOpacity", on ? "1" : "0");
}
function applyLongPressPick(on) {
  state.longPressPick = !!on;
  setMenuItem(els.menuLongPressPick, on);
  safeLSSet("webpaint.longPressPick", on ? "1" : "0");
}
function applyCheckerboard(on) {
  state.checkerboard = !!on;
  setMenuItem(els.menuCheckerboard, on);
  safeLSSet("webpaint.checkerboard", on ? "1" : "0");
  board.setShowCheckerboard?.(!!on);
  board.invalidateAll();
  board.requestRender();
}

els.menuPressureSize.addEventListener("click", () => {
  applyPressureSize(!state.brush.pressureToSize);
  setStatus(`压·粗 · ${state.brush.pressureToSize ? "开" : "关"}`);
});
els.menuPressureOpacity.addEventListener("click", () => {
  applyPressureOpacity(!state.brush.pressureToOpacity);
  setStatus(`压·透 · ${state.brush.pressureToOpacity ? "开" : "关"}`);
});
els.menuLongPressPick.addEventListener("click", () => {
  applyLongPressPick(!state.longPressPick);
  setStatus(`长按吸色 · ${state.longPressPick ? "开" : "关"}`);
});
els.menuCheckerboard.addEventListener("click", () => {
  applyCheckerboard(!state.checkerboard);
  setStatus(`透明棋盘 · ${state.checkerboard ? "开" : "关"}`);
});
els.menuTheme.addEventListener("click", () => {
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(next);
  setStatus(`主题 · ${THEME_LABEL[next]}`);
});
els.menuCheckUpdate.addEventListener("click", async () => {
  setMenuOpen(false);
  setStatus("检测更新中…", true);
  try {
    // 优先用 boot 时存的 registration（iPad PWA / save-to-home-screen 模式下
    // navigator.serviceWorker.getRegistration() 偶尔返 undefined）
    const reg = _swRegistration || await navigator.serviceWorker?.getRegistration();
    if (!reg) { setStatus("Service Worker 未注册（先把页面刷一次）"); return; }
    await reg.update();
    setTimeout(() => {
      if (reg.waiting) setStatus("有新版本，刷新页面应用");
      else setStatus(`已是最新（${window.WEBPAINT_VERSION || ""}）`);
    }, 1500);
  } catch (e) {
    setStatus("检测失败：" + (e && e.message || e));
  }
});
els.menuClear.addEventListener("click", () => {
  setMenuOpen(false);
  openSheet(els.clearSheet, els.clearBackdrop);
});

applyPressureSize(state.brush.pressureToSize);
applyPressureOpacity(state.brush.pressureToOpacity);
applyLongPressPick(state.longPressPick);
applyCheckerboard(state.checkerboard);

function setMenuOpen(open) {
  els.menuPanel.classList.toggle("hidden", !open);
  els.menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
}
els.menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenuOpen(els.menuPanel.classList.contains("hidden"));
});
document.addEventListener("pointerdown", (e) => {
  if (els.menuPanel.classList.contains("hidden")) return;
  if (els.menuPanel.contains(e.target) || els.menuBtn.contains(e.target)) return;
  setMenuOpen(false);
});

// ---- undo / redo / fit ----
els.undoBtn.addEventListener("click", () => input.undo());
els.redoBtn.addEventListener("click", () => input.redo());
window.addEventListener("wp:histchange", (e) => {
  els.undoBtn.disabled = !e.detail.canUndo;
  els.redoBtn.disabled = !e.detail.canRedo;
});
els.undoBtn.disabled = true;
els.redoBtn.disabled = true;

function openSheet(sheet, backdrop) {
  backdrop.classList.remove("hidden");
  sheet.classList.remove("hidden");
}
function closeSheet(sheet, backdrop) {
  backdrop.classList.add("hidden");
  sheet.classList.add("hidden");
}
els.clearBackdrop.addEventListener("click", () => closeSheet(els.clearSheet, els.clearBackdrop));
els.clearSheet.addEventListener("click", (e) => {
  const a = e.target.closest("[data-clear]")?.dataset.clear;
  if (!a) return;
  closeSheet(els.clearSheet, els.clearBackdrop);
  if (a !== "confirm") return;
  const layer = doc.activeLayer;
  if (!layer) return;
  // 走 stroke handler 让 Ctrl+Z 能复活。before = 当前像素；after = 空层快照。
  const before = layer.snapshot();
  doc.clearActiveLayer();
  const after = layer.snapshot();
  const entry = { type: "stroke", layerId: layer.id, before, after, beforeBlob: null, afterBlob: null };
  history.push(entry);
  compressPixelSnap(entry.before, (blob) => { entry.beforeBlob = blob; });
  compressPixelSnap(entry.after,  (blob) => { entry.afterBlob  = blob; });
  board.invalidateAll();
  setStatus("已清空当前图层（Ctrl+Z 撤销）");
});

// ---- HUD ----
function updateZoomLabel() {
  els.zoomLabel.textContent = Math.round(board.viewport.scale * 100) + "%";
}
let statusTimer = null;
function setStatus(text, persist = false) {
  els.statusLabel.textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  if (!persist) {
    statusTimer = setTimeout(() => { els.statusLabel.textContent = "就绪"; }, 1800);
  }
}
// hook board render 更新 HUD
const origRender = board.render.bind(board);
board.render = function () {
  origRender();
  updateZoomLabel();
};

// ---- HSV 浮动色板 ----
let pickerHsv = { h: 0, s: 0, v: 0.1 };

function toggleColorPanel(force) {
  const hidden = els.colorPanel.classList.contains("hidden");
  const show = force === true ? true : force === false ? false : hidden;
  if (show) {
    pickerSetFromHex(state.color);
    els.colorPanel.classList.remove("hidden");
    // 还原位置；没存过就放到右上角
    const saved = safeLS("webpaint.colorPanel.pos");
    const w = els.colorPanel.offsetWidth || 264;
    const h = els.colorPanel.offsetHeight || 320;
    let left, top;
    if (saved) {
      try {
        const o = JSON.parse(saved);
        left = o.left; top = o.top;
      } catch { left = top = null; }
    }
    if (left == null) { left = window.innerWidth - w - 16; top = 60; }
    // clamp
    left = Math.max(0, Math.min(window.innerWidth - w, left));
    top = Math.max(0, Math.min(window.innerHeight - h, top));
    els.colorPanel.style.left = left + "px";
    els.colorPanel.style.top = top + "px";
    drawSvPad();
  } else {
    els.colorPanel.classList.add("hidden");
  }
}
els.colorPanelClose.addEventListener("click", () => toggleColorPanel(false));

// 拖标题栏移动面板（pointer events，捕获到 head 上 → 不会漏掉移出窗口外的 move）
let _panelDrag = null;
els.colorPanelHead.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".close-x")) return;
  const r = els.colorPanel.getBoundingClientRect();
  _panelDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
  els.colorPanelHead.setPointerCapture(e.pointerId);
  e.preventDefault();
});
els.colorPanelHead.addEventListener("pointermove", (e) => {
  if (!_panelDrag || e.pointerId !== _panelDrag.id) return;
  const w = els.colorPanel.offsetWidth;
  const h = els.colorPanel.offsetHeight;
  const left = Math.max(0, Math.min(window.innerWidth - w, _panelDrag.ol + (e.clientX - _panelDrag.sx)));
  const top  = Math.max(0, Math.min(window.innerHeight - h, _panelDrag.ot + (e.clientY - _panelDrag.sy)));
  els.colorPanel.style.left = left + "px";
  els.colorPanel.style.top = top + "px";
  safeLSSet("webpaint.colorPanel.pos", JSON.stringify({ left, top }));
});
els.colorPanelHead.addEventListener("pointerup", (e) => {
  if (_panelDrag && e.pointerId === _panelDrag.id) {
    try { els.colorPanelHead.releasePointerCapture(e.pointerId); } catch {}
    _panelDrag = null;
  }
});

// 键盘 C 切换
window.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
  if (e.key === "c" || e.key === "C") {
    if (!(e.ctrlKey || e.metaKey)) toggleColorPanel();
  }
});

// ---- 图层面板 ----
function toggleLayersPanel(force) {
  const hidden = els.layersPanel.classList.contains("hidden");
  const show = force === true ? true : force === false ? false : hidden;
  els.layersPanel.classList.toggle("hidden", !show);
  els.layersBtn.setAttribute("aria-pressed", show ? "true" : "false");
  if (show) renderLayersPanel();
}
els.layersBtn.addEventListener("click", () => toggleLayersPanel());
els.layersPanelClose.addEventListener("click", () => toggleLayersPanel(false));

// 拖动 layers 面板（沿用 color panel 模式）
let _layersDrag = null;
els.layersPanelHead.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".float-panel-close")) return;
  const r = els.layersPanel.getBoundingClientRect();
  _layersDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
  els.layersPanelHead.setPointerCapture(e.pointerId);
  e.preventDefault();
});
els.layersPanelHead.addEventListener("pointermove", (e) => {
  if (!_layersDrag || e.pointerId !== _layersDrag.id) return;
  const w = els.layersPanel.offsetWidth;
  const h = els.layersPanel.offsetHeight;
  const left = Math.max(0, Math.min(window.innerWidth - w, _layersDrag.ol + (e.clientX - _layersDrag.sx)));
  const top  = Math.max(0, Math.min(window.innerHeight - h, _layersDrag.ot + (e.clientY - _layersDrag.sy)));
  els.layersPanel.style.left = left + "px";
  els.layersPanel.style.right = "auto";
  els.layersPanel.style.top = top + "px";
  safeLSSet("webpaint.layersPanel.pos", JSON.stringify({ left, top }));
});
els.layersPanelHead.addEventListener("pointerup", (e) => {
  if (_layersDrag && e.pointerId === _layersDrag.id) {
    try { els.layersPanelHead.releasePointerCapture(e.pointerId); } catch {}
    _layersDrag = null;
  }
});
// 还原上次位置
(function restoreLayersPanelPos() {
  const saved = safeLS("webpaint.layersPanel.pos");
  if (!saved) return;
  try {
    const o = JSON.parse(saved);
    els.layersPanel.style.left = o.left + "px";
    els.layersPanel.style.right = "auto";
    els.layersPanel.style.top = o.top + "px";
  } catch {}
})();

// 渲染图层列表（倒序：UI 上 = 最上面图层在面板顶部）
// 图层模式 → 单字符 badge (Procreate 风格)
const LAYER_MODE_INITIAL = {
  "source-over": "N", "multiply": "M", "screen": "S", "overlay": "O",
  "darken": "Da", "lighten": "Li", "color-dodge": "CD", "color-burn": "CB",
  "hard-light": "HL", "soft-light": "SL", "difference": "Df", "exclusion": "Ex",
};
const LAYER_MODE_LABEL = {
  "source-over": "正常", "multiply": "正片叠底", "screen": "滤色", "overlay": "叠加",
  "darken": "变暗", "lighten": "变亮", "color-dodge": "颜色减淡", "color-burn": "颜色加深",
  "hard-light": "强光", "soft-light": "柔光", "difference": "差值", "exclusion": "排除",
};
function modeInitial(m) { return LAYER_MODE_INITIAL[m] || "?"; }

let _expandedLayerId = null;

function renderLayersPanel() {
  els.layersList.innerHTML = "";
  const max = doc.maxLayers;
  els.layersCountLabel.textContent = `${doc.layers.length} / ${max}`;
  // 倒序：top of UI = top of stack
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const L = doc.layers[i];
    const row = document.createElement("div");
    row.className = "layer-row" + (i === doc.activeIndex ? " active" : "");
    row.dataset.layerId = String(L.id);

    const vis = document.createElement("button");
    vis.type = "button";
    vis.className = "layer-vis" + (L.visible ? "" : " hidden-icon");
    vis.title = L.visible ? "可见" : "已隐藏";
    vis.innerHTML = L.visible
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a18.94 18.94 0 0 1 4.06-5.06"/><path d="M1 1l22 22"/></svg>';
    vis.addEventListener("click", (e) => {
      e.stopPropagation();
      const oldVal = L.visible;
      L.visible = !oldVal;
      history.push({ type: "setLayerProp", layerId: L.id, prop: "visible", oldVal, newVal: L.visible });
      renderLayersPanel();
      board.invalidateAll();
      board.requestRender();
    });
    row.appendChild(vis);

    // 名字：单击 row = setActive（行 click handler 处理）。重命名走 "⋯" 工具菜单。
    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = L.name;
    row.appendChild(name);

    // "⋯" 工具菜单按钮（per-row tools，先放重命名，后续加复制 / 清空内容等）
    const tools = document.createElement("button");
    tools.type = "button";
    tools.className = "layer-tools-btn";
    tools.title = "图层菜单";
    tools.textContent = "⋯";
    tools.addEventListener("click", (e) => {
      e.stopPropagation();
      openLayerToolsMenu(L, tools, name);
    });
    row.appendChild(tools);

    // Mode / opacity badge：点开折叠区
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "layer-mode-badge" + (_expandedLayerId === L.id ? " active" : "");
    badge.textContent = modeInitial(L.mode);
    badge.title = `不透明度 ${Math.round(L.opacity * 100)}% · 模式 ${LAYER_MODE_LABEL[L.mode] || L.mode}`;
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      _expandedLayerId = _expandedLayerId === L.id ? null : L.id;
      renderLayersPanel();
    });
    row.appendChild(badge);

    row.addEventListener("click", () => {
      doc.setActiveById(L.id);
      renderLayersPanel();
    });
    els.layersList.appendChild(row);

    // 折叠区（点 badge 才出现）
    if (_expandedLayerId === L.id) {
      const expand = document.createElement("div");
      expand.className = "layer-row-expand";
      // 不透明度 slider
      const opaRow = document.createElement("label");
      opaRow.className = "layer-slider-row";
      opaRow.innerHTML = `<span>透</span><input type="range" min="0" max="100" value="${Math.round(L.opacity * 100)}"><span class="layer-slider-val">${Math.round(L.opacity * 100)}</span>`;
      const opaInput = opaRow.querySelector("input");
      const opaVal = opaRow.querySelector(".layer-slider-val");
      // Slider **coalescing**：pointerdown 记 oldVal，pointerup 才 push history entry。
      // input 期间只改 layer.opacity + render，不动 history。一次拖动 = 一个 entry。
      let opaCoalesceOldVal = null;
      opaInput.addEventListener("pointerdown", () => { opaCoalesceOldVal = L.opacity; });
      opaInput.addEventListener("input", () => {
        const v = parseFloat(opaInput.value) / 100;
        L.opacity = v;
        opaVal.textContent = String(Math.round(v * 100));
        badge.title = `不透明度 ${Math.round(v * 100)}% · 模式 ${LAYER_MODE_LABEL[L.mode] || L.mode}`;
        board.invalidateAll();
        board.requestRender();
      });
      const opaCommit = () => {
        if (opaCoalesceOldVal === null) return;
        if (opaCoalesceOldVal !== L.opacity) {
          history.push({ type: "setLayerProp", layerId: L.id, prop: "opacity", oldVal: opaCoalesceOldVal, newVal: L.opacity });
        }
        opaCoalesceOldVal = null;
      };
      opaInput.addEventListener("pointerup", opaCommit);
      opaInput.addEventListener("pointercancel", opaCommit);
      opaInput.addEventListener("click", (e) => e.stopPropagation());
      expand.appendChild(opaRow);
      // 模式 dropdown：change 是离散事件，直接 push 一个 entry
      const modeRow = document.createElement("label");
      modeRow.className = "layer-slider-row";
      let optsHtml = "";
      for (const [val, lbl] of Object.entries(LAYER_MODE_LABEL)) {
        optsHtml += `<option value="${val}"${L.mode === val ? " selected" : ""}>${lbl}</option>`;
      }
      modeRow.innerHTML = `<span>模式</span><select style="grid-column: span 2;">${optsHtml}</select>`;
      const modeSelect = modeRow.querySelector("select");
      modeSelect.addEventListener("change", () => {
        const oldVal = L.mode;
        const newVal = modeSelect.value;
        L.mode = newVal;
        history.push({ type: "setLayerProp", layerId: L.id, prop: "mode", oldVal, newVal });
        badge.textContent = modeInitial(L.mode);
        badge.title = `不透明度 ${Math.round(L.opacity * 100)}% · 模式 ${LAYER_MODE_LABEL[L.mode] || L.mode}`;
        board.invalidateAll();
        board.requestRender();
      });
      modeSelect.addEventListener("click", (e) => e.stopPropagation());
      expand.appendChild(modeRow);
      expand.addEventListener("click", (e) => e.stopPropagation());
      els.layersList.appendChild(expand);
    }
  }
  // foot button enable/disable
  els.layerAddBtn.disabled = doc.layers.length >= max;
  els.layerDelBtn.disabled = doc.layers.length <= 1;
  els.layerUpBtn.disabled = doc.activeIndex >= doc.layers.length - 1;
  els.layerDownBtn.disabled = doc.activeIndex <= 0;
}

// 各层操作都走 history.push → handler 同时 apply 和 push。这样未来 undo / redo
// 都自动可以反向 apply。helper：apply 即时效果 + 渲染。
function _afterDocChange() {
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
}

els.layerAddBtn.addEventListener("click", () => {
  if (doc.layers.length >= doc.maxLayers) {
    setStatus(`图层数已达上限 ${doc.maxLayers}`);
    return;
  }
  // 先 add（拿到分配的 id），然后用它的 spec 当 entry data
  const L = doc.addLayer();
  if (!L) return;
  const insertIndex = doc.layers.findIndex((l) => l.id === L.id);
  const layerSpec = layerSpecFrom(L);    // empty 新层 → spec 也是 empty
  history.push({ type: "addLayer", index: insertIndex, layerSpec });
  _afterDocChange();
});
els.layerDelBtn.addEventListener("click", () => {
  const L = doc.activeLayer;
  if (!L) return;
  if (doc.layers.length <= 1) { setStatus("至少保留一层"); return; }
  const index = doc.layers.findIndex((l) => l.id === L.id);
  const layerSpec = layerSpecFrom(L);     // 含 pixel snapshot
  doc.removeLayer(L.id);
  const entry = { type: "removeLayer", index, layerSpec };
  history.push(entry);
  // 异步压缩 layerSpec 的 imageData → blob
  compressPixelSnap(layerSpec, (blob) => { layerSpec.blob = blob; });
  _afterDocChange();
});
els.layerUpBtn.addEventListener("click", () => {
  const L = doc.activeLayer;
  if (!L) return;
  const from = doc.layers.findIndex((l) => l.id === L.id);
  if (!doc.moveLayer(L.id, 1)) return;
  const to = doc.layers.findIndex((l) => l.id === L.id);
  history.push({ type: "moveLayer", layerId: L.id, fromIdx: from, toIdx: to });
  _afterDocChange();
});
els.layerDownBtn.addEventListener("click", () => {
  const L = doc.activeLayer;
  if (!L) return;
  const from = doc.layers.findIndex((l) => l.id === L.id);
  if (!doc.moveLayer(L.id, -1)) return;
  const to = doc.layers.findIndex((l) => l.id === L.id);
  history.push({ type: "moveLayer", layerId: L.id, fromIdx: from, toIdx: to });
  _afterDocChange();
});

// In-app 通用 sheet：替代 alert / prompt / confirm（详见 feedback-no-system-dialog）。
// 返回 Promise，resolve 输入值 / true / null（取消）。
function _resolveAndClose(resolve, value, cleanup) {
  closeSheet(els.genericSheet, els.genericBackdrop);
  cleanup();
  resolve(value);
}
function openInputSheet(title, defaultValue = "", { placeholder = "" } = {}) {
  return new Promise((resolve) => {
    els.genericSheetTitle.textContent = title;
    els.genericSheetMessage.classList.add("hidden");
    els.genericSheetInput.classList.remove("hidden");
    els.genericSheetInput.value = defaultValue;
    els.genericSheetInput.placeholder = placeholder;
    openSheet(els.genericSheet, els.genericBackdrop);
    setTimeout(() => { els.genericSheetInput.focus(); els.genericSheetInput.select(); }, 0);
    const onConfirm = () => _resolveAndClose(resolve, els.genericSheetInput.value, cleanup);
    const onCancel  = () => _resolveAndClose(resolve, null, cleanup);
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    const cleanup = () => {
      els.genericSheetConfirm.removeEventListener("click", onConfirm);
      els.genericSheetCancel.removeEventListener("click", onCancel);
      els.genericBackdrop.removeEventListener("click", onCancel);
      els.genericSheetInput.removeEventListener("keydown", onKey);
    };
    els.genericSheetConfirm.addEventListener("click", onConfirm);
    els.genericSheetCancel.addEventListener("click", onCancel);
    els.genericBackdrop.addEventListener("click", onCancel);
    els.genericSheetInput.addEventListener("keydown", onKey);
  });
}
function openConfirmSheet(title, message) {
  return new Promise((resolve) => {
    els.genericSheetTitle.textContent = title;
    els.genericSheetInput.classList.add("hidden");
    els.genericSheetMessage.classList.remove("hidden");
    els.genericSheetMessage.textContent = message;
    openSheet(els.genericSheet, els.genericBackdrop);
    const onConfirm = () => _resolveAndClose(resolve, true, cleanup);
    const onCancel  = () => _resolveAndClose(resolve, false, cleanup);
    const cleanup = () => {
      els.genericSheetConfirm.removeEventListener("click", onConfirm);
      els.genericSheetCancel.removeEventListener("click", onCancel);
      els.genericBackdrop.removeEventListener("click", onCancel);
    };
    els.genericSheetConfirm.addEventListener("click", onConfirm);
    els.genericSheetCancel.addEventListener("click", onCancel);
    els.genericBackdrop.addEventListener("click", onCancel);
  });
}

// Per-row "⋯" 工具菜单：弹出 in-app popup（**不用** alert / prompt 等系统对话框）。
// 现在只有重命名一项；之后加复制图层 / 清空内容 / 合并下方 等。
function openLayerToolsMenu(L, anchorEl, nameEl) {
  // 关掉可能已开的（防多个同时）
  document.querySelectorAll(".layer-tools-popup").forEach((p) => p.remove());

  const popup = document.createElement("div");
  popup.className = "menu-panel layer-tools-popup";
  popup.innerHTML = `
    <button class="menu-item" data-act="rename" type="button">
      <span class="menu-item-label">重命名…</span>
    </button>
  `;
  document.body.appendChild(popup);
  // 锚到按钮下方，右对齐
  const r = anchorEl.getBoundingClientRect();
  const w = popup.offsetWidth || 160;
  popup.style.position = "fixed";
  popup.style.top = (r.bottom + 4) + "px";
  popup.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + "px";

  const cleanup = () => {
    popup.remove();
    document.removeEventListener("pointerdown", outside, true);
  };
  const outside = (e) => {
    if (!popup.contains(e.target) && !anchorEl.contains(e.target)) cleanup();
  };
  // 异步挂 listener 避开本次点击事件
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);

  popup.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    cleanup();
    if (act === "rename") startLayerRename(L, nameEl);
  });
}

// Layer rename：把 name span 换成 input，blur / Enter 提交，Esc 撤销
function startLayerRename(L, nameEl) {
  const oldName = L.name;
  const input = document.createElement("input");
  input.type = "text";
  input.value = oldName;
  input.className = "layer-name-input";
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const v = input.value.trim();
    const newName = v || oldName;
    if (newName !== oldName) {
      L.name = newName;
      history.push({ type: "renameLayer", layerId: L.id, oldName, newName });
    }
    renderLayersPanel();
  };
  const cancel = () => {
    if (committed) return;
    committed = true;
    renderLayersPanel();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.addEventListener("click", (e) => e.stopPropagation());
}

// 从 Layer 拿一份 spec（含 pixel snapshot）—— add/remove handler 都用
function layerSpecFrom(L) {
  const snap = L.snapshot();
  return {
    id: L.id,
    name: L.name,
    visible: L.visible,
    opacity: L.opacity,
    mode: L.mode,
    bboxX: snap.bboxX, bboxY: snap.bboxY,
    bboxW: snap.bboxW, bboxH: snap.bboxH,
    imageData: snap.imageData,
    blob: null,
  };
}

// ---- 5 个 layer handler 注册（**纪律 #1**：集中在 boot 段）----
// addLayer：undo 删层，redo 在 index 处插入空层（spec 通常 empty）
history.registerHandler("addLayer", {
  undo: (e) => { doc.removeLayer(e.layerSpec.id); _afterDocChange(); },
  redo: (e) => { doc.insertLayerAt(e.index, e.layerSpec); _afterDocChange(); },
  refsLayer: (e, id) => e.layerSpec.id === id,
});
// removeLayer：undo 在 index 处恢复层（含 pixel）；redo 再删
history.registerHandler("removeLayer", {
  undo: async (e) => {
    const spec = e.layerSpec;
    // 优先 imageData（同步）；否则 decode blob
    if (spec.imageData || (!spec.blob && (spec.bboxW <= 0 || spec.bboxH <= 0))) {
      doc.insertLayerAt(e.index, spec);
      _afterDocChange();
      return;
    }
    if (spec.blob) {
      const bitmap = await createImageBitmap(spec.blob);
      doc.insertLayerAt(e.index, { ...spec, bitmap });
      bitmap.close?.();
      _afterDocChange();
      return;
    }
    // 没像素 fallback
    doc.insertLayerAt(e.index, spec);
    _afterDocChange();
  },
  redo: (e) => { doc.removeLayer(e.layerSpec.id); _afterDocChange(); },
  refsLayer: (e, id) => e.layerSpec.id === id,
});
// moveLayer：undo 从 toIdx 移回 fromIdx；redo 从 fromIdx 移到 toIdx
history.registerHandler("moveLayer", {
  undo: (e) => {
    const cur = doc.layers.findIndex((l) => l.id === e.layerId);
    if (cur < 0) return;
    doc.moveLayer(e.layerId, e.fromIdx - cur);
    _afterDocChange();
  },
  redo: (e) => {
    const cur = doc.layers.findIndex((l) => l.id === e.layerId);
    if (cur < 0) return;
    doc.moveLayer(e.layerId, e.toIdx - cur);
    _afterDocChange();
  },
  refsLayer: (e, id) => e.layerId === id,
});
// renameLayer：oldName / newName
history.registerHandler("renameLayer", {
  undo: (e) => { const L = doc.findLayer(e.layerId); if (L) { L.name = e.oldName; renderLayersPanel(); } },
  redo: (e) => { const L = doc.findLayer(e.layerId); if (L) { L.name = e.newName; renderLayersPanel(); } },
  refsLayer: (e, id) => e.layerId === id,
});
// setLayerProp：visibility / opacity / mode
history.registerHandler("setLayerProp", {
  undo: (e) => { const L = doc.findLayer(e.layerId); if (L) { L[e.prop] = e.oldVal; _afterDocChange(); } },
  redo: (e) => { const L = doc.findLayer(e.layerId); if (L) { L[e.prop] = e.newVal; _afterDocChange(); } },
  refsLayer: (e, id) => e.layerId === id,
});
els.hueSlider.addEventListener("input", () => {
  pickerHsv.h = parseFloat(els.hueSlider.value);
  drawSvPad();
  commitPicker();
});
els.hexInput.addEventListener("change", () => {
  let v = els.hexInput.value.trim();
  if (!v.startsWith("#")) v = "#" + v;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    pickerSetFromHex(v);
    commitPicker();
  } else {
    setStatus("HEX 格式不对");
    els.hexInput.value = state.color;
  }
});
// SV pad pointer
let svDragging = false;
els.svPad.addEventListener("pointerdown", (e) => { svDragging = true; els.svPad.setPointerCapture(e.pointerId); pickFromSv(e); });
els.svPad.addEventListener("pointermove", (e) => { if (svDragging) pickFromSv(e); });
els.svPad.addEventListener("pointerup", (e) => { svDragging = false; });
function pickFromSv(e) {
  const r = els.svPad.getBoundingClientRect();
  const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
  const y = Math.max(0, Math.min(r.height, e.clientY - r.top));
  pickerHsv.s = x / r.width;
  pickerHsv.v = 1 - y / r.height;
  drawSvPad();
  commitPicker();
}
function drawSvPad() {
  const c = els.svPad;
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height;
  // 横向 = saturation，纵向 = 1-value
  // 用 hue 一种颜色 + 水平白渐 + 垂直黑渐
  ctx.fillStyle = `hsl(${pickerHsv.h} 100% 50%)`;
  ctx.fillRect(0, 0, w, h);
  const gx = ctx.createLinearGradient(0, 0, w, 0);
  gx.addColorStop(0, "rgba(255,255,255,1)");
  gx.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gx;
  ctx.fillRect(0, 0, w, h);
  const gy = ctx.createLinearGradient(0, 0, 0, h);
  gy.addColorStop(0, "rgba(0,0,0,0)");
  gy.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = gy;
  ctx.fillRect(0, 0, w, h);
  // marker
  const mx = pickerHsv.s * w;
  const my = (1 - pickerHsv.v) * h;
  ctx.strokeStyle = "rgba(0,0,0,0.65)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(mx, my, 6, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI * 2); ctx.stroke();
}
function commitPicker() {
  const hex = hsvToHex(pickerHsv.h, pickerHsv.s, pickerHsv.v);
  els.hexInput.value = hex;
  els.previewSwatch.style.background = hex;
  _suppressPickerSync = true;
  setColor(hex);
  _suppressPickerSync = false;
}
function pickerSetFromHex(hex) {
  const { h, s, v } = hexToHsv(hex);
  pickerHsv = { h, s, v };
  els.hueSlider.value = String(Math.round(h));
  els.hexInput.value = hex;
  els.previewSwatch.style.background = hex;
  drawSvPad();         // 不画的话 marker / hue band 都停在旧值，吸色看不出新颜色
}

// ---- color conv ----
function hsvToHex(h, s, v) {
  const c = v * s;
  const hp = (h / 60) % 6;
  const x = c * (1 - Math.abs(hp % 2 - 1));
  let r = 0, g = 0, b = 0;
  if (0 <= hp && hp < 1) { r = c; g = x; b = 0; }
  else if (1 <= hp && hp < 2) { r = x; g = c; b = 0; }
  else if (2 <= hp && hp < 3) { r = 0; g = c; b = x; }
  else if (3 <= hp && hp < 4) { r = 0; g = x; b = c; }
  else if (4 <= hp && hp < 5) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const m = v - c;
  const R = Math.round((r + m) * 255), G = Math.round((g + m) * 255), B = Math.round((b + m) * 255);
  return "#" + [R, G, B].map((n) => n.toString(16).padStart(2, "0")).join("");
}
function hexToHsv(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return { h: 0, s: 0, v: 0 };
  const R = parseInt(hex.slice(1, 3), 16) / 255;
  const G = parseInt(hex.slice(3, 5), 16) / 255;
  const B = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === R) h = ((G - B) / d) % 6;
    else if (mx === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = mx === 0 ? 0 : d / mx;
  const v = mx;
  return { h, s, v };
}

// ---- 持久化：IDB 自动 + Ctrl+S + autosave + visibility/pagehide 抢救 ----
// 抄 AtlasMaker shareback：Ctrl+S 主导 + 3min 兜底 + visibility/pagehide 抢救。
// 不走 debounce —— 画图工具不该 300ms 自动保存。
let _docDirty = false;
let _docSaving = false;
let _cloudPushing = false;     // 区分 IDB 写盘 vs 云端 push（按钮显示不同图标）
let _docLastSavedAt = 0;
// **幽灵 current path 保护**：内存里 _activeSessionName 只在 boot load 成功
// 或用户主动 open / new / save-as 后才升级到真实名字。boot 失败时保持
// safe default "未命名"，避免 save 走 rename-delete-old 路径误删。
let _activeSessionName = "未命名";
const AUTOSAVE_MS = 3 * 60 * 1000;

// v45 新语义：
//   **Ctrl+S / 点 save 按钮 = "save local + push cloud" 一把梭**（user 显式 consent）。
//   autosave (3min / visibility / pagehide) **仅写 IDB**，不触云 —— autosave
//   只防崩，IDB 是 transient（浏览器随时可能 evict / 用户清缓存），不算安全位置。
//   真正"安全"= 同步到云端。
//
//   Save 按钮 4 态：
//   - saving → 半透明
//   - dirty (本地未存) → 蓝色 disk + 角点
//   - cloud-dirty (IDB 已存但云端未同步) → 橙色上传箭头
//   - synced → 灰色对勾云（已安全）
//   - local-only (未登录云端) → 灰色 disk（提示 IDB 易失，建议登录）
//   点任意状态都触发 saveAndPush（dirty + cloud-dirty 一次性处理）。
//   冲突 (412) → alert 提示用户改名，本地已保存但云端没动。
const ICON_DISK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';
const ICON_UPLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const ICON_CLOUD_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 13 11 15 15 11"/></svg>';
// 上传中：云形 + 旋转的弧。CSS animation rotate 由 [data-state="cloud-busy"] 触发
const ICON_CLOUD_BUSY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><g class="spin-arc" style="transform-origin: 12px 13px;"><path d="M9 13a3 3 0 0 1 5.5-1.6" /><polyline points="14.5 9.5 14.5 11.4 12.6 11.4" /></g></svg>';

function computeSaveState() {
  if (_cloudPushing) return "cloud-busy";
  if (_docSaving) return "saving";
  if (_docDirty) return "dirty";
  if (isSignedIn() && isCloudDirty(_activeSessionName)) return "cloud-dirty";
  if (isSignedIn()) return "synced";
  return "local-only";
}
function updateSaveStatus() {
  const state = computeSaveState();
  els.topSaveBtn.dataset.state = state;
  const name = _activeSessionName;
  if (state === "cloud-busy") { els.topSaveBtn.innerHTML = ICON_CLOUD_BUSY; els.topSaveBtn.title = `上传中… · ${name}`; }
  else if (state === "saving")      { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `保存中… · ${name}`; }
  else if (state === "dirty")  { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `保存 + 推送 (Ctrl+S) · ${name} · 未保存`; }
  else if (state === "cloud-dirty") { els.topSaveBtn.innerHTML = ICON_UPLOAD; els.topSaveBtn.title = `推送到云端 (Ctrl+S) · ${name} · 本地已存，云端未同步`; }
  else if (state === "synced") { els.topSaveBtn.innerHTML = ICON_CLOUD_CHECK; els.topSaveBtn.title = `已同步到云端 · ${name}`; }
  else                          { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `已存本地（IDB 易失，登录云端更安全） · ${name}`; }
}
async function saveNow() {
  if (_docSaving) return;
  _docSaving = true;
  updateSaveStatus();
  try {
    await saveSession(doc, _activeSessionName, {
      referenceImage: referenceWindow.getPersistBlob(),
      webpaintState: { reference: referenceWindow.getSerializedState() },
    });
    _docDirty = false;
    _docLastSavedAt = Date.now();
    setStatus(`已保存：${_activeSessionName}`);
  } catch (e) {
    console.warn("[session] save failed:", e);
    setStatus("保存失败：" + (e && e.message || e));
  } finally {
    _docSaving = false;
    updateSaveStatus();
  }
}

// 把 loaded doc 的内容塞回 live doc（保持指针，避免到处换引用）
// **不**调 board.fitToScreen —— 保留用户当前视口（zoom / pan），切 session 不重置
function adoptLoadedDoc(loaded, sessionName) {
  doc.layers = loaded.layers;
  doc.activeIndex = loaded.activeIndex;
  doc.width = loaded.width;
  doc.height = loaded.height;
  doc.backgroundColor = loaded.backgroundColor;
  els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
  input.clearHistory();
  board.invalidateAll();
  board.requestRender();
  renderLayersPanel();
  _activeSessionName = sessionName;
  setCurrentSessionName(sessionName);
  _docDirty = false;
  _docLastSavedAt = Date.now();
  updateSaveStatus();
  // 恢复 reference 小窗（.ora webpaint/ 扩展）
  if (loaded._referenceBlob) {
    createImageBitmap(loaded._referenceBlob).then((bitmap) => {
      referenceWindow.setBitmap(bitmap, { persistBlob: loaded._referenceBlob });
      // 图就绪后再应用 viewport + open（applySerializedState 顺序无关，但 fitToPanel 在
      // setBitmap 里会被调用 → 应用 viewport 后用户保存时的 vp 才生效）
      if (loaded._webpaintState?.reference) {
        referenceWindow.applySerializedState(loaded._webpaintState.reference);
      }
    }).catch(() => {});
  } else {
    referenceWindow.clearBitmap();
    if (loaded._webpaintState?.reference) {
      referenceWindow.applySerializedState(loaded._webpaintState.reference);
    }
  }
}
// 笔触结束 / undo / redo / 图层操作（任何 wp:histchange）→ dirty
window.addEventListener("wp:histchange", () => {
  _docDirty = true;
  // 任何编辑 → 云端也变 dirty（待 push）
  if (isSignedIn()) setCloudDirty(_activeSessionName, true);
  updateSaveStatus();
});
// **Ctrl+S / 点 save 按钮** = 完全保存（local IDB + push cloud）。
// user 显式 consent + 在场 → 触云。autosave / visibility / pagehide
// 走 saveNow（仅 IDB），不触云。详见 docs/persistence-and-encryption-shareback.md。
async function saveAndPush() {
  if (_docSaving) return;
  // 1) local IDB
  if (_docDirty) await saveNow();
  // 2) push cloud（user 在场 + 已登录 + 在线 + 云端未同步）
  // 离线时跳过推送（不要弹错；本地已存，回到在线再 save 一次自动推）
  if (isSignedIn() && navigator.onLine === false && isCloudDirty(_activeSessionName)) {
    setStatus(`已存本地：${_activeSessionName}（离线，回到在线再 Ctrl+S 推云端）`);
    return;
  }
  if (isSignedIn() && isCloudDirty(_activeSessionName)) {
    _cloudPushing = true;
    updateSaveStatus();
    try {
      const ora = await encodeDocToOra(doc, {
        referenceImage: referenceWindow.getPersistBlob(),
        webpaintState: { reference: referenceWindow.getSerializedState() },
      });
      await pushSession(_activeSessionName, ora);
      setStatus(`已同步到云端：${_activeSessionName}`);
      renderGallery();
    } catch (e) {
      if (e instanceof CloudConflictError) {
        // 云端有同名 → inline 弹改名 sheet（不再让用户去图库找）
        setStatus(`云端有同名 "${_activeSessionName}"，改个名再推`, true);
        _cloudPushing = false;
        updateSaveStatus();
        const newName = await renameCurrentSession({ suggested: _activeSessionName + " (新)", reason: "云端冲突" });
        if (newName && isSignedIn()) {
          setCloudDirty(newName, true);
          queueSave("push");        // 走 coalesce 路径自动重试
        }
        return;
      } else {
        console.warn("[cloud] push failed:", e);
        setStatus("推送失败：" + (e && e.message || e));
      }
    } finally {
      _cloudPushing = false;
      updateSaveStatus();
    }
  } else if (!isSignedIn() && !_docDirty) {
    setStatus(`已存本地：${_activeSessionName}（IDB 易失，登录云端更安全）`);
  }
}

// 重命名当前 active session。在画画界面也能调（汉堡菜单），云冲突时也会自动弹。
// 同名循环检查（local 范围）；返回新名（或 null 取消 / 失败）。
async function renameCurrentSession({ suggested, reason } = {}) {
  const oldName = _activeSessionName;
  let candidate = suggested || oldName;
  // 循环直到 user 给出可用名 / 取消
  while (true) {
    const title = reason ? `重命名（${reason}）` : "重命名当前画作";
    const input = await openInputSheet(title, candidate, { placeholder: "作品名字" });
    if (input === null) return null;
    const trimmed = input.trim();
    if (!trimmed) { setStatus("名字不能空", true); candidate = ""; continue; }
    if (trimmed === oldName) return oldName;       // 没改 = 等于成功
    // local 同名检查
    const localNames = (await listSessions()).map((s) => s.name);
    if (localNames.includes(trimmed)) {
      setStatus(`本地已有同名 "${trimmed}"，换一个`, true);
      candidate = trimmed;
      continue;
    }
    // 干活：先存新名，再删旧名（feedback-phantom-current-path：oldName 是 actually-loaded 的）
    try {
      await saveSession(doc, trimmed, {
        referenceImage: referenceWindow.getPersistBlob(),
        webpaintState: { reference: referenceWindow.getSerializedState() },
      });
      if (oldName && oldName !== trimmed) {
        try { await removeSession(oldName); } catch {}
      }
      _activeSessionName = trimmed;
      setCurrentSessionName(trimmed);
      _docDirty = false;
      _docLastSavedAt = Date.now();
      updateSaveStatus();
      setStatus(`已重命名：${oldName} → ${trimmed}`);
      return trimmed;
    } catch (e) {
      setStatus("重命名失败：" + (e && e.message || e));
      return null;
    }
  }
}

// Ctrl+S = 完整保存（本地 + 云端）；Ctrl+Shift+S = 只存本地（不推云）
//
// **Coalesce**（user 2026-05-28）：连按 Ctrl+S 不并行串 N 次。
//   - 当前没在跑 → 立刻跑
//   - 当前在跑 + 中间没新编辑 + 同类型 → no-op（state 没变，省一次空转）
//   - 当前在跑 + 中间新编辑了 → queue 一个 pending，in-flight 完成后跑
//   - 当前在跑 local-only + 用户改主意 push → queue push（云端还没覆盖）
//   - pending 升级规则：push 覆盖 local（再多按几次也只一个尾巴）
let _savePending = null;             // null | "local" | "push"
let _inFlightSaveType = null;        // "local" | "push" | null
let _editVersion = 0;
let _inFlightStartVersion = 0;
window.addEventListener("wp:histchange", () => { _editVersion++; });

function queueSave(type) {
  if (!_inFlightSaveType) {
    runQueuedSave(type);
    return;
  }
  const hasNewEdits = _editVersion !== _inFlightStartVersion;
  // 决定要不要 queue 尾巴：
  //   in-flight local + 用户按 push → queue push（云端还没推）
  //   其他情况只看是否中间真有新编辑
  let shouldQueue;
  if (_inFlightSaveType === "local" && type === "push") shouldQueue = true;
  else shouldQueue = hasNewEdits;
  if (!shouldQueue) return;
  if (type === "push" || _savePending !== "push") _savePending = type;
}

async function runQueuedSave(type) {
  _inFlightSaveType = type;
  _inFlightStartVersion = _editVersion;
  try {
    if (type === "push") await saveAndPush();
    else await saveNow();
  } finally {
    _inFlightSaveType = null;
    if (_savePending) {
      const next = _savePending;
      _savePending = null;
      runQueuedSave(next);             // 不 await，避免递归栈
    }
  }
}

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    queueSave(e.shiftKey ? "local" : "push");
  }
});
// 3 min 兜底
setInterval(() => { if (_docDirty && !_docSaving) saveNow(); }, AUTOSAVE_MS);
// visibility / pagehide 抢救
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && _docDirty && !_docSaving) saveNow();
});
window.addEventListener("pagehide", () => {
  // pagehide 是同步语境，但 IDB tx 仍能在 page 真被关之前完成（浏览器 grace ~几百 ms）
  if (_docDirty && !_docSaving) saveNow();
});

// 菜单：保存 / 分享 / 导出
function stampNow() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}-${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}`;
}
// ---- topbar：save/upload + gallery ----
// 点 save 按钮 = saveAndPush 一把梭（同 Ctrl+S）。state == "synced" 时
// 也跑一遍（no-op fast path）让 user 永远不需要"再点一下"。
els.topSaveBtn.addEventListener("click", () => queueSave("push"));

// ---- topbar：adjustments popup（液化 / 后续调色 etc）----
// 单按钮 → 弹一列 menu-item（同 menuPanel 模式）。学 Procreate adjustments icon。
function setAdjustOpen(open) {
  els.adjustPopup.classList.toggle("hidden", !open);
  els.topAdjustBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    // 锚到按钮下方右对齐
    const r = els.topAdjustBtn.getBoundingClientRect();
    const w = els.adjustPopup.offsetWidth || 200;
    els.adjustPopup.style.top = (r.bottom + 4) + "px";
    els.adjustPopup.style.right = (window.innerWidth - r.right) + "px";
    els.adjustPopup.style.left = "auto";
  }
}
els.topAdjustBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setAdjustOpen(els.adjustPopup.classList.contains("hidden"));
});
document.addEventListener("pointerdown", (e) => {
  if (els.adjustPopup.classList.contains("hidden")) return;
  if (els.adjustPopup.contains(e.target) || els.topAdjustBtn.contains(e.target)) return;
  setAdjustOpen(false);
});
els.adjustLiquify.addEventListener("click", () => {
  setAdjustOpen(false);
  setTool("liquify");
  toggleLiquifyPanel(true);
  setStatus("液化");
});

// ---- 菜单：图库（v46 从 topbar 迁下来，避免误点）----
els.menuGallery.addEventListener("click", () => {
  setMenuOpen(false);
  setGalleryOpen(true);
});

// ---- 菜单：导入 / 导出 / 剪贴板 / 适应 ----
els.menuRename.addEventListener("click", () => {
  setMenuOpen(false);
  renameCurrentSession();
});
els.menuImport.addEventListener("click", () => {
  setMenuOpen(false);
  els.oraFileInput.value = "";
  els.oraFileInput.click();
});
els.menuExportPng.addEventListener("click", async () => {
  setMenuOpen(false);
  try {
    const r = await shareOrDownloadImage(doc, "png", `${_activeSessionName}-${stampNow()}`);
    setStatus(r.method === "share" ? "分享面板已开" : r.method === "cancel" ? "取消分享" : "PNG 已下载");
  } catch (e) { setStatus("导出失败：" + (e && e.message || e)); }
});
els.menuExportJpg.addEventListener("click", async () => {
  setMenuOpen(false);
  try {
    const r = await shareOrDownloadImage(doc, "jpg", `${_activeSessionName}-${stampNow()}`);
    setStatus(r.method === "share" ? "分享面板已开" : r.method === "cancel" ? "取消分享" : "JPG 已下载");
  } catch (e) { setStatus("导出失败：" + (e && e.message || e)); }
});
els.menuExportOra.addEventListener("click", async () => {
  setMenuOpen(false);
  try {
    await exportOraDownload(doc, `${_activeSessionName}.ora`);
    setStatus(".ora 已下载");
  } catch (e) { setStatus("导出失败：" + (e && e.message || e)); }
});
els.menuExportPsd.addEventListener("click", async () => {
  setMenuOpen(false);
  setStatus("PSD 编码中…", true);
  try {
    await exportPsdDownload(doc, `${_activeSessionName}.psd`);
    setStatus(".psd 已下载");
  } catch (e) {
    console.warn("[psd] export failed:", e);
    setStatus("PSD 导出失败：" + (e && e.message || e));
  }
});
els.menuClipboardCopy.addEventListener("click", async () => {
  setMenuOpen(false);
  try {
    await copyImageToClipboard(doc);
    setStatus("已复制 PNG 到剪贴板");
  } catch (e) { setStatus("复制失败：" + (e && e.message || e)); }
});
els.menuClipboardPaste.addEventListener("click", async () => {
  setMenuOpen(false);
  try {
    const blob = await readImageFromClipboard();
    if (!blob) { setStatus("剪贴板里没有图片"); return; }
    // 包装成 File 给 importImageAsLayer 复用
    const fakeFile = new File([blob], "clipboard.png", { type: blob.type || "image/png" });
    await importImageAsLayer(fakeFile);
  } catch (e) { setStatus("从剪贴板粘贴失败：" + (e && e.message || e)); }
});
els.menuFit.addEventListener("click", () => {
  setMenuOpen(false);
  board.fitToScreen();
  updateZoomLabel();
  setStatus("适应屏幕");
});

// ---- 笔刷平滑设置面板 ----
function toggleBrushPanel(force) {
  const hidden = els.brushPanel.classList.contains("hidden");
  const show = force === true ? true : force === false ? false : hidden;
  els.brushPanel.classList.toggle("hidden", !show);
  if (show) {
    syncBrushPanelFromState();
    // 还原位置 / 默认右上
    const saved = safeLS("webpaint.brushPanel.pos");
    const w = els.brushPanel.offsetWidth || 280;
    let left, top;
    if (saved) { try { const o = JSON.parse(saved); left = o.left; top = o.top; } catch { left = top = null; } }
    if (left == null) { left = window.innerWidth - w - 16; top = 60; }
    els.brushPanel.style.left = Math.max(0, Math.min(window.innerWidth - w, left)) + "px";
    els.brushPanel.style.top = Math.max(0, top) + "px";
  }
}
els.menuBrushSettings.addEventListener("click", () => {
  setMenuOpen(false);
  toggleBrushPanel(true);
});
els.brushPanelClose.addEventListener("click", () => toggleBrushPanel(false));

// 拖标题栏移动（沿用 color panel 模式）
let _brushPanelDrag = null;
els.brushPanelHead.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".float-panel-close")) return;
  const r = els.brushPanel.getBoundingClientRect();
  _brushPanelDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
  els.brushPanelHead.setPointerCapture(e.pointerId);
  e.preventDefault();
});
els.brushPanelHead.addEventListener("pointermove", (e) => {
  if (!_brushPanelDrag || e.pointerId !== _brushPanelDrag.id) return;
  const w = els.brushPanel.offsetWidth, h = els.brushPanel.offsetHeight;
  const left = Math.max(0, Math.min(window.innerWidth - w, _brushPanelDrag.ol + (e.clientX - _brushPanelDrag.sx)));
  const top  = Math.max(0, Math.min(window.innerHeight - h, _brushPanelDrag.ot + (e.clientY - _brushPanelDrag.sy)));
  els.brushPanel.style.left = left + "px";
  els.brushPanel.style.top = top + "px";
  safeLSSet("webpaint.brushPanel.pos", JSON.stringify({ left, top }));
});
els.brushPanelHead.addEventListener("pointerup", (e) => {
  if (_brushPanelDrag && e.pointerId === _brushPanelDrag.id) {
    try { els.brushPanelHead.releasePointerCapture(e.pointerId); } catch {}
    _brushPanelDrag = null;
  }
});

function syncBrushPanelFromState() {
  const b = state.brush;
  els.brushStreamline.value = String(Math.round(b.streamline * 100));
  els.brushStreamlineVal.textContent = String(Math.round(b.streamline * 100));
  els.brushStabilization.value = String(Math.round(b.stabilization * 100));
  els.brushStabilizationVal.textContent = String(Math.round(b.stabilization * 100));
  els.brushPullStabilizer.value = String(Math.round(b.pullStabilizer * 100));
  els.brushPullStabilizerVal.textContent = String(Math.round(b.pullStabilizer * 100));
  els.brushMotionFilter.value = String(Math.round(b.motionFilter * 100));
  els.brushMotionFilterVal.textContent = String(Math.round(b.motionFilter * 100));
}

function bindBrushSlider(input, label, lsKey, field) {
  input.addEventListener("input", () => {
    const v = parseFloat(input.value) / 100;
    state.brush[field] = v;
    label.textContent = String(Math.round(v * 100));
    safeLSSet(lsKey, String(v));
  });
}
bindBrushSlider(els.brushStreamline, els.brushStreamlineVal, "webpaint.streamline", "streamline");
bindBrushSlider(els.brushStabilization, els.brushStabilizationVal, "webpaint.stabilization", "stabilization");
bindBrushSlider(els.brushPullStabilizer, els.brushPullStabilizerVal, "webpaint.pullStabilizer", "pullStabilizer");
bindBrushSlider(els.brushMotionFilter, els.brushMotionFilterVal, "webpaint.motionFilter", "motionFilter");

// ---- 液化设置面板 ----
function toggleLiquifyPanel(force) {
  const hidden = els.liquifyPanel.classList.contains("hidden");
  const show = force === true ? true : force === false ? false : hidden;
  els.liquifyPanel.classList.toggle("hidden", !show);
  if (show) {
    syncLiquifyPanelFromState();
    const saved = safeLS("webpaint.liquifyPanel.pos");
    const w = els.liquifyPanel.offsetWidth || 280;
    let left, top;
    if (saved) { try { const o = JSON.parse(saved); left = o.left; top = o.top; } catch { left = top = null; } }
    if (left == null) { left = window.innerWidth - w - 16; top = 60; }
    els.liquifyPanel.style.left = Math.max(0, Math.min(window.innerWidth - w, left)) + "px";
    els.liquifyPanel.style.top = Math.max(0, top) + "px";
  }
}
els.liquifyPanelClose.addEventListener("click", () => toggleLiquifyPanel(false));

let _liquifyPanelDrag = null;
els.liquifyPanelHead.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".float-panel-close")) return;
  const r = els.liquifyPanel.getBoundingClientRect();
  _liquifyPanelDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
  els.liquifyPanelHead.setPointerCapture(e.pointerId);
  e.preventDefault();
});
els.liquifyPanelHead.addEventListener("pointermove", (e) => {
  if (!_liquifyPanelDrag || e.pointerId !== _liquifyPanelDrag.id) return;
  const w = els.liquifyPanel.offsetWidth, h = els.liquifyPanel.offsetHeight;
  const left = Math.max(0, Math.min(window.innerWidth - w, _liquifyPanelDrag.ol + (e.clientX - _liquifyPanelDrag.sx)));
  const top  = Math.max(0, Math.min(window.innerHeight - h, _liquifyPanelDrag.ot + (e.clientY - _liquifyPanelDrag.sy)));
  els.liquifyPanel.style.left = left + "px";
  els.liquifyPanel.style.top = top + "px";
  safeLSSet("webpaint.liquifyPanel.pos", JSON.stringify({ left, top }));
});
els.liquifyPanelHead.addEventListener("pointerup", (e) => {
  if (_liquifyPanelDrag && e.pointerId === _liquifyPanelDrag.id) {
    try { els.liquifyPanelHead.releasePointerCapture(e.pointerId); } catch {}
    _liquifyPanelDrag = null;
  }
});

function syncLiquifyPanelFromState() {
  const q = state.liquify;
  els.liquifyMode.value = q.mode;
  els.liquifySize.value = String(Math.round(q.size));
  els.liquifySizeVal.textContent = String(Math.round(q.size));
  els.liquifyStrength.value = String(Math.round(q.strength * 100));
  els.liquifyStrengthVal.textContent = String(Math.round(q.strength * 100));
}
els.liquifyMode.addEventListener("change", () => {
  state.liquify.mode = els.liquifyMode.value;
  safeLSSet("webpaint.liquify.mode", state.liquify.mode);
});
els.liquifySize.addEventListener("input", () => {
  const v = parseFloat(els.liquifySize.value);
  state.liquify.size = v;
  els.liquifySizeVal.textContent = String(Math.round(v));
  safeLSSet("webpaint.liquify.size", String(v));
});
els.liquifyStrength.addEventListener("input", () => {
  const v = parseFloat(els.liquifyStrength.value) / 100;
  state.liquify.strength = v;
  els.liquifyStrengthVal.textContent = String(Math.round(v * 100));
  safeLSSet("webpaint.liquify.strength", String(v));
});

// ---- 参考小窗 ----
// 浮动 panel + 独立 viewport（pinch / zoom / rotate）。状态在 ReferenceWindow 内部维护。
const referenceWindow = new ReferenceWindow({
  panel: els.referencePanel,
  head: els.referencePanelHead,
  body: els.referenceBody,
  canvas: els.referenceCanvas,
  closeBtn: els.referencePanelClose,
  emptyHint: els.referenceEmpty,
  status: setStatus,
});
els.menuReference.addEventListener("click", () => {
  setMenuOpen(false);
  referenceWindow.open();
});
els.referenceLoadBtn.addEventListener("click", () => {
  els.referenceFileInput.value = "";
  els.referenceFileInput.click();
});
els.referenceFileInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const bitmap = await createImageBitmap(file);
    // 留 file 原 Blob 作持久化源 → 跟着当前 doc 一起进 .ora
    referenceWindow.setBitmap(bitmap, { persistBlob: file });
    _docDirty = true;
    updateSaveStatus();
    window.dispatchEvent(new CustomEvent("wp:histchange", { detail: { canUndo: input.canUndo(), canRedo: input.canRedo() } }));
    setStatus(`参考：${file.name}（会跟当前画一起保存）`);
  } catch (err) {
    setStatus("参考图载入失败：" + (err && err.message || err));
  }
});
els.referenceLiveBtn.addEventListener("click", () => {
  referenceWindow.toggleLive(doc);
  els.referenceLiveBtn.setAttribute("aria-pressed", referenceWindow.isLive() ? "true" : "false");
  setStatus(referenceWindow.isLive() ? "参考小窗：实时镜像主画布" : "参考小窗：已退出实时模式");
});
els.referenceFitBtn.addEventListener("click", () => referenceWindow.fitToPanel());

els.oraFileInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  // 图库里"导入照片"语义：把照片当新 doc 打底（不是叠到当前）
  const asNewDoc = _addImportAsNewDoc;
  _addImportAsNewDoc = false;
  if (!file) return;
  const isOra = /\.ora$/i.test(file.name);
  const isImage = (file.type || "").startsWith("image/");
  try {
    if (isOra) {
      const loaded = await decodeOraToDoc(file);
      const nm = file.name.replace(/\.ora$/i, "") || "未命名";
      adoptLoadedDoc(loaded, nm);
      setStatus(`已导入：${nm}`);
      setGalleryOpen(false);
    } else if (isImage) {
      if (asNewDoc) {
        await importImageAsNewDoc(file);
        setGalleryOpen(false);
      } else {
        await importImageAsLayer(file);
      }
    } else {
      setStatus(`不支持的文件类型：${file.type || file.name}`);
    }
  } catch (err) {
    console.warn("[import] failed:", err);
    setStatus("导入失败：" + (err && err.message || err));
  }
});

// 「导入照片」语义：用照片新建一个 doc（doc 尺寸 = 照片尺寸，cap 8192），
// 单层就是这张照片。和"导入图片 / .ora"（叠新图层到当前 doc）不同。
async function importImageAsNewDoc(file) {
  const bitmap = await createImageBitmap(file);
  const w = Math.min(8192, bitmap.width);
  const h = Math.min(8192, bitmap.height);
  if (_docDirty) await saveNow();
  const fresh = new PaintDoc({ width: w, height: h });
  doc.layers = fresh.layers;
  doc.activeIndex = 0;
  doc.width = w; doc.height = h;
  els.canvasSizeLabel.textContent = `${w}×${h}`;
  // 把照片直接画到 base layer 全图（覆盖 bbox 到整 doc）
  const layer = doc.layers[0];
  layer.name = file.name.replace(/\.[^.]+$/, "") || "图像";
  layer.bboxX = 0; layer.bboxY = 0;
  layer.bboxW = w; layer.bboxH = h;
  const c = (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(w, h)
    : (() => { const x = document.createElement("canvas"); x.width = w; x.height = h; return x; })();
  layer.canvas = c;
  layer.ctx = c.getContext("2d", { willReadFrequently: false });
  layer.ctx.imageSmoothingEnabled = true;
  layer.ctx.imageSmoothingQuality = "high";
  layer.ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const stem = file.name.replace(/\.[^.]+$/, "") || "导入";
  const name = await uniqueLocalName(stem);
  _activeSessionName = name;
  setCurrentSessionName(name);
  input.clearHistory();
  board.invalidateAll();
  board.fitToScreen();
  renderLayersPanel();
  _docDirty = true;
  _docLastSavedAt = 0;
  updateSaveStatus();
  await saveNow();
  setStatus(`新建（照片）：${name}（${w}×${h}）`);
}

// 把图片当一个新图层叠进当前 doc（photobash / 参考图工作流）。
// 居中对齐；如果图片比 doc 大，按比例缩到 80% 短边，避免一上来就盖死。
async function importImageAsLayer(file) {
  const bitmap = await createImageBitmap(file);
  const docW = doc.width, docH = doc.height;
  let w = bitmap.width, h = bitmap.height;
  if (w > docW || h > docH) {
    const s = Math.min(docW / w, docH / h) * 0.8;
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
  }
  // 新建空层
  const layer = doc.addLayer(file.name.replace(/\.[^.]+$/, ""));
  if (!layer) {
    bitmap.close?.();
    setStatus(`图层已达上限 (${doc.maxLayers})，无法导入`);
    return;
  }
  // bbox 放在 doc 中心
  layer.bboxX = Math.floor((docW - w) / 2);
  layer.bboxY = Math.floor((docH - h) / 2);
  layer.bboxW = w;
  layer.bboxH = h;
  const c = (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(w, h)
    : (() => { const x = document.createElement("canvas"); x.width = w; x.height = h; return x; })();
  layer.canvas = c;
  layer.ctx = c.getContext("2d", { willReadFrequently: false });
  layer.ctx.imageSmoothingEnabled = true;
  layer.ctx.imageSmoothingQuality = "high";
  layer.ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
  _docDirty = true;
  updateSaveStatus();
  // 触发 wp:histchange 让保存状态同步
  window.dispatchEvent(new CustomEvent("wp:histchange", { detail: { canUndo: input.canUndo(), canRedo: input.canRedo() } }));
  setStatus(`已导入为新图层：${file.name}`);
}

// ---- 图库 全屏（v50 重做：无返回键、底栏 IDB 占用 + 清扫、加号 popup、云图标 popup） ----
// 进入和退出都触发 saveNow。进入后把主画布 UI 全 disable（body[data-mode="gallery"]）。
// 退出 = 点 active tile，或选择另一个 tile / 新建 / 导入照片 / 拉云图。
let _galleryUrls = [];
async function setGalleryOpen(open) {
  if (open) {
    // 进图库 = 立即保存当前 doc 到本地（用户离开编辑场景）
    if (_docDirty && !_docSaving) await saveNow();
    document.body.dataset.mode = "gallery";
    els.galleryFull.classList.remove("hidden");
    renderGallery();
    updateIdbUsage();
  } else {
    // 退图库 = 同样兜底保存一次
    if (_docDirty && !_docSaving) await saveNow();
    els.galleryFull.classList.add("hidden");
    delete document.body.dataset.mode;
    for (const u of _galleryUrls) URL.revokeObjectURL(u);
    _galleryUrls = [];
    // 关闭可能打开的 popup
    els.galleryAddPopup.classList.add("hidden");
    els.cloudAccountPopup.classList.add("hidden");
    board.requestRender();
  }
}

// 加号 popup
els.galleryCloseBtn.addEventListener("click", () => setGalleryOpen(false));
els.galleryAddBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const hidden = els.galleryAddPopup.classList.contains("hidden");
  els.cloudAccountPopup.classList.add("hidden");
  els.galleryAddPopup.classList.toggle("hidden", !hidden);
  if (hidden) anchorPopupToBtn(els.galleryAddPopup, els.galleryAddBtn);
  els.galleryAddBtn.setAttribute("aria-expanded", hidden ? "true" : "false");
});
// 云 icon popup
els.cloudIconBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const hidden = els.cloudAccountPopup.classList.contains("hidden");
  els.galleryAddPopup.classList.add("hidden");
  els.cloudAccountPopup.classList.toggle("hidden", !hidden);
  if (hidden) anchorPopupToBtn(els.cloudAccountPopup, els.cloudIconBtn);
  els.cloudIconBtn.setAttribute("aria-expanded", hidden ? "true" : "false");
});
document.addEventListener("pointerdown", (e) => {
  if (!els.galleryAddPopup.classList.contains("hidden") &&
      !els.galleryAddPopup.contains(e.target) &&
      !els.galleryAddBtn.contains(e.target)) {
    els.galleryAddPopup.classList.add("hidden");
  }
  if (!els.cloudAccountPopup.classList.contains("hidden") &&
      !els.cloudAccountPopup.contains(e.target) &&
      !els.cloudIconBtn.contains(e.target)) {
    els.cloudAccountPopup.classList.add("hidden");
  }
});
function anchorPopupToBtn(popup, btn) {
  const r = btn.getBoundingClientRect();
  popup.style.position = "fixed";
  popup.style.top = (r.bottom + 4) + "px";
  popup.style.right = (window.innerWidth - r.right) + "px";
  popup.style.left = "auto";
}

// 加号 → 新建：弹 sheet 选名字 + 分辨率
els.addNew.addEventListener("click", () => {
  els.galleryAddPopup.classList.add("hidden");
  openNewDocSheet();
});
els.addImportPhoto.addEventListener("click", () => {
  els.galleryAddPopup.classList.add("hidden");
  // 复用 oraFileInput 但限定 accept = image only。实际上 oraFileInput accept 包含 image
  els.oraFileInput.value = "";
  els.oraFileInput.click();
  // 上面的 onchange 会路由到 importImageAsLayer / decodeOraToDoc
  // 但用户语义是"新建作品打底"，所以新建一个 doc 把 image 当 base layer 放进去
  // 标记一个 pending flag
  _addImportAsNewDoc = true;
});
let _addImportAsNewDoc = false;

// 新建作品 sheet
function openNewDocSheet() {
  els.newDocName.value = "未命名";
  els.newDocPreset.value = "2048";
  els.newDocCustomRow.style.display = "none";
  els.newDocW.value = doc.width;
  els.newDocH.value = doc.height;
  els.newDocBackdrop.classList.remove("hidden");
  els.newDocSheet.classList.remove("hidden");
  setTimeout(() => els.newDocName.focus(), 50);
}
function closeNewDocSheet() {
  els.newDocBackdrop.classList.add("hidden");
  els.newDocSheet.classList.add("hidden");
}
els.newDocPreset.addEventListener("change", () => {
  els.newDocCustomRow.style.display = els.newDocPreset.value === "custom" ? "" : "none";
});
els.newDocBackdrop.addEventListener("click", closeNewDocSheet);
els.newDocCancel.addEventListener("click", closeNewDocSheet);
els.newDocConfirm.addEventListener("click", async () => {
  const nameRaw = (els.newDocName.value || "").trim() || "未命名";
  let w, h;
  if (els.newDocPreset.value === "custom") {
    w = Math.max(64, Math.min(8192, parseInt(els.newDocW.value, 10) || 2048));
    h = Math.max(64, Math.min(8192, parseInt(els.newDocH.value, 10) || 2048));
  } else {
    w = h = parseInt(els.newDocPreset.value, 10);
  }
  const name = await uniqueLocalName(nameRaw);
  closeNewDocSheet();
  if (_docDirty) await saveNow();
  const fresh = new PaintDoc({ width: w, height: h });
  doc.layers = fresh.layers;
  doc.activeIndex = 0;
  doc.width = w; doc.height = h;
  els.canvasSizeLabel.textContent = `${w}×${h}`;
  _activeSessionName = name;
  setCurrentSessionName(name);
  input.clearHistory();
  board.invalidateAll();
  board.fitToScreen();
  renderLayersPanel();
  _docDirty = true;
  _docLastSavedAt = 0;
  updateSaveStatus();
  await saveNow();
  setGalleryOpen(false);
  setStatus(`新建：${name}（${w}×${h}）`);
});

// 本地占用 = 实际所有 IDB session blob 大小之和（**不**走 storage.estimate —— 它把 SW
// 预缓存 / localStorage 算进去虚高几 MB）。
// quota 来自 storage.estimate，是**浏览器愿意分配的上限**（iOS Safari 通常 ~ 60-80% 可用
// 磁盘；动辄几十 GB），不是 "我们申请了多少"。所以放 title 里给好奇用户看，不主显。
async function updateIdbUsage() {
  try {
    const sessions = await listSessions();
    let total = 0;
    for (const s of sessions) total += (s.size || 0);
    els.galleryFootUsage.textContent = `本地占用：${humanSize(total)}（${sessions.length} 件）`;
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est && est.quota) {
        els.galleryFootUsage.title = `浏览器分配上限约 ${humanSize(est.quota)}（用满了浏览器才会限）`;
      }
    }
  } catch {
    els.galleryFootUsage.textContent = "占用：未知";
  }
}

async function renderGallery() {
  updateCloudAuthUI();
  updateIdbUsage();
  for (const u of _galleryUrls) URL.revokeObjectURL(u);
  _galleryUrls = [];

  // listSessions 在 IDB 被禁（隐私窗口 / 配额耗尽 / 浏览器策略）时会抛。
  // 这时图库没法用是合理结果，但要给个明确状态消息（原代码静默死掉）。
  let local = [];
  try { local = await listSessions(); }
  catch (e) {
    console.error("[gallery] listSessions failed:", e);
    setStatus("本地图库读取失败：" + (e && e.message || e) + "（可能是隐私窗口 / IDB 被禁）", true);
  }
  // 云端：仅在登录 + 在线 时尝试。navigator.onLine === false 几乎确定离线，跳网络省超时
  let cloud = [];
  if (isSignedIn() && navigator.onLine !== false) {
    try { cloud = await listCloudSessionsRecursive(); }
    catch (e) { console.warn("[cloud] list failed:", e); }
  }
  // 合并：用 name (无 .ora 后缀) 当 key
  const byName = new Map();
  for (const l of local) {
    byName.set(l.name, { name: l.name, local: l, cloud: null });
  }
  for (const c of cloud) {
    const name = c.path.replace(/\.ora$/i, "");
    const ent = byName.get(name);
    if (ent) ent.cloud = c;
    else byName.set(name, { name, local: null, cloud: c });
  }
  const merged = [...byName.values()];
  merged.sort((a, b) => {
    const ta = (a.local?.updatedAt) || Date.parse(a.cloud?.lastModifiedDateTime || 0);
    const tb = (b.local?.updatedAt) || Date.parse(b.cloud?.lastModifiedDateTime || 0);
    return tb - ta;
  });

  els.galleryGrid.innerHTML = "";
  if (merged.length === 0) {
    els.galleryEmpty.classList.remove("hidden");
    els.galleryGrid.style.display = "none";
    return;
  }
  els.galleryEmpty.classList.add("hidden");
  els.galleryGrid.style.display = "";

  for (const item of merged) {
    const isLocal = !!item.local;
    const isCloud = !!item.cloud;
    const tile = document.createElement("div");
    tile.className = "gallery-tile" + (item.name === _activeSessionName ? " active" : "");

    // 缩略图：local thumb 优先；纯云端用云朵 SVG 占位；纯本地无 thumb 用名字首字
    let thumbEl;
    if (isLocal && item.local.thumb) {
      thumbEl = document.createElement("img");
      thumbEl.className = "gallery-tile-thumb";
      thumbEl.alt = item.name;
      const url = URL.createObjectURL(item.local.thumb);
      _galleryUrls.push(url);
      thumbEl.src = url;
      thumbEl.loading = "lazy";
    } else {
      thumbEl = document.createElement("div");
      thumbEl.className = "gallery-tile-thumb placeholder";
      if (isCloud) {
        thumbEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:48px;height:48px;"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
      } else {
        thumbEl.textContent = (item.name.slice(0, 1) || "?");
      }
    }
    tile.appendChild(thumbEl);

    const info = document.createElement("div");
    info.className = "gallery-tile-info";
    const nm = document.createElement("div");
    nm.className = "gallery-tile-name";
    nm.textContent = item.name;
    const meta = document.createElement("div");
    meta.className = "gallery-tile-meta";
    const t = (item.local?.updatedAt) || Date.parse(item.cloud?.lastModifiedDateTime || 0);
    const sz = (item.local?.size) || item.cloud?.size || 0;
    // 状态标签：本地 / 云 / 未上传 / 本地+云
    const signedIn = isSignedIn();
    let stateLabel;
    if (isLocal && isCloud) stateLabel = "本地+云";
    else if (isCloud) stateLabel = "纯云端";
    else if (isLocal && signedIn) stateLabel = "未上传";
    else stateLabel = "本地";
    meta.textContent = `${stateLabel} · ${humanTime(t)} · ${humanSize(sz)}`;
    info.appendChild(nm);
    info.appendChild(meta);
    tile.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "gallery-tile-actions";
    if (isCloud && !isLocal) {
      // 纯云端 → 拉取
      const pullBtn = document.createElement("button");
      pullBtn.type = "button";
      pullBtn.textContent = "拉取";
      pullBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        pullBtn.disabled = true;
        pullBtn.textContent = "拉取中…";
        await pullCloudPath(item.cloud.path);
        pullBtn.disabled = false;
        pullBtn.textContent = "拉取";
      });
      actions.appendChild(pullBtn);
    } else if (isLocal && !isCloud && signedIn) {
      // 本地未上传 → 推送
      const pushBtn = document.createElement("button");
      pushBtn.type = "button";
      pushBtn.textContent = "推送";
      pushBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        pushBtn.disabled = true;
        pushBtn.textContent = "推送中…";
        try {
          // 拿这个 session 的 ora 内容直接推（不影响当前编辑的 doc）
          const loaded = await openSession(item.name);
          if (!loaded) throw new Error("找不到本地 session");
          const ora = await encodeDocToOra(loaded, {
            referenceImage: loaded._referenceBlob,
            webpaintState: loaded._webpaintState,
          });
          await pushSession(item.name, ora);
          setStatus(`已推送：${item.name}`);
          renderGallery();
        } catch (err) {
          if (err instanceof CloudConflictError) {
            setStatus(`云端冲突：${item.name}（先改名再推）`, true);
          } else {
            setStatus("推送失败：" + (err && err.message || err));
          }
        } finally {
          pushBtn.disabled = false;
          pushBtn.textContent = "推送";
        }
      });
      actions.appendChild(pushBtn);
    } else if (isLocal && isCloud) {
      // 本地 + 云都有 → 可以"卸载本地"省地方，云端是备份。下次"拉取"还能回来。
      // 不弱化为 danger 按钮 —— 它不破坏数据，只清本地副本。
      const offloadBtn = document.createElement("button");
      offloadBtn.type = "button";
      offloadBtn.textContent = "卸载本地";
      offloadBtn.title = "清这幅画的本地 IDB 副本，云端保留。下次需要可点拉取。";
      offloadBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (item.name === _activeSessionName) {
          setStatus("正在编辑这幅画，不能卸载本地副本");
          return;
        }
        offloadBtn.disabled = true;
        offloadBtn.textContent = "卸载中…";
        try {
          await removeSession(item.name);
          setStatus(`已卸载本地：${item.name}（云端保留）`);
          renderGallery();
        } catch (err) {
          setStatus("卸载失败：" + (err && err.message || err));
        } finally {
          offloadBtn.disabled = false;
          offloadBtn.textContent = "卸载本地";
        }
      });
      actions.appendChild(offloadBtn);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = isCloud && !isLocal ? "删除（云）" : (isLocal && isCloud ? "删除（本地+云）" : "删除");
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await openConfirmSheet(`删除 "${item.name}"？`, `${isLocal ? "本地 " : ""}${isCloud ? "云端 " : ""}不可撤销。`);
      if (!ok) return;
      try {
        if (isLocal) await removeSession(item.name);
        if (isCloud) await deleteCloudSession(item.name);
        if (item.name === _activeSessionName && isLocal) {
          setStatus(`已删除（当前在内存里，可保存副本为新名字保留）`);
        } else {
          setStatus(`已删除：${item.name}`);
        }
        renderGallery();
      } catch (err) {
        setStatus("删除失败：" + (err && err.message || err));
      }
    });
    actions.appendChild(del);
    tile.appendChild(actions);

    tile.addEventListener("click", async (e) => {
      if (e.target.closest(".gallery-tile-actions")) return;
      if (item.name === _activeSessionName) {
        setGalleryOpen(false);
        return;
      }
      if (_docDirty) await saveNow();
      if (isLocal) {
        try {
          const loaded = await openSession(item.name);
          if (!loaded) { setStatus(`找不到：${item.name}`); return; }
          adoptLoadedDoc(loaded, item.name);
          setGalleryOpen(false);
          setStatus(`已打开：${item.name}`);
        } catch (err) {
          setStatus("打开失败：" + (err && err.message || err));
        }
      } else if (isCloud) {
        // 纯云端：点 tile 也走拉取
        await pullCloudPath(item.cloud.path);
      }
    });

    els.galleryGrid.appendChild(tile);
  }
}

function humanTime(ts) {
  if (!ts) return "未知";
  const d = new Date(ts);
  const now = Date.now();
  const dt = now - ts;
  if (dt < 60 * 1000) return "刚刚";
  if (dt < 60 * 60 * 1000) return `${Math.floor(dt / 60000)} 分钟前`;
  if (dt < 24 * 60 * 60 * 1000) return `${Math.floor(dt / 3600000)} 小时前`;
  if (dt < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(dt / 86400000)} 天前`;
  return d.toLocaleDateString();
}
function humanSize(b) {
  if (b == null) return "?";
  if (b === 0) return "0 B";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

// ---- 云端 icon 按钮（gallery header 右侧）----
// 一颗云图标 + 状态色：未登录灰，已登录蓝勾；点开 popup 显示账号 + 登录/退出。
// 刷新按钮只在登录后显示。
const ICON_CLOUD_OUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
const ICON_CLOUD_IN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 13 11 15 15 11"/></svg>';

function updateCloudAuthUI() {
  const signed = isSignedIn();
  const configured = isAuthConfigured();
  const offline = navigator.onLine === false;     // navigator.onLine=undefined 当 true
  if (signed) {
    const acc = getActiveAccount();
    els.cloudIconBtn.innerHTML = ICON_CLOUD_IN;
    els.cloudIconBtn.dataset.cloudState = "signedin";
    const who = acc?.username || acc?.name || "已登录";
    els.cloudIconBtn.title = offline ? `云端：${who}（离线，无法推 / 拉）` : `云端：${who}（点开账号菜单）`;
    els.cloudAccountInfo.textContent = offline ? `云端：${who}（离线）` : `云端：${who}`;
    els.cloudSignInBtn.classList.add("hidden");
    els.cloudSignOutBtn.classList.remove("hidden");
    els.cloudRefreshBtn.classList.toggle("hidden", offline);   // 离线时藏刷新（按了没意义）
  } else {
    els.cloudIconBtn.innerHTML = ICON_CLOUD_OUT;
    els.cloudIconBtn.dataset.cloudState = configured ? "out" : "unconfigured";
    if (offline && configured) {
      els.cloudIconBtn.title = "云端：离线（无法登录 / 同步；本地图库正常）";
      els.cloudAccountInfo.textContent = "云端：离线";
    } else {
      els.cloudIconBtn.title = configured ? "云端：未登录（点开登录）" : "云端：未配置";
      els.cloudAccountInfo.textContent = configured ? "云端：未登录" : "云端：未配置";
    }
    els.cloudSignInBtn.classList.toggle("hidden", !configured || offline);    // 离线时登录按钮无意义
    els.cloudSignOutBtn.classList.add("hidden");
    els.cloudRefreshBtn.classList.add("hidden");
  }
  updateSaveStatus();
}

els.cloudSignInBtn.addEventListener("click", async () => {
  els.cloudAccountPopup.classList.add("hidden");
  if (!isAuthConfigured()) { setStatus("尚未配置 OneDrive 客户端"); return; }
  try { await signIn(); } catch (e) { setStatus("登录失败：" + (e && e.message || e)); }
});
els.cloudSignOutBtn.addEventListener("click", async () => {
  els.cloudAccountPopup.classList.add("hidden");
  try { await signOut(); } catch (_) {}
  updateCloudAuthUI();
  renderGallery();
});

els.cloudRefreshBtn.addEventListener("click", () => renderGallery());

// 给本地拿一个不冲突的名字（X / X 1 / X 2 / ...）
async function uniqueLocalName(stem) {
  const existing = new Set((await listSessions()).map((s) => s.name));
  if (!existing.has(stem)) return stem;
  for (let i = 1; i < 100; i++) {
    const candidate = `${stem} ${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${stem} ${Date.now()}`;
}

// 从云端拉一个文件，duplicate 到本地（永远）
async function pullCloudPath(path) {
  try {
    const r = await pullSessionByPath(path);
    if (!r) { setStatus(`找不到：${path}`); return; }
    const loaded = await decodeOraToDoc(r.blob);
    const finalName = await uniqueLocalName(r.suggestedName);
    adoptLoadedDoc(loaded, finalName);
    await saveNow();
    setGalleryOpen(false);
    setStatus(`已从云端拉取并保存为：${finalName}`);
  } catch (err) {
    console.warn("[cloud] pull failed:", err);
    setStatus("拉取失败：" + (err && err.message || err));
  }
}

// ---- 启动收尾：尝试加载上次的 session（异步，不阻塞 UI 显示） ----
setStatus("就绪");
updateZoomLabel();
updateSaveStatus();
updateCloudAuthUI();
// MSAL init（懒；只在配了 CLIENT_ID 才 load script），失败安静吞
if (isAuthConfigured()) {
  initAuth().then(() => updateCloudAuthUI()).catch((e) => {
    console.warn("[auth] init failed:", e);
  });
}
// 在线 / 离线变化时刷新云端 UI（标签 / 按钮可见性）；图库打开时还顺便重渲染列表
window.addEventListener("online",  () => { updateCloudAuthUI(); if (!els.galleryFull.classList.contains("hidden")) renderGallery(); });
window.addEventListener("offline", () => { updateCloudAuthUI(); });
(async () => {
  const wantedName = getCurrentSessionName();
  try {
    const loaded = await loadCurrentSession();
    if (!loaded) {
      // 没有存档 → safe default 名字，但默认空 doc 已经在
      _activeSessionName = wantedName;
      updateSaveStatus();
      return;
    }
    adoptLoadedDoc(loaded, wantedName);
    setStatus(`已恢复：${wantedName} (${loaded.layers.length} 层)`);
  } catch (e) {
    // **幽灵 current path 保护**（feedback-phantom-current-path memory）：
    //   - **不**重置 localStorage.currentSessionName（用户下次冷启动还能再试）
    //   - **但**内存里 _activeSessionName 保持 "未命名" safe default，
    //     避免 Ctrl+S 时 saveSession 写到加载失败的名字下覆盖坏数据
    console.warn("[session] load failed:", e);
    _activeSessionName = "未命名";
    updateSaveStatus();
    setStatus(`启动加载 "${wantedName}" 失败，使用空白文档`);
  }
})();

// ---- Service worker + 更新检测 ----
// 沿用 WebXiaoHeiWu 模式，四条检测路径都挂上，iPad PWA standalone 模式默认
// 不勤快地 check update —— 每次回到前台再 poke 一下 registration.update()。
//
//   1) registration.waiting 在 register 时 → 上次后台装好但没 activate 的，开机直接 toast
//   2) updatefound + statechange='installed' → 当前 session 内 SW 装了新版本就 toast
//   3) SW postMessage 'asset-updated' (fetch handler ETag 检测) → 任意一个 asset 变了
//   4) visibilitychange / focus → registration.update() 主动 poll

const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);
let updateDismissed = false;
function showUpdate() {
  if (updateDismissed) return;
  els.updateToast.classList.remove("hidden");
}
els.updateReload.addEventListener("click", () => {
  navigator.serviceWorker?.controller?.postMessage({ type: "skip-waiting" });
  location.reload();
});
els.updateDismiss.addEventListener("click", () => {
  updateDismissed = true;
  els.updateToast.classList.add("hidden");
});

let _swRegistration = null;       // 暴露给 menuCheckUpdate 用，避免 getRegistration() 返 undefined
if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname)) {
  // 路径 3
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "asset-updated") showUpdate();
  });

  window.addEventListener("load", async () => {
    let registration;
    try {
      registration = await navigator.serviceWorker.register("./service-worker.js");
      _swRegistration = registration;
    } catch (err) {
      console.warn("SW register failed", err);
      return;
    }
    // 路径 1
    if (registration.waiting && navigator.serviceWorker.controller) {
      showUpdate();
    }
    // 路径 2
    registration.addEventListener("updatefound", () => {
      const newWorker = registration.installing;
      if (!newWorker) return;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          showUpdate();
        }
      });
    });
    // 路径 4：回到前台 / 拿到焦点时主动 poke 一下
    const pokeUpdate = () => { registration.update().catch(() => {}); };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pokeUpdate();
    });
    window.addEventListener("focus", pokeUpdate);
    // 再加一个低频的 timer 作为兜底（PWA 在前台 30 分钟内每 10 分钟 check 一次）
    setInterval(pokeUpdate, 10 * 60 * 1000);
  });
}
