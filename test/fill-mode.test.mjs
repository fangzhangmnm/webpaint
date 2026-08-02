// v0.5.12 fill-mode（第一类工具版）：active 谓词真值表 + 切出=commit 钩子（transient 括号不算切出）。
// 像素正确性不在这里——gl-smoke fillParity（golden/commit≡live/lockAlpha/导出不漏）。
import { test, eq } from "./runner.mjs";
import { initFillMode, fillPreviewActive, commitFillNow, sendSelectionToFill } from "../src/fill-mode.ts";

// 最小 fake ctx：fill-mode 只碰这些面。editMode 状态机用字段模拟 + 手动派 wp:modechange。
function makeCtx() {
  const calls = { commitFill: 0, setSelectionNull: 0, provider: null, requestRender: 0 };
  const layer = {
    id: 7,
    snapshot: () => ({ snap: true }),
    restoreFromSnapshot: () => { calls.restored = true; },
  };
  const ctx = {
    _mode: "brush", _transient: false, _floating: false,
    doc: {
      selection: null,
      activeEditableLeaf: () => ({ leaf: layer, reason: null }),
    },
    editMode: { current: () => ctx._mode, isTransient: () => ctx._transient },
    input: { lasso: {
      hasFloating: () => ctx._floating,
      setSelection: (v) => { const before = ctx.doc.selection; ctx.doc.selection = v; if (v === null) calls.setSelectionNull++; return { before, after: v }; },
    } },
    board: {
      setFillProvider: (fn) => { calls.provider = fn; },
      requestRender: () => { calls.requestRender++; },
      invalidateAll: () => {},
      commitFill: () => { calls.commitFill++; return true; },
    },
    history: {
      compound: (_w, fn) => { try { fn(); return { ok: true }; } catch (e) { return { ok: false, msg: String(e) }; } },
      run: () => ({ ok: true }),
    },
    workpiece: {}, ops: { pixels: {}, selection: {} },
    state: { color: "#ff0000" },
    dialReactive: { color: "#ff0000" },
    setStatus: () => {},
  };
  return { ctx, calls, layer };
}

function setMode(ctx, mode, transient = false) {
  ctx._mode = mode; ctx._transient = transient;
  window.dispatchEvent(new CustomEvent("wp:modechange"));
}

test("[fill-mode] 谓词：fill 工具 && 有选区 && 非浮层", () => {
  const { ctx } = makeCtx();
  initFillMode(ctx);
  ctx._mode = "brush";
  eq(fillPreviewActive(), false, "非 fill 工具不预览");
  ctx._mode = "fill";
  eq(fillPreviewActive(), false, "无选区不预览");
  ctx.doc.selection = {};
  eq(fillPreviewActive(), true, "fill+选区 → 预览");
  ctx._floating = true;
  eq(fillPreviewActive(), false, "浮层中让位");
  ctx._floating = false;
});

test("[fill-mode] ✓ = commit + 清选区（一个 compound 整点）", () => {
  const { ctx, calls } = makeCtx();
  initFillMode(ctx);
  ctx._mode = "fill"; ctx.doc.selection = {};
  commitFillNow();
  eq(calls.commitFill, 1, "GPU commit 走了一次");
  eq(calls.setSelectionNull, 1, "选区清空（选区的 commit）");
  eq(ctx.doc.selection, null, "doc.selection 已空");
});

test("[fill-mode] 切出=commit+清选区（v0.6.19 修订）；transient 括号不算切出", () => {
  const { ctx, calls } = makeCtx();
  initFillMode(ctx);
  // 建立基线：当前持久模式 = fill
  setMode(ctx, "fill");
  ctx.doc.selection = {};
  // fill → adjust（transient 括号，如扩张 modal）→ 回 fill：不 commit
  setMode(ctx, "adjust", true);
  setMode(ctx, "fill");
  eq(calls.commitFill, 0, "transient 括号往返不 commit");
  // fill → brush（真切出）：commit + 清选区（v0.6.19 user 拍板：进其他工具不留选区；原 v0.5.15 保留）
  setMode(ctx, "brush");
  eq(calls.commitFill, 1, "切出 fill = commit");
  eq(calls.setSelectionNull, 1, "切出 commit 清选区（填完切笔要画画，蚂蚁线留着碍事）");
  eq(ctx.doc.selection, null, "选区已清");
  // brush → fill → adjust → brush（transient 中途切工具 = 括号展开落到新工具）：commit 一次
  setMode(ctx, "fill");
  ctx.doc.selection = {};
  setMode(ctx, "adjust", true);
  setMode(ctx, "brush");
  eq(calls.commitFill, 2, "transient 中途切工具也算切出 fill → commit");
});

