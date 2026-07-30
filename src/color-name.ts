// 职责（单一）：颜色 ↔ 名字（localization-aware）。数据 = color-name-table.ts（xkcd top-120）。
//   · colorNameOf(r,g,b)：最近锚点的**当前语言**名（OKLab 距离——RGB 欧氏会把蓝紫认错）。
//     产出是**死字符串**（图层名等烘焙即定，换语言不回译，user 2026-07-30 拍板）。
//   · parseColorName(text)：名字 → hex。**四语全收**（中文界面输 "sky blue" 照样认），
//     大小写/空格不敏感，撞名（tok 合体词多锚点共用）按表序 = 热度先到先得。
// 纯函数、零 DOM/canvas。lang() 只在 colorNameOf 调用时读（reload 制，安全）。

import { COLOR_NAMES, type ColorNameEntry } from "./color-name-table.ts";
import { lang } from "./i18n/index.ts";

// sRGB → OKLab（Björn Ottosson 2020 标准系数）。感知均匀：nearest 在这儿做才符合直觉。
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

// 锚点 OKLab 惰性预算一次（120 × 3 float，模块常驻可忽略）。
let _labs: Float64Array | null = null;
function labs(): Float64Array {
  if (!_labs) {
    _labs = new Float64Array(COLOR_NAMES.length * 3);
    for (let i = 0; i < COLOR_NAMES.length; i++) {
      const [r, g, b] = hexRgb(COLOR_NAMES[i].hex);
      const [L, a, bb] = srgbToOklab(r, g, b);
      _labs[i * 3] = L; _labs[i * 3 + 1] = a; _labs[i * 3 + 2] = bb;
    }
  }
  return _labs;
}

// 最近锚点条目（纯，测试面）。
export function nearestColorEntry(r: number, g: number, b: number): ColorNameEntry {
  const [L, a, bb] = srgbToOklab(r, g, b);
  const t = labs();
  let bi = 0, bd = Infinity;
  for (let i = 0; i < COLOR_NAMES.length; i++) {
    const dL = L - t[i * 3], da = a - t[i * 3 + 1], db = bb - t[i * 3 + 2];
    const d = dL * dL + da * da + db * db;
    if (d < bd) { bd = d; bi = i; }
  }
  return COLOR_NAMES[bi];
}

/** 当前语言下这个颜色叫什么（死字符串，烘焙即定）。 */
export function colorNameOf(r: number, g: number, b: number): string {
  return nearestColorEntry(r, g, b)[lang()];
}

// parse 索引惰性建一次：四语标签（+en 去空格变体，CSS 习惯的 "skyblue" 也认）→ hex。
//   先到先得（表序 = 热度）：tok "laso" 撞 N 个锚点时给最常用的那个。
let _parseIdx: Map<string, string> | null = null;
function norm(s: string): string { return s.trim().toLowerCase().replace(/\s+/g, " "); }
function parseIdx(): Map<string, string> {
  if (!_parseIdx) {
    _parseIdx = new Map();
    const put = (label: string, hex: string) => {
      const k = norm(label);
      if (!_parseIdx!.has(k)) _parseIdx!.set(k, hex);
      const nospace = k.replace(/ /g, "");
      if (!_parseIdx!.has(nospace)) _parseIdx!.set(nospace, hex);
    };
    for (const e of COLOR_NAMES) { put(e.en, e.hex); put(e.zh, e.hex); put(e.ja, e.hex); put(e.tok, e.hex); }
  }
  return _parseIdx;
}

/** 颜色名（任意语言）→ hex；认不出 → null。hex 本身不归这儿管（调用方先试 normalizeHex）。 */
export function parseColorName(text: string): string | null {
  return parseIdx().get(norm(text)) ?? null;
}
