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
import { PixelEdit } from "./pixel-edit.js";   // compressPixelSnap/applyPixelSnap 切到 layer-undo/topbar-menu
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
import { referenceWindow, paletteWindow, initSideWindows } from "./side-windows.ts";   // 参考/调色板浮窗（construct+wiring）
import { initDevConsole } from "./dev-console.ts";   // window.WebPaint 调试接口
import { mountColorWheel } from "./ui/color-wheel.ts";   // UI 深化 candidate 1 · Vue pilot
import { mountBrushSettings } from "./ui/brush-settings.ts";   // candidate 1 · 笔设置编辑器
import { mountGallery } from "./ui/gallery.ts";          // candidate 1 · 图库深模块
import { shareOrDownloadJSON, exportBrush, exportRackFolder, buildRackCode } from "./brush-io.ts";
import { BrushRack } from "./brush-rack.ts";
import { PwaShell } from "./pwa-shell.ts";
import { openInputSheet, openConfirmSheet, lockSyncGate, unlockSyncGate } from "./sheets.ts";   // settleSyncGate→cloud-freshness
import { els } from "./els.ts";
import { safeLSSet } from "./safe-ls.ts";   // safeLS seeding 已随 editor-state 搬走
import { applyTheme, cycleTheme, THEME_LABEL, initTheme } from "./theme.ts";
import { initLayersPanel, renderLayersPanel, toggleLayersPanel, LAYER_MODE_LABEL } from "./layers-panel.ts";
import { initDocOps, _updateMenuCropLabel } from "./doc-ops.ts";
import { initCloudAuthUI, updateCloudAuthUI } from "./cloud-auth-ui.ts";
import { initSettingsMenu, applyCheckerboard } from "./settings-menu.ts";   // setMenuOpen→各菜单模块
import { initFiltersAdjust, setAdjustOpen } from "./filters-adjust.ts";
import { initToolbar, setTool, RACK_PANEL_BY_TOOL, updateLassoToolbar } from "./toolbar.ts";
import { setColor, toggleColorPanel, initColorPanel } from "./color-panel.ts";
import { session, initSession, setSessionGallery } from "./session-state.ts";   // candidate 3 · 活动文档生命周期 SSoT
import { createEditorState } from "./editor-state.ts";   // candidate 3 · 编辑器 RAM 反应式 SSoT（dial/color/压感）
import { showFullscreenBusy, hideFullscreenBusy, withBusy } from "./fullscreen-busy.ts";
import { initSmoothDevPanel } from "./smooth-dev-panel.ts";
import { selectionToNewLayer, _makeFullLayerSelection, initSelectionOps } from "./selection-ops.ts";
import { updateSaveStatus, updateNewerBanner, ICON_DISK, ICON_UPLOAD, ICON_CLOUD_CHECK, ICON_CLOUD_BUSY } from "./save-status.ts";
import { initTransientPanels, _suppressTransientPanels, _restoreTransientPanels, _bringPanelTop, _commitTransform, _cancelTransform } from "./transient-panels.ts";
import { initLayerUndo, _afterDocChange, layerSpecFrom } from "./layer-undo.ts";
import { gateCloudSyncOnOpen, getLocalSavedAtLabel, showIdleLockIfStale, initCloudFreshness } from "./cloud-freshness.ts";   // maybeFastForwardActive→topbar-menu
import { initImportImage, importImageAsLayer } from "./import-image.ts";   // importImageAsNewDoc/setAddImportAsNewDoc 仅 gallery-shell/export-menu 用
import { initExportImportMenu } from "./export-import-menu.ts";
import { initGalleryShell, setGalleryOpen, checkQuotaAndWarn, uniqueLocalName } from "./gallery-shell.ts";
import { initTopbarMenu } from "./topbar-menu.ts";
import { mountLeftDial } from "./ui/left-dial.ts";   // candidate 1 Step 2 · 左栏 dial（size/opacity/笔指示/popup）
import { mountRackSheet } from "./ui/rack-sheet.ts";   // candidate 1 · 笔架 sheet（folder tabs + 笔 grid）
import { stepFor as _stepFor, quantizeSize as _quantizeSize } from "./ui/brush-size.ts";   // [ ] 键盘调粗用（slider 映射在 <LeftDial>）
import { computed, watch } from "../vendor/vue/vue.esm-browser.prod.js";   // candidate 1 · currentBrush computed + 引擎桥 watch
import {
  loadCurrentSession, listSessions,
  getCurrentSessionName,
} from "./session.js";   // 剪贴板/下载/分享 → export-import-menu / selection-ops
// Selection 切到 selection-ops.ts；smooth-config（SMOOTH/saveSmooth/resetSmooth）切到 smooth-dev-panel.ts
import { fillResampleSelect } from "./resample.js";   // 图片解码/缩放 → import-image / side-windows
import { pathJoin } from "./gallery-path.js";   // pathFolder/pathBasename 切到 session-state.ts / gallery.ts
import { mergeLocalCloud, sliceFolder, folderHasContents } from "./gallery-model.js";
import { collectFolders, brushesInFolder } from "./brush-rack-view.js";
// v132 (user：「所有 color adjustment 做成第一方默认安装的插件」)
//   filters.js 只剩 Filter 契约 + registry + helper；
//   每个调色器在 src/plugins/ 自成一文件，import 时自注册
import { getFilter, onFilterRegistered } from "./filters.js";   // listFilters/registerFilter → dev-console
import "./plugins/index.js";    // 触发 HSB / ColorBalance / Curves / SharpenBlur 自注册
// candidate 2：导出格式 = 注册表插件（含第一方 ora/psd/png/jpg 自注册）
import { getItemByPath, deleteItem, ensureSubfolder, clearFolderCaches } from "./app-store.js";
import {
  isAuthConfigured, initAuth, signOut, isSignedIn, getActiveAccount, retrySilentSignIn,
  listCloudAll, listCloudFolders,
  listCloudTrash,
  setLastSessionSignedIn,
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

// transient 面板抑制·复原 + panel z-order bringTop + transform commit/cancel 护栏 = transient-panels.ts。

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
// 剪贴板 / 复制为浮层 / 选区提取（wp:copy/paste/duplicateFloat + selectionToNewLayer）= selection-ops.ts。

// 桌面拖拽图片到画布（dragover/drop）= import-image.ts initImportImage。

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
  updateSaveStatus, updateZoomLabel,
  _suppressTransientPanels, _restoreTransientPanels, layerSpecFrom, _bringPanelTop,
  _commitTransform, _cancelTransform, selectionToNewLayer,
  importImageAsLayer,   // selection-ops 的 Ctrl+V 粘贴 / drop 用（hoisted function）
  afterDocChange: _afterDocChange,
  gallery: null,   // 晚绑（gallery 后建）
};
initColorPanel(ctx);
initTheme(ctx);
initLayersPanel(ctx);
initDocOps(ctx);
initSettingsMenu(ctx);
initExportImportMenu(ctx);
initFiltersAdjust(ctx);
initToolbar(ctx);
initSelectionOps(ctx);
initSmoothDevPanel(ctx);
initTransientPanels(ctx);
initLayerUndo(ctx);
initSideWindows(ctx);

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
// undo/redo 按钮 + 清空图层 sheet + openSheet/closeSheet = topbar-menu.ts。

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
// 文档版本 newer banner + save 按钮 4 态渲染 = save-status.ts。
// hook board render 更新 HUD
const origRender = board.render.bind(board);
board.render = function () {
  origRender();
  updateZoomLabel();
};

