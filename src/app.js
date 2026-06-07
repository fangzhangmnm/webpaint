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

import { WEBPAINT_VERSION } from "./version.js";
import { PaintDoc } from "./doc.js";
import { Board } from "./board.js";
import { InputController, KEYBOARD_SHORTCUTS } from "./input.js";
import { PixelEdit, compressPixelSnap, applyPixelSnap } from "./pixel-edit.js";
import { BrushSettings } from "./brush.js";
import {
  makeDefaultRack, findBrush, defaultBrushForTool, brushesByTool,
  newBrushId, brushToJSON, brushFromJSON, DEFAULT_FOLDER, mergeMissingDefaults, migrateBrush,
  defaultsPromise,
} from "./brushes.js";
import { PANELS, registerPanel, openExclusive, closeExclusive, getCurrentExclusive } from "./panel-state.js";
import { getMeta, setMeta } from "./storage.js";
import { UndoStack } from "./history.js";
import { EditMode } from "./edit-mode.js";
import { ReferenceWindow } from "./reference.js";
import { PaletteWindow } from "./palette.js";
import {
  saveSession, loadCurrentSession, openSession, removeSession, listSessions,
  listTrashedSessions,
  getCurrentSessionName, setCurrentSessionName,
  exportOraDownload, exportPsdDownload, shareOrDownloadImage,
  copyImageToClipboard, readImageFromClipboard, writeImageBlobToClipboard,
} from "./session.js";
import { Selection } from "./selection.js";
import { SMOOTH, SMOOTH_DEFAULTS, saveSmooth, resetSmooth } from "./smooth-config.js";
import { decodeImageFile, fitWithin, canvasToBlob, smartResample, fillResampleSelect } from "./resample.js";
// v132 (user：「所有 color adjustment 做成第一方默认安装的插件」)
//   filters.js 只剩 Filter 契约 + registry + helper；
//   每个调色器在 src/plugins/ 自成一文件，import 时自注册
import { getFilter, listFilters, registerFilter, onFilterRegistered } from "./filters.js";
import "./plugins/index.js";    // 触发 HSB / ColorBalance / Curves / SharpenBlur 自注册
import { decodeOraToDoc, encodeDocToOra, parseAppVersion } from "./ora.js";
import { getItemByPath, deleteItem, ensureSubfolder, clearFolderCaches } from "./app-store.js";
import { getOrFetchCloudThumb, clearCloudThumbCache, stats as cloudThumbStats, config as cloudThumbConfig, resetStats as cloudThumbResetStats } from "./cloud-thumb-cache.js";
import { telemetry as cloudThumbTelemetry, resetTelemetry as cloudThumbResetTelemetry } from "./cloud-thumbs.js";
import {
  isAuthConfigured, initAuth, signIn, signOut, isSignedIn, getActiveAccount, retrySilentSignIn,
  listCloudSessionsRecursive, listCloudAll, listCloudFolders,
  listCloudTrash,
  isCloudDirty, setCloudDirty, CloudConflictError,
  getLastSessionSignedIn, setLastSessionSignedIn, getKnownETag,
  rackFolderFlow, setRackDirty, isRackDirty, resolveRef,
  store as _store,
} from "./app-store.js";   // cut-over：cloud/auth/graph 全走 lib（app-store shim 保旧名）

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
  // v123：del/up/down 挪进 per-row "⋯" 菜单；footer 只剩 layerAddBtn
  menuBtn: document.getElementById("menuButton"),
  menuPanel: document.getElementById("menuPanel"),
  menuLongPressPick: document.getElementById("menuLongPressPick"),
  menuPressureSize: document.getElementById("menuPressureSize"),
  menuPressureOpacity: document.getElementById("menuPressureOpacity"),
  menuTheme: document.getElementById("menuTheme"),
  menuClear: document.getElementById("menuClear"),
  // v120 (user：「导出项目和导出语义分开 + 小扳手」)
  // 旧 5 项 (menuImport / menuExportPng/Jpg/Ora/Psd / menuClipboardCopy/Paste) → 新 3 行
  menuExportProject: document.getElementById("menuExportProject"),
  menuExportProjectConfig: document.getElementById("menuExportProjectConfig"),
  menuExportImage: document.getElementById("menuExportImage"),
  menuExportImageConfig: document.getElementById("menuExportImageConfig"),
  menuImportImage: document.getElementById("menuImportImage"),
  menuImportImageConfig: document.getElementById("menuImportImageConfig"),
  menuFit: document.getElementById("menuFit"),
  menuBrushSettings: document.getElementById("menuBrushSettings"),
  // v109: brushPanel + brush* sliders 撤了（平滑 per-preset，进 brush settings 调）
  topSaveBtn: document.getElementById("topSaveBtn"),
  topAdjustBtn: document.getElementById("topAdjustBtn"),
  adjustPopup: document.getElementById("adjustPopup"),
  // v110 crop / resample / adjust
  resampleBackdrop: document.getElementById("resampleBackdrop"),
  resampleSheet: document.getElementById("resampleSheet"),
  resampleW: document.getElementById("resampleW"),
  resampleH: document.getElementById("resampleH"),
  resampleLock: document.getElementById("resampleLock"),
  resampleMode: document.getElementById("resampleMode"),
  resampleCancel: document.getElementById("resampleCancel"),
  resampleConfirm: document.getElementById("resampleConfirm"),
  adjustPanel: document.getElementById("adjustPanel"),
  adjustPanelHead: document.getElementById("adjustPanelHead"),
  adjustPanelTitle: document.getElementById("adjustPanelTitle"),
  adjustParamsBody: document.getElementById("adjustParamsBody"),
  // v123 topGalleryBtn 撤了，图库挪进菜单 (id=menuGallery)
  menuGallery: document.getElementById("menuGallery"),
  menuReference: document.getElementById("menuReference"),
  menuResetBrushRack: document.getElementById("menuResetBrushRack"),
  menuForcePwaReset: document.getElementById("menuForcePwaReset"),
  menuSmoothDev: document.getElementById("menuSmoothDev"),
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
  galleryTrashBtn: document.getElementById("galleryTrashBtn"),
  galleryTrashBar: document.getElementById("galleryTrashBar"),
  galleryTrashBack: document.getElementById("galleryTrashBack"),
  galleryTrashMenuBtn: document.getElementById("galleryTrashMenuBtn"),
  galleryTrashMenuPopup: document.getElementById("galleryTrashMenuPopup"),
  galleryEmptyTrashBtn: document.getElementById("galleryEmptyTrashBtn"),
  galleryBreadcrumb: document.getElementById("galleryBreadcrumb"),
  addNewFolder: document.getElementById("addNewFolder"),
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
  galleryFootVersion: document.getElementById("galleryFootVersion"),
  galleryMenuBtn: document.getElementById("galleryMenuBtn"),
  galleryMenuPopup: document.getElementById("galleryMenuPopup"),
  galleryMenuVersion: document.getElementById("galleryMenuVersion"),
  galleryMenuForceUpdate: document.getElementById("galleryMenuForceUpdate"),
  galleryMenuTheme: document.getElementById("galleryMenuTheme"),
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
  menuSaveAs: document.getElementById("menuSaveAs"),
  menuRevertToOpen: document.getElementById("menuRevertToOpen"),
  menuCheckerboard: document.getElementById("menuCheckerboard"),
  menuPixelGrid: document.getElementById("menuPixelGrid"),
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

// cut-over 完成：_store 从 app-store import（接 lib）。explicit 保存恒走 store.flow.push（B1/B2/B5/retry/C4）。

// ---- 启动 ----
// 触屏检测（iPad / iPhone / surface touchscreen）→ hand 工具隐藏（双指 pan 已足）
if (navigator.maxTouchPoints > 0) {
  document.body.dataset.inputTouchscreen = "1";
}
const doc = new PaintDoc({ width: 2048, height: 2048 });
const board = new Board(els.board, doc);
els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
els.versionLabel.textContent = WEBPAINT_VERSION || "?";
// gallery 也显版本号（footer 水印 + 菜单信息行）——配合「强制更新」让用户知道自己在哪个版本。
if (els.galleryFootVersion) els.galleryFootVersion.textContent = WEBPAINT_VERSION || "?";
if (els.galleryMenuVersion) els.galleryMenuVersion.textContent = `版本：${WEBPAINT_VERSION || "?"}`;

const state = {
  // tool（当前工具）的 SSoT 已搬到 editMode（editMode.current()）。见 edit-mode.js / CONTEXT.md。
  // v132 filter brush 激活时 = { Filter, params, variantLabel }；空闲 = null
  filterBrush: null,
  color: safeLS("webpaint.color") || "#1b1b1b",
  brush: new BrushSettings({
    size: parseFloat(safeLS("webpaint.size") || "12"),
    opacity: parseFloat(safeLS("webpaint.opacity") || "1"),
    color: safeLS("webpaint.color") || "#1b1b1b",
    // v109：smooth 字段 per-preset，删 LS load。applyBrushPresetFrozen 会覆盖
  }),
  longPressPick: safeLS("webpaint.longPressPick") === "1", // 默认关，user 担心误触
  // v125 (user：「透明背景显示棋盘这个设置跟文件走」)
  //   checkerboard 从全局 LS 改 per-doc：保存在 webpaint/state.json，跟文件走
  //   初始 false；adoptLoadedDoc 时按文件值覆盖；新建 doc 默认 false
  checkerboard: false,
  // 注：液化设置不在这里——液化 v132 migrate 进 filterBrush，mode=variant 下拉、
  // size/strength=左栏 slider；引擎默认 bleed="edge"（见 src/liquify.js / plugins/liquify.js）。
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
    const brush = defaultBrushForTool(_brushRack, tool);
    if (brush) {
      return {
        size: brush.size.base,
        opacity: 1.0,
        flow:    1.0,
        activeBrushId: brush.id,
        activeBrushName: brush.name,
      };
    }
  }
  return { size: 12, opacity: 1.0, flow: 1.0, activeBrushId: null, activeBrushName: null };
}

// 解析某 toolState 的活动笔 = resolveRef（id→name 兜底）。命中后回填 id/name（healing：跨设备/
// 重导入换了 GUID 时靠 name 兜，并把本机 GUID 写回 ts）。见 CONTEXT [[活动笔刷引用]]。
function _findToolBrush(ts) {
  if (!ts || !_brushRack) return null;
  const b = resolveRef(_brushRack.brushes, { id: ts.activeBrushId, name: ts.activeBrushName });
  if (b) { ts.activeBrushId = b.id; ts.activeBrushName = b.name; }
  return b;
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
  // v132 (user：「记得文件持久化 filter brush 的 selection, radius, transparency」)
  //   size = radius，opacity = transparency / flow，variantId = 子算法选择（如 blur/sharp）
  //   variantId 由 Filter.brushVariants[].id 索引；空时 = 该 Filter 默认
  filterBrush: { size: 32, opacity: 1.0, flow: 1.0, activeBrushId: null, variantId: null },
};
// airbrush 工具 alias 到 brush（user：「喷枪笔架合并到笔刷」）。
// v120：shapes tool 撤了（user：「以后不要这个 tool 了」），shapes 会变 brush preset 的 toggle。
// 笔架是一个池子，所有 tool="brush" 的 preset 都在这。spacing.kind="time" 的 preset 就是喷枪。
function getRackToolKey(tool) {
  return tool === "airbrush" ? "brush" : tool;
}

