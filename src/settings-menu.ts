// 职责（单一）：汉堡 ⋯ 菜单面板——设置开关（压·粗 / 压·透 / 长按吸色 / 透明棋盘 / 像素栅格 /
// 主题 / 检测更新 stub / 清空 stub）+ 快捷键 sheet（从 KEYBOARD_SHORTCUTS 自动渲染）+ 菜单开关。
//
// 旧 app.js 「汉堡菜单」区逐字搬来；app.js 短路成 import + initSettingsMenu() 装配。
// setMenuOpen export 给 ctx（doc-ops 等也调）；boot 的 apply* 初始化调用进 initSettingsMenu()。
//
// 仍留 app.js 的协作件经 ctx 绑入：state / board / setStatus / store / updateSaveStatus（核心单例）。

import { updateCloudAuthUI } from "./gallery/cloud-auth-ui.ts";
import { els } from "./els.ts";
import { syncedUserPreference, localUserPreference, PREF_DEFAULTS } from "./app-prefs.ts";   // 手势/视图开关=跨设备；menu-tab=设备本地
import { desk } from "./workbench-state.ts";   // checkboard = per-doc desk（载入时经 wp:applyEditorState 应用到 board）
import { applyTheme, themeLabel, THEMES, currentTheme } from "./theme.ts";
import { t, lang, setLang, LANGS, langDisplayName, type Key } from "./i18n/index.ts";
import { KEYBOARD_SHORTCUTS } from "./input.ts";
import { _updateMenuCropLabel } from "./doc-ops.ts";
import { positionPopup } from "./anchored-popup.ts";
import { wireInlineSelect } from "./inline-select.ts";
import { openInputSheet } from "./sheets.ts";
import { reportError } from "./error-badge.ts";   // 全 app 唯一错误汇拢点（CLAUDE.md）
import { initInstallCapture, bindInstallButton } from "./install-prompt.ts";
import { isCloudEnabled, setCloudEnabled, CLOUD_CAPABILITY_EVENT } from "./cloud-capability.ts";
import { isAuthConfigured, isSignedIn } from "./app-store.ts";   // auth 公共面（cloud-auth-ui 同款直连）
import { session } from "./session-state.ts";   // 云开关关闭前 flush（saveAndPush）用；只调不改
import type { AppContext } from "./app-context.ts";

// KEYBOARD_SHORTCUTS 元素（input.js 未类型化 → 描述渲染用到的字段）。
interface ShortcutLike { category?: string; desc: string; combo: string; }

let state: AppContext["state"], board: AppContext["board"], setStatus: AppContext["setStatus"], store: AppContext["store"], updateSaveStatus: AppContext["updateSaveStatus"];

// openSheet/closeSheet：app.js-local 小工具被快捷键 sheet 用，inline 复制一份（app 仍各自保留）
function openSheet(sheet: HTMLElement | null, backdrop: HTMLElement | null) {
  if (!sheet || !backdrop) return;
  backdrop.classList.remove("hidden");
  sheet.classList.remove("hidden");
}
function closeSheet(sheet: HTMLElement | null, backdrop: HTMLElement | null) {
  if (!sheet || !backdrop) return;
  backdrop.classList.add("hidden");
  sheet.classList.add("hidden");
}

function setMenuItem(btn: HTMLElement, on: boolean, stateLabel = on ? t("common.on") : t("common.off")) {
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  const st = btn.querySelector('.menu-item-state');
  if (st) st.textContent = stateLabel;
}

