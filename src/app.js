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
import {
  makeDefaultRack, findBrush, getActiveBrush, brushesByTool,
  newBrushId, brushToJSON, brushFromJSON, DEFAULT_FOLDER, mergeMissingDefaults, migrateBrush,
} from "./brushes.js";
import { PANELS, registerPanel, openExclusive, closeExclusive, getCurrentExclusive } from "./panel-state.js";
import { getMeta, setMeta } from "./storage.js";
import { UndoStack } from "./history.js";
import { ReferenceWindow } from "./reference.js";
import { PaletteWindow } from "./palette.js";
import {
  saveSession, loadCurrentSession, openSession, removeSession, listSessions,
  getCurrentSessionName, setCurrentSessionName,
  exportOraDownload, exportPsdDownload, shareOrDownloadImage,
  copyImageToClipboard, readImageFromClipboard,
} from "./session.js";
import { fillSelectionOnLayer, clearSelectionOnLayer, invertSelection } from "./lasso.js";
import { decodeOraToDoc, encodeDocToOra, parseAppVersion } from "./ora.js";
import {
  isAuthConfigured, initAuth, signIn, signOut, isSignedIn, getActiveAccount, retrySilentSignIn,
  pushSession, pullSessionByPath, listCloudSessionsRecursive, deleteCloudSession,
  isCloudDirty, setCloudDirty, CloudConflictError,
  getLastSessionSignedIn, setLastSessionSignedIn, fetchSessionMetadata, getKnownETag,
  pushBrushRack, pullBrushRack, fetchBrushRackMetadata, getBrushRackKnownETag,
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
  sizePopup: document.getElementById("sizePopup"),
  sizePopupCircle: document.getElementById("sizePopupCircle"),
  sizePopupText: document.getElementById("sizePopupText"),
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
  topGalleryBtn: document.getElementById("topGalleryBtn"),
  liquifyPanel: document.getElementById("liquifyPanel"),
  liquifyPanelHead: document.getElementById("liquifyPanelHead"),
  liquifyPanelClose: document.getElementById("liquifyPanelClose"),
  liquifyMode: document.getElementById("liquifyMode"),
  liquifySize: document.getElementById("liquifySize"),
  liquifySizeVal: document.getElementById("liquifySizeVal"),
  liquifyStrength: document.getElementById("liquifyStrength"),
  liquifyStrengthVal: document.getElementById("liquifyStrengthVal"),
  menuReference: document.getElementById("menuReference"),
  menuResetBrushRack: document.getElementById("menuResetBrushRack"),
  menuForcePwaReset: document.getElementById("menuForcePwaReset"),
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
  addImportClipboard: document.getElementById("addImportClipboard"),
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
// 触屏检测（iPad / iPhone / surface touchscreen）→ hand 工具隐藏（双指 pan 已足）
if (navigator.maxTouchPoints > 0) {
  document.body.dataset.inputTouchscreen = "1";
}
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

// ============ Brush rack + per-tool state（v81→v82）============
//
// **两层 state**（user：「这个比笔刷预设还重要」）：
//   1. brushRack —— 全账户共享笔架，preset 定义。IDB + 云同步（v83+）
//   2. toolStates —— 每工具的 current size / flow / activeBrushId，**per-doc**
//      存在 .ora webpaint/state.json，跟 doc 一起走，不跨 doc
//
// state.brush（BrushSettings 单例）是 *当前工具的 working snapshot* —— 给 BrushEngine 用。
// setTool 切换时 toolStates[oldTool] 已是最新（slider input 时写过），就直接读
// toolStates[newTool] 应用到 state.brush + UI。
//
// color 是全局（不分工具），跟 doc 走（也存 webpaint/state.json）。
let _brushRack = null;
const RACK_META_KEY = "brush-rack";

// 默认 tool state：从 rack preset 拿初值
// v99：toolStates { size, opacity, flow, activeBrushId }
//   opacity / flow 选 preset 时都初始化为 1.0 (user：「默认 opacity 默认 flow 两个字段不要，都是 1」)
function defaultToolStateFor(tool) {
  if (_brushRack) {
    const brush = getActiveBrush(_brushRack, tool);
    if (brush) {
      return {
        size: brush.size.base,
        opacity: 1.0,
        flow:    1.0,
        activeBrushId: brush.id,
      };
    }
  }
  return { size: 12, opacity: 1.0, flow: 1.0, activeBrushId: null };
}

// state.toolStates：per-tool 持久化（per-doc）。
// shapes **不**自己存——user：「笔刷和形状用同样的 brush class，就是同一个 ref」
// shapes 路径全部 alias 到 brush（见 getRackToolKey）
// v98：toolStates { size, opacity, flow, activeBrushId }
//   opacity → 左侧栏 slider 2（label「透」）
//   flow    → 只在 brush settings 里调（默认隐藏到「高级」），preset 决定初值
state.toolStates = {
  brush:    { size: 12, opacity: 1.0, flow: 1.0, activeBrushId: null },
  smudge:   { size: 16, opacity: 1.0, flow: 0.8, activeBrushId: null },
  eraser:   { size: 32, opacity: 0.6, flow: 1.0, activeBrushId: null },
};
// shapes / airbrush 工具都 alias 到 brush（user：「喷枪笔架合并到笔刷」）。
// 笔架是一个池子，所有 tool="brush" 的 preset 都在这。spacing.kind="time" 的 preset 就是喷枪。
function getRackToolKey(tool) {
  return (tool === "shapes" || tool === "airbrush") ? "brush" : tool;
}

async function loadBrushRack() {
  try {
    const stored = await getMeta(RACK_META_KEY);
    if (stored && Array.isArray(stored.brushes) && stored.brushes.length > 0) {
      // 补缺 default brush（解 stale default 问题）；merge 只加缺的，不覆盖
      // v98 migration：老 schema brushes 转新（sizeMin/flowMin → coeff；
      // airbrush/bufferMode → compositeMode；opacity → defaultOpa；flow.base → defaultFlow）
      let migrated = false;
      for (const b of stored.brushes) {
        const before = JSON.stringify(b);
        migrateBrush(b);
        if (JSON.stringify(b) !== before) migrated = true;
      }
      const merged = mergeMissingDefaults(stored);
      if (migrated || merged) {
        try { await setMeta(RACK_META_KEY, stored); } catch (_) {}
      }
      return stored;
    }
  } catch (e) {
    console.warn("[brush-rack] load failed:", e);
  }
  const rack = makeDefaultRack();
  try { await setMeta(RACK_META_KEY, rack); } catch (e) { console.warn("[brush-rack] save default failed:", e); }
  return rack;
}
async function persistBrushRack() {
  if (!_brushRack) return;
  try { await setMeta(RACK_META_KEY, _brushRack); }
  catch (e) { console.warn("[brush-rack] persist failed:", e); }
}

// 左侧栏当前 brush 指示器（v93）
const _sidebarBrushBtn = document.getElementById("leftSidebarBrush");
const _sidebarBrushName = document.getElementById("leftSidebarBrushName");
function updateSidebarBrushIndicator() {
  if (!_brushRack || !_sidebarBrushName) return;
  const tool = state.tool;
  const rackKey = getRackToolKey(tool);
  const ts = state.toolStates[rackKey];
  const brush = ts?.activeBrushId ? findBrush(_brushRack, ts.activeBrushId) : null;
  _sidebarBrushName.textContent = brush ? brush.name : "—";
}
if (_sidebarBrushBtn) {
  // tap 切换 rack；长按 600ms 直接进设置
  let lpTimer = null;
  _sidebarBrushBtn.addEventListener("pointerdown", () => {
    lpTimer = setTimeout(() => {
      lpTimer = null;
      const rackKey = getRackToolKey(state.tool);
      const ts = state.toolStates[rackKey];
      if (ts?.activeBrushId) {
        closeExclusive();
        _openBrushSettings(ts.activeBrushId);
      }
    }, 600);
  });
  const cancelLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  _sidebarBrushBtn.addEventListener("pointerup", cancelLP);
  _sidebarBrushBtn.addEventListener("pointerleave", cancelLP);
  _sidebarBrushBtn.addEventListener("pointercancel", cancelLP);
  _sidebarBrushBtn.addEventListener("click", () => {
    const t = state.tool;
    const id = RACK_PANEL_BY_TOOL[t];
    if (id) openExclusive(id);
  });
}

// v99：应用 preset 冻结字段到 state.brush（coeffs + compositeMode + pixelMode + gamma + smooth）
// user-controlled fields (opacity / flow / size) 不在这里设，applyToolState 后设
function applyBrushPresetFrozen(brush) {
  if (!brush) return;
  state.brush.shapeKind     = brush.shape.kind || "round";
  state.brush.shapeAspect   = brush.shape.aspect ?? 1.0;
  state.brush.shapeRotation = (brush.shape.rotation ?? 0) * Math.PI / 180;
  state.brush.hardness      = brush.shape.hardness ?? 1.0;
  state.brush.taperIn       = brush.taper.in ?? 0;
  // v98 coeff 模型（−1..1 signed）
  state.brush.sizeCoeff     = brush.sizeCoeff ?? 0.6;
  state.brush.opaCoeff      = brush.opaCoeff ?? 0.6;
  state.brush.flowCoeff     = brush.flowCoeff ?? 0;
  state.brush.pressureGamma = brush.pressureGamma ?? 1.0;
  state.brush.pressureLPF   = brush.pressureLPF ?? 0;       // v102 时间域压感平滑
  state.brush.compositeMode = brush.compositeMode || "wash";
  state.brush.spacing       = (typeof brush.spacing === "number")
    ? brush.spacing
    : (brush.spacing?.value ?? 0.06);
  state.brush.pixelMode     = !!brush.pixelMode;
  // v99：smooth 跟 preset 走（位置平滑也是笔感的一部分，不该是系统全局）
  const sm = brush.smooth || {};
  state.brush.streamline     = sm.streamline     ?? 0.3;
  state.brush.stabilization  = sm.stabilization  ?? 0;
  state.brush.pullStabilizer = sm.pullStabilizer ?? 0;
  state.brush.motionFilter   = sm.motionFilter   ?? 0;
  if (brush.smudge) {
    state.brush.smudgeStrength = brush.smudge.strength ?? 0.8;
    state.brush.smudgeDryness  = brush.smudge.dryness  ?? 0.1;
  }
  if (input?.brush?.invalidateStamp) input.brush.invalidateStamp();
}

// 切到 tool t：从 toolStates[rackKey(t)] 取 size/opacity/flow 应用到 state.brush + UI
function applyToolState(tool) {
  if (!_brushRack) return;
  const key = getRackToolKey(tool);
  const ts = state.toolStates[key];
  if (!ts) return;
  if (ts.activeBrushId == null) {
    Object.assign(ts, defaultToolStateFor(key));
  }
  const brush = ts.activeBrushId ? findBrush(_brushRack, ts.activeBrushId) : null;
  if (brush) applyBrushPresetFrozen(brush);
  state.brush.size    = ts.size;
  state.brush.opacity = ts.opacity ?? 1.0;
  state.brush.flow    = ts.flow    ?? 1.0;
  // size slider：log 化 0~100 → 1~sizeMax px
  if (els.sizeSlider) {
    const sliderMax = brush?.size?.max || 200;
    els.sizeSlider.max = "100";
    els.sizeSlider.min = "0";
    els.sizeSlider.step = "1";
    els.sizeSlider.value = String(sizeToSliderPos(ts.size, sliderMax));
    els.sizeSlider.dataset.maxPx = String(sliderMax);
  }
  if (els.opacitySlider) {
    els.opacitySlider.value = String(Math.round((ts.opacity ?? 1.0) * 100));
  }
  updateSidebarBrushIndicator();
  updateSidebarSlider2Label();
}

// v97：size slider log 化 helpers
function sliderPosToSize(pos, maxPx) {
  const t = Math.max(0, Math.min(100, pos)) / 100;
  return Math.max(1, Math.round(Math.exp(t * Math.log(Math.max(2, maxPx)))));
}
function sizeToSliderPos(size, maxPx) {
  const t = Math.log(Math.max(1, size)) / Math.log(Math.max(2, maxPx));
  return Math.round(Math.max(0, Math.min(1, t)) * 100);
}
function updateSidebarSlider2Label() {
  // v98：slider 永远标「透」(opacity 语义)。
  // user：「slider 是 opacity 不是 flow」。flow 在 brush settings 改。
}

// 滑块改值 → 写回当前工具的 toolState（shapes 写到 brush）
function writeCurrentToolSize(v) {
  const ts = state.toolStates[getRackToolKey(state.tool)];
  if (ts) ts.size = v;
}
function writeCurrentToolOpacity(v) {
  const ts = state.toolStates[getRackToolKey(state.tool)];
  if (ts) ts.opacity = v;
}
function selectBrushPresetForTool(tool, brushId) {
  const key = getRackToolKey(tool);
  const ts = state.toolStates[key];
  if (!ts) return;
  const brush = findBrush(_brushRack, brushId);
  if (!brush) return;
  ts.activeBrushId = brushId;
  ts.size    = brush.size.base;
  // v99r2：opacity 从 preset.defaultOpa 取（默 1.0）；flow 永远 1.0（preset 不存 flow）
  ts.opacity = brush.defaultOpa ?? 1.0;
  ts.flow    = 1.0;
  if (key === getRackToolKey(state.tool)) applyToolState(state.tool);
}

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
  selection:      doc.selection,
  drawingPath:    input.lasso.getDrawingPath(),
  drawingRect:    input.lasso.getDrawingRect(),
  drawingEllipse: input.lasso.getDrawingEllipse(),
  floating:       input.lasso.getFloating(),
  handles:        input.lasso.visibleHandles(),
  sampleMode:     input.lasso.getSampleMode(),
}));