async function loadBrushRack() {
  try {
    let stored = await getMeta(RACK_META_KEY);
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
      // v122 r2: atomic swap，不 mutate
      const newRack = mergeMissingDefaults(stored);
      if (newRack) stored = newRack;
      if (migrated || newRack) {
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
  const tool = editMode.current();
  const rackKey = getRackToolKey(tool);
  const ts = state.toolStates[rackKey];
  const brush = _findToolBrush(ts);
  _sidebarBrushName.textContent = brush ? brush.name : "—";
}
if (_sidebarBrushBtn) {
  // tap 切换 rack；长按 600ms 直接进设置
  let lpTimer = null;
  _sidebarBrushBtn.addEventListener("pointerdown", () => {
    lpTimer = setTimeout(() => {
      lpTimer = null;
      const rackKey = getRackToolKey(editMode.current());
      const ts = state.toolStates[rackKey];
      const b = _findToolBrush(ts);
      if (b) {
        closeExclusive();
        _openBrushSettings(b.id);
      }
    }, 600);
  });
  const cancelLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  _sidebarBrushBtn.addEventListener("pointerup", cancelLP);
  _sidebarBrushBtn.addEventListener("pointerleave", cancelLP);
  _sidebarBrushBtn.addEventListener("pointercancel", cancelLP);
  _sidebarBrushBtn.addEventListener("click", () => {
    const t = editMode.current();
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
  state.brush.taperOut      = brush.taper.out ?? 0;   // v160 末端 taper（之前漏接，引擎拿不到）
  // v98 coeff 模型（−1..1 signed）
  state.brush.sizeCoeff     = brush.sizeCoeff ?? 0.6;
  state.brush.opaCoeff      = brush.opaCoeff ?? 0.6;
  state.brush.flowCoeff     = brush.flowCoeff ?? 0;
  state.brush.pressureGamma = brush.pressureGamma ?? 1.0;
  state.brush.pressureLPF   = brush.pressureLPF ?? 50;      // v102 时间域压感平滑（v161 默认 50ms：100ms 太钝，抬笔不收=末端不渐细）
  state.brush.compositeMode = brush.compositeMode || "wash";
  state.brush.blendMode     = brush.blendMode || "source-over";   // v163 per-brush 混合模式
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
  const brush = _findToolBrush(ts);
  if (brush) applyBrushPresetFrozen(brush);
  state.brush.size    = ts.size;
  state.brush.opacity = ts.opacity ?? 1.0;
  state.brush.flow    = ts.flow    ?? 1.0;
  // size slider：v124e 分段步长，HTML max 跟随当前 brush.size.max 动态算
  if (els.sizeSlider) {
    const sliderMax = brush?.size?.max || 200;
    els.sizeSlider.max = String(_sliderMaxPos(sliderMax));   // 修 (user：「8 就满了」)
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

// v124g (user：「以后所有 size slider 统一这个分段 quantize」)：
// v134 量化更新（user：「20内1, 50内2, 100内5, 200内10, 500内20, 1000内50」）
//   1..20   步长 1   → 20 positions
//   20..50  步长 2   → 15 positions
//   50..100 步长 5   → 10 positions
//   100..200 步长 10 → 10 positions
//   200..500 步长 20 → 15 positions
//   500..1000 步长 50 → 10 positions
function _segPositions(maxPx) {
  const a = Math.max(0, Math.min(20, maxPx));
  const bEnd = Math.min(50, maxPx);   const b = bEnd > 20  ? Math.floor((bEnd - 20)  / 2)  : 0;
  const cEnd = Math.min(100, maxPx);  const c = cEnd > 50  ? Math.floor((cEnd - 50)  / 5)  : 0;
  const dEnd = Math.min(200, maxPx);  const d = dEnd > 100 ? Math.floor((dEnd - 100) / 10) : 0;
  const eEnd = Math.min(500, maxPx);  const e = eEnd > 200 ? Math.floor((eEnd - 200) / 20) : 0;
  const fEnd = Math.min(1000, maxPx); const f = fEnd > 500 ? Math.floor((fEnd - 500) / 50) : 0;
  return { a, b, c, d, e, f, total: a + b + c + d + e + f };
}
function sliderPosToSize(pos, maxPx) {
  const { a, b, c, d, e, total } = _segPositions(maxPx);
  const p = Math.max(0, Math.min(total - 1, Math.round(pos)));
  if (p < a)                 return p + 1;                                  // 1..20 step 1
  if (p < a + b)             return 20  + (p - a + 1) * 2;                  // 22..50 step 2
  if (p < a + b + c)         return 50  + (p - a - b + 1) * 5;              // 55..100 step 5
  if (p < a + b + c + d)     return 100 + (p - a - b - c + 1) * 10;         // 110..200 step 10
  if (p < a + b + c + d + e) return 200 + (p - a - b - c - d + 1) * 20;     // 220..500 step 20
  return                            500 + (p - a - b - c - d - e + 1) * 50; // 550..1000 step 50
}
function sizeToSliderPos(size, maxPx) {
  const { a, b, c, d, e } = _segPositions(maxPx);
  const s = Math.max(1, Math.min(maxPx, Math.round(size)));
  if (s <= 20)  return s - 1;
  if (s <= 50)  return a + Math.round((s - 20) / 2) - 1;
  if (s <= 100) return a + b + Math.round((s - 50) / 5) - 1;
  if (s <= 200) return a + b + c + Math.round((s - 100) / 10) - 1;
  if (s <= 500) return a + b + c + d + Math.round((s - 200) / 20) - 1;
  return            a + b + c + d + e + Math.round((s - 500) / 50) - 1;
}
function _sliderMaxPos(maxPx) { return _segPositions(maxPx).total - 1; }
// v134 量化辅助：圆 v 到段步长（[] 按此 step）
function _stepFor(size) {
  if (size < 20) return 1;
  if (size < 50) return 2;
  if (size < 100) return 5;
  if (size < 200) return 10;
  if (size < 500) return 20;
  return 50;
}
function _quantizeSize(v) {
  v = Math.round(v);
  if (v < 20)  return Math.max(1, v);
  if (v <= 50) return Math.round(v / 2) * 2;
  if (v <= 100) return Math.round(v / 5) * 5;
  if (v <= 200) return Math.round(v / 10) * 10;
  if (v <= 500) return Math.round(v / 20) * 20;
  return Math.round(v / 50) * 50;
}
function updateSidebarSlider2Label() {
  // v98：slider 永远标「透」(opacity 语义)。
  // user：「slider 是 opacity 不是 flow」。flow 在 brush settings 改。
}

// 滑块改值 → 写回当前工具的 toolState（shapes 写到 brush）
function writeCurrentToolSize(v) {
  const ts = state.toolStates[getRackToolKey(editMode.current())];
  if (ts) ts.size = v;
}
function writeCurrentToolOpacity(v) {
  const ts = state.toolStates[getRackToolKey(editMode.current())];
  if (ts) ts.opacity = v;
}
function selectBrushPresetForTool(tool, brushId) {
  const key = getRackToolKey(tool);
  const ts = state.toolStates[key];
  if (!ts) return;
  const brush = findBrush(_brushRack, brushId);
  if (!brush) return;
  ts.activeBrushId = brushId;
  ts.activeBrushName = brush.name;
  ts.size    = brush.size.base;
  // v99r2：opacity 从 preset.defaultOpa 取（默 1.0）；flow 永远 1.0（preset 不存 flow）
  ts.opacity = brush.defaultOpa ?? 1.0;
  ts.flow    = 1.0;
  if (key === getRackToolKey(editMode.current())) applyToolState(editMode.current());
}

// Undo / redo 共享栈（command pattern + 注册 handler，详见
// docs/undo-architecture.md）。input.js 注册 "stroke" handler；layer
// 操作的 5 个 handler 在下方 boot 段集中注册（四条纪律 #1）。
const history = new UndoStack({ max: 50 });
// EditMode：独占编辑状态机，当前编辑模式（工具/transient）的 SSoT（取代旧 state.tool）。见 edit-mode.js / CONTEXT.md。
const editMode = new EditMode({ initialTool: "brush" });
// PixelEdit：纯像素三件套（stroke/liquify/filterBrush/shapes）的 undo 事务 + handler。
// 和 UndoStack 平级，注入 input。见 pixel-edit.js / CONTEXT.md。
const pixelHistory = new PixelEdit({ doc, history, board });

const input = new InputController(board, doc, {
  getTool: () => editMode.current(),
  getBrushSettings: () => state.brush,
  // v132 filter brush: state.filterBrush = { Filter, params, variantLabel } 或 null
  getFilterBrushState: () => state.filterBrush || null,
  getLongPressPickEnabled: () => state.longPressPick,
  onColorSampled: (hex) => setColor(hex),
  status: setStatus,
  history,
  pixelHistory,
  editMode,
});

// v116: transient mode panel suppression
// user：「transient 的时候有些窗口应该暂时 hide... 大部分窗口都是准模态的，而不是一直留在画布上」
// 进 transient (lasso transform / crop / color adjust)：把不相关 float 暂时藏起；
// 退出时复原。brush rack 走 closeExclusive 顺便关；brush settings 全屏 view 不动 (用户主动开的)
let _suppressedDuringTransient = [];
function _suppressTransientPanels(mode) {
  const allow = {
    transform:      ["referencePanel", "layersPanel"],     // transform 时还要看引用图 / 切活动层
    crop:           ["referencePanel"],
    "adjust-color": ["referencePanel", "layersPanel"],
  };
  const allowList = allow[mode] || [];
  const candidates = ["colorPanel", "paletteWindow", "referencePanel", "layersPanel"];
  // 防递归 (transition 间套用)：先复原再藏
  _restoreTransientPanels();
  for (const id of candidates) {
    if (allowList.includes(id)) continue;
    const el = document.getElementById(id);
    if (!el || el.classList.contains("hidden")) continue;
    _suppressedDuringTransient.push({ el, id });
    el.classList.add("hidden");
  }
  // brush rack: closeExclusive 一把关
  try { closeExclusive(); } catch {}
}
function _restoreTransientPanels() {
  for (const { el } of _suppressedDuringTransient) {
    el.classList.remove("hidden");
  }
  _suppressedDuringTransient = [];
}

// v113: panel z-order —— 点击 panel 把它带到同 panel 层内最高 z
// user：「adjust panel 点出来之后在 color panel 下面，导致我以为坏了，能不能点开谁谁到这一层的 top」
let _panelTopZ = 15;     // float-panel 默认 z = 15；递增不限上限
function _bringPanelTop(el) {
  if (!el) return;
  _panelTopZ++;
  el.style.zIndex = _panelTopZ;
}
// 给每个可能弹出来的 float panel 在 pointerdown 时 bringTop
(function bindPanelZOrder() {
  const panels = [
    "colorPanel", "paletteWindow", "referencePanel",
    "adjustPanel",
  ];
  for (const id of panels) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("pointerdown", () => _bringPanelTop(el), true);
  }
})();

// v111: iPad PWA 双击误触 window 拖动 → finger state 抽风修
// user：「有时双击时还是会错误拖动 ipad window 然后 finger state 抽风，按钮都按不了」
// iPad 系统手势抢断 canvas pointer 后偶尔不发 pointercancel 到 canvas，map 里残留 ghost。
// 全局 capture-phase 监听兜底：window 级 cancel / app 隐藏 / 窗口失焦 都 cancelAllPointers
window.addEventListener("pointercancel", () => input.cancelAllPointers(), true);
window.addEventListener("blur", () => input.cancelAllPointers());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") input.cancelAllPointers();
});

// v124 iPad 双击 systematic 4 层防御 layer 2 (capture-phase 拦截系统手势)
// docs/ipad-doubletap-architecture.md。layer 1 (body touch-action) + layer 3 (user-select)
// 都已在 styles.css 里；layer 4 (pointer 自愈) 上面 v111 已加；这里补 layer 2。
function _isTextEditableTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (t.isContentEditable) return true;
  return false;
}
// capture-phase 拦 dblclick（防 iPad 系统级"双击文本选中 / 双击拖窗"劫持）
window.addEventListener("dblclick", (e) => {
  if (_isTextEditableTarget(e.target)) return;
  e.preventDefault();
}, { capture: true, passive: false });
// 3 指及以上 touchstart：拦掉系统 split-view / slide-over 抢手
window.addEventListener("touchstart", (e) => {
  if (e.touches.length >= 3 && !_isTextEditableTarget(e.target)) {
    e.preventDefault();
  }
}, { capture: true, passive: false });
// gesturestart（iOS Safari 多点缩放专属事件）也拦
window.addEventListener("gesturestart", (e) => e.preventDefault(), { capture: true, passive: false });
window.addEventListener("gesturechange", (e) => e.preventDefault(), { capture: true, passive: false });

// 笔触 buffer live overlay：board 每帧问 brush 要，layer 之上 composite × s.opacity
// 预览（实际像素在 endStroke 才烧进 layer）。
board.setOverlayProvider(() => input.brush.getLiveOverlay());
// v131 修 (user：「液化 windows 又有 partial redraw 白框」)
//   filter brush（含 v132 后的液化）没用 overlayProvider 通路，board partial render 抓不到，sliver 漏出
//   strokeActiveHint 兜底：stroke 进行中 = 全屏渲染
board.setStrokeActiveHint(() => input.filterBrush.isActive?.());
board.setLassoProvider(() => ({
  selection:      doc.selection,
  drawingPath:    input.lasso.getDrawingPath(),
  drawingRect:    input.lasso.getDrawingRect(),
  drawingEllipse: input.lasso.getDrawingEllipse(),
  floating:       input.lasso.getFloating(),
  handles:        input.lasso.visibleHandles(board.viewport.scale),
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
  const lassoActive = editMode.current() === "lasso";
  const showAny = floating || hasSelection || lassoActive;
  lassoToolbarStack.classList.toggle("hidden", !showAny);
  if (!showAny) return;

  // 其他工具模式下有选区：选区只是个蒙板，工具栏只给一个"取消选区"（否则去选还得切回 lasso）。
  const otherToolSel = hasSelection && !floating && !lassoActive;
  // Row 1：lasso 模式给全套；其他工具+有选区只露 deselect（加 class，CSS 藏其余）。floating 时都不给。
  const showRow1 = (lassoActive && !floating) || otherToolSel;
  lassoToolbarRow1.classList.toggle("hidden", !showRow1);
  lassoSubToolBar.classList.toggle("hidden", !showRow1);
  lassoSubToolBar.classList.toggle("lasso-deselect-only", otherToolSel);

  // Row 2：selectionActions（变换/填色/清除/复制/移层）只在 lasso 模式给；其他工具模式不给。floating 显 transformCtrl。
  const showSelectionActions = hasSelection && !floating && lassoActive;
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
    const sel = document.getElementById("lassoSampleSel");
    if (sel && sel.value !== sm) sel.value = sm;
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
const lassoExpandInput = document.getElementById("lassoExpand");
const lassoExpandVal = document.getElementById("lassoExpandVal");
if (lassoExpandInput) {
  lassoExpandInput.value = String(input.lasso.getMagicExpand());
  lassoExpandVal.textContent = String(input.lasso.getMagicExpand());
  lassoExpandInput.addEventListener("input", () => {
    const v = parseInt(lassoExpandInput.value, 10) || 0;
    input.lasso.setMagicExpand(v);
    lassoExpandVal.textContent = String(v);
  });
}
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
  if (ok) {
    editMode.enterTransient("transform", { apply: _commitTransform, abort: _cancelTransform });
    updateLassoToolbar();
    _suppressTransientPanels("transform");
  }
});
// ===== v156 剪贴板 / 复制为浮层 快捷键 =====
// 入口在 input.js KEYBOARD_SHORTCUTS（hub）；run 派发 window 事件，逻辑在这（要 doc/import/setColor）。
// Ctrl+T 直接复用 lassoTransformBtn.click()，不在此。Ctrl+C/V 仅走系统剪贴板，无内部 buffer / token。
function _extractSelectionRegionCanvas(layer, sel) {
  const lbX = layer.bboxX, lbY = layer.bboxY, lbW = layer.bboxW, lbH = layer.bboxH;
  const x0 = Math.max(lbX, sel.bboxX), y0 = Math.max(lbY, sel.bboxY);
  const x1 = Math.min(lbX + lbW, sel.bboxX + sel.bboxW), y1 = Math.min(lbY + lbH, sel.bboxY + sel.bboxH);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const cx = c.getContext("2d");
  cx.drawImage(layer.canvas, x0 - lbX, y0 - lbY, w, h, 0, 0, w, h);
  cx.globalCompositeOperation = "destination-in";   // 裁到选区形状
  cx.drawImage(sel.maskCanvas, sel.bboxX - x0, sel.bboxY - y0);
  cx.globalCompositeOperation = "source-over";
  return c;
}
// Ctrl+C：当前层 ∩ 选区（无选区 → 整层）→ 系统剪贴板 PNG
window.addEventListener("wp:copy", async () => {
  const layer = doc.activeLayer;
  if (!layer) { setStatus("没有活动图层", true); return; }
  let canvas;
  if (doc.selection) {
    canvas = _extractSelectionRegionCanvas(layer, doc.selection);
    if (!canvas) { setStatus("选区在图层外，无内容可复制", true); return; }
  } else {
    if (layer.bboxW <= 0 || layer.bboxH <= 0) { setStatus("当前图层为空", true); return; }
    canvas = document.createElement("canvas");
    canvas.width = layer.bboxW; canvas.height = layer.bboxH;
    canvas.getContext("2d").drawImage(layer.canvas, 0, 0);
  }
  try {
    // lazy promise：blob 生成放进 ClipboardItem，保 Safari user-gesture
    await writeImageBlobToClipboard(new Promise((res) => canvas.toBlob(res, "image/png")));
    setStatus(doc.selection ? "已复制选区到剪贴板" : "已复制当前图层到剪贴板");
  } catch (e) {
    setStatus(`复制失败：${e.message || e}`, true);
  }
});
// Ctrl+V：系统剪贴板图 → 新层，视口居中（复用 importImageAsLayer）
window.addEventListener("wp:paste", async () => {
  let blob;
  try { blob = await readImageFromClipboard(); }
  catch (e) { setStatus(`读取剪贴板失败：${e.message || e}`, true); return; }
  if (!blob) { setStatus("剪贴板里没有图片", true); return; }
  const file = new File([blob], "paste.png", { type: blob.type || "image/png" });
  const r = board.canvas.getBoundingClientRect();
  const center = board.screenToDoc(r.left + r.width / 2, r.top + r.height / 2);
  await importImageAsLayer(file, { center });
});
// Ctrl+D：当前选区 → 原位浮层（不挖洞）= 非破坏性 lift + transform
window.addEventListener("wp:duplicateFloat", () => {
  if (input.lasso.hasFloating()) return;
  if (!doc.selection) { setStatus("先框选再 Ctrl+D 复制为浮层", true); return; }
  const ok = input.lasso.liftSelectionForTransform(doc.activeLayer, { cut: false });
  if (ok) {
    editMode.enterTransient("transform", { apply: _commitTransform, abort: _cancelTransform });
    updateLassoToolbar();
    _suppressTransientPanels("transform");
    board.invalidateAll();
    setStatus("已复制选区为浮层（拖动定位 → 应用 / 取消）");
  }
});

// v156 桌面拖拽图片到画布 → 导入为新层（落点 = 拖放位置）。external image = new layer 语义。
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault();   // 允许 drop
});
window.addEventListener("drop", async (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  const img = files.find((f) => f.type && f.type.startsWith("image/"));
  if (!img) return;                                  // 非图片（如 .ora）不拦，让默认行为
  e.preventDefault();
  if (document.body.dataset.mode === "gallery") { setStatus("退出图库后再拖入图片", true); return; }
  const center = board.screenToDoc(e.clientX, e.clientY);
  try { await importImageAsLayer(img, { center }); }
  catch (err) { setStatus(`拖入失败：${err.message || err}`, true); }
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
  doc.selection.fillOnLayer(layer, state.color);
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
  doc.selection.clearOnLayer(layer);
  const after = layer.snapshot();
  const entry = { type: "stroke", layerId: layer.id, before, after, beforeBlob: null, afterBlob: null };
  history.push(entry);
  compressPixelSnap(entry.before, (blob) => { entry.beforeBlob = blob; });
  compressPixelSnap(entry.after,  (blob) => { entry.afterBlob  = blob; });
  board.invalidateAll();
  setStatus("已清除选区内像素");
});
// v112: 全选（user：「lasso 加全选」）
document.getElementById("lassoSelectAllBtn").addEventListener("click", () => {
  const sel = Selection.full(doc.width, doc.height);
  const entry = input.lasso.setSelection(sel);
  if (entry && history) history.push(entry);
  board.invalidateAll();
  updateLassoToolbar();
});

// 反选：在 docW×docH 上 mask 取反
document.getElementById("lassoInvertBtn").addEventListener("click", () => {
  const inv = doc.selection ? doc.selection.invert(doc.width, doc.height) : Selection.full(doc.width, doc.height);
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
// commit/cancel 按钮 = 薄壳，走 EditMode → 运行 transform transient 的 apply/abort 闭包（_commit/_cancelTransform）
document.getElementById("lassoCommitBtn").addEventListener("click", () => {
  editMode.applyPendingTransient();
});
document.getElementById("lassoCancelBtn").addEventListener("click", () => {
  editMode.abortTransient();
});
// Stamp：写入图层但保留 float（连击多次叠加盖印）
document.getElementById("lassoStampBtn").addEventListener("click", () => {
  if (!input.lasso.hasFloating()) return;
  if (input.lasso.stamp()) {
    board.invalidateAll();
    setStatus("已盖印");
  }
});
// v120: 插值模式 dropdown（旧 3 个按钮 → 1 个 select）
const lassoSampleSel = document.getElementById("lassoSampleSel");
// 变换采样 + 调整尺寸 两个 dropdown 都从 resample.js 的 RESAMPLE_MODES SSoT 填（以后加方法/AI 一处生效）
fillResampleSelect(lassoSampleSel, "warp", "bicubic");
fillResampleSelect(els.resampleMode, "scale", "bicubic");
if (lassoSampleSel) {
  lassoSampleSel.addEventListener("change", () => {
    input.lasso.setSampleMode(lassoSampleSel.value);
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
// #6 stage 2：transient（未提交的瞬时编辑态：套索浮层 / 调色预览 / crop 框）由 EditMode 全量接管。
// 旧的 registerPendingTransient/applyAllPendingTransients 注册表已废——改为在各 transient 的入口
// editMode.enterTransient(name, { apply, abort })，决定性动作调 editMode.applyPendingTransient()。
// 三个 transient 的 apply/abort 闭包：
//   transform(lasso 浮层)：apply=commit 浮层，abort=取消浮层（见下两个命名函数）
//   adjust(调色)：apply/abort = _closeFilterPanel(true/false)（在 _openFilterPanel 处注册）
//   crop：apply/abort = _closeCropMode（丢弃裁切框；真裁只走 Apply 按钮，在 _openCropMode 处注册）
// transient 期间结构上 canDraw=false（不可能起 stroke）；面板 suppress/restore 暂仍手动（stage 5 改派生）。

// transform 浮层的 commit / cancel（lasso commit/cancel 按钮 + 决定性动作都走这两个）
function _commitTransform() {
  input.commitLassoIfFloating();
  updateLassoToolbar();
  _restoreTransientPanels();
}
function _cancelTransform() {
  if (input.lasso.hasFloating()) {
    input.lasso.cancel();
    board.invalidateAll();
    updateLassoToolbar();
  }
  _restoreTransientPanels();
}

// ---- 工具 ----
function setTool(t) {
  // v96：airbrush 工具不存在了。老 doc 持久化里可能存了 "airbrush" → 透明回退到 brush
  if (t === "airbrush") t = "brush";
  // v120：shapes 撤了。老 doc 持久化里可能存了 "shapes" → 透明回退 brush
  if (t === "shapes") t = "brush";
  // v110：smudge engine 未真实装（user：「smudge 和 shapes 灰色先不响应」）
  if (t === "smudge") {
    setStatus("涂抹 工具暂未启用");
    return;
  }
  // 切工具 = 决定性动作 → editMode.setTool 内部按 onToolSwitch 把停驻 transient apply/cancel（不在这单独调）
  // v132: 切到非 filterBrush 工具时自动退出 filter brush 模式（藏 toolbar / 清 state）
  if (state.filterBrush && t !== "filterBrush") {
    state.filterBrush = null;
    const tb = document.getElementById("filterBrushToolbar");
    if (tb) tb.classList.add("hidden");
  }
  editMode.setTool(t);   // emit wp:modechange → _syncEditModeUI 派生按钮高亮 / lasso 工具栏
  document.body.dataset.tool = t;   // 持久工具的 CSS hook（transient 期间保持不变）
  // 切工具 → 应用该工具的 per-tool state（size/flow/activeBrushId）+ preset 冻结字段
  if (t === "brush" || t === "smudge" || t === "eraser" || t === "filterBrush") {
    applyToolState(t);
  }
  if (t === "smudge") {
    setStatus("smudge engine 待实装；现在按 brush 走");
  }
}

// #6 stage 4：UI 从 EditMode 派生（监听 wp:modechange）。setTool / enterTransient / exit 都会触发。
// transient 期间（current()=transform/crop/adjust）**不高亮任何工具按钮** —— 这正是当初想实现、
// 逼出"双轴不行"的那个 payoff（双轴的 tool() 仍指向底层工具会误亮）。
function _syncEditModeUI() {
  const m = editMode.current();
  const transient = editMode.isTransient();
  // 工具按钮高亮：transient 时一个都不亮；持久工具高亮对应按钮
  for (const b of els.toolBtns) b.setAttribute("aria-pressed", (!transient && b.dataset.tool === m) ? "true" : "false");
  // 液化 / filterBrush 没独立 data-tool 按钮，用 adjust 按钮高亮（transient 期间也不亮）
  els.topAdjustBtn?.setAttribute("aria-pressed", (m === "liquify" || m === "filterBrush") ? "true" : "false");
  // 注：body.dataset.tool 保持"持久工具"（在 setTool 里设），不在这改成 transient 名——避免扰乱
  // 依赖 body[data-tool] 的 CSS（且 data-mode 被图库占用）。transient 的 UI 抑制走面板 suppress + 按钮高亮。
  // slider 禁用：size/opacity 仅 canDraw 模式可调；color 仅 allowsColor 上下文（笔刷/选区）可点。
  if (els.sizeSlider) els.sizeSlider.disabled = !editMode.canDraw();
  if (els.opacitySlider) els.opacitySlider.disabled = !editMode.canDraw();
  if (els.activeSwatch) els.activeSwatch.disabled = !editMode.allowsColor();
  updateLassoToolbar();             // 选区/变换工具栏跟着重新派生
}
window.addEventListener("wp:modechange", _syncEditModeUI);
_syncEditModeUI();   // 初始同步（boot setTool 同工具会 early-return 不 emit，这里兜一次）

// Rack 工具 → 对应的 exclusive panel id
const RACK_PANEL_BY_TOOL = {
  brush: PANELS.RACK_BRUSH,
  smudge: PANELS.RACK_SMUDGE,
  eraser: PANELS.RACK_ERASER,
  filterBrush: PANELS.RACK_FILTER_BRUSH,    // v132
};
let _lastNonLassoTool = "brush";
for (const b of els.toolBtns) {
  b.addEventListener("click", () => {
    const t = b.dataset.tool;
    // tap-active-again：已激活的 rack 工具再点 → 开/关该工具的笔架 sheet
    // 详 conversation v79→v80：「tap = 切换 / 已激活 tap = 开 rack」
    if (editMode.current() === t && RACK_PANEL_BY_TOOL[t]) {
      openExclusive(RACK_PANEL_BY_TOOL[t]);
      return;
    }
    // v124 (user) 第二次按 lasso = Esc 语义：清选区 + 回上一个非 lasso 工具
    if (editMode.current() === "lasso" && t === "lasso") {
      if (doc.selection) {
        const entry = input.lasso.setSelection(null);
        if (entry) history.push(entry);
        board.invalidateAll();
      }
      setTool(_lastNonLassoTool || "brush");
      closeExclusive();
      return;
    }
    if (editMode.current() !== "lasso") _lastNonLassoTool = editMode.current();
    setTool(t);
    // 切到新 tool 时关掉之前开的 rack（防止 stale）
    closeExclusive();
  });
}
window.addEventListener("wp:settool", (e) => setTool(e.detail));

// v120 删：Shapes 子工具栏。shapes tool 撤了 → 以后 shapes 改 brush preset 的 toggle 字段
// pencil 模式下双击 → 笔↔橡皮。但 floating 选区存在时屏蔽（避免误触切工具 = 自动 apply 变换）
window.addEventListener("wp:doubletap", () => {
  if (input.lasso.hasFloating()) {
    setStatus("套索浮层进行中，双击切换暂停（点应用 / 取消 / 返回工具栏）");
    return;
  }
  const next = editMode.current() === "eraser" ? "brush" : "eraser";
  setTool(next);
  setStatus(`双击 · ${next === "eraser" ? "橡皮" : "笔刷"}`);
});
setTool(editMode.current());

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
  applyToolState(editMode.current());
  updateSidebarBrushIndicator();
  setTimeout(() => { checkBrushRackCloud().catch(() => {}); _refreshRackCloudState(); }, 2000);
  // v122 r2: default-brushes.json 是 async fetch；先用现有 rack boot（可能是 IDB / emergency
  // 兜底空），fetch 回来后再 retroactively merge 缺失的 default brushes，写 IDB + 刷 UI
  defaultsPromise().then(() => {
    if (!_brushRack) return;
    const newRack = mergeMissingDefaults(_brushRack);
    if (!newRack) return;
    _brushRack = newRack;           // atomic swap
    persistBrushRack().catch(() => {});
    for (const t of Object.keys(state.toolStates)) {
      if (state.toolStates[t].activeBrushId == null) {
        const init = defaultToolStateFor(t);
        Object.assign(state.toolStates[t], init);
      }
    }
    applyToolState(editMode.current());
    updateSidebarBrushIndicator();
  });
}).catch((e) => {
  // **关键**：IDB 在 iPad Safari 私密浏览模式下会 throw。loadBrushRack 内部已有
  // try/catch fallback；这条 catch 接住极端情况（boot 期 promise 链外 throw）。
  // 至少给个 in-memory rack 让 user 能画
  console.warn("[brush-rack] init failed:", e);
  _brushRack = makeDefaultRack();
  applyToolState(editMode.current());
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

// v104 size 滑块 popup；v109 zoom-aware；v123 (user) 改：
//   - size + opacity 同 popup 复用，任一 slider 拖动都刷
//   - 圆的半径 = size × zoom，**透明度 = opacity**（视觉看到两个变化）
//   - 文字"N px · M%"，去掉"屏 px"备注
//   - 竖排（圆上字下），frame 缩到 64px
// 圆按真实屏 px 画；超 frame 时 frame overflow:hidden 裁
// v124 吸色 pin：input.js _doPick 派发 wp:pickerShow，tip 在采样 pixel 屏坐标
// pin 上浮 (transform translateY(-100%)) 避免被手指挡。1500ms 后自动淡出
let _pickerPinTimer = null;
const _pickerPin = document.getElementById("pickerPin");
const _pickerPinHead = document.getElementById("pickerPinHead");
window.addEventListener("wp:pickerShow", (e) => {
  if (!_pickerPin) return;
  const { sx, sy, hex } = e.detail;
  _pickerPin.style.left = sx + "px";
  _pickerPin.style.top = sy + "px";
  _pickerPin.style.setProperty("--head-color", hex);
  _pickerPin.classList.remove("hidden");
  clearTimeout(_pickerPinTimer);
  _pickerPinTimer = setTimeout(() => _pickerPin.classList.add("hidden"), 1500);
});
window.addEventListener("wp:pickerHide", () => {
  if (!_pickerPin) return;
  _pickerPin.classList.add("hidden");
  clearTimeout(_pickerPinTimer);
});

let _sizePopupTimer = null;
const POPUP_FRAME = 64;
// v134 (user：「popup 位置动态跟 slider，两个 slider 都算」)
//   anchor 元素由 caller 传：size slider 用 sizeSlider，opacity slider 用 opacitySlider
//   水平 anchor 到 sidebar.right（slider 太瘦不稳）；垂直跟传进的 slider 中心
function showSizePopup(anchorEl) {
  if (!els.sizePopup) return;
  const px = state.brush.size;
  const op = state.brush.opacity;
  const zoom = board?.viewport?.scale ?? 1;
  const screenPx = px * zoom;
  const r = Math.max(2, screenPx / 2);
  els.sizePopupCircle.style.width   = (r * 2) + "px";
  els.sizePopupCircle.style.height  = (r * 2) + "px";
  els.sizePopupCircle.style.opacity = String(op);
  els.sizePopupText.textContent = `${px|0} px · ${Math.round(op * 100)}%`;
  const a = anchorEl || els.sizeSlider;
  const aRect = a.getBoundingClientRect();
  const sidebar = document.getElementById("leftSidebar");
  const anchorRight = sidebar ? sidebar.getBoundingClientRect().right : aRect.right;
  els.sizePopup.style.left = (anchorRight + 12) + "px";
  els.sizePopup.style.top  = (aRect.top + aRect.height / 2 - POPUP_FRAME / 2) + "px";
  els.sizePopup.classList.remove("hidden");
  clearTimeout(_sizePopupTimer);
  _sizePopupTimer = setTimeout(() => els.sizePopup.classList.add("hidden"), 1500);
}

// v97：setSize 接受 px；slider 转 log；setIntensity 路由 flow/opacity
// v123 加 silent option：boot 时设默认值不弹 popup（user：「新页面 brush preview 没默认隐藏」）
function setSize(v, opts = {}) {
  v = Math.max(1, Math.round(v));        // v104: clamp to int
  state.brush.size = v;
  writeCurrentToolSize(v);
  safeLSSet("webpaint.size", String(v));
  // 同步 slider（log 化）
  const maxPx = parseInt(els.sizeSlider.dataset.maxPx, 10) || 200;
  els.sizeSlider.value = String(sizeToSliderPos(v, maxPx));
  if (!opts.silent) showSizePopup(els.sizeSlider);
}
function setOpacity(v, opts = {}) {
  state.brush.opacity = v;
  writeCurrentToolOpacity(v);
  safeLSSet("webpaint.opacity", String(v));
  els.opacitySlider.value = String(Math.round(v * 100));
  if (!opts.silent) showSizePopup(els.opacitySlider);   // v123 共用 size+opacity popup
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
  showSizePopup(els.sizeSlider);
});
els.opacitySlider.addEventListener("input", () => setOpacity(parseFloat(els.opacitySlider.value) / 100));
// boot 初值 (v124e applyToolState 会被笔架 load 后再调一次刷新；这里先给一个合理默认 maxPx 防 NaN)
els.sizeSlider.dataset.maxPx = "200";
els.sizeSlider.max = String(_sliderMaxPos(200));
setSize(state.brush.size, { silent: true });        // boot 不弹 popup
setOpacity(state.brush.opacity, { silent: true });
// 键盘 [ ] 调粗（v132: tool-aware dispatch）
//   - 液化（legacy 路径已废，editMode.current() 不会 "liquify"，留 fallback）
//   - 笔刷 / 橡皮 / 涂抹 / filter brush → state.brush.size，max 用 sizeSlider.dataset.maxPx
//   - 其他模式（lasso / picker / hand）→ no-op
window.addEventListener("wp:adjsize", (e) => {
  const delta = e.detail;
  const t = editMode.current();
  if (t === "brush" || t === "eraser" || t === "smudge" || t === "filterBrush") {
    const maxPx = parseInt(els.sizeSlider?.dataset.maxPx || "200", 10);
    // v134 [] step 按段量化：20内1, 50内2, 100内5, 200内10, 500内20, 1000内50
    const dir = Math.sign(delta) || 1;
    const step = _stepFor(state.brush.size);
    const raw = state.brush.size + dir * step;
    const next = Math.max(1, Math.min(maxPx, _quantizeSize(raw)));
    setSize(next);
    if (board._cursor) {
      board.setCursor({ ...board._cursor, size: next });
    }
  }
  // 其他工具忽略（液化已 migrate 进 filterBrush）
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
  // v125: checkerboard per-doc，不再写 localStorage
  state.checkerboard = !!on;
  setMenuItem(els.menuCheckerboard, on);
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
  // v125 per-doc：触发 dirty 让 autosave 把新值写进 webpaint/state.json
  _store.edits.mark(); updateSaveStatus();
  setStatus(`透明棋盘 · ${state.checkerboard ? "开" : "关"}`);
});
// v163 像素栅格：全局开关（视图辅助，跟设备不跟文件），localStorage 持久化，默认开
function applyPixelGrid(on) {
  board.setPixelGridEnabled?.(!!on);
  setMenuItem(els.menuPixelGrid, !!on);
  safeLSSet("webpaint.pixelGrid", on ? "1" : "0");
}
applyPixelGrid(safeLS("webpaint.pixelGrid") !== "0");   // boot：缺省=开
if (els.menuPixelGrid) els.menuPixelGrid.addEventListener("click", () => {
  const next = !board.getPixelGridEnabled();
  applyPixelGrid(next);
  setStatus(`像素栅格 · ${next ? "开" : "关"}`);
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
// v124b: menuClear 撤了（user：「清空内容跟删除重复，删掉」）。stub 留兜底
if (els.menuClear) els.menuClear.addEventListener("click", () => setMenuOpen(false));

// v124 快捷键 sheet：从 KEYBOARD_SHORTCUTS 自动渲染（input.js 注册的唯一真理源）
const _shortcutsSheet = document.getElementById("shortcutsSheet");
const _shortcutsBackdrop = document.getElementById("shortcutsBackdrop");
const _shortcutsBody = document.getElementById("shortcutsBody");
function _renderShortcutsSheet() {
  if (!_shortcutsBody) return;
  const byCat = new Map();
  for (const sc of KEYBOARD_SHORTCUTS) {
    const cat = sc.category || "其它";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(sc);
  }
  // 同 combo 多 entry（如 Escape 在 floating / hasSelection 两条）合并展示
  let html = "";
  for (const [cat, list] of byCat) {
    html += `<div class="shortcuts-category">${cat}</div>`;
    for (const sc of list) {
      html += `<div class="shortcuts-row"><span>${sc.desc}</span><span class="shortcuts-combo">${sc.combo}</span></div>`;
    }
  }
  _shortcutsBody.innerHTML = html;
}
document.getElementById("menuShortcuts")?.addEventListener("click", () => {
  setMenuOpen(false);
  _renderShortcutsSheet();
  openSheet(_shortcutsSheet, _shortcutsBackdrop);
});
document.getElementById("shortcutsClose")?.addEventListener("click", () => closeSheet(_shortcutsSheet, _shortcutsBackdrop));
_shortcutsBackdrop?.addEventListener("click", () => closeSheet(_shortcutsSheet, _shortcutsBackdrop));

applyPressureSize(state.brush.pressureToSize);
applyPressureOpacity(state.brush.pressureToOpacity);
applyLongPressPick(state.longPressPick);
applyCheckerboard(state.checkerboard);

function setMenuOpen(open) {
  els.menuPanel.classList.toggle("hidden", !open);
  els.menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    // v124 menu panel 跟随菜单按钮屏坐标（top-bar 居中 transform，
    // 用 viewport 写死的 left: 12px 在宽屏上对不齐图标）
    const r = els.menuBtn.getBoundingClientRect();
    els.menuPanel.style.top = (r.bottom + 6) + "px";
    els.menuPanel.style.left = r.left + "px";
    els.menuPanel.style.right = "auto";
    _updateMenuCropLabel?.();
  }
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
els.undoBtn.addEventListener("click", () => input.ctrlZ());
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
// v156 窗格快捷键（C/N/R）逻辑：入口在 input.js KEYBOARD_SHORTCUTS hub，run 派发这些事件。
//   （取代了原来散落在这里的裸 "c" keydown —— 收进 hub，见 docs/backlog.md）
window.addEventListener("wp:toggleColor", () => toggleColorPanel());
window.addEventListener("wp:toggleLayers", () => toggleLayersPanel());
window.addEventListener("wp:toggleReference", () => referenceWindow.toggle());

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
    // v123 眼睛 icon 放大 16→22 (user)
    vis.innerHTML = L.visible
      ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a18.94 18.94 0 0 1 4.06-5.06"/><path d="M1 1l22 22"/></svg>';
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

    // 名字：单击 row = setActive（行 click handler 处理）。
    // v125 (user：「点图层名可以 rename」) active 时再点 name = rename，"⋯" 菜单仍保留入口
    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = L.name;
    name.addEventListener("click", (e) => {
      if (L.id === doc.activeLayer?.id) {
        e.stopPropagation();
        startLayerRename(L, name);
      }
      // else 让 row.click 设 active
    });
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
      // v154 (user)：点别的层 → 收起非选中层的展开折叠区（badge dropdown）；点自己展开着的保留
      if (_expandedLayerId !== L.id) _expandedLayerId = null;
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
  // 滚动到当前活动层（undo/redo 切了 activeIndex 时让面板跳过去，用户看得见变化）
  els.layersList.querySelector(".layer-row.active")?.scrollIntoView({ block: "nearest" });
  // v123 footer 只剩 add（del / up / down 进 per-row "⋯" 菜单）
  els.layerAddBtn.disabled = doc.layers.length >= max;
  // v132 global 删除按钮 disable + 灰（user：「删除图层不可用时应该灰色」）
  const delBtn = document.getElementById("layerDeleteBtn");
  if (delBtn) delBtn.disabled = doc.layers.length <= 1;
}

// 各层操作都走 history.push → handler 同时 apply 和 push。这样未来 undo / redo
// 都自动可以反向 apply。helper：apply 即时效果 + 渲染。
function _afterDocChange() {
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
}

// v123 把 layer op 抽成 named 函数：原 4 个 footer 按钮挪进 menu/popup
function _addEmptyLayer() {
  if (doc.layers.length >= doc.maxLayers) {
    setStatus(`图层数已达上限 ${doc.maxLayers}`);
    return;
  }
  const prevActiveId = doc.activeLayer?.id ?? null;   // 持久化：undo 创建时回到创建前的活动层
  const L = doc.addLayer();
  if (!L) return;
  const insertIndex = doc.layers.findIndex((l) => l.id === L.id);
  const layerSpec = layerSpecFrom(L);
  history.push({ type: "addLayer", index: insertIndex, layerSpec, prevActiveId });
  _afterDocChange();
}
function _openImagePicker() {
  // v125 修 (user：「图层面板的导入图片不成功」)
  //   图库"导入照片"会 set _addImportAsNewDoc=true，如果用户取消 file picker
  //   flag 不会清。下次从图层面板导入会被路由到 importImageAsNewDoc（替换 doc），
  //   user 觉得"不成功"。这里强制 false 让图层面板入口走 importImageAsLayer
  _addImportAsNewDoc = false;
  els.oraFileInput.value = "";
  els.oraFileInput.click();
}
function _deleteLayer(L) {
  if (!L) return;
  if (doc.layers.length <= 1) { setStatus("至少保留一层"); return; }
  const index = doc.layers.findIndex((l) => l.id === L.id);
  const layerSpec = layerSpecFrom(L);
  doc.removeLayer(L.id);
  history.push({ type: "removeLayer", index, layerSpec });
  compressPixelSnap(layerSpec, (blob) => { layerSpec.blob = blob; });
  _afterDocChange();
}
// v132 (user：「··· 菜单加 clear layer」)
//   清空当前图层像素：保留图层 + 名字 + opacity / mode，bbox 归零
function _clearLayerPixels(L) {
  if (!L) return;
  if (L.bboxW <= 0 || L.bboxH <= 0) { setStatus("图层已经是空的"); return; }
  const before = L.snapshot();
  // restoreFromSnapshot 用空 spec 把 layer 像素清掉，bbox 归零
  L.restoreFromSnapshot({ bboxX: 0, bboxY: 0, bboxW: 0, bboxH: 0, imageData: null, bitmap: null });
  const after = L.snapshot();
  history.push({ type: "stroke", layerId: L.id, before, after, beforeBlob: null, afterBlob: null });
  compressPixelSnap(before, (blob) => { before.blob = blob; });
  compressPixelSnap(after,  (blob) => { after.blob  = blob; });
  _afterDocChange();
  board.invalidateAll();
  setStatus(`已清空：${L.name}`);
}
// v124b 向下合并 (user 急需，mode-aware)：
// 用 active 的 mode + opacity 把 active 合到下方层；删 active。
// **不**改 active 的 mode (因为它要消失了)；下方层保留它原本 mode + opacity。
// 视觉等价：合并前后画面相同。clippingMask layer 不支持（先返回不做）。
function _mergeDownLayer(L) {
  if (!L) return;
  const idx = doc.layers.findIndex((l) => l.id === L.id);
  if (idx <= 0) { setStatus("已经是最底层，没法向下合"); return; }
  if (L.clippingMask) { setStatus("剪裁层不支持向下合并（先取消剪裁）"); return; }
  const under = doc.layers[idx - 1];
  if (under.clippingMask) { setStatus("下方是剪裁层不支持合并"); return; }
  // 算合并后的 bbox = active ∪ under
  const aHasPx = L.bboxW > 0 && L.bboxH > 0;
  const uHasPx = under.bboxW > 0 && under.bboxH > 0;
  if (!aHasPx) { _deleteLayer(L); return; }   // active 空，直接当删 active 处理
  const x0 = uHasPx ? Math.min(under.bboxX, L.bboxX) : L.bboxX;
  const y0 = uHasPx ? Math.min(under.bboxY, L.bboxY) : L.bboxY;
  const x1 = uHasPx ? Math.max(under.bboxX + under.bboxW, L.bboxX + L.bboxW) : L.bboxX + L.bboxW;
  const y1 = uHasPx ? Math.max(under.bboxY + under.bboxH, L.bboxY + L.bboxH) : L.bboxY + L.bboxH;
  const newW = x1 - x0, newH = y1 - y0;
  // 离屏画 tmp = under (source-over) → active (with active.mode × active.opacity)
  const tmp = (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(newW, newH)
    : (() => { const c = document.createElement("canvas"); c.width = newW; c.height = newH; return c; })();
  const tctx = tmp.getContext("2d");
  if (uHasPx) {
    tctx.globalAlpha = under.opacity;
    tctx.drawImage(under.canvas, under.bboxX - x0, under.bboxY - y0);
    tctx.globalAlpha = 1;
  }
  tctx.globalAlpha = L.opacity;
  tctx.globalCompositeOperation = L.mode || "source-over";
  tctx.drawImage(L.canvas, L.bboxX - x0, L.bboxY - y0);
  tctx.globalAlpha = 1;
  tctx.globalCompositeOperation = "source-over";
  // 先抓"被改前"状态再 mutate
  const underBeforeSnap = under.snapshot();
  const underBeforeOpacity = under.opacity;
  const underBeforeMode = under.mode;
  const activeSpec = layerSpecFrom(L);
  // 替换 under 的画布 + 归一化 opacity/mode（因为 active.mode×active.opacity 已经烤进 tmp 像素）
  under.canvas = tmp;
  under.ctx = tmp.getContext("2d", { willReadFrequently: false });
  under.bboxX = x0; under.bboxY = y0; under.bboxW = newW; under.bboxH = newH;
  under.opacity = 1;
  under.mode = "source-over";
  doc.removeLayer(L.id);
  const underAfterSnap = under.snapshot();
  history.push({
    type: "mergeDown",
    underId: under.id,
    underBefore: underBeforeSnap, underAfter: underAfterSnap,
    underBeforeOpacity, underBeforeMode,
    activeSpec, activeIndex: idx,
  });
  compressPixelSnap(underBeforeSnap, (blob) => { underBeforeSnap.blob = blob; });
  compressPixelSnap(underAfterSnap, (blob) => { underAfterSnap.blob = blob; });
  if (activeSpec.imageData) compressPixelSnap(activeSpec, (blob) => { activeSpec.blob = blob; });
  // 选 active = under (刚合并完的层)
  doc.setActiveById(under.id);
  _afterDocChange();
}

function _moveLayerDelta(L, delta) {
  if (!L) return;
  const from = doc.layers.findIndex((l) => l.id === L.id);
  if (!doc.moveLayer(L.id, delta)) return;
  const to = doc.layers.findIndex((l) => l.id === L.id);
  history.push({ type: "moveLayer", layerId: L.id, fromIdx: from, toIdx: to });
  _afterDocChange();
}

// v124b user 改主意：拆回 2 按钮。"+" 直加空层；相框 直开文件选
els.layerAddBtn.addEventListener("click", _addEmptyLayer);
document.getElementById("layerImportPhotoBtn")?.addEventListener("click", _openImagePicker);
// v132 (user：「global 加删除当前图层」) 删当前 active layer
document.getElementById("layerDeleteBtn")?.addEventListener("click", () => {
  if (doc.activeLayer) _deleteLayer(doc.activeLayer);
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

// 拉 etag 比对 + 冲突决断 —— 整套（备份先于覆盖 / keep-pull-branch）已收进 store.flow.open。
// 这里只剩 UI：spinner 锁屏 + 「跳过到离线」probe + 弹「拉/留/分支」+ 状态提示。
async function checkCloudETag(sessionName) {
  if (!sessionName) return;
  // spinner 锁屏；点「跳过到离线」→ resolve probe（flow.open 内部 race 到 skip）。
  // 注意：settleSyncGate(null)（fetch 赢 / onNewer 弹窗时）也会 resolve 这个 promise，值是 null——
  //       只有 value.kind==="skip"（用户真点了按钮）才算跳过，避免误判。
  let onSkip;
  const probe = new Promise((res) => { onSkip = res; });
  let skipped = false;
  lockSyncGate({
    title: "检查云端", message: sessionName, showSpinner: true,
    actions: [{ label: "跳过到离线", value: { kind: "skip" } }],
  }).then((v) => { if (v && v.kind === "skip") { skipped = true; onSkip(); } });

  let res;
  try {
    res = await _store.flow.open(sessionName, {
      isOnline: () => navigator.onLine !== false,
      probe,
      now: () => Date.now(),
      localDirty: () => _store.edits.localDirty(),   // 未落盘编辑也算 dirty → 不静默快进（ADR-0016）

      // 云端比 base 新 → 关 spinner，弹「保留 / 覆盖 / 分支」。pull/branch 的备份+覆盖由 flow.open 内执行。
      onNewer: async ({ cloudTime }) => {
        settleSyncGate(null);
        return await lockSyncGate({
          title: "云端有新版本",
          message: `${sessionName} 在云端 ${formatCloudTime(cloudTime)} 有新版本。本地是 ${getLocalSavedAtLabel()}。`,
          showSpinner: false,
          // spec（file-enter）：安全项 keep 默认（本地可能有未推编辑，默认拉云会丢）。
          actions: [
            { label: "保留本地（之后 push 会再确认）", value: "keep", primary: true },
            { label: "用云端覆盖本地（本地先备份进 .backup）", value: "pull" },
            { label: "两份都留（云端另存为副本）", value: "branch" },
          ],
        });
      },
      adopt: async (blob, nm) => { const loaded = await decodeOraToDoc(blob); adoptLoadedDoc(loaded, nm); },
    });
  } finally {
    settleSyncGate(null);   // 收尾确保 spinner 关（已关则安全 no-op）
  }

  // flow.open 的 source/reason → 状态提示
  if (res.source === "fast-forwarded") setStatus(`已同步到云端最新：${sessionName}`);   // clean 静默快进（ADR-0016）
  else if (res.source === "pulled") setStatus(`已拉云端；本地原版备份为「${res.backupName}」`);
  else if (res.source === "branched") setStatus(`云端版已开为「${res.branchName}」`);
  else {
    const reason = res.reason;
    if (skipped || reason === "skipped") setStatus("已跳过云端检查，用本地版本");
    else if (reason === "cloud-error") setStatus("连不上云端，用本地版本");
    else if (reason === "backup-failed") setStatus(`本地备份失败，已取消拉云端（本地未动）`, true);
    else if (reason === "cloud-vanished") setStatus(`云端找不到「${sessionName}」（本地未动）`, true);
    else if (reason === "kept") setStatus("已保留本地，云端版本暂不动");
    // in-sync / cloud-absent → 静默
  }
  // 成功联到云（非离线/出错/跳过）→ 记新鲜度时刻（ADR-0017：开图本身就是一次云端检查）。
  _markActivity();   // 刚开图 = 用户主动到场 → 重置闲置计时（别一进来就快到锁屏阈值）
}

// ADR-0016 §2：事件驱动的「干净 Work 无损快进」。放下 A 设备、回到 B 设备 → B 触发 focus/visibility/online →
// B 干净时先快进到云端最新（= A 的版本）再落笔 → B 的第一笔就根于最新 → B 的 push 是干净 If-Match（零 412 零 backup）。
// **硬约束（ADR-0016 §7）**：绝不每笔/每编辑触发——只挂人速事件；refresh 内部只 fetchMeta（etag 真动才拉内容）。
// ADR-0017（修订 2026-06-06）：**不做后台静默刷新**——内容创作里盯着画布时内容 unsolicited 突变会让人疯。
//   新鲜度走 **explicit 超时锁屏**：距上次动笔/操作 ≥ IDLE_LOCK_AFTER → 像 iPad 闲置熄屏那样**锁屏**；
//   点「继续」= 用户主动 → 才查云 + 干净则快进（任何内容变更都在用户点继续之后发生 = solicited）。
//   新鲜度是 wall-clock 属性、不靠 timer tick——suspend 期间 timer 冻结不跑，回前台靠 visibility/focus 现算
//   （关机一周再开 → 第一个事件即判 idle → 锁屏；绝不把周龄当新鲜、绝不静默 FF）。
const IDLE_LOCK_AFTER_MS = 3 * 60 * 1000;           // 距上次动笔/操作 ≥ 此 → 锁屏（explicit 继续才刷新）
let _lastActivityAt = Date.now();                   // 上次动笔/操作的时刻（idle 锁屏用）
let _idleLockShowing = false;
function _markActivity() { _lastActivityAt = Date.now(); }
// 注：save 图标 synced 态固定显「云✓+角标刷新箭」（中性色，含义=上次保存已同步·点击检查新版本），
//   不随时间变样——「过期该刷新」由闲置锁屏负责，不在图标上。故无云端新鲜度时钟（_lastCheckedAt 已删）。

let _ffInFlight = false;
async function maybeFastForwardActive({ manual = false } = {}) {
  if (_ffInFlight) return;
  if (!isSignedIn() || navigator.onLine === false) { if (manual) setStatus("离线，暂时无法检查云端", true); return; }
  const name = _activeSessionName;
  if (!name || name === "未命名") return;
  if (els.galleryFull && !els.galleryFull.classList.contains("hidden")) return;   // 在图库（无活动画布）不 FF
  if (_store.edits.localDirty() || isCloudDirty(name)) return;                     // 仅干净（refresh 内还会再判，这里先省一次网络）
  _ffInFlight = true;
  try {
    const vp = { ...board.viewport };   // 视口是设备态：FF 换的是内容，别让本设备的 zoom/pan 跟着跳
    const res = await _store.flow.refresh(name, {
      isOnline: () => navigator.onLine !== false,
      localDirty: () => _store.edits.localDirty(),
      adopt: async (blob, nm) => { const loaded = await decodeOraToDoc(blob); adoptLoadedDoc(loaded, nm); },
      busy: manual ? withBusy : undefined,   // 手动点 → 锁屏（反馈 + 防刷新中途动笔）；自动轮询 → 静默
    });
    if (res.status === "fast-forwarded") {
      board.setViewport(vp.tx, vp.ty, vp.scale, vp.rot || 0);   // 还原本设备视口
      setStatus(`已同步到云端最新：${name}`);
    } else if (manual && res.status === "in-sync") {
      setStatus(`已是云端最新：${name}`);
    }
    updateSaveStatus();   // 刷新新鲜度指示（synced 图标 fresh/stale）
  } catch (e) { console.warn("[ff] 快进失败：", e); }
  finally { _ffInFlight = false; }
}

// ADR-0017（修订）：超时 → 锁屏，点「继续」才 explicit 刷新。复用 lockSyncGate 当锁屏覆盖。
//   只在「活动·干净·已同步·登录·在线·闲够了·没别的 gate」时锁——这正是原来会**静默 FF** 的时机，
//   现在改成等用户主动点继续才把内容换到云端最新（绝不在你看着画布时突变）。dirty/离线/图库 → 不锁。
async function showIdleLockIfStale() {
  if (_idleLockShowing) return;
  if (!isSignedIn() || navigator.onLine === false) return;
  const name = _activeSessionName;
  if (!name || name === "未命名") return;
  if (els.galleryFull && !els.galleryFull.classList.contains("hidden")) return;   // 图库里不锁
  if (_store.edits.localDirty() || isCloudDirty(name)) return;                     // 有未存/未推编辑 → 不锁（不会 FF，你的活还在）
  if (Date.now() - _lastActivityAt < IDLE_LOCK_AFTER_MS) return;                   // 还没闲够
  _idleLockShowing = true;
  try {
    await lockSyncGate({
      title: "暂离编辑",
      message: "离开一会儿了。点「继续」会检查云端最新版本（可能是其他设备的改动）。",
      showSpinner: false,
      actions: [{ label: "继续编辑", value: "resume", primary: true }],
    });
  } finally {
    settleSyncGate(null);   // 收尾（已关则 no-op）
    _idleLockShowing = false;
    _markActivity();        // 点了继续 = 重新活跃，重置闲置计时
  }
  await maybeFastForwardActive({ manual: true });   // explicit：查云 + 干净则快进（withBusy 锁着拉，拉完才放手）
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
  // v124b toggle (user：「图层的 ⋯ 没法关，所有的 ⋯ 都点了能关」)
  // 同 anchor 再按 = 收回；不同 anchor 替换
  const existing = document.querySelector(".layer-tools-popup");
  const sameAnchor = existing && existing.dataset.anchorId === String(L.id);
  document.querySelectorAll(".layer-tools-popup").forEach((p) => p.remove());
  if (sameAnchor) return;

  const popup = document.createElement("div");
  popup.className = "menu-panel layer-tools-popup";
  popup.dataset.anchorId = String(L.id);
  // v123 起：del / up / down / 向下合并 都在这里
  const idx = doc.layers.findIndex((l) => l.id === L.id);
  const canUp = idx < doc.layers.length - 1;
  const canDown = idx > 0;
  const canDel = doc.layers.length > 1;
  const canMergeDown = idx > 0 && !L.clippingMask && !doc.layers[idx - 1].clippingMask;
  // v132 (user：「··· 菜单加 clear layer 在删除上面，删除不标红」)
  const hasPx = L.bboxW > 0 && L.bboxH > 0;
  popup.innerHTML = `
    <button class="menu-item" data-act="rename" type="button">
      <span class="menu-item-label">重命名…</span>
    </button>
    <button class="menu-item" data-act="up" type="button"${canUp ? "" : " disabled"}>
      <span class="menu-item-label">上移</span>
    </button>
    <button class="menu-item" data-act="down" type="button"${canDown ? "" : " disabled"}>
      <span class="menu-item-label">下移</span>
    </button>
    <button class="menu-item" data-act="mergeDown" type="button"${canMergeDown ? "" : " disabled"}>
      <span class="menu-item-label">向下合并</span>
    </button>
    <button class="menu-item" data-act="clear" type="button"${hasPx ? "" : " disabled"}>
      <span class="menu-item-label">清空内容</span>
    </button>
    <button class="menu-item menu-danger" data-act="del" type="button"${canDel ? "" : " disabled"}>
      <span class="menu-item-label">删除</span>
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
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    cleanup();
    if (act === "rename")           startLayerRename(L, nameEl);
    else if (act === "up")          _moveLayerDelta(L, 1);
    else if (act === "down")        _moveLayerDelta(L, -1);
    else if (act === "mergeDown")   _mergeDownLayer(L);
    else if (act === "clear")       _clearLayerPixels(L);
    else if (act === "del")         _deleteLayer(L);
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
// v125 (user：「undo redo 创建图层时不跳过去会误导用户，要 toast + 跳」)
//   addLayer.redo（重做创建）：setActive 到恢复的图层并 toast
//   addLayer.undo（撤销创建）：remove 后 active 落回兜底层，toast 提示
history.registerHandler("addLayer", {
  undo: (e) => {
    doc.removeLayer(e.layerSpec.id);
    if (e.prevActiveId != null) doc.setActiveById(e.prevActiveId);   // 回到创建前的活动层（不误导）
    _afterDocChange();
    setStatus(`已撤销创建图层「${e.layerSpec.name || ""}」`);
  },
  redo: (e) => {
    doc.insertLayerAt(e.index, e.layerSpec);
    doc.setActiveById(e.layerSpec.id);
    _afterDocChange();
    setStatus(`已恢复图层「${e.layerSpec.name || ""}」`);
  },
  refsLayer: (e, id) => e.layerSpec.id === id,
});
// removeLayer：undo 在 index 处恢复层（含 pixel）；redo 再删
// v125: 一律 setActive 到恢复的图层 + toast
history.registerHandler("removeLayer", {
  undo: async (e) => {
    const spec = e.layerSpec;
    if (spec.imageData || (!spec.blob && (spec.bboxW <= 0 || spec.bboxH <= 0))) {
      doc.insertLayerAt(e.index, spec);
    } else if (spec.blob) {
      const bitmap = await createImageBitmap(spec.blob);
      doc.insertLayerAt(e.index, { ...spec, bitmap });
      bitmap.close?.();
    } else {
      doc.insertLayerAt(e.index, spec);
    }
    doc.setActiveById(spec.id);
    _afterDocChange();
    setStatus(`已恢复图层「${spec.name || ""}」`);
  },
  redo: (e) => {
    doc.removeLayer(e.layerSpec.id);
    _afterDocChange();
    setStatus(`已删除图层「${e.layerSpec.name || ""}」`);
  },
  refsLayer: (e, id) => e.layerSpec.id === id,
});
// v124b mergeDown：undo 还原 under 像素 + opacity/mode，再 insert active 回 activeIndex；redo 应用 underAfter + 删 active
history.registerHandler("mergeDown", {
  undo: async (e) => {
    const under = doc.findLayer(e.underId);
    if (under) {
      applyPixelSnap(doc, e.underId, e.underBefore, e.underBefore.blob, board);
      under.opacity = e.underBeforeOpacity;
      under.mode = e.underBeforeMode;
    }
    // 把 active 插回原 index
    const spec = e.activeSpec;
    if (spec.imageData || spec.bboxW <= 0 || spec.bboxH <= 0) {
      doc.insertLayerAt(e.activeIndex, spec);
    } else if (spec.blob) {
      const bitmap = await createImageBitmap(spec.blob);
      doc.insertLayerAt(e.activeIndex, { ...spec, bitmap });
    } else {
      doc.insertLayerAt(e.activeIndex, spec);
    }
    doc.setActiveById(spec.id);
    _afterDocChange();
    setStatus(`已撤销合并 · 恢复「${spec.name || ""}」`);
  },
  redo: (e) => {
    const under = doc.findLayer(e.underId);
    if (under) {
      applyPixelSnap(doc, e.underId, e.underAfter, e.underAfter.blob, board);
      under.opacity = 1;
      under.mode = "source-over";
    }
    doc.removeLayer(e.activeSpec.id);
    doc.setActiveById(e.underId);
    _afterDocChange();
    setStatus("已向下合并");
  },
  refsLayer: (e, id) => e.underId === id || e.activeSpec.id === id,
});
// moveLayer：undo 从 toIdx 移回 fromIdx；redo 从 fromIdx 移到 toIdx
history.registerHandler("moveLayer", {
  undo: (e) => {
    const cur = doc.layers.findIndex((l) => l.id === e.layerId);
    if (cur < 0) return;
    doc.moveLayer(e.layerId, e.fromIdx - cur);
    _afterDocChange();
    const L = doc.findLayer(e.layerId);
    setStatus(`图层「${L?.name || ""}」移回原位`);
  },
  redo: (e) => {
    const cur = doc.layers.findIndex((l) => l.id === e.layerId);
    if (cur < 0) return;
    doc.moveLayer(e.layerId, e.toIdx - cur);
    _afterDocChange();
    const L = doc.findLayer(e.layerId);
    setStatus(`图层「${L?.name || ""}」已移动`);
  },
  refsLayer: (e, id) => e.layerId === id,
});
// renameLayer：oldName / newName
history.registerHandler("renameLayer", {
  undo: (e) => {
    const L = doc.findLayer(e.layerId);
    if (L) { L.name = e.oldName; renderLayersPanel(); setStatus(`图层名还原「${e.oldName}」`); }
  },
  redo: (e) => {
    const L = doc.findLayer(e.layerId);
    if (L) { L.name = e.newName; renderLayersPanel(); setStatus(`图层重命名「${e.newName}」`); }
  },
  refsLayer: (e, id) => e.layerId === id,
});
// setLayerProp：visibility / opacity / mode
const _LP_LABEL = { visible: "可见", opacity: "不透明度", mode: "混合", clippingMask: "剪裁" };
history.registerHandler("setLayerProp", {
  undo: (e) => {
    const L = doc.findLayer(e.layerId);
    if (L) { L[e.prop] = e.oldVal; _afterDocChange(); setStatus(`「${L.name}」${_LP_LABEL[e.prop] || e.prop} 已还原`); }
  },
  redo: (e) => {
    const L = doc.findLayer(e.layerId);
    if (L) { L[e.prop] = e.newVal; _afterDocChange(); setStatus(`「${L.name}」${_LP_LABEL[e.prop] || e.prop} 已更新`); }
  },
  refsLayer: (e, id) => e.layerId === id,
});
// setReferenceLayer：unique doc-level state
history.registerHandler("setReferenceLayer", {
  undo: (e) => { doc.referenceLayerId = e.oldVal; renderLayersPanel(); },
  redo: (e) => { doc.referenceLayerId = e.newVal; renderLayersPanel(); },
  refsLayer: (e, id) => e.oldVal === id || e.newVal === id,
});
// v110/114: docTransform —— crop / resample 一次 op 影响所有 layer + doc 尺寸 + viewport
// entry shape: { before: {doc, viewport}, after: {doc, viewport} }
history.registerHandler("docTransform", {
  undo: (e) => {
    doc.restoreSnapshotAll(e.before.doc);
    if (e.before.viewport) Object.assign(board.viewport, e.before.viewport);
    _afterDocChange();
    if (els.canvasSizeLabel) els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
    board.invalidateAll();
    renderLayersPanel();
  },
  redo: (e) => {
    doc.restoreSnapshotAll(e.after.doc);
    if (e.after.viewport) Object.assign(board.viewport, e.after.viewport);
    _afterDocChange();
    if (els.canvasSizeLabel) els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
    board.invalidateAll();
    renderLayersPanel();
  },
  refsLayer: () => true,        // 所有层都受影响
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
// 本地未落盘 = store.edits.localDirty()（派生自编辑游标，不再用独立的 _docDirty 标志）。
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
// synced 态图标：云✓（上次保存时已同步）+ 右下角小刷新箭（点击检查云端新版本）。中性色、不随时间变样（ADR-0017）。
const ICON_CLOUD_CHECK_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 13 11 15 15 11"/><g stroke-width="1.5"><path d="M21.8 18.5a2.3 2.3 0 1 1-.67-1.63"/><polyline points="21.8 16 21.15 16.9 20.2 16.5"/></g></svg>';
// 上传中：云形 + 旋转的弧。CSS animation rotate 由 [data-state="cloud-busy"] 触发
const ICON_CLOUD_BUSY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><g class="spin-arc" style="transform-origin: 12px 13px;"><path d="M9 13a3 3 0 0 1 5.5-1.6" /><polyline points="14.5 9.5 14.5 11.4 12.6 11.4" /></g></svg>';

// tile meta 三态 icon：
//   本地 only = database 圆柱（HDD 概念，比软盘直观）
//   云端 only = cloud outline
//   都有 = cloud + 内 checkmark（已同步）
const ICON_LOCAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>';
const ICON_CLOUD_SOLID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
const ICON_CLOUD_SYNCED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 14 11 16 15 12"/></svg>';
// cloud + ↑ = 本地有未推到云端的改动
const ICON_CLOUD_PENDING = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><line x1="12" y1="17" x2="12" y2="11"/><polyline points="9 14 12 11 15 14"/></svg>';

function computeSaveState() {
  // transient（本地未存/存盘中/推云中）= app 态；synced/dirty/local-only = store.cloud.status 单一源（候选2）。
  if (_cloudPushing) return "cloud-busy";
  if (_docSaving) return "saving";
  if (_store.edits.localDirty()) return "dirty";
  const st = _store.cloud.status(_activeSessionName, { signedIn: isSignedIn(), hasLocal: true });
  if (st === "dirty") return "cloud-dirty";     // 本地已存、云端未同步
  if (st === "synced") return "synced";         // 与云端一致
  return "local-only";                          // 未登录（含 cloud-only/absent，对本地视角=只本地）
}
function updateSaveStatus() {
  // gallery-first: 没绑 session → 隐藏 save btn（没东西可保存）
  if (!_activeSessionName) {
    els.topSaveBtn.dataset.state = "none";
    els.topSaveBtn.innerHTML = ICON_DISK;
    els.topSaveBtn.title = "未打开作品";
    return;
  }
  const state = computeSaveState();
  els.topSaveBtn.dataset.state = state;
  const name = _activeSessionName;
  if (state === "cloud-busy") { els.topSaveBtn.innerHTML = ICON_CLOUD_BUSY; els.topSaveBtn.title = `上传中… · ${name}`; }
  else if (state === "saving")      { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `保存中… · ${name}`; }
  else if (state === "dirty")  { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `保存 + 推送 (Ctrl+S) · ${name} · 未保存`; }
  else if (state === "cloud-dirty") { els.topSaveBtn.innerHTML = ICON_UPLOAD; els.topSaveBtn.title = `推送到云端 (Ctrl+S) · ${name} · 本地已存，云端未同步`; }
  else if (state === "synced") {
    // synced = 无可存可推 → 云✓（上次保存时已同步）+ 角标刷新箭；点击=检查云端新版本（中性色，不随时间变）。
    els.topSaveBtn.innerHTML = ICON_CLOUD_CHECK_REFRESH;
    els.topSaveBtn.title = `已同步云端（上次保存时）· 点击检查是否有新版本 · ${name}`;
  }
  else                          { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `已存本地（IDB 易失，登录云端更安全） · ${name}`; }
}
// opts.implicit = autosave / visibility / pagehide 这类后台路径。
// floating 状态下 implicit 路径**完全跳**——不把"layer 有洞"持久化进 IDB。
// 显式路径（Ctrl+S / 切 session / 进图库 / rename）会自动 commit floating 再保存，
// 匹配用户语义"save = 当前所见，包含正在变换"
// v124 (user)：未命名 + 一笔没动 (所有层 bbox 全空) → 跳过保存，避免 IDB 灌一堆"未命名"
// reset-to-blank 后的 lazy session 标记：name 已 unique 算好 + 占位但 IDB 没 record。
// 用户画第一笔后下面 _docIsBlankUnnamed 自检：bbox 非空 → 清 flag → 该 session 正常 save 落 IDB
let _isLazyBlankSession = false;
function _docIsBlankUnnamed() {
  if (_isLazyBlankSession) {
    for (const L of doc.layers) {
      if (L.bboxW > 0 && L.bboxH > 0) { _isLazyBlankSession = false; return false; }
    }
    return true;
  }
  if (_activeSessionName && _activeSessionName !== "未命名") return false;
  for (const L of doc.layers) {
    if (L.bboxW > 0 && L.bboxH > 0) return false;   // 有像素 → 不算 blank
  }
  return true;
}
async function saveNow(opts = {}) {
  if (_docSaving) return;
  if (!_activeSessionName) return;       // gallery-first: 在 gallery 没绑 session → 不保存
  if (_docIsBlankUnnamed()) return;
  if (editMode.hasPendingTransient()) {
    if (opts.implicit) return;             // 后台路径：保持 IDB 干净，等用户回来
    editMode.applyPendingTransient();           // 显式路径：先把变换 / 浮层等都 apply
  }
  // 文档来自更新版本 → 用户必须显式确认才能覆盖（每个 session 只问一次）
  // implicit 路径（autosave / visibility / pagehide）直接 skip 保存——防自动覆盖
  if (_loadedDocIsNewer && !_loadedDocNewerConfirmed) {
    if (opts.implicit) return;
    const ok = await openConfirmSheet(
      `覆盖更新版本写的画？`,
      `这画由 ${_loadedDocWriterVer} 写的，你是 ${WEBPAINT_VERSION}。` +
      `保存会丢失新版本特有的属性（如新图层 flag 等）。建议先刷新升级。`,
    );
    if (!ok) { setStatus("已取消保存"); return; }
    _loadedDocNewerConfirmed = true;
    updateNewerBanner();
  }
  _docSaving = true;
  updateSaveStatus();
  try {
    await saveSession(doc, _activeSessionName, _buildOraMeta());   // 本地/云端字节统一：viewport 不进 .ora（ADR-0016 §6）
    _store.edits.markSaved();
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
// 加载/采纳/FF 期间会调 input.clearHistory() → 派发 wp:histchange → dirty 监听器会把刚载入的画误标成
// **云端 dirty**（markSaved 只复位本地、复位不了云端）→ 刚 FF/打开就又脏、退出即冲突（真机实测「没画却冲突」根因）。
// _loadingDoc 在整个 adopt 期间挡掉 dirty 标记：保留 adopt 前的云端 dirty 真值（FF/pull=clean、本地脏画=仍脏）。
let _loadingDoc = false;
function adoptLoadedDoc(loaded, sessionName) {
  _loadingDoc = true;
  try {
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
  // C4：捕获本 tab 的 base-etag（打开这画时的云端版本）进 Store 内存。
  // 之后 store.flow.push 用它当 If-Match，不读共享 localStorage → 杜绝多 tab 静默覆盖。
  _store.adoptBase(sessionName, getKnownETag(sessionName));
  _store.edits.markSaved();
  _docLastSavedAt = Date.now();
  _isLazyBlankSession = false;   // 加载了真实 session，不再 lazy
  updateSaveStatus();
  // 文档版本检测：写入这画时的 WebPaint 版本 > 当前 → 警告
  // 防：旧客户端打开新版写的画 → 编辑 → 保存时把新版独有的层属性
  // （clipping / reference / 未来的扩展）静默吃掉。
  _loadedDocIsNewer = false;
  _loadedDocNewerConfirmed = false;
  const writerN = parseAppVersion(loaded._wroteWith);
  const selfN   = parseAppVersion(WEBPAINT_VERSION);
  if (writerN !== null && selfN !== null && writerN > selfN) {
    _loadedDocIsNewer = true;
    _loadedDocWriterVer = loaded._wroteWith;
    setStatus(
      `这画由 ${loaded._wroteWith} 写的，你是 ${WEBPAINT_VERSION} —— ` +
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
          activeBrushName: typeof saved.activeBrushName === "string" ? saved.activeBrushName : state.toolStates[t].activeBrushName,
          // v132 filterBrush 多 variantId（user：「持久化 filter brush 的 selection」）
          ...(typeof saved.variantId === "string" ? { variantId: saved.variantId } : {}),
        });
      }
    }
    applyToolState(editMode.current());
  }
  // v125 per-doc checkerboard：按文件值刷新，缺省回 false
  applyCheckerboard(!!loaded._webpaintState?.checkerboard);
  // v126 (user：「画布的旋转和位置缩放跟文件」)
  //   per-doc viewport：有就 restore，没有的话 caller 会 fitToScreen
  const vp = loaded._webpaintState?.viewport;
  if (vp && typeof vp.scale === "number") {
    Object.assign(board.viewport, vp);
    board.invalidateAll();
    board.requestRender();
  }
  // v133 (user：「revert 回到本次 session 打开时」) 写 checkpoint
  //   opts.skipCheckpoint = true 给 revert 路径用（revert 后不刷新 checkpoint，user 还能再 revert）
  if (!_adoptLoadedOpts.skipCheckpoint) {
    _sessionOpenedAt = Date.now();
    // 异步写：encode 几百 ms，不阻塞 UI
    _writeSessionCheckpoint(sessionName).catch((e) => console.warn("[revert] checkpoint 失败:", e));
  }
  } finally { _loadingDoc = false; }
}
// v133 revert: session-open checkpoint state
let _sessionOpenedAt = 0;
// adoptLoadedDoc opts 用全局传（绕开签名兼容）：调前 set，复位
let _adoptLoadedOpts = {};
function adoptLoadedDocWithOpts(loaded, name, opts) {
  _adoptLoadedOpts = opts || {};
  try { adoptLoadedDoc(loaded, name); }
  finally { _adoptLoadedOpts = {}; }
}
// 当前 doc 的标准持久化 meta（reference + webpaintState）。flow.encode 回调 / checkpoint / saveAndPush 共用，
// 避免这个形状散抄多份（drift 源）。
// viewport（zoom/pan）是**设备本地态**，**不进任何 .ora 字节**（本地落盘 / 云端同步一律不带）——
// ADR-0016 §6：设备态进 .ora 会让两设备同像素产生不同字节 → W1 字节相等自愈跨设备永不命中、纯平移也算冲突。
// 所有 .ora 字节由此统一（本地==云端），无「同一版本两份字节」的不一致。
// 取舍（用户定 2026-06-06）：重开（含同设备）一律 fitToScreen，不记忆视口。活动中的事件驱动 FF 仍保留当前视口
//   （maybeFastForwardActive 在内存里前后存还，不碰字节），别让背景快进把你正看的画面跳掉。
function _buildOraMeta() {
  return {
    referenceImage: referenceWindow.getPersistBlob(),
    webpaintState: { reference: referenceWindow.getSerializedState(), color: state.color, toolStates: state.toolStates, palette: paletteWindow.getSerializedState(), checkerboard: state.checkerboard },
  };
}
function _encodeCurrentOra() { return encodeDocToOra(doc, _buildOraMeta()); }

async function _writeSessionCheckpoint(name) {
  if (!name) return;
  const blob = await _encodeCurrentOra();
  await setMeta(`revert:${name}:ora`, blob);
  await setMeta(`revert:${name}:at`, _sessionOpenedAt);
}
async function _readSessionCheckpoint(name) {
  const blob = await getMeta(`revert:${name}:ora`);
  const at = await getMeta(`revert:${name}:at`);
  return blob ? { blob, at: at || 0 } : null;
}
// 笔触结束 / undo / redo / 图层操作（任何 wp:histchange）→ dirty。
// 合并了原来分开的「_editVersion++」监听：编辑游标 SSoT 归 Store（④），这里 mark 一次（无条件，含 B2 语义）。
window.addEventListener("wp:histchange", () => {
  if (_loadingDoc) return;                    // 加载/采纳/FF 期间 clearHistory 派发的 histchange 不算编辑（不标本地脏、不标云脏）
  _store.edits.mark();                        // 编辑游标推进 → 本地 localDirty 自动为真（B2 + 合流 + 本地落盘共用）
  if (!_activeSessionName) return;            // gallery-first: 无绑 session 时不响应
  // **不 gate isSignedIn**：编辑必标云脏。否则登出 / SSO 抖动期间的编辑不被标脏，
  // 登回来后 push 判 isCloudDirty=false 静默跳过 → 编辑永不上云、无报错（看不见 bug 根因）。
  // 安全：isCloudDirty getter 在未登录时本就返 false 忽略此标记，登回来才认这个 "1" → 补推。
  setCloudDirty(_activeSessionName, true);
  updateSaveStatus();
});
// **Ctrl+S / 点 save 按钮** = 完全保存（local IDB + push cloud）。
// user 显式 consent + 在场 → 触云。autosave / visibility / pagehide
// 走 saveNow（仅 IDB），不触云。详见 docs/persistence-and-encryption-shareback.md。
// 云推走 _store.flow.push（lib）：内含 B1 串行 / B2 不丢编辑 / B5 lost-response 自愈 / retry / C4 多tab。
// 真冲突 → flow.push 返回 {status:"conflict", choice}，下面复用既有 primitives 执行 pull/rename/branch。
async function saveAndPush() {
  if (_docSaving) return;
  if (_cloudPushing) await _awaitCloudPushIdle();
  if (!_activeSessionName) { setStatus("没打开作品，无法保存", true); return; }
  if (_store.edits.localDirty()) await saveNow();
  if (_activeSessionName) {
    _sessionOpenedAt = Date.now();
    _writeSessionCheckpoint(_activeSessionName).catch((e) => console.warn("[revert] explicit save checkpoint:", e));
  }
  if (isSignedIn() && navigator.onLine === false && isCloudDirty(_activeSessionName)) {
    setStatus(`已存本地：${_activeSessionName}（离线，回到在线再 Ctrl+S 推云端）`);
    return;
  }
  if (!(isSignedIn() && isCloudDirty(_activeSessionName))) {
    if (!isSignedIn() && !_store.edits.localDirty()) setStatus(`已存本地：${_activeSessionName}（IDB 易失，登录云端更安全）`);
    return;
  }
  const sessionName = _activeSessionName;
  let conflictChoice = null;
  _cloudPushing = true;
  updateSaveStatus();
  try {
    const result = await _store.flow.push(sessionName, {
      encode: () => _encodeCurrentOra(),   // 同步字节不带 viewport（ADR-0016 §6；与 checkpoint/flow.encode 共用一处形状）
      // store 内执行 take-cloud(pull) 需要 adopt 把云端版反映进活编辑器（_safePull：本地先 backup→拉云覆盖→adopt）。
      adopt: async (blob, nm) => { const loaded = await decodeOraToDoc(blob); adoptLoadedDoc(loaded, nm); },
      // spec（share-file-model / ADR-0009）：Work 禁 destructive pull。三选项无命名、两个「覆盖」输方都进 backup 不丢：
      //   no-op 安全默认 / pull=云端赢·我的进本地 .backup / weak-override=我赢·云端原版进云端 .backup。
      onConflict: async () => await lockSyncGate({
        title: "云端有更新版本",
        message: `「${sessionName}」云端已被改过；你本地是 ${getLocalSavedAtLabel()}。`,
        showSpinner: false,
        actions: [
          { label: "保留本地、暂不推（稍后再决定）", value: "no-op", primary: true },
          { label: "用云端覆盖本地（我的版本存进 .backup，可恢复）", value: "pull" },
          { label: "用本地覆盖云端（云端原版存进 .backup，可恢复）", value: "weak-override" },
        ],
      }),
    });
    if (result.status === "conflict") {
      conflictChoice = result.choice;                 // no-op（app 执行）
    } else if (result.status === "resolved" && result.resolution === "pull") {
      setStatus(`已采用云端版本：${sessionName}（你的版本存进本地 .backup，可恢复）`);
      renderGallery();
    } else if (result.status === "resolved" && result.resolution === "weak-override") {
      setStatus(`已用本地覆盖云端：${sessionName}（云端原版存进 .backup，可恢复）`);
      renderGallery();
    } else {
      setStatus(result.status === "healed"
        ? `已同步到云端：${sessionName}（云端本已是这份）`
        : `已同步到云端：${sessionName}`);
      renderGallery();
    }
  } catch (e) {
    console.warn("[cloud] store push failed:", e);
    setStatus("推送失败：" + (e && e.message || e));
  } finally {
    _cloudPushing = false;
    updateSaveStatus();
  }
  // 冲突执行：pull / weak-override 都已由 store 内部完成（备份先于覆盖）；这里只剩 no-op 提示。
  if (conflictChoice === "no-op") {
    setStatus(`已保留本地，云端未动；下次推会再确认（${sessionName}）`);
  }
}

// 重命名当前 active session。在画画界面也能调（汉堡菜单），云冲突时也会自动弹。
// 同名循环检查（local 范围）；返回新名（或 null 取消 / 失败）。
async function renameCurrentSession({ suggested, reason } = {}) {
  // 重命名 = 用户决定性动作 → apply pending（套索浮层等）
  editMode.applyPendingTransient();
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
    // 干活全交给 store.flow.rename（feedback-phantom-current-path：本地先存新名再删旧名，红线在库内）。
    //   云端：synced→服务端 move 保 etag；dirty/无云文件→push 新名 + 旧名进 .trash（非 hard-delete）。
    //   云端 best-effort：失败不回滚本地，新名标脏下次 Ctrl+S 续（res.cloudDeferred）。
    try {
      const cloudOn = isSignedIn() && navigator.onLine !== false;
      const res = await _store.flow.rename(oldName, trimmed, {
        encode: () => _encodeCurrentOra(),
        cloud: cloudOn,
      });
      _activeSessionName = trimmed;
      setCurrentSessionName(trimmed);
      _store.edits.markSaved();
      _docLastSavedAt = Date.now();
      updateSaveStatus();
      if (!cloudOn) setStatus(`已重命名：${oldName} → ${trimmed}`);
      else if (res.cloudDeferred) setStatus(`已重命名（仅本地）：${oldName} → ${trimmed}（云端稍后 Ctrl+S 推）`);
      else setStatus(`已重命名（含云端）：${oldName} → ${trimmed}`);
      renderGallery();
      return trimmed;
    } catch (e) {
      setStatus("重命名失败：" + (e && e.message || e));
      return null;
    }
  }
}

// Ctrl+S = 完整保存（本地 + 云端）；Ctrl+Shift+S = 只存本地（不推云）。
// 合流（coalesce）状态机收进 Store（④）：_store.session.request(type)。逻辑/单测见 store.js + test/store-coalescer。
// app 只注入两个真·保存动作（doLocal/doPush）。编辑游标也归 Store（_store.edits）——histchange 里 mark 一次。
_store.session.configure({ doLocal: () => saveNow(), doPush: () => saveAndPush() });

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    _store.session.request(e.shiftKey ? "local" : "push");
  }
});
// 3 min 兜底
setInterval(() => { if (_store.edits.localDirty() && !_docSaving) saveNow({ implicit: true }); }, AUTOSAVE_MS);
// visibility / pagehide 抢救（implicit：floating 状态下跳过；layer 留半态在内存，但 IDB 干净）
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && _store.edits.localDirty() && !_docSaving) saveNow({ implicit: true });
});
window.addEventListener("pagehide", () => {
  if (_store.edits.localDirty() && !_docSaving) saveNow({ implicit: true });
});
// v115: Ctrl+Shift+R / 关 tab / 浏览器返回 前弹挽留 + 偷偷本地备份
// (user：「可以弹挽留对话框，应该弹」+「挽留的时候偷偷本地备份」)
// 1. beforeunload 是唯一能 block 浏览器的钩子；对话框内容浏览器自管
// 2. dialog 弹出时浏览器暂停 UI 但 JS async 还在跑 → 偷偷起 saveNow，user 看 dialog 时
//    后台 IDB transaction 大概率能跑完；user 选「留下」→ 成果保住，选「离开」→
//    至少有 dialog 那一两秒救了
window.addEventListener("beforeunload", (e) => {
  if (_store.edits.localDirty() && !_docSaving) {
    e.preventDefault();
    e.returnValue = "";
    // 偷存（implicit 只写 IDB 不推云）；不 await 让 dialog 立刻起
    saveNow({ implicit: true }).catch(() => {});
  }
});

// 菜单：保存 / 分享 / 导出
function stampNow() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}-${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}`;
}
// ---- topbar：save/upload + gallery ----
// 点 save 按钮 = saveAndPush 一把梭（同 Ctrl+S）。state == "synced" 时
// 也跑一遍（no-op fast path）让 user 永远不需要"再点一下"。
els.topSaveBtn.addEventListener("click", () => {
  const name = _activeSessionName;
  // synced（无可存可推）→ 按钮兼作「刷新云端态」（ADR-0017，点一下 = 现场查云 + 干净则快进）；否则正常存/推。
  if (name && name !== "未命名" && isSignedIn() && !_store.edits.localDirty() && !isCloudDirty(name)) {
    maybeFastForwardActive({ manual: true });
  } else {
    _store.session.request("push");
  }
});

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

// ===== v110/114 crop / resample / adjust =====
// 通用：op 前先 commit floating + 把当前 doc + viewport snapshot 当 before
function _captureDocBefore() {
  editMode.applyPendingTransient();
  return { doc: doc.snapshotAll(), viewport: { ...board.viewport } };
}
function _captureDocAfter() {
  return { doc: doc.snapshotAll(), viewport: { ...board.viewport } };
}
function _pushDocTransform(before, after, label) {
  history.push({ type: "docTransform", before, after });
  _store.edits.mark();
  if (isSignedIn()) setCloudDirty(_activeSessionName, true);
  if (els.canvasSizeLabel) els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
  board.invalidateAll();
  renderLayersPanel();
  setStatus(label);
}

// v114: 裁切后让原 (rect.x, rect.y) 像素在屏上不挪 → viewport.tx/ty 减去 (rect.x, rect.y) × scale
// 数学：old 屏位 = old_tx + rect.x × scale；new 屏位 = new_tx + 0 × scale = new_tx
// 要等 → new_tx = old_tx + rect.x × scale
function _shiftViewportAfterCrop(rect) {
  const v = board.viewport;
  v.tx = v.tx + rect.x * v.scale;
  v.ty = v.ty + rect.y * v.scale;
}

// 裁到选区 ----
document.getElementById("adjustCropToSelection").addEventListener("click", () => {
  setMenuOpen(false);
  setAdjustOpen(false);
  if (!doc.selection) { setStatus("没选区——画一个 lasso 选区先", true); return; }
  const s = doc.selection;
  const x = Math.max(0, s.bboxX | 0), y = Math.max(0, s.bboxY | 0);
  const w = Math.min(doc.width - x, s.bboxW | 0), h = Math.min(doc.height - y, s.bboxH | 0);
  if (w < 1 || h < 1) { setStatus("选区太小或在画布外", true); return; }
  const before = _captureDocBefore();
  doc.cropTo({ x, y, w, h });
  _shiftViewportAfterCrop({ x, y });
  const after = _captureDocAfter();
  _pushDocTransform(before, after, `已裁到选区：${w}×${h}`);
});

// 自由裁切（8-handle）----
let _cropState = null;     // { rect:{x,y,w,h} in doc, drag:'nw'|'n'|'ne'|...|'move'|null, startMouse, startRect }
function _docRectToScreen(r) {
  const { tx, ty, scale } = board.viewport;
  return { x: r.x * scale + tx, y: r.y * scale + ty, w: r.w * scale, h: r.h * scale };
}
function _screenToDocPt(sx, sy) {
  const { tx, ty, scale } = board.viewport;
  return { x: (sx - tx) / scale, y: (sy - ty) / scale };
}
function _renderCropOverlay() {
  if (!_cropState) return;
  const r = _docRectToScreen(_cropState.rect);
  const el = document.getElementById("cropRect");
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
  document.getElementById("cropOverlay").classList.remove("hidden");
  document.getElementById("cropToolbar").classList.remove("hidden");
  _renderCropOverlay();
  _suppressTransientPanels("crop");
  // crop transient：apply/abort 都 = 丢弃裁切框（真裁只走 Apply 按钮）。决定性动作/ctrl-z 不会误裁。
  editMode.enterTransient("crop", { apply: _closeCropMode, abort: _closeCropMode });
}
function _closeCropMode() {
  _cropState = null;
  document.getElementById("cropOverlay").classList.add("hidden");
  document.getElementById("cropToolbar").classList.add("hidden");
  _restoreTransientPanels();
  editMode.exitTransient();   // sync 点：任何关闭路径（按钮/decisive）都清 EditMode 的 transient
}
// crop 时画布 pan/zoom（两指 / 滚轮）→ rect SSoT 是 doc 坐标，重投影到屏幕跟随 viewport
board.onViewportChange = () => { if (_cropState) _renderCropOverlay(); };
document.getElementById("adjustCropFree").addEventListener("click", () => {
  setMenuOpen(false);
  setAdjustOpen(false);
  _openCropMode();
});
// v124 合并裁切入口：有选区 → 裁到选区；无选区 → 自由裁切。label 在 setMenuOpen(true) 时动态切
const _menuCropBtn = document.getElementById("menuCrop");
if (_menuCropBtn) {
  _menuCropBtn.addEventListener("click", () => {
    if (doc.selection) document.getElementById("adjustCropToSelection").click();
    else                document.getElementById("adjustCropFree").click();
  });
}
function _updateMenuCropLabel() {
  const lbl = document.getElementById("menuCropLabel");
  if (!lbl) return;
  lbl.textContent = doc.selection ? "裁切到选区" : "裁切（自由）";
}
// 水平翻转整个画布（所有层 + 选区）。一次 docTransform op，可撤销。
const _menuFlipHBtn = document.getElementById("menuFlipH");
if (_menuFlipHBtn) {
  _menuFlipHBtn.addEventListener("click", () => {
    setMenuOpen(false);
    setAdjustOpen(false);
    const before = _captureDocBefore();
    doc.flipHorizontal();
    const after = _captureDocAfter();
    _pushDocTransform(before, after, "已水平翻转");
  });
}
document.getElementById("cropToolbarCancel").addEventListener("click", () => _closeCropMode());
document.getElementById("cropToolbarApply").addEventListener("click", () => {
  if (!_cropState) return;
  // v127 (user：「裁切还可以扩张」)：允许 x/y 负（向左/向上扩），允许 w/h > doc（向右/向下扩）
  //   只保最小 1 + 最大 8192；doc.cropTo 已支持负 dx/dy
  const r = _cropState.rect;
  const x = r.x | 0;
  const y = r.y | 0;
  const w = Math.max(1, Math.min(8192, r.w | 0));
  const h = Math.max(1, Math.min(8192, r.h | 0));
  const before = _captureDocBefore();
  doc.cropTo({ x, y, w, h });
  _shiftViewportAfterCrop({ x, y });
  const after = _captureDocAfter();
  _pushDocTransform(before, after, `已裁切：${w}×${h}`);
  _closeCropMode();
});

// 裁切 overlay 拖拽 (handle / rect 内 = move)
(function bindCropOverlayPointer() {
  const overlay = document.getElementById("cropOverlay");
  const rect = document.getElementById("cropRect");
  overlay.addEventListener("pointerdown", (e) => {
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
  overlay.addEventListener("pointermove", (e) => {
    if (!_cropState || !_cropState.drag) return;
    const dx_screen = e.clientX - _cropState.startMouse.x;
    const dy_screen = e.clientY - _cropState.startMouse.y;
    const scale = board.viewport.scale;
    const dx = dx_screen / scale;
    const dy = dy_screen / scale;
    const r0 = _cropState.startRect;
    const r = { ..._cropState.rect };
    const h = _cropState.drag;
    if (h === "move") {
      r.x = r0.x + dx;
      r.y = r0.y + dy;
    } else {
      if (h.includes("n")) { r.y = r0.y + dy; r.h = r0.h - dy; }
      if (h.includes("s")) { r.h = r0.h + dy; }
      if (h.includes("w")) { r.x = r0.x + dx; r.w = r0.w - dx; }
      if (h.includes("e")) { r.w = r0.w + dx; }
    }
    // v127 (user：「裁切还可以扩张」)
    //   原本 clamp 到 [0, doc] 不让拖出；现在只保 min 4px + max 8192
    //   r.x / r.y 可负（向左 / 向上 扩张）；r.w / r.h 可超 doc（向右 / 向下 扩张）
    //   doc.cropTo 已支持负 dx/dy 扩张语义，不需要再改
    if (r.w < 4) { r.w = 4; if (h.includes("w")) r.x = r0.x + r0.w - 4; }
    if (r.h < 4) { r.h = 4; if (h.includes("n")) r.y = r0.y + r0.h - 4; }
    if (r.w > 8192) { r.w = 8192; if (h.includes("w")) r.x = r0.x + r0.w - 8192; }
    if (r.h > 8192) { r.h = 8192; if (h.includes("n")) r.y = r0.y + r0.h - 8192; }
    _cropState.rect = r;
    _renderCropOverlay();
  });
  overlay.addEventListener("pointerup", (e) => {
    if (!_cropState) return;
    try { overlay.releasePointerCapture(e.pointerId); } catch {}
    _cropState.drag = null;
  });
  overlay.addEventListener("pointercancel", (e) => {
    if (!_cropState) return;
    try { overlay.releasePointerCapture(e.pointerId); } catch {}
    _cropState.drag = null;
  });
})();

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
document.getElementById("adjustResample").addEventListener("click", () => {
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
  const before = _captureDocBefore();
  doc.resampleTo(nw, nh, mode);
  const after = _captureDocAfter();
  _pushDocTransform(before, after, `已重采样到 ${nw}×${nh}（${mode}）`);
  _closeResampleDialog();
});

// v131 Filter 面板（重构自原 BCSH 颜色调整）
// 所有 filter 走 src/filters.js 的 Filter 接口（含 id/title/menuId/modes/bleedRadius/defaults/buildBody/bake）
// _adjustState = { Filter, active, params, beforeSnap, sur, surCtx, srcImg, maskData, _rafId }
// 入口 _openFilterPanel(filterId)；Reset / Cancel / Apply 共用
// preview 用 rAF coalesce：slider drag 不堵队列（user：「液化笔刷事件 last commit，slider drag 也是，gaussian blur fps 低 OK，别 queue 卡半天」）
let _adjustState = null;     // 见上注释
// === 老 BCSH 实现已迁 src/filters.js HsbFilter，这里只剩 panel infra ===

// 准备 surrogate canvas + 提取 src/mask 数据
function _initFilterSurrogate(L) {
  const sur = document.createElement("canvas");
  sur.width = L.bboxW; sur.height = L.bboxH;
  const surCtx = sur.getContext("2d");
  surCtx.drawImage(L.canvas, 0, 0);
  const srcImg = surCtx.getImageData(0, 0, L.bboxW, L.bboxH);
  let maskData = null;
  if (doc.selection) {
    const m = document.createElement("canvas");
    m.width = L.bboxW; m.height = L.bboxH;
    const mctx = m.getContext("2d");
    mctx.drawImage(doc.selection.maskCanvas,
      doc.selection.bboxX - L.bboxX, doc.selection.bboxY - L.bboxY);
    maskData = mctx.getImageData(0, 0, L.bboxW, L.bboxH).data;
  }
  return { sur, surCtx, srcImg, maskData };
}

// v132 opts.picker = [Filter, ...]：在 panel body 顶部插一个 dropdown 切其他 filter
//   切换 = cancel 当前 → reopen 新 filter（同一 picker）。用于"艺术滤镜"组
function _openFilterPanel(filterId, opts = {}) {
  const Filter = getFilter(filterId);
  if (!Filter) { setStatus(`未知 filter：${filterId}`, true); return; }
  const L = doc.activeLayer;
  if (!L) { setStatus("没活动图层", true); return; }
  if (L.bboxW <= 0 || L.bboxH <= 0) { setStatus("活动图层是空的", true); return; }
  if (_adjustState) _closeFilterPanel(false);
  const { sur, surCtx, srcImg, maskData } = _initFilterSurrogate(L);
  _adjustState = {
    Filter, active: L, params: Filter.defaults(),
    beforeSnap: L.snapshot(), sur, surCtx, srcImg, maskData,
    _rafId: 0,
    picker: opts.picker || null,
  };
  if (els.adjustPanelTitle) els.adjustPanelTitle.textContent = opts.picker ? "艺术滤镜" : Filter.title;
  els.adjustParamsBody.innerHTML = "";
  // picker 模式：插 dropdown
  if (opts.picker) {
    const wrap = document.createElement("label");
    wrap.className = "brush-slider-row";
    wrap.innerHTML = `<span class="brush-slider-label">选滤镜</span>`;
    const sel = document.createElement("select");
    sel.style.flex = "1";
    sel.style.font = "inherit";
    sel.style.padding = "2px 4px";
    for (const F of opts.picker) {
      const opt = document.createElement("option");
      opt.value = F.id;
      opt.textContent = F.title;
      if (F.id === filterId) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      const newId = sel.value;
      if (newId === filterId) return;
      _closeFilterPanel(false);
      _openFilterPanel(newId, { picker: opts.picker });
    });
    wrap.appendChild(sel);
    wrap.appendChild(document.createElement("span"));
    els.adjustParamsBody.appendChild(wrap);
  }
  Filter.buildBody(els.adjustParamsBody, _adjustState, _onFilterChange);
  els.adjustPanel.classList.remove("hidden");
  const w = els.adjustPanel.offsetWidth || 320;
  els.adjustPanel.style.left = (window.innerWidth - w - 16) + "px";
  els.adjustPanel.style.top  = "70px";
  _bringPanelTop(els.adjustPanel);
  board.setActiveLayerSurrogate?.(L.id, sur);
  _runFilterPreview();      // 初次渲染（identity）
  _suppressTransientPanels("adjust-color");
  // adjust transient：apply=烤进(true)，abort=丢弃(false)。_closeFilterPanel 是 sync 点（见其尾 exitTransient）。
  editMode.enterTransient("adjust", { apply: () => _closeFilterPanel(true), abort: () => _closeFilterPanel(false) });
}

// preview coalesce：rAF 保证最多 1 帧 1 次 bake，slider drag 不堵队列
// (user：「液化笔刷事件 last commit，slider drag 也是，fps 低 OK，别 queue 卡半天」)
function _onFilterChange() {
  if (!_adjustState) return;
  if (_adjustState._rafId) return;
  _adjustState._rafId = requestAnimationFrame(() => {
    if (!_adjustState) return;
    _adjustState._rafId = 0;
    _runFilterPreview();
  });
}
function _runFilterPreview() {
  const s = _adjustState;
  const outImg = s.surCtx.createImageData(s.srcImg.width, s.srcImg.height);
  s.Filter.bake(s.srcImg.data, outImg.data, s.params, s.maskData, s.srcImg.width, s.srcImg.height);
  s.surCtx.putImageData(outImg, 0, 0);
  board.invalidateAll();
}

function _closeFilterPanel(applied) {
  if (!_adjustState) return;
  const L = _adjustState.active;
  if (_adjustState._rafId) { cancelAnimationFrame(_adjustState._rafId); _adjustState._rafId = 0; }
  board.setActiveLayerSurrogate?.(null, null);
  if (applied) {
    // 烤进 layer（surrogate 已是最终结果，直接拷回）
    L.ctx.clearRect(0, 0, L.bboxW, L.bboxH);
    L.ctx.drawImage(_adjustState.sur, 0, 0);
    const after = L.snapshot();
    history.push({ type: "stroke", layerId: L.id, before: _adjustState.beforeSnap, after, beforeBlob: null, afterBlob: null });
    _store.edits.mark();
    if (isSignedIn()) setCloudDirty(_activeSessionName, true);
    setStatus(`${_adjustState.Filter.title} 已应用：${L.name}`);
  }
  _adjustState = null;
  els.adjustPanel.classList.add("hidden");
  els.adjustParamsBody.innerHTML = "";
  _restoreTransientPanels();
  board.invalidateAll();
  editMode.exitTransient();   // sync 点：任何关闭路径（OK/cancel/重开/picker/decisive）都清 EditMode transient
}

// v132 菜单 3 组渲染（user：「3 组 hr 分组：调色 / 液化锐化模糊 / 艺术滤镜」）
//   - 调色 = adjustment category + 有 region 模式（HSV / ColorBalance / Curves）
//             左侧 prefix = 旧 adjust SVG（3 条滑块 + 圆点）
//   - 笔刷类 = 液化 + 所有有 brush 模式的 filter
//             左侧 prefix = 笔刷 SVG（跟工具栏一致）
//   - 艺术滤镜 = category="artist"，1 个 picker item（点开 panel 里有 dropdown 切）
//   - 组之间 hr 分隔，不写类别 label
const ADJUST_PREFIX_SVG = `<svg class="menu-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>
  <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/>
  <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/>
  <circle cx="7" cy="18" r="2" fill="currentColor" stroke="none"/>
</svg>`;
const BRUSH_PREFIX_SVG = `<svg class="menu-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M14 4l6 6-9 9H5v-6l9-9z"/><path d="M13 5l6 6"/>
</svg>`;
function _renderFilterMenu() {
  const container = document.getElementById("adjustFilterList");
  if (!container) return;
  container.innerHTML = "";
  const all = listFilters();
  const adjustmentRegion = all.filter((F) => (F.category || "adjustment") === "adjustment" && F.modes.includes("region"));
  const brushFilters     = all.filter((F) => F.modes.includes("brush"));
  const artistFilters    = all.filter((F) => F.category === "artist");
  const addHr = () => {
    const hr = document.createElement("hr"); hr.className = "menu-sep"; container.appendChild(hr);
  };
  const addItem = (label, prefixSvg, onClick) => {
    const btn = document.createElement("button");
    btn.className = "menu-item menu-item-with-icon";
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    btn.innerHTML = `${prefixSvg}<span class="menu-item-label">${label}</span>`;
    btn.addEventListener("click", onClick);
    container.appendChild(btn);
    return btn;
  };
  let groupOpened = false;
  // 1) 调色
  for (const F of adjustmentRegion) {
    addItem(F.title, ADJUST_PREFIX_SVG, () => {
      setAdjustOpen(false);
      _openFilterPanel(F.id);
    });
    groupOpened = true;
  }
  // 2) 笔刷类 filter（液化 / 锐化模糊 都是 plugin，自动列出来）
  if (groupOpened && brushFilters.length > 0) addHr();
  groupOpened = brushFilters.length > 0;
  for (const F of brushFilters) {
    addItem(F.title, BRUSH_PREFIX_SVG, () => {
      setAdjustOpen(false);
      _enterFilterBrushMode(F);
    });
  }
  // 3) 艺术滤镜（1 picker item）
  if (artistFilters.length > 0) {
    if (groupOpened) addHr();
    addItem("艺术滤镜", ADJUST_PREFIX_SVG, () => {
      setAdjustOpen(false);
      _openArtistPicker();
    });
  }
}
// 艺术滤镜：开 adjust panel，body 顶部加 dropdown 切具体 filter
function _openArtistPicker() {
  const artist = listFilters().filter((F) => F.category === "artist");
  if (artist.length === 0) { setStatus("没有艺术滤镜"); return; }
  _openFilterPanel(artist[0].id, { picker: artist });
}
_renderFilterMenu();
onFilterRegistered(_renderFilterMenu);

// v132 进入 / 退出 filter brush 模式
//   进入：state.filterBrush = { Filter, params, variantId, variantLabel }；setTool("filterBrush")
//        + openExclusive 弹 filter brush rack（user：「我不是让你做两个新笔吗」）
//        + variantId 优先用 toolStates.filterBrush.variantId 持久化值
//        + toolbar 渲染子算法 dropdown（user：「不同算法是 toolbar dropdown」）
//   退出：清 state.filterBrush；关 rack；setTool 回前一个
let _filterBrushPreviousTool = null;
function _enterFilterBrushMode(Filter) {
  editMode.applyPendingTransient();
  _filterBrushPreviousTool = editMode.current() === "filterBrush" ? "brush" : editMode.current();
  // 取持久化的 variantId（user 上次选过的；新 doc 默认第一个）
  const variants = Filter.brushVariants || [{ id: "default", title: Filter.title, params: Filter.defaults() }];
  const savedVid = state.toolStates.filterBrush?.variantId;
  let variant = variants.find((v) => v.id === savedVid) || variants[0];
  // v147 声明了 boundaryModes 的 filter（液化）→ params 带上持久化的 bleed；其他 filter 不掺这个 key
  const params = Filter.boundaryModes
    ? { ...variant.params, bleed: safeLS("webpaint.liquify.bleed") || "edge" }
    : variant.params;
  state.filterBrush = { Filter, params, variantId: variant.id, variantLabel: variant.title };
  if (state.toolStates.filterBrush) state.toolStates.filterBrush.variantId = variant.id;
  setTool("filterBrush");
  _renderFilterBrushToolbar();
  // v132 (user：「点 filter brush 不要自动弹笔架」) 进入时不开 rack
  //   user 想换笔点 toolbar 的「笔架」button
  setStatus(`${Filter.title}（笔刷）`);
}
function _exitFilterBrushMode() {
  state.filterBrush = null;
  const tb = document.getElementById("filterBrushToolbar");
  if (tb) tb.classList.add("hidden");
  closeExclusive();   // 收 rack
  setTool(_filterBrushPreviousTool || "brush");
  _filterBrushPreviousTool = null;
  setStatus("已退出 filter brush");
}
// 渲染 toolbar：title + variant dropdown (if multi) + 退出
function _renderFilterBrushToolbar() {
  if (!state.filterBrush) return;
  const { Filter, variantId } = state.filterBrush;
  const tb = document.getElementById("filterBrushToolbar");
  const title = document.getElementById("filterBrushTitle");
  if (!tb || !title) return;
  tb.classList.remove("hidden");
  title.textContent = Filter.title;
  // dropdown：清掉旧的，按 brushVariants 重建
  let sel = document.getElementById("filterBrushVariantSel");
  if (sel) sel.remove();
  const variants = Filter.brushVariants || [];
  if (variants.length > 1) {
    sel = document.createElement("select");
    sel.id = "filterBrushVariantSel";
    sel.className = "crop-toolbar-btn";
    sel.style.padding = "2px 6px";
    for (const v of variants) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.title;
      if (v.id === variantId) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      const v = variants.find((x) => x.id === sel.value);
      if (!v) return;
      // 切 variant 别丢 bleed（boundaryModes filter 才有这个 key）
      state.filterBrush.params = Filter.boundaryModes
        ? { ...v.params, bleed: state.filterBrush.params.bleed }
        : v.params;
      state.filterBrush.variantId = v.id;
      state.filterBrush.variantLabel = v.title;
      if (state.toolStates.filterBrush) state.toolStates.filterBrush.variantId = v.id;
      _store.edits.mark(); updateSaveStatus();
      setStatus(`已切 ${v.title}`);
    });
    // 插在 title 后
    title.insertAdjacentElement("afterend", sel);
  }
  // v147 边界取样下拉：仅当 filter 声明 boundaryModes（液化）且有选区时渲染。
  // feature 声明数据 + 通用渲染 → 删 filter 即删 UI，不再像旧 #liquifyPanel 那样静态腐烂。
  let bsel = document.getElementById("filterBrushBleedSel");
  if (bsel) bsel.remove();
  if (Filter.boundaryModes && doc.selection) {
    bsel = document.createElement("select");
    bsel.id = "filterBrushBleedSel";
    bsel.className = "crop-toolbar-btn";
    bsel.style.padding = "2px 6px";
    bsel.title = "选区边界：位移源落到选区外怎么办";
    const curBleed = state.filterBrush.params.bleed || "edge";
    for (const b of Filter.boundaryModes) {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.title;
      if (b.id === curBleed) opt.selected = true;
      bsel.appendChild(opt);
    }
    bsel.addEventListener("change", () => {
      state.filterBrush.params = { ...state.filterBrush.params, bleed: bsel.value };
      safeLSSet("webpaint.liquify.bleed", bsel.value);
      const m = Filter.boundaryModes.find((b) => b.id === bsel.value);
      setStatus(`边界：${m ? m.title : bsel.value}`);
    });
    // 插在 variant select 后（没有 variant 就插 title 后）
    (document.getElementById("filterBrushVariantSel") || title).insertAdjacentElement("afterend", bsel);
  }
}
document.getElementById("filterBrushExit")?.addEventListener("click", _exitFilterBrushMode);
// v132 笔架 button：再开 rack（user：「ui 里有开笔架，不然关了开不了」）
document.getElementById("filterBrushOpenRack")?.addEventListener("click", () => {
  openExclusive(PANELS.RACK_FILTER_BRUSH);
});
document.getElementById("adjustReset").addEventListener("click", () => {
  if (!_adjustState) return;
  _adjustState.params = _adjustState.Filter.defaults();
  els.adjustParamsBody.innerHTML = "";
  _adjustState.Filter.buildBody(els.adjustParamsBody, _adjustState, _onFilterChange);
  _onFilterChange();
});
document.getElementById("adjustCancel").addEventListener("click", () => _closeFilterPanel(false));
document.getElementById("adjustPanelClose").addEventListener("click", () => _closeFilterPanel(false));
document.getElementById("adjustApply").addEventListener("click", () => _closeFilterPanel(true));

// v136 POC: 云缩略图 byte-range 拉取 — console 调试
//   await WebPaint.pocFetchThumb()  默认拉云列表第一个 ora 验证
import { fetchOraThumbnail } from "./cloud-thumbs.js";
window.WebPaint = window.WebPaint || {};
window.WebPaint.fetchOraThumbnail = fetchOraThumbnail;
window.WebPaint.cloudThumbStats = () => ({ cache: { ...cloudThumbStats }, paths: { ...cloudThumbTelemetry } });
window.WebPaint.cloudThumbResetStats = () => { cloudThumbResetStats(); cloudThumbResetTelemetry(); };
window.WebPaint.cloudThumbSkipCache = (on = true) => {
  cloudThumbConfig.skipCache = !!on;
  console.log(`[cloud-thumb] skipCache=${cloudThumbConfig.skipCache}`);
};
window.WebPaint.clearCloudThumbCache = async () => {
  const n = await clearCloudThumbCache();
  console.log(`[cloud-thumb] cleared ${n} cached thumbnails`);
  return n;
};
window.WebPaint.pocFetchThumb = async function (itemId, fileSize) {
  if (!itemId) {
    // 自动找第一个云端 ora
    if (!isSignedIn()) throw new Error("没登录云");
    const list = await listCloudSessionsRecursive();
    if (!list.length) throw new Error("云端没 session");
    const first = list[0];
    itemId = first.id; fileSize = first.size;
    console.log("POC：拉", first.path, "size", fileSize);
  }
  const t0 = performance.now();
  const blob = await fetchOraThumbnail(itemId, fileSize);
  console.log(`POC 完成 ${(performance.now() - t0) | 0}ms, blob size ${blob.size}`);
  // 显示到 console（可见 thumbnail）
  const url = URL.createObjectURL(blob);
  console.log("thumbnail URL（在 console 点击预览）：", url);
  const img = new Image();
  img.src = url;
  document.body.appendChild(img);
  img.style.cssText = "position:fixed;top:60px;right:16px;z-index:99999;border:2px solid red;max-width:256px";
  setTimeout(() => { img.remove(); URL.revokeObjectURL(url); }, 10000);
  return blob;
};

// 暴露给 plugin（v131）：window.WebPaint.registerFilter(FilterClass)
// 插件自己写 buildBody，可以放色环 / 自定义 canvas / 任何 DOM（user：「插件自己提供 UI」）
window.WebPaint = window.WebPaint || {};
window.WebPaint.registerFilter = registerFilter;
window.WebPaint.listFilters = listFilters;
// adjust panel head 拖动
(function bindAdjustPanelDrag() {
  let drag = null;
  els.adjustPanelHead.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".float-panel-close")) return;
    const r = els.adjustPanel.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
    els.adjustPanelHead.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  els.adjustPanelHead.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const w = els.adjustPanel.offsetWidth, h = els.adjustPanel.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth - w, drag.ol + (e.clientX - drag.sx)));
    const top  = Math.max(0, Math.min(window.innerHeight - h, drag.ot + (e.clientY - drag.sy)));
    els.adjustPanel.style.left = left + "px";
    els.adjustPanel.style.top = top + "px";
  });
  els.adjustPanelHead.addEventListener("pointerup", (e) => {
    if (drag && e.pointerId === drag.id) {
      try { els.adjustPanelHead.releasePointerCapture(e.pointerId); } catch {}
      drag = null;
    }
  });
})();
// ===== v110 crop/resample/adjust end =====

// v124 (user) 图库挪回顶栏：topGalleryBtn 直接开图库；menuGallery 留 stub 兜底
// gallery-first：进图库 = 关闭当前画作（active = null）+ refresh 后停 gallery
document.getElementById("topGalleryBtn")?.addEventListener("click", () => _exitCanvasToGallery());
els.menuGallery?.addEventListener("click", () => { setMenuOpen(false); _exitCanvasToGallery(); });

// ---- 菜单：导入 / 导出 / 剪贴板 / 适应 ----
els.menuRename.addEventListener("click", () => {
  setMenuOpen(false);
  renameCurrentSession();
});
// v125 (user：「菜单加另存为（画库 + 名字冲突检查）」)
//   "另存为" = 当前 doc 复制到新名字 session（原 session 保留）。
//   完成后切到新 session 继续编辑（Photoshop 语义）。同名检查本地 + 云端。
els.menuSaveAs.addEventListener("click", async () => {
  setMenuOpen(false);
  editMode.applyPendingTransient();
  const oldName = _activeSessionName || "未命名";
  let candidate = `${oldName} 副本`;
  while (true) {
    const input = await openInputSheet("另存为", candidate, { placeholder: "新作品名字" });
    if (input === null) return;
    const trimmed = input.trim();
    if (!trimmed) { setStatus("名字不能空", true); candidate = ""; continue; }
    if (trimmed === oldName) { setStatus("名字和当前一样，换一个", true); candidate = trimmed; continue; }
    const localNames = (await listSessions()).map((s) => s.name);
    if (localNames.includes(trimmed)) {
      setStatus(`本地已有同名 "${trimmed}"，换一个`, true);
      candidate = trimmed; continue;
    }
    if (isSignedIn() && navigator.onLine !== false) {
      try {
        const cloud = await listCloudSessionsRecursive();
        const cloudNames = cloud.map((c) => c.path.replace(/\.ora$/i, ""));
        if (cloudNames.includes(trimmed)) {
          setStatus(`云端已有同名 "${trimmed}"，换一个`, true);
          candidate = trimmed; continue;
        }
      } catch (e) { console.warn("[saveAs] cloud list failed:", e); }
    }
    // 另存为 = 写新身份、旧的不动（store.flow.saveAs：本地存 + 云端 push，云端 best-effort）。
    try {
      const cloudOn = isSignedIn() && navigator.onLine !== false;
      const res = await _store.flow.saveAs(trimmed, {
        encode: () => _encodeCurrentOra(),
        cloud: cloudOn,
      });
      _activeSessionName = trimmed;
      setCurrentSessionName(trimmed);
      _store.edits.markSaved();
      _docLastSavedAt = Date.now();
      updateSaveStatus();
      if (!cloudOn) setStatus(`已另存为：${trimmed}`);
      else if (res.cloudDeferred) setStatus(`已另存为（仅本地）：${trimmed}（云端稍后 Ctrl+S 推）`);
      else setStatus(`已另存为（含云端）：${trimmed}`);
      renderGallery();
      return;
    } catch (e) {
      setStatus("另存为失败：" + (e && e.message || e));
      return;
    }
  }
});
// v133 revert：从 IDB checkpoint 恢复 session 打开时的状态
els.menuRevertToOpen?.addEventListener("click", async () => {
  setMenuOpen(false);
  if (!_activeSessionName) { setStatus("没活动 session", true); return; }
  const cp = await _readSessionCheckpoint(_activeSessionName);
  if (!cp || !cp.blob) {
    setStatus("没找到本次打开时的快照", true);
    return;
  }
  const ageMin = Math.max(1, Math.round((Date.now() - (cp.at || _sessionOpenedAt)) / 60000));
  const choice = await lockSyncGate({
    title: "撤销修改",
    message: `回到约 ${ageMin} 分钟前的快照（本次打开或上次保存时的版本）。\n之后所有修改将丢失。`,
    actions: [
      { label: "取消", value: "cancel" },
      { label: "撤销", value: "ok", primary: true },
    ],
  });
  if (choice !== "ok") return;
  editMode.applyPendingTransient();
  try {
    const loaded = await decodeOraToDoc(cp.blob);
    adoptLoadedDocWithOpts(loaded, _activeSessionName, { skipCheckpoint: true });
    _store.edits.mark();     // 跟磁盘内容已经偏离，下次保存把 revert 后的状态写进去
    updateSaveStatus();
    setStatus(`已恢复到本次打开时（${ageMin} 分钟前）`);
  } catch (e) {
    setStatus("恢复失败：" + (e && e.message || e), true);
  }
});
// v120: 主菜单导出/导入 重组（user：「导出项目和导出语义分开」+「小扳手」)
// - 主行 = 按 sticky config 一键执行；🔧 = 弹 inline popup 改 config
// - sticky 存 localStorage（不绑 doc，配一次全工程用）
const _EXP_PRJ_KEY = "webpaint:exportProject:v1";   // { format: "ora" | "psd" }
const _EXP_IMG_KEY = "webpaint:exportImage:v1";     // { format, target }
const _IMP_IMG_KEY = "webpaint:importImage:v1";     // { source: "file" | "clipboard" }
function _getExpPrj() {
  try { return JSON.parse(localStorage.getItem(_EXP_PRJ_KEY)) || { format: "ora" }; }
  catch { return { format: "ora" }; }
}
function _getExpImg() {
  try {
    const v = JSON.parse(localStorage.getItem(_EXP_IMG_KEY)) || {};
    // v124 加 scope 字段 ("merged" | "active")，默认 merged 兼容旧配置
    return { format: "png", target: "file", scope: "merged", ...v };
  } catch { return { format: "png", target: "file", scope: "merged" }; }
}
function _getImpImg() {
  try { return JSON.parse(localStorage.getItem(_IMP_IMG_KEY)) || { source: "file" }; }
  catch { return { source: "file" }; }
}
function _setExpPrj(v) { localStorage.setItem(_EXP_PRJ_KEY, JSON.stringify(v)); _updateMenuSubLabels(); }
function _setExpImg(v) { localStorage.setItem(_EXP_IMG_KEY, JSON.stringify(v)); _updateMenuSubLabels(); }
function _setImpImg(v) { localStorage.setItem(_IMP_IMG_KEY, JSON.stringify(v)); _updateMenuSubLabels(); }
function _updateMenuSubLabels() {
  const ep = _getExpPrj();
  const ei = _getExpImg();
  const ii = _getImpImg();
  const epEl = document.getElementById("menuExportProjectSub");
  const eiEl = document.getElementById("menuExportImageSub");
  const iiEl = document.getElementById("menuImportImageSub");
  if (epEl) epEl.textContent = "." + ep.format;
  if (eiEl) eiEl.textContent = `${ei.format.toUpperCase()} · ${ei.scope === "active" ? "当前层" : "合并"} · ${ei.target === "clipboard" ? "剪切板" : "文件"}`;
  if (iiEl) iiEl.textContent = `${ii.source === "clipboard" ? "剪切板" : "文件"} · 新图层`;
}
_updateMenuSubLabels();

els.menuExportProject.addEventListener("click", async () => {
  setMenuOpen(false);
  const { format } = _getExpPrj();
  try {
    if (format === "psd") {
      setStatus("PSD 编码中…", true);
      await exportPsdDownload(doc, `${_activeSessionName}.psd`);
      setStatus(".psd 已下载");
    } else {
      await exportOraDownload(doc, `${_activeSessionName}.ora`);
      setStatus(".ora 已下载");
    }
  } catch (e) { setStatus("导出失败：" + (e && e.message || e)); }
});
els.menuExportImage.addEventListener("click", async () => {
  setMenuOpen(false);
  const c = _getExpImg();
  try {
    if (c.target === "clipboard") {
      await copyImageToClipboard(doc, c.scope);
      setStatus(`已复制 PNG 到剪贴板（${c.scope === "active" ? "当前层" : "合并"}）`);
    } else {
      const r = await shareOrDownloadImage(doc, c.format, `${_activeSessionName}-${stampNow()}`, c.scope);
      setStatus(r.method === "share" ? "分享面板已开" : r.method === "cancel" ? "取消分享" : `${c.format.toUpperCase()} 已下载`);
    }
  } catch (e) { setStatus("导出失败：" + (e && e.message || e)); }
});
els.menuImportImage.addEventListener("click", async () => {
  setMenuOpen(false);
  const { source } = _getImpImg();
  if (source === "clipboard") {
    try {
      const blob = await readImageFromClipboard();
      if (!blob) { setStatus("剪贴板里没有图片"); return; }
      const fakeFile = new File([blob], "clipboard.png", { type: blob.type || "image/png" });
      await importImageAsLayer(fakeFile);
    } catch (e) { setStatus("从剪贴板粘贴失败：" + (e && e.message || e)); }
  } else {
    els.oraFileInput.value = "";
    els.oraFileInput.click();
  }
});

// v126 (user：「图层窗口的导入照片还是不灵」)
//   原本这里注册了第二个 click handler 重复触发 picker.click()，
//   双 click() 在 iPad Safari 上 picker 干脆不开。删掉；layerImportPhotoBtn
//   已在 line ~1788 通过 _openImagePicker 接管（含 _addImportAsNewDoc 复位）。

// 🔧 配置 popup（点开 / 点别处关）。setMenuOpen 不变，popup 嵌在 menu-item-row 里
function _openMenuConfigPopup(wrenchBtn, html, onApply) {
  // v124 toggle：再点同一个扳手就收回（user：「再按一下扳手应该收回」）
  const existing = wrenchBtn.closest(".menu-item-row")?.querySelector(".menu-config-popup");
  if (existing) { existing.remove(); return; }
  document.querySelectorAll(".menu-config-popup").forEach((el) => el.remove());
  const row = wrenchBtn.closest(".menu-item-row");
  if (!row) return;
  const popup = document.createElement("div");
  popup.className = "menu-config-popup";
  popup.innerHTML = html;
  row.appendChild(popup);
  const onPopupChange = () => onApply(popup);
  popup.addEventListener("change", onPopupChange);
  // popup 内点击不冒泡（让 menu 自身的「点外面关」别误把 popup 当外面）
  popup.addEventListener("click", (e) => e.stopPropagation());
  setTimeout(() => {
    function onDocClick(ev) {
      if (popup.contains(ev.target) || wrenchBtn.contains(ev.target)) return;
      popup.remove();
      document.removeEventListener("pointerdown", onDocClick, true);
    }
    document.addEventListener("pointerdown", onDocClick, true);
  }, 0);
}
els.menuExportProjectConfig.addEventListener("click", (e) => {
  e.stopPropagation();
  const c = _getExpPrj();
  _openMenuConfigPopup(e.currentTarget, `
    <div class="menu-config-section">
      <div class="menu-config-title">格式</div>
      <label><input type="radio" name="fmt" value="ora" ${c.format === "ora" ? "checked" : ""} /> .ora（推荐 / 开源）</label>
      <label><input type="radio" name="fmt" value="psd" ${c.format === "psd" ? "checked" : ""} /> .psd（Photoshop）</label>
    </div>
  `, (popup) => {
    const fmt = popup.querySelector('input[name="fmt"]:checked')?.value || "ora";
    _setExpPrj({ format: fmt });
  });
});
els.menuExportImageConfig.addEventListener("click", (e) => {
  e.stopPropagation();
  const c = _getExpImg();
  _openMenuConfigPopup(e.currentTarget, `
    <div class="menu-config-section">
      <div class="menu-config-title">格式</div>
      <label><input type="radio" name="fmt" value="png" ${c.format === "png" ? "checked" : ""} /> PNG</label>
      <label><input type="radio" name="fmt" value="jpg" ${c.format === "jpg" ? "checked" : ""} /> JPG</label>
    </div>
    <div class="menu-config-section">
      <div class="menu-config-title">范围</div>
      <label><input type="radio" name="scope" value="merged" ${c.scope === "merged" ? "checked" : ""} /> 合并所有可见层</label>
      <label><input type="radio" name="scope" value="active" ${c.scope === "active" ? "checked" : ""} /> 仅当前层</label>
    </div>
    <div class="menu-config-section">
      <div class="menu-config-title">去向</div>
      <label><input type="radio" name="tgt" value="file" ${c.target === "file" ? "checked" : ""} /> 文件</label>
      <label><input type="radio" name="tgt" value="clipboard" ${c.target === "clipboard" ? "checked" : ""} /> 剪切板</label>
    </div>
  `, (popup) => {
    const fmt = popup.querySelector('input[name="fmt"]:checked')?.value || "png";
    const tgt = popup.querySelector('input[name="tgt"]:checked')?.value || "file";
    const scope = popup.querySelector('input[name="scope"]:checked')?.value || "merged";
    _setExpImg({ format: fmt, target: tgt, scope });
  });
});
els.menuImportImageConfig.addEventListener("click", (e) => {
  e.stopPropagation();
  const c = _getImpImg();
  _openMenuConfigPopup(e.currentTarget, `
    <div class="menu-config-section">
      <div class="menu-config-title">来源</div>
      <label><input type="radio" name="src" value="file" ${c.source === "file" ? "checked" : ""} /> 文件</label>
      <label><input type="radio" name="src" value="clipboard" ${c.source === "clipboard" ? "checked" : ""} /> 剪切板</label>
    </div>
  `, (popup) => {
    const src = popup.querySelector('input[name="src"]:checked')?.value || "file";
    _setImpImg({ source: src });
  });
});
els.menuFit.addEventListener("click", () => {
  setMenuOpen(false);
  board.fitToScreen();
  updateZoomLabel();
  setStatus("适应屏幕");
});

// v109: 撤「笔刷平滑设置」浮动面板 —— 平滑参数 v99 起 per-preset，进 brush settings 调
// 删了：toggleBrushPanel / syncBrushPanelFromState / bindBrushSlider / brushPanelHead 拖动 handler
// menuBrushSettings element hidden 保兼容（HTML 不报 null），handler no-op
if (els.menuBrushSettings) els.menuBrushSettings.addEventListener("click", () => setMenuOpen(false));

// v147 旧液化设置面板（toggleLiquifyPanel / syncLiquifyPanelFromState / 拖拽 / change handlers）
// 已删：液化 v132 migrate 进 filterBrush，UI = toolbar variant 下拉 + 左栏 slider。

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
  // v154 参考窗吸色：eyedropper / 长按 → 吸窗内显示色，复用主吸色 setColor + pin
  getTool: () => editMode.current(),
  getLongPressPickEnabled: () => state.longPressPick,
  onColorSampled: (hex) => setColor(hex),
});
// v134 (user：「参考窗口大小可以调整」) iPad/touch resize handle
(function bindReferenceResize() {
  const handle = document.getElementById("referenceResizeHandle");
  const panel = els.referencePanel;
  if (!handle || !panel) return;
  let drag = null;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const rect = panel.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, w0: rect.width, h0: rect.height };
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const w = Math.max(160, Math.min(window.innerWidth - 40, drag.w0 + (e.clientX - drag.sx)));
    const h = Math.max(160, Math.min(window.innerHeight - 80, drag.h0 + (e.clientY - drag.sy)));
    panel.style.width = w + "px";
    panel.style.height = h + "px";
  });
  const endDrag = (e) => {
    if (drag && e.pointerId === drag.id) {
      try { handle.releasePointerCapture(e.pointerId); } catch {}
      drag = null;
      // 触发 reference 重新布局（如果需要）
      window.dispatchEvent(new CustomEvent("wp:referenceResize"));
    }
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
})();
// ---- 调色板小窗（v87）----
// 256×256 mixer canvas + 刷 / 涂 / 吸 3 工具。吸色 → 主画 setColor。
// 画布内容跟 doc 走（webpaint/state.json 持久化，跟 reference 同模式）
const paletteWindow = new PaletteWindow({
  root: document.getElementById("paletteWindow"),
  onColorSampled: (hex) => setColor(hex),
  getCurrentColor: () => state.color,
});
// 调色板小窗（v87 → v94 撤掉 menu 入口）：UI 已删，code 留 P2（backlog）

