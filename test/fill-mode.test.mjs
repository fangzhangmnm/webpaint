// v0.5.12 fill-mode（第一类工具版）：active 谓词真值表 + 切出=commit 钩子（transient 括号不算切出）。
// 像素正确性不在这里——gl-smoke fillParity（golden/commit≡live/lockAlpha/导出不漏）。
import { test, eq } from "./runner.mjs";
import { initFillMode, fillPreviewActive, commitFillNow, sendSelectionToFill, gateFillOnDocSwitch } from "../src/fill-mode.ts";
import { currentPanelColor, setColor, setBrushColor } from "../src/color-panel.ts";

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
      commitFill: (args) => { calls.commitFill++; calls.commitFillColor = args?.color; return true; },
    },
    history: {
      compound: (_w, fn) => { try { fn(); return { ok: true }; } catch (e) { return { ok: false, msg: String(e) }; } },
      withPoint: (_l, _o, fn) => { try { fn(); return { ok: true }; } catch (e) { return { ok: false, msg: String(e) }; } },
      run: () => ({ ok: true }),
    },
    workpiece: { sel: { commitPreApplied: () => ({ ok: true }) } }, ops: {},
    // T4c：pending 色组件 stub（真组件在 pending-fill.test.mjs；这里只要面形状）
    wp2: {
      pendingFill: {
        _v: null,
        view() { return this._v; },
        begin(c) { this._v = { color: c }; },
        clear() { this._v = null; },
        clearRecorded() { this._v = null; calls.pfClearRecorded = (calls.pfClearRecorded || 0) + 1; },
        setColorLive(c) { if (this._v) this._v = { color: c }; },
        commitPreApplied: () => {},
      },
      selection: { commitPreApplied: () => {} },
      onChange: () => {},
    },
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

test("[fill-mode] v0.8.29 commit 步含 PendingFill 清（ADR-0008 §6）；留在 fill 续填 seed 不丢", () => {
  const { ctx, calls } = makeCtx();
  initFillMode(ctx);
  setMode(ctx, "brush");
  setMode(ctx, "fill");
  setColor("#00ff00");
  ctx.doc.selection = {};
  commitFillNow();                         // ✓：commit + 清选区，留在 fill
  eq(calls.commitFillColor, "#00ff00", "落地色 = seed 色");
  eq(calls.pfClearRecorded, 1, "commit 整点内记账清 seed（user 2026-08-10「应该清」）");
  eq(ctx.wp2.pendingFill.view().color, "#00ff00", "✓ 后 seed 用刚填的色重新起步——连续填下一块色不丢");
  // 切出路径：commit 内清、不 re-seed（色板回笔刷色）
  ctx.doc.selection = {};
  setMode(ctx, "brush");
  eq(calls.pfClearRecorded, 2, "切出 commit 同样记账清");
  eq(ctx.wp2.pendingFill.view(), null, "切出后 seed 不复活");
});

test("[fill-mode] v0.8.29 切工具 commit 落的是 pending 色（WYSIWYG），不是笔刷色", () => {
  const { ctx, calls } = makeCtx();
  initFillMode(ctx);
  setMode(ctx, "brush");
  setMode(ctx, "fill");                    // 进 fill：seed = 笔刷色 #ff0000
  setColor("#00ff00");                     // fill 里换色（无选区 = 换 seed）
  ctx.doc.selection = {};                  // 圈选 → 预览挂起（预览显示绿）
  setMode(ctx, "brush");                   // 切工具 = commit（预览所见即所落）
  eq(calls.commitFill, 1, "切出 commit 走了一次");
  eq(calls.commitFillColor, "#00ff00", "落地色 = 预览色（曾先清 pendingFill 后 commit → 错落笔刷色）");
});

test("[fill-mode] v0.8.24 色板 target = fill 全程：无选区改色跟到 seed（color window 退化修复）", () => {
  const { ctx, calls } = makeCtx();
  initFillMode(ctx);
  setMode(ctx, "brush");
  setMode(ctx, "fill");                    // 进 fill：pendingFill.begin(笔刷色)
  eq(currentPanelColor(), "#ff0000", "进 fill 色板显示 = 笔刷色（零跳变）");
  setColor("#00ff00");                     // 无选区改色 → 改 pendingFill seed，不写笔刷色
  eq(ctx.wp2.pendingFill.view().color, "#00ff00", "无选区改色跟到 pendingFill（旧行为：漏写笔刷色、seed 陈旧）");
  eq(ctx.state.color, "#ff0000", "笔刷色不动（T4c 锚）");
  ctx.doc.selection = {};                  // 圈选 → 预览激活
  const p = calls.provider();              // board 每帧拉的 fill provider
  eq(p.color, "#00ff00", "预览用的就是色窗当前显示的色（不再陈旧）");
  eq(currentPanelColor(), "#00ff00", "色窗显示与预览一致");
  setMode(ctx, "brush");                   // 真切出：commit + pendingFill 清场
  eq(ctx.wp2.pendingFill.view(), null, "出 fill pendingFill 清场（色板回笔刷色）");
});

