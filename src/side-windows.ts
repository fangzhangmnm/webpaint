// 职责（单一）：浮动辅助窗——参考小窗（<wp-reference-window> 组件的**宿主适配层**）+ 调色板小窗。
// C9（家族组件试点）后参考窗分两半：
//   组件（frontend/reference-window.ts）= chrome/手势/渲染，宿主 store 零知识；
//   这里 = 全部宿主接线：desk.refPanel 持久化、wp: 事件通道、live 合成（backend 知识）、
//   i18n labels、吸色 → 主 setColor + pin、文件载入（decode/resample = backend）。
// referenceWindow 导出 = 组件元素本身（satisfies ReferenceWindowHandle）；
//   app.ts 晚绑 Object.assign(ctx, { referenceWindow, paletteWindow }) 与 session-state 直接读。

import { t } from "./i18n/index.ts";
import { WpReferenceWindow } from "./frontend/reference-window.ts";
import type { RefLiveSource, RefPanelRect } from "./frontend/reference-window.ts";
import { PaletteWindow } from "./palette.ts";
import { els } from "./els.ts";
import { decodeImageFile, imageSourceToBytes } from "./shell/image-io.ts";
import { areaResampleBytes } from "./backend/algorithms/resample-bytes.ts";
import { encodePngFromBytes } from "./backend/png-codec.ts";
import { setColor } from "./color-panel.ts";
import { setMenuOpen } from "./settings-menu.ts";
import { raiseWindow } from "./surfaces.ts";
import { desk } from "./workbench-state.ts";
import { renderNodesToCanvas } from "./backend/doc-render.ts";
import type { AppContext } from "./app-context.ts";
const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e);

// initSideWindows(ctx) 填入；construct 期 null，仅事件回调（lazy）读取。
let setStatus: AppContext["setStatus"], editMode: AppContext["editMode"], state: AppContext["state"], doc: AppContext["doc"];

// ---- 参考小窗 ----
// 元素在 index.html（slot 文案吃宿主 i18n）；import 上面的组件模块已 define → 此处已升级。
export const referenceWindow = document.getElementById("referencePanel") as WpReferenceWindow;

// 开/关的**用户路径**（menu/快捷键/× 键）写 desk（per-doc 标脏）；程序性回灌不经这里。
function refSetOpen(open: boolean) {
  referenceWindow.open = open;
  if (open) raiseWindow(referenceWindow);   // v232：开窗即置顶（surfaces window band）
  desk.refPanel.enabled = open;
}

// live 镜像合成（S9：走 GL doc-render，respect clip/mode/组）。白纸显示常量（doc 无纸色，
// 同 board docBg）。组件只吃这个 provider；返回 null = GL 不可用 → 组件保留上帧。
let _liveCanvas: HTMLCanvasElement | null = null;
function composeLiveFrame(): RefLiveSource | null {
  const merged = renderNodesToCanvas(doc.layers, doc.width, doc.height);
  if (!merged) return null;
  const W = doc.width, H = doc.height;
  if (!_liveCanvas) _liveCanvas = document.createElement("canvas");
  if (_liveCanvas.width !== W || _liveCanvas.height !== H) { _liveCanvas.width = W; _liveCanvas.height = H; }
  const cx = _liveCanvas.getContext("2d")!;
  cx.clearRect(0, 0, W, H);
  cx.fillStyle = "#ffffff";
  cx.fillRect(0, 0, W, H);
  cx.drawImage(merged, 0, 0);
  return _liveCanvas;
}

// ---- 调色板小窗（v87）----
// 256×256 mixer canvas + 刷 / 涂 / 吸 3 工具。吸色 → 主画 setColor。
// 画布内容跟 doc 走（webpaint/state.json 持久化，跟 reference 同模式）
export const paletteWindow = new PaletteWindow({
  root: document.getElementById("paletteWindow")!,
  onColorSampled: (hex: string) => setColor(hex),
  getCurrentColor: () => state.color,
});
// 调色板小窗（v87 → v94 撤掉 menu 入口）：UI 已删，code 留 P2（backlog）

