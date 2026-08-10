// 色相 / 饱和度 / 亮度 / 对比——UI 面（滑条/渐变 ramp）。
// 数学 = backend/filters/hsb-kernel.ts（C8 析出：bake/defaults 委托 kernel，同一份数学两面消费）。

import { registerFilter, makeSliderRow, makeSelectRow } from "../filters.ts";
import { HsbKernel, type HsbParams } from "../backend/filters/hsb-kernel.ts";

interface HsbState {
  params: HsbParams;
}

export class HsbFilter {
  static id = "hsb";
  static title = "色相 / 饱和度 / 亮度";
  static category = "adjustment";
  static modes = ["region"];
  static bleedRadius = HsbKernel.bleedRadius;
  static defaults = HsbKernel.defaults;
  static bake = HsbKernel.bake;

  static buildBody(container: HTMLElement, state: HsbState, onChange: () => void) {
    const set = (k: string, v: string | number) => { state.params[k] = (typeof v === "string") ? v : (v | 0); onChange(); };
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
}

registerFilter(HsbFilter);
