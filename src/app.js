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

import { PaintDoc, MODULE_VERSION as DOC_V } from "./doc.js";
import { Board, MODULE_VERSION as BOARD_V } from "./board.js";
import { InputController, MODULE_VERSION as INPUT_V } from "./input.js";
import { BrushSettings, MODULE_VERSION as BRUSH_V } from "./brush.js";
import { getMeta, setMeta, debounce, MODULE_VERSION as DB_V } from "./db.js";

// 反煤气灯：app.js 自己的硬编码版本，启动时和兄弟 module + window.WEBPAINT_VERSION 对账
const APP_V = "v20-2026-05-26";
const MODULE_VERSIONS = { app: APP_V, doc: DOC_V, board: BOARD_V, input: INPUT_V, brush: BRUSH_V, db: DB_V };

const THEMES = ["auto", "day", "night"];
const THEME_LABEL = { auto: "跟随系统", day: "日", night: "夜" };

const els = {
  board: document.getElementById("board"),
  topBar: document.getElementById("topBar"),
  zoomLabel: document.getElementById("zoomLabel"),
  canvasSizeLabel: document.getElementById("canvasSizeLabel"),
  statusLabel: document.getElementById("statusLabel"),
  brushDebugLabel: document.getElementById("brushDebugLabel"),
  versionLabel: document.getElementById("versionLabel"),
  sizeSlider: document.getElementById("sizeSlider"),
  opacitySlider: document.getElementById("opacitySlider"),
  undoBtn: document.getElementById("undoButton"),
  redoBtn: document.getElementById("redoButton"),
  fitBtn: document.getElementById("fitButton"),
  clearBtn: document.getElementById("clearButton"),
  themeBtn: document.getElementById("themeButton"),
  pressureBtn: document.getElementById("pressureButton"),
  longPressPickBtn: document.getElementById("longPressPickButton"),
  debugStampsBtn: document.getElementById("debugStampsButton"),
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
// 版本对账：app.js 这一段 + 各兄弟 module 的 MODULE_VERSION + SW 合成 version.js
// 三方都对上才是真的"装上 vN"。任一对不上 = bytecode cache 没刷干净 / SW 没更新
function computeVersionLabel() {
  const sw = window.WEBPAINT_VERSION || "?";
  const allMatch = Object.values(MODULE_VERSIONS).every((v) => v === sw);
  if (allMatch) return `${sw} ✓`;
  const stale = Object.entries(MODULE_VERSIONS)
    .filter(([_, v]) => v !== sw)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `${sw} ⚠ stale: ${stale}`;
}
els.versionLabel.textContent = computeVersionLabel();
console.log("[WebPaint] versions:", { sw: window.WEBPAINT_VERSION, ...MODULE_VERSIONS });

const state = {
  tool: "brush",
  color: safeLS("webpaint.color") || "#1b1b1b",
  brush: new BrushSettings({
    size: parseFloat(safeLS("webpaint.size") || "12"),
    opacity: parseFloat(safeLS("webpaint.opacity") || "1"),
    color: safeLS("webpaint.color") || "#1b1b1b",
  }),
  pressureEnabled: safeLS("webpaint.pressure") !== "0", // 默认开（不像 ScratchPad 默认关）
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
  getPressureEnabled: () => state.pressureEnabled,
  getLongPressPickEnabled: () => state.longPressPick,
  onColorSampled: (hex) => setColor(hex),
  status: setStatus,
});

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
  els.themeBtn.title = `主题：${THEME_LABEL[t]}`;
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
function setColor(hex) {
  state.color = hex;
  safeLSSet("webpaint.color", hex);
  els.activeSwatch.style.background = hex;
  syncBrushColor();
  // 浮动色板开着的话同步 marker / hex
  if (!els.colorPanel.classList.contains("hidden")) {
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

// ---- 压感 ----
function applyPressure(on) {
  state.pressureEnabled = !!on;
  els.pressureBtn.setAttribute("aria-pressed", on ? "true" : "false");
  els.pressureBtn.title = `压感（${on ? "开" : "关"}）`;
  safeLSSet("webpaint.pressure", on ? "1" : "0");
}
els.pressureBtn.addEventListener("click", () => {
  applyPressure(!state.pressureEnabled);
  setStatus(`压感 · ${state.pressureEnabled ? "开" : "关"}`);
});
applyPressure(state.pressureEnabled);

// ---- 单指长按吸色 toggle ----
function applyLongPressPick(on) {
  state.longPressPick = !!on;
  els.longPressPickBtn.setAttribute("aria-pressed", on ? "true" : "false");
  els.longPressPickBtn.title = `单指长按吸色（${on ? "开" : "关"}）`;
  safeLSSet("webpaint.longPressPick", on ? "1" : "0");
}
els.longPressPickBtn.addEventListener("click", () => {
  applyLongPressPick(!state.longPressPick);
  setStatus(`长按吸色 · ${state.longPressPick ? "开" : "关"}`);
});
applyLongPressPick(state.longPressPick);

// ---- undo / redo / fit / clear ----
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
els.clearBtn.addEventListener("click", () => openSheet(els.clearSheet, els.clearBackdrop));
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

// 主题切换
els.themeBtn.addEventListener("click", () => {
  const i = THEMES.indexOf(theme);
  const next = THEMES[(i + 1) % THEMES.length];
  applyTheme(next);
  setStatus(`主题 · ${THEME_LABEL[next]}`);
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
  setColor(hex);
}
function pickerSetFromHex(hex) {
  const { h, s, v } = hexToHsv(hex);
  pickerHsv = { h, s, v };
  els.hueSlider.value = String(Math.round(h));
  els.hexInput.value = hex;
  els.previewSwatch.style.background = hex;
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

// ---- Debug: brush 状态在 HUD 显示，方便定位 knot 根因 ----
// 用闭包变量 + 在 slider 监听器/strokeEnd 事件里直接 refresh，不动 setSize/setOpacity 本体
let _lastStrokeStamps = 0;
let _lastDiag = null;
function refreshBrushDebug() {
  const s = state.brush;
  // v19 起 step 是整笔常量（不再随 pressure 飘）
  const step = Math.max(0.5, s.size * s.spacing);
  let txt = `size ${s.size.toFixed(0)} step ${step.toFixed(1)} / n ${_lastStrokeStamps}`;
  if (_lastDiag) {
    txt += ` drop ${_lastDiag.dropped}`;
    // d_mean = 相邻 stamp 实测欧氏距离的 mean±std [min..max]，理想 ≈ step
    txt += ` / d_mean ${_lastDiag.dMean.toFixed(2)}±${_lastDiag.dStd.toFixed(2)} [${_lastDiag.dMin.toFixed(1)}..${_lastDiag.dMax.toFixed(1)}]`;
    txt += ` / α ${_lastDiag.aMin.toFixed(2)}-${_lastDiag.aMax.toFixed(2)}`;
  }
  els.brushDebugLabel.textContent = txt;
}
window.addEventListener("wp:strokeEnd", (e) => {
  _lastStrokeStamps = e.detail.stamps;
  _lastDiag = e.detail.diag || null;
  refreshBrushDebug();
  // Debug 红点：开了的话把这一笔的 stamp 位置交给 board 画 marker
  if (_debugStampsOn && _lastDiag?.positions) {
    board.setDebugMarkers(_lastDiag.positions);
  }
});

// ---- Debug: stamps 红点叠加 toggle ----
let _debugStampsOn = false;
function applyDebugStamps(on) {
  _debugStampsOn = !!on;
  els.debugStampsBtn.setAttribute("aria-pressed", on ? "true" : "false");
  if (!on) board.setDebugMarkers(null);
  else if (_lastDiag?.positions) board.setDebugMarkers(_lastDiag.positions);
}
els.debugStampsBtn.addEventListener("click", () => {
  applyDebugStamps(!_debugStampsOn);
  setStatus(`Debug stamps · ${_debugStampsOn ? "开" : "关"}`);
});
els.sizeSlider.addEventListener("input", refreshBrushDebug);
els.opacitySlider.addEventListener("input", refreshBrushDebug);

// ---- 启动收尾 ----
setStatus("就绪");
updateZoomLabel();
refreshBrushDebug();

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