// ===== v158 平滑调参 dev 面板 =====
// 所有平滑魔数：连续用 textbox（可打任意数量级值 → 自测是否真起作用/跳出饱和区，杀煤气灯）、二元用 checkbox。
// live 改 SMOOTH + localStorage 持久化；下一笔生效。详 docs/stroke-smoother-time-gate.md。
const _SMOOTH_LABELS = {
  lookaheadCap: "窗口上限 W (screen px @ streamline=1)",
  dwellMs:      "dwell 时间门 T (ms)",
  smoothBoost:  "轻压平滑增益 (0=关, 1=轻按窗口×2)",
  deflate:      "内缩/毛笔甩尖 (开=0阶 / 关=保曲率)",
  vref:         "V_REF 旧四件套 (疑似对主笔刷无效)",
  rawStaticSq:  "raw 静止门限 (screen px²)",
  pressureAlpha:"压感 EMA α (0..1)",
};
let _smoothDevPanel = null;
function _refreshSmoothInputs(p) {
  for (const el of p.querySelectorAll("[data-skey]")) {
    const k = el.dataset.skey;
    if (el.type === "checkbox") el.checked = !!SMOOTH[k];
    else el.value = String(SMOOTH[k]);
  }
}
function _buildSmoothDevPanel() {
  const p = document.createElement("div");
  p.style.cssText = "position:fixed;right:12px;top:60px;z-index:300;background:var(--panel,#fff);color:var(--ink,#222);border:1px solid var(--line,#ccc);border-radius:10px;padding:12px 14px;font:12px/1.5 system-ui;box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:300px";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:8px";
  head.innerHTML = "<span>平滑调参 (dev)</span>";
  const close = document.createElement("button");
  close.textContent = "×";
  close.style.cssText = "border:none;background:none;font-size:18px;line-height:1;cursor:pointer;color:inherit";
  close.addEventListener("click", () => { p.style.display = "none"; });
  head.appendChild(close);
  p.appendChild(head);
  for (const k of Object.keys(SMOOTH_DEFAULTS)) {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:8px;margin:5px 0";
    const lbl = document.createElement("span");
    lbl.textContent = _SMOOTH_LABELS[k] || k;
    lbl.style.cssText = "flex:1";
    row.appendChild(lbl);
    if (typeof SMOOTH_DEFAULTS[k] === "boolean") {
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.dataset.skey = k; cb.checked = !!SMOOTH[k];
      cb.addEventListener("change", () => { SMOOTH[k] = cb.checked; saveSmooth(); });
      row.appendChild(cb);
    } else {
      const tb = document.createElement("input");
      tb.type = "text"; tb.inputMode = "decimal"; tb.dataset.skey = k; tb.value = String(SMOOTH[k]);
      tb.style.cssText = "width:74px;text-align:right;font:inherit";
      tb.addEventListener("change", () => {
        const v = parseFloat(tb.value);
        if (Number.isFinite(v)) { SMOOTH[k] = v; saveSmooth(); }
        else tb.value = String(SMOOTH[k]);
      });
      row.appendChild(tb);
    }
    p.appendChild(row);
  }
  const reset = document.createElement("button");
  reset.textContent = "重置默认";
  reset.style.cssText = "margin-top:8px;width:100%;padding:6px;cursor:pointer";
  reset.addEventListener("click", () => { resetSmooth(); _refreshSmoothInputs(p); setStatus("平滑参数已重置默认"); });
  p.appendChild(reset);
  const note = document.createElement("div");
  note.style.cssText = "margin-top:8px;color:var(--ink-soft,#888);font-size:11px";
  note.textContent = "textbox 可打任意数量级值。改完下一笔生效。×100 没变化 = 该参数对当前笔无效。";
  p.appendChild(note);
  document.body.appendChild(p);
  return p;
}
els.menuSmoothDev?.addEventListener("click", () => {
  setMenuOpen(false);
  if (!_smoothDevPanel) _smoothDevPanel = _buildSmoothDevPanel();
  const showing = _smoothDevPanel.style.display !== "none";
  _smoothDevPanel.style.display = showing ? "none" : "block";
  if (!showing) _refreshSmoothInputs(_smoothDevPanel);
});

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
  _brushRack = makeDefaultRack({ resetAt: Date.now() });   // v2: 恢复出厂 = resetAt watermark（跨设备 merge 也清掉旧自定义笔）
  // 重置所有 toolStates 的 activeBrushId 让 applyToolState 重选默认
  for (const t of Object.keys(state.toolStates)) {
    state.toolStates[t].activeBrushId = null;
    Object.assign(state.toolStates[t], defaultToolStateFor(t));
  }
  await persistBrushRack();
  applyToolState(editMode.current());
  // 若 rack sheet 当前开着 → 强制刷一遍
  if (RACK_PANEL_BY_TOOL[editMode.current()] === getCurrentExclusive()) _renderRackSheet();
  setRackDirty(true);
  if (isSignedIn()) pushBrushRackIfSignedIn();
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
    const decoded = await decodeImageFile(file);          // C：鲁棒解码（修 Windows createImageBitmap 失效）
    const REF_MAX = 2048;                                 // B：参考图最大边（≈2048² 面积上限）
    const fit = fitWithin(decoded, REF_MAX, REF_MAX);     // 超了 step-halving 缩小
    // 缩了就存缩小后的 PNG（省 .ora 体积）；没缩存原文件 Blob
    const persistBlob = fit.scaled ? await canvasToBlob(fit.source) : file;
    referenceWindow.setBitmap(fit.source, { persistBlob });
    if (fit.scaled) decoded.close?.();                    // 缩放后原 bitmap 没用了，释放
    _store.edits.mark();
    updateSaveStatus();
    window.dispatchEvent(new CustomEvent("wp:histchange", { detail: { canUndo: input.canUndo(), canRedo: input.canRedo() } }));
    setStatus(`参考：${file.name}${fit.scaled ? `（已缩到 ${fit.w}×${fit.h}）` : ""}（会跟当前画一起保存）`);
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
  const bitmap = await decodeImageFile(file);
  const w = Math.min(8192, bitmap.width);
  const h = Math.min(8192, bitmap.height);
  if (_store.edits.localDirty()) await saveNow();
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
  // 超 8192 缩小走 step-halving 抗锯齿；否则原样画
  const src = (w < bitmap.width || h < bitmap.height) ? smartResample(bitmap, w, h) : bitmap;
  layer.ctx.drawImage(src, 0, 0, w, h);
  bitmap.close?.();
  applyCheckerboard(false);    // v125: 导入新作品默认关棋盘
  const stem = file.name.replace(/\.[^.]+$/, "") || "导入";
  const name = await uniqueLocalName(stem);
  _activeSessionName = name;
  setCurrentSessionName(name);
  input.clearHistory();
  board.invalidateAll();
  board.fitToScreen();
  renderLayersPanel();
  _store.edits.mark();
  _docLastSavedAt = 0;
  updateSaveStatus();
  await saveNow();
  // v133 revert checkpoint
  _sessionOpenedAt = Date.now();
  _writeSessionCheckpoint(name).catch((e) => console.warn("[revert] photo-import checkpoint:", e));
  setStatus(`新建（照片）：${name}（${w}×${h}）`);
}

