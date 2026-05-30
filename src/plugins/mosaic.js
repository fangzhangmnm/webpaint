// 马赛克（pixelize）
// 每个 cellSize × cellSize 方块用块内平均色填满
//
// 用途：交作业过审 / 隐私打码 / 像素艺术风格化
// 极简 ~35 行核内核

import { registerFilter, makeSliderRow } from "../filters.js";

export class MosaicFilter {
  static id = "mosaic";
  static title = "马赛克";
  static category = "artist";
  static modes = ["region"];          // brush 模式 v132+ 可加：每 stamp bbox 内做 mosaic
  static bleedRadius() { return 0; }  // 块内自包含，不读外面

  static defaults() { return { cellSize: 12 }; }

  static buildBody(container, state, onChange) {
    container.appendChild(makeSliderRow("块大小", "cellSize", 2, 64, 1, state.params.cellSize, (k, v) => {
      state.params.cellSize = v | 0;
      onChange();
    }, { fmt: (v) => `${v | 0} px` }));
  }

  static bake(src, dst, p, mask, w, h) {
    const cs = Math.max(2, p.cellSize | 0);
    for (let cy = 0; cy < h; cy += cs) {
      for (let cx = 0; cx < w; cx += cs) {
        const ex = Math.min(w, cx + cs);
        const ey = Math.min(h, cy + cs);
        // 1) 块内平均
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let y = cy; y < ey; y++) {
          for (let x = cx; x < ex; x++) {
            const o = (y * w + x) * 4;
            r += src[o]; g += src[o+1]; b += src[o+2]; a += src[o+3]; n++;
          }
        }
        const ar = (r / n) | 0, ag = (g / n) | 0, ab = (b / n) | 0, aa = (a / n) | 0;
        // 2) 块内填平均
        for (let y = cy; y < ey; y++) {
          for (let x = cx; x < ex; x++) {
            const o = (y * w + x) * 4;
            if (mask && mask[o + 3] < 128) {
              dst[o] = src[o]; dst[o+1] = src[o+1];
              dst[o+2] = src[o+2]; dst[o+3] = src[o+3];
              continue;
            }
            dst[o] = ar; dst[o+1] = ag; dst[o+2] = ab; dst[o+3] = aa;
          }
        }
      }
    }
  }
}

registerFilter(MosaicFilter);