// （全局压感开关 applyPressureSize/Opacity 已 deprecate 2026-07-14 → 每笔自带，见 resolved-brush）
//
// ⚠**render* / apply* 的分工是纪律，不是风格**（v409 修的 P0-1）：
//   render*(on) = 只贴 RAM/DOM/board，**绝不写盘**；apply*(on) = render* + setItem（写 collection → 触发云同步）。
//   **boot 只准调 render***。v406-v408 boot 调的是 apply*（读完立刻回写）→ collection.setItem 无条件盖
//   `uat: now()` → per-item LWW 变成「**最后冷启动**的设备赢」而非「最后修改的设备赢」：
//   iPad 上开的设置，被桌面机下次冷启动的回写盖掉、还推回云端把 iPad 也清了。4 个 synced 键的跨设备同步等于打死。
//   theme.ts（renderTheme 不写盘）和 i18n（setLang 有 `l === lang()` 早退）本来就守着这条纪律，恰好躲过；
//   settings-menu 当时没守。别再让 boot 路径碰 setItem。
function renderLongPressPick(on: boolean) {
  state.longPressPick = !!on;
  setMenuItem(els.menuLongPressPick, on);
}
function applyLongPressPick(on: boolean) {
  renderLongPressPick(on);
  syncedUserPreference.setItem("long-press-pick", !!on);   // 跨设备偏好
}
function renderSingleFingerDraw(on: boolean) {
  state.singleFingerDraw = !!on;
  setMenuItem(els.menuSingleFingerDraw, on);
}
function applySingleFingerDraw(on: boolean) {
  renderSingleFingerDraw(on);
  syncedUserPreference.setItem("single-finger-draw", !!on);   // 跨设备偏好（默认关——不拦鼠标，见 pointer-route）
}
export function applyCheckerboard(on: boolean) {
  // v125: checkerboard per-doc，不再写 localStorage
  state.checkerboard = !!on;
  setMenuItem(els.menuCheckerboard, on);
  board.setShowCheckerboard?.(!!on);
  board.invalidateAll();
  board.requestRender();
}

// v163 像素栅格：全局开关（视图辅助），跨设备偏好（synced-user-preference），默认开
function renderPixelGrid(on: boolean) {
  board.setPixelGridEnabled?.(!!on);
  setMenuItem(els.menuPixelGrid, !!on);
}
function applyPixelGrid(on: boolean) {
  renderPixelGrid(on);
  syncedUserPreference.setItem("pixel-grid", !!on);
}

// v275 FPS 计：dev 性能读数（角落 overlay）；跨设备偏好（synced-user-preference），默认关。防煤气灯。
function renderFps(on: boolean) {
  board.setShowFps?.(!!on);
  setMenuItem(els.menuFps, !!on);
}
function applyFps(on: boolean) {
  renderFps(on);
  syncedUserPreference.setItem("show-fps", !!on);
}

// v0.5.28 生成式 AI 总开关：body[data-gen-ai] = 全 app 热切换钩子（未来 AI UI 挂 .needs-gen-ai 类即受控；
//   JS 消费者直读 pref）。不进 boot——功能入口显隐，fixup 相回灌晚一拍无感知（boot 门只配 lang/theme 那类 eval 期锁死值）。
export function genAiEnabled(): boolean {
  return syncedUserPreference.getItem<boolean>("gen-ai", PREF_DEFAULTS["gen-ai"]);
}
function renderGenAI(on: boolean) {
  document.body.dataset.genAi = on ? "1" : "";
  // v0.6.14：图库菜单的 gen-AI 代理开关已撤（user：不影响图库）——只剩主菜单一处
  document.getElementById("menuGenAI")?.setAttribute("aria-pressed", on ? "true" : "false");
  document.querySelectorAll('[data-state-for="genAI"]').forEach((st) => { st.textContent = on ? t("common.on") : t("common.off"); });
}
function applyGenAI(on: boolean) {
  renderGenAI(on);
  syncedUserPreference.setItem("gen-ai", !!on);
}