export function initSideWindows(ctx: AppContext) {
  setStatus = ctx.setStatus;
  editMode = ctx.editMode;
  state = ctx.state;
  doc = ctx.doc;
  const ref = referenceWindow;

  // ---- 组件事件 → desk 持久化（宿主 store 解耦：组件不认识 desk）----
  ref.addEventListener("viewportchange", (e) => {
    desk.refPanel.viewport = { ...(e as CustomEvent).detail };
  });
  ref.addEventListener("rectchange", (e) => {
    // 值没变就不写：RO 在程序性回灌/开窗后也 fire，回声不许误标脏（旧 _savePos 同款守卫）
    const d = (e as CustomEvent).detail as RefPanelRect;
    const cur = desk.refPanel.position;
    if (cur && cur.left === d.left && cur.top === d.top && cur.width === d.width && cur.height === d.height) return;
    desk.refPanel.position = { ...d };
  });
  ref.addEventListener("openchange", (e) => {
    desk.refPanel.enabled = !!((e as CustomEvent).detail as { open: boolean }).open;
  });

  // ---- 按钮请求（组件只发意图；文件对话框/live 源都是宿主知识）----
  ref.addEventListener("requestload", () => {
    els.referenceFileInput.value = "";
    els.referenceFileInput.click();
  });
  ref.addEventListener("requestlivetoggle", () => {
    if (ref.live) ref.stopLive();
    else ref.setLiveProvider(composeLiveFrame);
    setStatus(ref.live ? t("mi.referenceLive") : t("mi.referenceLiveExit"));
  });

  // ---- 吸色桥：组件读自家像素发事件，宿主接主吸色（setColor + wp:pickerShow pin）----
  ref.addEventListener("colorpickstart", () => setStatus(t("ref.picking")));
  ref.addEventListener("colorpick", (e) => {
    const { hex, screenX, screenY } = (e as CustomEvent).detail as { hex: string | null; screenX: number; screenY: number };
    if (!hex) { window.dispatchEvent(new CustomEvent("wp:pickerHide")); return; }   // 透明 → 没东西吸
    setColor(hex);
    window.dispatchEvent(new CustomEvent("wp:pickerShow", { detail: { sx: screenX, sy: screenY, hex } }));
  });
  ref.addEventListener("colorpickend", () => window.dispatchEvent(new CustomEvent("wp:pickerHide")));

  // ---- 宿主全局通道 → 组件（组件不监听 window；wp: 事件是宿主约定）----
  // doc 像素或图层结构变 → live 脏标（真合成组件内按脏标+节流做）
  // ?.：元素在无 customElements 的环境（boot smoke dom-shim）不升级、方法不存在——这两条在 boot
  // 期就会被派发，不 ?. 会把 dispatchEvent 炸穿（2026-08-10 挂死链的教训；见 ReferenceWindowHandle 注）
  window.addEventListener("wp:docpixeldirty", () => ref.markLiveDirty?.());
  window.addEventListener("wp:histchange", () => ref.markLiveDirty?.());
  // desk apply-on-load：程序性属性下灌**不发事件** → 不回写 desk、载入不标脏
  // （旧 _applying 两帧守卫退役：回声由上面 rectchange 的值比较吸收）
  window.addEventListener("wp:applyEditorState", () => {
    ref.viewport = desk.refPanel.viewport;
    ref.rect = desk.refPanel.position;
    ref.open = desk.refPanel.enabled;
    if (desk.refPanel.enabled) raiseWindow(ref);
  });
  window.addEventListener("wp:toggleReference", () => refSetOpen(!ref.open));

  // 吸管工具态桥：editMode.current()（wp:modechange 通知）→ 组件 pick 属性（光标 + 点吸行为）。
  // 注意不是 body[data-tool]：那个 transient（adjust/transform）期间保持旧持久工具，而吸色行为
  // 要跟 current()（旧 getTool 语义）。shadow 里 host-context 选择器不可靠（Safari/FF 弃/缺），
  // 属性同步是家族约定的标准桥。
  const syncPick = () => ref.toggleAttribute("pick", editMode.current() === "picker");
  window.addEventListener("wp:modechange", syncPick);
  syncPick();
  // 长按吸色开关：手势中查询宿主态的 pull 端口（约定「pull 例外」）
  ref.queryLongPressPick = () => state.longPressPick;

  // i18n：shadow 内按钮 tooltip 走 labels property（slot 够不到 title 属性）。
  // 语言切换 = 整页 reload（i18n 约定），boot 一次即可。
  ref.labels = {
    load: t("ref.load"), live: t("ref.live"), fit: t("ref.fit"),
    close: t("common.close.aria"), resize: t("ref.resize"), resizeAria: t("ref.resizeAria"),
  };

  els.menuReference.addEventListener("click", () => {
    setMenuOpen(false);
    refSetOpen(true);
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
  refSetOpen(true);
  referenceWindow.setBitmap(source, { persistBlob });
  if (scaled) (decoded as ImageBitmap).close?.();       // 缩放后原 bitmap 没用了，释放
  // v0.8.5（S5·ADR-0007）：参考图 = sidecar（跟 ora 走 ∧ 不进 undo）——走正名的 wp:sidecarchange
  // 通道（编辑门/保存状态都听它）。旧姿势（markEdited + 伪造 wp:histchange）已死：那是「合法不记账
  // 却无合法标脏通道」逼出来的，undo 按钮态靠填真值才不被污染。
  window.dispatchEvent(new CustomEvent("wp:sidecarchange", { detail: { kind: "reference" } }));
  setStatus(t("mi.referenceLoaded", { name: (file as File).name || "", scaled: scaled ? t("mi.referenceScaled", { w: fw, h: fh }) : "" }));
}
