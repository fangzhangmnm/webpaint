// 职责（单一）：主题切换（auto/日/夜）——data-theme attr + board void 色 + 菜单标签 + 持久化。
import { els } from "./els.ts";
import { safeLS, safeLSSet } from "./safe-ls.ts";

export const THEMES = ["auto", "day", "night"];
export const THEME_LABEL: Record<string, string> = { auto: "跟随系统", day: "日", night: "夜" };

let theme = safeLS("webpaint.theme") || "auto";
if (!THEMES.includes(theme)) theme = "auto";
let board: any;

function readCssColor(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function applyThemeColorsToBoard() {
  board.setThemeColors({ voidColor: readCssColor("--void") });
}

export function applyTheme(t: string) {
  theme = t;
  document.documentElement.setAttribute("data-theme", t);
  safeLSSet("webpaint.theme", t);
  els.menuTheme.querySelector('[data-state-for="theme"]').textContent = THEME_LABEL[t];
  requestAnimationFrame(applyThemeColorsToBoard);
}
export function cycleTheme() { return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; }
export function currentTheme() { return theme; }

export function initTheme(ctx) {
  board = ctx.board;
  applyTheme(theme);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (theme === "auto") requestAnimationFrame(applyThemeColorsToBoard);
  });
}
