// 色彩平衡（PS 风格 3 区 × 3 轴）
// 3 区段：阴影 / 中间调 / 高光，每区 3 个轴（青-红 / 品-绿 / 黄-蓝）
// 区段权重 = luma 三段高斯（shadow @ 0、mid @ 0.5、hi @ 1）

import { registerFilter, clamp8, makeSliderRow, makeSectionTitle } from "../filters.ts";
import type { FilterParams } from "../filters.ts";

interface ColorBalanceParams extends FilterParams {
  shR: number; shG: number; shB: number;
  mR: number; mG: number; mB: number;
  hiR: number; hiG: number; hiB: number;
}

interface ColorBalanceState {
  params: ColorBalanceParams;
}

type RampPrefix = "sh" | "m" | "hi";

export class ColorBalanceFilter {
  static id = "colorBalance";
  static title = "色彩平衡";
  static category = "adjustment";
  static modes = ["region"];
  static bleedRadius() { return 0; }

  static defaults() {
    return { shR: 0, shG: 0, shB: 0, mR: 0, mG: 0, mB: 0, hiR: 0, hiG: 0, hiB: 0 };
  }

  static buildBody(container: HTMLElement, state: ColorBalanceState, onChange: () => void) {
    const set = (k: string, v: number) => { state.params[k] = v | 0; onChange(); };
    // v132 (user：「colorful slider 也对应调整亮度让用户有直观感受」)
    //   3 段 × 3 轴 各自一套 ramp：颜色按 tone 区段亮度深浅，user 一看就知是哪段
    const RAMPS = {
      sh: {  // shadows: 深色
        R: "linear-gradient(90deg, #044 0%, #222 50%, #600 100%)",
        G: "linear-gradient(90deg, #404 0%, #222 50%, #060 100%)",
        B: "linear-gradient(90deg, #660 0%, #222 50%, #006 100%)",
      },
      m: {   // midtones: 中色
        R: "linear-gradient(90deg, #0aa 0%, #777 50%, #c33 100%)",
        G: "linear-gradient(90deg, #a0a 0%, #777 50%, #3c3 100%)",
        B: "linear-gradient(90deg, #cc3 0%, #777 50%, #33c 100%)",
      },
      hi: {  // highlights: 浅色
        R: "linear-gradient(90deg, #cff 0%, #ddd 50%, #fcc 100%)",
        G: "linear-gradient(90deg, #fcf 0%, #ddd 50%, #cfc 100%)",
        B: "linear-gradient(90deg, #ffc 0%, #ddd 50%, #ccf 100%)",
      },
    };
    const axisRows = (prefix: RampPrefix) => {
      const r = RAMPS[prefix];
      container.appendChild(makeSliderRow("青 ⟷ 红", prefix + "R", -100, 100, 1, state.params[prefix + "R"] as number, set, { gradient: r.R }));
      container.appendChild(makeSliderRow("品 ⟷ 绿", prefix + "G", -100, 100, 1, state.params[prefix + "G"] as number, set, { gradient: r.G }));
      container.appendChild(makeSliderRow("黄 ⟷ 蓝", prefix + "B", -100, 100, 1, state.params[prefix + "B"] as number, set, { gradient: r.B }));
    };
    container.appendChild(makeSectionTitle("阴影（暗部，luma≈0）"));
    axisRows("sh");
    container.appendChild(makeSectionTitle("中间调（主体，luma≈0.5）"));
    axisRows("m");
    container.appendChild(makeSectionTitle("高光（亮部，luma≈1）"));
    axisRows("hi");
  }

  static bake(srcData: Uint8ClampedArray, dstData: Uint8ClampedArray, p: ColorBalanceParams, mask: Uint8ClampedArray | null) {
    // 三段 luma 权重函数（每段高斯 σ≈0.25，中心 0 / 0.5 / 1）
    const wShadow = new Float32Array(256);
    const wMid    = new Float32Array(256);
    const wHi     = new Float32Array(256);
    const SIG2 = 2 * 0.25 * 0.25;
    for (let i = 0; i < 256; i++) {
      const l = i / 255;
      wShadow[i] = Math.exp(-(l - 0) * (l - 0) / SIG2);
      wMid[i]    = Math.exp(-(l - 0.5) * (l - 0.5) / SIG2);
      wHi[i]     = Math.exp(-(l - 1) * (l - 1) / SIG2);
    }
    // delta LUT 预算（按 luma 0..255 索引）
    const dRLut = new Float32Array(256);
    const dGLut = new Float32Array(256);
    const dBLut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      dRLut[i] = (p.shR * wShadow[i] + p.mR * wMid[i] + p.hiR * wHi[i]) / 100 * 64;
      dGLut[i] = (p.shG * wShadow[i] + p.mG * wMid[i] + p.hiG * wHi[i]) / 100 * 64;
      dBLut[i] = (p.shB * wShadow[i] + p.mB * wMid[i] + p.hiB * wHi[i]) / 100 * 64;
    }
    const N = srcData.length / 4;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (mask && mask[o + 3] < 128) {
        dstData[o] = srcData[o]; dstData[o+1] = srcData[o+1];
        dstData[o+2] = srcData[o+2]; dstData[o+3] = srcData[o+3];
        continue;
      }
      const r = srcData[o], g = srcData[o+1], b = srcData[o+2];
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
      const li = luma > 255 ? 255 : luma < 0 ? 0 : luma;
      dstData[o]   = clamp8(r + dRLut[li]);
      dstData[o+1] = clamp8(g + dGLut[li]);
      dstData[o+2] = clamp8(b + dBLut[li]);
      dstData[o+3] = srcData[o+3];
    }
  }
}

registerFilter(ColorBalanceFilter);
