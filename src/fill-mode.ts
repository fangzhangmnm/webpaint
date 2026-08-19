// fill-mode（v0.5.11 生，v0.5.12 升第一类工具）——油漆桶 = 选区机器 + 填色消费视图。
//   任何选区生产者（魔棒/套索/矩形/椭圆/将来的 AI 分割）都自动获得填色能力——本模块零 flood 知识，
//   阈值/自动扩张是魔棒（选区生产者）的属性（desk.magicWand），不在这里。
//
// 语义（user 拍板 2026-07-24 两轮，ADR-0004 + v0.5.12 修订）：
//   · fill 是**第一类工具**（editMode "fill"；指针经 pointer-route 全走 lasso role，零第二套代码）。
//     工具身份即模式——desk.fillMode 开关已删（工具不 per-doc 持久化，与笔/套索一视同仁）。
//   · **只 preview 不落文档**：fill 工具 + 有选区 → GPU 预览（board fill provider → 笔刷 overlay 同槽，
//     journal v0.4 Plan L81「commit 和 live 同一个 shader，ssot」）。
//   · 出口语义（v0.6.24「彻底不互通」拍板，ADR-0004 修订记录；супersede v0.5.15/v0.6.19）：
//       **进 fill（从任何工具，含 lasso）= 清选区**（undo 兜底）——fill 从零开始自己点；
//       切去任何工具（**含回 lasso**）= **commit + 清选区**（对称，无特例）；
//       ✓  = commit + 清选区（留在 fill 连续填下一块）；去选 = 丢弃。
//     mental model = 两个不能互通的工具（实现共用一条 lasso 管线）。
//     文档关闭/切换 = 丢弃（interrupt=cancel 家规；commit 只对显式的工具切换）。
//   · 填色**尊重 lockAlpha**（预览=commit 同 shader 同参）；吸管吸预览色（拍板#8 同款）。
//
// 切出=commit 的钩子：听 wp:modechange，跟踪「上一个持久模式」——transient（adjust/transform/crop）
//   是括号不是切出（进扩张 modal 再回来不该触发 commit；transient 中途切工具时括号展开落到新工具，
//   此时才算真切出）。像素正确性 = gl-smoke fillParity。

import { requireEditableLeaf } from "./editable-leaf.ts";
import { reportError } from "./error-badge.ts";
import { t } from "./i18n/index.ts";
import { registerColorTarget, refreshColorDisplay } from "./color-panel.ts";
import type { AppContext } from "./app-context.ts";
import type { ViewLeaf } from "./backend/workpiece/painting-view.ts";

let _ctx: AppContext | null = null;
let _lastPersistentMode = "";
// v0.7.38（ADR-0004 修订 5）：「送选区进填色」的 one-shot 例外旗标——显式命令携选区进 fill 时
// 抑制**下一次**「进 fill = 清选区」。出口语义（切走 = commit + 清）一字不动，对称性只开单向口。
let _carryIn = false;

// 把当前选区送进 fill（lasso ⋯ 菜单「送入填色」）。无选区 = 静默 no-op（按钮 needs-sel 本就禁用）。
// 派 wp:settool 走完整 setTool 路径（rack.applyToolState 等），不直调 editMode.setTool。
export function sendSelectionToFill(): void {
  if (!_ctx || !_ctx.doc.selection) return;
  if (_ctx.editMode.current() === "fill") return;
  _carryIn = true;
  window.dispatchEvent(new CustomEvent("wp:settool", { detail: "fill" }));
}

// ---- fill 预览期换色入 undo（v0.7.8 生；T4c 换 PendingFill 组件 + 色板 target 切换）----
// 预览挂着时改色 = 可撤销（改的是「将要填的东西」= PendingFill.color，**笔刷色不动**）。
// 防抖合并一次拖拽/连点为一条 entry；commit 前 flush（undo 顺序 = 先撤 fill 再撤换色）。
// undo/redo 直接翻组件 substrate → onChange(kind=pendingFill) 刷显示——旧 FillColorOp 的
// 回灌抑制（_expectFromHistory）机制随 op 一起死。
let _colorBase: string | null = null;                       // 待入栈 entry 的「改前色」；null = 无 pending
let _colorTimer: ReturnType<typeof setTimeout> | undefined;

// 「将要填的颜色」（预览/commit 的取色口；无 pending 时退回笔刷色）。
function _fillColor(): string {
  return _ctx!.wp2.pendingFill.view()?.color ?? _ctx!.state.color;
}

function _flushColorEntry(force = false): void {
  clearTimeout(_colorTimer);
  if (_colorBase === null) return;
  const base = _colorBase;
  _colorBase = null;
  if (!_ctx) return;
  // 定时器路径：预览已不在 → 幽灵步作废。commit 路径传 force——切工具时 editMode 已不是
  // fill，谓词失真，但换色 entry 必须先落栈（undo 顺序 = 先撤 fill 像素再撤换色）。
  if (!force && !fillPreviewActive()) return;
  const pf = _ctx.wp2.pendingFill;
  const cur = pf.view()?.color;
  if (cur == null || base === cur) return;
  _ctx.history.withPoint("fillColor", {}, () => pf.commitPreApplied(base));
}

