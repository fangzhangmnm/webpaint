// 教堂彩窗（Stained glass）
// Voronoi 分块（每块平均色）+ 黑色 lead 边界线
//
// 算法：
//   1. 抖动网格生成 seed 点（每 cellSize × cellSize 一个，确定性随机抖）
//   2. 每像素找最近 seed → 落入哪个 cell
//   3. 累 cell 平均色
//   4. 渲染：seed 不同 = 边界 → 画黑；否则填 cell 平均色
//
// 性能：O(W*H*9) 因为每像素只测 3×3 邻 cell 的 seed

import { registerFilter, makeSliderRow } from "../filters.js";

export class StainedGlassFilter {
  static id = "stainedGlass";
  static title = "教堂彩窗";
  static category = "artist";
  static modes = ["region"];
  // bleed 跟 cellSize 同量级；region 全层不用
  static bleedRadius(p) { return p ? (p.cellSize | 0) : 12; }

  static defaults() { return { cellSize: 16, leadWidth: 1 }; }

  static buildBody(container, state, onChange) {
    const set = (k, v) => { state.params[k] = v | 0; onChange(); };
    container.appendChild(makeSliderRow("玻璃块大小", "cellSize", 6, 64, 1, state.params.cellSize, set, {
      fmt: (v) => `${v | 0} px`,
    }));
    container.appendChild(makeSliderRow("铅条粗细",   "leadWidth", 0, 4, 1, state.params.leadWidth, set, {
      fmt: (v) => `${v | 0} px`,
    }));
  }

  static bake(src, dst, p, mask, w, h) {
    const cs = Math.max(6, p.cellSize | 0);
    const lead = Math.max(0, p.leadWidth | 0);
    const cols = Math.ceil(w / cs) + 1;
    const rows = Math.ceil(h / cs) + 1;
    // 1) seed 点（确定性抖动）
    const seedX = new Float32Array(cols * rows);
    const seedY = new Float32Array(cols * rows);
    const seedR = new Float32Array(cols * rows);
    const seedG = new Float32Array(cols * rows);
    const seedB = new Float32Array(cols * rows);
    const seedA = new Float32Array(cols * rows);
    const seedN = new Int32Array(cols * rows);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = cy * cols + cx;
        // 整数 hash 抖动（确定性 + 不依赖 Math.random）
        const h1 = ((cx * 374761393 + cy * 668265263) ^ 0xdeadbeef) >>> 0;
        const h2 = ((cx * 2246822519 + cy * 3266489917) ^ 0xcafebabe) >>> 0;
        seedX[i] = cx * cs + (h1 % 256) / 255 * cs;
        seedY[i] = cy * cs + (h2 % 256) / 255 * cs;
      }
    }
    // 2 & 3) per-pixel 找最近 seed + 累加平均色
    const pixelSeed = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ccx = Math.floor(x / cs);
        const ccy = Math.floor(y / cs);
        let best = -1, bestD = Infinity;
        for (let dcy = -1; dcy <= 1; dcy++) {
          for (let dcx = -1; dcx <= 1; dcx++) {
            const sx = ccx + dcx, sy = ccy + dcy;
            if (sx < 0 || sx >= cols || sy < 0 || sy >= rows) continue;
            const si = sy * cols + sx;
            const dx = x + 0.5 - seedX[si];
            const dy = y + 0.5 - seedY[si];
            const d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = si; }
          }
        }
        pixelSeed[y * w + x] = best;
        if (best >= 0) {
          const o = (y * w + x) * 4;
          seedR[best] += src[o];
          seedG[best] += src[o + 1];
          seedB[best] += src[o + 2];
          seedA[best] += src[o + 3];
          seedN[best]++;
        }
      }
    }
    // 4) finalize 平均
    for (let i = 0; i < seedN.length; i++) {
      if (seedN[i] > 0) {
        seedR[i] = (seedR[i] / seedN[i]) | 0;
        seedG[i] = (seedG[i] / seedN[i]) | 0;
        seedB[i] = (seedB[i] / seedN[i]) | 0;
        seedA[i] = (seedA[i] / seedN[i]) | 0;
      }
    }
    // 5) 渲染：每像素填 cell 平均；边界（邻居 seed 不同）画黑
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const o = i * 4;
        if (mask && mask[o + 3] < 128) {
          dst[o] = src[o]; dst[o+1] = src[o+1]; dst[o+2] = src[o+2]; dst[o+3] = src[o+3];
          continue;
        }
        const my = pixelSeed[i];
        // 边界检测：右 / 下 / 右下 邻居不同 seed = 边
        let isLead = false;
        if (lead > 0) {
          for (let dy = 0; dy <= lead && !isLead; dy++) {
            for (let dx = 0; dx <= lead && !isLead; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx, ny = y + dy;
              if (nx >= w || ny >= h) continue;
              if (pixelSeed[ny * w + nx] !== my) isLead = true;
            }
          }
        }
        if (isLead) {
          dst[o] = 0; dst[o+1] = 0; dst[o+2] = 0; dst[o+3] = src[o+3];
        } else if (my >= 0) {
          dst[o]   = seedR[my];
          dst[o+1] = seedG[my];
          dst[o+2] = seedB[my];
          dst[o+3] = seedA[my];
        } else {
          dst[o] = src[o]; dst[o+1] = src[o+1]; dst[o+2] = src[o+2]; dst[o+3] = src[o+3];
        }
      }
    }
  }
}

registerFilter(StainedGlassFilter);
