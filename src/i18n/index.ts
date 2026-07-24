// i18n 运行时 —— t()（具名插值）+ 当前语言 + setLang（reload 制）+ data-i18n 启动填充（桥）。
// SSoT = ./strings.ts。设计见 docs/20260707-i18n-architecture.md。
//   · 切换 = 持久化 + location.reload()（绘画 app 语言 set-once，reload 干净、零半译状态）。
//   · <html lang> 随语言动态 → 浏览器选对 CJK 字形（日文汉字 ≠ 中文汉字）。
//   · data-i18n 是过渡桥（非终点）：静态 index.html 一次性填充；新内容/需动的段走 Vue + t()。

import { S, type Lang } from "./strings.ts";
import { syncedUserPreference, preferencesReady, PREF_DEFAULTS } from "../app-prefs.ts";   // 语言 = 跨设备偏好（synced-user-preference collection）
import { readBootSnapshot, writeBootSnapshot } from "../boot-snapshot.ts";   // eval 期读得到的 lang 快照（IDB 异步，见该文件）

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

const validLang = (v: unknown): Lang | null => (typeof v === "string" && LANGS.includes(v as Lang) ? v as Lang : null);

// collection（SSoT）里的 lang。未设 / 未 hydrate → null（= 跟系统）。
function langFromPrefs(): Lang | null {
  return validLang(syncedUserPreference.getItem<Lang | null>("lang", PREF_DEFAULTS.lang as Lang | null));
}
// 解析优先级：collection（hydrate 后才有值）→ **LS 快照**（eval 期唯一读得到的）→ 跟系统。
//   快照只在用户显式 setLang / 对账时写，所以"快照有值"≡"用户选过语言"，不会污染"跟系统"语义。
function readLang(): Lang {
  return langFromPrefs() ?? validLang(readBootSnapshot("lang")) ?? detectLang();
}

// _lang **惰性**解析（首次 t()/lang() 时读）+ 一经解析即锁死（reload 制，全 app 一个语言，不要半译状态）。
//   v409：eval 期读到的是 **LS 快照**（collection 还没 hydrate）——这正是快照存在的理由，也是
//   v406-v408 那道 TLA 门（`await initPreferences()` 再跑组合根）被拆掉的前提。见 boot-snapshot.ts。
//   hydrate 后由 reconcileLangFromPrefs() 对账；不一致 → 刷快照 + reload。
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

// （cycleLang 已删 v415：零调用者——语言在设置菜单里显式选，没有"循环切换"的入口。）

// ⚠ async：reload 之前必须**确认字节落了 IDB**。
//   v417 之前这里是同步的 setItem + 立刻 location.reload() —— setItem 只改内存并排一个 400ms
//   防抖写（collection.ts:169-172），reload 把定时器连页面一起杀掉，语言**从没进过 IDB**。
//   于是 reload 后 reconcileLangFromPrefs 读到 null → 连快照一起清 → 再 reload → 弹回系统语言。
//   观感就是「切了闪一下又回去」。对照组 theme 能用，正因为它写完不 reload。
export async function setLang(l: Lang): Promise<void> {
  if (!LANGS.includes(l) || l === lang()) return;   // 值没变就早退：别白盖 uat 触发无谓云同步
  await preferencesReady();                  // hydrate 前 setItem 会抛（collection.ts:253），而设置菜单一 boot 就可点
  syncedUserPreference.setItem("lang", l);   // SSoT：synced-user-preference collection（跨设备）
  writeBootSnapshot("lang", l);              // 先刷快照，再 reload —— 顺序不能反，否则 reload 后 eval 期读回旧值
  await syncedUserPreference.flushLocal();   // ★ 导航前屏障：不等这一下，上面那行等于没写
  location.reload();     // reload 制
}