// 把图片当一个新图层叠进当前 doc（photobash / 参考图工作流）。
// 居中对齐；如果图片比 doc 大，按比例缩到 80% 短边，避免一上来就盖死。
// v134 big-import sheet：图片 > 画布 弹询问
//   resolve { w, h, mode } 或 null（取消）
function _openBigImportSheet(ow, oh, docW, docH) {
  const backdrop = document.getElementById("bigImportBackdrop");
  const sheet = document.getElementById("bigImportSheet");
  const wIn = document.getElementById("bigImportW");
  const hIn = document.getElementById("bigImportH");
  const modeSel = document.getElementById("bigImportMode");
  const info = document.getElementById("bigImportInfo");
  const okBtn = document.getElementById("bigImportConfirm");
  const cancelBtn = document.getElementById("bigImportCancel");
  // fit-to-canvas（保比例 = 短边贴齐）
  const scale = Math.min(docW / ow, docH / oh);
  const fitW = Math.round(ow * scale);
  const fitH = Math.round(oh * scale);
  info.textContent = `图片 ${ow}×${oh} · 画布 ${docW}×${docH}`;
  wIn.value = String(fitW);
  hIn.value = String(fitH);
  // 默认 fit choice
  for (const r of sheet.querySelectorAll('input[name="bigImportChoice"]')) {
    r.checked = (r.value === "fit");
  }
  // W/H input 联动（锁宽高比，由当前 ow/oh 决定）
  const aspect = ow / oh;
  const setChoice = (val) => {
    for (const r of sheet.querySelectorAll('input[name="bigImportChoice"]')) {
      r.checked = (r.value === val);
    }
    if (val === "fit") { wIn.value = String(fitW); hIn.value = String(fitH); }
    else if (val === "keep") { wIn.value = String(ow); hIn.value = String(oh); }
  };
  wIn.oninput = () => {
    setChoice("custom");
    const v = parseFloat(wIn.value) | 0;
    if (v > 0) hIn.value = String(Math.max(1, Math.round(v / aspect)));
  };
  hIn.oninput = () => {
    setChoice("custom");
    const v = parseFloat(hIn.value) | 0;
    if (v > 0) wIn.value = String(Math.max(1, Math.round(v * aspect)));
  };
  for (const r of sheet.querySelectorAll('input[name="bigImportChoice"]')) {
    r.addEventListener("change", () => setChoice(r.value));
  }
  backdrop.classList.remove("hidden");
  sheet.classList.remove("hidden");
  return new Promise((resolve) => {
    const cleanup = () => {
      backdrop.classList.add("hidden");
      sheet.classList.add("hidden");
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      backdrop.onclick = null;
    };
    okBtn.onclick = () => {
      const w = Math.max(1, Math.min(8192, parseFloat(wIn.value) | 0));
      const h = Math.max(1, Math.min(8192, parseFloat(hIn.value) | 0));
      const mode = modeSel.value || "bicubic";
      cleanup();
      resolve({ w, h, mode });
    };
    cancelBtn.onclick = () => { cleanup(); resolve(null); };
    backdrop.onclick  = () => { cleanup(); resolve(null); };
  });
}

