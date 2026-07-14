// 职责（单一）：汉堡 ⋯ 菜单面板——设置开关（压·粗 / 压·透 / 长按吸色 / 透明棋盘 / 像素栅格 /
// 主题 / 检测更新 stub / 清空 stub）+ 快捷键 sheet（从 KEYBOARD_SHORTCUTS 自动渲染）+ 菜单开关。
//
// 旧 app.js 「汉堡菜单」区逐字搬来；app.js 短路成 import + initSettingsMenu() 装配。
// setMenuOpen export 给 ctx（doc-ops 等也调）；boot 的 apply* 初始化调用进 initSettingsMenu()。
//
// 仍留 app.js 的协作件经 ctx 绑入：state / board / setStatus / store / updateSaveStatus（核心单例）。

import { els } from "./els.ts";
import { syncedUserPreference, PREF_DEFAULTS } from "./app-prefs.ts";   // 手势/视图开关 = 跨设备偏好
import { editorState } from "./editor-state.ts";   // checkboard = per-doc editorState（载入时经 wp:applyEditorState 应用到 board）
import { applyTheme, cycleTheme, themeLabel } from "./theme.ts";
import { t, lang, setLang, LANGS, LANG_NAME, type Key, type Lang } from "./i18n/index.ts";
import { KEYBOARD_SHORTCUTS } from "./input.ts";
import { _updateMenuCropLabel } from "./doc-ops.ts";
import { positionPopup } from "./anchored-popup.ts";
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
  renderPixelGrid(syncedUserPreference.getItem<boolean>("pixel-grid", PREF_DEFAULTS["pixel-grid"]));
  renderFps(syncedUserPreference.getItem<boolean>("show-fps", PREF_DEFAULTS["show-fps"]));
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
  }
}

export function initSettingsMenu(ctx: AppContext) {
  ({ state, board, setStatus, store, updateSaveStatus } = ctx);

  els.menuLongPressPick.addEventListener("click", () => {
    applyLongPressPick(!state.longPressPick);
    setStatus(t("status.longPressPick", { s: state.longPressPick ? t("common.on") : t("common.off") }));
  });
  els.menuSingleFingerDraw.addEventListener("click", () => {
    applySingleFingerDraw(!state.singleFingerDraw);
    setStatus(t("status.singleFingerDraw", { s: state.singleFingerDraw ? t("common.on") : t("common.off") }));
  });
  // desk 载入：文档的 checkboard 回灌到 board（applyCheckerboard 只写 board+mirror，不写 editorState→不标脏；守人类 2026-06-10 决定）。
  window.addEventListener("wp:applyEditorState", () => applyCheckerboard(editorState.checkboard));
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

  if (els.menuFps) els.menuFps.addEventListener("click", () => {
    const next = !board.getShowFps?.();
    applyFps(next);
    setStatus(t("status.fps", { s: next ? t("common.on") : t("common.off") }));
  });
  els.menuTheme.addEventListener("click", () => {
    const next = cycleTheme();
    applyTheme(next);
    setStatus(t("status.theme", { s: themeLabel(next) }));
  });
  // 语言：下拉框选择（endonym = 各语母语名，任何 UI 语言都认得；change 即 setLang→reload）。
  const menuLanguageSelect = document.getElementById("menuLanguageSelect") as HTMLSelectElement | null;
  if (menuLanguageSelect) {
    // endonym 是静态语言名（中文/English/日本語/toki pona），非用户数据 → innerHTML 安全。
    menuLanguageSelect.innerHTML = LANGS.map((l) =>
      `<option value="${l}"${l === lang() ? " selected" : ""}>${LANG_NAME[l]}</option>`).join("");
    menuLanguageSelect.addEventListener("change", () => setLang(menuLanguageSelect.value as Lang));   // setLang 内部 reload
  }
  // v100：删「检测更新」menu (实测在 iPad PWA 上不可靠，user：「检测更新功能没用」)。
  // 强制更新一律走「强制清缓存重启」（menuForcePwaReset）— 详 docs/20260526-pwa-update-detection.md。
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
