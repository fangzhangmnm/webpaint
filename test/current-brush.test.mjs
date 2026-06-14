// current-brush 反应式接线测试 —— 守 boot-smoke 抓不到的那个风险（survey rec #3 下沉 currentBrush 时）。
//
// currentBrush 是把 dial/预设/color/压感装配成 ResolvedBrush 的 computed。下沉到工厂后，最怕的不是
// 手感漂移（手感数学在 resolveBrush，没动），而是**反应式依赖断了**：改了 dial/color/预设笔不更新。
// 这里直接验「改 dep → currentBrush 重算且反映新值」+ flush 时机无关的纯反应正确性。
// 不需要 DOM（Vue reactivity 在 node 直跑，resolveBrush 是纯函数）。

import { describe, it, assert, eq } from "./runner.mjs";
import { makeCurrentBrush } from "../src/current-brush.ts";
import { createEditorState } from "../src/editor-state.ts";

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

  it("依赖 dialReactive.rackVersion：bump → 重算（编辑/重置预设后活动预设字段刷新）", () => {
    const { state, dialReactive } = createEditorState();
    const { currentBrush } = makeCurrentBrush({ state, dialReactive, rack: fakeRack() });
    const v1 = currentBrush.value;
    dialReactive.rackVersion++;
    assert(currentBrush.value !== v1, "rackVersion bump 没触发重算（依赖漏了？）");
  });

  it("bindEngine：currentBrush 变 → input.brush.invalidateStamp 被调（引擎桥未断）", () => {
    const { state, dialReactive } = createEditorState();
    const { currentBrush, bindEngine } = makeCurrentBrush({ state, dialReactive, rack: fakeRack() });
    let calls = 0;
    bindEngine({ brush: { invalidateStamp: () => { calls++; } } });
    state.toolStates.brush.size = 42;
    void currentBrush.value;   // flush:"sync" 下 watch 在 dep 变时即触发；读一次确保 computed 求值
    assert(calls >= 1, "currentBrush 变了但引擎桥没 invalidateStamp");
  });
});