// ============ 云端功能开关 v1（2026-08-21 user 拍板；接缝 = cloud-capability.ts）============
// 编排（toggle 姿势照 menuGenAI）：render = 只贴 DOM（boot/fixup 安全）；点击 handler 才 setCloudEnabled。
// gating（v1 = 全部显隐/短路，零数据变更）：①菜单「图库」项隐藏（其余入口守卫在 topbar-menu）
//   ②boot 不自动恢复（boot-restore 端口门）③save 徽章无云态（save-status）④图库藏了云 popup 即不可达。
// !isAuthConfigured()（容器不支持云）→ toggle 灰显强制关（aria-disabled + title 说明），**不写盘**：
//   配置恢复后自愈回用户存值（cloudPrefEnabled 原样）。
function renderCloudEnabled() {
  const btn = document.getElementById("menuCloudEnabled");
  if (!btn) return;
  const configured = isAuthConfigured();
  const on = isCloudEnabled();   // = configured && 用户存值
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.setAttribute("aria-disabled", configured ? "false" : "true");
  btn.title = configured ? "" : t("menu.cloudUnavailableTitle");
  const st = btn.querySelector('[data-state-for="cloudEnabled"]');
  if (st) st.textContent = configured ? (on ? t("common.on") : t("common.off")) : t("common.off");
  applyCloudCapabilityGating();
}

// gating 显隐的**唯一集中点**（v1.1，2026-08-21 headless 实锤修）：菜单项显隐机制是 `hidden` **属性**
//   （styles.css:850 `.menu-item[hidden]{display:none}`）——v1 用 `.hidden` class 藏 menuGallery，
//   而全仓没有全局 .hidden 规则、.menu-item 自身 display:flex 胜出 → 藏了个寂寞。此类显隐一律走属性。
//   订阅 CLOUD_CAPABILITY_EVENT：将来任何地方切开关，这里一处重贴全部 UI。
function applyCloudCapabilityGating() {
  const on = isCloudEnabled();
  if (els.menuGallery) els.menuGallery.hidden = !on;                   // 图库入口（云账号 popup 等随图库一并不可达）
  const cloudImport = document.getElementById("layerImportCloudBtn");  // 图层面板「从云盘导入…」
  if (cloudImport) (cloudImport as HTMLButtonElement).hidden = !on;
  document.getElementById("referencePanel")?.toggleAttribute("no-cloud", !on);   // 参考窗云盘选图钮（组件观察属性）
}
window.addEventListener(CLOUD_CAPABILITY_EVENT, applyCloudCapabilityGating);

// v124 快捷键 sheet：从 KEYBOARD_SHORTCUTS 自动渲染（input.js 注册的唯一真理源）
const _shortcutsSheet = document.getElementById("shortcutsSheet");
const _shortcutsBackdrop = document.getElementById("shortcutsBackdrop");
const _shortcutsBody = document.getElementById("shortcutsBody");
function _renderShortcutsSheet() {
  if (!_shortcutsBody) return;
  const byCat = new Map<string, ShortcutLike[]>();
  for (const sc of KEYBOARD_SHORTCUTS) {
    const cat = sc.category || "sc.cat.other";   // category 现存 i18n key（input.ts）
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(sc);
  }
  // 同 combo 多 entry（如 Escape 在 floating / hasSelection 两条）合并展示
  let html = "";
  for (const [cat, list] of byCat) {
    html += `<div class="shortcuts-category">${t(cat as Key)}</div>`;
    for (const sc of list) {
      html += `<div class="shortcuts-row"><span>${t(sc.desc as Key)}</span><span class="shortcuts-combo">${sc.combo}</span></div>`;
    }
  }
  _shortcutsBody.innerHTML = html;
}

