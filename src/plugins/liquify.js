// 液化（Liquify）—— filter brush 模式
//
// v132 (user：「液化先 migrate 到 filter brush，求你了，就不用路由了」)
//
// 包装现有 LiquifyEngine：实现 Filter brush 契约，把 stroke 委托给 engine。
// 这样：
//   - menu 液化 = _enterFilterBrushMode(LiquifyFilter)（跟模糊 / 锐化 同路径）
//   - role = "filterBrush"，input.js 不再走 role="liquify"
//   - [ ] 快捷键 = brush 那条分支，调 state.brush.size（filter brush 共用）
//   - mode（推 / 收 / 胀 / 旋 / 还原）= brushVariants，toolbar dropdown 切
//   - strength = state.brush.opacity（左栏 opacity slider 当 strength）
//   - size = state.brush.size（左栏 size slider）

import { registerFilter } from "../filters.js";
import { LiquifyEngine } from "../liquify.js";

export class LiquifyFilter {
  static id = "liquify";
  static title = "液化";
  static category = "adjustment";   // 跟 sharpenBlur 同组（菜单"笔刷类"）
  static modes = ["brush"];
  static bleedRadius(p) {
    // 液化每个 stamp 在 footprint 内累加 dispField，footprint 半径 = brush.size/2
    // 不读 footprint 外，所以 0 即可
    return 0;
  }
  static defaults() { return { mode: "push" }; }

  // v132 (user：「老版我 slider 拉 0.1」) strengthScale 直接对齐老手感
  //   推强度 / 距离比线性，0.x..1.0 都合理 → 1.0
  //   收/胀/旋 是径向变形，单 stamp 累积快 → 0.1（多笔触叠加可达更强）
  //   slider 仍在（opacity → 乘 scale），最大值发生在 opacity 100%
  static brushVariants = [
    { id: "push",    title: "推",   params: { mode: "push",    strengthScale: 1.0 } },
    { id: "pinch",   title: "收",   params: { mode: "pinch",   strengthScale: 0.1 } },
    { id: "bloat",   title: "胀",   params: { mode: "bloat",   strengthScale: 0.1 } },
    { id: "twirlL",  title: "左旋", params: { mode: "twirl",   strengthScale: 0.1 } },
    { id: "twirlR",  title: "右旋", params: { mode: "twirlCW", strengthScale: 0.1 } },
  ];

  // region 模式没意义（液化天生是 stroke-based），所以不提供 bake / buildBody

  // Filter brush 契约：begin / extend / end / cancel / flushDirty
  static beginBrushStroke(layer, params, brushSettings, selection, x, y, pressure) {
    const engine = new LiquifyEngine();
    const scale = params.strengthScale ?? 1;
    const settings = {
      mode: params.mode || "push",
      size: brushSettings.size,
      strength: (brushSettings.opacity ?? 1) * scale,    // opacity × variant scale
    };
    engine.beginStroke(layer, settings, x, y, selection);
    return { engine };
  }

  static extendBrushStamp(state, x, y, _pressure) {
    state.engine.extendStroke(x, y);
  }

  static endBrushStroke(state) {
    state.engine.endStroke();
  }

  static cancelBrushStroke(state) {
    state.engine.cancelStroke();
  }

  static flushDirty(state) {
    return state.engine.flushDirty();
  }
}

registerFilter(LiquifyFilter);