async function importImageAsLayer(file, opts = {}) {
  const bitmap = await decodeImageFile(file);
  const ow = bitmap.width, oh = bitmap.height;
  const docW = doc.width, docH = doc.height;
  // v134 (user：「导入超大图片弹 sheet」) bitmap 比 doc 大 → 询问 fit / 保原 / 自定义
  let w = ow, h = oh, imgSmoothing = "high";
  if (ow > docW || oh > docH) {
    const choice = await _openBigImportSheet(ow, oh, docW, docH);
    if (!choice) { bitmap.close?.(); return; }   // user 取消
    w = choice.w; h = choice.h;
    imgSmoothing = choice.mode === "nearest" ? "low" : "high";
  }
  // 新建空层
  const layer = doc.addLayer(file.name.replace(/\.[^.]+$/, ""));
  if (!layer) {
    bitmap.close?.();
    setStatus(`图层已达上限 (${doc.maxLayers})，无法导入`);
    return;
  }
  // bbox 中心：默认 doc 中心；opts.center（doc 坐标）可指定（Ctrl+V 传视口中心）
  const ccx = opts.center?.x ?? docW / 2;
  const ccy = opts.center?.y ?? docH / 2;
  layer.bboxX = Math.floor(ccx - w / 2);
  layer.bboxY = Math.floor(ccy - h / 2);
  layer.bboxW = w;
  layer.bboxH = h;
  const c = (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(w, h)
    : (() => { const x = document.createElement("canvas"); x.width = w; x.height = h; return x; })();
  layer.canvas = c;
  layer.ctx = c.getContext("2d", { willReadFrequently: false });
  layer.ctx.imageSmoothingEnabled = imgSmoothing !== "low";
  layer.ctx.imageSmoothingQuality = imgSmoothing;
  // 缩小且非 nearest（像素画保持硬边）→ step-halving 抗锯齿；否则原样画
  const lsrc = (imgSmoothing !== "low" && (w < ow || h < oh)) ? smartResample(bitmap, w, h) : bitmap;
  layer.ctx.drawImage(lsrc, 0, 0, w, h);
  bitmap.close?.();
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
  _store.edits.mark();
  updateSaveStatus();
  // 触发 wp:histchange 让保存状态同步
  window.dispatchEvent(new CustomEvent("wp:histchange", { detail: { canUndo: input.canUndo(), canRedo: input.canRedo() } }));

  // v111: 自动 lift 全图入 transform（user：「导入图片到图层之后自动全选图片进入 transform 模式」）
  try {
    const sel = _makeFullLayerSelection(layer);
    if (sel) {
      doc.selection = sel;
      setTool("lasso");
      const ok = input.lasso.liftSelectionForTransform(layer);
      if (ok) {
        editMode.enterTransient("transform", { apply: _commitTransform, abort: _cancelTransform });
        input.lasso.setMode("free");
        updateLassoToolbar();
        _suppressTransientPanels("transform");
        board.invalidateAll();
        setStatus(`已导入：${file.name}（拖角变换 → 应用 / 取消）`);
        return;
      }
    }
  } catch (e) { console.warn("[import auto-transform]", e); }
  setStatus(`已导入为新图层：${file.name}`);
}

// v111: 给 layer 当前 bbox 做一个全白 mask 当 selection（占满整个 layer 像素）
function _makeFullLayerSelection(layer) {
  return Selection.full(layer.bboxW, layer.bboxH, layer.bboxX, layer.bboxY);
}

// ---- 图库 全屏（v50 重做：无返回键、底栏 IDB 占用 + 清扫、加号 popup、云图标 popup） ----
// 进入和退出都触发 saveNow。进入后把主画布 UI 全 disable（body[data-mode="gallery"]）。
// 退出 = 点 active tile，或选择另一个 tile / 新建 / 导入照片 / 拉云图。
let _galleryUrls = [];
let _galleryThumbObserver = null;
let _galleryThumbInflight = new Set();   // itemId in-flight，去重
let _galleryDownloadUrls = new Map();    // itemId → @microsoft.graph.downloadUrl（listChildren 带回，1h 有效）
let _galleryView = "files";              // "files" | "trash"

// ===== 子文件夹 state =====
// 当前浏览的 folder（"" = 根；"characters" / "characters/side" = 嵌套）
// 跨 refresh 持久化，进 gallery 时不重置（用户期望停留上次位置）
const LS_GALLERY_FOLDER = "webpaint.galleryFolder";
let _galleryFolder = "";
try { _galleryFolder = localStorage.getItem(LS_GALLERY_FOLDER) || ""; } catch {}
function setGalleryFolder(path) {
  _galleryFolder = path || "";
  try { localStorage.setItem(LS_GALLERY_FOLDER, _galleryFolder); } catch {}
}
// 空文件夹模型：**云端真文件夹为准**（OneDrive 上 ensureSubfolder 建的真文件夹，listCloudFolders
// 带回，含空的）。删掉了旧的 localStorage explicitFolders 旁路——它和真 fs 漂移，是「半残文件夹」。
// 代价：未登录/离线时建不了纯本地空文件夹（无处持久化）；但本地作品本就要登录才上云，可接受。
// 本次渲染拿到的云端真文件夹路径（renderGallery 填，_renderFolderTile / 空判用）。
let _galleryCloudFolders = [];
// path utils
function pathFolder(name) {
  const i = name.lastIndexOf("/");
  return i < 0 ? "" : name.slice(0, i);
}
function pathBasename(name) {
  const i = name.lastIndexOf("/");
  return i < 0 ? name : name.slice(i + 1);
}
function pathJoin(folder, name) {
  if (!folder) return name;
  if (!name) return folder;
  return `${folder}/${name}`;
}

// gallery-first 设计：删 / 卸载 active session 后，**进 gallery**（不创建新空白 doc）。
// _activeSessionName 设 null = 未绑定任何 session；画布 hidden。
// 用户在 gallery 选别的 / 新建 / 关 → 重新绑定。
async function _exitCanvasToGallery() {
  // 点退 gallery = explicit consent save：本地 + 云端一起推
  // user：「这样少一些用户心智负担」—— 不需要先 Ctrl+S 再退
  if (_activeSessionName) {
    await withBusy(`正在保存 ${_activeSessionName}…`, async () => {
      try { await saveAndPush(); } catch (e) { console.warn("[exit-to-gallery] save failed:", e); }
    });
    // 退到 gallery 停在 active session 所在 folder（连贯感）
    setGalleryFolder(pathFolder(_activeSessionName));
  }
  _activeSessionName = null;
  setCurrentSessionName("");
  _store.edits.markSaved();
  _isLazyBlankSession = false;
  updateSaveStatus();
  await setGalleryOpen(true);
}

// gallery-first 设计：用 _activeSessionName == null 区分 gallery 状态。
// localStorage.webpaint.currentSessionName 真实持久化 active session name；
// 空字符串 = "在 gallery 没绑定任何画作"，refresh 后停 gallery。

// 系统 popup menu helper：anchor 下方 / 右对齐定位 + 高 z-index + outside-click 关闭。
// 用 fixed 定位（脱离父 container 限制），z-index 200 永远 > 所有 modal。
// 避免每个 popup 个别调 z-index / position。
const _openPopups = new WeakSet();
function openAnchoredPopup(popupEl, anchorEl, { alignRight = true, offsetY = 4 } = {}) {
  if (!popupEl || !anchorEl) return;
  const rect = anchorEl.getBoundingClientRect();
  popupEl.style.position = "fixed";
  popupEl.style.top = (rect.bottom + offsetY) + "px";
  if (alignRight) {
    popupEl.style.right = (window.innerWidth - rect.right) + "px";
    popupEl.style.left = "auto";
  } else {
    popupEl.style.left = rect.left + "px";
    popupEl.style.right = "auto";
  }
  popupEl.style.zIndex = "200";
  popupEl.classList.remove("hidden");
  _openPopups.add(popupEl);
  // outside click 关闭（一帧后挂，避免本次 click 立刻关）
  const handler = (e) => {
    if (popupEl.contains(e.target) || anchorEl.contains(e.target)) return;
    closeAnchoredPopup(popupEl);
    document.removeEventListener("click", handler, true);
  };
  setTimeout(() => document.addEventListener("click", handler, true), 0);
}
function closeAnchoredPopup(popupEl) {
  if (!popupEl) return;
  popupEl.classList.add("hidden");
  _openPopups.delete(popupEl);
}
function toggleAnchoredPopup(popupEl, anchorEl, opts) {
  if (_openPopups.has(popupEl)) closeAnchoredPopup(popupEl);
  else openAnchoredPopup(popupEl, anchorEl, opts);
}

// withBusy: 长 op 包装 → 全屏 spinner + 防误点 + 报状态。统一所有 trash/rename/卸载 等长操作。
async function withBusy(label, fn) {
  showFullscreenBusy(label);
  try { return await fn(); }
  finally { hideFullscreenBusy(); }
}

// 等云端 push 完成。push 进行中点进图库可能 race（status 报错给错 session 名 / sync-gate sheet 错位）
async function _awaitCloudPushIdle() {
  if (!_cloudPushing) return;
  showFullscreenBusy("正在同步到云端…");
  try {
    while (_cloudPushing) await new Promise((r) => setTimeout(r, 80));
  } finally { hideFullscreenBusy(); }
}

async function setGalleryOpen(open) {
  if (open) {
    // 进图库 = 用户离开编辑场景 → apply 所有 pending transient（套索浮层等）+ 保存
    editMode.applyPendingTransient();
    if (_store.edits.localDirty() && !_docSaving) await saveNow();
    await _awaitCloudPushIdle();   // 等 cloud push 完，防 status race
    document.body.dataset.mode = "gallery";
    els.galleryFull.classList.remove("hidden");
    _galleryView = "files";     // 每次进默认 files 视图（避免上次留在 trash 里的混乱）
    if (els.galleryEmpty) els.galleryEmpty.textContent = "还没有保存的作品。点右上加号新建一个，或先在 PC 上画一笔。";
    renderGallery();
    updateIdbUsage();
  } else {
    editMode.applyPendingTransient();
    if (_store.edits.localDirty() && !_docSaving) await saveNow();
    els.galleryFull.classList.add("hidden");
    delete document.body.dataset.mode;
    for (const u of _galleryUrls) URL.revokeObjectURL(u);
    _galleryUrls = [];
    // 关闭可能打开的 popup
    els.galleryAddPopup.classList.add("hidden");
    els.cloudAccountPopup.classList.add("hidden");
    els.galleryMenuPopup?.classList.add("hidden");
    board.requestRender();
  }
}

// 加号 popup
// (galleryCloseBtn 已删除 gallery-first，无 close-back-to-canvas 按钮)
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
// 图库菜单 popup（版本号 + 强制更新 + 文件无关设置）
els.galleryMenuBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const hidden = els.galleryMenuPopup.classList.contains("hidden");
  els.galleryAddPopup.classList.add("hidden");
  els.cloudAccountPopup.classList.add("hidden");
  els.galleryMenuPopup.classList.toggle("hidden", !hidden);
  if (hidden) anchorPopupToBtn(els.galleryMenuPopup, els.galleryMenuBtn);
  els.galleryMenuBtn.setAttribute("aria-expanded", hidden ? "true" : "false");
});
// 动作代理到主菜单已有 handler（.click() 即触发，无需主菜单可见）——不重复逻辑/状态。
els.galleryMenuForceUpdate?.addEventListener("click", () => {
  els.galleryMenuPopup.classList.add("hidden");
  els.menuForcePwaReset?.click();
});
els.galleryMenuTheme?.addEventListener("click", () => {
  els.galleryMenuPopup.classList.add("hidden");
  els.menuTheme?.click();
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
  if (els.galleryMenuPopup && !els.galleryMenuPopup.classList.contains("hidden") &&
      !els.galleryMenuPopup.contains(e.target) &&
      !els.galleryMenuBtn.contains(e.target)) {
    els.galleryMenuPopup.classList.add("hidden");
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

// + 新建文件夹（云端真文件夹为准：在 OneDrive 上建真文件夹，需登录+在线）
els.addNewFolder?.addEventListener("click", async () => {
  els.galleryAddPopup.classList.add("hidden");
  // 文件夹模型「云端真文件夹为准」→ 必须登录+在线才能建（否则无处持久化空文件夹）
  if (!isSignedIn() || navigator.onLine === false) {
    setStatus("新建文件夹需先登录云端（空文件夹存在 OneDrive 上）", true);
    return;
  }
  const stem = await openInputSheet("新建文件夹", "新文件夹", { placeholder: "文件夹名" });
  if (stem == null) return;
  const trimmed = stem.trim();
  if (!trimmed) { setStatus("文件夹名不能空", true); return; }
  if (trimmed.includes("/")) { setStatus("文件夹名不能含 /（要建嵌套请进对应文件夹再点新建）", true); return; }
  const fullPath = pathJoin(_galleryFolder, trimmed);
  // 已存在 check（本地+云的 item 派生 + 云端真文件夹）
  let allNames = [], cloudFolders = [];
  try { allNames = allNames.concat((await listSessions()).map(s => s.name)); } catch {}
  try {
    const all = await listCloudAll();
    allNames = allNames.concat(all.files.map(c => c.path.replace(/\.ora$/i, "")));
    cloudFolders = all.folders;
  } catch (e) { console.warn("[folder] cloud list failed:", e); }
  const fullPrefix = `${fullPath}/`;
  const exists = allNames.some(n => n === fullPath || n.startsWith(fullPrefix)) || cloudFolders.includes(fullPath);
  if (exists) { setStatus(`文件夹 "${trimmed}" 已存在`, true); return; }
  await withBusy(`正在创建文件夹 ${trimmed}…`, async () => {
    try { await ensureSubfolder(fullPath); setStatus(`已建文件夹：${trimmed}`); }
    catch (e) { console.warn("[folder] cloud ensure failed:", e); setStatus("建文件夹失败：" + (e && e.message || e), true); }
  });
  renderGallery();
});
let _addImportAsNewDoc = false;

// 新建作品 sheet
// 日期戳 yyyymmdd（取代"未命名"；user）。
function _todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
// 下一个可用名：yyyymmdd / yyyymmdd-2 / yyyymmdd-3 …（查本地+云重名自动避让，顺带解决"重名没 detect"）。
async function _nextDocName(folder) {
  const base = _todayStamp();
  const names = new Set();
  try { (await listSessions()).forEach((s) => names.add(s.name)); } catch {}
  if (isSignedIn() && navigator.onLine !== false) {
    try { (await listCloudSessionsRecursive()).forEach((c) => names.add(c.path.replace(/\.ora$/i, ""))); } catch {}
  }
  const full = (n) => (folder ? `${folder}/${n}` : n);
  if (!names.has(full(base))) return base;
  for (let i = 2; i < 1000; i++) if (!names.has(full(`${base}-${i}`))) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}
async function openNewDocSheet() {
  els.newDocName.value = _galleryFolder ? `${_galleryFolder}/…` : "…";   // 占位，下面 async 填日期名
  els.newDocPreset.value = "2048";
  els.newDocCustomRow.style.display = "none";
  els.newDocW.value = doc.width;
  els.newDocH.value = doc.height;
  els.newDocBackdrop.classList.remove("hidden");
  els.newDocSheet.classList.remove("hidden");
  // yyyymmdd-N（避让本地+云重名）。folder 前缀保留（落当前子文件夹）。
  const next = await _nextDocName(_galleryFolder);
  els.newDocName.value = _galleryFolder ? `${_galleryFolder}/${next}` : next;
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
    w = Math.max(16, Math.min(8192, parseInt(els.newDocW.value, 10) || 2048));
    h = Math.max(16, Math.min(8192, parseInt(els.newDocH.value, 10) || 2048));
  } else {
    // v163：preset value 改成 "W×H"（支持非正方形 / 像素画 / 纸张比例）
    const parts = String(els.newDocPreset.value).split("x");
    w = Math.max(16, Math.min(8192, parseInt(parts[0], 10) || 2048));
    h = Math.max(16, Math.min(8192, parseInt(parts[1], 10) || w));
  }
  const name = await uniqueLocalName(nameRaw);
  closeNewDocSheet();
  if (_store.edits.localDirty()) await saveNow();
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
  _store.edits.mark();
  _docLastSavedAt = 0;
  updateSaveStatus();
  // user：「新建作品时参考里面的图没更新」→ 清 reference 小窗
  referenceWindow.clearBitmap();
  applyCheckerboard(false);    // v125: 新建 doc 棋盘 reset 关
  // user (gallery-first)：新画布 color 默认黑（笔刷态保持，user 只 reset 色）
  setColor("#000000");
  await saveNow();
  // v133 revert checkpoint：新建后 = 空白 doc 状态
  _sessionOpenedAt = Date.now();
  _writeSessionCheckpoint(name).catch((e) => console.warn("[revert] new-doc checkpoint:", e));
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
  if (_galleryThumbObserver) { _galleryThumbObserver.disconnect(); _galleryThumbObserver = null; }
  _galleryThumbInflight.clear();
  _galleryDownloadUrls.clear();

  // trash 视图独立渲染
  els.galleryTrashBar?.classList.toggle("hidden", _galleryView !== "trash");
  els.galleryAddBtn?.classList.toggle("hidden", _galleryView === "trash");
  els.galleryTrashBtn?.classList.toggle("hidden", _galleryView === "trash");
  // 占位"加载中" sync 显示 → 防 user 看到旧 tiles 一会儿
  els.galleryGrid.innerHTML = '<div class="gallery-loading">加载中…</div>';
  els.galleryGrid.style.display = "";
  els.galleryEmpty.classList.add("hidden");
  if (_galleryView === "trash") {
    return await renderTrashView();
  }

  // listSessions 在 IDB 被禁（隐私窗口 / 配额耗尽 / 浏览器策略）时会抛。
  // 这时图库没法用是合理结果，但要给个明确状态消息（原代码静默死掉）。
  let local = [];
  try { local = await listSessions(); }
  catch (e) {
    console.error("[gallery] listSessions failed:", e);
    setStatus("本地图库读取失败：" + (e && e.message || e) + "（可能是隐私窗口 / IDB 被禁）", true);
  }
  // 云端：仅在登录 + 在线 时尝试。一次 listCloudAll 同时拿文件 + 真文件夹（含空），省一半往返。
  // navigator.onLine === false 几乎确定离线，跳网络省超时。
  let cloud = [];
  _galleryCloudFolders = [];
  if (isSignedIn() && navigator.onLine !== false) {
    try { const all = await listCloudAll(); cloud = all.files; _galleryCloudFolders = all.folders; }
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
  const allItems = [...byName.values()];

  // ====== 子文件夹切片 ======
  // 取 _galleryFolder prefix 之内的 items；按"剩余路径含 /"分 folder vs file
  const prefix = _galleryFolder ? `${_galleryFolder}/` : "";
  const folderSet = new Set();    // 当前层 immediate sub-folder name
  const filesInFolder = [];        // 当前层 direct child files
  for (const it of allItems) {
    if (_galleryFolder && !it.name.startsWith(prefix)) continue;
    const rest = it.name.slice(prefix.length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx >= 0) {
      folderSet.add(rest.slice(0, slashIdx));
    } else if (rest) {
      filesInFolder.push(it);
    }
  }
  // 云端真文件夹（含空）—— 文件夹模型单一真相源（取代旧 explicitFolders 旁路）。
  for (const f of _galleryCloudFolders) {
    if (_galleryFolder) {
      if (f === _galleryFolder || !f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const seg = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
      if (seg) folderSet.add(seg);
    } else {
      const first = f.split("/")[0];
      if (first) folderSet.add(first);
    }
  }
  filesInFolder.sort((a, b) => {
    const ta = (a.local?.updatedAt) || Date.parse(a.cloud?.lastModifiedDateTime || 0);
    const tb = (b.local?.updatedAt) || Date.parse(b.cloud?.lastModifiedDateTime || 0);
    return tb - ta;
  });
  const folderNames = [...folderSet].sort((a, b) => a.localeCompare(b));

  // ====== Breadcrumb ======
  _renderBreadcrumb();

  els.galleryGrid.innerHTML = "";
  if (folderNames.length === 0 && filesInFolder.length === 0) {
    els.galleryEmpty.classList.remove("hidden");
    els.galleryEmpty.textContent = _galleryFolder
      ? `文件夹 "${_galleryFolder}" 是空的`
      : "还没有保存的作品。点右上加号新建一个，或先在 PC 上画一笔。";
    els.galleryGrid.style.display = "none";
    return;
  }
  els.galleryEmpty.classList.add("hidden");
  els.galleryGrid.style.display = "";

  // ====== Folder tiles 先（字母序） ======
  for (const folderName of folderNames) {
    const folderPath = pathJoin(_galleryFolder, folderName);
    // 是否为空：没有 item 也没有子文件夹以这 path 为 prefix（非空时禁删，避免级联）
    const fullPrefix = `${folderPath}/`;
    const hasItems = allItems.some((it) => it.name.startsWith(fullPrefix))
      || _galleryCloudFolders.some((f) => f.startsWith(fullPrefix));
    _renderFolderTile(folderName, folderPath, hasItems);
  }

  for (const item of filesInFolder) {
    const isLocal = !!item.local;
    const isCloud = !!item.cloud;
    const tile = document.createElement("div");
    // gallery-first：进 gallery 时 _activeSessionName 应该 null，所以不会有 active 框
    tile.className = "gallery-tile";

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
        // 云朵 placeholder + 标记，IntersectionObserver 进视口才拉
        thumbEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:48px;height:48px;"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
        thumbEl.dataset.cloudItemId = item.cloud.id;
        thumbEl.dataset.cloudEtag = item.cloud.eTag || "";
        thumbEl.dataset.cloudSize = String(item.cloud.size || 0);
        thumbEl.dataset.cloudName = item.name;
        // listChildren 带回的 downloadUrl 存模块 Map（dataset 放 URL 太长）
        const dl = item.cloud["@microsoft.graph.downloadUrl"];
        if (dl) _galleryDownloadUrls.set(item.cloud.id, dl);
      } else {
        thumbEl.textContent = (item.name.slice(0, 1) || "?");
      }
    }
    tile.appendChild(thumbEl);

    const signedIn = isSignedIn();

    // 名字 + 备注（第 1 行 name ellipsis；第 2 行 状态·时间·大小，淡色）
    const nameRow = document.createElement("div");
    nameRow.className = "gallery-tile-name-row";
    const nm = document.createElement("div");
    nm.className = "gallery-tile-name";
    nm.textContent = pathBasename(item.name);   // 在子文件夹下只显示 basename
    nm.title = item.name;                       // 完整路径走 tooltip
    nameRow.appendChild(nm);
    const meta = document.createElement("div");
    meta.className = "gallery-tile-meta";
    const t = (item.local?.updatedAt) || Date.parse(item.cloud?.lastModifiedDateTime || 0);
    const sz = (item.local?.size) || item.cloud?.size || 0;
    // 状态 icon (4 态)：
    //   本地 only：HDD
    //   云端 only：cloud
    //   本地+云已同步：cloud + check
    //   本地+云有未推改动：cloud + ↑  (autosave 只 IDB，没推云的临时态)
    let stateIcon, stateTitle;
    if (isLocal && isCloud) {
      if (signedIn && isCloudDirty(item.name)) {
        stateIcon = ICON_CLOUD_PENDING; stateTitle = "本地+云端 · 本地有未推改动（点退 gallery 自动推）";
      } else {
        stateIcon = ICON_CLOUD_SYNCED; stateTitle = "本地+云端（已同步）";
      }
    } else if (isCloud) {
      stateIcon = ICON_CLOUD_SOLID; stateTitle = "纯云端（未拉到本地）";
    } else if (isLocal && signedIn) {
      stateIcon = ICON_LOCAL; stateTitle = "仅本地（未上传云端）";
    } else {
      stateIcon = ICON_LOCAL; stateTitle = "本地";
    }
    const stateIconEl = document.createElement("span");
    stateIconEl.className = "gallery-tile-state-icon";
    stateIconEl.innerHTML = stateIcon;
    stateIconEl.title = stateTitle;
    meta.appendChild(stateIconEl);
    const metaText = document.createElement("span");
    metaText.textContent = `${humanTime(t)} · ${humanSize(sz)}`;
    meta.appendChild(metaText);
    nameRow.appendChild(meta);
    tile.appendChild(nameRow);

    // ⋯ 菜单按钮叠在 thumb 右上 + 弹出菜单
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "gallery-tile-menu-btn";
    menuBtn.setAttribute("aria-label", "更多操作");
    menuBtn.textContent = "⋯";
    tile.appendChild(menuBtn);

    const popup = document.createElement("div");
    popup.className = "gallery-tile-menu-popup hidden";

    function addAction(label, handler, opts = {}) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      if (opts.danger) b.className = "danger";
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        popup.classList.add("hidden");
        await handler();
      });
      popup.appendChild(b);
    }

    addAction("重命名", async () => {
      // active session 走 renameCurrentSession（已含云端同步）
      if (item.name === _activeSessionName) {
        const newName = await renameCurrentSession();
        if (newName && newName !== item.name) {
          setStatus(`已重命名：${item.name} → ${newName}`);
          renderGallery();
        } else if (newName === item.name) {
          setStatus("名字未变");
        }
        return;
      }
      const input = await openInputSheet("重命名", item.name, { placeholder: "新名字" });
      if (input == null) { setStatus("已取消"); return; }
      const trimmed = input.trim();
      if (!trimmed) { setStatus("名字不能空", true); return; }
      if (trimmed === item.name) { setStatus("名字未变"); return; }
      // 冲突检查：本地 + 云端都不能撞名
      const localNames = new Set((await listSessions()).map(s => s.name));
      if (localNames.has(trimmed)) { setStatus(`本地已有同名 "${trimmed}"，换一个`, true); return; }
      if (isCloud) {
        try {
          const cloudList = await listCloudSessionsRecursive();
          const cloudNames = new Set(cloudList.map(c => c.path.replace(/\.ora$/i, "")));
          if (cloudNames.has(trimmed)) { setStatus(`云端已有同名 "${trimmed}"，换一个`, true); return; }
        } catch (e) { console.warn("[rename] 云端列表失败:", e); }
      }
      // 干活全交给 store.flow.rename（机制在库内）：本地先存新名再删旧名（phantom-path 红线）；
      // 云端 synced→服务端 move 保 etag、dirty→push 新+trash 旧。cloud:isCloud 让纯本地 item 不误传云端。
      await withBusy(`正在重命名 ${item.name} → ${trimmed}…`, async () => {
        try {
          const res = await _store.flow.rename(item.name, trimmed, { cloud: isCloud });
          if (res.cloudDeferred) setStatus(`已重命名（云端稍后重试）：${item.name} → ${trimmed}`);
          else setStatus(`已重命名：${item.name} → ${trimmed}`);
        } catch (e) {
          setStatus(`重命名失败：${e && e.message || e}`, true);
        }
      });
      renderGallery();
    });

    // 移动到…（取代拖拽：iPad 触屏 drag-drop 不可靠 → 卡片菜单选目标文件夹）。
    // 移动 = 跨文件夹 rename：lib rename 同folder→PATCH名，跨folder→ensureFolder+move（同 GUID，无副本，ADR-0011）。
    addAction("移动到…", async () => {
      const curFolder = pathFolder(item.name);
      const base = pathBasename(item.name);
      // 候选目标 = 所有已知文件夹（云端真文件夹 + item 派生的各级祖先）+ 根目录，排掉当前所在。
      const folders = new Set(_galleryCloudFolders);
      folders.add("");  // 根目录
      for (const it of allItems) {
        const parts = it.name.split("/");
        let acc = "";
        for (let i = 0; i < parts.length - 1; i++) { acc = acc ? `${acc}/${parts[i]}` : parts[i]; folders.add(acc); }
      }
      folders.delete(curFolder);
      const sorted = [...folders].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
      if (sorted.length === 0) { setStatus("没有别的文件夹可移（先新建一个）"); return; }
      const actions = sorted.map((f) => ({ label: f === "" ? "/ 根目录" : f, value: f }));
      actions.push({ label: "✕ 取消", value: "__cancel__" });
      const target = await lockSyncGate({ title: `移动「${base}」到…`, message: "选择目标文件夹", showSpinner: false, actions });
      if (target == null || target === "__cancel__") return;
      const newName = pathJoin(target, base);
      if (newName === item.name) { setStatus("已在该文件夹"); return; }
      // 冲突检查：目标文件夹下不能撞名（本地 + 云端）
      const localNames = new Set((await listSessions()).map((s) => s.name));
      if (localNames.has(newName)) { setStatus(`目标已有同名「${base}」，先改名`, true); return; }
      if (isCloud) {
        try {
          const cloudNames = new Set((await listCloudSessionsRecursive()).map((c) => c.path.replace(/\.ora$/i, "")));
          if (cloudNames.has(newName)) { setStatus(`云端目标已有同名「${base}」`, true); return; }
        } catch (e) { console.warn("[move] 云端列表失败:", e); }
      }
      // 移动 = 跨文件夹 rename，走 store.flow.rename（同 GUID、保 etag/红线，机制在库内）。
      await withBusy(`正在移动 ${base} → ${target || "根目录"}…`, async () => {
        try {
          const res = await _store.flow.rename(item.name, newName, { cloud: isCloud });
          // active session 跟着改名（否则后续保存写错路径）
          if (item.name === _activeSessionName) { _activeSessionName = newName; setCurrentSessionName(newName); }
          if (res.cloudDeferred) setStatus(`已移动（云端稍后重试）：${target || "根目录"}`);
          else setStatus(`已移动到：${target || "根目录"}`);
        } catch (e) {
          setStatus(`移动失败：${e && e.message || e}`, true);
        }
      });
      renderGallery();
    });

    // 拉取/推送/卸载（按状态，3 选 1 或者没有）
    if (isCloud && !isLocal) {
      addAction("拉取到本地", async () => {
        // pullCloudPath 自带 fullscreen busy + 自动 adopt
        await pullCloudPath(item.cloud.path);
      });
    } else if (isLocal && !isCloud && signedIn) {
      addAction("推送到云端", async () => {
        await withBusy(`正在推送 ${item.name} 到云端…`, async () => {
          try {
            const loaded = await openSession(item.name);
            if (!loaded) throw new Error("找不到本地 session");
            // 走 store.flow.push：拿到 B1 串行 / B5 自愈 / retry / 冲突 gate（不再裸推）。
            const res = await _store.flow.push(item.name, {
              encode: () => encodeDocToOra(loaded, { referenceImage: loaded._referenceBlob, webpaintState: loaded._webpaintState }),
              onConflict: async () => "keep",   // gallery 非 active item：冲突不静默覆盖，提示先改名
            });
            if (res.status === "conflict") setStatus(`云端冲突：${item.name}（先改名再推）`, true);
            else setStatus(`已推送：${item.name}`);
          } catch (err) {
            if (err instanceof CloudConflictError) setStatus(`云端冲突：${item.name}（先改名再推）`, true);
            else setStatus("推送失败：" + (err && err.message || err));
          }
        });
        renderGallery();
      });
    } else if (isLocal && isCloud) {
      // 卸载 = 删本地副本，云端备份还在。
      // - 无冲突（cloud-dirty=false）：本地跟云端同步过 → 直接卸载
      // - 有冲突（cloud-dirty=true）：本地有未推改动 → warning confirm，卸载会丢
      // - active session 卸载：跟"送到回收站 active"一样走 _resetCanvasToBlank（lazy 空白占位）
      addAction("卸载本地", async () => {
        const isActive = (item.name === _activeSessionName);
        const dirty = isCloudDirty(item.name);
        if (dirty) {
          const ok = await openConfirmSheet(
            `卸载本地 "${item.name}"？`,
            "本地有未推送到云端的修改，卸载会**丢失这些修改**。云端保留的是旧版本。",
          );
          if (!ok) return;
        }
        await withBusy(`正在卸载本地 ${item.name}…`, async () => {
          try {
            await removeSession(item.name);
            if (isActive) await _exitCanvasToGallery();
            setStatus(`已卸载本地：${item.name}（云端保留）`);
          } catch (err) {
            setStatus("卸载失败：" + (err && err.message || err));
          }
        });
        renderGallery();
      });
    }

    // 删除 = 软删（送回收站，可恢复）。策略：有云端就只云端进 trash，本地直接 IDB delete。
    // - 本地 only：本地 trash
    // - 云端 only：云端 trash
    // - 本地+云：云端 trash（source of truth）+ 本地 IDB 直接删
    //   特殊：cloud-dirty（本地有未推改动） → warning：删本地会丢这部分改动
    addAction("送到回收站", async () => {
      const isActive = (item.name === _activeSessionName);
      const dirty = isLocal && isCloud && isCloudDirty(item.name);
      let detail;
      if (isLocal && isCloud) {
        detail = dirty
          ? "本地有**未推送到云端的修改**，删除会丢失这些改动。云端备份会进回收站可恢复。"
          : "本地副本会一起删，云端进回收站可恢复。";
      } else if (isCloud) {
        detail = "会进云端回收站，可恢复。";
      } else {
        detail = "会进本地回收站，可恢复。";
      }
      if (isActive) detail += " 当前画布会关闭。";
      const ok = await openConfirmSheet(`删除 "${item.name}"？`, detail);
      if (!ok) return;
      // 干活全交给 store.flow.delete（三态 move-aside / 不留双份 / 离线排队，机制在库内）。
      // dirty 警告已在上面的 confirm sheet 里说清，故不再传 onDirtyWarn（不重复弹）。
      // 文件夹模型「云端真文件夹为准」：删最后一个文件后 OneDrive 父文件夹仍在 → 空文件夹自然保留。
      await withBusy(`正在删除 ${item.name}…`, async () => {
        try {
          await _store.flow.delete(item.name, { isOnline: () => navigator.onLine !== false });
          if (isActive) await _exitCanvasToGallery();
          setStatus(`已删除：${item.name}`);
        } catch (e) {
          setStatus(`删除失败：${e && e.message || e}`, true);
        }
      });
      renderGallery();
    }, { danger: true });

    tile.appendChild(popup);

    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      // 关其他打开的 popup
      for (const p of els.galleryGrid.querySelectorAll(".gallery-tile-menu-popup")) {
        if (p !== popup) p.classList.add("hidden");
      }
      popup.classList.toggle("hidden");
    });

    tile.addEventListener("click", async (e) => {
      if (e.target.closest(".gallery-tile-menu-btn")) return;
      if (e.target.closest(".gallery-tile-menu-popup")) return;
      if (tile.dataset.busy === "1") return;   // 防狂点 race
      if (item.name === _activeSessionName) {
        setGalleryOpen(false);
        return;
      }
      tile.dataset.busy = "1";
      try {
        if (_store.edits.localDirty()) await saveNow();
        if (isLocal) {
          const loaded = await openSession(item.name);
          if (!loaded) { setStatus(`找不到：${item.name}`); return; }
          adoptLoadedDoc(loaded, item.name);
          setGalleryOpen(false);
          setStatus(`已打开：${item.name}`);
          gateCloudSyncOnOpen(item.name).catch((e) => console.warn("[sync-gate]", e));
        } else if (isCloud) {
          // 纯云端：点 tile = 拉取（与"拉取"按钮等价）
          setStatus(`正在拉取：${item.name}…`);
          await pullCloudPath(item.cloud.path);
        }
      } catch (err) {
        setStatus("打开失败：" + (err && err.message || err));
      } finally {
        delete tile.dataset.busy;
      }
    });

    els.galleryGrid.appendChild(tile);
  }

  // 关闭弹出的 ⋯ 菜单：grid 内任何地方点击且不在菜单 btn / popup 上 → 关全部
  els.galleryGrid.addEventListener("click", (e) => {
    if (e.target.closest(".gallery-tile-menu-btn")) return;
    if (e.target.closest(".gallery-tile-menu-popup")) return;
    for (const p of els.galleryGrid.querySelectorAll(".gallery-tile-menu-popup")) {
      p.classList.add("hidden");
    }
  }, { capture: true });

  // 云端 thumbnail 懒加载：进视口（rootMargin 多 extend 一点降延迟）才拉
  _galleryThumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target;
      _galleryThumbObserver.unobserve(el);
      _hydrateCloudThumb(el);
    }
  }, { root: els.galleryGrid, rootMargin: "600px 0px", threshold: 0.01 });

  for (const el of els.galleryGrid.querySelectorAll(".gallery-tile-thumb.placeholder[data-cloud-item-id]")) {
    _galleryThumbObserver.observe(el);
  }
}