// collection hydrate 后由 app.ts 的 fixup 相调：把 4 个 synced 开关的**真值**灌进 RAM/DOM/board。
//   **只 render 不写盘**（见上方纪律）——这是 P0-1 的修复核心：boot 路径永不 setItem。
export function renderSettingsFromPrefs(): void {
  // v0.5.27：☰ 停留页回灌（设备本地 pref；无效值回 file）
  const savedTab = localUserPreference.getItem<string>("menu-tab", PREF_DEFAULTS["menu-tab"]);
  if (_menuTabs.some((b) => b.dataset.menuTab === savedTab)) { _menuTab = savedTab; _applyMenuTab(); }

  renderPixelGrid(syncedUserPreference.getItem<boolean>("pixel-grid", PREF_DEFAULTS["pixel-grid"]));
  renderFps(syncedUserPreference.getItem<boolean>("show-fps", PREF_DEFAULTS["show-fps"]));
  renderGenAI(genAiEnabled());
  renderCloudEnabled();   // 云端功能开关真值回灌（设备本地 pref；只 render 不写盘）
  renderLongPressPick(syncedUserPreference.getItem<boolean>("long-press-pick", PREF_DEFAULTS["long-press-pick"]));
  renderSingleFingerDraw(syncedUserPreference.getItem<boolean>("single-finger-draw", PREF_DEFAULTS["single-finger-draw"]));
}

export function setMenuOpen(open: boolean) {
  els.menuPanel.classList.toggle("hidden", !open);
  els.menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    // v124 menu panel 跟随菜单按钮屏坐标（top-bar 居中 transform，写死 left 在宽屏对不齐图标）。
    // v270：改走统一 positionPopup（左对齐到按钮 + safe-area + 夹视口），不再手搓坐标。
    positionPopup(els.menuPanel, { anchor: els.menuBtn, align: "left", offsetY: 6 });
    _updateMenuCropLabel?.();
    updateCloudAuthUI();   // v0.6.26：登录项显隐每次开菜单重派生（auth 静默恢复不触发 wp:auth-changed 的路径漏网——真机：登录后没隐藏）
  }
}

// v0.6C tab 分页状态（module 级：init 建，renderSettingsFromPrefs 回灌持久化值）
let _menuTab = "file";
let _menuTabs: HTMLElement[] = [];
let _menuPages: HTMLElement[] = [];
function _applyMenuTab() {
  for (const b of _menuTabs) b.setAttribute("aria-pressed", b.dataset.menuTab === _menuTab ? "true" : "false");
  for (const p of _menuPages) p.classList.toggle("hidden", p.dataset.menuPage !== _menuTab);
}