// 预览挂着？= fill 工具 && 有选区 && 非浮层。board 的 overlay 槽断言靠它结构安全
// （fill canDraw=false → 不可能同时有 brush overlay）。
export function fillPreviewActive(): boolean {
  if (!_ctx) return false;
  return !!(_ctx.editMode.current() === "fill" && _ctx.doc.selection && !_ctx.input.lasso.hasFloating());
}

// ✓：commit + 清选区（选区的 commit）。预览没挂着时静默 no-op（按钮本就该隐着）。
export function commitFillNow(): void {
  if (!fillPreviewActive()) return;
  _doCommit(true);
}

// 像素 commit（+可选清选区）一个 compound 整点（= 一个令牌一步，ADR-0004 出入口语义不动）。
//   v2（T2）：before 快照/ops.pixels 微步退役——commitFill 的 tile 换手由 LayerTiles collector
//   写时扣押；compound 中途失败 = token.cancel 倒序回滚（像素/选区一体无痕）。
function _doCommit(clearSelection: boolean): boolean {
  _flushColorEntry(true);   // pending 换色先落栈——undo 顺序 = 先撤 fill 像素再撤换色
  const { doc, board, input, history, wp2, setStatus } = _ctx!;
  const fillColor = _fillColor();
  const layer = requireEditableLeaf(doc, setStatus) as ViewLeaf | null;
  if (!layer || !doc.selection) return false;
  const st = history.withPoint("fill", {}, () => {
    const ok = board.commitFill({ color: fillColor, layer });
    if (!ok) throw new Error("GL fill merge not committed (no selection / pool exhausted)");
    if (clearSelection) {
      const entry = input.lasso.setSelection(null);
      if (entry) wp2.selection.commitPreApplied(entry.before ?? null);   // 本整点令牌已开——直写组件 verb
    }
    // ADR-0008 §6「commit = [tiles+selection 清+PendingFill 清] 一步」——v0.8.29 对齐落地
    // （user 2026-08-10「应该清」）；undo fill → seed 随 step 还原。
    wp2.pendingFill.clearRecorded();
  });
  if (!st.ok) {
    reportError(new Error("[fill] commit failed: " + (st.msg || "?")), "warning");
    setStatus(t("fm.commitFailed"), true);
    board.invalidateAll();
    return false;   // ✓ 路径：选区保留可重试；切出路径：调用方负责清（不许泄漏进下个工具）
  }
  // 留在 fill（✓ 连续填下一块）：seed 用刚落地的色重新起步（导航态）——色窗/下一块不丢色。
  if (_ctx!.editMode.current() === "fill") wp2.pendingFill.begin(fillColor);
  board.invalidateAll();
  setStatus(t("se.filled", { color: fillColor }));
  return true;
}

// fill 边界钩子。只认「持久模式 → 持久模式」的真切换；transient 括号（扩张 modal 等）不算。
//   出口分叉（v0.5.15）：→lasso = 取消（预览是派生视图，重绘即消）；→其他工具 = commit（选区保留）。
//   进 fill 也要补一帧（有选区时预览要立即出现——board 只在被请求时出帧）。
function _onModeChange(): void {
  const { editMode, doc, board } = _ctx!;
  const m = editMode.current();
  if (editMode.isTransient()) return;   // 括号里：不更新、不判
  const prev = _lastPersistentMode;
  _lastPersistentMode = m;
  if (m !== "fill") _carryIn = false;   // 旗标只对「下一次进 fill」有效；走去别处即作废
  if (m === "fill" && prev !== "fill") {
    _ctx!.wp2.pendingFill.begin(_ctx!.state.color);   // 起步 = 当前笔刷色（显示零跳变）
    // v0.7.38（ADR-0004 修订 5）：sendSelectionToFill 的 one-shot 携入——本次不清选区
    if (_carryIn) { _carryIn = false; board.requestRender(); return; }
    // v0.6.24 不互通：进 fill = 清掉带进来的选区（undo 兜底）——fill 从零开始自己点
    const { input, history, wp2 } = _ctx!;
    if (doc.selection) {
      const entry = input.lasso.setSelection(null);
      if (entry) history.withPoint("selection", {}, () => wp2.selection.commitPreApplied(entry.before ?? null));
    }
    board.requestRender();
    return;
  }
  if (prev !== "fill" || m === "fill") return;
  // 真切出 fill（v0.6.24 含回 lasso，无特例）：**先 commit 后清场**（v0.8.29 修——曾先
  //   pendingFill.clear() 再 _doCommit，_fillColor 落回笔刷色：预览是绿、落地成红）。
  //   预览确实挂着才 commit + 清选区（组/隐藏层本就没显示 → 静默跳过，但选区也要清——不互通）。
  if (doc.selection && requireEditableLeaf(doc, null)) {
    if (!_doCommit(true) && doc.selection) {
      // commit 失败（token 已回滚，选区还活着）：「切走 = 清」不变量对失败分支也成立——
      // 否则幽灵选区泄漏进下个工具，下一笔被静默裁剪（v0.9.11 修；错误已由 _doCommit 上报）。
      const { input, history, wp2 } = _ctx!;
      const entry = input.lasso.setSelection(null);
      if (entry) history.withPoint("selection", {}, () => wp2.selection.commitPreApplied(entry.before ?? null));
    }
  } else if (doc.selection) {
    const { input, history, wp2, setStatus } = _ctx!;
    const entry = input.lasso.setSelection(null);
    if (entry) history.withPoint("selection", {}, () => wp2.selection.commitPreApplied(entry.before ?? null));
    setStatus(t("fm.exitNoFill"), true);   // 组/隐藏层：预览本就没显示，但选区被清了要说一声（v0.9.11）
  }
  // pending 色退场：commit 分支里 clearRecorded 已清（切出路径不 re-seed），这里兜未 commit
  // 的残余（导航态）；残余防抖作废——预览已不在，记了也是幽灵步。
  _colorBase = null; clearTimeout(_colorTimer);
  _ctx!.wp2.pendingFill.clear();
  refreshColorDisplay();   // 色板显示回笔刷色（它从未被 fill 期间的换色碰过）
  board.requestRender();   // 没得 commit 也要刷掉残余 overlay
}

