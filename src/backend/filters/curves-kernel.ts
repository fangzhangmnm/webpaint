// 曲线 kernel（RGBA + 复合）——数学自 plugins/curves.ts 析出（C8）。
// 5 通道：复合 / R / G / B / A；应用顺序：复合（同时作用于 R/G/B）→ R/G/B 各自 → A
//
// v132 (user：「曲线不是折线！」)：分段插值 = Monotonic Cubic Hermite 系
// v135 (user：「曲线还是有点怪，不是 PS / Unity 手感」)：换 Catmull-Rom
//   切线 = (邻居 y 差) / (邻居 x 差) — 中心差分；端点 = 单边斜率
//   越界值 clamp 到 0..255，偶尔出现 plateau 是 trade-off（PS 也这样）

import { clamp8, type FilterKernel, type FilterParams } from "./kernel.ts";

export type CurvePoint = [number, number];

export interface CurvesParams extends FilterParams {
  active: string;
  comp: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
  a: CurvePoint[];
}

// Catmull-Rom → Hermite basis 采样 LUT。UI 画曲线（plugins/curves.ts buildBody）与 bake 同源。
export function buildCurveLut(points: CurvePoint[]): Uint8Array {
  const pts = points.slice().sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const lut = new Uint8Array(256);
  if (n < 2) {
    for (let x = 0; x < 256; x++) lut[x] = x;
    return lut;
  }
  // 1) Catmull-Rom 切线（中心差分；端点单边）
  const tans = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      const dx = pts[1][0] - pts[0][0];
      tans[i] = dx === 0 ? 0 : (pts[1][1] - pts[0][1]) / dx;
    } else if (i === n - 1) {
      const dx = pts[n - 1][0] - pts[n - 2][0];
      tans[i] = dx === 0 ? 0 : (pts[n - 1][1] - pts[n - 2][1]) / dx;
    } else {
      const dx = pts[i + 1][0] - pts[i - 1][0];
      tans[i] = dx === 0 ? 0 : (pts[i + 1][1] - pts[i - 1][1]) / dx;
    }
  }
  // 2) 采样到 LUT（Hermite basis：y(t) = h00·y0 + h10·dx·m0 + h01·y1 + h11·dx·m1）
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    while (seg < n - 2 && x > pts[seg + 1][0]) seg++;
    const x0 = pts[seg][0], y0 = pts[seg][1];
    const x1 = pts[seg + 1][0], y1 = pts[seg + 1][1];
    const dx = x1 - x0;
    if (dx === 0) { lut[x] = clamp8(y0); continue; }
    const t = (x - x0) / dx;
    const t2 = t * t, t3 = t2 * t;
    const h00 =  2 * t3 - 3 * t2 + 1;
    const h10 =      t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 =      t3 -     t2;
    const y = h00 * y0 + h10 * dx * tans[seg] + h01 * y1 + h11 * dx * tans[seg + 1];
    lut[x] = clamp8(y);
  }
  return lut;
}

export const CurvesKernel: FilterKernel = {
  id: "curves",

  defaults(): CurvesParams {
    const id = (): CurvePoint[] => [[0, 0], [255, 255]];
    return { active: "comp", comp: id(), r: id(), g: id(), b: id(), a: id() };
  },

  bleedRadius() { return 0; },

  bake(srcData, dstData, params, mask) {
    const p = params as CurvesParams;
    const lutComp = buildCurveLut(p.comp);
    const lutR    = buildCurveLut(p.r);
    const lutG    = buildCurveLut(p.g);
    const lutB    = buildCurveLut(p.b);
    const lutA    = buildCurveLut(p.a);
    const N = srcData.length / 4;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (mask && mask[o >> 2] < 128) {
        dstData[o] = srcData[o]; dstData[o+1] = srcData[o+1];
        dstData[o+2] = srcData[o+2]; dstData[o+3] = srcData[o+3];
        continue;
      }
      dstData[o]   = lutR[lutComp[srcData[o]]];
      dstData[o+1] = lutG[lutComp[srcData[o+1]]];
      dstData[o+2] = lutB[lutComp[srcData[o+2]]];
      dstData[o+3] = lutA[srcData[o+3]];
    }
  },
};
