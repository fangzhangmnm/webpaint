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
import { InputController } from "./input.js";
import { BrushSettings } from "./brush.js";
import {
  saveSession, loadCurrentSession, openSession, removeSession, listSessions,
  getCurrentSessionName, setCurrentSessionName,
  exportOraDownload, shareOrDownloadImage,
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
  menuClipboardCopy: document.getElementById("menuClipboardCopy"),
  menuClipboardPaste: document.getElementById("menuClipboardPaste"),
  menuFit: document.getElementById("menuFit"),
  topSaveBtn: document.getElementById("topSaveBtn"),
  topGalleryBtn: document.getElementById("topGalleryBtn"),
  galleryFull: document.getElementById("galleryFull"),
  galleryClose: document.getElementById("galleryClose"),
  galleryCurrentName: document.getElementById("galleryCurrentName"),
  galleryNewBtn: document.getElementById("galleryNewBtn"),
  gallerySaveCopyBtn: document.getElementById("gallerySaveCopyBtn"),
  galleryGrid: document.getElementById("galleryGrid"),
  galleryEmpty: document.getElementById("galleryEmpty"),
  galleryCloudStatus: document.getElementById("galleryCloudStatus"),
  cloudSignInBtn: document.getElementById("cloudSignInBtn"),
  cloudSignOutBtn: document.getElementById("cloudSignOutBtn"),
  cloudPushBtn: document.getElementById("cloudPushBtn"),
  cloudRefreshBtn: document.getElementById("cloudRefreshBtn"),
  oraFileInput: document.getElementById("oraFileInput"),
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
  }),
  longPressPick: safeLS("webpaint.longPressPick") === "1", // 默认关，user 担心误触
};

// brush settings keep color in sync
function syncBrushColor() {
  state.brush.color = state.color;
  // brush engine 会自动 invalidate stamp（_getStamp key 包含 color）
}
syncBrushColor();

const input = new InputController(board, doc, {
  getTool: () => state.tool,
  getBrushSettings: () => state.brush,
  getLongPressPickEnabled: () => state.longPressPick,
  onColorSampled: (hex) => setColor(hex),
  status: setStatus,
});

// 笔触 buffer live overlay：board 每帧问 brush 要，layer 之上 composite × s.opacity
// 预览（实际像素在 endStroke 才烧进 layer）。
board.setOverlayProvider(() => input.brush.getLiveOverlay());

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
  state.tool = t;
  for (const b of els.toolBtns) b.setAttribute("aria-pressed", b.dataset.tool === t ? "true" : "false");
  document.body.dataset.tool = t;
}
for (const b of els.toolBtns) {
  b.addEventListener("click", () => setTool(b.dataset.tool));
}
window.addEventListener("wp:settool", (e) => setTool(e.detail));
// pencil 模式下双击 → 笔↔橡皮
window.addEventListener("wp:doubletap", () => {
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
els.menuTheme.addEventListener("click", () => {
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(next);
  setStatus(`主题 · ${THEME_LABEL[next]}`);
});
els.menuClear.addEventListener("click", () => {
  setMenuOpen(false);
  openSheet(els.clearSheet, els.clearBackdrop);
});

applyPressureSize(state.brush.pressureToSize);
applyPressureOpacity(state.brush.pressureToOpacity);
applyLongPressPick(state.longPressPick);

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
  doc.clearActiveLayer();
  input.clearHistory();
  board.invalidateAll();
  setStatus("已清空");
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
      L.visible = !L.visible;
      renderLayersPanel();
      board.invalidateAll();
      board.requestRender();
    });
    row.appendChild(vis);

    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = L.name;
    row.appendChild(name);

    row.addEventListener("click", () => {
      doc.setActiveById(L.id);
      renderLayersPanel();
    });
    els.layersList.appendChild(row);
  }
  // foot button enable/disable
  els.layerAddBtn.disabled = doc.layers.length >= max;
  els.layerDelBtn.disabled = doc.layers.length <= 1;
  els.layerUpBtn.disabled = doc.activeIndex >= doc.layers.length - 1;
  els.layerDownBtn.disabled = doc.activeIndex <= 0;
}

