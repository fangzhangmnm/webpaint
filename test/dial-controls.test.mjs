// dial-controls 测试 —— 下沉自组合根的 dial 写入 + 键盘调粗（survey rec #3）。
// 不需 DOM（用最小假 rack/board/leftDial + 反应式 state）。

import { describe, it, assert, eq } from "./runner.mjs";
import { makeDialControls } from "../src/dial-controls.ts";
import { createEditorState } from "../src/editor-state.ts";

// 假笔架：write* 直接写 toolStates（复刻真 rack 行为的最小子集）；按 getEditMode 当前工具。
function fakeRack(state, sizeMax = 200) {
  return {
    getRackToolKey: (t) => t,
    writeCurrentToolSize: (v) => { state.toolStates.brush.size = v; },
    writeCurrentToolOpacity: (v) => { state.toolStates.brush.opacity = v; },
    findToolBrushPure: () => ({ size: { max: sizeMax } }),
  };
}

describe("dial-controls · dial 写入 + 键盘调粗", () => {
  it("setSize：clamp 成 ≥1 整数 + 写 dial", () => {
    const { state } = createEditorState();
    const { setSize } = makeDialControls({ state, rack: fakeRack(state), getEditMode: () => ({ current: () => "brush" }) });
    setSize(0.4);
    eq(state.toolStates.brush.size, 1, "setSize 应 clamp 到 ≥1");
    setSize(33.7);
    eq(state.toolStates.brush.size, 34, "setSize 应 round 成整数");
  });

  it("setOpacity：写 dial opacity", () => {
    const { state } = createEditorState();
    const { setOpacity } = makeDialControls({ state, rack: fakeRack(state), getEditMode: () => ({ current: () => "brush" }) });
    setOpacity(0.5);
    eq(state.toolStates.brush.opacity, 0.5, "setOpacity 没写 dial");
  });

  it("currentDials：按 getEditMode 当前工具返回对应 dial", () => {
    const { state } = createEditorState();
    const { currentDials } = makeDialControls({ state, rack: { getRackToolKey: (t) => t }, getEditMode: () => ({ current: () => "eraser" }) });
    state.toolStates.eraser.size = 55;
    eq(currentDials().size, 55, "currentDials 没返回当前工具(eraser)的 dial");
  });

  it("键盘 wp:adjsize：段量化 + clamp 到预设 max + flashSize", () => {
    const { state } = createEditorState();
    state.toolStates.brush.size = 12;
    const { bindKeyboard } = makeDialControls({ state, rack: fakeRack(state, 50), getEditMode: () => ({ current: () => "brush" }) });
    let flashed = 0;
    bindKeyboard({ board: { _cursor: null }, leftDial: { flashSize: () => { flashed++; } } });
    // 12 在「<20 step=1」段：+1 方向 → 13。
    window.dispatchEvent(new CustomEvent("wp:adjsize", { detail: +1 }));
    eq(state.toolStates.brush.size, 13, "键盘 +1 段量化错（12→13 期望，<20 段 step=1）");
    assert(flashed >= 1, "应触发 leftDial.flashSize");
    // 验更大段：48（<50 step=2）+1 → 50（clamp 到预设 max=50）。
    state.toolStates.brush.size = 48;
    window.dispatchEvent(new CustomEvent("wp:adjsize", { detail: +1 }));
    eq(state.toolStates.brush.size, 50, "48→50（step=2 段 + clamp 到 max=50）");
  });

  it("键盘：非绘制工具忽略", () => {
    const { state } = createEditorState();
    state.toolStates.brush.size = 12;
    const { bindKeyboard } = makeDialControls({ state, rack: fakeRack(state), getEditMode: () => ({ current: () => "lasso" }) });
    bindKeyboard({ board: { _cursor: null }, leftDial: { flashSize: () => {} } });
    window.dispatchEvent(new CustomEvent("wp:adjsize", { detail: +1 }));
    eq(state.toolStates.brush.size, 12, "lasso 工具不该改 size");
  });
});