export function initFillMode(ctx: AppContext): void {
  _ctx = ctx;
  _lastPersistentMode = ctx.editMode.current();
  // 预览 provider（board 每渲染帧拉取）：active 才给内容；组/隐藏层静默不预览。
  ctx.board.setFillProvider(() => {
    if (!fillPreviewActive()) return null;
    const leaf = requireEditableLeaf(ctx.doc, null) as ViewLeaf | null;
    return leaf ? { color: _fillColor(), layer: leaf } : null;
  });
  // 色板 target 切换（T4c；v0.8.24 从「仅预览期」扩到 fill 工具全程）：fill 里 setColor/吸管/色词
  // 全改 PendingFill（笔刷色不动）。全程接管修的退化 = 无选区期改色曾写笔刷色、pendingFill seed
  // 不跟，下一次圈选预览用的是进 fill 时的陈旧色（「填色没反应全局颜色窗的颜色」）。
  // 记账只在预览挂着时走防抖 350ms（v0.7.8 语义）；无预览期改色 = 换 seed（画布零变化，不占 undo 步）。
  registerColorTarget(() => {
    if (ctx.editMode.current() !== "fill") return null;   // transient 括号里也让位（current = 括号模式）
    const pf = ctx.wp2.pendingFill;
    if (!pf.view()) pf.begin(ctx.state.color);   // 兜底（undo 把选区变回来等路径）
    return {
      get: () => pf.view()!.color,
      set: (hex) => {
        const cur = pf.view()!.color;
        if (cur === hex) return;
        if (fillPreviewActive()) {
          if (_colorBase === null) _colorBase = cur;
          clearTimeout(_colorTimer);
          _colorTimer = setTimeout(_flushColorEntry, 350);
        }
        pf.setColorLive(hex);
        ctx.board.requestRender();
      },
    };
  });
  // undo/redo 翻 pending 色 → 色板显示重同步 + 预览重绘（组件信号，无回灌环）。
  ctx.wp2.onChange((e) => {
    if (e.kind !== "pendingFill") return;
    _colorBase = null; clearTimeout(_colorTimer);   // 栈动了：作废窗口内的防抖（防幽灵合并）
    refreshColorDisplay();
    ctx.board.requestRender();
  });
  window.addEventListener("wp:modechange", _onModeChange);
  // fill 里 tap 出选区但活动层不可填（组/隐藏）：蚂蚁线和 ✓ 照常出现而预览隐形（provider 静默
  // null）——曾经零提示直到按 ✓ 才报。选区一变就用标准 el.* 文案报状态行（v0.9.11）。
  window.addEventListener("wp:lassochange", () => {
    if (!_ctx || !fillPreviewActive()) return;
    requireEditableLeaf(_ctx.doc, _ctx.setStatus);
  });
  // 载图/新建时 fill 工具还挂着（工具不随 doc 切换重置）：旧 doc 的 pending seed 已无意义，
  // 用新 doc 的笔刷色重起步（导航态不记账）；防抖残余作废（v0.9.11——旧行为是 restore 的
  // setColor 被 target 劫持写进 pending，seed 陈旧 + 存档色蒸发，色板三方不一致）。
  window.addEventListener("wp:applyEditorState", () => {
    if (!_ctx || _ctx.editMode.current() !== "fill") return;
    _colorBase = null; clearTimeout(_colorTimer);
    _ctx.wp2.pendingFill.begin(_ctx.state.color);
    refreshColorDisplay();
    _ctx.board.requestRender();
  });
}
