// i18n 运行时 —— t()（具名插值）+ 当前语言 + setLang（reload 制）+ data-i18n 启动填充（桥）。
// SSoT = ./strings.ts。设计见 docs/20260707-i18n-architecture.md。
//   · 切换 = 持久化 + location.reload()（绘画 app 语言 set-once，reload 干净、零半译状态）。
//   · <html lang> 随语言动态 → 浏览器选对 CJK 字形（日文汉字 ≠ 中文汉字）。
//   · data-i18n 是过渡桥（非终点）：静态 index.html 一次性填充；新内容/需动的段走 Vue + t()。

import { S, type Lang } from "./strings.ts";
import { syncedUserPreference, PREF_DEFAULTS } from "../app-prefs.ts";   // 语言 = 跨设备偏好（synced-user-preference collection）

export type { Lang } from "./strings.ts";
export type Key = keyof typeof S;

export const LANGS: Lang[] = ["zh", "en", "ja", "tok"];
// 语言名用 endonym（各语言自称，不翻译）——菜单里显示当前语言用。
export const LANG_NAME: Record<Lang, string> = { zh: "中文", en: "English", ja: "日本語", tok: "toki pona" };

// 首次运行（无持久化）按系统语言判定。未支持的系统语言 → 英文（更国际；用户 2026-07-07 定）。
function detectLang(): Lang {
  const n = (navigator.language || "en").toLowerCase();
  if (n.startsWith("ja")) return "ja";
  if (n.startsWith("zh")) return "zh";
  if (n.startsWith("tok")) return "tok";
  return "en";
}

function readLang(): Lang {
  const v = syncedUserPreference.getItem<Lang | null>("lang", PREF_DEFAULTS.lang as Lang | null);
  return v && LANGS.includes(v) ? v : detectLang();
}

// _lang **惰性**解析（首次 t()/lang() 时读）——避免模块 eval 期读 collection（那时 boot 门还没 hydrate 完）。
//   首次访问发生在 boot 门 `await initPreferences()` 之后（app-main 动态 import 内），故读到的是 hydrate 后的值。
let _lang: Lang | null = null;

export function lang(): Lang { return (_lang ??= readLang()); }

// t(key, params?)：读当前语言一次（reload 制，无需响应式订阅）。fallback：请求语言 → en → zh。
export function t(key: Key, params?: Record<string, string | number>): string {
  const e = S[key] as Record<string, string> | undefined;
  if (!e) { console.warn("[i18n] missing key:", key); return String(key); }   // 桥的 data-i18n 不受 tsc 检查 → 防崩
  const raw = e[lang()] ?? e.en ?? e.zh;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_m, k) => (k in params ? String(params[k]) : `{${k}}`));
}

function htmlLangFor(l: Lang): string {
  return l === "zh" ? "zh-CN" : l;   // ja / en / tok 原样；zh 用 zh-CN 走简中字形
}
export function applyHtmlLang() { document.documentElement.lang = htmlLangFor(lang()); }

export function cycleLang(): Lang { return LANGS[(LANGS.indexOf(lang()) + 1) % LANGS.length]; }

export function setLang(l: Lang) {
  if (!LANGS.includes(l) || l === lang()) return;
  syncedUserPreference.setItem("lang", l);   // 落 synced-user-preference collection（跨设备）
  location.reload();     // reload 制
}

// data-i18n 桥：静态 HTML 一次性填充。textContent / title / aria-label / placeholder 四种 attr。
export function localizeDom(root: ParentNode = document) {
  const k = (s: string | undefined) => s as Key;   // 桥 attr 值是运行时字符串（不受 tsc 检查）；t() 内部对未知 key 兜底
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach(el => { if (el.dataset.i18n) el.textContent = t(k(el.dataset.i18n)); });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach(el => { if (el.dataset.i18nTitle) el.title = t(k(el.dataset.i18nTitle)); });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach(el => { if (el.dataset.i18nAria) el.setAttribute("aria-label", t(k(el.dataset.i18nAria))); });
  root.querySelectorAll<HTMLInputElement>("[data-i18n-ph]").forEach(el => { if (el.dataset.i18nPh) el.placeholder = t(k(el.dataset.i18nPh)); });
}

// boot：设 <html lang> + 填静态 HTML。app.ts 早期调（DOM 已就绪，module 默认 deferred）。
export function initI18n() {
  applyHtmlLang();
  localizeDom();
}