els.layerAddBtn.addEventListener("click", () => {
  const L = doc.addLayer();
  if (!L) {
    setStatus(`图层数已达上限 ${doc.maxLayers}`);
    return;
  }
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
});
els.layerDelBtn.addEventListener("click", () => {
  const L = doc.activeLayer;
  if (!L) return;
  if (!doc.removeLayer(L.id)) {
    setStatus("至少保留一层");
    return;
  }
  // 同时清掉这层的 undo 链条 entry（layerId 匹配的）—— 否则 undo 会复活已删层
  input.dropHistoryForLayer(L.id);
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
});
els.layerUpBtn.addEventListener("click", () => {
  const L = doc.activeLayer;
  if (!L) return;
  if (doc.moveLayer(L.id, 1)) {
    renderLayersPanel();
    board.invalidateAll();
    board.requestRender();
  }
});
els.layerDownBtn.addEventListener("click", () => {
  const L = doc.activeLayer;
  if (!L) return;
  if (doc.moveLayer(L.id, -1)) {
    renderLayersPanel();
    board.invalidateAll();
    board.requestRender();
  }
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
let _docLastSavedAt = 0;
// **幽灵 current path 保护**：内存里 _activeSessionName 只在 boot load 成功
// 或用户主动 open / new / save-as 后才升级到真实名字。boot 失败时保持
// safe default "未命名"，避免 save 走 rename-delete-old 路径误删。
let _activeSessionName = "未命名";
const AUTOSAVE_MS = 3 * 60 * 1000;

// Smart save button：
//   saving → 半透明 disk
//   dirty → 蓝色 disk + 角点
//   cloud-dirty → 上传箭头（点 = push to cloud）
//   synced → 灰色对勾云（点 = noop）
//   saved (未登录 / 未配置 cloud) → 灰色 disk
const ICON_DISK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';
const ICON_UPLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const ICON_CLOUD_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 13 11 15 15 11"/></svg>';

function computeSaveState() {
  if (_docSaving) return "saving";
  if (_docDirty) return "dirty";
  // doc clean
  if (isSignedIn() && isCloudDirty(_activeSessionName)) return "cloud-dirty";
  if (isSignedIn()) return "synced";
  return "saved";
}
function updateSaveStatus() {
  const state = computeSaveState();
  els.topSaveBtn.dataset.state = state;
  const name = _activeSessionName;
  if (state === "saving")      { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `保存中… · ${name}`; }
  else if (state === "dirty")  { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `保存 (Ctrl+S) · ${name} · 未保存`; }
  else if (state === "cloud-dirty") { els.topSaveBtn.innerHTML = ICON_UPLOAD; els.topSaveBtn.title = `推送到云端 · ${name} · 本地已保存`; }
  else if (state === "synced") { els.topSaveBtn.innerHTML = ICON_CLOUD_CHECK; els.topSaveBtn.title = `已同步到云端 · ${name}`; }
  else                          { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `已保存到本地 · ${name}（未连云端）`; }
}
async function saveNow() {
  if (_docSaving) return;
  _docSaving = true;
  updateSaveStatus();
  try {
    await saveSession(doc, _activeSessionName);
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
}
// 笔触结束 / undo / redo / 图层操作（任何 wp:histchange）→ dirty
window.addEventListener("wp:histchange", () => {
  _docDirty = true;
  // 任何编辑 → 云端也变 dirty（待 push）
  if (isSignedIn()) setCloudDirty(_activeSessionName, true);
  updateSaveStatus();
});
// Ctrl+S
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    saveNow();
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
// Smart save 按钮：dirty=保存到本地；本地 clean + 云 dirty=推送；synced=noop
els.topSaveBtn.addEventListener("click", async () => {
  const state = computeSaveState();
  if (state === "dirty" || state === "saving") {
    await saveNow();
    // saveNow 完成后 state 会重新算；如果接着 cloud-dirty 给用户提示
    if (computeSaveState() === "cloud-dirty") {
      setStatus("已保存到本地，再点一下推送到云端");
    }
  } else if (state === "cloud-dirty") {
    await cloudPushCurrent();
  } else if (state === "synced") {
    setStatus("已同步到云端");
  } else {
    setStatus("已保存到本地");
  }
});
els.topGalleryBtn.addEventListener("click", () => setGalleryOpen(true));

// ---- 菜单：导入 / 导出 / 剪贴板 / 适应 ----
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
els.oraFileInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const isOra = /\.ora$/i.test(file.name);
  const isImage = (file.type || "").startsWith("image/");
  try {
    if (isOra) {
      const loaded = await decodeOraToDoc(file);
      const nm = file.name.replace(/\.ora$/i, "") || "未命名";
      adoptLoadedDoc(loaded, nm);
      setStatus(`已导入：${nm}`);
    } else if (isImage) {
      await importImageAsLayer(file);
    } else {
      setStatus(`不支持的文件类型：${file.type || file.name}`);
    }
  } catch (err) {
    console.warn("[import] failed:", err);
    setStatus("导入失败：" + (err && err.message || err));
  }
});

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

// ---- 图库 全屏 ----
// 打开时把每个 thumb Blob 转成 ObjectURL 给 <img src>；关闭时 revoke
// 防内存泄漏。
let _galleryUrls = [];
function setGalleryOpen(open) {
  els.galleryFull.classList.toggle("hidden", !open);
  if (open) {
    renderGallery();
  } else {
    for (const u of _galleryUrls) URL.revokeObjectURL(u);
    _galleryUrls = [];
  }
}
els.galleryClose.addEventListener("click", () => setGalleryOpen(false));

els.galleryCurrentName.addEventListener("change", () => {
  const v = (els.galleryCurrentName.value || "").trim();
  if (!v) {
    els.galleryCurrentName.value = _activeSessionName;
    return;
  }
  if (v === _activeSessionName) return;
  // 重命名 = 把当前 doc 在新名字下另存，删旧名（旧名是"已 load 进 scene 的真名"，
  // 满足 feedback-phantom-current-path 的安全条件）
  (async () => {
    try {
      await saveSession(doc, v);
      if (_activeSessionName && _activeSessionName !== v) {
        await removeSession(_activeSessionName);
      }
      _activeSessionName = v;
      setCurrentSessionName(v);
      _docDirty = false;
      _docLastSavedAt = Date.now();
      updateSaveStatus();
      renderGallery();
      setStatus(`已重命名：${v}`);
    } catch (e) {
      setStatus("重命名失败：" + (e && e.message || e));
    }
  })();
});
els.galleryNewBtn.addEventListener("click", () => {
  const name = prompt("新作品名字", "未命名");
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  // 新建：先把当前 doc 落盘（如果 dirty），然后切到全空白 doc
  (async () => {
    if (_docDirty) await saveNow();
    // 空白 doc：清掉 layers，重置成一个空层
    // 复刻一个空白 PaintDoc 的默认 layers
    const fresh = new PaintDoc({ width: doc.width, height: doc.height });
    doc.layers = fresh.layers;
    doc.activeIndex = 0;
    _activeSessionName = trimmed;
    setCurrentSessionName(trimmed);
    input.clearHistory();
    board.invalidateAll();
    board.requestRender();
    renderLayersPanel();
    _docDirty = true;          // 新建的还没存
    _docLastSavedAt = 0;
    updateSaveStatus();
    await saveNow();           // 立即落盘占名
    renderGallery();
    setStatus(`新建：${trimmed}`);
  })();
});
els.gallerySaveCopyBtn.addEventListener("click", () => {
  const name = prompt("保存副本为", _activeSessionName + " 副本");
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  if (trimmed === _activeSessionName) {
    setStatus("副本不能和当前同名");
    return;
  }
  // **保存副本** 语义：把当前 doc 写到 trimmed 名字下，**不**切走 active。
  // 用户继续编辑原作。和"另存为"语义不同：另存为会换 active 到新名字 →
  // 容易和"重命名"混淆。
  (async () => {
    try {
      await saveSession(doc, trimmed);
      renderGallery();
      setStatus(`已保存副本：${trimmed}（仍在编辑：${_activeSessionName}）`);
    } catch (e) {
      setStatus("保存副本失败：" + (e && e.message || e));
    }
  })();
});

async function renderGallery() {
  els.galleryCurrentName.value = _activeSessionName;
  updateCloudAuthUI();
  // revoke 旧 URL
  for (const u of _galleryUrls) URL.revokeObjectURL(u);
  _galleryUrls = [];

  // 同时拿本地 + 云端 list（如果登录），按 name 合并
  const local = await listSessions();
  let cloud = [];
  if (isSignedIn()) {
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

    // 缩略图：local thumb 优先；纯云端用 ☁ 占位
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
      thumbEl.textContent = isCloud ? "☁" : (item.name.slice(0, 1) || "?");
    }
    tile.appendChild(thumbEl);

    const info = document.createElement("div");
    info.className = "gallery-tile-info";
    const nm = document.createElement("div");
    nm.className = "gallery-tile-name";
    // 在 name 后面挂 source badges
    const sources = [];
    if (isLocal) sources.push("本地");
    if (isCloud) sources.push("☁");
    nm.textContent = item.name + (sources.length ? ` · ${sources.join(" ")}` : "");
    const meta = document.createElement("div");
    meta.className = "gallery-tile-meta";
    const t = (item.local?.updatedAt) || Date.parse(item.cloud?.lastModifiedDateTime || 0);
    const sz = (item.local?.size) || item.cloud?.size || 0;
    meta.textContent = `${humanTime(t)} · ${humanSize(sz)}`;
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
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = isCloud && !isLocal ? "删除（云）" : (isLocal && isCloud ? "删除（本地+云）" : "删除");
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`删除 "${item.name}"？\n${isLocal ? "✓ 本地\n" : ""}${isCloud ? "✓ 云端\n" : ""}不可撤销。`)) return;
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
  if (!b) return "?";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