// ===== 子文件夹 helpers =====
function _renderBreadcrumb() {
  const bc = els.galleryBreadcrumb;
  if (!bc) return;
  bc.innerHTML = "";
  if (!_galleryFolder && _galleryView !== "trash") {
    bc.classList.add("hidden");
    return;
  }
  bc.classList.remove("hidden");
  // 根按钮
  const rootBtn = document.createElement("button");
  rootBtn.type = "button";
  rootBtn.textContent = "/ 根目录";
  if (!_galleryFolder) rootBtn.classList.add("current");
  else rootBtn.addEventListener("click", () => { setGalleryFolder(""); renderGallery(); });
  bc.appendChild(rootBtn);
  // 每段路径
  if (_galleryFolder) {
    const segs = _galleryFolder.split("/").filter(Boolean);
    let accum = "";
    for (let i = 0; i < segs.length; i++) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "›";
      bc.appendChild(sep);
      const seg = segs[i];
      accum = accum ? `${accum}/${seg}` : seg;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = seg;
      if (i === segs.length - 1) {
        btn.classList.add("current");
      } else {
        const target = accum;
        btn.addEventListener("click", () => { setGalleryFolder(target); renderGallery(); });
      }
      bc.appendChild(btn);
    }
  }
}

function _renderFolderTile(folderName, folderPath, hasItems) {
  const tile = document.createElement("div");
  tile.className = "gallery-tile folder";
  // thumb 用 folder icon
  const thumb = document.createElement("div");
  thumb.className = "gallery-tile-thumb";
  thumb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  tile.appendChild(thumb);
  // name row
  const nameRow = document.createElement("div");
  nameRow.className = "gallery-tile-name-row";
  const nm = document.createElement("div");
  nm.className = "gallery-tile-name";
  nm.textContent = folderName;
  nm.title = folderPath;
  nameRow.appendChild(nm);
  const meta = document.createElement("div");
  meta.className = "gallery-tile-meta";
  meta.textContent = hasItems ? "文件夹" : "空文件夹";
  nameRow.appendChild(meta);
  tile.appendChild(nameRow);
  // ⋯ menu（只显示"删除"，且仅在空时启用）
  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "gallery-tile-menu-btn";
  menuBtn.setAttribute("aria-label", "更多操作");
  menuBtn.textContent = "⋯";
  tile.appendChild(menuBtn);
  const popup = document.createElement("div");
  popup.className = "gallery-tile-menu-popup hidden";
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "danger";
  delBtn.textContent = hasItems ? "删除（请先清空里面）" : "删除空文件夹";
  delBtn.disabled = hasItems;
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    popup.classList.add("hidden");
    if (hasItems) {
      setStatus("文件夹非空，请先把里面的作品移走或删除", true);
      return;
    }
    await withBusy(`正在删除文件夹 ${folderName}…`, async () => {
      // 云端真文件夹为准：直接删 OneDrive 上的真文件夹（无旁路要清）。
      if (isSignedIn() && navigator.onLine !== false) {
        try {
          const item = await getItemByPath(folderPath);
          if (item && item.folder) await deleteItem(item.id);
          clearFolderCaches();
        } catch (e) { console.warn("[folder] cloud delete:", e); }
      }
      setStatus(`已删除空文件夹：${folderName}`);
    });
    renderGallery();
  });
  popup.appendChild(delBtn);
  tile.appendChild(popup);
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    for (const p of els.galleryGrid.querySelectorAll(".gallery-tile-menu-popup")) {
      if (p !== popup) p.classList.add("hidden");
    }
    popup.classList.toggle("hidden");
  });
  tile.addEventListener("click", (e) => {
    if (e.target.closest(".gallery-tile-menu-btn")) return;
    if (e.target.closest(".gallery-tile-menu-popup")) return;
    setGalleryFolder(folderPath);
    renderGallery();
  });
  els.galleryGrid.appendChild(tile);
}