// 保存触发（wp:histchange dirty 门 / Ctrl+S / beforeunload）= topbar-menu.ts。
// 死 tile 图标 ICON_LOCAL/CLOUD_SOLID/SYNCED/PENDING 已删（无消费者）。

// 顶栏 save 按钮点击 = topbar-menu.ts。

// window.WebPaint 调试/POC 控制台接口 = dev-console.ts。
initDevConsole();
// adjust 面板拖动 = topbar-menu.ts。

// 顶栏图库按钮 + 汉堡菜单项（rename/saveAs/revert/fit/brushSettings/gallery）= topbar-menu.ts。

// 参考小窗 + 调色板小窗（构造 + resize + 按钮接线）= side-windows.ts。

// 平滑调参 dev 面板（menuSmoothDev → 浮层）= smooth-dev-panel.ts（initSmoothDevPanel）。

// 强制清缓存重启 + 重置笔架 菜单项 = topbar-menu.ts。

// 参考图 menu/load/live/fit 按钮接线 = side-windows.ts initSideWindows。

// 图片/.ora 导入（oraFileInput 派发 / importImageAsNewDoc / importImageAsLayer / _openBigImportSheet）= import-image.ts。

// ---- 图库 全屏（v50 重做：无返回键、底栏 IDB 占用 + 清扫、加号 popup、云图标 popup） ----
// 退出画布回图库（保存 + 切指针 + 关库）= session.exit()，定义在 session-state.ts。
// gallery-first 设计：用 session.name == null 区分 gallery 状态。
// localStorage.webpaint.currentSessionName 真实持久化 active session name；
// 空字符串 = "在 gallery 没绑定任何画作"，refresh 后停 gallery。

// 锚定 popup 定位 helper（openAnchoredPopup/closeAnchoredPopup/toggleAnchoredPopup/anchorPopupToBtn）= anchored-popup.ts。
// withBusy / showFullscreenBusy / hideFullscreenBusy = fullscreen-busy.ts。
// 等云端 push 完成（防 status race）= session.awaitCloudPushIdle()，定义在 session-state.ts。

// 图库外壳（setGalleryOpen/chrome/新建sheet/IDB占用/配额/popup接线/uniqueLocalName）= gallery-shell.ts。
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
initCloudFreshness(ctx);   // 前台云端新鲜度（需 board/withBusy/setStatus/updateSaveStatus）
initImportImage(ctx);      // 图片/.ora 导入（需 late ctx：applyCheckerboard/renderLayersPanel/setGalleryOpen/uniqueLocalName）
initGalleryShell(ctx);     // 图库外壳（需 ctx.gallery + late keys）
initTopbarMenu(ctx);       // 顶栏/菜单/sheet/save 触发 事件接线（需 ctx.gallery）
initCloudAuthUI(ctx);

// (galleryCloseBtn 已删除 gallery-first，无 close-back-to-canvas 按钮)
// 加号/云/图库菜单 popup 的开启接线 = gallery-shell.ts initGalleryShell。
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

// 加号 popup 的 新建/导入照片/剪贴板新建 接线 = gallery-shell.ts initGalleryShell。

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

// 新建作品 sheet / IDB 占用 / 配额警告 / humanTime/Size / uniqueLocalName = gallery-shell.ts。

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

// 前台新鲜度活动监听 + idle tick 接线已切到 cloud-freshness.ts initCloudFreshness。
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