// ---- 云端按钮（在 gallery header 里），登录态 / 推送 / 刷新 ----
function updateCloudAuthUI() {
  const signed = isSignedIn();
  if (signed) {
    const acc = getActiveAccount();
    els.galleryCloudStatus.textContent = `云端：${acc?.username || acc?.name || "已登录"}`;
    els.cloudSignInBtn.classList.add("hidden");
    els.cloudSignOutBtn.classList.remove("hidden");
    els.cloudPushBtn.classList.remove("hidden");
    els.cloudRefreshBtn.classList.remove("hidden");
  } else {
    els.galleryCloudStatus.textContent = isAuthConfigured() ? "云端：未登录" : "云端：未配置";
    els.cloudSignInBtn.classList.toggle("hidden", !isAuthConfigured());
    els.cloudSignOutBtn.classList.add("hidden");
    els.cloudPushBtn.classList.add("hidden");
    els.cloudRefreshBtn.classList.add("hidden");
  }
  updateSaveStatus();   // save 按钮的 state 也跟着变
}

els.cloudSignInBtn.addEventListener("click", async () => {
  if (!isAuthConfigured()) { setStatus("尚未配置 OneDrive 客户端"); return; }
  try { await signIn(); } catch (e) { setStatus("登录失败：" + (e && e.message || e)); }
});
els.cloudSignOutBtn.addEventListener("click", async () => {
  try { await signOut(); } catch (_) {}
  updateCloudAuthUI();
  renderGallery();
});

async function cloudPushCurrent() {
  if (!isSignedIn()) { setStatus("未登录"); return; }
  els.cloudPushBtn.disabled = true;
  els.cloudPushBtn.textContent = "推送中…";
  try {
    if (_docDirty) await saveNow();
    const ora = await encodeDocToOra(doc);
    await pushSession(_activeSessionName, ora);
    setStatus(`已推送：${_activeSessionName}`);
    updateSaveStatus();
    renderGallery();
  } catch (e) {
    if (e instanceof CloudConflictError) {
      alert(e.message + "\n\n点击「保存副本」用新名字，然后再推送。");
      setStatus("推送失败：云端有更新版本");
    } else {
      console.warn("[cloud] push failed:", e);
      setStatus("推送失败：" + (e && e.message || e));
    }
  } finally {
    els.cloudPushBtn.disabled = false;
    els.cloudPushBtn.textContent = "推送当前";
  }
}
els.cloudPushBtn.addEventListener("click", cloudPushCurrent);
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

if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname)) {
  // 路径 3
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "asset-updated") showUpdate();
  });

  window.addEventListener("load", async () => {
    let registration;
    try {
      registration = await navigator.serviceWorker.register("./service-worker.js");
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