// collection hydrate/reconcile 后对账（app.ts 的 fixup 相调）：先刷快照 → 语言不对就 reload。
//   触发场景：① 别的设备改了语言、云端 reconcile 拉回来 ② 本机快照丢了（清缓存/隐私模式）而 IDB 还在。
//   ⚠ 必须先写快照再 reload：reload 后 eval 期只读得到快照，不刷就无限 reload。
//   ⚠ `real == null → 清快照` 的正确性**依赖 setLang 的导航前屏障**（上面那个 await flushLocal）：
//     只有当"写了就一定落了盘"成立时，null 才真的等于"用户没选过语言"。屏障没了的话（v417 之前），
//     null 会混进"写丢了"的情形，这里就会把用户刚选的语言连快照一起抹掉。别把那个 await 优化掉。
//     反向喂回 collection **不是**选项——boot-snapshot.ts 纪律 #1：快照单向只写，绝不回灌 SSoT。
export function reconcileLangFromPrefs(): void {
  const real = langFromPrefs();
  writeBootSnapshot("lang", real);          // null（跟系统）→ 清快照
  const want = real ?? detectLang();
  if (want !== lang()) location.reload();
}

// 写入 data-i18n 元素的文本，**不碰它的元素子节点**。
//
// ⚠ 为什么不能直接 `el.textContent = s`：那会清空**所有**子节点，包括内联的 `<svg><use>` 图标。
//   v419 把一批菜单项前面加上图标后，boot 期的 localizeDom 当场把它们全冲掉了（v420 逐个把文案/结构
//   挪开修的——但那只修了当时那几个，机制没堵）。只要有人再给一个带图标的元素加 data-i18n，
//   图标就会在 boot 时**静默消失**：不报错、不 tsc 失败，只有真机上肉眼能看见。这里从根上堵掉。
//
// 策略：纯文本元素走原来的快路径（行为逐字不变）；有元素子节点时就地改**第一个非空白文本节点**，
//   图标和前后顺序原样保留（`<button><svg/>文字</button>` 和 `<span>文字<svg/></span>` 都对）。
// export 是为了可测：不变式「写文本但不碰元素子节点」只有直接测它才立得住——
//   测试垫片的 textContent 是个普通属性、不会清空子节点，透过 localizeDom 测等于没测（旧代码也能过）。
export function setLocalizedText(el: HTMLElement, s: string): void {
  if (el.children.length === 0) { el.textContent = s; return; }   // 无元素子节点 → 老路径
  const texts = Array.from(el.childNodes).filter((n): n is Text => n.nodeType === 3);
  const target = texts.find((n) => (n.textContent ?? "").trim() !== "");
  if (!target) {
    // 只有图标、没有文案 → 补一个文本节点在末尾。
    //   ⚠ 用 appendChild(createTextNode)，别用 el.append(s)：测试垫片的 append 会忽略字符串参数。
    el.appendChild(document.createTextNode(s));
    return;
  }
  target.textContent = s;
  // 清掉其余**非空白**文本节点（重复标签）；空白节点留着，它们是 HTML 排版产生的、无害。
  for (const n of texts) if (n !== target && (n.textContent ?? "").trim() !== "") n.remove();
}

// data-i18n 桥：静态 HTML 一次性填充。textContent / title / aria-label / placeholder / optgroup label 五种 attr。
export function localizeDom(root: ParentNode = document) {
  const k = (s: string | undefined) => s as Key;   // 桥 attr 值是运行时字符串（不受 tsc 检查）；t() 内部对未知 key 兜底
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach(el => { if (el.dataset.i18n) setLocalizedText(el, t(k(el.dataset.i18n))); });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach(el => { if (el.dataset.i18nTitle) el.title = t(k(el.dataset.i18nTitle)); });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach(el => { if (el.dataset.i18nAria) el.setAttribute("aria-label", t(k(el.dataset.i18nAria))); });
  root.querySelectorAll<HTMLInputElement>("[data-i18n-ph]").forEach(el => { if (el.dataset.i18nPh) el.placeholder = t(k(el.dataset.i18nPh)); });
  // v0.5.10：<optgroup label> 走属性而非文本节点（新建作品尺寸下拉的分组标题用）
  root.querySelectorAll<HTMLOptGroupElement>("optgroup[data-i18n-label]").forEach(el => { if (el.dataset.i18nLabel) el.label = t(k(el.dataset.i18nLabel)); });
}

// boot：设 <html lang> + 填静态 HTML。app.ts 早期调（DOM 已就绪，module 默认 deferred）。
export function initI18n() {
  applyHtmlLang();
  localizeDom();
}
