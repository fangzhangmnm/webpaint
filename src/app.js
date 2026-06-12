// app.js —— Composition Root（组合根）。**只装配，不实现业务**。
//
// 职责：构造核心单例（doc / board / input / editMode / history / pixelHistory / rack / currentBrush）→
//   组一个显式 ctx → 调各深模块的 initX(ctx) 接线 → 挂 boot 加载 / auth / PWA 外壳。
//   god-file 已肢解：UI 与业务分散到单一职责模块（session-state / editor-state / gallery-shell /
//   topbar-menu / cloud-freshness / import-image / export-import-menu / side-windows / selection-ops /
//   layer-undo / transient-panels / save-status / smooth-dev-panel / platform-guards / dev-console /
//   anchored-popup / fullscreen-busy …）。每个模块 export 函数 + initX(ctx) 绑 app 单例。
//
// 状态归属（SSoT）：
//   PaintDoc        ← 画布像素（layers）              Board ← 视口 + 渲染
//   EditMode        ← 工具 / transient 相位            editor-state ← 反应式 RAM dial（color/size/压感）
//   session-state   ← 活动文档生命周期（存/换/退）     Store(app-store) ← 本地+云同步机制
//   currentBrush    ← 不可变 ResolvedBrush（从 dial+预设纯派生，引擎唯一吃）

import { WEBPAINT_VERSION } from "./version.js";
import { PaintDoc } from "./doc.js";
import { Board } from "./board.js";
import { InputController } from "./input.js";
import { PixelEdit } from "./pixel-edit.js";   // compressPixelSnap/applyPixelSnap 切到 layer-undo/topbar-menu
import { resolveBrush } from "./resolved-brush.js";
import { makeDefaultRack, mergeMissingDefaults, defaultsPromise } from "./brushes.js";
import { registerPanel, openExclusive, closeExclusive, getCurrentExclusive } from "./panel-state.js";
import { UndoStack } from "./history.js";
import { EditMode } from "./edit-mode.js";
import { referenceWindow, paletteWindow, initSideWindows } from "./side-windows.ts";   // 参考/调色板浮窗（construct+wiring）
import { initDevConsole } from "./dev-console.ts";   // window.WebPaint 调试接口
import { mountGallery } from "./ui/gallery.ts";          // candidate 1 · 图库深模块
import { BrushRack } from "./brush-rack.ts";
import { PwaShell } from "./pwa-shell.ts";
import { openInputSheet, openConfirmSheet, lockSyncGate } from "./sheets.ts";   // settleSyncGate→cloud-freshness
import { setPasswordPrompt } from "./crypto-state.js";   // 加密：密码弹窗注入（ADR-0012）
import { ensureUnlocked } from "./enc-thumbs.js";        // boot load 加密作品：busy 外解锁
import { els } from "./els.ts";
import { safeLSSet } from "./safe-ls.ts";   // safeLS seeding 已随 editor-state 搬走
import { initTheme } from "./theme.ts";
import { initLayersPanel, renderLayersPanel, LAYER_MODE_LABEL } from "./layers-panel.ts";
import { initDocOps } from "./doc-ops.ts";
import { initCloudAuthUI, updateCloudAuthUI } from "./cloud-auth-ui.ts";
import { initSettingsMenu, applyCheckerboard } from "./settings-menu.ts";   // setMenuOpen→各菜单模块
import { initFiltersAdjust } from "./filters-adjust.ts";
import { initToolbar, RACK_PANEL_BY_TOOL } from "./toolbar.ts";
import { setColor, initColorPanel } from "./color-panel.ts";
import { session, initSession, setSessionGallery } from "./session-state.ts";   // candidate 3 · 活动文档生命周期 SSoT
import { createEditorState } from "./editor-state.ts";   // candidate 3 · 编辑器 RAM 反应式 SSoT（dial/color/压感）
import { showFullscreenBusy, hideFullscreenBusy, withBusy } from "./fullscreen-busy.ts";
import { initSmoothDevPanel } from "./smooth-dev-panel.ts";
import { selectionToNewLayer, initSelectionOps } from "./selection-ops.ts";
import { updateSaveStatus, updateNewerBanner, ICON_DISK, ICON_UPLOAD, ICON_CLOUD_CHECK, ICON_CLOUD_BUSY } from "./save-status.ts";
import { initTransientPanels, _suppressTransientPanels, _restoreTransientPanels, _bringPanelTop, _commitTransform, _cancelTransform } from "./transient-panels.ts";
import { initLayerUndo, _afterDocChange, layerSpecFrom } from "./layer-undo.ts";
import { gateCloudSyncOnOpen, getLocalSavedAtLabel, showIdleLockIfStale, initCloudFreshness } from "./cloud-freshness.ts";   // maybeFastForwardActive→topbar-menu
import { initImportImage, importImageAsLayer } from "./import-image.ts";   // importImageAsNewDoc/setAddImportAsNewDoc 仅 gallery-shell/export-menu 用
import { initExportImportMenu } from "./export-import-menu.ts";
import { initGalleryShell, setGalleryOpen, checkQuotaAndWarn, uniqueLocalName } from "./gallery-shell.ts";
import { initTopbarMenu } from "./topbar-menu.ts";
import { initPlatformGuards } from "./platform-guards.ts";
import { mountLeftDial } from "./ui/left-dial.ts";   // candidate 1 Step 2 · 左栏 dial（size/opacity/笔指示/popup）
import { stepFor as _stepFor, quantizeSize as _quantizeSize } from "./ui/brush-size.ts";   // [ ] 键盘调粗用（slider 映射在 <LeftDial>）
import { computed, watch } from "../vendor/vue/vue.esm-browser.prod.js";   // candidate 1 · currentBrush computed + 引擎桥 watch
import { getCurrentSessionName } from "./session.js";
import { decodeOraToDoc } from "./ora.js";   // boot 恢复：flow.load 解壳后的明文 → doc
// Selection 切到 selection-ops.ts；smooth-config（SMOOTH/saveSmooth/resetSmooth）切到 smooth-dev-panel.ts
// v132 (user：「所有 color adjustment 做成第一方默认安装的插件」)
//   filters.js 只剩 Filter 契约 + registry + helper；
//   每个调色器在 src/plugins/ 自成一文件，import 时自注册
import "./plugins/index.js";    // 触发 HSB / ColorBalance / Curves / SharpenBlur 自注册
// candidate 2：导出格式 = 注册表插件（含第一方 ora/psd/png/jpg 自注册）
import { isAuthConfigured, initAuth, isSignedIn, retrySilentSignIn, setLastSessionSignedIn, rackStore, setRackDirty, store as _store } from "./app-store.js";   // cut-over：cloud/auth/graph 全走 lib




