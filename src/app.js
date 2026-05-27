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
import { saveCurrentSession, loadCurrentSession, exportOraDownload, shareOrDownloadImage } from "./session.js";

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
  fitBtn: document.getElementById("fitButton"),
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
  menuSave: document.getElementById("menuSave"),
  menuSharePng: document.getElementById("menuSharePng"),
  menuShareJpg: document.getElementById("menuShareJpg"),
  menuExportOra: document.getElementById("menuExportOra"),
  menuTheme: document.getElementById("menuTheme"),
  menuClear: document.getElementById("menuClear"),
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

els.fitBtn.addEventListener("click", () => {
  board.fitToScreen();
  updateZoomLabel();
  setStatus("适应屏幕");
});

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
const AUTOSAVE_MS = 3 * 60 * 1000;

function setSaveLabel(text) {
  const stateEl = els.menuSave.querySelector('[data-state-for="save"]');
  if (stateEl) stateEl.textContent = text;
}
function updateSaveStatus() {
  if (_docSaving) setSaveLabel("保存中…");
  else if (_docDirty) setSaveLabel("未保存");
  else if (_docLastSavedAt) setSaveLabel("已保存");
  else setSaveLabel("-");
}
async function saveNow() {
  if (_docSaving) return;
  _docSaving = true;
  updateSaveStatus();
  try {
    await saveCurrentSession(doc);
    _docDirty = false;
    _docLastSavedAt = Date.now();
    setStatus("已保存");
  } catch (e) {
    console.warn("[session] save failed:", e);
    setStatus("保存失败：" + (e && e.message || e));
  } finally {
    _docSaving = false;
    updateSaveStatus();
  }
}
// 笔触结束 / undo / redo / 图层操作（任何 wp:histchange）→ dirty
window.addEventListener("wp:histchange", () => {
  _docDirty = true;
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
els.menuSave.addEventListener("click", () => {
  setMenuOpen(false);
  saveNow();
});
els.menuSharePng.addEventListener("click", async () => {
  setMenuOpen(false);
  try {
    const r = await shareOrDownloadImage(doc, "png", `WebPaint-${stampNow()}`);
    setStatus(r.method === "share" ? "分享面板已开" : r.method === "cancel" ? "取消分享" : "PNG 已下载");
  } catch (e) { setStatus("分享失败：" + (e && e.message || e)); }
});
els.menuShareJpg.addEventListener("click", async () => {
  setMenuOpen(false);
  try {
    const r = await shareOrDownloadImage(doc, "jpg", `WebPaint-${stampNow()}`);
    setStatus(r.method === "share" ? "分享面板已开" : r.method === "cancel" ? "取消分享" : "JPG 已下载");
  } catch (e) { setStatus("分享失败：" + (e && e.message || e)); }
});
els.menuExportOra.addEventListener("click", async () => {
  setMenuOpen(false);
  try {
    await exportOraDownload(doc, `WebPaint-${stampNow()}.ora`);
    setStatus(".ora 已下载");
  } catch (e) { setStatus("导出失败：" + (e && e.message || e)); }
});

// ---- 启动收尾：尝试加载上次的 session（异步，不阻塞 UI 显示） ----
setStatus("就绪");
updateZoomLabel();
updateSaveStatus();
(async () => {
  try {
    const loaded = await loadCurrentSession();
    if (!loaded) return;                  // 没有存档 → 用默认空白 doc
    // 替换 doc 的内容（保持 doc 指针不变，input/board 引用都还在）
    doc.layers = loaded.layers;
    doc.activeIndex = loaded.activeIndex;
    doc.width = loaded.width;
    doc.height = loaded.height;
    els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
    input.clearHistory();                 // 旧 undo 链对新 layers 无意义
    board.fitToScreen();
    board.invalidateAll();
    board.requestRender();
    renderLayersPanel();
    setStatus(`已恢复 (${loaded.layers.length} 层)`);
  } catch (e) {
    // **幽灵 current path 保护**：不主动删 IDB 里失败的 entry；不把 _active 指向
    // 失败 path（phase 1 只有 fixed "current" slot，无 rename op，天然安全）。
    // 下次冷启动还会再试。
    console.warn("[session] load failed:", e);
    setStatus("启动加载失败，使用空白文档");
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
