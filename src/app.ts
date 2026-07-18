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

import { WEBPAINT_VERSION } from "./version.ts";
import { initI18n, t, reconcileLangFromPrefs } from "./i18n/index.ts";   // 本地化：<html lang> + 静态 HTML data-i18n 填充
import { PaintDoc } from "./doc.ts";
import { Board } from "./board.ts";
import { InputController } from "./input.ts";
import { PixelEdit } from "./pixel-edit.ts";   // compressPixelSnap/applyPixelSnap 切到 layer-undo/topbar-menu
import { makeCurrentBrush } from "./resolved-brush.ts";   // 当前笔派生 computed + 引擎桥（手感数学在 resolveBrush，同文件）
import { registerPanel, openExclusive, closeExclusive, getCurrentExclusive } from "./panel-state.ts";
import { UndoStack } from "./history.ts";
import { EditMode } from "./edit-mode.ts";
import { referenceWindow, paletteWindow, initSideWindows } from "./side-windows.ts";   // 参考/调色板浮窗（construct+wiring）
import { initDevConsole } from "./dev-console.ts";   // window.WebPaint 调试接口
import { mountGallery } from "./ui/gallery.ts";          // candidate 1 · 图库深模块
import { BrushRackController } from "./brush-rack-controller.ts";
import { PwaShell } from "./pwa-shell.ts";
import { openInputSheet, openConfirmSheet, lockSyncGate } from "./sheets.ts";   // settleSyncGate→cloud-freshness
import { setPasswordPrompt } from "./crypto-state.ts";   // 加密：密码弹窗注入（ADR-0012）
import { sessionFileName } from "./config.ts";   // 边界：裸 session 名 → 库全名（薄库身份=X.ora）
import { els } from "./els.ts";
import type { AppContext } from "./app-context.ts";
import { makeDialControls } from "./dial-controls.ts";   // dial 写入（setSize/setOpacity）+ 当前 dial + 键盘 [ ] 调粗
import { initTheme, reconcileThemeFromPrefs } from "./theme.ts";
import { initLayersPanel, renderLayersPanel, LAYER_MODE_LABEL } from "./layers-panel.ts";
import { initDocOps } from "./doc-ops.ts";
import { initCloudAuthUI, updateCloudAuthUI } from "./cloud-auth-ui.ts";
import { initSettingsMenu, applyCheckerboard, renderSettingsFromPrefs } from "./settings-menu.ts";   // setMenuOpen→各菜单模块
import { initFiltersAdjust } from "./filters-adjust.ts";
import { initToolbar, RACK_PANEL_BY_TOOL } from "./toolbar.ts";
import { setColor, initColorPanel } from "./color-panel.ts";
import { session, initSession, setSessionGallery } from "./session-state.ts";   // candidate 3 · 活动文档生命周期 SSoT
import { createEditorState } from "./editor-state.ts";   // candidate 3 · 编辑器 RAM 反应式 SSoT（dial/color/压感）
import { showFullscreenBusy, hideFullscreenBusy, withBusy } from "./fullscreen-busy.ts";
import { initSmoothDevPanel } from "./smooth-dev-panel.ts";
import { selectionToNewLayer, initSelectionOps } from "./selection-ops.ts";
import { updateSaveStatus, updateNewerBanner } from "./save-status.ts";
import { initErrorBadge, reportError } from "./error-badge.ts";
import { initTransientPanels, _suppressTransientPanels, _restoreTransientPanels, _bringPanelTop, _commitTransform, _cancelTransform } from "./transient-panels.ts";
import { initLayerUndo, _afterDocChange, layerSpecFrom } from "./layer-undo.ts";
import { initImportImage, importImageAsLayer } from "./import-image.ts";   // importImageAsNewDoc/setAddImportAsNewDoc 仅 gallery-shell/export-menu 用
import { initExportImportMenu } from "./export-import-menu.ts";
import { initGalleryShell, setGalleryOpen, checkQuotaAndWarn, uniqueLocalName } from "./gallery-shell.ts";
import { initTopbarMenu } from "./topbar-menu.ts";
import { initBlenderSync, reconcileBlenderUrlFromPrefs } from "./blender-sync.ts";   // 推/拉贴图到 Blender（BlenderTextureProtocol，插件式隔离子功能）
import { initPlatformGuards } from "./platform-guards.ts";
import { mountLeftDial } from "./ui/left-dial.ts";   // candidate 1 Step 2 · 左栏 dial（size/opacity/笔指示/popup）
import { watch } from "../vendor/vue/vue.esm-browser.prod.js";   // 加密常驻指示 watch（currentBrush computed + 引擎桥已下沉 resolved-brush.ts）
import { initRackBoot, bootRestoreSession } from "./boot.ts";   // 启动编排：笔架异步 boot + gallery-first 恢复
// Selection 切到 selection-ops.ts；smooth-config（SMOOTH/saveSmooth/resetSmooth）切到 smooth-dev-panel.ts
// v132 (user：「所有 color adjustment 做成第一方默认安装的插件」)
//   filters.js 只剩 Filter 契约 + registry + helper；
//   每个调色器在 src/plugins/ 自成一文件，import 时自注册
import "./plugins/index.ts";    // 触发 HSB / ColorBalance / Curves / SharpenBlur 自注册
// candidate 2：导出格式 = 注册表插件（含第一方 ora/psd/png/jpg 自注册）
import { isAuthConfigured, initAuth, isSignedIn, retrySilentSignIn, brushRackCollection, store as _store } from "./app-store.ts";   // cut-over：cloud/auth/graph 全走 lib
import { initPreferences, refreshPreferences } from "./app-prefs.ts";   // boot 门 + 前台/online 拉云对齐 user-preference（lang/theme/手势）
import { hydrateSmoothFromPrefs } from "./smooth-config.ts";   // boot 门后合并 synced 平滑调参进 SMOOTH
import { initAppState, appState } from "./app-state.ts";                // boot 门 + 前台/online 拉云对齐 app-state（current-dir/file/blenderUrl）