export function initSettingsMenu(ctx: AppContext) {
  ({ state, board, setStatus, store, updateSaveStatus } = ctx);

  // v0.9.26 PWA 安装入口（user 2026-08-20）：capture 要尽早挂（事件发在监听前就收不到了）；
  //   设置页按钮在此绑，图库菜单那颗在 gallery-shell 绑（各自收各自的面板）。
  initInstallCapture();
  bindInstallButton(document.getElementById("menuInstallApp"), () => setMenuOpen(false));

  // v0.6C（user 拍板）：☰ 六 tab 分页（文件/画布/视图/设置/插件/dev）。停留页 RAM 记忆（session 内）。
  {
    _menuTabs = [...document.querySelectorAll<HTMLElement>("#menuPanel .menu-tab")];
    _menuPages = [...document.querySelectorAll<HTMLElement>("#menuPanel .menu-page")];
    for (const b of _menuTabs) b.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      _menuTab = b.dataset.menuTab!;
      localUserPreference.setItem("menu-tab", _menuTab);   // v0.5.27：停留页持久化（设备本地 pref）
      _applyMenuTab();
    });
    _applyMenuTab();
    // 持久化回灌走 renderSettingsFromPrefs（fixup 相，prefs 已 hydrate——同其它 pref 的时序纪律）
  }

  els.menuLongPressPick.addEventListener("click", () => {
    applyLongPressPick(!state.longPressPick);
    setStatus(t("status.longPressPick", { s: state.longPressPick ? t("common.on") : t("common.off") }));
  });
  els.menuSingleFingerDraw.addEventListener("click", () => {
    applySingleFingerDraw(!state.singleFingerDraw);
    setStatus(t("status.singleFingerDraw", { s: state.singleFingerDraw ? t("common.on") : t("common.off") }));
  });
  // desk 载入：文档的 checkboard 回灌到 board（applyCheckerboard 只写 board+mirror，不写 desk→不标脏；守人类 2026-06-10 决定）。
  window.addEventListener("wp:applyEditorState", () => applyCheckerboard(desk.checkboard));
  els.menuCheckerboard.addEventListener("click", () => {
    applyCheckerboard(!state.checkerboard);
    // UI 态不 mark dirty（user 2026-06-10）：棋盘是观感开关，下次真编辑保存时顺手捞进 state.json。
    //   不再 edits.mark()——否则切个棋盘就让已同步的画变「未保存」。
    setStatus(t("status.checkerboard", { s: state.checkerboard ? t("common.on") : t("common.off") }));
  });

  if (els.menuPixelGrid) els.menuPixelGrid.addEventListener("click", () => {
    const next = !board.getPixelGridEnabled();
    applyPixelGrid(next);
    setStatus(t("status.pixelGrid", { s: next ? t("common.on") : t("common.off") }));
  });

  // #10 主栅格（tilemap 对齐）：per-doc（desk.grid），一直显示不渐隐（对照像素栅格的放大渐显）。
  //   同 checkerboard 纪律：观感开关不 mark dirty（desk setter 本就不标脏）。
  const applyDocGrid = () => {
    board.setDocGrid?.(desk.grid.on, desk.grid.cell);
    setMenuItem(els.menuDocGrid, desk.grid.on);
    // 并行样式（2026-08-21）：尺寸显示挪进主按钮的 sub 槽（menuDocGridCell 已变扳手，内部无 state 槽）
    const cellLabel = document.getElementById("menuDocGridCellSub");
    if (cellLabel) cellLabel.textContent = `${desk.grid.cell}px`;
  };
  window.addEventListener("wp:applyEditorState", applyDocGrid);
  els.menuDocGrid?.addEventListener("click", () => {
    desk.grid.on = !desk.grid.on;
    applyDocGrid();
    setStatus(t("status.docGrid", { s: desk.grid.on ? t("common.on") : t("common.off") }));
  });
  els.menuDocGridCell?.addEventListener("click", async () => {
    setMenuOpen(false);
    const v = await openInputSheet(t("menu.docGridCellTitle"), String(desk.grid.cell), { placeholder: "16" });
    if (v == null) return;
    const n = Math.max(2, Math.min(1024, parseInt(v, 10) || 0));
    if (!n) return;
    desk.grid.cell = n;
    if (!desk.grid.on) desk.grid.on = true;   // 设了尺寸=想看到它，顺手打开
    applyDocGrid();
    setStatus(t("status.docGridCell", { n }));
  });
  applyDocGrid();

  if (els.menuFps) els.menuFps.addEventListener("click", () => {
    const next = !board.getShowFps?.();
    applyFps(next);
    setStatus(t("status.fps", { s: next ? t("common.on") : t("common.off") }));
  });
  document.getElementById("menuGenAI")?.addEventListener("click", () => {
    const next = !genAiEnabled();
    applyGenAI(next);
    setStatus(t("status.genAI", { s: next ? t("common.on") : t("common.off") }));
  });
  // 云端功能开关（2026-08-21；纪律/gating 见 renderCloudEnabled 头注释）
  document.getElementById("menuCloudEnabled")?.addEventListener("click", async () => {
    if (!isAuthConfigured()) return;   // 灰显强制关：容器不支持云，点了也不动用户存值
    const next = !isCloudEnabled();
    if (!next && session.name) {
      // 关闭前 flush：有活动 store 画 → 先存（登录着才带云腿；**未登录只本地**——v1.1 headless 实锤：
      //   未登录跑 saveAndPush 会让云腿把「Not signed in」推上红 banner，关云的动作自己先炸一条云错误）。
      //   没落成（内存脏残留 / 登录态云腿仍 pending）→ 提示并**不切换**。
      try {
        if (isSignedIn()) await session.saveAndPush();
        else await session.save({ commitPending: true });
      } catch { /* 内部已 surface；下面判据兜底 */ }
      if (session.dirty || (isSignedIn() && session.pushPending)) {
        setStatus(t("status.cloudOffFlushFailed"), true);
        renderCloudEnabled();
        return;
      }
    }
    setCloudEnabled(next);   // 只写设备本地 pref + 广播 wp:cloud-capability-changed；零数据变更（红线）
    renderCloudEnabled();
    updateSaveStatus();      // ③save 徽章无云态立即生效
    setStatus(t("status.cloudEnabled", { s: next ? t("common.on") : t("common.off") }));
  });
  // v0.5.37（user）：主题/语言换 in-app 下拉——原生 select 打开态是 chrome 域（iPad 弹层系统字体，
  //   UCSUR 必豆腐；夜间白底、装不了 SVG 同根性坑）。弹层复用紧凑菜单 list 形态 + 锚定。
  //   条目开时现建 → 标签永远新鲜（字体门迟到翻转后 endonym/主题名自动带字形）。
  wireInlineSelect("menuThemeBtn", "menuThemeMenu",
    () => THEMES.map((th) => ({ value: th, label: themeLabel(th) })),
    () => currentTheme(),
    (th) => { applyTheme(th); setStatus(t("status.theme", { s: themeLabel(th) })); });
  // 语言：下拉框选择（endonym = 各语母语名，任何 UI 语言都认得；change 即 setLang→reload）。
  // 语言：endonym 各语自称；tok 在字形可用时=sitelen pona（langDisplayName）。setLang async 失败必 surface。
  const langBtnLabel = document.getElementById("menuLanguageBtnLabel");
  if (langBtnLabel) langBtnLabel.textContent = langDisplayName(lang());
  wireInlineSelect("menuLanguageBtn", "menuLanguageMenu",
    () => LANGS.map((l) => ({ value: l, label: langDisplayName(l) })),
    () => lang(),
    (l) => {
      void setLang(l).catch((e) => {
        if (langBtnLabel) langBtnLabel.textContent = langDisplayName(lang());   // 回滚显示
        reportError(e);
      });
    });
  // v100：删「检测更新」menu (实测在 iPad PWA 上不可靠，user：「检测更新功能没用」)。
  // 强制更新一律走「强制清缓存重启」（menuForcePwaReset）— 详 ai-docs/20260526-pwa-update-detection.md。
  // 老 element 在 HTML 里 hidden，handler 留空保 element exists 防 null deref。
  if (els.menuCheckUpdate) els.menuCheckUpdate.addEventListener("click", () => setMenuOpen(false));
  // v124b: menuClear 撤了（user：「清空内容跟删除重复，删掉」）。stub 留兜底
  if (els.menuClear) els.menuClear.addEventListener("click", () => setMenuOpen(false));

  document.getElementById("menuShortcuts")?.addEventListener("click", () => {
    setMenuOpen(false);
    _renderShortcutsSheet();
    openSheet(_shortcutsSheet, _shortcutsBackdrop);
  });
  document.getElementById("shortcutsClose")?.addEventListener("click", () => closeSheet(_shortcutsSheet, _shortcutsBackdrop));
  _shortcutsBackdrop?.addEventListener("click", () => closeSheet(_shortcutsSheet, _shortcutsBackdrop));

  // ⚠ boot 期**不**在这读 pref —— collection 还没 hydrate（v409 拆了 TLA 门），读到的是 DEFAULTS。
  //   真值由 app.ts 的 fixup 相（await prefsReady 后）调 renderSettingsFromPrefs() 灌入。
  applyCheckerboard(state.checkerboard);   // checkboard 是 per-doc desk（非 pref），不等 collection

  els.menuBtn.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    setMenuOpen(els.menuPanel.classList.contains("hidden"));
  });
  document.addEventListener("pointerdown", (e: Event) => {
    if (els.menuPanel.classList.contains("hidden")) return;
    if (els.menuPanel.contains(e.target as Node) || els.menuBtn.contains(e.target as Node)) return;
    setMenuOpen(false);
  });
}
