// 色彩平衡——UI 面（3 区段 × 3 轴 ramp 滑条）。
// 数学 = backend/filters/color-balance-kernel.ts（C8 析出：bake/defaults 委托 kernel）。

import { registerFilter, makeSliderRow, makeSectionTitle } from "../filters.ts";
import { ColorBalanceKernel, type ColorBalanceParams } from "../backend/filters/color-balance-kernel.ts";

interface ColorBalanceState {
  params: ColorBalanceParams;
}

type RampPrefix = "sh" | "m" | "hi";

export class ColorBalanceFilter {
  static id = "colorBalance";
  static title = "色彩平衡";
  static category = "adjustment";
  static modes = ["region"];
  static bleedRadius = ColorBalanceKernel.bleedRadius;
  static defaults = ColorBalanceKernel.defaults;
  static bake = ColorBalanceKernel.bake;

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
}

registerFilter(ColorBalanceFilter);