// 蚂蚁线无动画（user 反馈太干扰）；选区改变时 setLassoProvider 已触发 invalidateAll。

// 套索工具栏（v65 重做）。三个 section 按状态切换：
//   - subToolBar：lasso 工具激活时显（不论有没有选区），含 sub-tool picker / set-op / threshold
//   - selectionActions：有选区 + 没在 floating 时显，含 变换 / 取消选区
//   - transformCtrl：floating 状态下显，含 mode picker + 应用 / 取消
// 两行 toolbar stack（v93）：row1 = 选区方式，row2 = 操作 / 变换
const lassoToolbarStack = document.getElementById("lassoToolbarStack");
const lassoToolbarRow1 = document.getElementById("lassoToolbarRow1");
const lassoToolbarRow2 = document.getElementById("lassoToolbarRow2");
const lassoSubToolBar = document.getElementById("lassoSubToolBar");
const lassoSelectionActions = document.getElementById("lassoSelectionActions");
const lassoTransformCtrl = document.getElementById("lassoTransformCtrl");
const lassoSubBtns = [...lassoSubToolBar.querySelectorAll("[data-lasso-sub]")];
const lassoSetOpBtns = [...lassoSubToolBar.querySelectorAll("[data-lasso-setop]")];
const lassoTransformModeBtns = [...lassoTransformCtrl.querySelectorAll("[data-lasso-mode]")];
const lassoThresholdInput = document.getElementById("lassoThreshold");
const lassoThresholdVal = document.getElementById("lassoThresholdVal");
const lassoMagicCfgBtn = document.getElementById("lassoMagicCfgBtn");
const lassoMagicPopup = document.getElementById("lassoMagicPopup");
const lassoConstrainBtn = document.getElementById("lassoConstrainBtn");
const lassoConstrainSep = document.querySelector(".lasso-constrain-sep");

function updateLassoToolbar() {
  const floating = input.lasso.hasFloating();
  const hasSelection = !!doc.selection;
  const lassoActive = state.tool === "lasso";
  const showAny = floating || hasSelection || lassoActive;
  lassoToolbarStack.classList.toggle("hidden", !showAny);
  if (!showAny) return;

  // Row 1：lasso 工具激活 + 不在 floating 才显（floating 时不能新建选区）
  const showRow1 = lassoActive && !floating;
  lassoToolbarRow1.classList.toggle("hidden", !showRow1);
  lassoSubToolBar.classList.toggle("hidden", !showRow1);

  // Row 2：有选区显 selectionActions / floating 显 transformCtrl
  const showSelectionActions = hasSelection && !floating;
  const showTransformCtrl = floating;
  const showRow2 = showSelectionActions || showTransformCtrl;
  lassoToolbarRow2.classList.toggle("hidden", !showRow2);
  lassoSelectionActions.classList.toggle("hidden", !showSelectionActions);
  lassoTransformCtrl.classList.toggle("hidden", !showTransformCtrl);

  // 高亮当前 sub-tool / set-op / transform mode
  const sub = input.lasso.getSubTool();
  for (const b of lassoSubBtns) {
    b.setAttribute("aria-pressed", b.dataset.lassoSub === sub ? "true" : "false");
  }
  lassoMagicCfgBtn.classList.toggle("hidden", sub !== "magic");
  // 子工具切走 → 关掉魔术棒 popup（油漆桶按工具栏没装；按 ⚙ 仅在 magic 下出）
  if (sub !== "magic") lassoMagicPopup.classList.add("hidden");
  // 1:1 约束按钮：仅 rect / ellipse 子工具下显示
  const showConstrain = sub === "rect" || sub === "ellipse";
  lassoConstrainBtn.classList.toggle("hidden", !showConstrain);
  lassoConstrainSep.classList.toggle("hidden", !showConstrain);
  if (showConstrain) {
    lassoConstrainBtn.setAttribute("aria-pressed", input.lasso.getConstrainSquare() ? "true" : "false");
  }
  const setOp = input.lasso.getSetOpMode();
  for (const b of lassoSetOpBtns) {
    b.setAttribute("aria-pressed", b.dataset.lassoSetop === setOp ? "true" : "false");
  }
  if (floating) {
    const mode = input.lasso.getMode();
    for (const b of lassoTransformModeBtns) {
      b.setAttribute("aria-pressed", b.dataset.lassoMode === mode ? "true" : "false");
    }
    const sm = input.lasso.getSampleMode();
    for (const b of lassoTransformCtrl.querySelectorAll("[data-lasso-sample]")) {
      b.setAttribute("aria-pressed", b.dataset.lassoSample === sm ? "true" : "false");
    }
  }
}

// sub-tool picker
for (const b of lassoSubBtns) {
  b.addEventListener("click", () => {
    input.lasso.setSubTool(b.dataset.lassoSub);
    updateLassoToolbar();
  });
}
// set-op modifier
for (const b of lassoSetOpBtns) {
  b.addEventListener("click", () => {
    input.lasso.setSetOpMode(b.dataset.lassoSetop);
    updateLassoToolbar();
  });
}
// magic threshold（容隙功能 v71→v79 撤掉，详 docs/lessons-magic-wand-gap-closing.md）
lassoThresholdInput.addEventListener("input", () => {
  const v = parseInt(lassoThresholdInput.value, 10) || 0;
  input.lasso.setMagicThreshold(v);
  lassoThresholdVal.textContent = String(v);
});
// 设置按钮 → popup toggle
function toggleMagicPopup(e) {
  e.stopPropagation();
  lassoMagicPopup.classList.toggle("hidden");
}
lassoMagicCfgBtn.addEventListener("click", toggleMagicPopup);
// 点 popup 外侧 → 关
document.addEventListener("pointerdown", (e) => {
  if (lassoMagicPopup.classList.contains("hidden")) return;
  if (lassoMagicPopup.contains(e.target)) return;
  if (lassoMagicCfgBtn.contains(e.target)) return;
  lassoMagicPopup.classList.add("hidden");
});
// 1:1 约束 toggle（rect / ellipse 用）
lassoConstrainBtn.addEventListener("click", () => {
  input.lasso.setConstrainSquare(!input.lasso.getConstrainSquare());
  updateLassoToolbar();
});

// 选区动作
document.getElementById("lassoTransformBtn").addEventListener("click", () => {
  if (!doc.selection) return;
  const ok = input.lasso.liftSelectionForTransform(doc.activeLayer);
  if (ok) updateLassoToolbar();
});
document.getElementById("lassoDeselectBtn").addEventListener("click", () => {
  const entry = input.lasso.setSelection(null);
  if (entry && history) history.push(entry);
  board.invalidateAll();
  updateLassoToolbar();
});
// 填色：选区内填当前颜色（push stroke-type entry，可 Ctrl+Z）
document.getElementById("lassoFillBtn").addEventListener("click", () => {
  const layer = doc.activeLayer;
  if (!layer || !doc.selection) return;
  const before = layer.snapshot();
  fillSelectionOnLayer(layer, doc.selection, state.color);
  const after = layer.snapshot();
  const entry = { type: "stroke", layerId: layer.id, before, after, beforeBlob: null, afterBlob: null };
  history.push(entry);
  compressPixelSnap(entry.before, (blob) => { entry.beforeBlob = blob; });
  compressPixelSnap(entry.after,  (blob) => { entry.afterBlob  = blob; });
  board.invalidateAll();
  setStatus(`已填色：${state.color}`);
});
// 清除：选区内 dst-out
document.getElementById("lassoClearBtn").addEventListener("click", () => {
  const layer = doc.activeLayer;
  if (!layer || !doc.selection) return;
  const before = layer.snapshot();
  clearSelectionOnLayer(layer, doc.selection);
  const after = layer.snapshot();
  const entry = { type: "stroke", layerId: layer.id, before, after, beforeBlob: null, afterBlob: null };
  history.push(entry);
  compressPixelSnap(entry.before, (blob) => { entry.beforeBlob = blob; });
  compressPixelSnap(entry.after,  (blob) => { entry.afterBlob  = blob; });
  board.invalidateAll();
  setStatus("已清除选区内像素");
});
// 反选：在 docW×docH 上 mask 取反
document.getElementById("lassoInvertBtn").addEventListener("click", () => {
  const inv = invertSelection(doc.selection, doc.width, doc.height);
  const entry = input.lasso.setSelection(inv);
  if (entry && history) history.push(entry);
  board.invalidateAll();
  updateLassoToolbar();
});

