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
import { DEFAULT_SETTINGS } from "./brush.js";
import { resolveBrush } from "./resolved-brush.js";
import {
  makeDefaultRack, findBrush, defaultBrushForTool, brushesByTool,
  newBrushId, brushToJSON, brushFromJSON, DEFAULT_FOLDER, mergeMissingDefaults, migrateBrush,
  defaultsPromise,
} from "./brushes.js";
import { PANELS, registerPanel, openExclusive, closeExclusive, getCurrentExclusive } from "./panel-state.js";
import { UndoStack } from "./history.js";
import { EditMode } from "./edit-mode.js";
import { ReferenceWindow } from "./reference.js";
import { PaletteWindow } from "./palette.js";
import { mountColorWheel } from "./ui/color-wheel.ts";   // UI 深化 candidate 1 · Vue pilot
import { mountBrushSettings } from "./ui/brush-settings.ts";   // candidate 1 · 笔设置编辑器
import { mountGallery } from "./ui/gallery.ts";          // candidate 1 · 图库深模块
import { shareOrDownloadJSON, exportBrush, exportRackFolder, buildRackCode } from "./brush-io.ts";
import { BrushRack } from "./brush-rack.ts";
import { PwaShell } from "./pwa-shell.ts";
import { openInputSheet, openConfirmSheet, lockSyncGate, unlockSyncGate, settleSyncGate } from "./sheets.ts";
import { els } from "./els.ts";
import { safeLSSet } from "./safe-ls.ts";   // safeLS seeding 已随 editor-state 搬走
import { applyTheme, cycleTheme, THEME_LABEL, initTheme } from "./theme.ts";
import { initLayersPanel, renderLayersPanel, toggleLayersPanel, LAYER_MODE_LABEL } from "./layers-panel.ts";
import { initDocOps, _updateMenuCropLabel } from "./doc-ops.ts";
import { initCloudAuthUI, updateCloudAuthUI } from "./cloud-auth-ui.ts";
import { initSettingsMenu, setMenuOpen, applyCheckerboard } from "./settings-menu.ts";
import { initFiltersAdjust, setAdjustOpen } from "./filters-adjust.ts";
import { initToolbar, setTool, RACK_PANEL_BY_TOOL, updateLassoToolbar } from "./toolbar.ts";
import { setColor, toggleColorPanel, initColorPanel } from "./color-panel.ts";
import { session, initSession, setSessionGallery } from "./session-state.ts";   // candidate 3 · 活动文档生命周期 SSoT
import { createEditorState } from "./editor-state.ts";   // candidate 3 · 编辑器 RAM 反应式 SSoT（dial/color/压感）
import { mountLeftDial } from "./ui/left-dial.ts";   // candidate 1 Step 2 · 左栏 dial（size/opacity/笔指示/popup）
import { mountRackSheet } from "./ui/rack-sheet.ts";   // candidate 1 · 笔架 sheet（folder tabs + 笔 grid）
import { stepFor as _stepFor, quantizeSize as _quantizeSize } from "./ui/brush-size.ts";   // [ ] 键盘调粗用（slider 映射在 <LeftDial>）
import { computed, watch } from "../vendor/vue/vue.esm-browser.prod.js";   // candidate 1 · currentBrush computed + 引擎桥 watch
import {
  loadCurrentSession, listSessions,
  getCurrentSessionName,
  triggerDownload, shareOrDownloadBlob,
  copyImageToClipboard, readImageFromClipboard, writeImageBlobToClipboard,
} from "./session.js";   // saveSession/openSession/removeSession/listTrashedSessions 切到 session-state.ts
import { Selection } from "./selection.js";
import { SMOOTH, SMOOTH_DEFAULTS, saveSmooth, resetSmooth } from "./smooth-config.js";
import { decodeImageFile, fitWithin, canvasToBlob, smartResample, fillResampleSelect } from "./resample.js";
import { pathJoin } from "./gallery-path.js";   // pathFolder/pathBasename 切到 session-state.ts / gallery.ts
import { mergeLocalCloud, sliceFolder, folderHasContents } from "./gallery-model.js";
import { collectFolders, brushesInFolder } from "./brush-rack-view.js";
// v132 (user：「所有 color adjustment 做成第一方默认安装的插件」)
//   filters.js 只剩 Filter 契约 + registry + helper；
//   每个调色器在 src/plugins/ 自成一文件，import 时自注册
import { getFilter, listFilters, registerFilter, onFilterRegistered } from "./filters.js";
import "./plugins/index.js";    // 触发 HSB / ColorBalance / Curves / SharpenBlur 自注册
// candidate 2：导出格式 = 注册表插件（含第一方 ora/psd/png/jpg 自注册）
import { getExporter, listExportersByKind, registerExporter, listExporters } from "./exporters.js";
import { decodeOraToDoc } from "./ora.js";   // encodeDocToOra/parseAppVersion 切到 session-state.ts
import { getItemByPath, deleteItem, ensureSubfolder, clearFolderCaches } from "./app-store.js";
import { getOrFetchCloudThumb, clearCloudThumbCache, stats as cloudThumbStats, config as cloudThumbConfig, resetStats as cloudThumbResetStats } from "./cloud-thumb-cache.js";
import { telemetry as cloudThumbTelemetry, resetTelemetry as cloudThumbResetTelemetry } from "./cloud-thumbs.js";
import {
  isAuthConfigured, initAuth, signIn, signOut, isSignedIn, getActiveAccount, retrySilentSignIn,
  listCloudSessionsRecursive, listCloudAll, listCloudFolders,
  listCloudTrash,
  isCloudDirty,
  getLastSessionSignedIn, setLastSessionSignedIn,
  rackStore, setRackDirty, isRackDirty, resolveRef,
  store as _store,
} from "./app-store.js";   // cut-over：cloud/auth/graph 全走 lib（app-store shim 保旧名）




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

