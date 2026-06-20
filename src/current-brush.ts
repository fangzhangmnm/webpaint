// current-brush.ts —— 「当前笔」反应式派生 + 引擎桥（从组合根 app.js 下沉，survey rec #3）。
//
// currentBrush = Vue computed，把 4 个反应式 SSoT 装配成引擎唯一吃的不可变 ResolvedBrush：
//   ① 当前工具 dial（toolStates：size/opacity/flow，per-doc reactive）
//   ② 活动预设（笔架，rackVersion 触发重算）③ 全局 color ④ 全局压感开关
// **手感数学全在 resolveBrush（resolved-brush.js），这里只装配、不碰任何公式/时间常数。**
// 引擎只读 currentBrush.value（stroke begin 时取，非每 stamp）。
//
// 接线风险（boot-smoke 抓不到、本模块的 node 测专门守）：依赖集漏一个 → 改 dial/color/预设
// 笔不更新；flush:"sync" 丢了 → invalidateStamp 晚一拍、一笔首 dab 用旧缓存 stamp。两者都是
// 「功能不响应」级 bug，不是手感漂移。故 current-brush.test.mjs 验「改 dep → currentBrush 重算」。

import { computed, watch } from "../vendor/vue/vue.esm-browser.prod.js";
import { resolveBrush } from "./resolved-brush.ts";
import type { BrushPreset } from "./resolved-brush.ts";
import type { EditorRuntimeState, DialReactive } from "./app-context.ts";
import type { BrushRack } from "./brush-rack.ts";

interface CurrentBrushDeps { state: EditorRuntimeState; dialReactive: DialReactive; rack: BrushRack; }
// input 晚于本工厂构造 → bindEngine 分离调用；只触及 brush.invalidateStamp（裸引擎桥）。
type EngineInput = { brush?: { invalidateStamp?: () => void } } | null | undefined;

export function makeCurrentBrush({ state, dialReactive, rack }: CurrentBrushDeps) {
  // **必须纯**：computed 内不写 toolStates（GUID healing 回写用 findToolBrushPure 的纯版；写回留显式路径）。
  const currentBrush = computed(() => {
    void dialReactive.rackVersion;   // 依赖笔架版本（编辑/重置预设后重算活动预设字段）
    const ts = state.toolStates[rack.getRackToolKey(dialReactive.tool)] || state.toolStates.brush;
    const preset = rack.findToolBrushPure(ts);   // 无笔架 → null → DEFAULT 兜底
    return resolveBrush({
      // 同一运行时 brush 对象的两个视图：rack 存的是完整 Brush，resolveBrush 只读 BrushPreset 子集。
      preset: preset as BrushPreset | null,
      size: ts.size, opacity: ts.opacity ?? 1.0, flow: ts.flow ?? 1.0,
      color: state.color,
      pressureToSize: state.pressureToSize,
      pressureToOpacity: state.pressureToOpacity,
    });
  });

  // 命令/反应桥：当前笔变 → 引擎 stamp 缓存失效（flush:"sync" 复刻旧 refreshCurrentBrush 的同步时机）。
  // input 晚于本工厂构造 → bindEngine 分离调用；cb 仍守 input?.（防御）。这是「反应式 UI 态 ↔ 裸引擎态」唯一的桥。
  const bindEngine = (input: EngineInput) =>
    watch(currentBrush, () => { if (input?.brush?.invalidateStamp) input.brush.invalidateStamp(); }, { flush: "sync" });

  return { currentBrush, bindEngine };
}