test("[fill-mode] v0.9.11 载图时 fill 挂着：setBrushColor 绕 target + applyEditorState 重 seed", () => {
  const { ctx } = makeCtx();
  initFillMode(ctx);
  setMode(ctx, "brush");
  setMode(ctx, "fill");
  setColor("#00ff00");                       // fill 里换色 → 改 seed（target 语义）
  eq(ctx.wp2.pendingFill.view().color, "#00ff00", "seed 已换");
  setBrushColor("#123456");                  // restore 路径（载图/新建/重置）：显式写笔刷，不经 target
  eq(ctx.wp2.pendingFill.view().color, "#00ff00", "setBrushColor 不碰 pendingFill（劫持修复锚——旧行为存档色被吞进 pending）");
  ctx.state.color = "#123456";               // 模拟反应式跟进（真实链路 desk.brushTool.color → state.color）
  window.dispatchEvent(new CustomEvent("wp:applyEditorState"));
  eq(ctx.wp2.pendingFill.view().color, "#123456", "载图后 pending 用新 doc 笔刷色重 seed（旧 doc seed 作废）");
  setMode(ctx, "brush");                     // 非 fill 工具下载图 = no-op
  window.dispatchEvent(new CustomEvent("wp:applyEditorState"));
  eq(ctx.wp2.pendingFill.view(), null, "非 fill 工具下 applyEditorState 不起 pending");
});

test("[fill-mode] v0.9.11 commit 失败切出：选区不泄漏进下个工具（切走=清 对失败分支也成立）", () => {
  const { ctx } = makeCtx();
  initFillMode(ctx);
  setMode(ctx, "fill");
  ctx.doc.selection = {};
  ctx.board.commitFill = () => false;        // GL 失败（池到顶/context lost）→ token 回滚
  setMode(ctx, "brush");
  eq(ctx.doc.selection, null, "失败后选区也被清——否则幽灵选区静默裁剪下一笔");
});

test("[fill-mode] v0.9.11 不可填层的静默失败补反馈：tap 报状态行 + 切出清选区报 fm.exitNoFill", () => {
  const { ctx } = makeCtx();
  const msgs = [];
  ctx.setStatus = (m) => msgs.push(String(m));
  ctx.doc.activeEditableLeaf = () => ({ leaf: null, reason: "group" });   // 活动层 = 图层组
  initFillMode(ctx);
  setMode(ctx, "fill");
  ctx.doc.selection = {};                    // tap 出了选区（蚂蚁线/✓ 都会出现，预览隐形）
  window.dispatchEvent(new CustomEvent("wp:lassochange"));
  eq(msgs.length >= 1, true, "tap 即报（曾静默到按 ✓ 才知道）");
  const before = msgs.length;
  setMode(ctx, "brush");                     // 切出：没得 commit，选区被清——要说一声
  eq(ctx.doc.selection, null, "选区已清（不互通语义不变）");
  eq(msgs.length > before, true, "清选区有提示（fm.exitNoFill）");
});

// ── 显式换文档挽留门（user 2026-08-21：「换文档如果走丢弃，文案里要有提示，而且要弹窗挽留」）──
// session-state 的 openItem/newDoc/openLocalFile + import-image 的 .ora 导入共用这一个分支函数；
// UI sheet 由调用方注入（ask），这里 mock ask 测三分支 + 免问放行。

test("[fill-mode] 换文档挽留门：预览没挂着 → 不问直接放行", async () => {
  const { ctx } = makeCtx();
  initFillMode(ctx);
  setMode(ctx, "brush");                     // 非 fill 工具：预览不可能挂着
  let asked = 0;
  eq(await gateFillOnDocSwitch(async () => { asked++; return "discard"; }), true, "放行");
  eq(asked, 0, "没弹 sheet（不许骚扰无 pending 的换文档）");
});

test("[fill-mode] 换文档挽留门：应用并继续 = commitFillNow 后放行", async () => {
  const { ctx, calls } = makeCtx();
  initFillMode(ctx);
  setMode(ctx, "fill");
  ctx.doc.selection = {};                    // 预览挂着
  eq(await gateFillOnDocSwitch(async () => "apply"), true, "放行");
  eq(calls.commitFill, 1, "填色已 commit（不蒸发）");
  eq(ctx.doc.selection, null, "commit 清选区（✓ 同款语义）");
});

test("[fill-mode] 换文档挽留门：丢弃并继续 = 不 commit、放行（原「切换=丢弃」行为，但问过了）", async () => {
  const { ctx, calls } = makeCtx();
  initFillMode(ctx);
  setMode(ctx, "fill");
  ctx.doc.selection = {};
  eq(await gateFillOnDocSwitch(async () => "discard"), true, "放行");
  eq(calls.commitFill, 0, "没 commit（丢弃 = 预览随换文档蒸发）");
});

test("[fill-mode] 换文档挽留门：取消（Esc/点背板 → null）= 拦下切换，预览原样留着", async () => {
  const { ctx, calls } = makeCtx();
  initFillMode(ctx);
  setMode(ctx, "fill");
  ctx.doc.selection = {};
  eq(await gateFillOnDocSwitch(async () => null), false, "拦下（调用方中止换文档）");
  eq(calls.commitFill, 0, "没 commit");
  eq(fillPreviewActive(), true, "预览还挂着（留在当前画继续调）");
});
