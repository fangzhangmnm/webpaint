// 色轮的纯模型（UI 深化 candidate 1 · pilot）。
//
// 这是「色轮该怎么算」的全部领域知识：HSV⇄hex 转换 + hex 解析 + 同色判定。
// 零 DOM / 零 Vue / 零状态——纯函数，node 直测（test/color-model.test.mjs）。
// 色轮组件（color-wheel.ts）只是这套函数 + 一层薄 Vue 渲染。
//
// 历史 bug（保住）：HSV→RGB→HSV 在低饱和/低明度处 hue 数学上无定义，hexToHsv 默认 h=0。
// 所以「内部 pad/hue 拖动产生的 hex 回灌」绝不能重新派生 HSV（否则 hue slider 跳回 0）。
// 这个不变式由组件用 sameHex(lastEmitted, incoming) 守，模型只保证转换纯净。

export interface Hsv {
  h: number; // 0..360
  s: number; // 0..1
  v: number; // 0..1
}

// h:0..360 s,v:0..1 → "#rrggbb"
export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const hp = (h / 60) % 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (0 <= hp && hp < 1) { r = c; g = x; b = 0; }
  else if (1 <= hp && hp < 2) { r = x; g = c; b = 0; }
  else if (2 <= hp && hp < 3) { r = 0; g = c; b = x; }
  else if (3 <= hp && hp < 4) { r = 0; g = x; b = c; }
  else if (4 <= hp && hp < 5) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const m = v - c;
  const R = Math.round((r + m) * 255), G = Math.round((g + m) * 255), B = Math.round((b + m) * 255);
  return "#" + [R, G, B].map((n) => n.toString(16).padStart(2, "0")).join("");
}

// "#rrggbb" → HSV；非法输入返回 {0,0,0}
export function hexToHsv(hex: string): Hsv {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return { h: 0, s: 0, v: 0 };
  const R = parseInt(hex.slice(1, 3), 16) / 255;
  const G = parseInt(hex.slice(3, 5), 16) / 255;
  const B = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === R) h = ((G - B) / d) % 6;
    else if (mx === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = mx === 0 ? 0 : d / mx;
  const v = mx;
  return { h, s, v };
}

// 把用户在 HEX 输入框敲的东西规整成 "#rrggbb"，失败返回 null（调用方负责报错/还原）。
export function normalizeHex(input: string): string | null {
  let v = (input || "").trim();
  if (!v.startsWith("#")) v = "#" + v;
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
}

// 大小写无关的同色判定（守 round-trip 不变式用）。
export function sameHex(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}
