// 半调（Halftone，报刊 / 漫画 / 老印刷网点）
// 每个 cell 一个圆点，半径 = (1 - 平均亮度) × cellSize/2 × scale
// 黑点 on 白底（也支持反相）
//
// 数学：cell 内某像素 (x,y) 到 cell center 距离 < radius → 黑

import { registerFilter, makeSliderRow, makeSelectRow } from "../filters.js";

export class HalftoneFilter {
  static id = "halftone";
  static title = "半调网点";
  static category = "artist";
  static modes = ["region"];
  static bleedRadius() { return 0; }

  static defaults() {
    return { cellSize: 8, dotScale: 100, mode: "blackOnWhite" };
  }

  static buildBody(container, state, onChange) {
    const set = (k, v) => {
      state.params[k] = (typeof v === "string") ? v : (v | 0);
      onChange();
    };
    container.appendChild(makeSliderRow("网点间距", "cellSize", 3, 32, 1, state.params.cellSize, set, {
      fmt: (v) => `${v | 0} px`,
    }));
    container.appendChild(makeSliderRow("网点缩放", "dotScale", 50, 200, 5, state.params.dotScale, set, {
      fmt: (v) => `${v | 0}%`,
    }));
    container.appendChild(makeSelectRow("模式", "mode", [
      { value: "blackOnWhite", label: "黑点 on 白" },
      { value: "whiteOnBlack", label: "白点 on 黑" },
    ], state.params.mode, set));
  }

  static bake(src, dst, p, mask, w, h) {
    const cs = Math.max(3, p.cellSize | 0);
    const scale = (p.dotScale | 0) / 100;
    const inverted = p.mode === "whiteOnBlack";
    const bgR = inverted ? 0 : 255;
    const fgR = inverted ? 255 : 0;
    for (let cy = 0; cy < h; cy += cs) {
      for (let cx = 0; cx < w; cx += cs) {
        const ex = Math.min(w, cx + cs);
        const ey = Math.min(h, cy + cs);
        // 平均亮度
        let l = 0, n = 0;
        for (let y = cy; y < ey; y++) {
          for (let x = cx; x < ex; x++) {
            const o = (y * w + x) * 4;
            l += 0.2126 * src[o] + 0.7152 * src[o+1] + 0.0722 * src[o+2];
            n++;
          }
        }
        const avgLuma = l / n;
        const darkness = inverted ? avgLuma / 255 : 1 - avgLuma / 255;
        const r = darkness * (cs / 2) * scale;
        const r2 = r * r;
        const ccx = cx + cs / 2;
        const ccy = cy + cs / 2;
        for (let y = cy; y < ey; y++) {
          for (let x = cx; x < ex; x++) {
            const o = (y * w + x) * 4;
            if (mask && mask[o + 3] < 128) {
              dst[o] = src[o]; dst[o+1] = src[o+1]; dst[o+2] = src[o+2]; dst[o+3] = src[o+3];
              continue;
            }
            const dx = x + 0.5 - ccx, dy = y + 0.5 - ccy;
            const inDot = (dx*dx + dy*dy) < r2;
            const v = inDot ? fgR : bgR;
            dst[o] = v; dst[o+1] = v; dst[o+2] = v; dst[o+3] = src[o+3];
          }
        }
      }
    }
  }
}

registerFilter(HalftoneFilter);
