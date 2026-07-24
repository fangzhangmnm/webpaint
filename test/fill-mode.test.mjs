// v0.5.11 fill-mode：active 谓词真值表 + 开关事件 + pre-init 安全（isMidOperation 可能早于 init 调用）。
// 像素正确性不在这里——gl-smoke fillParity（golden/commit≡live/lockAlpha/导出不漏）。
import { test, eq } from "./runner.mjs";
import { editorState } from "../src/workbench-state.ts";
import { initFillMode, fillModeOn, fillPreviewActive, setFillMode } from "../src/fill-mode.ts";

// 最小 fake ctx（fill-mode 只碰这些面；provider/watch 接线烟囱式验证）。
function makeCtx() {
  const calls = { requestRender: 0, provider: null };
  const ctx = {
    doc: { selection: null },
    editMode: { current: () => ctx._mode },
    input: { lasso: { hasFloating: () => ctx._floating } },
    board: {
      setFillProvider: (fn) => { calls.provider = fn; },
      requestRender: () => { calls.requestRender++; },
      invalidateAll: () => {},
      commitFill: () => true,
    },
    state: { color: "#ff0000" },
    dialReactive: { color: "#ff0000" },
    setStatus: () => {},
    _mode: "lasso", _floating: false,
  };
  return { ctx, calls };
}

test("[fill-mode] pre-init：谓词恒 false（isMidOperation 早调不炸）", () => {
  // 模块可能已被别的用例 init 过 → 只验不炸 + 布尔返回
  eq(typeof fillPreviewActive(), "boolean", "不炸且返回布尔");
});

test("[fill-mode] active 谓词真值表：开关 && 选区 && lasso && 非浮层", () => {
  const { ctx, calls } = makeCtx();
  initFillMode(ctx);
  editorState.reset();
  eq(fillModeOn(), false, "默认关（freshGroups SSoT）");
  eq(fillPreviewActive(), false, "关 → 不预览");
  setFillMode(true);
  eq(fillModeOn(), true, "开关写入 editorState（per-doc 持久化面）");
  eq(fillPreviewActive(), false, "开但无选区 → 不预览");
  ctx.doc.selection = {};   // 结构占位：谓词只判非空
  eq(fillPreviewActive(), true, "开+选区+lasso → 预览");
  ctx._mode = "brush";
  eq(fillPreviewActive(), false, "切走工具 → 预览丢弃（interrupt=cancel）");
  ctx._mode = "lasso"; ctx._floating = true;
  eq(fillPreviewActive(), false, "浮层变换中 → 预览让位");
  ctx._floating = false;
  eq(fillPreviewActive(), true, "浮层收摊 → 预览回来");
  // provider 接线：active 时给 {color, layer}?——此 fake doc 无 activeEditableLeaf，只验注册发生
  eq(typeof calls.provider, "function", "board.setFillProvider 已注册");
  editorState.reset();
});

test("[fill-mode] setFillMode：写 SSoT + 派 wp:fillmodechange + 请求重绘", () => {
  const { ctx, calls } = makeCtx();
  initFillMode(ctx);
  editorState.reset();
  let events = 0;
  const onChange = () => { events++; };
  window.addEventListener("wp:fillmodechange", onChange);
  setFillMode(true);
  setFillMode(true);   // 幂等：同值不重复派事件
  eq(events, 1, "开关变化派一次事件（幂等）");
  eq(calls.requestRender >= 1, true, "请求重绘（plan 签名含 overlay → 下帧重合成）");
  setFillMode(false);
  eq(events, 2, "关同样派事件");
  window.removeEventListener("wp:fillmodechange", onChange);
  editorState.reset();
});