// transform 模式 picker + 应用 / 取消
for (const b of lassoTransformModeBtns) {
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
// Stamp：写入图层但保留 float（连击多次叠加复印）
document.getElementById("lassoStampBtn").addEventListener("click", () => {
  if (!input.lasso.hasFloating()) return;
  if (input.lasso.stamp()) {
    board.invalidateAll();
    setStatus("已复印");
  }
});
// 插值模式 picker
const lassoSampleBtns = [...lassoTransformCtrl.querySelectorAll("[data-lasso-sample]")];
for (const b of lassoSampleBtns) {
  b.addEventListener("click", () => {
    input.lasso.setSampleMode(b.dataset.lassoSample);
    board.invalidateAll();
    updateLassoToolbar();
  });
}
// 选区 → 新层 / 复制层
document.getElementById("lassoDuplicateBtn").addEventListener("click", () => {
  selectionToNewLayer({ move: false });
});
document.getElementById("lassoMoveToLayerBtn").addEventListener("click", () => {
  selectionToNewLayer({ move: true });
});
function selectionToNewLayer({ move }) {
  const sel = doc.selection;
  if (!sel) { setStatus("没选区"); return; }
  if (doc.layers.length >= doc.maxLayers) { setStatus(`图层数已达上限 ${doc.maxLayers}`); return; }
  const src = doc.activeLayer;
  if (!src) return;
  const beforeActive = move ? src.snapshot() : null;
  const newL = doc.addLayer(move ? "移到新层" : "复制层");
  if (!newL) return;
  // 把 newL 的 bbox / canvas 重设为 selection bbox
  newL.bboxX = sel.bboxX;
  newL.bboxY = sel.bboxY;
  newL.bboxW = sel.bboxW;
  newL.bboxH = sel.bboxH;
  newL.canvas.width = sel.bboxW;
  newL.canvas.height = sel.bboxH;
  newL.ctx = newL.canvas.getContext("2d", { willReadFrequently: false });
  newL.ctx.imageSmoothingEnabled = true;
  newL.ctx.imageSmoothingQuality = "low";
  // 把 active ∩ selection 的像素 copy 进 newL
  newL.ctx.drawImage(src.canvas, src.bboxX - sel.bboxX, src.bboxY - sel.bboxY);
  newL.ctx.globalCompositeOperation = "destination-in";
  newL.ctx.drawImage(sel.maskCanvas, 0, 0);
  newL.ctx.globalCompositeOperation = "source-over";
  if (move) {
    src.ctx.save();
    src.ctx.globalCompositeOperation = "destination-out";
    src.ctx.drawImage(sel.maskCanvas, sel.bboxX - src.bboxX, sel.bboxY - src.bboxY);
    src.ctx.restore();
  }
  const insertIndex = doc.layers.findIndex((l) => l.id === newL.id);
  const newLayerSpec = layerSpecFrom(newL);
  const afterActive = move ? src.snapshot() : null;
  history.push({
    type: "selectionToLayer",
    isMove: move,
    newLayerSpec, insertIndex,
    activeLayerId: src.id,
    beforeActive, afterActive,
  });
  // 异步压缩 newL pixels（同 removeLayer 路径）
  compressPixelSnap(newLayerSpec, (blob) => { newLayerSpec.blob = blob; });
  if (move && beforeActive) compressPixelSnap(beforeActive, (blob) => { beforeActive.blob = blob; });
  if (move && afterActive)  compressPixelSnap(afterActive,  (blob) => { afterActive.blob = blob; });
  _afterDocChange();
  setStatus(move ? "已移到新层" : "已复制到新层");
}
window.addEventListener("wp:lassochange", updateLassoToolbar);
// 任何 history push/undo/redo 都可能改 doc.selection → 刷新 toolbar 显隐
window.addEventListener("wp:histchange", updateLassoToolbar);

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

// ---- Pending transients 架构级护栏 ----
// 思路：app 里可能有多种"未提交的瞬时编辑状态"（套索浮层、未来的 text in progress、
// shape draft 等）。任何"用户决定性动作"（切工具 / save / 切 session / 进图库 / rename）
// 之前，都应该让每个 pending state 有个 apply 的机会。
// 每个 transient state 注册 (check, apply, label)。
// - check(): 当前是否有 pending
// - apply(): 把 pending 烤进 doc / layer / 等持久状态
// - label: 调试用
const _pendingTransients = [];
function registerPendingTransient({ check, apply, label }) {
  _pendingTransients.push({ check, apply, label });
}
function hasAnyPendingTransient() {
  return _pendingTransients.some((p) => { try { return p.check(); } catch { return false; } });
}
function applyAllPendingTransients() {
  for (const p of _pendingTransients) {
    try { if (p.check()) p.apply(); }
    catch (e) { console.warn(`[pending] ${p.label} apply failed:`, e); }
  }
}

// 注册套索浮层。未来 text / shape 工具的 in-progress state 也在这注册一行
registerPendingTransient({
  label: "lasso-floating",
  check: () => input.lasso.hasFloating(),
  apply: () => input.commitLassoIfFloating(),
});

// ---- 工具 ----
function setTool(t) {
  // v96：airbrush 工具不存在了。老 doc 持久化里可能存了 "airbrush" → 透明回退到 brush
  if (t === "airbrush") t = "brush";
  // 切工具 = 用户决定性动作 → 让所有 pending 先 apply（套索浮层 commit 等）
  applyAllPendingTransients();
  state.tool = t;
  for (const b of els.toolBtns) b.setAttribute("aria-pressed", b.dataset.tool === t ? "true" : "false");
  // 液化没有独立 data-tool topbar 按钮，但 adjust 按钮在该工具下高亮
  els.topAdjustBtn.setAttribute("aria-pressed", t === "liquify" ? "true" : "false");
  document.body.dataset.tool = t;
  updateLassoToolbar();   // sub-tool bar 跟着工具切换显隐
  // shapes 子工具栏只在 shapes tool 下显
  const shapesToolbar = document.getElementById("shapesToolbar");
  if (shapesToolbar) shapesToolbar.classList.toggle("hidden", t !== "shapes");
  // 切工具 → 应用该工具的 per-tool state（size/flow/activeBrushId）+ preset 冻结字段
  if (t === "brush" || t === "smudge" || t === "eraser" || t === "shapes" || t === "airbrush") {
    applyToolState(t);
  }
  // v80 占位：smudge / shapes / airbrush engine 未上，先按 brush 路径走
  if (t === "smudge" || t === "shapes" || t === "airbrush") {
    setStatus(`${t} 工具 engine 待 v83+ 实装；现在按 brush 走（已应用对应 per-tool 状态）`);
  }
}
// Rack 工具 → 对应的 exclusive panel id
const RACK_PANEL_BY_TOOL = {
  brush: PANELS.RACK_BRUSH,
  smudge: PANELS.RACK_SMUDGE,
  eraser: PANELS.RACK_ERASER,
  shapes: PANELS.RACK_BRUSH,    // shapes 共用 brush 的 rack
};
for (const b of els.toolBtns) {
  b.addEventListener("click", () => {
    const t = b.dataset.tool;
    // tap-active-again：已激活的 rack 工具再点 → 开/关该工具的笔架 sheet
    // 详 conversation v79→v80：「tap = 切换 / 已激活 tap = 开 rack」
    if (state.tool === t && RACK_PANEL_BY_TOOL[t]) {
      openExclusive(RACK_PANEL_BY_TOOL[t]);
      return;
    }
    setTool(t);
    // 切到新 tool 时关掉之前开的 rack（防止 stale）
    closeExclusive();
  });
}
window.addEventListener("wp:settool", (e) => setTool(e.detail));

// ---- Shapes 子工具栏（v86）----
{
  const tb = document.getElementById("shapesToolbar");
  if (tb) {
    const subBtns = [...tb.querySelectorAll("[data-shape-sub]")];
    const eqBtn = document.getElementById("shapesEqualAspectBtn");
    const alBtn = document.getElementById("shapesAlignAxisBtn");
    const refresh = () => {
      const sub = input.shapes.getSubtool();
      for (const b of subBtns) b.setAttribute("aria-pressed", b.dataset.shapeSub === sub ? "true" : "false");
      eqBtn.setAttribute("aria-pressed", input.shapes.getEqualAspect() ? "true" : "false");
      alBtn.setAttribute("aria-pressed", input.shapes.getAlignAxis() ? "true" : "false");
    };
    for (const b of subBtns) {
      b.addEventListener("click", () => { input.shapes.setSubtool(b.dataset.shapeSub); refresh(); });
    }
    eqBtn.addEventListener("click", () => { input.shapes.setEqualAspect(!input.shapes.getEqualAspect()); refresh(); });
    alBtn.addEventListener("click", () => { input.shapes.setAlignAxis(!input.shapes.getAlignAxis()); refresh(); });
    refresh();
  }
}
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

// Brush rack 异步加载：boot 时拿 IDB 缓存，把 toolStates 缺失字段从 rack 补齐
// 然后应用当前 tool 的 state
loadBrushRack().then((rack) => {
  _brushRack = rack;
  for (const t of Object.keys(state.toolStates)) {
    if (state.toolStates[t].activeBrushId == null) {
      const init = defaultToolStateFor(t);
      Object.assign(state.toolStates[t], init);
    }
  }
  applyToolState(state.tool);
  updateSidebarBrushIndicator();
  setTimeout(() => { checkBrushRackCloud().catch(() => {}); }, 2000);
}).catch((e) => {
  // **关键**：IDB 在 iPad Safari 私密浏览模式下会 throw。loadBrushRack 内部已有
  // try/catch fallback；这条 catch 接住极端情况（boot 期 promise 链外 throw）。
  // 至少给个 in-memory rack 让 user 能画
  console.warn("[brush-rack] init failed:", e);
  _brushRack = makeDefaultRack();
  applyToolState(state.tool);
  updateSidebarBrushIndicator();
  setStatus("笔架持久化失败（可能私密浏览）：本次 session 可用，重启会重置", true);
});

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

// v104: size 滑块 popup（px + mini circle 预览，1.2s 自动隐）
let _sizePopupTimer = null;
function showSizePopup(px) {
  if (!els.sizePopup) return;
  const r = Math.max(2, Math.min(60, px / 2));
  els.sizePopupCircle.style.width  = (r * 2) + "px";
  els.sizePopupCircle.style.height = (r * 2) + "px";
  els.sizePopupText.textContent = `${px|0} px`;
  const rect = els.sizeSlider.getBoundingClientRect();
  // 浮在 slider 右侧，竖直中线对齐 popup 中心
  els.sizePopup.style.left = (rect.right + 12) + "px";
  els.sizePopup.style.top  = (rect.top + rect.height / 2 - 30) + "px";
  els.sizePopup.classList.remove("hidden");
  clearTimeout(_sizePopupTimer);
  _sizePopupTimer = setTimeout(() => els.sizePopup.classList.add("hidden"), 1200);
}

// v97：setSize 接受 px；slider 转 log；setIntensity 路由 flow/opacity
function setSize(v) {
  v = Math.max(1, Math.round(v));        // v104: clamp to int
  state.brush.size = v;
  writeCurrentToolSize(v);
  safeLSSet("webpaint.size", String(v));
  // 同步 slider（log 化）
  const maxPx = parseInt(els.sizeSlider.dataset.maxPx, 10) || 200;
  els.sizeSlider.value = String(sizeToSliderPos(v, maxPx));
  showSizePopup(v);
}
function setOpacity(v) {
  state.brush.opacity = v;
  writeCurrentToolOpacity(v);
  safeLSSet("webpaint.opacity", String(v));
  els.opacitySlider.value = String(Math.round(v * 100));
}
// 老 setIntensity alias 给跨 v97 调用兜底
const setIntensity = setOpacity;
// v97：size slider log → px。max 100 (slider pos), 实际 px = sliderPosToSize
els.sizeSlider.addEventListener("input", () => {
  const pos = parseFloat(els.sizeSlider.value);
  const maxPx = parseInt(els.sizeSlider.dataset.maxPx, 10) || 200;
  const px = sliderPosToSize(pos, maxPx);   // sliderPosToSize 已 round 到 int
  state.brush.size = px;
  writeCurrentToolSize(px);
  safeLSSet("webpaint.size", String(px));
  showSizePopup(px);
});
els.opacitySlider.addEventListener("input", () => setOpacity(parseFloat(els.opacitySlider.value) / 100));
// boot 初值
els.sizeSlider.dataset.maxPx = "200";
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
// v100：删「检测更新」menu (实测在 iPad PWA 上不可靠，user：「检测更新功能没用」)。
// 强制更新一律走「强制清缓存重启」（menuForcePwaReset）— 详 docs/pwa-update-detection.md。
// 老 element 在 HTML 里 hidden，handler 留空保 element exists 防 null deref。
if (els.menuCheckUpdate) els.menuCheckUpdate.addEventListener("click", () => setMenuOpen(false));
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
// 文档版本警告：在 setStatus 之上再呈现一个持久 banner（用 doc.body.dataset 给 CSS 染色）
function updateNewerBanner() {
  if (_loadedDocIsNewer && !_loadedDocNewerConfirmed) {
    document.body.dataset.docNewer = "1";
  } else {
    delete document.body.dataset.docNewer;
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
    const isRef = doc.referenceLayerId === L.id;
    row.className = "layer-row"
      + (i === doc.activeIndex ? " active" : "")
      + (L.clippingMask ? " clipping" : "")
      + (isRef ? " reference" : "");
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

    // Clipping mask 视觉提示：剪裁层左侧加 ↘ 标
    if (L.clippingMask) {
      const chip = document.createElement("span");
      chip.className = "layer-clip-chip";
      chip.textContent = "↘";
      chip.title = "已剪裁到下方第一颗非剪裁层";
      row.appendChild(chip);
    }
    // 参考层视觉提示：右侧加「参」chip
    if (isRef) {
      const chip = document.createElement("span");
      chip.className = "layer-ref-chip";
      chip.textContent = "参";
      chip.title = "参考层：魔棒 / 油漆桶读这一层";
      row.appendChild(chip);
    }

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

      // Clipping mask 切换：剪裁到下方第一颗非剪裁层（Procreate 行为）
      const clipRow = document.createElement("div");
      clipRow.className = "layer-slider-row";
      clipRow.innerHTML = `
        <span>剪裁</span>
        <span class="layer-clip-hint">↘ 跟随下方</span>
        <button type="button" class="layer-clip-toggle" aria-pressed="${L.clippingMask ? "true" : "false"}">${L.clippingMask ? "开" : "关"}</button>
      `;
      const clipBtn = clipRow.querySelector(".layer-clip-toggle");
      clipBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const oldVal = L.clippingMask;
        L.clippingMask = !oldVal;
        history.push({
          type: "setLayerProp", layerId: L.id,
          prop: "clippingMask", oldVal, newVal: L.clippingMask,
        });
        renderLayersPanel();
        board.invalidateAll();
        board.requestRender();
      });
      expand.appendChild(clipRow);

      // 参考层 toggle：unique；设这一层时自动清掉旧的
      const refRow = document.createElement("div");
      refRow.className = "layer-slider-row";
      const isRefNow = doc.referenceLayerId === L.id;
      refRow.innerHTML = `
        <span>参考</span>
        <span class="layer-clip-hint">魔棒 / 油漆桶读这层</span>
        <button type="button" class="layer-clip-toggle" aria-pressed="${isRefNow ? "true" : "false"}">${isRefNow ? "开" : "关"}</button>
      `;
      const refBtn = refRow.querySelector(".layer-clip-toggle");
      refBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const oldVal = doc.referenceLayerId;
        const newVal = isRefNow ? null : L.id;
        doc.referenceLayerId = newVal;
        history.push({ type: "setReferenceLayer", oldVal, newVal });
        renderLayersPanel();
      });
      expand.appendChild(refRow);

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
// ============ Sync gate ============
// 锁屏 + 同步状态决策。详见 docs/sync-design.md
//
// 设计原则：
//   - 应该连线 → 拦住用户等
//   - 应该连线但离线 / token 过期 → user 显式 consent（选「离线」/「登录」）
//   - 未登录 / 一开始就 offline → 直接走，不卡
//   - 转圈期间 user 可随时点「离线」fall back，不强制等满
//   - 「离线」选择**不**更新 lastSessionSignedIn → 意图保留，下次进还问