// 前台（focus/visible）/ online 时把 4 个 settings/state collection 拉云对齐（per-key LWW；离线/local-only 内部 no-op）。
const pullSettingsAndState = (): void => { void refreshPreferences(); void appState.pullFromPersistent(); };




// cut-over 完成：_store 从 app-store import（接 lib）。explicit 保存恒走 store.flow.push（B1/B2/B5/retry/C4）。

// ============ 设置/状态就绪 promise（v409：**不再是 TLA 门**）============
// 设置/状态 SSoT = 4 个 IDB collection。IDB 是 async，而组合根是同步的 → 两种办法：
//   v406-v408：TLA 门（`await Promise.all(...)` 挂起整个模块）—— 存在的**唯一**理由是 lang 在 eval 期
//     就被 t() 读、`_lang` 一读即锁死。代价：整个 boot 等 IDB；且 theme 的首帧闪白它**根本修不了**
//     （FOUC 发生在 bundle 求值之前）。
//   v409：lang/theme 改走 **localStorage boot 快照**（src/boot-snapshot.ts）→ eval 期/pre-paint 同步可读
//     → 门没必要了，拆掉。app-store 已在 imports 期 eval → 4 个 collection 建好并 wire；此处只**发起** init。
// 其余 6 个消费方（currentFile/currentDirectory/4 个开关/stylus/blenderUrl）没有快照，hydrate 前只能读到
//   DEFAULTS → 它们**各自 await prefsReady**，统一在下面的「fixup 相」灌真值。别在 fixup 之外读这些 pref。
const prefsReady: Promise<unknown> = Promise.all([initPreferences(), initAppState()]);

// ---- 启动 ----
// 加密（ADR-0012）：密码弹窗接线 —— crypto-state 无 DOM，composition root 把 in-app
// 输入 sheet 注入进去（守「无系统对话框」红线）。必须在任何 decode 之前（boot load 可能是加密作品）。
setPasswordPrompt(({ title, message }) =>
  openInputSheet(title || t("mi.enterPassword"), "", { placeholder: t("mi.galleryPassword"), password: true, message: message || "" }));