// 回收站视图：每条 trash 独立 tile（trashKey / itemId 唯一），不按 name 合并。
// 同名多次删除显示多个 tile，按删除时间排序；meta 行标"本地"或"云端"区分
async function renderTrashView() {
  let local = [], cloud = [];
  try { local = await listTrashedSessions(); } catch (e) { console.warn("[trash] local list:", e); }
  if (isSignedIn() && navigator.onLine !== false) {
    try { cloud = await listCloudTrash(); } catch (e) { console.warn("[trash] cloud list:", e); }
  }

  // 每条独立 entry，标 source 区分
  const merged = [];
  for (const l of local) {
    merged.push({
      kind: "local",
      uid: l.trashKey,
      name: l.originalName,
      deletedAt: l.deletedAt,
      thumb: l.thumb,
      local: l, cloud: null,
    });
  }
  for (const c of cloud) {
    // 去 .ora 后缀 + 去冲突时间戳 → 显示原名
    const name = c.name.replace(/\.ora$/i, "").replace(/ \[\d+\]$/, "");
    merged.push({
      kind: "cloud",
      uid: c.id,
      name,
      deletedAt: Date.parse(c.lastModifiedDateTime || 0),
      thumb: null,
      local: null, cloud: c,
    });
  }
  merged.sort((a, b) => b.deletedAt - a.deletedAt);

  els.galleryGrid.innerHTML = "";
  if (merged.length === 0) {
    els.galleryEmpty.classList.remove("hidden");
    els.galleryEmpty.textContent = "回收站是空的。";
    els.galleryGrid.style.display = "none";
    return;
  }
  els.galleryEmpty.classList.add("hidden");
  els.galleryGrid.style.display = "";

  for (const item of merged) {
    const tile = document.createElement("div");
    tile.className = "gallery-tile";

    // thumb：本地有就直接显示；云端走 IntersectionObserver lazy fetch（跟 main view 一样）
    let thumbEl;
    if (item.local && item.local.thumb) {
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
      if (item.kind === "cloud" && item.cloud) {
        thumbEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:48px;height:48px;"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
        thumbEl.dataset.cloudItemId = item.cloud.id;
        thumbEl.dataset.cloudEtag = item.cloud.eTag || "";
        thumbEl.dataset.cloudSize = String(item.cloud.size || 0);
        thumbEl.dataset.cloudName = item.name;
        const dl = item.cloud["@microsoft.graph.downloadUrl"];
        if (dl) _galleryDownloadUrls.set(item.cloud.id, dl);
      } else {
        thumbEl.textContent = (item.name.slice(0, 1) || "?");
      }
    }
    tile.appendChild(thumbEl);

    // 名字 + meta（meta 标 kind 区分本地 / 云端）
    const nameRow = document.createElement("div");
    nameRow.className = "gallery-tile-name-row";
    const nm = document.createElement("div");
    nm.className = "gallery-tile-name";
    nm.textContent = item.name;
    nm.title = item.name;
    nameRow.appendChild(nm);
    const meta = document.createElement("div");
    meta.className = "gallery-tile-meta";
    const source = item.kind === "cloud" ? "云端" : "本地";
    meta.textContent = `${source} · ${humanTime(item.deletedAt)} 删除`;
    nameRow.appendChild(meta);
    tile.appendChild(nameRow);

    // ⋯ 菜单
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "gallery-tile-menu-btn";
    menuBtn.textContent = "⋯";
    tile.appendChild(menuBtn);

    const popup = document.createElement("div");
    popup.className = "gallery-tile-menu-popup hidden";

    const addAction = (label, handler, opts = {}) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      if (opts.danger) b.className = "danger";
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        popup.classList.add("hidden");
        await handler();
      });
      popup.appendChild(b);
    };

    addAction("恢复", async () => {
      // 走 store.flow.restore：本地先恢复拿到实际落名（撞名自动 (2)）→ 云端按同一名恢复，两端不再失同步。
      await withBusy(`正在恢复 ${item.name}…`, async () => {
        try {
          const res = await _store.flow.restore({
            trashKey: item.local ? item.local.trashKey : null,
            fromCloud: !!item.cloud,
            cloudItemId: item.cloud ? item.cloud.id : null,
            targetName: item.name,
          });
          const restoredName = res.name || item.name;
          setStatus(`已恢复：${restoredName}${restoredName !== item.name ? `（原名 ${item.name} 已被占用）` : ""}`);
        } catch (e) {
          setStatus(`恢复失败：${e && e.message || e}`, true);
        }
      });
      renderGallery();
    });

    addAction("永久删除", async () => {
      const ok = await openConfirmSheet(`永久删除 "${item.name}"？`, "不可撤销。");
      if (!ok) return;
      // 走 store.flow.purge：本地 trash + 云端 trash 一处删。
      await withBusy(`正在永久删除 ${item.name}…`, async () => {
        try {
          await _store.flow.purge({
            trashKey: item.local ? item.local.trashKey : null,
            cloudItemId: item.cloud ? item.cloud.id : null,
          });
          setStatus(`已永久删除：${item.name}`);
        } catch (e) {
          setStatus(`永久删除失败：${e && e.message || e}`, true);
        }
      });
      renderGallery();
    }, { danger: true });

    tile.appendChild(popup);

    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      for (const p of els.galleryGrid.querySelectorAll(".gallery-tile-menu-popup")) {
        if (p !== popup) p.classList.add("hidden");
      }
      popup.classList.toggle("hidden");
    });

    els.galleryGrid.appendChild(tile);
  }

  els.galleryGrid.addEventListener("click", (e) => {
    if (e.target.closest(".gallery-tile-menu-btn")) return;
    if (e.target.closest(".gallery-tile-menu-popup")) return;
    for (const p of els.galleryGrid.querySelectorAll(".gallery-tile-menu-popup")) {
      p.classList.add("hidden");
    }
  }, { capture: true });

  // 云端 trash 也接 lazy thumb 拉取（跟 main view 同 observer 路径）
  _galleryThumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target;
      _galleryThumbObserver.unobserve(el);
      _hydrateCloudThumb(el);
    }
  }, { root: els.galleryGrid, rootMargin: "600px 0px", threshold: 0.01 });
  for (const el of els.galleryGrid.querySelectorAll(".gallery-tile-thumb.placeholder[data-cloud-item-id]")) {
    _galleryThumbObserver.observe(el);
  }
}