const syncGate = {
  backdrop: document.getElementById("syncGateBackdrop"),
  sheet: document.getElementById("syncGateSheet"),
  title: document.getElementById("syncGateTitle"),
  message: document.getElementById("syncGateMessage"),
  spinner: document.getElementById("syncGateSpinner"),
  actions: document.getElementById("syncGateActions"),
};
function lockSyncGate({ title, message, showSpinner, actions }) {
  syncGate.title.textContent = title;
  syncGate.message.textContent = message;
  syncGate.spinner.classList.toggle("hidden", !showSpinner);
  syncGate.actions.innerHTML = "";
  return new Promise((resolve) => {
    for (const a of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = a.label;
      if (a.primary) btn.classList.add("primary");
      btn.addEventListener("click", () => { unlockSyncGate(); resolve(a.value); });
      syncGate.actions.appendChild(btn);
    }
    syncGate.backdrop.classList.remove("hidden");
    syncGate.sheet.classList.remove("hidden");
    // 暴露 resolve 让 fetch 完成时能从外部 unlock 并返回
    syncGate._pendingResolve = resolve;
  });
}
function unlockSyncGate() {
  syncGate.backdrop.classList.add("hidden");
  syncGate.sheet.classList.add("hidden");
  syncGate._pendingResolve = null;
}
function settleSyncGate(value) {
  if (syncGate._pendingResolve) {
    const r = syncGate._pendingResolve;
    unlockSyncGate();
    r(value);
  }
}

// 主流程：openSession 后调一次
async function gateCloudSyncOnOpen(sessionName) {
  // 未登录过 / 没开 OneDrive 配置 → 不卡
  if (!isAuthConfigured() || !getLastSessionSignedIn()) return;

  const online = navigator.onLine;
  // 上次登录这次离线 → 锁屏问意图（不动 lastSessionSignedIn 直到 user 选）
  if (!online) {
    const choice = await lockSyncGate({
      title: "未连接网络",
      message: "上次是登录 OneDrive 状态。离线只能用本地缓存。",
      showSpinner: false,
      actions: [
        { label: "离线模式", value: "offline" },
        { label: "稍后再试（取消）", value: "offline", primary: false },
      ],
    });
    if (choice === "offline") setStatus("离线模式：用本地缓存", true);
    return;
  }

  // 上次登录这次在线但 isSignedIn() false → 先 silent retry 一次确认；
  // user：「老是提示 onedrive token 过期，但实际上可以正常拉取保存」
  // → isSignedIn() 是 stale 状态，silent acquire 仍可能拿到 token
  if (!isSignedIn()) {
    try { await retrySilentSignIn(); } catch (_) {}
  }
  // 真的拿不到 token → 才弹 gate
  if (!isSignedIn()) {
    const choice = await lockSyncGate({
      title: "OneDrive 登录已过期",
      message: "token 失效。重登拿云端，离线用本地。",
      showSpinner: false,
      actions: [
        { label: "重新登录", value: "signin", primary: true },
        { label: "离线模式", value: "offline" },
      ],
    });
    if (choice === "signin") {
      try { await signIn(); setStatus("已登录"); }
      catch (e) { setStatus("登录失败：" + (e.message || e), true); return; }
      // 登录成功 → 重入流程
      return gateCloudSyncOnOpen(sessionName);
    }
    return;     // offline
  }

  // 登录 + 在线 + token 有效 → 拉云端 etag 比对
  await checkCloudETag(sessionName);
}

// 拉 etag，转圈 + 「离线」按钮立刻可用；无硬超时。
async function checkCloudETag(sessionName) {
  if (!sessionName) return;
  // 起 spinner 锁屏；同时跑 fetch
  const result = await Promise.race([
    lockSyncGate({
      title: "检查云端",
      message: sessionName,
      showSpinner: true,
      actions: [
        { label: "跳过到离线", value: { kind: "skip" } },
      ],
    }),
    (async () => {
      try {
        const meta = await fetchSessionMetadata(sessionName);
        return { kind: "fetched", meta };
      } catch (e) {
        return { kind: "error", error: e };
      }
    })(),
  ]);
  // race 赢家：fetch 完了 → 主动 settle gate（让锁屏关闭）
  // user 跳过：lockSyncGate 已自己 unlock
  if (result.kind === "fetched") settleSyncGate(null);
  else if (result.kind === "error") settleSyncGate(null);

  if (result.kind === "skip") {
    setStatus("已跳过云端检查，用本地版本");
    return;
  }
  if (result.kind === "error") {
    setStatus("连不上云端，用本地版本");
    return;
  }
  // 比对
  const cloudETag = result.meta?.etag || null;
  const localETag = getKnownETag(sessionName);
  if (!cloudETag || cloudETag === localETag) {
    // in sync → 静默
    return;
  }
  // 不一致 → 弹「拉 / 留 / 分支」
  const cloudTime = result.meta?.lastModified || "?";
  const choice = await lockSyncGate({
    title: "云端有新版本",
    message: `${sessionName} 在云端 ${formatCloudTime(cloudTime)} 有新版本。本地是 ${getLocalSavedAtLabel()}。`,
    showSpinner: false,
    actions: [
      { label: "拉云端（备份本地）", value: "pull", primary: true },
      { label: "保留本地（之后 push 可能冲突）", value: "keep" },
      { label: "云端开为副本", value: "branch" },
    ],
  });
  if (choice === "pull") {
    setStatus("正在拉云端…");
    // **顺序很重要**：先备份本地，再拉云端，再覆盖
    //   备份失败 → 整个 abort，本地不动
    //   云端拉失败 → 整个 abort，本地不动（backup 是无害多余）
    //   只有都成功才 saveSession 覆盖
    const backupName = `${sessionName}-backup-${Date.now()}`;
    try {
      await renameLocalSessionAsBackup(sessionName, backupName);
    } catch (e) {
      setStatus(`本地备份失败，已取消拉云端：${e.message || e}`, true);
      return;
    }
    try {
      const r = await pullSessionByPath(sessionName + ".ora");
      if (r) {
        const loaded = await decodeOraToDoc(r.blob);
        adoptLoadedDoc(loaded, sessionName);    // 闭锁：显式用 sessionName
        await saveSession(doc, sessionName, {});
        setStatus(`已拉云端；本地原版备份为「${backupName}」`);
      } else {
        setStatus(`云端找不到「${sessionName}」（本地未动，备份「${backupName}」可删）`, true);
      }
    } catch (e) {
      setStatus(`拉云端失败：${e.message || e}（本地未动，备份「${backupName}」可删）`, true);
    }
  } else if (choice === "branch") {
    setStatus("正在拉云端到副本…");
    try {
      const r = await pullSessionByPath(sessionName + ".ora");
      if (r) {
        const branchName = `${sessionName}-cloud-${Date.now()}`;
        const loaded = await decodeOraToDoc(r.blob);
        await saveSession(loaded, branchName, {});
        setStatus(`云端版已开为「${branchName}」`);
      }
    } catch (e) { setStatus("开副本失败：" + (e.message || e), true); }
  } else {
    setStatus("已保留本地，云端版本暂不动");
  }
}