test("[fill-mode] 切出时无选区 / 活动层不可编辑 → 静默跳过", () => {
  const { ctx, calls } = makeCtx();
  initFillMode(ctx);
  setMode(ctx, "fill");
  ctx.doc.selection = null;
  setMode(ctx, "brush");
  eq(calls.commitFill, 0, "无选区切出不 commit");
  setMode(ctx, "fill");
  ctx.doc.selection = {};
  ctx.doc.activeEditableLeaf = () => ({ leaf: null, reason: "group" });
  setMode(ctx, "brush");
  eq(calls.commitFill, 0, "活动层是组（预览本没显示）切出不 commit、不炸");
});

test("[fill-mode] v0.6.24 不互通：带选区进 fill = 清选区（undo 兜底）", () => {
  const { ctx, calls } = makeCtx();
  initFillMode(ctx);
  setMode(ctx, "lasso");
  ctx.doc.selection = {};             // lasso 里圈了个选区
  setMode(ctx, "fill");               // 切进 fill
  eq(calls.setSelectionNull, 1, "进 fill 清掉带进来的选区");
  eq(ctx.doc.selection, null, "fill 从零开始");
  eq(calls.commitFill, 0, "只清不 commit（没预览可 commit）");
});

test("[fill-mode] v0.6.24 不互通：fill→lasso 也 commit+清（对称无特例）", () => {
  const { ctx, calls } = makeCtx();
  initFillMode(ctx);
  setMode(ctx, "fill");
  ctx.doc.selection = {};             // fill 里自己点出选区
  setMode(ctx, "lasso");              // 回套索
  eq(calls.commitFill, 1, "回 lasso 也 commit（v0.5.15 '保留' 作废）");
  eq(calls.setSelectionNull, 1, "commit 后清选区");
  eq(ctx.doc.selection, null, "选区不跟去 lasso");
});

test("[fill-mode] v0.7.38 送入填色：one-shot 携入不清选区，只生效一次（ADR-0004 修订 5）", () => {
  const { ctx, calls } = makeCtx();
  initFillMode(ctx);
  // 测试侧接线：wp:settool → 假 editMode 切模式（真 app 是 toolbar.setTool 完整路径）
  const onSetTool = (e) => setMode(ctx, e.detail);
  window.addEventListener("wp:settool", onSetTool);
  try {
    setMode(ctx, "lasso");
    ctx.doc.selection = {};             // lasso 里圈好选区
    sendSelectionToFill();              // 显式命令：携入
    eq(ctx._mode, "fill", "settool 走通，进了 fill");
    eq(calls.setSelectionNull, 0, "携入：本次不清选区");
    eq(ctx.doc.selection !== null, true, "选区保留在 fill 里");
    // 出口语义不动：切走 = commit + 清
    setMode(ctx, "brush");
    eq(calls.commitFill, 1, "切出照旧 commit");
    eq(calls.setSelectionNull, 1, "切出照旧清选区");
    // one-shot：再正常进 fill → 照旧清（旗标没黏住）
    setMode(ctx, "lasso");
    ctx.doc.selection = {};
    setMode(ctx, "fill");
    eq(calls.setSelectionNull, 2, "旗标只生效一次，正常进 fill 照旧清");
    // 无选区 / 已在 fill：no-op 不派事件
    ctx.doc.selection = null;
    setMode(ctx, "lasso");
    sendSelectionToFill();
    eq(ctx._mode, "lasso", "无选区：不切换");
  } finally { window.removeEventListener("wp:settool", onSetTool); }
});