// cut-over 完成：_store 从 app-store import（接 lib）。explicit 保存恒走 store.flow.push（B1/B2/B5/retry/C4）。

// ---- 启动 ----
// 加密（ADR-0012）：密码弹窗接线 —— crypto-state 无 DOM，composition root 把 in-app
// 输入 sheet 注入进去（守「无系统对话框」红线）。必须在任何 decode 之前（boot load 可能是加密作品）。
setPasswordPrompt(({ title, message }) =>
  openInputSheet(title || "输入密码", "", { placeholder: "图库密码", password: true, message: message || "" }));

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
// pointer 自愈 + iPad/触屏系统手势拦截 = platform-guards.ts initPlatformGuards。

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

// ---- 笔架 boot：异步加载 + toolStates 补齐 ----
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
initPlatformGuards(ctx);

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

// v236 加密常驻指示（顶栏小锁 + 菜单 label）：反应式跟 session.enc.encrypted。
watch(() => session.enc.encrypted, (enc) => {
  els.topEncLock?.classList.toggle("hidden", !enc);
  if (els.menuEncryptLabel) els.menuEncryptLabel.textContent = enc ? "解除加密…" : "加密保护…";
}, { immediate: true });
els.topEncLock?.addEventListener("click", () => session.decryptCurrent());

// 图库 popup 开启/关闭 + 菜单代理 + 新建文件夹 + 新建作品 sheet + IDB 占用/配额 = gallery-shell.ts。

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
    // boot load 走 store.flow.load（明文原样；加密容器需先解锁）。boot 不在 busy → 可弹密码框。
    let r = await _store.flow.load(wantedName);
    if (r.status === "locked") {
      if (await ensureUnlocked(wantedName)) r = await _store.flow.load(wantedName);
    }
    if (r.status !== "loaded") {
      // IDB 没了 / 加密未解锁（取消）→ 停 gallery
      session.setName(null);
      updateSaveStatus();
      await setGalleryOpen(true);
      setStatus(r.status === "locked"
        ? `「${wantedName}」是加密作品（已取消解锁）——从图库再打开`
        : `找不到上次画作 "${wantedName}"，先选一个或新建`);
      return;
    }
    const loaded = await decodeOraToDoc(r.blob);
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
