// 职责（单一）：主题切换（auto/日/夜）——data-theme attr + board void 色 + 菜单标签 + 持久化。
import type { AppContext } from "./app-context.ts";
import { els } from "./els.ts";
import { safeLS } from "./safe-ls.ts";
import { getPref, setPref } from "./syncable-prefs.ts";   // 主题 = 「跨设备同步候选」偏好（与语言同处；现设备本地）
import { t, type Key } from "./i18n/index.ts";

export const THEMES = ["auto", "day", "night"];
// 主题状态标签走 i18n（key: theme.auto / theme.day / theme.night）。
export function themeLabel(th: string): string { return t(`theme.${th}` as Key); }

let theme = getPref("theme") ?? safeLS("webpaint.theme") ?? "auto";   // 新 blob 优先，旧散键兜底（迁移）
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
  setPref("theme", t);   // 落 syncable-prefs（与语言同处；现设备本地）
  const lbl = els.menuTheme.querySelector('[data-state-for="theme"]');
  if (lbl) lbl.textContent = themeLabel(t);
  requestAnimationFrame(applyThemeColorsToBoard);
}
export function cycleTheme() { return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; }
export function currentTheme() { return theme; }

export function initTheme(ctx: AppContext) {
  board = ctx.board;
  applyTheme(theme);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (theme === "auto") requestAnimationFrame(applyThemeColorsToBoard);
  });
}
