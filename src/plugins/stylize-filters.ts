// 艺术滤镜组（category="artist"）：马赛克 / 半调网点 / 教堂彩窗——UI 面。
// v135 (user：「三个同主题的艺术滤镜合同一个 js」) 从 mosaic.js / halftone.js / stained-glass.js 合并
// 数学 = backend/filters/stylize-kernels.ts（C8 析出：bake/defaults/bleedRadius 委托 kernel）。

import { registerFilter, makeSliderRow, makeSelectRow } from "../filters.ts";
import { t, tLatin } from "../i18n/index.ts";
import { MosaicKernel, HalftoneKernel, StainedGlassKernel } from "../backend/filters/stylize-kernels.ts";

// buildBody state：app 注入的 { params } 容器（filter UI 读写 state.params）
interface FilterBuildState {
  params: Record<string, unknown>;
}

// ============ 马赛克（pixelize）============
// 用途：交作业过审 / 隐私打码 / 像素艺术风格化
export class MosaicFilter {
  static id = "mosaic";
  static title = t("flt.mos.title");
  static category = "artist";
  static modes = ["region"];
  static bleedRadius = MosaicKernel.bleedRadius;
  static defaults = MosaicKernel.defaults;
  static bake = MosaicKernel.bake;

  static buildBody(container: HTMLElement, state: FilterBuildState, onChange: () => void) {
    container.appendChild(makeSliderRow(t("flt.mos.cellSize"), "cellSize", 2, 64, 1, state.params.cellSize as number, (k: string, v: number) => {
      state.params.cellSize = v | 0;
      onChange();
    }, { fmt: (v: number) => `${v | 0} px` }));
  }
}

// ============ 半调网点（Halftone）============
// 报刊 / 漫画 / 老印刷
export class HalftoneFilter {
  static id = "halftone";
  static title = t("flt.ht.title");
  static category = "artist";
  static modes = ["region"];
  static bleedRadius = HalftoneKernel.bleedRadius;
  static defaults = HalftoneKernel.defaults;
  static bake = HalftoneKernel.bake;

  static buildBody(container: HTMLElement, state: FilterBuildState, onChange: () => void) {
    const set = (k: string, v: string | number) => {
      state.params[k] = (typeof v === "string") ? v : (v | 0);
      onChange();
    };
    container.appendChild(makeSliderRow(t("flt.ht.cellSize"), "cellSize", 3, 32, 1, state.params.cellSize as number, set, {
      fmt: (v: number) => `${v | 0} px`,
    }));
    container.appendChild(makeSliderRow(t("flt.ht.dotScale"), "dotScale", 50, 200, 5, state.params.dotScale as number, set, {
      fmt: (v: number) => `${v | 0}%`,
    }));
    container.appendChild(makeSelectRow(t("flt.ht.mode"), "mode", [
      { value: "blackOnWhite", label: tLatin("flt.ht.blackOnWhite") },
      { value: "whiteOnBlack", label: tLatin("flt.ht.whiteOnBlack") },
    ], state.params.mode as string, set));
  }
}

// ============ 教堂彩窗（Stained glass）============
export class StainedGlassFilter {
  static id = "stainedGlass";
  static title = t("flt.sg.title");
  static category = "artist";
  static modes = ["region"];
  static bleedRadius = StainedGlassKernel.bleedRadius;
  static defaults = StainedGlassKernel.defaults;
  static bake = StainedGlassKernel.bake;

  static buildBody(container: HTMLElement, state: FilterBuildState, onChange: () => void) {
    const set = (k: string, v: number) => { state.params[k] = v | 0; onChange(); };
    container.appendChild(makeSliderRow(t("flt.sg.cellSize"), "cellSize", 6, 64, 1, state.params.cellSize as number, set, {
      fmt: (v: number) => `${v | 0} px`,
    }));
    container.appendChild(makeSliderRow(t("flt.sg.leadWidth"), "leadWidth", 0, 4, 1, state.params.leadWidth as number, set, {
      fmt: (v: number) => `${v | 0} px`,
    }));
  }
}

registerFilter(MosaicFilter);
registerFilter(HalftoneFilter);
registerFilter(StainedGlassFilter);