// 触屏检测（iPad / iPhone / surface touchscreen）→ hand 工具隐藏（双指 pan 已足）
if (navigator.maxTouchPoints > 0) {
  document.body.dataset.inputTouchscreen = "1";
}
initI18n();   // 本地化 boot：设 <html lang> + 填静态 HTML data-i18n（早于任何 JS 设标签/首帧）
const doc = new PaintDoc({ width: 2048, height: 2048 });
const board = new Board(els.board as HTMLCanvasElement, doc);
els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
els.versionLabel.textContent = t("menu.version", { v: WEBPAINT_VERSION || "?" });   // 挪到「强制更新」旁的菜单信息行
// gallery 也显版本号（footer 水印 + 菜单信息行）——配合「强制更新」让用户知道自己在哪个版本。
if (els.galleryFootVersion) els.galleryFootVersion.textContent = WEBPAINT_VERSION || "?";
if (els.galleryMenuVersion) els.galleryMenuVersion.textContent = t("menu.version", { v: WEBPAINT_VERSION || "?" });

// 编辑器「当前设成什么样」的反应式 RAM SSoT（主色 / 每工具 dial / 压感开关 / 棋盘等）= editor-state.ts。
// 当前笔（currentBrush computed）从这束 dial + 笔架预设纯派生（见下，组合接线留 app）。
const { state, dialReactive } = createEditorState();

// 左栏 dial = <LeftDial> Vue 组件（src/ui/left-dial.ts）：笔指示按钮(tap=rack/长按=设置) + size/opacity 竖滑块 + size popup。
// 全绑定反应式 dial SSoT（getter 读 state.toolStates/dialReactive → 组件 computed 自动追踪）。
// 取代旧的 updateSidebarBrushIndicator / _sidebarBrushBtn 手势 / showSizePopup / 两个 slider 监听 / applyToolState 的 slider-DOM-push。
// 笔架深模块（src/brush-rack-controller.ts）。持久化/云同步走 brushRackCollection（红线在库内）。
// editMode 走 thunk（构造早于 editMode）；DOM/panels 晚绑 init()。
const rack = new BrushRackController({
  collection: brushRackCollection,
  state, dialReactive,
  editMode: () => editMode,
  setStatus, confirm: openConfirmSheet,
  openExclusive, closeExclusive, registerPanel,
  isSignedIn, isOnline: () => navigator.onLine !== false,
});

// dial 写入（setSize/setOpacity 写 dial SSoT + LS）+ 当前 dial + 键盘 [ ] 调粗 = dial-controls.ts。
// editMode thunk：setSize 要早于 leftDial 可用，editMode const 晚声明。bindKeyboard 待 board/leftDial 后调。
const { setSize, setOpacity, currentDials, bindKeyboard: bindSizeKeyboard } = makeDialControls({ state, rack, getEditMode: () => editMode });

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
// 键盘 [ ] 调粗接线（需 board/leftDial，已建好）。
bindSizeKeyboard({ board, leftDial });

// 当前笔（ResolvedBrush）派生 + 引擎桥 = resolved-brush.ts makeCurrentBrush，input 前构造（见下）。手感数学全在 resolveBrush。


// Undo / redo 共享栈（command pattern + 注册 handler，详见
// docs/20260527-undo-architecture.md）。input.js 注册 "stroke" handler；layer
// 操作的 5 个 handler 在下方 boot 段集中注册（四条纪律 #1）。
const history = new UndoStack({ max: 50 });
// EditMode：独占编辑状态机，当前编辑模式（工具/transient）的 SSoT（取代旧 state.tool）。见 edit-mode.js / CONTEXT.md。
const editMode = new EditMode({ initialTool: "brush" });
// 当前笔派生（dial+预设+color+压感 → ResolvedBrush，resolved-brush.ts）。input 前建（getResolvedBrush 读它）。
const { currentBrush } = makeCurrentBrush({ state, dialReactive, rack });
// PixelEdit：纯像素（stroke/liquify/filterBrush）的 undo 事务 + handler。
// 和 UndoStack 平级，注入 input。见 pixel-edit.js / CONTEXT.md。
const pixelHistory = new PixelEdit({ doc, history, board });

