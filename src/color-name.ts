// 职责（单一）：颜色 ↔ 名字。纯函数、零 DOM/canvas。
// 数据 = color-words.ts 的**统一大表**（[类别, 名, hex, 别名, slang]）。**类别 = culture，
// 不是 localization**（2026-07-30 user：二次元场景中国传统色远优于 western——culture awareness
// is critical）：命名词库用户自选（explode sheet 的 inline-select），localization 只决定**默认值**
// （defaultCulture）；色名不翻译，就用 culture 自己的语言。本模块对类别零 special-case——
// **以后加 culture 只加行不改码**。
//
// · colorNameIn(culture, r,g,b)：命名 = 表按 culture 过滤（slang 行跳过；该 culture 无行则
//   fallback xkcd）。nearest 在 OKLab（感知均匀，RGB 欧氏会把蓝紫认错）。产出是**死字符串**
//   （图层名烘焙即定，换语言/culture 不回译）。
// · parseColorName(text)：全 culture 搜索，大小写/空格不敏感（另挂去空格/冒号变体：skyblue /
//   tab blue 也认）。撞名先到先得，**表行序 = 优先级**（mpl > css > xkcd > zh-trad > ja-trad
//   > tok，universal → 小众）；slang 照认——输入不 censor，只有输出不吓人。
//   注意「blue」落 css 档 = 标准化石值 #0000ff（user 点名跟标准对齐），非 xkcd 质心。

import { COLOR_WORDS } from "./color-words.ts";
import { lang } from "./i18n/index.ts";

// sRGB → OKLab（Björn Ottosson 2020 标准系数）。
function srgbToOklab(r8: number, g8: number, b8: number): [number, number, number] {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const r = lin(r8), g = lin(g8), b = lin(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function hexRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

// 每语言的命名表（labels + 锚点 OKLab），按需惰性建。key = 类别字符串，泛化零 special-case。
interface NamingTable { labels: string[]; labs: Float64Array }
const _naming = new Map<string, NamingTable>();
function namingTable(l: string): NamingTable {
  let t = _naming.get(l);
  if (!t) {
    let rows = COLOR_WORDS.filter((r) => r[0] === l && !r[4]);
    if (rows.length === 0) rows = COLOR_WORDS.filter((r) => r[0] === "xkcd" && !r[4]);   // 未收录 culture 兜底
    const labels = rows.map((r) => r[1]);
    const labs = new Float64Array(rows.length * 3);
    for (let i = 0; i < rows.length; i++) {
      const [r, g, b] = hexRgb(rows[i][2]);
      const [L, a, bb] = srgbToOklab(r, g, b);
      labs[i * 3] = L; labs[i * 3 + 1] = a; labs[i * 3 + 2] = bb;
    }
    t = { labels, labs };
    _naming.set(l, t);
  }
  return t;
}

// localization → 默认 culture 的唯一映射点（sheet 的 dropdown 初值用它；用户选了就听用户的）。
export function defaultCulture(): string {
  const l = lang();
  return l === "zh" ? "zh-trad" : l === "ja" ? "ja-trad" : l === "tok" ? "tok" : "xkcd";
}

/** 指定 culture 下这个颜色叫什么。 */
export function colorNameIn(l: string, r: number, g: number, b: number): string {
  const { labels, labs } = namingTable(l);
  const [L, a, bb] = srgbToOklab(r, g, b);
  let bi = 0, bd = Infinity;
  for (let i = 0; i < labels.length; i++) {
    const dL = L - labs[i * 3], da = a - labs[i * 3 + 1], db = bb - labs[i * 3 + 2];
    const d = dL * dL + da * da + db * db;
    if (d < bd) { bd = d; bi = i; }
  }
  return labels[bi];
}

/** 默认 culture（按 localization 映射）下这个颜色叫什么（死字符串，烘焙即定）。 */
export function colorNameOf(r: number, g: number, b: number): string {
  return colorNameIn(defaultCulture(), r, g, b);
}

// parse 索引惰性建一次（~2100 行 → 约 5000 词条含变体，Map 常驻十 KB 级）。
let _parseIdx: Map<string, string> | null = null;
function norm(s: string): string { return s.trim().toLowerCase().replace(/\s+/g, " "); }
function parseIdx(): Map<string, string> {
  if (!_parseIdx) {
    const idx = _parseIdx = new Map<string, string>();
    const put = (label: string, hex: string) => {
      const k = norm(label);
      if (!idx.has(k)) idx.set(k, hex);
      const nospace = k.replace(/[ :]/g, "");   // skyblue / tabblue / tab:blue→tabblue
      if (!idx.has(nospace)) idx.set(nospace, hex);
    };
    for (const [, name, hex, alias] of COLOR_WORDS) {   // 表行序 = 优先级，先到先得
      put(name, hex);
      if (name.includes(":")) put(name.replace(":", " "), hex);   // "tab blue"（带空格变体）
      if (alias) put(alias, hex);                                  // かな读音 / 拼音
    }
  }
  return _parseIdx;
}

/** 颜色名（任意语言）→ hex；认不出 → null。hex 本身不归这儿管（调用方先试 normalizeHex）。 */
export function parseColorName(text: string): string | null {
  return parseIdx().get(norm(text)) ?? null;
}

/** 色名联想（autocomplete 数据面）：前缀命中优先、**中间/尾缀子串命中保底一半槽位**
 *  （2026-07-30 user：中文品类字在尾巴——输「黄」必须查得到「豆汁黄」，不能被黄x前缀挤光）。
 *  名与别名（かな/拼音）都参与匹配，显示用正名；同档内 = 表序（priority）。
 *  全表线性扫（~2100 行/键击，个位 ms）。 */
export function searchColorNames(query: string, limit = Infinity): { name: string; hex: string }[] {
  const q = norm(query);
  if (!q) return [];
  const qn = q.replace(/[ :]/g, "");
  const pre: { name: string; hex: string }[] = [];
  const sub: { name: string; hex: string }[] = [];
  const seen = new Set<string>();
  for (const [, name, hex, alias] of COLOR_WORDS) {
    if (pre.length >= limit && sub.length >= limit) break;
    const n = norm(name), nn = n.replace(/[ :]/g, "");
    const a = alias ? norm(alias) : "";
    const key = n + hex;
    if (seen.has(key)) continue;
    if (pre.length < limit && (n.startsWith(q) || nn.startsWith(qn) || (a && a.startsWith(q)))) {
      seen.add(key); pre.push({ name, hex });
    } else if (sub.length < limit && (n.includes(q) || (a && a.includes(q)))) {
      seen.add(key); sub.push({ name, hex });
    }
  }
  if (!Number.isFinite(limit)) return pre.concat(sub);   // 无上限（默认）：前缀档全排前，子串档殿后
  // 有限 limit 的槽位分配：子串命中在场时给它保底 ⌈limit/2⌉，前缀拿剩下的；子串不足时前缀补满。
  const subQuota = Math.min(sub.length, Math.ceil(limit / 2));
  const preTake = Math.min(pre.length, limit - subQuota);
  return pre.slice(0, preTake).concat(sub.slice(0, limit - preTake));
}