// 编辑器「当前设成什么样」的反应式 RAM SSoT（主色 / 每工具 dial / 压感开关 / 棋盘等）= editor-state.ts。
// 当前笔（currentBrush computed）从这束 dial + 笔架预设纯派生（见下，组合接线留 app）。
const { state, dialReactive } = createEditorState();

// 左栏 dial = <LeftDial> Vue 组件（src/ui/left-dial.ts）：笔指示按钮(tap=rack/长按=设置) + size/opacity 竖滑块 + size popup。
// 全绑定反应式 dial SSoT（getter 读 state.toolStates/dialReactive → 组件 computed 自动追踪）。
// 取代旧的 updateSidebarBrushIndicator / _sidebarBrushBtn 手势 / showSizePopup / 两个 slider 监听 / applyToolState 的 slider-DOM-push。
// 笔架深模块（src/brush-rack.ts）。editMode 走 thunk（构造早于 editMode）；DOM/icons/panels 晚绑 init()。
const rack = new BrushRack({
  state, dialReactive,
  editMode: () => editMode,
  setStatus, confirm: openConfirmSheet,
  openExclusive, closeExclusive, registerPanel,
  rackStore, setRackDirty,
  isSignedIn, isOnline: () => navigator.onLine !== false,
});

const _leftDial = () => state.toolStates[rack.getRackToolKey(dialReactive.tool)] || state.toolStates.brush;
const leftDial = mountLeftDial(els.leftDialMount, {
  getSize: () => _leftDial().size,
  getOpacity: () => _leftDial().opacity ?? 1.0,
  getSizeMax: () => { void dialReactive.rackVersion; return rack.findToolBrushPure(_leftDial())?.size?.max || 200; },
  getBrushName: () => { void dialReactive.rackVersion; return rack.findToolBrushPure(_leftDial())?.name || "—"; },
  getCanDraw: () => dialReactive.canDraw,
  getZoom: () => board?.viewport?.scale ?? 1,
  onSize: (px) => setSize(px),
  onOpacity: (frac) => setOpacity(frac),
  onBrushTap: () => { const id = RACK_PANEL_BY_TOOL[editMode.current()]; if (id) openExclusive(id); },
  onBrushLongpress: () => { const b = rack.findToolBrush(_leftDial()); if (b) { closeExclusive(); rack.openBrushSettings(b.id); } },
});

// ============ 当前笔（ResolvedBrush）——引擎唯一吃的不可变值 ============
// candidate 3 收敛成不可变值；candidate 1（toolStates dial）再把派生收成反应式 computed：
//   旧 refreshCurrentBrush() 手动 fan-out（8 处）→ currentBrush computed，从反应式 SSoT 自动重算。
//   SSoT = ① 当前工具 dial（toolStates，per-doc，reactive）② 活动预设（笔架，rackVersion 触发）③ 全局 color ④ 全局压感开关。
//   getBrushSettings 返回 _currentBrush；rack⟂engine 由「值」结构性保证（见 resolved-brush.js）。
// 当前笔 = 纯 computed（从反应式 SSoT 派生）。引擎只读 currentBrush.value（stroke begin 时取，非每 stamp）。
// dial(toolStates) / color / 压感 / tool / rackVersion 任一变 → 自动重算 → 下面 watch 同步 invalidateStamp。
// 各处旧的手动 refreshCurrentBrush() 全删（reactivity 替代散落 fan-out）。
// **必须纯**：computed 内不写 toolStates（GUID healing 回写用 findToolBrushPure 的纯版；写回留显式路径）。
const currentBrush = computed(() => {
  void dialReactive.rackVersion;   // 依赖笔架版本（编辑/重置预设后重算活动预设字段）
  const ts = state.toolStates[rack.getRackToolKey(dialReactive.tool)] || state.toolStates.brush;
  const preset = rack.findToolBrushPure(ts);   // 无笔架 → null → DEFAULT 兜底
  return resolveBrush({
    preset,
    size: ts.size, opacity: ts.opacity ?? 1.0, flow: ts.flow ?? 1.0,
    color: state.color,
    pressureToSize: state.pressureToSize,
    pressureToOpacity: state.pressureToOpacity,
  });
});
// 命令/反应桥：当前笔变 → 引擎 stamp 缓存失效（flush:sync 复刻旧 refreshCurrentBrush 的同步时机）。
// cb 守 input?.（boot 期 input 未建时的 dep 变动 = no-op）。这是「反应式 UI 态 ↔ 裸引擎态」唯一的桥，故意留命令式。
watch(currentBrush, () => { if (input?.brush?.invalidateStamp) input.brush.invalidateStamp(); }, { flush: "sync" });