const input = new InputController(board, doc, {
  getTool: () => editMode.current(),
  getResolvedBrush: () => currentBrush.value,
  // v132 filter brush: state.filterBrush = { Filter, params, variantLabel } 或 null
  getFilterBrushState: () => state.filterBrush || null,
  getLongPressPickEnabled: () => state.longPressPick,
  getSingleFingerDraw: () => state.singleFingerDraw,
  getPickMode: () => state.pickMode,
  isContentReplacing: () => session.loadingDoc,   // N10：adopt 换内容中 → 起笔降级（session._loadingDoc）
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

// brush live 预览：GPU stamp overlay（collectStamps→GPU 栅格；选区/lockAlpha 在 shader 内裁）。
board.setStampProvider(() => input.brush.collectStamps());
// strokeActiveHint：任一笔画进行中 → board 走 livePreview（直接合成，不用静态缓存）。
//   含 brush/像素笔/liquify/filterBrush（liquify/filter/pixel 另经 setLiveSyncProvider 把活动层每帧重传 GPU）。
board.setStrokeActiveHint(() => input.isStrokeActive());
// GL live-sync：原地改像素的笔（liquify/filterBrush/pixelMode）描边中要把活动层每帧重传 GPU 才显预览
//   （buffered brush 走 GPU stamp overlay，此处返 null）。仅 GL 模式生效（board 内部门控）。
board.setLiveSyncProvider(() => input.liveMutatedLeaf());
// 自由变换 commit 烤定走 GPU warp（board.glWarpBakeFn）；lasso 仍 GL-blind，经 provider 拿。
input.lasso.setWarpBakeProvider(() => board.glWarpBakeFn());
board.setLassoProvider((() => ({
  selection:      doc.selection,
  drawingPath:    input.lasso.getDrawingPath(),
  drawingRect:    input.lasso.getDrawingRect(),
  drawingEllipse: input.lasso.getDrawingEllipse(),
  floating:       input.lasso.getFloating(),
  handles:        input.lasso.visibleHandles(board.viewport.scale),
  sampleMode:     input.lasso.getSampleMode(),
})) as Parameters<typeof board.setLassoProvider>[0]);

// 蚂蚁线无动画（user 反馈太干扰）；选区改变时 setLassoProvider 已触发 invalidateAll。

// 笔架 boot（异步加载 IDB + toolStates 补齐 + 默认笔 merge）= boot.ts initRackBoot，ctx 建好后调（见下）。


// Composition Root：core 单例 + 跨模块函数装进显式 ctx，传给每个 initX(ctx)（取代全局 rt）。
// ctx 一次构造、即刻冻结（survey S1/S2 + boot-smoke 的搭档）。两道守卫，各有边界：
//   · Object.freeze：ESM strict 下任何 `ctx.x = …` 二次突变即抛——杜绝肢解时那套
//     「null 占位 + 晚期 Object.assign」两阶段突变复活。ctx 自此不可变、一次成形。
//   · 构造期断言：键在场但值为 undefined（import 名写错 / 引用未定义）→ boot 即响亮报错。
// 抓不到的（固有盲区，归 survey rec #2(a) 的「每 initX 声明自用 key」）：键整个漏写进字面量——
//   消费方只在事件 handler 里读到 undefined（boot 不触及，故 boot-smoke 也抓不到，仍是「点到才炸」）。
// 全部键早绑（import / hoisted function / 上方 const）；唯一晚绑是 gallery：用 getter 透传下方
// const（init 体只「存」不「解引用」，晚 init 在 gallery 构造后跑→读到真值，故无需 null 占位/二次 assign）。
function freezeCtx<T extends object>(obj: T): T {
  for (const k of Object.keys(obj)) {
    if (Object.getOwnPropertyDescriptor(obj, k)!.get) continue;   // getter（gallery）懒求值，构造期跳过
    if ((obj as Record<string, unknown>)[k] === undefined) throw new Error(`[ctx] 组合根键 "${k}" 构造时值为 undefined（import 名写错或引用未定义）`);
  }
  return Object.freeze(obj);
}
const ctx: AppContext = freezeCtx({
  state, dialReactive, currentBrush, editMode, doc, board, input, history, pixelHistory,
  rack, store: _store, setStatus, withBusy, leftDial,
  updateSaveStatus, updateZoomLabel, updateNewerBanner, pullSettingsAndState,
  _suppressTransientPanels, _restoreTransientPanels, layerSpecFrom, _bringPanelTop,
  _commitTransform, _cancelTransform, selectionToNewLayer,
  importImageAsLayer,   // selection-ops 的 Ctrl+V 粘贴 / drop 用（hoisted function）
  afterDocChange: _afterDocChange,
  referenceWindow, paletteWindow,   // side-windows.ts 的 import（module-eval 即构造，早可用）
  setColor, applyCheckerboard, renderLayersPanel,
  setGalleryOpen, checkQuotaAndWarn, uniqueLocalName,
  showFullscreenBusy, hideFullscreenBusy,
  get gallery() { return gallery; },   // 晚绑：gallery const 在下方 mountGallery 处构造
});
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

// 笔架异步 boot（fire-and-forget；ctx 已建好）。
initRackBoot(ctx);

// dial 写入（setSize/setOpacity）+ 当前 dial + 键盘 [ ] 调粗 已下沉 dial-controls.ts（见上方构造）。
// size/opacity popup + slider 监听 + slider-DOM 同步在 <LeftDial>（src/ui/left-dial.ts）。


// ---- undo / redo / fit ----
// undo/redo 按钮 + 清空图层 sheet + openSheet/closeSheet = topbar-menu.ts。

// ---- HUD ----
function updateZoomLabel() {
  els.zoomLabel.textContent = Math.round(board.viewport.scale * 100) + "%";
}
let statusTimer: ReturnType<typeof setTimeout> | null = null;
function setStatus(text: string, persist = false) {
  els.statusLabel.textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  if (!persist) {
    statusTimer = setTimeout(() => { els.statusLabel.textContent = t("status.ready"); }, 1800);
  }
}
// 统一 error banner：注入状态栏 sink（info 级走这）+ 接管内联 __errBar 的 fatal handler（往后走 severity）。
initErrorBadge({ status: setStatus });
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
// appState.currentFile（synced-app-state）真实持久化 active session name（跨设备 resume；非 null → boot 自动 open）；
// 空字符串 = "在 gallery 没绑定任何画作"，refresh 后停 gallery。

// 锚定 popup 定位 helper（positionPopup 核心 + anchorPopupToBtn/anchorPopupBelowToolbars wrapper）= anchored-popup.ts。
// withBusy / showFullscreenBusy / hideFullscreenBusy = fullscreen-busy.ts。
// 等云端 push 完成（防 status race）= session.awaitCloudPushIdle()，定义在 session-state.ts。

// 图库外壳（setGalleryOpen/chrome/新建sheet/IDB占用/配额/popup接线/uniqueLocalName）= gallery-shell.ts。
// ===== 图库 = <Gallery> 深模块（src/ui/gallery.ts）。app 只供画布耦合 host 回调 + 无系统弹窗 UI =====
const gallery = mountGallery(document.getElementById("galleryMount")!, {
  signedIn: () => isSignedIn(),
  online: () => navigator.onLine !== false,
  activeName: () => session.name,
  confirm: (title, m) => openConfirmSheet(title, m),
  input: (title, d, o) => openInputSheet(title, d, o),
  chooseFolder: async (title, message, options) => {
    const v = await lockSyncGate({ title, message, showSpinner: false, actions: [...options, { label: "✕ " + t("common.cancel"), value: "__cancel__" }] });
    return (v == null || v === "__cancel__") ? null : v;
  },
  status: (m, e) => setStatus(m, e),
  busy: (label, fn) => withBusy(label, fn),
  // 画布耦合操作（open/push/unload/rename/exit/setName）gallery.ts 直调 session.*，不再经 host。
});

// gallery 现由 ctx 的 getter 透传（不再 ctx.gallery= / Object.assign 二次突变——ctx 已冻结、一次构造）。
// 晚 init 在此之后跑，故各模块 init 体里的 `x = ctx.gallery` 读到真值。
setSessionGallery(gallery);   // session 的晚绑 gallery handle（getter 已使其 init 期即读到真值；此调用保持幂等冗余）
initSession(ctx);
initImportImage(ctx);      // 图片/.ora 导入（需 late ctx：applyCheckerboard/renderLayersPanel/setGalleryOpen/uniqueLocalName）
initGalleryShell(ctx);     // 图库外壳（需 ctx.gallery + late keys）
initTopbarMenu(ctx);       // 顶栏/菜单/sheet/save 触发 事件接线（需 ctx.gallery）
initBlenderSync(ctx);      // Blender 同步面板（菜单入口 menuBlender → 自建 float panel）
initCloudAuthUI(ctx);

// v236 加密常驻指示（顶栏小锁 + 菜单 label）：反应式跟 session.enc.encrypted。
watch(() => session.enc.encrypted, (enc) => {
  els.topEncLock?.classList.toggle("hidden", !enc);
  if (els.menuEncryptLabel) els.menuEncryptLabel.textContent = enc ? t("menu.decrypt") : t("menu.encrypt");
}, { immediate: true });
els.topEncLock?.addEventListener("click", () => session.decryptCurrent());

// 图库 popup 开启/关闭 + 菜单代理 + 新建文件夹 + 新建作品 sheet + IDB 占用/配额 = gallery-shell.ts。

// ---- 启动收尾：尝试加载上次的 session（异步，不阻塞 UI 显示） ----
setStatus(t("status.ready"));
updateZoomLabel();
updateSaveStatus();
updateCloudAuthUI();
// MSAL init（懒；只在配了 CLIENT_ID 才 load script），失败安静吞
if (isAuthConfigured()) {
  initAuth().then(() => {
    updateCloudAuthUI();
    // gallery-first: boot 时 gallery 可能已经渲染过（auth 没好 → 只有本地）；
    // auth 完成后 if gallery 还开着 → 重渲染拿云端列表
    if (!els.galleryFull.classList.contains("hidden")) gallery.refresh();
  }).catch((e) => {
    reportError(new Error("[auth] init failed: " + String(e)), "log");
  });
}
// auth 可观察 seam（候选1）：lib 在**每个** auth 转变（登录回来/后台silent/登出/过期F2）fire wp:auth-changed。
// UI 订阅一次 → 按钮蓝/灰、save 图标、云列表 全自动同步，永不漂移、不再靠散落手 poke。
window.addEventListener("wp:auth-changed", () => {
  updateCloudAuthUI();
  updateSaveStatus();                                       // 候选2：auth 变化影响 save 图标
  if (!els.galleryFull.classList.contains("hidden")) gallery.refresh();
});
// 在线 / 离线变化时刷新云端 UI（标签 / 按钮可见性）。
// online 时尝试 silent re-auth：boot 离线 → activeAccount 为 null；有网了主动 retry 一次
window.addEventListener("online", async () => {
  if (!isSignedIn()) await retrySilentSignIn();
  pullSettingsAndState();                                    // 回线：拉 4 库 settings/state 对齐
  updateCloudAuthUI();
  if (isSignedIn()) _store.files.drainOfflineQueue().catch((e) => reportError(new Error("drainOfflineQueue: " + String(e)), "log"));   // N3：重连重放离线删队列
  if (!els.galleryFull.classList.contains("hidden")) gallery.refresh();
  if (isSignedIn() && session.name) _store.file(sessionFileName(session.name), { isZip: true, mode: "existing" }).pullIfClean().catch(() => {});   // 回线：事件驱动干净快进（freshness 进库；无 idle-lock）。边界转全名。
});
window.addEventListener("offline", () => { updateCloudAuthUI(); });

// 前台新鲜度活动监听 + idle tick 接线已切到 cloud-freshness.ts initCloudFreshness。
//
// ============ fixup 相（v409）：collection hydrate 完 → 把**真值**灌进上面已用 DEFAULTS 建好的 UI ============
// 为什么需要这一相：拆了 TLA 门后，组合根是在 collection hydrate **之前**同步跑完的，所以上面所有读过
//   pref/app-state 的地方拿到的都是 DEFAULTS。这里是**唯一**的补灌点 —— 6 个消费方一个都不能漏，
//   漏了的症状是「设置静默回默认」：不报错、只在真机上偶发。改这块时对着这张表逐条打勾。
//     ① stylus 平滑调参 ② 4 个开关（settings-menu）③ theme ④ lang ⑤ 图库上次的夹 ⑥ blender URL
//     ⑦ 上次打开的画（currentFile → bootRestoreSession，必须排在最后：它会开画/开图库）
// 纪律：这一相**只准 render / 不准写盘**（renderSettingsFromPrefs / hydrateFolder 都是不写盘的变体）。
//   若这里调了会 setItem 的路径（applyPixelGrid / gallery.setFolder），就等于「读完立刻回写」，
//   会把 uat 盖成 now → per-item LWW 退化成「最后冷启动的设备赢」= v406-v408 的 P0-1。
void prefsReady.then(() => {
  hydrateSmoothFromPrefs();      // ① 手感热路径：synced 平滑调参合并进 SMOOTH（eval 期是 SMOOTH_DEFAULTS）
  renderSettingsFromPrefs();     // ② longPressPick / singleFingerDraw / pixel-grid / show-fps（不写盘）
  reconcileThemeFromPrefs();     // ③ 刷 boot 快照；与快照不符则就地换（主题=css，无 reload）
  reconcileLangFromPrefs();      // ④ 刷 boot 快照；与快照不符则 reload（lang 是 reload 制）—— 可能不返回
  try { gallery.hydrateFolder(appState.currentDirectory); } catch { /* 图库未挂/无夹 */ }   // ⑤ 不写盘变体
  reconcileBlenderUrlFromPrefs();   // ⑥ appState.blenderPanelUrl 真值刷进输入框（不写盘、不碰面板显隐）
}).catch((e) => reportError(new Error("[boot] settings fixup failed: " + String(e)), "log"));

// ⑦ Gallery-first 启动恢复（读 appState.currentFile：非 null → 自动开那张画；否则停图库）= boot.ts。
//   必须 await prefsReady：hydrate 前 currentFile 恒为 null → 会永远落图库、不再自动开上次的画。
//   排在 fixup 之后（同一个 promise 的 then 按注册顺序跑）→ 开画时 desk/设置已就位。
void prefsReady.then(() => bootRestoreSession(ctx)).catch((e) => reportError(new Error("[boot] restore failed: " + String(e)), "log"));
// N3：启动时若在线+已登录，排空上次离线攒下的删除队列（fresh boot 不触发 online 事件，故此处补一刀）。
if (navigator.onLine && isSignedIn()) _store.files.drainOfflineQueue().catch((e: unknown) => reportError(new Error("drainOfflineQueue: " + String(e)), "log"));

// 笔架深模块装配：mount sheet/settings 组件 + 注册 panel + 绑 DOM 事件 + 订阅 collection.onChange。
rack.init({
  els: {
    rack: {
      sheet: document.getElementById("brushRackSheet")!,
      title: document.getElementById("brushRackTitle")!,
      close: document.getElementById("brushRackClose")!,
      importBtn: document.getElementById("brushRackImport")!,
      newBtn: document.getElementById("brushRackNew")!,
      mount: document.getElementById("rackSheetMount")!,
      exportFolderBtn: document.getElementById("brushRackExportFolder")!,
      refreshBtn: document.getElementById("brushRackRefresh")!,
      resetBtn: document.getElementById("brushRackReset")!,
      dumpCodeBtn: document.getElementById("brushRackDumpCode")!,
    },
    settings: {
      view: document.getElementById("brushSettingsView")!,
      body: document.getElementById("brushSettingsBody")!,
      save: document.getElementById("brushSettingsSave")!,
      cancel: document.getElementById("brushSettingsCancel")!,
    },
  },
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
    await session.save();   // saveNow 内含 blank/dirty 守卫（es.flushLocal 不脏 no-op）
  },
  onForeground: () => { pullSettingsAndState(); if (isSignedIn() && session.name) _store.file(sessionFileName(session.name), { isZip: true, mode: "existing" }).pullIfClean().catch(() => {}); },   // 前台：拉 4 库 + 当前文件快进（边界转全名）
}).init();
