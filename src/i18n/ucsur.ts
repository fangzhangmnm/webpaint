// tok → UCSUR sitelen pona 转写（v0.5.35，user 拍板方案 C，2026-07-25）。
//
// 为什么转写而不是 ligature：nasin-nanpa 的 ASCII ligature 会把非 tp 词（"dev"）合成乱码；
//   UCSUR 码点（U+F1900 块）渲染不走 ligature——**词表内的 tp 词才成图，其余默认拉丁**，
//   escape 语义天然反转（dev/PNG/HEX/vN 全自动保持拉丁，零标注）。
//   翻译源文保持 ASCII 拉丁（translation agent 可读可写可 diff），本层在运行时转写。
//
// 转写四条件（与 Toki Pona repo 风格约定/linter 同一规则，negotiation 2026-07-25）：
//   ① token 纯小写字母 ② 命中词表（vendor/toki-pona/ucsur-map.json，Linku 快照）
//   ③ 紧邻无字母/数字/连字符（保住 v124a、4.0.2a 里的孤立字母） ④ 不在反引号跨度内。
//   agent 约定：有意保留拉丁的小写词/短语必须包反引号 `dev`；大写/含数字自动豁免。
//   反引号是标记，两种模式下都剥掉。
//
// 转写域 = textContent（含 placeholder/optgroup label——它们吃 DOM 字体）；
//   **title/aria 永远 ASCII**（浏览器 chrome/读屏渲染，UCSUR 必豆腐）——见 index.ts 的 tLatin。
//
// 字体门（方案 C）：check 命中（SW precache/二访）→ 立即转写；未命中 → 先 ASCII 出 UI，
//   fonts.load 促成后翻开关 + 重跑 localizeDom（静态全刷新；动态标签在下次更新自愈）。
//   任何路径都不可能出豆腐——转写只在字体确认可用后才开。

import ucsurMapJson from "../../vendor/toki-pona/ucsur-map.json" with { type: "json" };   // node 直跑测试要求显式属性

const MAP: Record<string, string> = ucsurMapJson as Record<string, string>;

let _active = false;
export function ucsurActive(): boolean { return _active; }

// 反引号剥离（latin 模式也要——它是标记不是内容）。
export function stripTokMarkup(s: string): string { return s.includes("`") ? s.replace(/`/g, "") : s; }

// 转写核心（纯函数，node 直测）。{param} 跨度原样保留（用户数据在插值时进入，绝不被转写）。
export function tokGlyphs(template: string): string {
  const n = template.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const ch = template[i];
    if (ch === "{") {   // 参数占位跨度
      const j = template.indexOf("}", i);
      if (j > 0) { out += template.slice(i, j + 1); i = j + 1; continue; }
    }
    if (ch === "`") {   // 显式拉丁跨度（agent 约定④）：剥标记、内容原样
      const j = template.indexOf("`", i + 1);
      if (j > 0) { out += template.slice(i + 1, j); i = j + 1; continue; }
      i++; continue;    // 落单反引号：剥掉
    }
    if (/[a-z]/.test(ch)) {
      let j = i;
      while (j < n && /[a-z]/.test(template[j])) j++;
      const word = template.slice(i, j);
      const prev = i > 0 ? template[i - 1] : "";
      const next = j < n ? template[j] : "";
      const clean = !/[A-Za-z0-9-]/.test(prev) && !/[A-Za-z0-9-]/.test(next);   // 条件③
      out += clean && MAP[word] ? MAP[word] : word;
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {   // 大写起头的词整体豁免（Blender/PNG…）
      let j = i;
      while (j < n && /[A-Za-z]/.test(template[j])) j++;
      out += template.slice(i, j);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// 按 key 缓存（模板不可变；切语言=reload 制，无失效问题）。
const _cache = new Map<string, string>();
export function tokGlyphsCached(key: string, template: string): string {
  let v = _cache.get(key);
  if (v === undefined) { v = tokGlyphs(template); _cache.set(key, v); }
  return v;
}

// 字体门（方案 C）。onLateReady：迟到促成时的静态重灌回调（index.ts 传 localizeDom）。
export function initTokFontGate(onLateReady: () => void): void {
  const fonts = (typeof document !== "undefined"
    ? (document as unknown as { fonts?: { check(f: string): boolean; load(f: string): Promise<unknown> } }).fonts
    : undefined);
  if (!fonts?.check) { _active = false; return; }   // 测试垫片/上古环境：全程 ASCII 拉丁
  const probe = '16px "nasin nanpa"';
  if (fonts.check(probe)) { _active = true; return; }
  fonts.load(probe).then(() => {
    if (_active || !fonts.check(probe)) return;
    _active = true;
    onLateReady();   // 静态 DOM 全刷新；动态标签下次更新自愈（字体 SW precache，迟到窗口通常仅毫秒级）
  }).catch(() => { /* 字体加载失败：保持 ASCII 拉丁（可读），永不豆腐 */ });
}