// 当前工具的 dial（size/opacity/flow + activeBrushId），shapes/airbrush alias 到 brush。
function currentDials() {
  return state.toolStates[rack.getRackToolKey(editMode.current())] || state.toolStates.brush;
}


// 笔粗分段量化（_segPositions/sliderPosToSize/sizeToSliderPos/_sliderMaxPos/_stepFor/_quantizeSize）
// 已搬进 src/ui/brush-size.ts（纯 + node 测，form 与 dial 共用），见上方 import。


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
  getBrushSettings: () => currentBrush.value,
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
// v189 修 (user：「像素笔 Windows 又出黑框」)：旧 hint 只兜 filterBrush，像素笔/smudge 直接写 layer、
//   无 buffered overlay、又非 filterBrush → 漏。改用 input.isStrokeActive()（任一笔画进行中都强全屏，
//   含 brush/像素笔/smudge/liquify/filterBrush）；buffered 笔本就走 overlayProvider，这里冗余无害。
board.setStrokeActiveHint(() => input.isStrokeActive());
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

// ---- 主题 ----

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

// Brush rack 异步加载：boot 时拿 IDB 缓存，把 toolStates 缺失字段从 rack 补齐
// 然后应用当前 tool 的 state
const _backfillToolStates = () => {
  for (const t of Object.keys(state.toolStates)) {
    if (state.toolStates[t].activeBrushId == null) Object.assign(state.toolStates[t], rack.defaultToolStateFor(t));
  }
};
rack.load().then(() => {
  _backfillToolStates();
  rack.applyToolState(editMode.current());
  dialReactive.rackVersion++;
  setTimeout(() => { rack.checkCloud().catch(() => {}); rack.refreshCloudState(); }, 2000);
  // default-brushes.json 是 async fetch：fetch 回来后 retroactively merge 缺失默认笔。
  defaultsPromise().then(() => {
    const cur = rack.get();
    if (!cur) return;
    const merged = mergeMissingDefaults(cur);
    if (!merged) return;
    rack.setRack(merged);
    rack.persist().catch(() => {});
    _backfillToolStates();
    rack.applyToolState(editMode.current());
    dialReactive.rackVersion++;
  });
}).catch((e) => {
  console.warn("[brush-rack] init failed:", e);
  rack.setRack(makeDefaultRack());
  rack.applyToolState(editMode.current());
  dialReactive.rackVersion++;
  setStatus("笔架持久化失败（可能私密浏览）：本次 session 可用，重启会重置", true);
});


// Composition Root：core 单例 + 跨模块函数装进显式 ctx，传给每个 initX(ctx)（取代全局 rt）。
const ctx = {
  state, dialReactive, currentBrush, editMode, doc, board, input, history, pixelHistory,
  rack, store: _store, setStatus, withBusy, leftDial,
  updateSaveStatus,
  _suppressTransientPanels, _restoreTransientPanels, layerSpecFrom, _bringPanelTop,
  _commitTransform, _cancelTransform, selectionToNewLayer,
  afterDocChange: _afterDocChange,
  gallery: null,   // 晚绑（gallery 后建）
};
initColorPanel(ctx);
initTheme(ctx);
initLayersPanel(ctx);
initDocOps(ctx);
initSettingsMenu(ctx);
initFiltersAdjust(ctx);
initToolbar(ctx);

