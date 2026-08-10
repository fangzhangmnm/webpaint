// 职责（单一）：浮动辅助窗——参考小窗 + 调色板小窗（构造 + 各自的按钮/resize/菜单接线）。
// referenceWindow / paletteWindow 在 module-eval（import 时）构造，并作为 live binding 导出；
//   app.js 的晚绑 Object.assign(ctx, { referenceWindow, paletteWindow }) 与 session-state 直接读它们。
// 构造期的 config 回调只在 user 交互时被 CALL，故引用 module-level let（construct 时为 null，
//   initSideWindows(ctx) 在任何交互前填好）是安全的。setColor 是稳定 import，无需经 ctx。

import { t } from "./i18n/index.ts";
import { ReferenceWindow } from "./reference.ts";
import { PaletteWindow } from "./palette.ts";
import { els } from "./els.ts";
import { decodeImageFile, imageSourceToBytes } from "./shell/image-io.ts";
import { areaResampleBytes } from "./backend/algorithms/resample-bytes.ts";
import { encodePngFromBytes } from "./backend/png-codec.ts";
import { setColor } from "./color-panel.ts";
import { setMenuOpen } from "./settings-menu.ts";
import type { AppContext } from "./app-context.ts";
const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e);

// initSideWindows(ctx) 填入；construct 期 null，仅 config 回调（lazy）/ button 接线读取。
let setStatus: AppContext["setStatus"], editMode: AppContext["editMode"], state: AppContext["state"], doc: AppContext["doc"];

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
  root: document.getElementById("paletteWindow")!,
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
      await setReferenceFromFile(file);
    } catch (err) {
      setStatus(t("mi.referenceLoadFailed", { err: errMsg(err) }));
    }
  });
  els.referenceLiveBtn.addEventListener("click", () => {
    referenceWindow.toggleLive(doc);
    els.referenceLiveBtn.setAttribute("aria-pressed", referenceWindow.isLive() ? "true" : "false");
    setStatus(referenceWindow.isLive() ? t("mi.referenceLive") : t("mi.referenceLiveExit"));
  });
  els.referenceFitBtn.addEventListener("click", () => referenceWindow.fitToPanel());
}

// #19（v0.5）：把一张图片文件设为参考图——decode → 2048² 内缩放 → 开窗 + setBitmap + 标脏。
//   referenceFileInput 与「拖入图片 → 设为参考」（import-image drop 路径）共用；开窗幂等。
export async function setReferenceFromFile(file: File | Blob): Promise<void> {
  const decoded = await decodeImageFile(file);          // C：鲁棒解码（修 Windows createImageBitmap 失效）
  const REF_MAX = 2048;                                 // B：参考图最大边（≈2048² 面积上限）
  const sw = decoded.width || (decoded as HTMLImageElement).naturalWidth;
  const sh = decoded.height || (decoded as HTMLImageElement).naturalHeight;
  const scaled = sw > REF_MAX || sh > REF_MAX;
  let source: ImageBitmap | HTMLImageElement = decoded;
  let persistBlob: Blob = file;
  let fw = sw, fh = sh;
  if (scaled) {
    // C3 全字节：解码边界读出一次 → areaResampleBytes 缩小 → UPNG 存（省 .ora 体积）；
    //   显示位图从缩好的字节再造（createImageBitmap(ImageData)）。
    const k = Math.min(REF_MAX / sw, REF_MAX / sh);
    fw = Math.round(sw * k); fh = Math.round(sh * k);
    const px = imageSourceToBytes(decoded);
    const small = areaResampleBytes(px.data, sw, sh, fw, fh);
    const png = await encodePngFromBytes(small, fw, fh);
    persistBlob = new Blob([png as unknown as BlobPart], { type: "image/png" });
    source = await createImageBitmap(new ImageData(small, fw, fh));
  }
  referenceWindow.open();
  referenceWindow.setBitmap(source, { persistBlob });
  if (scaled) (decoded as ImageBitmap).close?.();       // 缩放后原 bitmap 没用了，释放
  // v0.8.5（S5·ADR-0007）：参考图 = sidecar（跟 ora 走 ∧ 不进 undo）——走正名的 wp:sidecarchange
  // 通道（编辑门/保存状态都听它）。旧姿势（markEdited + 伪造 wp:histchange）已死：那是「合法不记账
  // 却无合法标脏通道」逼出来的，undo 按钮态靠填真值才不被污染。
  window.dispatchEvent(new CustomEvent("wp:sidecarchange", { detail: { kind: "reference" } }));
  setStatus(t("mi.referenceLoaded", { name: (file as File).name || "", scaled: scaled ? t("mi.referenceScaled", { w: fw, h: fh }) : "" }));
}
