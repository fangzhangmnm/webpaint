// 「当前笔」反应式派生 + 引擎桥（从组合根 app.js 下沉，survey rec #3）。
// 纯部分（ResolvedBrush 类型 + resolveBrush 纯函数）C8 迁 src/common/resolved-brush.ts
// （提案 §1：ResolvedBrush 类型是 common 住户；backend/brush.ts 与 backend 档口都吃它）——
// 本文件只剩 Vue 装配，并 re-export 纯部分（存量消费者 import 路径不动）。
//
// currentBrush = Vue computed，把 4 个反应式 SSoT 装配成引擎唯一吃的不可变 ResolvedBrush：
//   ① 当前工具 dial（toolStates：size/opacity，per-doc reactive）
//   ② 活动预设（笔架：findToolBrushPure 读 controller 的 shallowRef 镜像 → 依赖自动建立）③ 全局 color
// **手感数学全在 resolveBrush（common）**，这里只装配、不碰任何公式/时间常数。
// 引擎只读 currentBrush.value（stroke begin 时取，非每 stamp）。
//
// 接线风险（boot-smoke 抓不到、本模块的 node 测专门守）：依赖集漏一个 → 改 dial/color/预设
// 笔不更新（「功能不响应」级 bug，非手感漂移）。故 current-brush.test.mjs 验「改 dep → currentBrush 重算」。
// （旧的 bindEngine→invalidateStamp 引擎桥已删：stamp 缓存随 GPU 栅格归档，无缓存可作废。）

import { resolveBrush } from "./common/resolved-brush.ts";
import type { BrushPreset } from "./common/resolved-brush.ts";
import { computed } from "../vendor/vue/vue.esm-browser.prod.js";
import type { EditorRuntimeState, DialReactive } from "./app-context.ts";
import type { BrushRackController } from "./brush-rack-controller.ts";

export { resolveBrush } from "./common/resolved-brush.ts";
export type { ResolvedBrush, BrushPreset, ResolveBrushArgs } from "./common/resolved-brush.ts";

interface CurrentBrushDeps { state: EditorRuntimeState; dialReactive: DialReactive; rack: BrushRackController; }

export function makeCurrentBrush({ state, dialReactive, rack }: CurrentBrushDeps) {
  // **必须纯**：computed 内不写 toolStates（GUID healing 回写用 findToolBrushPure 的纯版；写回留显式路径）。
  const currentBrush = computed(() => {
    const ts = state.toolStates[rack.getRackToolKey(dialReactive.tool)] || state.toolStates.brush;
    // v0.6.14 缺笔自愈：id/name 解析不到 → 退该工具默认笔（纯派生不回写；无笔架 → null → DEFAULT 兜底）
    const preset = rack.resolveActiveBrushPure(ts, dialReactive.tool);
    return resolveBrush({
      // 同一运行时 brush 对象的两个视图：rack 存的是完整 Brush，resolveBrush 只读 BrushPreset 子集。
      preset: preset as BrushPreset | null,
      size: ts.size, opacity: ts.opacity ?? 1.0,
      color: state.color,
      // 压感开关不再全局传入（2026-07-14 deprecate）——每笔自带（resolveBrush 从 preset 取，缺则 DEFAULT true）。
    });
  });

  return { currentBrush };
}
