// 职责（单一）：主题切换（auto/日/夜）——data-theme attr + board void 色 + 菜单标签 + 持久化。
import type { AppContext } from "./app-context.ts";
import { els } from "./els.ts";
import { getSetting, setSetting, onSyncedSettingChange } from "./settings.ts";   // 主题 = synced 设置（跨设备跟人）
import { t, type Key } from "./i18n/index.ts";

export const THEMES = ["auto", "day", "night"];
// 主题状态标签走 i18n（key: theme.auto / theme.day / theme.night）。
export function themeLabel(th: string): string { return t(`theme.${th}` as Key); }

let theme = getSetting<string>("theme");   // settings 深模块：旧键迁移 + default "auto" 内化
if (!THEMES.includes(theme)) theme = "auto";
let board: AppContext["board"];

function readCssColor(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function applyThemeColorsToBoard() {
  board.setThemeColors({ voidColor: readCssColor("--void") });
}

export function applyTheme(t: string) {
  theme = t;
  document.documentElement.setAttribute("data-theme", t);
  setSetting("theme", t);   // settings 深模块：本地镜像 + 跨设备 syncedSettings
  const lbl = els.menuTheme.querySelector('[data-state-for="theme"]');
  if (lbl) lbl.textContent = themeLabel(t);
  requestAnimationFrame(applyThemeColorsToBoard);
}
export function cycleTheme() { return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; }
export function currentTheme() { return theme; }

export function initTheme(ctx: AppContext) {
  board = ctx.board;
  applyTheme(theme);
  // 跨设备：initSettings 拉云后若别的设备改了 theme → 重贴（本地镜像已被折回，直接读）。
  onSyncedSettingChange("theme", () => { const v = getSetting<string>("theme"); if (THEMES.includes(v)) applyTheme(v); });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (theme === "auto") requestAnimationFrame(applyThemeColorsToBoard);
  });
}
