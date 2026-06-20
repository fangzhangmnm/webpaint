// 色相 / 饱和度 / 亮度 / 对比（per-pixel，无空间扩展）
//
// v132 (user：「饱和度用自然饱和度算法，默认自然，下拉框选」)
// - 自然饱和度（vibrance）：对低饱和像素加幅度大，高饱和像素少加，防过饱
// - 线性饱和度：朝 luma lerp，PS 老式饱和度

import { registerFilter, clamp8, makeSliderRow, makeSelectRow } from "../filters.ts";

export class HsbFilter {
  static id = "hsb";
  static title = "色相 / 饱和度 / 亮度";
  static category = "adjustment";
  static modes = ["region"];
  static bleedRadius() { return 0; }

  static defaults() {
    return { brightness: 0, contrast: 0, saturation: 0, hue: 0, satMode: "vibrance" };
  }

  static buildBody(container, state, onChange) {
    const set = (k, v) => { state.params[k] = (typeof v === "string") ? v : (v | 0); onChange(); };
    // 亮度：黑→白 渐变
    container.appendChild(makeSliderRow("亮度", "brightness", -100, 100, 1, state.params.brightness, set, {
      gradient: "linear-gradient(90deg, #000 0%, #888 50%, #fff 100%)",
    }));
    container.appendChild(makeSliderRow("对比", "contrast", -100, 100, 1, state.params.contrast, set, {
      gradient: "linear-gradient(90deg, #999 0%, #888 50%, #555 51%, #ccc 100%)",
    }));
    container.appendChild(makeSliderRow("饱和", "saturation", -100, 100, 1, state.params.saturation, set, {
      // 灰 → 红，左 = 去饱和到灰，右 = 加饱和到鲜艳
      gradient: "linear-gradient(90deg, #eee 0%, #d33 100%)",
    }));
    container.appendChild(makeSelectRow("饱和模式", "satMode", [
      { value: "vibrance", label: "自然" },
      { value: "linear",   label: "线性" },
    ], state.params.satMode, set));
    // 色相：彩虹 ramp
    container.appendChild(makeSliderRow("色相", "hue", -180, 180, 1, state.params.hue, set, {
      fmt: (v) => `${v | 0}°`,
      gradient: "linear-gradient(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
    }));
  }

  static bake(srcData, dstData, p, mask) {
    const b = 1 + (p.brightness / 100);
    const c = 1 + (p.contrast / 100);
    const sat = p.saturation / 100;       // -1..1
    const satLinear = 1 + sat;            // 线性模式系数
    const useVibrance = p.satMode !== "linear";
    const hueRad = (p.hue | 0) * Math.PI / 180;
    const cosH = Math.cos(hueRad), sinH = Math.sin(hueRad);
    const lumR = 0.213, lumG = 0.715, lumB = 0.072;
    const m11 = lumR + cosH * (1 - lumR) + sinH * (-lumR);
    const m12 = lumG + cosH * (-lumG)    + sinH * (-lumG);
    const m13 = lumB + cosH * (-lumB)    + sinH * (1 - lumB);
    const m21 = lumR + cosH * (-lumR)    + sinH * 0.143;
    const m22 = lumG + cosH * (1 - lumG) + sinH * 0.140;
    const m23 = lumB + cosH * (-lumB)    + sinH * (-0.283);
    const m31 = lumR + cosH * (-lumR)    + sinH * (-(1 - lumR));
    const m32 = lumG + cosH * (-lumG)    + sinH * lumG;
    const m33 = lumB + cosH * (1 - lumB) + sinH * lumB;
    const useHue = p.hue !== 0;
    const N = srcData.length / 4;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (mask && mask[o + 3] < 128) {
        dstData[o] = srcData[o]; dstData[o+1] = srcData[o+1];
        dstData[o+2] = srcData[o+2]; dstData[o+3] = srcData[o+3];
        continue;
      }
      let r = srcData[o], g = srcData[o+1], bl = srcData[o+2];
      r *= b; g *= b; bl *= b;
      r = (r - 128) * c + 128;
      g = (g - 128) * c + 128;
      bl = (bl - 128) * c + 128;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      if (sat !== 0) {
        if (useVibrance) {
          // 自然饱和度：当前像素 currentSat = (max-min) / max
          //   加幅 = sat × (1 - currentSat) → 低饱大加 / 高饱小加 / 0 → 不退色
          //   减幅 = sat × currentSat       → 高饱大减 / 低饱小减（避免饱和反转黑）
          const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
          const currentSat = mx <= 0 ? 0 : (mx - mn) / mx;
          const k = sat >= 0 ? sat * (1 - currentSat) : sat * currentSat;
          const factor = 1 + k;
          r = luma + (r - luma) * factor;
          g = luma + (g - luma) * factor;
          bl = luma + (bl - luma) * factor;
        } else {
          r = luma + (r - luma) * satLinear;
          g = luma + (g - luma) * satLinear;
          bl = luma + (bl - luma) * satLinear;
        }
      }
      if (useHue) {
        const nr = r * m11 + g * m12 + bl * m13;
        const ng = r * m21 + g * m22 + bl * m23;
        const nb = r * m31 + g * m32 + bl * m33;
        r = nr; g = ng; bl = nb;
      }
      dstData[o]   = clamp8(r);
      dstData[o+1] = clamp8(g);
      dstData[o+2] = clamp8(bl);
      dstData[o+3] = srcData[o+3];
    }
  }
}

registerFilter(HsbFilter);
