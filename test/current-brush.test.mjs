// current-brush 反应式接线测试 —— 守 boot-smoke 抓不到的那个风险（survey rec #3 下沉 currentBrush 时）。
//
// currentBrush 是把 dial/预设/color/压感装配成 ResolvedBrush 的 computed。下沉到工厂后，最怕的不是
// 手感漂移（手感数学在 resolveBrush，没动），而是**反应式依赖断了**：改了 dial/color/预设笔不更新。
// 这里直接验「改 dep → currentBrush 重算且反映新值」+ flush 时机无关的纯反应正确性。
// 不需要 DOM（Vue reactivity 在 node 直跑，resolveBrush 是纯函数）。

import { describe, it, assert, eq } from "./runner.mjs";
import { makeCurrentBrush } from "../src/resolved-brush.ts";
import { createEditorState } from "../src/workbench-state.ts";
import { shallowRef } from "../vendor/vue/vue.esm-browser.prod.js";

// 最小假笔架：getRackToolKey 直返工具名；findToolBrushPure 默认返 null（→ resolveBrush 走 DEFAULT 兜底）。
function fakeRack(preset = null) {
  return { getRackToolKey: (t) => t, findToolBrushPure: () => preset };
}

describe("current-brush · 反应式接线（守 boot-smoke 抓不到的依赖断裂）", () => {
  it("改 dial.size → currentBrush.value.size 跟随重算", () => {
    const { state, dialReactive } = createEditorState();
    const { currentBrush } = makeCurrentBrush({ state, dialReactive, rack: fakeRack() });
    state.toolStates.brush.size = 17;
    eq(currentBrush.value.size, 17, "size dial 改了笔没跟");
    state.toolStates.brush.size = 88;
    eq(currentBrush.value.size, 88, "size dial 第二次改没跟（computed 没重算？）");
  });

  it("改全局 color → currentBrush.value.color 跟随", () => {
    const { state, dialReactive } = createEditorState();
    const { currentBrush } = makeCurrentBrush({ state, dialReactive, rack: fakeRack() });
    state.color = "#123456";
    eq(currentBrush.value.color, "#123456", "color 改了笔没跟");
  });

  it("computed 缓存：dep 不变则同一冻结值；dep 变则新值", () => {
    const { state, dialReactive } = createEditorState();
    const { currentBrush } = makeCurrentBrush({ state, dialReactive, rack: fakeRack() });
    const v1 = currentBrush.value;
    assert(v1 === currentBrush.value, "dep 没变应返回缓存的同一值");
    assert(Object.isFrozen(v1), "ResolvedBrush 应是冻结值");
    state.color = "#abcdef";
    assert(currentBrush.value !== v1, "dep 变了应是新值");
  });

  // v415：手动计数器 rackVersion 已删。笔架内容的反应式来源改成 controller 里的 shallowRef 镜像，
  //   currentBrush 经 findToolBrushPure 读它 → 依赖自动建立（不再靠"记得 bump"）。
  it("笔架内容变（镜像整体换）→ currentBrush 重算，无需任何手动 bump", () => {
    const { state, dialReactive } = createEditorState();
    const mirror = shallowRef([{ id: "b1", name: "笔A", size: { base: 10 }, spacing: 0.2 }]);
    // 仿真 controller：findToolBrushPure 读镜像（这一读就是依赖）
    const rack = {
      getRackToolKey: (t) => t,
      findToolBrushPure: (ts) => mirror.value.find((b) => b.id === ts.activeBrushId) ?? null,
    };
    state.toolStates.brush.activeBrushId = "b1";
    const { currentBrush } = makeCurrentBrush({ state, dialReactive, rack });
    eq(currentBrush.value.spacing, 0.2, "先读到笔A 的 spacing");
    // 模拟「编辑保存这支笔」→ collection.onChange → 镜像整体换上新数组
    mirror.value = [{ id: "b1", name: "笔A", size: { base: 10 }, spacing: 0.5 }];
    eq(currentBrush.value.spacing, 0.5, "★镜像换了 currentBrush 必须重算（依赖断了这里就还是 0.2）");
  });

  // 人类钉死的约束：computed **必须纯**。写回 reactive 会引发无限重算/难查的串扰，
  //   所以治愈型 findToolBrush（会写 ts.activeBrushId/Name）永远不许上 computed 路径。
  it("★纯度：求值 currentBrush 绝不写 toolStates", () => {
    const { state, dialReactive } = createEditorState();
    // 故意给一个**解析不到**的 activeBrushId —— 正是会诱使"治愈回写"的场景
    state.toolStates.brush.activeBrushId = "不存在的笔";
    state.toolStates.brush.activeBrushName = "不存在";
    const before = JSON.stringify(state.toolStates);
    const { currentBrush } = makeCurrentBrush({ state, dialReactive, rack: fakeRack() });
    void currentBrush.value;
    void currentBrush.value;
    eq(JSON.stringify(state.toolStates), before, "求值前后 toolStates 必须逐字节一致（computed 内不许写 reactive）");
  });
});
