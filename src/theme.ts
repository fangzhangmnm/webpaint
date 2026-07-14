// 职责（单一）：主题切换（auto/日/夜）——data-theme attr + board void 色 + 菜单标签 + 持久化（local-user-preference）。
import type { AppContext } from "./app-context.ts";
import { els } from "./els.ts";
import { localUserPreference, PREF_DEFAULTS } from "./app-prefs.ts";   // 主题 = 设备本地偏好（跟设备日夜/环境，不跨设备）
import { t, type Key } from "./i18n/index.ts";

export const THEMES = ["auto", "day", "night"];
// 主题状态标签走 i18n（key: theme.auto / theme.day / theme.night）。
export function themeLabel(th: string): string { return t(`theme.${th}` as Key); }

function readTheme(): string {
  const v = localUserPreference.getItem<string>("color-theme", PREF_DEFAULTS["color-theme"]);
  return THEMES.includes(v) ? v : "auto";
}
let theme = readTheme();
let board: AppContext["board"];

function readCssColor(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function applyThemeColorsToBoard() {
  board.setThemeColors({ voidColor: readCssColor("--void") });
}

// 只贴 DOM/board/label（**不写盘**）——applyTheme 与云端 onChange 热重贴复用（换主题=换 CSS，无 reboot）。
function renderTheme(th: string) {
  theme = th;
  document.documentElement.setAttribute("data-theme", th);
  const lbl = els.menuTheme.querySelector('[data-state-for="theme"]');
  if (lbl) lbl.textContent = themeLabel(th);
  requestAnimationFrame(applyThemeColorsToBoard);
}

export function applyTheme(th: string) {
  renderTheme(th);
  localUserPreference.setItem("color-theme", th);   // 落 local-user-preference collection
}
export function cycleTheme() { return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; }
export function currentTheme() { return theme; }

export function initTheme(ctx: AppContext) {
  board = ctx.board;
  renderTheme(readTheme());   // boot：贴当前（hydrate 后）值，不重复写盘
  // 云端 reconcile 带来新主题 → 热重贴（不 reboot、不回写，避免 churn）。
  localUserPreference.onChange((ids) => { if (ids.includes("color-theme")) renderTheme(readTheme()); });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (theme === "auto") requestAnimationFrame(applyThemeColorsToBoard);
  });
}
