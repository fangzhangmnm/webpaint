// fill-mode（v0.5.11）——「油漆桶」重生为套索工具的**填充模式**：填色 = doc.selection 的消费视图。
//   任何选区生产者（魔棒/套索/矩形/椭圆/将来的 AI 分割）都自动获得填色能力——本模块零 flood 知识，
//   阈值/自动扩张是魔棒（选区生产者）的属性（editorState.magicWand），不在这里。
//
// 语义（user 拍板 2026-07-24，supersede v0.5 #22「不碰选区」拍板）：
//   · **只 preview 不落文档**：模式开 + 有选区 + lasso 工具 → GPU 预览。管线全面参考笔刷
//     （journal v0.4 Plan L81「commit 和 live 同一个 shader，ssot」）：board fill provider →
//     stamp overlay 同槽（render-tree-gl FillOverlayInput，1×1 填色纹理 × selMask）。
//   · **✓ = 选区的 commit**：填色落层（board.commitFill，GPU merge→tile diff→ops.pixels）+ 清选区，
//     compound 封一个 undo 整点——undo 一步 = 像素回滚 + 选区恢复。
//   · 切走工具 / 退出模式 = 丢弃预览（interrupt=cancel 家规）；预览期间零文档突变。
//   · 填色**尊重 lockAlpha**（与旧 CPU fillOnLayer 无视锁α不同，有意行为变更；预览=commit 同 shader 同参）。
//   · 吸管吸预览色（board.pickCompositeColor 已接 fill overlay，同 v0.4.11 拍板#8 surrogate 待遇）。
//   · 开关 per-doc 持久化（editorState.fillMode，与其他 toolstate 一视同仁进 .webpaint/editor-state.json）；
//     选区**不**持久化 → 重开文档开关还在、选区重选、预览不复活（user：「选区不进更简单，我更喜欢这样」）。
//
// 像素正确性 = gl-smoke fillParity（golden 对 CPU fillOnLayer / commit≡live / lockAlpha / 导出不漏预览）。

import { editorState } from "./workbench-state.ts";
import { requireEditableLeaf } from "./editable-leaf.ts";
import { reportError } from "./error-badge.ts";
import { t } from "./i18n/index.ts";
import { watch } from "../vendor/vue/vue.esm-browser.prod.js";
import type { AppContext } from "./app-context.ts";
import type { Layer } from "./doc.ts";

let _ctx: AppContext | null = null;

// 开关（per-doc SSoT = editorState.fillMode.on；toolbar pressed 态 / G·L 快捷键 都走这里）。
export function fillModeOn(): boolean { return !!_ctx && editorState.fillMode.on; }

// 预览挂着？= 开关 && 有选区 && lasso 工具 && 非浮层变换中。
//   lasso 项使 board 的 overlay 槽断言结构安全（lasso canDraw=false → 不可能同时有 brush overlay），
//   也让浮层变换/切走工具期间预览自动隐身（丢弃语义）。isMidOperation（autosave 让路）也吃这个谓词。
export function fillPreviewActive(): boolean {
  if (!_ctx) return false;
  return !!(editorState.fillMode.on && _ctx.doc.selection
    && _ctx.editMode.current() === "lasso" && !_ctx.input.lasso.hasFloating());
}

export function setFillMode(on: boolean): void {
  if (!_ctx || editorState.fillMode.on === !!on) return;
  editorState.fillMode.on = !!on;
  window.dispatchEvent(new CustomEvent("wp:fillmodechange"));   // toolbar pressed/✓✗ 重派生
  _ctx.board.requestRender();   // 预览开/关：plan 签名含 overlay 标记 → 下帧自动重合成（无需 invalidateAll）
}

// ✓ = 选区的 commit：像素 + 清选区一个 compound 整点。
//   微步纪律：全部 checkpoint:false，compound 收口统一封（v0.5.5 盖印同款教训）。
//   before 快照归属：成功交给 ops.pixels；GL 未提交（false=像素未动）→ 本地释放。
export function commitFillNow(): void {
  if (!_ctx || !fillPreviewActive()) return;
  const { doc, board, input, history, workpiece, ops, state, setStatus } = _ctx;
  const layer = requireEditableLeaf(doc, setStatus) as Layer | null;
  if (!layer) return;
  const before = layer.snapshot();
  let handedOff = false;
  const st = history.compound(workpiece, () => {
    const ok = board.commitFill({ color: state.color, layer });
    if (!ok) throw new Error("GL fill merge 未提交（无选区/池到顶）");
    handedOff = true;   // 像素已动：before 交 ops.pixels（失败由 compound 回滚释放）
    const stPx = history.run(workpiece, ops.pixels, { layerId: layer.id, _initialBefore: before }, { checkpoint: false, label: "fill" });
    if (!stPx.ok) throw new Error(stPx.msg || "ops.pixels 入栈失败");
    const entry = input.lasso.setSelection(null);
    if (entry) history.run(workpiece, ops.selection, { _initialBefore: { v: entry.before ?? null } }, { checkpoint: false });
  });
  if (!st.ok) {
    if (!handedOff) {
      // 像素没动、快照没人接手 → 还原姿态释放（restoreFromSnapshot 消费快照，与 PixelTx.abort 同式）
      layer.restoreFromSnapshot(before);
    }
    reportError(new Error("[fill] commit 失败：" + (st.msg || "?")), "warning");
    setStatus(t("fm.commitFailed"), true);
    board.invalidateAll();
    return;
  }
  board.invalidateAll();
  setStatus(t("se.filled", { color: state.color }));
}

export function initFillMode(ctx: AppContext): void {
  _ctx = ctx;
  // 预览 provider（board 每渲染帧拉取）：active 才给内容；组/隐藏层静默不预览（无状态行刷屏）。
  ctx.board.setFillProvider(() => {
    if (!fillPreviewActive()) return null;
    const leaf = requireEditableLeaf(ctx.doc, null) as Layer | null;
    return leaf ? { color: ctx.state.color, layer: leaf } : null;
  });
  // 换色即预览跟色（反应式 dial → 重绘请求）；选区/undo 触发的重绘走既有 histchange/invalidate 路径。
  watch(() => ctx.dialReactive.color, () => { if (fillPreviewActive()) ctx.board.requestRender(); });
}
