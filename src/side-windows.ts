// 职责（单一）：浮动辅助窗——参考小窗 + 调色板小窗（构造 + 各自的按钮/resize/菜单接线）。
// referenceWindow / paletteWindow 在 module-eval（import 时）构造，并作为 live binding 导出；
//   app.js 的晚绑 Object.assign(ctx, { referenceWindow, paletteWindow }) 与 session-state 直接读它们。
// 构造期的 config 回调只在 user 交互时被 CALL，故引用 module-level let（construct 时为 null，
//   initSideWindows(ctx) 在任何交互前填好）是安全的。setColor 是稳定 import，无需经 ctx。

import { ReferenceWindow } from "./reference.js";
import { PaletteWindow } from "./palette.js";
import { els } from "./els.ts";
import { decodeImageFile, fitWithin, canvasToBlob } from "./resample.ts";
import { setColor } from "./color-panel.ts";
import { setMenuOpen } from "./settings-menu.ts";
import type { AppContext } from "./app-context.ts";
const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e);

// initSideWindows(ctx) 填入；construct 期 null，仅 config 回调（lazy）/ button 接线读取。
let setStatus: AppContext["setStatus"], editMode: AppContext["editMode"], state: AppContext["state"], doc: AppContext["doc"], input: AppContext["input"], _store: AppContext["store"], updateSaveStatus: AppContext["updateSaveStatus"];

// ---- 参考小窗 ----
// 浮动 panel + 独立 viewport（pinch / zoom / rotate）。状态在 ReferenceWindow 内部维护。
export const referenceWindow = new ReferenceWindow({
  panel: els.referencePanel,
  head: els.referencePanelHead,
  body: els.referenceBody,
  canvas: els.referenceCanvas,
  closeBtn: els.referencePanelClose,
  emptyHint: els.referenceEmpty,
  status: (m: string, e?: boolean) => setStatus(m, e),
  // v154 参考窗吸色：eyedropper / 长按 → 吸窗内显示色，复用主吸色 setColor + pin
  getTool: () => editMode.current(),
  getLongPressPickEnabled: () => state.longPressPick,
  onColorSampled: (hex: string) => setColor(hex),
});

// ---- 调色板小窗（v87）----
// 256×256 mixer canvas + 刷 / 涂 / 吸 3 工具。吸色 → 主画 setColor。
// 画布内容跟 doc 走（webpaint/state.json 持久化，跟 reference 同模式）
export const paletteWindow = new PaletteWindow({
  root: document.getElementById("paletteWindow"),
  onColorSampled: (hex: string) => setColor(hex),
  getCurrentColor: () => state.color,
});
// 调色板小窗（v87 → v94 撤掉 menu 入口）：UI 已删，code 留 P2（backlog）

// v134 (user：「参考窗口大小可以调整」) iPad/touch resize handle
(function bindReferenceResize() {
  const handle = document.getElementById("referenceResizeHandle");
  const panel = els.referencePanel;
  if (!handle || !panel) return;
  let drag: { id: number; sx: number; sy: number; w0: number; h0: number } | null = null;
  handle.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const rect = panel.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, w0: rect.width, h0: rect.height };
  });
  handle.addEventListener("pointermove", (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const w = Math.max(160, Math.min(window.innerWidth - 40, drag.w0 + (e.clientX - drag.sx)));
    const h = Math.max(160, Math.min(window.innerHeight - 80, drag.h0 + (e.clientY - drag.sy)));
    panel.style.width = w + "px";
    panel.style.height = h + "px";
  });
  const endDrag = (e: PointerEvent) => {
    if (drag && e.pointerId === drag.id) {
      try { handle.releasePointerCapture(e.pointerId); } catch {}
      drag = null;
      // 触发 reference 重新布局（如果需要）
      window.dispatchEvent(new CustomEvent("wp:referenceResize"));
    }
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
})();

export function initSideWindows(ctx: AppContext) {
  setStatus = ctx.setStatus;
  editMode = ctx.editMode;
  state = ctx.state;
  doc = ctx.doc;
  input = ctx.input;
  _store = ctx.store;
  updateSaveStatus = ctx.updateSaveStatus;

  window.addEventListener("wp:toggleReference", () => referenceWindow.toggle());

  els.menuReference.addEventListener("click", () => {
    setMenuOpen(false);
    referenceWindow.open();
  });
  els.referenceLoadBtn.addEventListener("click", () => {
    els.referenceFileInput.value = "";
    els.referenceFileInput.click();
  });
  els.referenceFileInput.addEventListener("change", async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const decoded = await decodeImageFile(file);          // C：鲁棒解码（修 Windows createImageBitmap 失效）
      const REF_MAX = 2048;                                 // B：参考图最大边（≈2048² 面积上限）
      const fit = fitWithin(decoded, REF_MAX, REF_MAX);     // 超了 step-halving 缩小
      // 缩了就存缩小后的 PNG（省 .ora 体积）；没缩存原文件 Blob
      const persistBlob = fit.scaled ? await canvasToBlob(fit.source as Parameters<typeof canvasToBlob>[0]) : file;
      referenceWindow.setBitmap(fit.source, { persistBlob });
      if (fit.scaled) (decoded as ImageBitmap).close?.();                    // 缩放后原 bitmap 没用了，释放
      _store.edits.mark();
      updateSaveStatus();
      window.dispatchEvent(new CustomEvent("wp:histchange", { detail: { canUndo: input.canUndo(), canRedo: input.canRedo() } }));
      setStatus(`参考：${file.name}${fit.scaled ? `（已缩到 ${fit.w}×${fit.h}）` : ""}（会跟当前画一起保存）`);
    } catch (err) {
      setStatus("参考图载入失败：" + errMsg(err));
    }
  });
  els.referenceLiveBtn.addEventListener("click", () => {
    referenceWindow.toggleLive(doc);
    els.referenceLiveBtn.setAttribute("aria-pressed", referenceWindow.isLive() ? "true" : "false");
    setStatus(referenceWindow.isLive() ? "参考小窗：实时镜像主画布" : "参考小窗：已退出实时模式");
  });
  els.referenceFitBtn.addEventListener("click", () => referenceWindow.fitToPanel());
}