// 给一个 placeholder 元素拉云缩略图，成功后原地替换成 <img>
async function _hydrateCloudThumb(placeholderEl) {
  const itemId = placeholderEl.dataset.cloudItemId;
  const etag = placeholderEl.dataset.cloudEtag;
  const size = Number(placeholderEl.dataset.cloudSize);
  const dl = _galleryDownloadUrls.get(itemId);
  if (!itemId || _galleryThumbInflight.has(itemId)) return;
  _galleryThumbInflight.add(itemId);
  const t0 = performance.now();
  try {
    const { blob, fromCache } = await getOrFetchCloudThumb(itemId, etag, size, dl);
    const dt = (performance.now() - t0) | 0;
    const tag = fromCache ? "cache" : "net";
    console.log(`[thumb] ${tag} ${dt}ms ${(blob.size/1024)|0}KB ${placeholderEl.dataset.cloudName}`);
    if (!placeholderEl.isConnected) return;  // 列表已重渲染 → 丢弃
    const url = URL.createObjectURL(blob);
    _galleryUrls.push(url);
    const img = document.createElement("img");
    img.className = "gallery-tile-thumb";
    img.alt = placeholderEl.dataset.cloudName || "";
    img.src = url;
    img.loading = "lazy";
    placeholderEl.replaceWith(img);
  } catch (err) {
    console.warn("[gallery] cloud thumb fail:", err);
    // placeholder 保持显示（云朵 icon）
  } finally {
    _galleryThumbInflight.delete(itemId);
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

els.galleryTrashBtn?.addEventListener("click", () => {
  _galleryView = "trash";
  renderGallery();
});
els.galleryTrashMenuBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  els.galleryTrashMenuPopup?.classList.toggle("hidden");
});
// 点 popup / btn 之外关闭
document.addEventListener("click", (e) => {
  const p = els.galleryTrashMenuPopup;
  if (!p || p.classList.contains("hidden")) return;
  if (e.target.closest("#galleryTrashMenuPopup, #galleryTrashMenuBtn")) return;
  p.classList.add("hidden");
});
els.galleryTrashBack?.addEventListener("click", () => {
  _galleryView = "files";
  // 还原 empty 文案
  if (els.galleryEmpty) els.galleryEmpty.textContent = "还没有保存的作品。点右上加号新建一个，或先在 PC 上画一笔。";
  renderGallery();
});
els.galleryEmptyTrashBtn?.addEventListener("click", async () => {
  els.galleryTrashMenuPopup?.classList.add("hidden");
  const ok = await openConfirmSheet("清空回收站？", "本地和云端的回收站都会清。不可撤销。");
  if (!ok) return;
  // 一条 flow：本地 + 云端两端在库内清、失败汇总不静默（取代旧 app 两腿 emptyTrash+循环 purgeCloudTrashItem）。
  await withBusy("正在清空回收站…", async () => {
    const res = await _store.flow.emptyTrash({ isOnline: () => isSignedIn() && navigator.onLine !== false });
    const cloudFails = (res.failed || []).filter((f) => f.where !== "local").length;
    if (cloudFails) setStatus(`已清本地；${cloudFails} 项云端没清（可能离线），回线再清`, true);
    else if ((res.failed || []).length) setStatus("清空时部分失败", true);
    else setStatus("回收站已清空");
  });
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
// 全屏 block overlay：拉云端时显示 spinner + 文字，防误操作
function showFullscreenBusy(msg) {
  let el = document.getElementById("fullscreenBusy");
  if (!el) {
    el = document.createElement("div");
    el.id = "fullscreenBusy";
    el.className = "fullscreen-busy";
    el.innerHTML = '<div class="fullscreen-busy-spinner"></div><div class="fullscreen-busy-msg"></div>';
    document.body.appendChild(el);
  }
  el.querySelector(".fullscreen-busy-msg").textContent = msg || "处理中…";
  el.classList.remove("hidden");
}
function hideFullscreenBusy() {
  const el = document.getElementById("fullscreenBusy");
  if (el) el.classList.add("hidden");
}

async function pullCloudPath(path) {
  // 云端 → 本地 IDB → 自动打开（user：「下载好了应该自动进去」）。
  // store.flow.acquire：cloud-only 首取，本地存原始 ora bytes（不 re-encode）+ adopt。
  showFullscreenBusy(`正在从云端拉取…`);
  try {
    const cloudName = String(path).replace(/\.ora$/i, "");
    const localName = await uniqueLocalName(cloudName);
    const res = await _store.flow.acquire(cloudName, {
      localName,
      adopt: async (blob, nm) => { const loaded = await decodeOraToDoc(blob); adoptLoadedDoc(loaded, nm); },
    });
    if (res.status === "absent") { setStatus(`找不到：${path}`); return; }
    setGalleryOpen(false);
    setStatus(`已打开：${res.localName}（从云端拉取）`);
    gateCloudSyncOnOpen(res.localName).catch((e) => console.warn("[sync-gate]", e));
  } catch (err) {
    console.warn("[cloud] pull failed:", err);
    setStatus("拉取失败：" + (err && err.message || err));
  } finally {
    hideFullscreenBusy();
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
    // gallery-first: boot 时 gallery 可能已经渲染过（auth 没好 → 只有本地）；
    // auth 完成后 if gallery 还开着 → 重渲染拿云端列表
    if (!els.galleryFull.classList.contains("hidden")) renderGallery();
  }).catch((e) => {
    console.warn("[auth] init failed:", e);
  });
}
// auth 可观察 seam（候选1）：lib 在**每个** auth 转变（登录回来/后台silent/登出/过期F2）fire wp:auth-changed。
// UI 订阅一次 → 按钮蓝/灰、save 图标、云列表 全自动同步，永不漂移、不再靠散落手 poke。
window.addEventListener("wp:auth-changed", () => {
  if (isSignedIn()) setLastSessionSignedIn(true);
  updateCloudAuthUI();
  updateSaveStatus();                                       // 候选2：auth 变化影响 save 图标
  if (!els.galleryFull.classList.contains("hidden")) renderGallery();
});
// 在线 / 离线变化时刷新云端 UI（标签 / 按钮可见性）。
// online 时尝试 silent re-auth：boot 离线 → activeAccount 为 null；有网了主动 retry 一次
window.addEventListener("online", async () => {
  if (!isSignedIn()) await retrySilentSignIn();
  updateCloudAuthUI();
  if (!els.galleryFull.classList.contains("hidden")) renderGallery();
  showIdleLockIfStale();   // 回到在线 → 闲够了则锁屏（不静默 FF；点继续才 explicit 刷新）
});
window.addEventListener("offline", () => { updateCloudAuthUI(); });

// ADR-0017（修订）前台新鲜度 —— **不静默 FF**，超时 explicit 锁屏：
//   · 活动监听：动笔/操作重置闲置计时（pointerdown/keydown 全局 capture）。
//   · idle 检查 tick：前台时每 30s 看闲够没 → 锁屏（像 iPad 闲置熄屏；suspend 时 timer 冻结，回前台靠 visibility 现算）。
document.addEventListener("pointerdown", _markActivity, true);
document.addEventListener("keydown", _markActivity, true);
setInterval(() => { if (document.visibilityState === "visible") showIdleLockIfStale(); }, 30 * 1000);
// Gallery-first 启动：
//   1) galleryOpen flag = true（上次退出在 gallery） → 停 gallery
//   2) 否则有上次 session 名 → load → 成功 adopt + 进画布；失败 → 停 gallery
//   3) 失败保留 currentSessionName 不清（用户下次冷启动还能 retry）
(async () => {
  const wantedName = getCurrentSessionName();
  if (!wantedName) {
    _activeSessionName = null;
    updateSaveStatus();
    await setGalleryOpen(true);
    return;
  }
  try {
    const loaded = await loadCurrentSession();
    if (!loaded) {
      // 上次记录的 name 在 IDB 没了 → 停 gallery
      _activeSessionName = null;
      updateSaveStatus();
      await setGalleryOpen(true);
      setStatus(`找不到上次画作 "${wantedName}"，先选一个或新建`);
      return;
    }
    adoptLoadedDoc(loaded, wantedName);
    setStatus(`已恢复：${wantedName} (${loaded.layers.length} 层)`);
    gateCloudSyncOnOpen(wantedName).catch((e) => console.warn("[sync-gate]", e));
  } catch (e) {
    console.warn("[session] load failed:", e);
    _activeSessionName = null;
    updateSaveStatus();
    await setGalleryOpen(true);
    setStatus(`启动加载 "${wantedName}" 失败：${e && e.message || e}`, true);
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

// v124 (user：「暂时不用管后向兼容，还没到 alpha」) 删 shapes / airbrush 映射
const TOOL_LABEL = {
  brush: "笔刷", smudge: "涂抹", eraser: "橡皮",
};
let _rackCurrentFolder = DEFAULT_FOLDER;
let _rackCurrentTool = "brush";   // 当前 rack sheet 显示的工具
// dirty 单源 = rackSync（isRackDirty/setRackDirty）；旧 app 侧 _rackDirty 双源已删（v2）。
// 内容改动（存预设/删/导入/重置）后防抖自动同步（停手 ~1.5s 推）。FolderFlow 自带 412 重试 +
// 无损 union，频繁推也安全；切笔是 per-doc 不脏 rack，故不会因切笔狂推。关 sheet 立即 flush。
let _rackSyncTimer = null;
function _scheduleRackSync(delay = 1500) {
  if (_rackSyncTimer) clearTimeout(_rackSyncTimer);
  _rackSyncTimer = setTimeout(() => { _rackSyncTimer = null; pushBrushRackIfSignedIn(); }, delay);
  _refreshRackCloudState();   // icon 立刻切 dirty
}
// 「笔架内容变了」单一语义入口：落本地 + 防抖同步云。
// 编辑器 / 导入 / 删除 只声明「变了」，**不直接碰 sync**（load+save 与 sync 解耦）。
function markRackChanged() {
  setRackDirty(true);
  persistBrushRack();
  _scheduleRackSync();
}

function _showRackSheet(tool) {
  if (!_brushRack) return;
  _rackCurrentTool = tool;
  _rackEls.title.textContent = `笔架 · ${TOOL_LABEL[tool] || tool}`;
  _renderRackSheet();
  _rackEls.sheet.classList.remove("hidden");
  _refreshRackCloudState();        // v134 打开 rack 时刷 icon
}
function _hideRackSheet() {
  _rackEls.sheet.classList.add("hidden");
  if (_rackSyncTimer) { clearTimeout(_rackSyncTimer); _rackSyncTimer = null; }   // 关 sheet 立即 flush，取消防抖
  if (isRackDirty()) {
    persistBrushRack();           // 同步 IDB
    pushBrushRackIfSignedIn();    // 同步云（成功内部清 rackSync dirty）
  }
}

// v134 rack cloud 状态机：smart icon + auto push
//   synced：ETag 匹配 + 没本地未推改动
//   busy：正在推
//   dirty：本地有未推改动（短暂；auto push 会清掉）
//   conflict：上次推遇到 412，待 user 选三选
//   offline：navigator.onLine === false
//   no-auth：未登录
let _rackCloudState = "no-auth";
function updateRackCloudIcon() {
  const btn = document.getElementById("brushRackCloudPush");
  if (!btn) return;
  const name = "笔架";
  const ICON = {
    "synced":   ICON_CLOUD_CHECK,
    "busy":     ICON_CLOUD_BUSY,
    "dirty":    ICON_UPLOAD,
    "offline":  ICON_DISK,
    "no-auth":  ICON_DISK,
  };
  const TITLE = {
    "synced":   `${name} 已同步云端`,
    "busy":     `${name} 上传中…`,
    "dirty":    `${name} 待推 — 点推送`,
    "offline":  `${name} 离线 — 仅本地`,
    "no-auth":  `${name} 未登录 — 登 OneDrive 自动同步`,
  };
  btn.innerHTML = ICON[_rackCloudState] || ICON.synced;
  btn.title = TITLE[_rackCloudState] || "";
  btn.dataset.state = _rackCloudState;
}
function _refreshRackCloudState() {
  if (!isSignedIn()) _rackCloudState = "no-auth";
  else if (navigator.onLine === false) _rackCloudState = "offline";
  else if (isRackDirty()) _rackCloudState = "dirty";
  else _rackCloudState = "synced";
  updateRackCloudIcon();
}

// 推云：仅 IDB 已写后调；user 在场（关 sheet 是 explicit action）
//   v134：冲突时 3 选（拉 / 强推 / 合并）；其他状态 auto retry
// 笔架同步 = FolderFlow（pull-merge-push，无损 union，零冲突 UI）。
// 编辑永远本地即时（调用方已落本地）；这里只在能连时后台 reconcile。merge 把别的设备新增的笔带回来。
async function pushBrushRackIfSignedIn() {
  if (!isSignedIn() || !navigator.onLine) { _refreshRackCloudState(); return; }
  if (!_brushRack) return;
  _rackCloudState = "busy"; updateRackCloudIcon();
  const res = await rackFolderFlow.sync({
    version: _brushRack.version, items: _brushRack.brushes,
    trash: _brushRack.trash || [], resetAt: _brushRack.resetAt || 0,
  });
  // 采纳 merge 结果（可能含云端别设备新增的笔）。正在编辑某把笔时不揪它——挂到关闭再 reconcile。
  if (res.folder && _editingBrushId == null) {
    _brushRack = { ...(_brushRack), version: res.folder.version, brushes: res.folder.items, trash: res.folder.trash, resetAt: res.folder.resetAt };
    { const _n = mergeMissingDefaults(_brushRack); if (_n) _brushRack = _n; }
    await persistBrushRack();
    applyToolState(editMode.current());
    if (RACK_PANEL_BY_TOOL[editMode.current()] === getCurrentExclusive()) _renderRackSheet();
  }
  if (res.status === "synced") setStatus("笔架已同步到云端");
  else if (res.status === "invalid") setStatus("笔架云端数据异常，已留待重试", true);
  else if (res.status === "dirty") { console.warn("[brush-rack sync]", res.error); setStatus("笔架同步失败，已留待重试", true); }
  // offline：静默
  _refreshRackCloudState();   // 单源派生 icon（dirty 来自 rackSync）
}
// （旧 _resolveRackCloudConflict 三选对话框已删——Folder shape 的 union-merge 让冲突消失，
//   FolderFlow 自动无损合并，不再有 lossy「拉云端丢本地/覆盖云端丢云端」）。

// Boot 后调一次：背景 reconcile（FolderFlow pull-merge-push）。
// merge 无损：本地有就 union 上去再推，本地没新就只采纳云端、不白写（folder-flow 的跳推优化）。
async function checkBrushRackCloud() {
  if (!isAuthConfigured() || !navigator.onLine || !isSignedIn()) return;
  await pushBrushRackIfSignedIn();
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
      markRackChanged();
      applyToolState(editMode.current());
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
    // v124b (user：「笔刷的扳手改成 ⋯，统一用一个框架」) 扳手 → ⋯ (unicode 在 iOS 一致)
    const gear = document.createElement("button");
    gear.type = "button";
    gear.className = "brush-rack-tile-edit";
    gear.title = "编辑";
    gear.textContent = "⋯";
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
      pressureGamma: 1.0, pressureLPF: 50, defaultOpa: 1.0,
      compositeMode: "wash", blendMode: "source-over", spacing: 0.06, pixelMode: false,
      taper: { in: 0, out: 0 },
      smudge: _rackCurrentTool === "smudge" ? { strength: 0.8, dryness: 0.1 } : null,
      smooth: { streamline: 0.3, stabilization: 0, pullStabilizer: 0, motionFilter: 0 },
    };
  }
  // 新建 = 进 draft、**不落 rack**；存才落、cancel/闪退 = 没建过（user：不点保存 = cancel）。
  newB.uat = Date.now();            // v2: 建笔 user-action-time（存时再刷新）
  closeExclusive();
  _openBrushSettings(newB.id, newB);
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
      b.uat = Date.now();             // v2: 导入 = user-action-time
      _brushRack.brushes.push(b);
      markRackChanged();
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
    if (b.blendMode && b.blendMode !== "source-over") args.blendMode = b.blendMode;
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
  setStatus("正在同步笔架…");
  await pushBrushRackIfSignedIn();
});
if (_rackEls.resetBtn) _rackEls.resetBtn.addEventListener("click", async () => {
  const ok = await openConfirmSheet(
    "重置笔架？",
    "会删除全部自定义笔刷 + 改过的默认笔，恢复出厂默认。不可撤销。",
  );
  if (!ok) return;
  _brushRack = makeDefaultRack({ resetAt: Date.now() });   // v2: 恢复出厂 = resetAt watermark
  for (const t of Object.keys(state.toolStates)) {
    state.toolStates[t].activeBrushId = null;
    Object.assign(state.toolStates[t], defaultToolStateFor(t));
  }
  await persistBrushRack();
  applyToolState(editMode.current());
  if (RACK_PANEL_BY_TOOL[editMode.current()] === getCurrentExclusive()) _renderRackSheet();
  setRackDirty(true);
  if (isSignedIn()) pushBrushRackIfSignedIn();
  setStatus(`笔架已重置（${_brushRack.brushes.length} 个 brush）`, true);
});
if (_rackEls.dumpCodeBtn) _rackEls.dumpCodeBtn.addEventListener("click", () => dumpRackAsCode());

// ---- brush settings 全屏 view ----
let _editingBrushId = null;
let _editingBrushDraft = null;

// brushId 已在 rack → 克隆成 draft 编辑；newDraft 传入 → 编辑一个**尚未落 rack** 的新笔（存才落）。
function _openBrushSettings(brushId, newDraft) {
  let draft;
  if (newDraft) draft = newDraft;
  else { const b = findBrush(_brushRack, brushId); if (!b) return; draft = JSON.parse(JSON.stringify(b)); }
  _editingBrushId = brushId;
  _editingBrushDraft = draft;
  _renderBrushSettings();
  _settingsEls.view.classList.remove("hidden");
}
// 编辑全程改的是 draft（深拷贝/新笔）；**只有点保存才落 rack**。cancel / 不点保存闪退 = draft 丢弃 = 没改过/没建过。
function _closeBrushSettings(save) {
  if (save && _editingBrushDraft) {
    _editingBrushDraft.uat = Date.now();   // v2: 保存/更新预设/改名/移 folder = user-action-time
    const idx = _brushRack.brushes.findIndex((x) => x.id === _editingBrushId);
    if (idx >= 0) _brushRack.brushes[idx] = _editingBrushDraft;   // 更新现有
    else _brushRack.brushes.push(_editingBrushDraft);             // 新建落地（draft → rack）
    markRackChanged();             // 存 = 落本地 + 防抖同步（sheet 不直接碰 sync）
    // v99r2：保存后自动切到该笔（user：「修改保存后自动切到那一个，回 default size」）。不主动切 tool。
    const tool = _editingBrushDraft.tool;
    const targetTool = editMode.current() === "airbrush" ? "brush" : tool;
    if (getRackToolKey(editMode.current()) === getRackToolKey(targetTool)) {
      selectBrushPresetForTool(editMode.current(), _editingBrushDraft.id);
    } else {
      selectBrushPresetForTool(targetTool, _editingBrushDraft.id);
    }
    if (RACK_PANEL_BY_TOOL[editMode.current()] === getCurrentExclusive()) _renderRackSheet();
    setStatus(`已保存：${_editingBrushDraft.name}`);
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
  // v120: shapes / airbrush 撤了，brush rack 编辑器里也不再显这俩选项（写到 brush.tool 字段会失效）
  selectRow(basic, "工具", [
    ["brush", "笔刷"], ["smudge", "涂抹"], ["eraser", "橡皮"],
  ], b.tool, (v) => b.tool = v);
  // v163 笔刷混合模式（整条 stroke vs 下方 layer，复用图层那套 Canvas2D 模式）。基础设置，放上面。
  if (b.blendMode == null) b.blendMode = "source-over";
  selectRow(basic, "混合模式", Object.entries(LAYER_MODE_LABEL),
    b.blendMode, (v) => b.blendMode = v);
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
  if (b.pressureLPF == null) b.pressureLPF = 50;
  if (b.compositeMode == null) b.compositeMode = "wash";
  if (b.defaultOpa == null) b.defaultOpa = 1.0;
  if (!b.smooth) b.smooth = { streamline: 0.3, stabilization: 0, pullStabilizer: 0, motionFilter: 0 };

  // Size：base + max
  // v134 (user：「基础和最大都用同样的段量化 [] step」+「存的也是量化」)
  //   fmt 和 onChange 都跑 _quantizeSize，存的 / 显的 / [] step 三者一致
  const size = section("粗细 (size)");
  rangeRow(size, "基础", 1, b.size.max || 200, 1, b.size.base, (v) => `${_quantizeSize(v)} px`, (v) => b.size.base = _quantizeSize(v));
  rangeRow(size, "最大", 10, 1000, 1, b.size.max || 200, (v) => `${_quantizeSize(v)} px`, (v) => b.size.max = _quantizeSize(v));

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

  // Taper：入端 / 出端 stylistic taper（v160 起出端也接进引擎了）。数值 = taper 长度(× 笔径)，越大越长。
  const tp = section("收尾");
  rangeRow(tp, "入端", 0, 5, 0.1, b.taper.in,  (v) => v.toFixed(1), (v) => b.taper.in = v);
  rangeRow(tp, "出端", 0, 5, 0.1, b.taper.out, (v) => v.toFixed(1), (v) => b.taper.out = v);

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
    const delId = _editingBrushId;
    const idx = _brushRack.brushes.findIndex((x) => x.id === delId);
    if (idx >= 0) {
      // 真在 rack 里的笔才记 trash（缺席≠删除；merge 靠它判真删 vs edit-wins 复活）。
      _brushRack.brushes.splice(idx, 1);
      if (!Array.isArray(_brushRack.trash)) _brushRack.trash = [];
      _brushRack.trash.push({ id: delId, uat: Date.now() });
      markRackChanged();
      if (RACK_PANEL_BY_TOOL[editMode.current()] === getCurrentExclusive()) _renderRackSheet();
    }
    // 删一个尚未保存的新笔（idx<0）→ 仅丢 draft，等同 cancel。
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
  editMode.applyPendingTransient();
  if (_store.edits.localDirty() && !_docSaving) await saveNow();
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
// v121 dev/ 子目录跳 SW 注册：dev bundle 文件名固定 + ?v=epoch 防缓存，无 SW
// 反而每次刷新都直接拿最新代码，免得 dev 自己也踩"过一会才好"
// v124b：扩义——任何非 prod-root 路径都算 dev (含 /dev/, /staging/, localhost 等)。
// HUD 上挂红色 DEV chip 让人一眼看出环境
const IS_DEV_ROUTE = location.pathname.includes("/dev/")
  || location.hostname === "localhost"
  || location.hostname === "127.0.0.1";
{
  const chip = document.getElementById("envChip");
  if (chip && IS_DEV_ROUTE) chip.classList.remove("hidden");
}
if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname) && !IS_DEV_ROUTE) {
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
    // 路径 4：回前台 / 焦点 → poke SW 更新 + ADR-0017 闲置锁屏检查（**不静默 FF**，闲够了锁屏等用户点继续）。
    const pokeUpdate = () => { registration.update().catch(() => {}); };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { pokeUpdate(); showIdleLockIfStale(); }
    });
    window.addEventListener("focus", () => { pokeUpdate(); showIdleLockIfStale(); });
    setInterval(pokeUpdate, 10 * 60 * 1000);
  }).catch((err) => {
    console.warn("SW register failed", err);
  });
}