// 把本地 sessionName 复制到 backupName（拉云端前的安全网）。
// **失败必须抛**——caller 不能继续 pull 否则丢画（v77→v78 红线 bug）。
// 注意：是「复制」不是「重命名」；原 sessionName 还在 IDB，等 pull 完才被覆盖。
async function renameLocalSessionAsBackup(name, backupName) {
  const loaded = await openSession(name);
  if (!loaded) throw new Error(`本地找不到「${name}」，无法备份`);
  await saveSession(loaded, backupName, {});
}
function formatCloudTime(iso) {
  if (!iso) return "?";
  const t = Date.parse(iso);
  if (!t) return iso;
  const d = new Date(t);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function getLocalSavedAtLabel() {
  if (!_docLastSavedAt) return "（未保存）";
  const d = new Date(_docLastSavedAt);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
// setReferenceLayer：unique doc-level state
history.registerHandler("setReferenceLayer", {
  undo: (e) => { doc.referenceLayerId = e.oldVal; renderLayersPanel(); },
  redo: (e) => { doc.referenceLayerId = e.newVal; renderLayersPanel(); },
  refsLayer: (e, id) => e.oldVal === id || e.newVal === id,
});
// selectionToLayer：复合 entry。undo / redo 同步处理 newLayer + active 改变
history.registerHandler("selectionToLayer", {
  undo: async (e) => {
    // 1. 删 new layer
    doc.removeLayer(e.newLayerSpec.id);
    // 2. 还原 active layer（仅 move 模式）
    if (e.isMove && e.beforeActive) {
      const L = doc.findLayer(e.activeLayerId);
      if (L) await applyPixelSnap(doc, L.id, e.beforeActive, e.beforeActive.blob, board);
    }
    // 3. active 切回原来
    doc.setActiveById(e.activeLayerId);
    _afterDocChange();
  },
  redo: async (e) => {
    const spec = e.newLayerSpec;
    if (spec.blob && !spec.imageData) {
      const bitmap = await createImageBitmap(spec.blob);
      doc.insertLayerAt(e.insertIndex, { ...spec, bitmap });
      bitmap.close?.();
    } else {
      doc.insertLayerAt(e.insertIndex, spec);
    }
    if (e.isMove && e.afterActive) {
      const L = doc.findLayer(e.activeLayerId);
      if (L) await applyPixelSnap(doc, L.id, e.afterActive, e.afterActive.blob, board);
    }
    doc.setActiveById(spec.id);
    _afterDocChange();
  },
  refsLayer: (e, id) => e.newLayerSpec.id === id || e.activeLayerId === id,
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
// 当前 doc 由比自己高的 WebPaint 版本写过 → 编辑保存有降级风险
let _loadedDocIsNewer = false;
let _loadedDocWriterVer = null;
let _loadedDocNewerConfirmed = false;   // user 已经确认过本 session 的降级风险
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
// opts.implicit = autosave / visibility / pagehide 这类后台路径。
// floating 状态下 implicit 路径**完全跳**——不把"layer 有洞"持久化进 IDB。
// 显式路径（Ctrl+S / 切 session / 进图库 / rename）会自动 commit floating 再保存，
// 匹配用户语义"save = 当前所见，包含正在变换"
async function saveNow(opts = {}) {
  if (_docSaving) return;
  if (hasAnyPendingTransient()) {
    if (opts.implicit) return;             // 后台路径：保持 IDB 干净，等用户回来
    applyAllPendingTransients();           // 显式路径：先把变换 / 浮层等都 apply
  }
  // 文档来自更新版本 → 用户必须显式确认才能覆盖（每个 session 只问一次）
  // implicit 路径（autosave / visibility / pagehide）直接 skip 保存——防自动覆盖
  if (_loadedDocIsNewer && !_loadedDocNewerConfirmed) {
    if (opts.implicit) return;
    const ok = await openConfirmSheet(
      `覆盖更新版本写的画？`,
      `这画由 ${_loadedDocWriterVer} 写的，你是 ${window.WEBPAINT_VERSION}。` +
      `保存会丢失新版本特有的属性（如新图层 flag 等）。建议先刷新升级。`,
    );
    if (!ok) { setStatus("已取消保存"); return; }
    _loadedDocNewerConfirmed = true;
    updateNewerBanner();
  }
  _docSaving = true;
  updateSaveStatus();
  try {
    await saveSession(doc, _activeSessionName, {
      referenceImage: referenceWindow.getPersistBlob(),
      webpaintState: { reference: referenceWindow.getSerializedState(), color: state.color, toolStates: state.toolStates, palette: paletteWindow.getSerializedState() },
    });
    _docDirty = false;
    _docLastSavedAt = Date.now();
    setStatus(`已保存：${_activeSessionName}`);
    checkQuotaAndWarn();
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
  // 跟层无关的 doc-level state（之前漏带 → reload 后丢失）
  doc.referenceLayerId = loaded.referenceLayerId ?? null;
  doc.selection = null;     // 跨 session 不沿用选区
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
  // 文档版本检测：写入这画时的 WebPaint 版本 > 当前 → 警告
  // 防：旧客户端打开新版写的画 → 编辑 → 保存时把新版独有的层属性
  // （clipping / reference / 未来的扩展）静默吃掉。
  _loadedDocIsNewer = false;
  _loadedDocNewerConfirmed = false;
  const writerN = parseAppVersion(loaded._wroteWith);
  const selfN   = parseAppVersion(window.WEBPAINT_VERSION);
  if (writerN !== null && selfN !== null && writerN > selfN) {
    _loadedDocIsNewer = true;
    _loadedDocWriterVer = loaded._wroteWith;
    setStatus(
      `这画由 ${loaded._wroteWith} 写的，你是 ${window.WEBPAINT_VERSION} —— ` +
      `编辑保存会丢失新版特有的层属性。建议先刷新升级。`,
      true,
    );
  } else {
    _loadedDocWriterVer = null;
  }
  updateNewerBanner();
  // 恢复 reference 小窗（.ora webpaint/ 扩展）
  // **先清后设**——防上一画的 ref 在异步路径里残留显示（v95 user 反馈）
  referenceWindow.clearBitmap();
  if (loaded._referenceBlob) {
    createImageBitmap(loaded._referenceBlob).then((bitmap) => {
      referenceWindow.setBitmap(bitmap, { persistBlob: loaded._referenceBlob });
      if (loaded._webpaintState?.reference) {
        referenceWindow.applySerializedState(loaded._webpaintState.reference);
      }
    }).catch(() => {});
  } else if (loaded._webpaintState?.reference) {
    referenceWindow.applySerializedState(loaded._webpaintState.reference);
  }
  // 恢复 per-doc 的 color + per-tool 状态（v82 起）
  if (loaded._webpaintState?.color) {
    setColor(loaded._webpaintState.color);
  }
  // 恢复调色板（v87 起）
  if (loaded._webpaintState?.palette) {
    try { paletteWindow.applySerializedState(loaded._webpaintState.palette); } catch (_) {}
  }
  if (loaded._webpaintState?.toolStates && typeof loaded._webpaintState.toolStates === "object") {
    for (const t of Object.keys(state.toolStates)) {
      const saved = loaded._webpaintState.toolStates[t];
      if (saved && typeof saved === "object") {
        // v98：opacity/flow 分离；老 doc 的 .intensity 当 opacity 兼容
        const op = typeof saved.opacity === "number" ? saved.opacity
                 : typeof saved.intensity === "number" ? saved.intensity
                 : typeof saved.flow === "number" ? saved.flow
                 : state.toolStates[t].opacity;
        const fl = typeof saved.flow === "number" && typeof saved.opacity === "number" ? saved.flow
                 : state.toolStates[t].flow;
        Object.assign(state.toolStates[t], {
          size: typeof saved.size === "number" ? saved.size : state.toolStates[t].size,
          opacity: op,
          flow: fl,
          activeBrushId: typeof saved.activeBrushId === "string" ? saved.activeBrushId : state.toolStates[t].activeBrushId,
        });
      }
    }
    applyToolState(state.tool);
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
        webpaintState: { reference: referenceWindow.getSerializedState(), color: state.color, toolStates: state.toolStates, palette: paletteWindow.getSerializedState() },
      });
      await pushSession(_activeSessionName, ora);
      setStatus(`已同步到云端：${_activeSessionName}`);
      renderGallery();
    } catch (e) {
      if (e instanceof CloudConflictError) {
        // 412 → 锁屏 + 弹「拉云端 / 保留本地 / 都留」
        _cloudPushing = false;
        updateSaveStatus();
        const sessionName = _activeSessionName;
        const choice = await lockSyncGate({
          title: "云端有更新版本",
          message: `${sessionName} 在云端已被改过。推会覆盖那次改动。`,
          showSpinner: false,
          actions: [
            { label: "拉云端覆盖本地（备份本地）", value: "pull", primary: true },
            { label: "保留本地另存为副本", value: "rename" },
            { label: "都留（云端开为副本）", value: "branch" },
          ],
        });
        if (choice === "pull") {
          // 同 gateCloudSyncOnOpen 的 pull：先备份本地，再拉云端，再覆盖
          const backupName = `${sessionName}-backup-${Date.now()}`;
          try {
            await renameLocalSessionAsBackup(sessionName, backupName);
          } catch (err) {
            setStatus(`本地备份失败，已取消拉云端：${err.message || err}`, true);
            return;
          }
          try {
            const r = await pullSessionByPath(sessionName + ".ora");
            if (r) {
              const loaded = await decodeOraToDoc(r.blob);
              adoptLoadedDoc(loaded, sessionName);
              await saveSession(doc, sessionName, {});
              setStatus(`已拉云端；本地原版备份为「${backupName}」`);
            } else {
              setStatus(`云端找不到「${sessionName}」（备份「${backupName}」可删）`, true);
            }
          } catch (err) {
            setStatus(`拉云端失败：${err.message || err}（备份「${backupName}」可删）`, true);
          }
        } else if (choice === "rename") {
          const newName = await renameCurrentSession({ suggested: sessionName + " (新)", reason: "云端冲突" });
          if (newName && isSignedIn()) {
            setCloudDirty(newName, true);
            queueSave("push");
          }
        } else if (choice === "branch") {
          try {
            const r = await pullSessionByPath(sessionName + ".ora");
            if (r) {
              const branchName = `${sessionName}-cloud-${Date.now()}`;
              const loaded = await decodeOraToDoc(r.blob);
              await saveSession(loaded, branchName, {});
              setStatus(`云端版开为「${branchName}」；本地未变`);
            }
          } catch (err) { setStatus("开副本失败：" + (err.message || err), true); }
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
  // 重命名 = 用户决定性动作 → apply pending（套索浮层等）
  applyAllPendingTransients();
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
        webpaintState: { reference: referenceWindow.getSerializedState(), color: state.color, toolStates: state.toolStates, palette: paletteWindow.getSerializedState() },
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
setInterval(() => { if (_docDirty && !_docSaving) saveNow({ implicit: true }); }, AUTOSAVE_MS);
// visibility / pagehide 抢救（implicit：floating 状态下跳过；layer 留半态在内存，但 IDB 干净）
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && _docDirty && !_docSaving) saveNow({ implicit: true });
});
window.addEventListener("pagehide", () => {
  if (_docDirty && !_docSaving) saveNow({ implicit: true });
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

// ---- 图库 icon（v95：从菜单挪回 topbar，user：「图库从菜单中拿出来单独做一个 icon 放菜单旁边」）----
els.topGalleryBtn.addEventListener("click", () => {
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
// 图层窗口里也加快捷导入照片（user：「图层窗口里应该有导入照片的选项」）
const _layerImportBtn = document.getElementById("layerImportPhotoBtn");
if (_layerImportBtn) {
  _layerImportBtn.addEventListener("click", () => {
    els.oraFileInput.value = "";
    els.oraFileInput.click();
  });
}
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
// ---- 调色板小窗（v87）----
// 256×256 mixer canvas + 刷 / 涂 / 吸 3 工具。吸色 → 主画 setColor。
// 画布内容跟 doc 走（webpaint/state.json 持久化，跟 reference 同模式）
const paletteWindow = new PaletteWindow({
  root: document.getElementById("paletteWindow"),
  onColorSampled: (hex) => setColor(hex),
  getCurrentColor: () => state.color,
});
// 调色板小窗（v87 → v94 撤掉 menu 入口）：UI 已删，code 留 P2（backlog）

els.menuForcePwaReset.addEventListener("click", async () => {
  els.menuPanel?.classList.add("hidden");
  const ok = await openConfirmSheet(
    "强制清缓存重启？",
    "会清掉 SW + Cache Storage，强制重新拉所有 JS / CSS。" +
    "你的画 / 笔架（IDB / OneDrive）不会动。\n" +
    "用途：PWA 卡老版本，点更新还是老的时候用。",
  );
  if (!ok) return;
  try {
    // 1. 注销所有 SW
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister().catch(() => {});
    }
    // 2. 清 Cache Storage（不动 IDB）
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      for (const k of keys) await caches.delete(k).catch(() => {});
    }
    setStatus("已清缓存，正在硬重载…", true);
    setTimeout(() => location.reload(), 200);
  } catch (e) {
    setStatus("清缓存失败：" + (e.message || e), true);
  }
});

els.menuResetBrushRack.addEventListener("click", async () => {
  els.menuPanel?.classList.add("hidden");
  const ok = await openConfirmSheet(
    "重置笔架？",
    "会删除全部自定义笔刷 + 改过的默认笔，恢复出厂 8 个 brush。不可撤销。",
  );
  if (!ok) return;
  _brushRack = makeDefaultRack();
  // 重置所有 toolStates 的 activeBrushId 让 applyToolState 重选默认
  for (const t of Object.keys(state.toolStates)) {
    state.toolStates[t].activeBrushId = null;
    Object.assign(state.toolStates[t], defaultToolStateFor(t));
  }
  await persistBrushRack();
  applyToolState(state.tool);
  // 若 rack sheet 当前开着 → 强制刷一遍
  if (RACK_PANEL_BY_TOOL[state.tool] === getCurrentExclusive()) _renderRackSheet();
  _rackDirty = true;
  if (isSignedIn()) pushBrushRackIfSignedIn();
  _rackDirty = false;
  setStatus(`笔架已重置（${_brushRack.brushes.length} 个 brush）`, true);
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
    // 进图库 = 用户离开编辑场景 → apply 所有 pending transient（套索浮层等）+ 保存
    applyAllPendingTransients();
    if (_docDirty && !_docSaving) await saveNow();
    document.body.dataset.mode = "gallery";
    els.galleryFull.classList.remove("hidden");
    renderGallery();
    updateIdbUsage();
  } else {
    applyAllPendingTransients();
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
els.addImportClipboard.addEventListener("click", async () => {
  els.galleryAddPopup.classList.add("hidden");
  try {
    const blob = await readImageFromClipboard();
    if (!blob) { setStatus("剪贴板里没有图片"); return; }
    const file = new File([blob], "clipboard.png", { type: blob.type || "image/png" });
    await importImageAsNewDoc(file);
    setGalleryOpen(false);
  } catch (e) {
    setStatus("从剪切板新建失败：" + (e && e.message || e));
  }
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
  doc.selection = null;
  doc.referenceLayerId = null;
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
  // user：「新建作品时参考里面的图没更新」→ 清 reference 小窗
  referenceWindow.clearBitmap();
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
    let label = `本地占用：${humanSize(total)}（${sessions.length} 件）`;
    let level = "ok";   // ok | warn | critical
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est && est.quota) {
        const ratio = (est.usage || 0) / est.quota;
        const pct = Math.round(ratio * 100);
        els.galleryFootUsage.title =
          `浏览器分配上限约 ${humanSize(est.quota)}；当前 ${pct}% 已用（含 SW 缓存等）`;
        if (ratio > 0.95) { level = "critical"; label += ` · 已用 ${pct}%`; }
        else if (ratio > 0.8) { level = "warn"; label += ` · 已用 ${pct}%`; }
      }
    }
    els.galleryFootUsage.textContent = label;
    els.galleryFootUsage.classList.toggle("usage-warn", level === "warn");
    els.galleryFootUsage.classList.toggle("usage-critical", level === "critical");
  } catch {
    els.galleryFootUsage.textContent = "占用：未知";
  }
}

// 每次保存后检查一次配额；> 80% 弹状态条提示用户去图库整理。
// 同一阈值短时间内不重复弹（避免每笔 stroke 后骚扰）。
let _lastQuotaWarnLevel = "ok";
async function checkQuotaAndWarn() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return;
    const est = await navigator.storage.estimate();
    if (!est || !est.quota) return;
    const ratio = (est.usage || 0) / est.quota;
    const pct = Math.round(ratio * 100);
    let level = "ok";
    if (ratio > 0.95) level = "critical";
    else if (ratio > 0.8) level = "warn";
    if (level === _lastQuotaWarnLevel) return;
    _lastQuotaWarnLevel = level;
    if (level === "critical") {
      setStatus(`本地存储 ${pct}% 已满 — 立即去图库卸载不常用的作品`, true);
    } else if (level === "warn") {
      setStatus(`本地存储 ${pct}% 已用 — 建议在图库整理`, true);
    }
  } catch {}
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
          gateCloudSyncOnOpen(item.name).catch((e) => console.warn("[sync-gate]", e));
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
  try { await signIn(); setLastSessionSignedIn(true); } catch (e) { setStatus("登录失败：" + (e && e.message || e)); }
});
els.cloudSignOutBtn.addEventListener("click", async () => {
  els.cloudAccountPopup.classList.add("hidden");
  try { await signOut(); } catch (_) {}
  setLastSessionSignedIn(false);    // 显式登出 → 下次不问
  updateCloudAuthUI();
  renderGallery();
});

els.cloudRefreshBtn.addEventListener("click", async () => {
  // 离线 → 在线 后第一次按"刷新"：若未签到但有缓存账号，silent retry 一次
  if (!isSignedIn() && navigator.onLine !== false) {
    await retrySilentSignIn();
    updateCloudAuthUI();
  }
  renderGallery();
});

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
  // **不切走当前 active doc**（user 反馈：拉取不应跳进画布）。
  // 只把云上 .ora 解码 + 写到本地 IDB 作为一条新 session；tile 接下来变成
  // "本地+云"，user 想打开它再点 tile（走 openSession + adoptLoadedDoc 路径）
  try {
    const r = await pullSessionByPath(path);
    if (!r) { setStatus(`找不到：${path}`); return; }
    const loaded = await decodeOraToDoc(r.blob);
    const finalName = await uniqueLocalName(r.suggestedName);
    await saveSession(loaded, finalName, {
      referenceImage: loaded._referenceBlob,
      webpaintState: loaded._webpaintState,
    });
    setStatus(`已从云端拉取到本地：${finalName}（点 tile 打开）`);
    renderGallery();
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
  initAuth().then(() => {
    // silent acquire 成功后 isSignedIn() = true → 同步 lastSessionSignedIn
    if (isSignedIn()) setLastSessionSignedIn(true);
    updateCloudAuthUI();
  }).catch((e) => {
    console.warn("[auth] init failed:", e);
  });
}
// 在线 / 离线变化时刷新云端 UI（标签 / 按钮可见性）。
// online 时尝试 silent re-auth：boot 离线 → activeAccount 为 null；有网了主动 retry 一次
window.addEventListener("online", async () => {
  if (!isSignedIn()) await retrySilentSignIn();
  updateCloudAuthUI();
  if (!els.galleryFull.classList.contains("hidden")) renderGallery();
});
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
    // 启动 sync gate（不阻塞主流程，但锁屏期间用户不能画）
    gateCloudSyncOnOpen(wantedName).catch((e) => console.warn("[sync-gate]", e));
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

// ============ Brush rack sheet + 设置 view（v83）============

const _rackEls = {
  sheet: document.getElementById("brushRackSheet"),
  title: document.getElementById("brushRackTitle"),
  close: document.getElementById("brushRackClose"),
  importBtn: document.getElementById("brushRackImport"),
  newBtn: document.getElementById("brushRackNew"),
  folders: document.getElementById("brushRackFolders"),
  grid: document.getElementById("brushRackGrid"),
  // v99 footer 操作
  exportFolderBtn: document.getElementById("brushRackExportFolder"),
  cloudPushBtn:    document.getElementById("brushRackCloudPush"),
  resetBtn:        document.getElementById("brushRackReset"),
  dumpCodeBtn:     document.getElementById("brushRackDumpCode"),
};
const _settingsEls = {
  view: document.getElementById("brushSettingsView"),
  body: document.getElementById("brushSettingsBody"),
  save: document.getElementById("brushSettingsSave"),
  cancel: document.getElementById("brushSettingsCancel"),
};

const TOOL_LABEL = {
  brush: "笔刷", smudge: "涂抹", eraser: "橡皮",
  shapes: "形状", airbrush: "喷枪",
};
let _rackCurrentFolder = DEFAULT_FOLDER;
let _rackCurrentTool = "brush";   // 当前 rack sheet 显示的工具
let _rackDirty = false;           // sheet 操作 dirty 标记，**关闭时**才同步云（user 指示）

function _showRackSheet(tool) {
  if (!_brushRack) return;
  _rackCurrentTool = tool;
  _rackEls.title.textContent = `笔架 · ${TOOL_LABEL[tool] || tool}`;
  _renderRackSheet();
  _rackEls.sheet.classList.remove("hidden");
}
function _hideRackSheet() {
  _rackEls.sheet.classList.add("hidden");
  if (_rackDirty) {
    persistBrushRack();           // 同步 IDB
    pushBrushRackIfSignedIn();    // 同步云
    _rackDirty = false;
  }
}

// 推云：仅 IDB 已写后调；user 在场（关 sheet 是 explicit action）
async function pushBrushRackIfSignedIn() {
  if (!isSignedIn() || !navigator.onLine) return;
  if (!_brushRack) return;
  try {
    await pushBrushRack(_brushRack);
    setStatus("笔架已同步到云端");
  } catch (e) {
    if (e instanceof CloudConflictError) {
      // 云端有更新版本 → 跟 doc 一样 3 选 sheet
      const choice = await lockSyncGate({
        title: "笔架云端有更新版本",
        message: "另一台设备改过云端笔架。推会覆盖那次改动。",
        showSpinner: false,
        actions: [
          { label: "拉云端覆盖本地", value: "pull", primary: true },
          { label: "保留本地（之后可重推）", value: "keep" },
        ],
      });
      if (choice === "pull") {
        try {
          const pulled = await pullBrushRack();
          if (pulled?.rack) {
            _brushRack = pulled.rack;
            mergeMissingDefaults(_brushRack);   // 防云端空 rack 把本地清空
            await persistBrushRack();
            applyToolState(state.tool);
            setStatus("已拉云端笔架");
          }
        } catch (err) { setStatus("拉云端笔架失败：" + (err.message || err), true); }
      }
    } else {
      console.warn("[brush-rack push]", e);
      setStatus("笔架推送失败：" + (e.message || e), true);
    }
  }
}

// Boot 后调一次：背景拉云端 etag 比对；不一致 + 本地 clean → 默默拉
async function checkBrushRackCloud() {
  if (!isAuthConfigured() || !navigator.onLine || !isSignedIn()) return;
  if (!_brushRack) return;
  try {
    const meta = await fetchBrushRackMetadata();
    if (!meta) return;                          // 云端尚无 → silent OK
    const localETag = getBrushRackKnownETag();
    if (meta.etag === localETag) return;        // 已同步 → silent
    if (_rackDirty) {
      // 本地未推改动，云端也变了 → 等 user 关 sheet 时统一处理冲突
      return;
    }
    // 本地 clean + 云端 newer → 默默拉
    const pulled = await pullBrushRack();
    if (pulled?.rack) {
      _brushRack = pulled.rack;
      mergeMissingDefaults(_brushRack);   // 防云端空 rack 把本地清空
      await persistBrushRack();
      applyToolState(state.tool);
      setStatus("笔架已从云端同步");
    }
  } catch (e) {
    console.warn("[brush-rack cloud check]", e);
  }
}
function _renderRackSheet() {
  // 防护：rack 为空时显「重置笔架」入口而不是空白
  if (!_brushRack || !_brushRack.brushes || _brushRack.brushes.length === 0) {
    _rackEls.folders.innerHTML = "";
    _rackEls.grid.innerHTML = `<div style="padding:20px;text-align:center;color:var(--ink-soft);">
      笔架是空的。<br><br>
      <button class="brush-rack-action" id="_rackEmptyResetBtn">恢复默认笔架（8 个）</button>
    </div>`;
    const btn = document.getElementById("_rackEmptyResetBtn");
    if (btn) btn.addEventListener("click", () => {
      _brushRack = makeDefaultRack();
      for (const t of Object.keys(state.toolStates)) {
        state.toolStates[t].activeBrushId = null;
        Object.assign(state.toolStates[t], defaultToolStateFor(t));
      }
      _rackDirty = true;
      persistBrushRack();
      applyToolState(state.tool);
      _renderRackSheet();
      setStatus(`已恢复默认笔架（${_brushRack.brushes.length} 个）`, true);
    });
    return;
  }
  const brushes = brushesByTool(_brushRack, _rackCurrentTool);
  // 当前工具没 brush 也提示
  if (brushes.length === 0) {
    _rackEls.folders.innerHTML = "";
    _rackEls.grid.innerHTML = `<div style="padding:20px;text-align:center;color:var(--ink-soft);">
      此工具暂无笔刷。点「+ 新建」加一个。
    </div>`;
    return;
  }
  // 收集 folder 列表
  const folderSet = new Set();
  for (const b of brushes) folderSet.add(b.folder || DEFAULT_FOLDER);
  if (folderSet.size === 0) folderSet.add(DEFAULT_FOLDER);
  const folders = Array.from(folderSet);
  if (!folders.includes(_rackCurrentFolder)) _rackCurrentFolder = folders[0];
  // 渲 folder tabs
  _rackEls.folders.innerHTML = "";
  for (const f of folders) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "brush-rack-folder";
    btn.textContent = f;
    btn.setAttribute("aria-pressed", f === _rackCurrentFolder ? "true" : "false");
    btn.addEventListener("click", () => {
      _rackCurrentFolder = f;
      _renderRackSheet();
    });
    _rackEls.folders.appendChild(btn);
  }
  // 渲 brush tiles
  const activeId = state.toolStates[_rackCurrentTool]?.activeBrushId;
  _rackEls.grid.innerHTML = "";
  for (const b of brushes.filter((x) => (x.folder || DEFAULT_FOLDER) === _rackCurrentFolder)) {
    // v96：tile 改 div + 内嵌 gear button（user 不喜欢长按）
    const tile = document.createElement("div");
    tile.className = "brush-rack-tile";
    tile.setAttribute("aria-pressed", b.id === activeId ? "true" : "false");
    tile.dataset.brushId = b.id;
    tile.setAttribute("role", "button");
    tile.tabIndex = 0;
    const preview = document.createElement("div");
    preview.className = "brush-rack-tile-preview";
    if (b.shape.kind === "ellipse") {
      const ar = b.shape.aspect;
      preview.style.transform = `rotate(${b.shape.rotation}deg) scaleY(${ar})`;
    }
    // v107：smoothstep multi-stop 跟 stamp 真值一致；hardness=1 时 16 stops 全 α=1（solid 不浪费）
    preview.style.background = _smoothstepRadialGradient(b.shape.hardness);
    const name = document.createElement("span");
    name.className = "brush-rack-tile-name";
    name.textContent = b.name;
    // gear icon → 直接进设置（不用长按）。v101r2：unicode ⚙ 在 iOS 渲染不一致，换 SVG 小扳手
    const gear = document.createElement("button");
    gear.type = "button";
    gear.className = "brush-rack-tile-edit";
    gear.title = "编辑";
    gear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
    gear.addEventListener("click", (e) => {
      e.stopPropagation();
      closeExclusive();
      _openBrushSettings(b.id);
    });
    tile.appendChild(preview);
    tile.appendChild(name);
    tile.appendChild(gear);
    // tap tile body → 选中 + 关 sheet
    // 注意：选笔只动 state.toolStates（per-doc 活动笔），**不**改 _brushRack 内容。
    // 所以不设 _rackDirty，避免每次切笔都触发云端 push（拿旧 ETag 必然 412 冲突）。
    tile.addEventListener("click", (e) => {
      e.stopPropagation();
      selectBrushPresetForTool(_rackCurrentTool, b.id);
      closeExclusive();
    });
    _rackEls.grid.appendChild(tile);
  }
}

// 注册 panel-state
// **bug 修**：多个 tool map 到同 panel id 时（brush + shapes + airbrush → RACK_BRUSH）
// 后注册的会覆盖前面的 show()。结果点 brush 按钮但 title 显示「形状」/「喷枪」。
// 修：去重，第一个 tool 赢（canonical）。
const _registeredPanels = new Set();
for (const tool of Object.keys(RACK_PANEL_BY_TOOL)) {
  const id = RACK_PANEL_BY_TOOL[tool];
  if (_registeredPanels.has(id)) continue;
  _registeredPanels.add(id);
  registerPanel(id, {
    show: () => _showRackSheet(tool),
    hide: _hideRackSheet,
  });
}
_rackEls.close.addEventListener("click", () => closeExclusive());
function _nextBrushName() {
  // conflict-free 新笔名：找现有「新笔 N」最大 N
  const re = /^新笔\s*(\d+)$/;
  let max = 0;
  for (const b of _brushRack.brushes) {
    const m = re.exec(b.name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `新笔 ${max + 1}`;
}
_rackEls.newBtn.addEventListener("click", () => {
  // v107: 新建 = 复制当前笔（user：「笔架加号应该是复制当前笔，找个接近的就行了」）
  // 优先复制当前 active brush，否则当前 tool/folder 第一个，否则 rack 第一个，最后才硬编码模板
  const activeId = state.toolStates[getRackToolKey(_rackCurrentTool)]?.activeBrushId;
  let source = activeId ? findBrush(_brushRack, activeId) : null;
  if (!source) {
    const inFolder = brushesByTool(_brushRack, _rackCurrentTool)
      .filter(b => (b.folder || DEFAULT_FOLDER) === _rackCurrentFolder);
    source = inFolder[0] || _brushRack.brushes[0] || null;
  }
  let newB;
  if (source) {
    newB = JSON.parse(JSON.stringify(source));         // deep clone
    newB.id = newBrushId();
    newB.name = _nextBrushName();
    newB.folder = _rackCurrentFolder;
    newB.tool = _rackCurrentTool;
  } else {
    // 兜底：rack 整个空时（理论不会到这）
    newB = {
      id: newBrushId(), name: _nextBrushName(),
      tool: _rackCurrentTool, folder: _rackCurrentFolder,
      shape: { kind: "round", aspect: 1, rotation: 0, hardness: 1.0, textureB64: null },
      size: { base: 12, max: 200 },
      sizeCoeff: 0.6, opaCoeff: 0.6, flowCoeff: 0,
      pressureGamma: 1.0, pressureLPF: 0, defaultOpa: 1.0,
      compositeMode: "wash", spacing: 0.06, pixelMode: false,
      taper: { in: 0, out: 0 },
      smudge: _rackCurrentTool === "smudge" ? { strength: 0.8, dryness: 0.1 } : null,
      smooth: { streamline: 0.3, stabilization: 0, pullStabilizer: 0, motionFilter: 0 },
    };
  }
  _brushRack.brushes.push(newB);
  _rackDirty = true;
  closeExclusive();
  _openBrushSettings(newB.id);
});
// 导入：文件选择 (user：「不应该是粘贴，而是文件上传下载」)
_rackEls.importBtn.addEventListener("click", () => {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "application/json,.json";
  inp.style.display = "none";
  inp.addEventListener("change", async () => {
    const file = inp.files?.[0];
    if (!file) return;
    try {
      const txt = await file.text();
      const b = brushFromJSON(txt);
      b.folder = _rackCurrentFolder;
      b.tool = _rackCurrentTool;
      _brushRack.brushes.push(b);
      _rackDirty = true;
      persistBrushRack();
      _renderRackSheet();
      setStatus(`已导入：${b.name}`);
    } catch (e) { setStatus("导入失败：" + (e.message || e), true); }
    document.body.removeChild(inp);
  });
  document.body.appendChild(inp);
  inp.click();
});

// 单 brush 导出（navigator.share 优先，fallback download）
async function exportBrushAsFile(brush) {
  const json = brushToJSON(brush);
  const blob = new Blob([json], { type: "application/json" });
  const filename = `${brush.name || "brush"}-${brush.tool}.json`;
  await _shareOrDownloadJSON(blob, filename, brush.name);
}

async function _shareOrDownloadJSON(blob, filename, title) {
  if (navigator.canShare && navigator.share) {
    const file = new File([blob], filename, { type: "application/json" });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title }); return; }
      catch (_) {/* user cancel / not supported → fallback */}
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

// v107: tile preview 用跟 stamp 一致的 smoothstep falloff (16 stops CSS gradient)
// 真 stamp 是 putImageData 解析公式（连续），CSS gradient 只能 stop 间 linear interp，
// 16 stops 视觉上已经平滑（dα 在 stop 处 jump 小到看不见）
function _smoothstepRadialGradient(hardness, stops = 16) {
  const hd = Math.max(0, Math.min(1, hardness));
  const out = [];
  for (let i = 0; i <= stops; i++) {
    const t = i / stops;
    let alpha;
    if (t <= hd) alpha = 1;
    else {
      const u = (t - hd) / (1 - hd);
      alpha = 1 - u * u * (3 - 2 * u);
    }
    const pct = (t * 100).toFixed(1);
    const apct = (alpha * 100).toFixed(1);
    out.push(`color-mix(in srgb, var(--ink) ${apct}%, transparent) ${pct}%`);
  }
  // v108 BUG FIX：默认 farthest-corner = √2 × 半宽，100% stop 跑框外角 → 视觉框边
  // 只走 ~70.7% 渐变（user 反映「preview 没变」+ 猜「多了个根号 2」），必须 closest-side
  return `radial-gradient(circle closest-side, ${out.join(", ")})`;
}

// v100r2：rack 操作按钮回退 text 标签
// user：「几个 svg 按钮不好理解什么意思。还是改回文字」

// v99：导出当前文件夹下的所有 brush 为一个 JSON pack（{ folder, brushes: [...] }）
async function exportRackFolderAsFile() {
  if (!_brushRack) return;
  const tool = _rackCurrentTool;
  const folder = _rackCurrentFolder;
  const brushes = brushesByTool(_brushRack, tool).filter(b => (b.folder || DEFAULT_FOLDER) === folder);
  if (brushes.length === 0) { setStatus("本文件夹是空的", true); return; }
  const pack = { version: 1, folder, tool, brushes };
  const json = JSON.stringify(pack, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const filename = `${folder || "folder"}-${tool}.json`;
  await _shareOrDownloadJSON(blob, filename, folder);
  setStatus(`已导出文件夹「${folder}」（${brushes.length} 笔）`);
}

// v99r2 dev：把当前 _brushRack 拼成 DEFAULTS_SPEC 代码文件下载（不走剪贴板）
// user：「我 ipad 调好了你写回默认」+「不要走剪切板，就是文件」
async function dumpRackAsCode() {
  if (!_brushRack) return;
  const lines = [];
  lines.push("// Auto-dumped from brush rack. 替换 src/brushes.js DEFAULTS_SPEC array 内容。");
  lines.push("export const DEFAULTS_SPEC = [");
  for (const b of _brushRack.brushes) {
    const args = {};
    args.size = b.size?.base ?? 12;
    args.sizeBaseMax = b.size?.max ?? 200;
    args.hardness = b.shape?.hardness ?? 1.0;
    if (b.shape?.kind && b.shape.kind !== "round") args.shapeKind = b.shape.kind;
    if (b.shape?.aspect != null && b.shape.aspect !== 1) args.aspect = b.shape.aspect;
    if (b.shape?.rotation) args.rotation = b.shape.rotation;
    args.sizeCoeff = b.sizeCoeff ?? 0.6;
    args.opaCoeff  = b.opaCoeff  ?? 0.6;
    args.flowCoeff = b.flowCoeff ?? 0;
    if (b.pressureGamma != null && b.pressureGamma !== 1.0) args.pressureGamma = b.pressureGamma;
    if (b.defaultOpa != null && b.defaultOpa !== 1.0) args.defaultOpa = b.defaultOpa;
    args.compositeMode = b.compositeMode || "wash";
    args.spacingValue = (typeof b.spacing === "number") ? b.spacing : (b.spacing?.value ?? 0.06);
    if (b.pixelMode) args.pixelMode = true;
    if (b.taper?.in)  args.taperIn  = b.taper.in;
    if (b.taper?.out) args.taperOut = b.taper.out;
    if (b.smudge) args.smudge = b.smudge;
    const sm = b.smooth || {};
    if (sm.streamline     != null && sm.streamline     !== 0.3) args.streamline     = sm.streamline;
    if (sm.stabilization  != null && sm.stabilization  !== 0)   args.stabilization  = sm.stabilization;
    if (sm.pullStabilizer != null && sm.pullStabilizer !== 0)   args.pullStabilizer = sm.pullStabilizer;
    if (sm.motionFilter   != null && sm.motionFilter   !== 0)   args.motionFilter   = sm.motionFilter;
    const argsStr = JSON.stringify(args).replace(/"([a-zA-Z_]\w*)":/g, "$1:");
    lines.push(`  { id: ${JSON.stringify(b.id)}, name: ${JSON.stringify(b.name)}, tool: ${JSON.stringify(b.tool)},`);
    lines.push(`    args: ${argsStr} },`);
  }
  lines.push("];");
  const code = lines.join("\n");
  const blob = new Blob([code], { type: "text/javascript" });
  await _shareOrDownloadJSON(blob, "default-brushes.js", "笔架代码");
  setStatus(`已导出 ${_brushRack.brushes.length} 笔的代码文件`);
}

if (_rackEls.exportFolderBtn) _rackEls.exportFolderBtn.addEventListener("click", () => exportRackFolderAsFile());
if (_rackEls.cloudPushBtn) _rackEls.cloudPushBtn.addEventListener("click", async () => {
  if (!isSignedIn()) { setStatus("请先登录云端账号", true); return; }
  setStatus("正在上传笔架…");
  await pushBrushRackIfSignedIn();
});
if (_rackEls.resetBtn) _rackEls.resetBtn.addEventListener("click", async () => {
  const ok = await openConfirmSheet(
    "重置笔架？",
    "会删除全部自定义笔刷 + 改过的默认笔，恢复出厂默认。不可撤销。",
  );
  if (!ok) return;
  _brushRack = makeDefaultRack();
  for (const t of Object.keys(state.toolStates)) {
    state.toolStates[t].activeBrushId = null;
    Object.assign(state.toolStates[t], defaultToolStateFor(t));
  }
  await persistBrushRack();
  applyToolState(state.tool);
  if (RACK_PANEL_BY_TOOL[state.tool] === getCurrentExclusive()) _renderRackSheet();
  _rackDirty = true;
  if (isSignedIn()) pushBrushRackIfSignedIn();
  _rackDirty = false;
  setStatus(`笔架已重置（${_brushRack.brushes.length} 个 brush）`, true);
});
if (_rackEls.dumpCodeBtn) _rackEls.dumpCodeBtn.addEventListener("click", () => dumpRackAsCode());

// ---- brush settings 全屏 view ----
let _editingBrushId = null;
let _editingBrushDraft = null;

function _openBrushSettings(brushId) {
  const b = findBrush(_brushRack, brushId);
  if (!b) return;
  _editingBrushId = brushId;
  _editingBrushDraft = JSON.parse(JSON.stringify(b));    // deep clone
  _renderBrushSettings();
  _settingsEls.view.classList.remove("hidden");
}
function _closeBrushSettings(save) {
  if (save && _editingBrushDraft) {
    const idx = _brushRack.brushes.findIndex((x) => x.id === _editingBrushId);
    if (idx >= 0) {
      _brushRack.brushes[idx] = _editingBrushDraft;
      _rackDirty = true;
      persistBrushRack();
      // v99r2：保存后自动切到该笔（包括 size 回 base、opacity / flow 重置默认）
      // user：「修改保存了一个笔刷之后自动切到那一个（包括回到 default size）」
      const tool = _editingBrushDraft.tool;
      const targetTool = (state.tool === "shapes" || state.tool === "airbrush") ? "brush" : tool;
      // 切到对应 tool（如果用户当前不在）
      // 不主动切 tool，避免打断 user 当下的工具；只切笔
      // 在当前 tool 的 rackKey 跟 brush.tool 兼容时才切
      if (getRackToolKey(state.tool) === getRackToolKey(targetTool)) {
        selectBrushPresetForTool(state.tool, _editingBrushDraft.id);
      } else {
        // 写到目标 tool 的 toolState 但不切 tool
        selectBrushPresetForTool(targetTool, _editingBrushDraft.id);
      }
      setStatus(`已保存：${_editingBrushDraft.name}`);
    }
  }
  _editingBrushId = null;
  _editingBrushDraft = null;
  _settingsEls.view.classList.add("hidden");
}
_settingsEls.save.addEventListener("click", () => _closeBrushSettings(true));
_settingsEls.cancel.addEventListener("click", () => _closeBrushSettings(false));

function _renderBrushSettings() {
  const b = _editingBrushDraft;
  if (!b) return;
  const body = _settingsEls.body;
  body.innerHTML = "";
  // 用模板化 helper 简写各 row
  const section = (title) => {
    const s = document.createElement("div");
    s.className = "brush-settings-section";
    const t = document.createElement("div");
    t.className = "brush-settings-section-title";
    t.textContent = title;
    s.appendChild(t);
    body.appendChild(s);
    return s;
  };
  const rangeRow = (sec, label, min, max, step, val, fmt, onChange) => {
    const row = document.createElement("div");
    row.className = "brush-settings-row";
    row.innerHTML = `<label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${val}"><span class="brush-settings-val">${fmt(val)}</span>`;
    const input = row.querySelector("input");
    const valSpan = row.querySelector(".brush-settings-val");
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      valSpan.textContent = fmt(v);
      onChange(v);
    });
    sec.appendChild(row);
  };
  const textRow = (sec, label, val, onChange) => {
    const row = document.createElement("div");
    row.className = "brush-settings-row brush-settings-row-full";
    row.innerHTML = `<label>${label}</label><input type="text" value="">`;
    const input = row.querySelector("input");
    input.value = val;
    input.addEventListener("input", () => onChange(input.value));
    sec.appendChild(row);
  };
  const selectRow = (sec, label, options, val, onChange) => {
    const row = document.createElement("div");
    row.className = "brush-settings-row brush-settings-row-full";
    const opts = options.map(([v, l]) => `<option value="${v}"${v===val?" selected":""}>${l}</option>`).join("");
    row.innerHTML = `<label>${label}</label><select>${opts}</select>`;
    const sel = row.querySelector("select");
    sel.addEventListener("change", () => onChange(sel.value));
    sec.appendChild(row);
  };

  // 基本
  const basic = section("基本");
  textRow(basic, "名字", b.name, (v) => b.name = v);
  selectRow(basic, "工具", [
    ["brush", "笔刷"], ["smudge", "涂抹"], ["eraser", "橡皮"],
    ["shapes", "形状"], ["airbrush", "喷枪"],
  ], b.tool, (v) => b.tool = v);
  textRow(basic, "文件夹", b.folder, (v) => b.folder = v);

  // Shape
  const shape = section("形状");
  selectRow(shape, "类型", [["round", "圆"], ["ellipse", "椭圆"], ["texture", "纹理"]], b.shape.kind, (v) => {
    b.shape.kind = v; _renderBrushSettings();   // 切类型刷新可见 row
  });
  if (b.shape.kind === "ellipse") {
    rangeRow(shape, "长短轴", 0.1, 1.0, 0.05, b.shape.aspect, (v) => v.toFixed(2), (v) => b.shape.aspect = v);
    rangeRow(shape, "旋转°", 0, 180, 1, b.shape.rotation, (v) => `${v|0}°`, (v) => b.shape.rotation = v);
  }
  rangeRow(shape, "硬度", 0, 1.0, 0.05, b.shape.hardness, (v) => v.toFixed(2), (v) => b.shape.hardness = v);

  // v99 schema 补缺
  if (b.sizeCoeff == null) b.sizeCoeff = 0.6;
  if (b.opaCoeff == null)  b.opaCoeff = 0.6;
  if (b.flowCoeff == null) b.flowCoeff = 0;
  if (b.pressureGamma == null) b.pressureGamma = 1.0;
  if (b.pressureLPF == null) b.pressureLPF = 0;
  if (b.compositeMode == null) b.compositeMode = "wash";
  if (b.defaultOpa == null) b.defaultOpa = 1.0;
  if (!b.smooth) b.smooth = { streamline: 0.3, stabilization: 0, pullStabilizer: 0, motionFilter: 0 };

  // Size：base + max
  const size = section("粗细 (size)");
  rangeRow(size, "基础", 1, b.size.max || 200, 1, b.size.base, (v) => `${v|0} px`, (v) => b.size.base = v);
  rangeRow(size, "最大", 4, 800, 1, b.size.max || 200, (v) => `${v|0} px`, (v) => b.size.max = v);

  // 压感 dynamics（signed coeff −1..1，0=不响应）
  const dyn = section("压感 (−1..1，0 = 不响应、负数 = 反向)");
  rangeRow(dyn, "size",    -1, 1, 0.05, b.sizeCoeff, (v) => v.toFixed(2), (v) => b.sizeCoeff = v);
  rangeRow(dyn, "opacity", -1, 1, 0.05, b.opaCoeff,  (v) => v.toFixed(2), (v) => b.opaCoeff = v);
  rangeRow(dyn, "flow",    -1, 1, 0.05, b.flowCoeff, (v) => v.toFixed(2), (v) => b.flowCoeff = v);

  // 默认值（选笔时拷给 toolState；flow 永远 1.0 不存）
  const def = section("默认值（选笔时拷给 opacity 滑块）");
  rangeRow(def, "默认 opacity", 0, 1.0, 0.05, b.defaultOpa, (v) => `${(v*100)|0}%`, (v) => b.defaultOpa = v);

  // 笔画平滑（v99：从 system 挪进 preset；v104 LPF 也归这里）
  const smooth = section("笔画平滑");
  rangeRow(smooth, "streamline",   0, 1.0, 0.05, b.smooth.streamline,    (v) => v.toFixed(2), (v) => b.smooth.streamline = v);
  rangeRow(smooth, "stabilization",0, 1.0, 0.05, b.smooth.stabilization, (v) => v.toFixed(2), (v) => b.smooth.stabilization = v);
  rangeRow(smooth, "pull-stab",    0, 1.0, 0.05, b.smooth.pullStabilizer,(v) => v.toFixed(2), (v) => b.smooth.pullStabilizer = v);
  rangeRow(smooth, "motion-filter",0, 1.0, 0.05, b.smooth.motionFilter,  (v) => v.toFixed(2), (v) => b.smooth.motionFilter = v);
  rangeRow(smooth, "pressure LPF", 0, 200, 5,  b.pressureLPF,            (v) => `${v|0} ms`,  (v) => b.pressureLPF = v);

  // 高级：composite mode + pressureGamma + pixelMode
  const adv = section("高级");
  selectRow(adv, "重叠模式 compositeMode", [
    ["wash",    "Wash（max；自交不变深，有上限）"],
    ["buildup", "Build-Up（累积；可达 100%，喷枪 feel）"],
  ], b.compositeMode, (v) => b.compositeMode = v);
  rangeRow(adv, "pressureGamma", 0.2, 3.0, 0.05, b.pressureGamma, (v) => v.toFixed(2), (v) => b.pressureGamma = v);

  // Pixel mode toggle
  const pmRow = document.createElement("div");
  pmRow.className = "brush-settings-row brush-settings-row-full";
  const initPM = !!b.pixelMode;
  pmRow.innerHTML = `
    <label>pixelMode<br><span style="font-size:11px;color:var(--ink-soft);">开 = 整数 snap + fillRect 无 AA（像素艺术）</span></label>
    <button type="button" class="brush-rack-action" style="justify-self:end;" aria-pressed="${initPM}">
      ${initPM ? "开" : "关"}
    </button>
  `;
  const pmBtn = pmRow.querySelector("button");
  b.pixelMode = initPM;
  pmBtn.addEventListener("click", () => {
    b.pixelMode = !b.pixelMode;
    pmBtn.setAttribute("aria-pressed", b.pixelMode ? "true" : "false");
    pmBtn.textContent = b.pixelMode ? "开" : "关";
  });
  adv.appendChild(pmRow);

  // Spacing (1%-200%)
  const sp = section("间距 (% 直径)");
  // 转 scalar
  const spVal = (typeof b.spacing === "number") ? b.spacing : (b.spacing?.value ?? 0.06);
  rangeRow(sp, "间距", 1, 200, 1, Math.round(spVal * 100),
    (v) => `${v|0}%`,
    (v) => { b.spacing = v / 100; });
  // v106：flow 乘数撤了 (user：「flow 乘数好像没 work，要不删掉」+「root cause 是 stamp boundary
  // 没 falloff 到 0」)。v106 已改 smoothstep falloff，spacing 10% 也平滑，乘数没必要。

  // Taper：入端 stylistic taper（生效）；出端 v98+ 没接进引擎 → 撤
  const tp = section("收尾");
  rangeRow(tp, "入端", 0, 5, 0.1, b.taper.in, (v) => v.toFixed(1), (v) => b.taper.in = v);

  // Smudge specific
  if (b.tool === "smudge") {
    if (!b.smudge) b.smudge = { strength: 0.8, dryness: 0.1 };
    const sm = section("涂抹");
    rangeRow(sm, "强度", 0, 1.0, 0.05, b.smudge.strength, (v) => v.toFixed(2), (v) => b.smudge.strength = v);
    rangeRow(sm, "干燥度", 0, 1.0, 0.05, b.smudge.dryness, (v) => v.toFixed(2), (v) => b.smudge.dryness = v);
  }

  // 导出此笔（navigator.share / 下载）
  const exp = section("");
  const expBtn = document.createElement("button");
  expBtn.type = "button";
  expBtn.className = "brush-rack-action";
  expBtn.textContent = "导出此笔为 JSON 文件";
  expBtn.addEventListener("click", () => exportBrushAsFile(b));
  exp.appendChild(expBtn);

  // 删除按钮
  const del = section("");
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "brush-rack-action";
  delBtn.textContent = "删除此笔";
  delBtn.style.background = "rgba(220,38,38,0.1)";
  delBtn.style.color = "#dc2626";
  delBtn.style.borderColor = "#dc2626";
  delBtn.addEventListener("click", async () => {
    const ok = await openConfirmSheet("删除这支笔？", `「${b.name}」（不可撤销）`);
    if (!ok) return;
    const idx = _brushRack.brushes.findIndex((x) => x.id === _editingBrushId);
    if (idx >= 0) _brushRack.brushes.splice(idx, 1);
    _rackDirty = true;
    persistBrushRack();
    _editingBrushId = null;
    _editingBrushDraft = null;
    _settingsEls.view.classList.add("hidden");
    setStatus("已删除");
  });
  del.appendChild(delBtn);
}

// canvas pointerdown → 关 exclusive panel（user：「画画时别让 panel 挡着」）
els.board.addEventListener("pointerdown", () => {
  if (getCurrentExclusive()) closeExclusive();
}, { capture: true });   // capture 在 input.js 处理 stroke 之前

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
els.updateReload.addEventListener("click", async () => {
  // 用户决定性动作 → apply 所有 pending（套索浮层等）+ 保一次（reload 会清掉内存）
  applyAllPendingTransients();
  if (_docDirty && !_docSaving) await saveNow();
  // **v60 修**：必须把 skip-waiting 推给 WAITING SW，不是 controller。
  // controller = 当前 active SW（旧版本），收到 skipWaiting 无意义；要的是让 waiting
  // 的新 SW 转 active。然后听 controllerchange 再 reload —— 否则 reload 时旧 SW 还
  // 在控位，又返一份旧 index.html → 用户体感"toast 一直弹但版本没换"。
  const reg = _swRegistration || await navigator.serviceWorker?.getRegistration();
  if (!reg || !reg.waiting) {
    // 没有 waiting SW（可能已 active 但 page 没 reload）→ 直接刷
    location.reload();
    return;
  }
  let reloaded = false;
  const doReload = () => { if (reloaded) return; reloaded = true; location.reload(); };
  navigator.serviceWorker.addEventListener("controllerchange", doReload, { once: true });
  reg.waiting.postMessage({ type: "skip-waiting" });
  // 5s 兜底：controllerchange 不来就硬 reload（不会把状态推得更差）
  setTimeout(doReload, 5000);
});
els.updateDismiss.addEventListener("click", () => {
  updateDismissed = true;
  els.updateToast.classList.add("hidden");
});

let _swRegistration = null;       // 暴露给 menuCheckUpdate 用
// **v58 修**：之前 register 写在 `window.addEventListener("load", ...)` 里。
// 但 app.js 是 dynamic `import()` 异步加载（见 index.html 顶部 module script），
// 等模块跑完时 `load` event 经常已经 fire 过了 → addEventListener 挂的 listener
// 永远不触发 → SW 从来没注册。iPad PWA 离线就崩，"检测更新"也说"未注册"。
// 现在改成模块顶层直接 register（同 ScratchPad），不依赖 load event。
if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname)) {
  // 路径 3：asset-updated 消息
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "asset-updated") showUpdate();
  });

  navigator.serviceWorker.register("./service-worker.js").then((registration) => {
    _swRegistration = registration;
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
    // 路径 4：回前台 / 焦点 → poke
    const pokeUpdate = () => { registration.update().catch(() => {}); };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pokeUpdate();
    });
    window.addEventListener("focus", pokeUpdate);
    setInterval(pokeUpdate, 10 * 60 * 1000);
  }).catch((err) => {
    console.warn("SW register failed", err);
  });
}