// size/opacity popup + 两个 slider 监听 + slider-DOM 同步已搬进 <LeftDial>（src/ui/left-dial.ts）。
// setSize/setOpacity 现在只写反应式 dial SSoT + LS；<LeftDial> 绑定 dial 自动反映 + 自闪 popup。
function setSize(v) {
  v = Math.max(1, Math.round(v));        // v104: clamp to int
  rack.writeCurrentToolSize(v);               // dial SSoT（反应式 → currentBrush + <LeftDial> 自动跟随）
  safeLSSet("webpaint.size", String(v));
}
function setOpacity(v) {
  rack.writeCurrentToolOpacity(v);            // dial SSoT（反应式）
  safeLSSet("webpaint.opacity", String(v));
}
// 老 setIntensity alias 给跨 v97 调用兜底
const setIntensity = setOpacity;
// 键盘 [ ] 调粗（v132: tool-aware dispatch）。max 从活动预设取（不再读 slider dataset）；popup 经 leftDial.flashSize()。
window.addEventListener("wp:adjsize", (e) => {
  const delta = e.detail;
  const t = editMode.current();
  if (t === "brush" || t === "eraser" || t === "smudge" || t === "filterBrush") {
    const maxPx = rack.findToolBrushPure(currentDials())?.size?.max || 200;
    // v134 [] step 按段量化：20内1, 50内2, 100内5, 200内10, 500内20, 1000内50
    const dir = Math.sign(delta) || 1;
    const curSize = currentDials().size;
    const step = _stepFor(curSize);
    const raw = curSize + dir * step;
    const next = Math.max(1, Math.min(maxPx, _quantizeSize(raw)));
    setSize(next);
    leftDial.flashSize();   // 闪 size popup（组件自持）
    if (board._cursor) {
      board.setCursor({ ...board._cursor, size: next });
    }
  }
  // 其他工具忽略（液化已 migrate 进 filterBrush）
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
  if (session.loadedDocIsNewer && !session.loadedDocNewerConfirmed) {
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

// ---- HSV 浮动色板（面板 chrome：开关 / 拖动 / 位置记忆。内容 = 色轮 Vue 组件）----
window.addEventListener("wp:toggleReference", () => referenceWindow.toggle());

// ---- 图层面板 ----
function _afterDocChange() {
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
}

// v123 把 layer op 抽成 named 函数：原 4 个 footer 按钮挪进 menu/popup
function _openImagePicker() {
  // v125 修 (user：「图层面板的导入图片不成功」)
  //   图库"导入照片"会 set _addImportAsNewDoc=true，如果用户取消 file picker
  //   flag 不会清。下次从图层面板导入会被路由到 importImageAsNewDoc（替换 doc），
  //   user 觉得"不成功"。这里强制 false 让图层面板入口走 importImageAsLayer
  _addImportAsNewDoc = false;
  els.oraFileInput.value = "";
  els.oraFileInput.click();
}
document.getElementById("layerImportPhotoBtn")?.addEventListener("click", _openImagePicker);
// v132 (user：「global 加删除当前图层」) 删当前 active layer

// In-app 通用 sheet：替代 alert / prompt / confirm（详见 feedback-no-system-dialog）。
// 返回 Promise，resolve 输入值 / true / null（取消）。

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
      adopt: async (blob, nm) => { const loaded = await decodeOraToDoc(blob); session.adopt(loaded, nm); },
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
  const name = session.name;
  if (!name || name === "未命名") return;
  if (els.galleryFull && !els.galleryFull.classList.contains("hidden")) return;   // 在图库（无活动画布）不 FF
  if (_store.edits.localDirty() || isCloudDirty(name)) return;                     // 仅干净（refresh 内还会再判，这里先省一次网络）
  _ffInFlight = true;
  try {
    const vp = { ...board.viewport };   // 视口是设备态：FF 换的是内容，别让本设备的 zoom/pan 跟着跳
    const res = await _store.flow.refresh(name, {
      isOnline: () => navigator.onLine !== false,
      localDirty: () => _store.edits.localDirty(),
      adopt: async (blob, nm) => { const loaded = await decodeOraToDoc(blob); session.adopt(loaded, nm); },
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
  const name = session.name;
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
  if (!session.docLastSavedAt) return "（未保存）";
  const d = new Date(session.docLastSavedAt);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}


// Per-row "⋯" 工具菜单：弹出 in-app popup（**不用** alert / prompt 等系统对话框）。
// 现在只有重命名一项；之后加复制图层 / 清空内容 / 合并下方 等。

// 从 Layer 拿一份 spec（含 pixel snapshot）—— add/remove handler 都用
// 「层 → spec」的形状归模型层（doc.layerSpec）；这里只是旧名兜底。
function layerSpecFrom(L) { return doc.layerSpec(L); }

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
// 色轮的 SV pad / 色相条 / HEX 输入 / 颜色换算全部搬进 src/ui/color-wheel.ts + color-model.ts
// （Vue 组件 + 纯模型）。这里只剩面板 chrome（toggleColorPanel + 拖动，见上）。

// ---- 持久化：IDB 自动 + Ctrl+S + autosave + visibility/pagehide 抢救 ----
// 抄 AtlasMaker shareback：Ctrl+S 主导 + 3min 兜底 + visibility/pagehide 抢救。
// 不走 debounce —— 画图工具不该 300ms 自动保存。
// 本地未落盘 = store.edits.localDirty()（派生自编辑游标，不再用独立的 _docDirty 标志）。
// transient busy（saving=IDB 写盘中 / pushing=云端 push 中）归 store（_store.busy，L4 ②b）——
// app 不再持 saving/pushing 全局变量；computeSaveState 只读 store。
// 活动文档生命周期 SSoT（指针/lazy/saved-at/newer-guard/autosave 接线）已切到 session-state.ts。
// 这里只剩 save-btn 4 态渲染（读 session.name + store），不再持任何 session-private 变量。

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
  if (_store.busy.pushing()) return "cloud-busy";
  if (_store.busy.saving()) return "saving";
  if (_store.edits.localDirty()) return "dirty";
  const st = _store.cloud.status(session.name, { signedIn: isSignedIn(), hasLocal: true });
  if (st === "dirty") return "cloud-dirty";     // 本地已存、云端未同步
  if (st === "synced") return "synced";         // 与云端一致
  return "local-only";                          // 未登录（含 cloud-only/absent，对本地视角=只本地）
}
function updateSaveStatus() {
  // gallery-first: 没绑 session → 隐藏 save btn（没东西可保存）
  if (!session.name) {
    els.topSaveBtn.dataset.state = "none";
    els.topSaveBtn.innerHTML = ICON_DISK;
    els.topSaveBtn.title = "未打开作品";
    return;
  }
  const state = computeSaveState();
  els.topSaveBtn.dataset.state = state;
  els.topSaveBtn.style.opacity = ""; els.topSaveBtn.style.color = "";   // 永不残留旧的灰/蓝 —— 云=可按态主题色（灰=不可按，禁用）
  const name = session.name;
  if (state === "cloud-busy") { els.topSaveBtn.innerHTML = ICON_CLOUD_BUSY; els.topSaveBtn.title = `上传中… · ${name}`; }
  else if (state === "saving")      { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `保存中… · ${name}`; }
  else if (state === "dirty")  { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `保存 + 推送 (Ctrl+S) · ${name} · 未保存`; }
  else if (state === "cloud-dirty") { els.topSaveBtn.innerHTML = ICON_UPLOAD; els.topSaveBtn.title = `推送到云端 (Ctrl+S) · ${name} · 本地已存，云端未同步`; }
  else if (state === "synced") {
    // synced = 云✓（上次保存时已同步）。中性可按态色；点击=检查云端有没有新版本（动作走 tooltip+行为）。
    els.topSaveBtn.innerHTML = ICON_CLOUD_CHECK;
    els.topSaveBtn.title = `已同步云端（上次保存时）· 点击检查是否有新版本 · ${name}`;
  }
  else                          { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `已存本地（IDB 易失，登录云端更安全） · ${name}`; }
}
// saveNow / adoptLoadedDoc / saveAndPush / newDoc / rename / exit / pull / checkpoint
// 全切到 session-state.ts（活动文档生命周期 SSoT）。app 这边只经 session.* 调用。

// 笔触结束 / undo / redo / 图层操作（任何 wp:histchange）→ dirty。这是 work-file 的**唯一编辑门**。
// store.edit(name) 一处吸：推编辑游标(local-dirty) + 经门标云脏(捕 parentBase；不 gate signedIn)。
// name 空（gallery-first 未绑 session）→ 只推游标。门机制全在库内（app 不再直调 setCloudDirty，ADR-0016 §4）。
window.addEventListener("wp:histchange", () => {
  if (session.loadingDoc) return;             // 加载/采纳/FF 期间 clearHistory 派发的 histchange 不算编辑（不标脏）
  _store.edit(session.name || null);
  if (!session.name) return;                  // gallery-first: 无绑 session 时不刷 save 按钮
  updateSaveStatus();
});
// saveAndPush / renameCurrentSession / coalescer+autosave 接线全切到 session-state.ts。
// Ctrl+S = 完整保存（本地 + 云端）；Ctrl+Shift+S = 只存本地（不推云）。合流状态机在 Store（_store.session）。
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    _store.session.request(e.shiftKey ? "local" : "push");
  }
});
// autosave configure/start + visibility/pagehide flush 已切到 session-state.ts initSession。
// v115: Ctrl+Shift+R / 关 tab / 浏览器返回 前弹挽留 + 偷偷本地备份
// (user：「可以弹挽留对话框，应该弹」+「挽留的时候偷偷本地备份」)
// 1. beforeunload 是唯一能 block 浏览器的钩子；对话框内容浏览器自管
// 2. dialog 弹出时浏览器暂停 UI 但 JS async 还在跑 → 偷偷起 saveNow，user 看 dialog 时
//    后台 IDB transaction 大概率能跑完；user 选「留下」→ 成果保住，选「离开」→
//    至少有 dialog 那一两秒救了
window.addEventListener("beforeunload", (e) => {
  if (_store.edits.localDirty() && !_store.busy.saving()) {
    e.preventDefault();
    e.returnValue = "";
    // 偷存（implicit 只写 IDB 不推云）；不 await 让 dialog 立刻起。flush 内部再判一次 dirty/busy（无害）
    _store.autosave.flush().catch(() => {});
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
  const name = session.name;
  // synced（无可存可推）→ 按钮兼作「刷新云端态」（ADR-0017，点一下 = 现场查云 + 干净则快进）；否则正常存/推。
  if (name && name !== "未命名" && isSignedIn() && !_store.edits.localDirty() && !isCloudDirty(name)) {
    maybeFastForwardActive({ manual: true });
  } else {
    _store.session.request("push");
  }
});

// ---- topbar：adjustments popup（液化 / 后续调色 etc）----
// 单按钮 → 弹一列 menu-item（同 menuPanel 模式）。学 Procreate adjustments icon。

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
// candidate 2：导出格式同样可插件注册（下载插件 → registerExporter）
window.WebPaint.registerExporter = registerExporter;
window.WebPaint.listExporters = listExporters;
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
document.getElementById("topGalleryBtn")?.addEventListener("click", () => session.exit());
els.menuGallery?.addEventListener("click", () => { setMenuOpen(false); session.exit(); });

// ---- 菜单：导入 / 导出 / 剪贴板 / 适应 ----
els.menuRename.addEventListener("click", () => {
  setMenuOpen(false);
  session.rename();
});
// v125 (user：「菜单加另存为（画库 + 名字冲突检查）」)
//   "另存为" = 当前 doc 复制到新名字 session（原 session 保留）。
//   完成后切到新 session 继续编辑（Photoshop 语义）。同名检查本地 + 云端。
els.menuSaveAs.addEventListener("click", async () => {
  setMenuOpen(false);
  editMode.applyPendingTransient();
  const oldName = session.name || "未命名";
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
        encode: () => session.encodeOra(),
        cloud: cloudOn,
      });
      session.setName(trimmed);
      _store.edits.markSaved();
      session.markSavedNow();
      updateSaveStatus();
      if (!cloudOn) setStatus(`已另存为：${trimmed}`);
      else if (res.cloudDeferred) setStatus(`已另存为（仅本地）：${trimmed}（云端稍后 Ctrl+S 推）`);
      else setStatus(`已另存为（含云端）：${trimmed}`);
      gallery.refresh();
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
  if (!session.name) { setStatus("没活动 session", true); return; }
  const cp = await session.readCheckpoint(session.name);
  if (!cp || !cp.blob) {
    setStatus("没找到本次打开时的快照", true);
    return;
  }
  const ageMin = Math.max(1, Math.round((Date.now() - (cp.at || session.sessionOpenedAt)) / 60000));
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
    session.adoptWithOpts(loaded, session.name, { skipCheckpoint: true });
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
  if (epEl) epEl.textContent = "." + ((getExporter(ep.format) || getExporter("ora")).ext);
  if (eiEl) eiEl.textContent = `${ei.format.toUpperCase()} · ${ei.scope === "active" ? "当前层" : "合并"} · ${ei.target === "clipboard" ? "剪切板" : "文件"}`;
  if (iiEl) iiEl.textContent = `${ii.source === "clipboard" ? "剪切板" : "文件"} · 新图层`;
}
_updateMenuSubLabels();

els.menuExportProject.addEventListener("click", async () => {
  setMenuOpen(false);
  const exp = getExporter(_getExpPrj().format) || getExporter("ora");
  try {
    if (exp.busyHint) setStatus(exp.busyHint, true);
    const blob = await exp.encode(doc);
    triggerDownload(blob, `${session.name}.${exp.ext}`);
    setStatus(`.${exp.ext} 已下载`);
  } catch (e) { setStatus("导出失败：" + (e && e.message || e)); }
});
els.menuExportImage.addEventListener("click", async () => {
  setMenuOpen(false);
  const c = _getExpImg();
  try {
    if (c.target === "clipboard") {
      // 剪贴板恒为 PNG（ClipboardItem image/png）——格式选择只作用于文件/分享路径
      await copyImageToClipboard(doc, c.scope);
      setStatus(`已复制 PNG 到剪贴板（${c.scope === "active" ? "当前层" : "合并"}）`);
    } else {
      const exp = getExporter(c.format) || getExporter("png");
      if (exp.busyHint) setStatus(exp.busyHint, true);
      const blob = await exp.encode(doc, { scope: c.scope });
      const r = await shareOrDownloadBlob(blob, `${session.name}-${stampNow()}.${exp.ext}`, exp.mime);
      setStatus(r.method === "share" ? "分享面板已开" : r.method === "cancel" ? "取消分享" : `${exp.ext.toUpperCase()} 已下载`);
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
  const fmtRadios = listExportersByKind("project").map((exp) =>
    `<label><input type="radio" name="fmt" value="${exp.id}" ${c.format === exp.id ? "checked" : ""} /> ${exp.label}</label>`
  ).join("");
  _openMenuConfigPopup(e.currentTarget, `
    <div class="menu-config-section">
      <div class="menu-config-title">格式</div>
      ${fmtRadios}
    </div>
  `, (popup) => {
    const fmt = popup.querySelector('input[name="fmt"]:checked')?.value || "ora";
    _setExpPrj({ format: fmt });
  });
});
els.menuExportImageConfig.addEventListener("click", (e) => {
  e.stopPropagation();
  const c = _getExpImg();
  const fmtRadios = listExportersByKind("image").map((exp) =>
    `<label><input type="radio" name="fmt" value="${exp.id}" ${c.format === exp.id ? "checked" : ""} /> ${exp.label}</label>`
  ).join("");
  _openMenuConfigPopup(e.currentTarget, `
    <div class="menu-config-section">
      <div class="menu-config-title">格式</div>
      ${fmtRadios}
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
  rack.reset(true);   // 恢复出厂 resetAt watermark + 重置 toolStates + persist + applyToolState + bump
  setRackDirty(true);
  if (isSignedIn()) rack.syncCloud();
  setStatus(`笔架已重置（${rack.get().brushes.length} 个 brush）`, true);
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
      session.adopt(loaded, nm);
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
  if (_store.edits.localDirty()) await session.save();
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
  session.setName(name);
  input.clearHistory();
  board.invalidateAll();
  board.fitToScreen();
  renderLayersPanel();
  _store.edits.mark();
  session.resetSavedAt();
  updateSaveStatus();
  await session.save();
  // v133 revert checkpoint
  session.markOpenedNow();
  session.writeCheckpoint(name).catch((e) => console.warn("[revert] photo-import checkpoint:", e));
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
// 退出画布回图库（保存 + 切指针 + 关库）= session.exit()，定义在 session-state.ts。
// gallery-first 设计：用 session.name == null 区分 gallery 状态。
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

// 等云端 push 完成（防 status race）= session.awaitCloudPushIdle()，定义在 session-state.ts。

// trash-bar / add / trash 按钮的可见性随视图（旧 renderGallery 内联，现 app chrome 显式管）。
function _galleryChrome(view) {
  els.galleryTrashBar?.classList.toggle("hidden", view !== "trash");
  els.galleryAddBtn?.classList.toggle("hidden", view === "trash");
  els.galleryTrashBtn?.classList.toggle("hidden", view === "trash");
}

async function setGalleryOpen(open) {
  if (open) {
    // 进图库 = 用户离开编辑场景 → apply 所有 pending transient（套索浮层等）+ 保存
    editMode.applyPendingTransient();
    if (_store.edits.localDirty() && !_store.busy.saving()) await session.save();
    await session.awaitCloudPushIdle();   // 等 cloud push 完，防 status race
    document.body.dataset.mode = "gallery";
    els.galleryFull.classList.remove("hidden");
    _galleryChrome("files");      // 每次进默认 files 视图（避免上次留在 trash 里的混乱）
    gallery.setView("files");     // setView 内含 reload
    updateIdbUsage();
  } else {
    editMode.applyPendingTransient();
    if (_store.edits.localDirty() && !_store.busy.saving()) await session.save();
    els.galleryFull.classList.add("hidden");
    delete document.body.dataset.mode;
    // 关闭可能打开的 popup
    els.galleryAddPopup.classList.add("hidden");
    els.cloudAccountPopup.classList.add("hidden");
    els.galleryMenuPopup?.classList.add("hidden");
    board.requestRender();
  }
}

// 加号 popup
// ===== 图库 = <Gallery> 深模块（src/ui/gallery.ts）。app 只供画布耦合 host 回调 + 无系统弹窗 UI =====
const gallery = mountGallery(document.getElementById("galleryMount"), {
  signedIn: () => isSignedIn(),
  online: () => navigator.onLine !== false,
  activeName: () => session.name,
  confirm: (t, m) => openConfirmSheet(t, m),
  input: (t, d, o) => openInputSheet(t, d, o),
  chooseFolder: async (title, message, options) => {
    const v = await lockSyncGate({ title, message, showSpinner: false, actions: [...options, { label: "✕ 取消", value: "__cancel__" }] });
    return (v == null || v === "__cancel__") ? null : v;
  },
  status: (m, e) => setStatus(m, e),
  busy: (label, fn) => withBusy(label, fn),
  // 画布耦合操作（open/push/unload/rename/exit/setName）gallery.ts 直调 session.*，不再经 host。
});

// 晚绑 rt（gallery 是 const，非 hoisted）+ 云账号 UI init（src/cloud-auth-ui.ts）
ctx.gallery = gallery;
// candidate 3 · 活动文档生命周期：把晚声明的 app-local 协作件补进 ctx 后 init session-state。
// referenceWindow/paletteWindow 是 const（前面已声明）；其余是 hoisted function 声明，引用安全。
Object.assign(ctx, {
  referenceWindow, paletteWindow,
  updateNewerBanner,
  setColor, applyCheckerboard, renderLayersPanel,
  setGalleryOpen, gateCloudSyncOnOpen, checkQuotaAndWarn, uniqueLocalName,
  getLocalSavedAtLabel,
  showFullscreenBusy, hideFullscreenBusy,
});
setSessionGallery(gallery);   // session 的晚绑 gallery handle
initSession(ctx);
initCloudAuthUI(ctx);

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
  const fullPath = pathJoin(gallery.getFolder(), trimmed);
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
  gallery.refresh();
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
  els.newDocName.value = gallery.getFolder() ? `${gallery.getFolder()}/…` : "…";   // 占位，下面 async 填日期名
  els.newDocPreset.value = "2048";
  els.newDocCustomRow.style.display = "none";
  els.newDocW.value = doc.width;
  els.newDocH.value = doc.height;
  els.newDocBackdrop.classList.remove("hidden");
  els.newDocSheet.classList.remove("hidden");
  // yyyymmdd-N（避让本地+云重名）。folder 前缀保留（落当前子文件夹）。
  const next = await _nextDocName(gallery.getFolder());
  els.newDocName.value = gallery.getFolder() ? `${gallery.getFolder()}/${next}` : next;
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
  // doc 替换 + 落盘 + 切指针 + checkpoint + 关库全在 session.newDoc（session-state.ts）。
  await session.newDoc({ name, w, h });
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

// 云端拉取 + 自动打开 = session.pull(path)，定义在 session-state.ts。

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
    if (!els.galleryFull.classList.contains("hidden")) gallery.refresh();
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
  if (!els.galleryFull.classList.contains("hidden")) gallery.refresh();
});
// 在线 / 离线变化时刷新云端 UI（标签 / 按钮可见性）。
// online 时尝试 silent re-auth：boot 离线 → activeAccount 为 null；有网了主动 retry 一次
window.addEventListener("online", async () => {
  if (!isSignedIn()) await retrySilentSignIn();
  updateCloudAuthUI();
  if (!els.galleryFull.classList.contains("hidden")) gallery.refresh();
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
    session.setName(null);
    updateSaveStatus();
    await setGalleryOpen(true);
    return;
  }
  try {
    const loaded = await loadCurrentSession();
    if (!loaded) {
      // 上次记录的 name 在 IDB 没了 → 停 gallery
      session.setName(null);
      updateSaveStatus();
      await setGalleryOpen(true);
      setStatus(`找不到上次画作 "${wantedName}"，先选一个或新建`);
      return;
    }
    session.adopt(loaded, wantedName);
    setStatus(`已恢复：${wantedName} (${loaded.layers.length} 层)`);
    gateCloudSyncOnOpen(wantedName).catch((e) => console.warn("[sync-gate]", e));
  } catch (e) {
    console.warn("[session] load failed:", e);
    session.setName(null);
    updateSaveStatus();
    await setGalleryOpen(true);
    setStatus(`启动加载 "${wantedName}" 失败：${e && e.message || e}`, true);
  }
})();

// 笔架深模块装配：mount sheet/settings 组件 + rackStore.configure + 注册 panel + 绑 DOM 事件。
rack.init({
  els: {
    rack: {
      sheet: document.getElementById("brushRackSheet"),
      title: document.getElementById("brushRackTitle"),
      close: document.getElementById("brushRackClose"),
      importBtn: document.getElementById("brushRackImport"),
      newBtn: document.getElementById("brushRackNew"),
      mount: document.getElementById("rackSheetMount"),
      exportFolderBtn: document.getElementById("brushRackExportFolder"),
      cloudPushBtn: document.getElementById("brushRackCloudPush"),
      resetBtn: document.getElementById("brushRackReset"),
      dumpCodeBtn: document.getElementById("brushRackDumpCode"),
    },
    settings: {
      view: document.getElementById("brushSettingsView"),
      body: document.getElementById("brushSettingsBody"),
      save: document.getElementById("brushSettingsSave"),
      cancel: document.getElementById("brushSettingsCancel"),
    },
  },
  icons: { check: ICON_CLOUD_CHECK, busy: ICON_CLOUD_BUSY, upload: ICON_UPLOAD, disk: ICON_DISK },
  blendModes: LAYER_MODE_LABEL,
  RACK_PANEL_BY_TOOL,
});

// canvas pointerdown → 关 exclusive panel（user：「画画时别让 panel 挡着」）
els.board.addEventListener("pointerdown", () => {
  if (getCurrentExclusive()) closeExclusive();
}, { capture: true });   // capture 在 input.js 处理 stroke 之前


// ---- PWA 外壳：service-worker 注册 + 更新 toast + dev chip（src/pwa-shell.ts）----
new PwaShell({
  toast: els.updateToast,
  reloadBtn: els.updateReload,
  dismissBtn: els.updateDismiss,
  envChip: document.getElementById("envChip"),
  onBeforeReload: async () => {
    editMode.applyPendingTransient();
    if (_store.edits.localDirty() && !_store.busy.saving()) await session.save();
  },
  onForeground: () => showIdleLockIfStale(),
}).init();
