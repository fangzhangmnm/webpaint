// 职责（单一）：主题切换（auto/日/夜）——data-theme attr + board void 色 + 菜单标签 + 持久化（local-user-preference）。
//
// 主题 = **一个 css**：换主题只改 `data-theme` attr + board void 色，无 reload、随时可换（对比 i18n 的 setLang 是 reload 制）。
// SSoT = local-user-preference collection（设备本地，跟设备日夜/环境，不跨设备）。
// boot 两段（v409）：① `<head>` guard + initTheme 用 **LS 快照**同步贴（IDB 异步、首帧前读不到 → 见 boot-snapshot.ts）
//                    ② collection hydrate 后 `reconcileThemeFromPrefs()` 对账：先刷快照，值不对就地换。
import type { AppContext } from "./app-context.ts";
import { els } from "./els.ts";
import { localUserPreference, PREF_DEFAULTS } from "./app-prefs.ts";   // 主题 = 设备本地偏好（跟设备日夜/环境，不跨设备）
import { readBootSnapshot, writeBootSnapshot } from "./boot-snapshot.ts";
import { t, type Key } from "./i18n/index.ts";

export const THEMES = ["auto", "day", "night"];
// 主题状态标签走 i18n（key: theme.auto / theme.day / theme.night）。
export function themeLabel(th: string): string { return t(`theme.${th}` as Key); }

const valid = (v: string | null | undefined): string => (v && THEMES.includes(v) ? v : "auto");

// collection（SSoT）读。⚠ hydrate 前会返 PREF_DEFAULTS（"auto"）——分不清"用户就选了 auto"和"还没就绪"，
//   故 boot 期别用它，用 readBootTheme()；hydrate 后（reconcile）才是权威。
function readTheme(): string {
  return valid(localUserPreference.getItem<string>("color-theme", PREF_DEFAULTS["color-theme"]));
}
// boot 期读：LS 快照（与 index.html 的 guard 同源，故首帧与 JS 首次渲染一致，不会自己闪一下）。
function readBootTheme(): string { return valid(readBootSnapshot("theme")); }

let theme = readBootTheme();
let board: AppContext["board"];

function readCssColor(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function applyThemeColorsToBoard() {
  board.setThemeColors({
    voidColor: readCssColor("--void"),
    voidDotColor: readCssColor("--void-dot"),     // 透明显示模式：点网格色
    docFrameColor: readCssColor("--doc-frame"),   // 透明显示模式：doc 细框（白@日/黑@夜）
  });
}

// 只贴 DOM/board/label（**不写盘**）——boot 贴 / 对账热重贴 复用（换主题=换 CSS，无 reboot）。
function renderTheme(th: string) {
  theme = th;
  document.documentElement.setAttribute("data-theme", th);
  const lbl = els.menuTheme?.querySelector?.('[data-state-for="theme"]');
  if (lbl) lbl.textContent = themeLabel(th);
  const lbl2 = document.getElementById("menuThemeBtnLabel");   // v0.5.37 in-app 下拉按钮 label
  if (lbl2) lbl2.textContent = themeLabel(th);
  requestAnimationFrame(applyThemeColorsToBoard);
}

// 用户显式换主题：贴 + 写 SSoT + 刷快照（快照供下次冷启动的 pre-paint guard）。
export function applyTheme(th: string) {
  renderTheme(th);
  localUserPreference.setItem("color-theme", th);   // SSoT：local-user-preference collection
  writeBootSnapshot("theme", th);                   // 单向镜像：只给下次 boot 的 guard 读
}
export function cycleTheme() { return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; }
export function currentTheme(): string { return theme; }
// （currentTheme 已删 v415：零调用者。）

// collection hydrate 后对账（app.ts 的 fixup 相调）：先刷快照 → 值不对就地换（主题=css，无需 reload）。
//   典型触发：快照丢了（清缓存/隐私模式）或旧版本遗留的 `webpaint.theme` 还没迁过来。
export function reconcileThemeFromPrefs(): void {
  const th = readTheme();                 // hydrate 后 = 权威
  writeBootSnapshot("theme", th);
  if (th !== theme) renderTheme(th);
}

export function initTheme(ctx: AppContext) {
  board = ctx.board;
  renderTheme(readBootTheme());   // boot：贴快照值（与 <head> guard 同源）；真值等 reconcileThemeFromPrefs
  // ⚠ 不订 onChange：local-user-preference 是 {local:true}=cloudless，collection 的 fireChanged 只在 sync() 里调，
  //   而 sync() 对 cloudless 直接 return → **永不触发**。v406-v408 这里挂过一个 onChange，是结构上不可达的死代码。
  //   主题不跨设备（设计如此），同 tab 内的改动 applyTheme 已经贴过了。
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (theme === "auto") requestAnimationFrame(applyThemeColorsToBoard);
  });
}
