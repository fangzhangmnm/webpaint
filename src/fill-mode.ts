// fill-mode（v0.5.11 生，v0.5.12 升第一类工具）——油漆桶 = 选区机器 + 填色消费视图。
//   任何选区生产者（魔棒/套索/矩形/椭圆/将来的 AI 分割）都自动获得填色能力——本模块零 flood 知识，
//   阈值/自动扩张是魔棒（选区生产者）的属性（editorState.magicWand），不在这里。
//
// 语义（user 拍板 2026-07-24 两轮，ADR-0004 + v0.5.12 修订）：
//   · fill 是**第一类工具**（editMode "fill"；指针经 pointer-route 全走 lasso role，零第二套代码）。
//     工具身份即模式——editorState.fillMode 开关已删（工具不 per-doc 持久化，与笔/套索一视同仁）。
//   · **只 preview 不落文档**：fill 工具 + 有选区 → GPU 预览（board fill provider → 笔刷 overlay 同槽，
//     journal v0.4 Plan L81「commit 和 live 同一个 shader，ssot」）。
//   · 出口语义（v0.5.15 user 修正；切工具出口 v0.6.19 再修订，ADR-0004 修订记录）：
//       回套索（油漆桶 toggle 关 / L 键）= **取消**——丢弃预览、选区保留，回去继续编辑选区；
//       切去其他工具（笔/橡皮/…）   = **commit + 清选区**（v0.6.19：原"选区保留"改清——
//         填完切笔就是要画画了，蚂蚁线留着碍事；undo 兜底可回）；
//       ✓  = commit + 清选区（选区的 commit，compound 一整点，留在 fill 连续填下一块）；
//       去选 = 丢弃（选区一起清，undo 兜底）。
//     文档关闭/切换 = 丢弃（interrupt=cancel 家规；commit 只对显式的工具切换）。
//   · 填色**尊重 lockAlpha**（预览=commit 同 shader 同参）；吸管吸预览色（拍板#8 同款）。
//
// 切出=commit 的钩子：听 wp:modechange，跟踪「上一个持久模式」——transient（adjust/transform/crop）
//   是括号不是切出（进扩张 modal 再回来不该触发 commit；transient 中途切工具时括号展开落到新工具，
//   此时才算真切出）。像素正确性 = gl-smoke fillParity。

import { requireEditableLeaf } from "./editable-leaf.ts";
import { reportError } from "./error-badge.ts";
import { t } from "./i18n/index.ts";
import { watch } from "../vendor/vue/vue.esm-browser.prod.js";
import type { AppContext } from "./app-context.ts";
import type { Layer } from "./doc.ts";

let _ctx: AppContext | null = null;
let _lastPersistentMode = "";

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

// 像素 commit（+可选清选区）一个 compound 整点。微步纪律：全 checkpoint:false（v0.5.5 教训）。
//   before 快照归属：像素动了交 ops.pixels；GL 未提交（false=像素未动）→ 本地还原释放。
function _doCommit(clearSelection: boolean): void {
  const { doc, board, input, history, workpiece, ops, state, setStatus } = _ctx!;
  const layer = requireEditableLeaf(doc, setStatus) as Layer | null;
  if (!layer || !doc.selection) return;
  const before = layer.snapshot();
  let handedOff = false;
  const st = history.compound(workpiece, () => {
    const ok = board.commitFill({ color: state.color, layer });
    if (!ok) throw new Error("GL fill merge 未提交（无选区/池到顶）");
    handedOff = true;
    const stPx = history.run(workpiece, ops.pixels, { layerId: layer.id, _initialBefore: before }, { checkpoint: false, label: "fill" });
    if (!stPx.ok) throw new Error(stPx.msg || "ops.pixels 入栈失败");
    if (clearSelection) {
      const entry = input.lasso.setSelection(null);
      if (entry) history.run(workpiece, ops.selection, { _initialBefore: { v: entry.before ?? null } }, { checkpoint: false });
    }
  });
  if (!st.ok) {
    if (!handedOff) layer.restoreFromSnapshot(before);   // 像素没动、快照没人接手 → 还原姿态释放
    reportError(new Error("[fill] commit 失败：" + (st.msg || "?")), "warning");
    setStatus(t("fm.commitFailed"), true);
    board.invalidateAll();
    return;
  }
  board.invalidateAll();
  setStatus(t("se.filled", { color: state.color }));
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
  if (m === "fill" && prev !== "fill") { board.requestRender(); return; }
  if (prev !== "fill" || m === "fill") return;
  if (m === "lasso") { board.requestRender(); return; }   // 取消油漆桶：丢弃预览，回去继续编辑选区
  // 真切去别的工具：预览确实挂着才 commit（组/隐藏层本就没显示 → 静默跳过）。
  //   v0.6.19：commit 后清选区（原保留；user 2026-07-28——进其他工具不留选区）。
  if (doc.selection && requireEditableLeaf(doc, null)) _doCommit(true);
  else board.requestRender();   // 没得 commit 也要刷掉残余 overlay
}

export function initFillMode(ctx: AppContext): void {
  _ctx = ctx;
  _lastPersistentMode = ctx.editMode.current();
  // 预览 provider（board 每渲染帧拉取）：active 才给内容；组/隐藏层静默不预览。
  ctx.board.setFillProvider(() => {
    if (!fillPreviewActive()) return null;
    const leaf = requireEditableLeaf(ctx.doc, null) as Layer | null;
    return leaf ? { color: ctx.state.color, layer: leaf } : null;
  });
  // 换色即预览跟色；选区/图层面板触发的重绘走 histchange/invalidate + docVersion 订阅（app.ts）。
  watch(() => ctx.dialReactive.color, () => { if (fillPreviewActive()) ctx.board.requestRender(); });
  window.addEventListener("wp:modechange", _onModeChange);
}
