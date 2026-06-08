// 笔粗分段量化（UI 深化 candidate 1）。纯函数，无 DOM——左栏 size slider 与笔设置编辑器共用。
//
// 从 app.js 原样搬出（_segPositions/_quantizeSize/sliderPosToSize/sizeToSliderPos/_sliderMaxPos/_stepFor）。
// 量化规格（user：「20内1, 50内2, 100内5, 200内10, 500内20, 1000内50」）：
//   1..20 步1 · 20..50 步2 · 50..100 步5 · 100..200 步10 · 200..500 步20 · 500..1000 步50
// node 可测（test/brush-size.test.mjs）。

interface SegCount { a: number; b: number; c: number; d: number; e: number; f: number; total: number; }

// 各段的 slider position 数量（HTML range 是均匀整数刻度，靠这张表把刻度映成 px）。
export function segPositions(maxPx: number): SegCount {
  const a = Math.max(0, Math.min(20, maxPx));
  const bEnd = Math.min(50, maxPx);   const b = bEnd > 20  ? Math.floor((bEnd - 20)  / 2)  : 0;
  const cEnd = Math.min(100, maxPx);  const c = cEnd > 50  ? Math.floor((cEnd - 50)  / 5)  : 0;
  const dEnd = Math.min(200, maxPx);  const d = dEnd > 100 ? Math.floor((dEnd - 100) / 10) : 0;
  const eEnd = Math.min(500, maxPx);  const e = eEnd > 200 ? Math.floor((eEnd - 200) / 20) : 0;
  const fEnd = Math.min(1000, maxPx); const f = fEnd > 500 ? Math.floor((fEnd - 500) / 50) : 0;
  return { a, b, c, d, e, f, total: a + b + c + d + e + f };
}

export function sliderPosToSize(pos: number, maxPx: number): number {
  const { a, b, c, d, e, total } = segPositions(maxPx);
  const p = Math.max(0, Math.min(total - 1, Math.round(pos)));
  if (p < a)                 return p + 1;                                  // 1..20 step 1
  if (p < a + b)             return 20  + (p - a + 1) * 2;                  // 22..50 step 2
  if (p < a + b + c)         return 50  + (p - a - b + 1) * 5;              // 55..100 step 5
  if (p < a + b + c + d)     return 100 + (p - a - b - c + 1) * 10;         // 110..200 step 10
  if (p < a + b + c + d + e) return 200 + (p - a - b - c - d + 1) * 20;     // 220..500 step 20
  return                            500 + (p - a - b - c - d - e + 1) * 50; // 550..1000 step 50
}

export function sizeToSliderPos(size: number, maxPx: number): number {
  const { a, b, c, d, e } = segPositions(maxPx);
  const s = Math.max(1, Math.min(maxPx, Math.round(size)));
  if (s <= 20)  return s - 1;
  if (s <= 50)  return a + Math.round((s - 20) / 2) - 1;
  if (s <= 100) return a + b + Math.round((s - 50) / 5) - 1;
  if (s <= 200) return a + b + c + Math.round((s - 100) / 10) - 1;
  if (s <= 500) return a + b + c + d + Math.round((s - 200) / 20) - 1;
  return            a + b + c + d + e + Math.round((s - 500) / 50) - 1;
}

export function sliderMaxPos(maxPx: number): number { return segPositions(maxPx).total - 1; }

// 段步长（圆 popup 的 [] 按此 step）。
export function stepFor(size: number): number {
  if (size < 20) return 1;
  if (size < 50) return 2;
  if (size < 100) return 5;
  if (size < 200) return 10;
  if (size < 500) return 20;
  return 50;
}

// 量化到段步长（存的 / 显的 / [] step 三者一致）。
export function quantizeSize(v: number): number {
  v = Math.round(v);
  if (v < 20)  return Math.max(1, v);
  if (v <= 50) return Math.round(v / 2) * 2;
  if (v <= 100) return Math.round(v / 5) * 5;
  if (v <= 200) return Math.round(v / 10) * 10;
  if (v <= 500) return Math.round(v / 20) * 20;
  return Math.round(v / 50) * 50;
}
