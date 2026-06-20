// 职责（单一）：图片/.ora 导入——照片新建 doc / 叠为新层 / 文件选择器 / 大图导入询问 sheet / 拖拽落图。
// 三条入口：
//   _openImagePicker()      图层面板「导入图片」按钮 → 触发 oraFileInput（强制走 importImageAsLayer）
//   importImageAsNewDoc()   图库「导入照片 / 剪贴板新建」语义：照片当新 doc 打底（doc 尺寸 = 照片，cap 8192）
//   importImageAsLayer()    photobash / Ctrl+V 粘贴 / 桌面拖拽：图片叠为当前 doc 的新层（含自动 lift transform）
// oraFileInput change-handler 按文件类型分流（.ora→session.adopt / image→As{NewDoc|Layer}）。
// 大图（> 画布）走 _openBigImportSheet 询问 fit / 保原 / 自定义尺寸。
// 与 app 经 ctx 绑核心单例（doc/board/input/...）；leaf 依赖直接 import（session/resample/ora/els）。
// 「导入照片(新建)」复用 session.newDoc 骨架（fillLayer0 画照片），不再自建 PaintDoc/做 doc 替换。

import { els } from "./els.ts";
import { session } from "./session-state.ts";
import { decodeImageFile, smartResample } from "./resample.ts";
import { decodeOraToDoc } from "./ora.ts";
import { store as _store } from "./app-store.ts";
import { stripSessionExt } from "./config.ts";
import { ensureUnlockedForBlob } from "./enc-thumbs.ts";
import { onPasswordVerified } from "./crypto-state.ts";
import { setTool, updateLassoToolbar } from "./toolbar.ts";
import { _makeFullLayerSelection } from "./selection-ops.ts";
import { _suppressTransientPanels, _commitTransform, _cancelTransform } from "./transient-panels.ts";
import type { AppContext } from "./app-context.ts";
import type { PaintDoc } from "./doc.ts";

// 错误信息提取（catch 子句 e 在 strict 下是 unknown）。
const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e);

// 导入时往 doc 活层写像素（doc.js 未类型化 → 只描述用到的字段；ctx 容 OffscreenCanvas/HTMLCanvasElement）。
interface ImportLayer {
  name: string; bboxX: number; bboxY: number; bboxW: number; bboxH: number;
  canvas: CanvasImageSource; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}
// big-import sheet 的结果。
interface BigImportChoice { w: number; h: number; mode: string; }
interface TransientOpts { apply?: () => void; abort?: () => void; }

// app 单例 / 跨模块函数（initImportImage(ctx) 装入）。
let doc: AppContext["doc"], board: AppContext["board"], input: AppContext["input"], editMode: AppContext["editMode"];
let setStatus: AppContext["setStatus"], updateSaveStatus: AppContext["updateSaveStatus"];
let renderLayersPanel: AppContext["renderLayersPanel"], setGalleryOpen: AppContext["setGalleryOpen"], uniqueLocalName: AppContext["uniqueLocalName"];

// 图库「导入照片」会 set 此 flag=true，oraFileInput change 读后立即复位（语义：照片打底新 doc）。
let _addImportAsNewDoc = false;

// v123 把 layer op 抽成 named 函数：原 4 个 footer 按钮挪进 menu/popup
export function _openImagePicker() {
  // v125 修 (user：「图层面板的导入图片不成功」)
  //   图库"导入照片"会 set _addImportAsNewDoc=true，如果用户取消 file picker
  //   flag 不会清。下次从图层面板导入会被路由到 importImageAsNewDoc（替换 doc），
  //   user 觉得"不成功"。这里强制 false 让图层面板入口走 importImageAsLayer
  _addImportAsNewDoc = false;
  els.oraFileInput.value = "";
  els.oraFileInput.click();
}

// 「导入照片」语义：用照片新建一个 doc（doc 尺寸 = 照片尺寸，cap 8192），
// 单层就是这张照片。和"导入图片 / .ora"（叠新图层到当前 doc）不同。
export async function importImageAsNewDoc(file: File) {
  const bitmap = await decodeImageFile(file);
  const w = Math.min(8192, bitmap.width);
  const h = Math.min(8192, bitmap.height);
  const stem = file.name.replace(/\.[^.]+$/, "") || "导入";
  const name = await uniqueLocalName(stem);
  // 共用 session.newDoc 骨架（消 survey rec #4 孪生）：照片绘制 = fillLayer0；doc 替换/全部重置/
  // 落盘/checkpoint 归 session。照片导入因此与空白新建完全对齐（清 selection/参考窗 + color 归黑 +
  // 加密归明文 + 关图库）——human 定：之前不重置这些反而是小 bug。
  await session.newDoc({ name, w, h, fillLayer0: (layer: unknown) => {
    const L = layer as ImportLayer;
    L.name = file.name.replace(/\.[^.]+$/, "") || "图像";
    L.bboxX = 0; L.bboxY = 0;
    L.bboxW = w; L.bboxH = h;
    const c = (typeof OffscreenCanvas !== "undefined")
      ? new OffscreenCanvas(w, h)
      : (() => { const x = document.createElement("canvas"); x.width = w; x.height = h; return x; })();
    L.canvas = c;
    const lctx = c.getContext("2d", { willReadFrequently: false })!;
    L.ctx = lctx;
    lctx.imageSmoothingEnabled = true;
    lctx.imageSmoothingQuality = "high";
    // 超 8192 缩小走 step-halving 抗锯齿；否则原样画
    const src = (w < bitmap.width || h < bitmap.height) ? smartResample(bitmap, w, h) : bitmap;
    lctx.drawImage(src, 0, 0, w, h);
    (bitmap as ImageBitmap).close?.();
  } });
  setStatus(`新建（照片）：${name}（${w}×${h}）`);
}

// 把图片当一个新图层叠进当前 doc（photobash / 参考图工作流）。
// 居中对齐；如果图片比 doc 大，按比例缩到 80% 短边，避免一上来就盖死。
// v134 big-import sheet：图片 > 画布 弹询问
//   resolve { w, h, mode } 或 null（取消）
function _openBigImportSheet(ow: number, oh: number, docW: number, docH: number): Promise<BigImportChoice | null> {
  const backdrop = document.getElementById("bigImportBackdrop") as HTMLElement;
  const sheet = document.getElementById("bigImportSheet") as HTMLElement;
  const wIn = document.getElementById("bigImportW") as HTMLInputElement;
  const hIn = document.getElementById("bigImportH") as HTMLInputElement;
  const modeSel = document.getElementById("bigImportMode") as HTMLSelectElement;
  const info = document.getElementById("bigImportInfo") as HTMLElement;
  const okBtn = document.getElementById("bigImportConfirm") as HTMLElement;
  const cancelBtn = document.getElementById("bigImportCancel") as HTMLElement;
  // fit-to-canvas（保比例 = 短边贴齐）
  const scale = Math.min(docW / ow, docH / oh);
  const fitW = Math.round(ow * scale);
  const fitH = Math.round(oh * scale);
  info.textContent = `图片 ${ow}×${oh} · 画布 ${docW}×${docH}`;
  wIn.value = String(fitW);
  hIn.value = String(fitH);
  // 默认 fit choice
  for (const r of sheet.querySelectorAll('input[name="bigImportChoice"]')) {
    (r as HTMLInputElement).checked = ((r as HTMLInputElement).value === "fit");
  }
  // W/H input 联动（锁宽高比，由当前 ow/oh 决定）
  const aspect = ow / oh;
  const setChoice = (val: string) => {
    for (const r of sheet.querySelectorAll('input[name="bigImportChoice"]')) {
      (r as HTMLInputElement).checked = ((r as HTMLInputElement).value === val);
    }
    if (val === "fit") { wIn.value = String(fitW); hIn.value = String(fitH); }
    else if (val === "keep") { wIn.value = String(ow); hIn.value = String(oh); }
  };
  wIn.oninput = () => {
    setChoice("custom");
    const v = parseFloat(wIn.value) | 0;
    if (v > 0) hIn.value = String(Math.max(1, Math.round(v / aspect)));
  };
  hIn.oninput = () => {
    setChoice("custom");
    const v = parseFloat(hIn.value) | 0;
    if (v > 0) wIn.value = String(Math.max(1, Math.round(v * aspect)));
  };
  for (const r of sheet.querySelectorAll('input[name="bigImportChoice"]')) {
    r.addEventListener("change", () => setChoice((r as HTMLInputElement).value));
  }
  backdrop.classList.remove("hidden");
  sheet.classList.remove("hidden");
  return new Promise<BigImportChoice | null>((resolve) => {
    const cleanup = () => {
      backdrop.classList.add("hidden");
      sheet.classList.add("hidden");
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      backdrop.onclick = null;
    };
    okBtn.onclick = () => {
      const w = Math.max(1, Math.min(8192, parseFloat(wIn.value) | 0));
      const h = Math.max(1, Math.min(8192, parseFloat(hIn.value) | 0));
      const mode = modeSel.value || "bicubic";
      cleanup();
      resolve({ w, h, mode });
    };
    cancelBtn.onclick = () => { cleanup(); resolve(null); };
    backdrop.onclick  = () => { cleanup(); resolve(null); };
  });
}

export async function importImageAsLayer(file: File, opts: { center?: { x: number; y: number } } = {}) {
  const bitmap = await decodeImageFile(file);
  const ow = bitmap.width, oh = bitmap.height;
  const docW = doc.width, docH = doc.height;
  // v134 (user：「导入超大图片弹 sheet」) bitmap 比 doc 大 → 询问 fit / 保原 / 自定义
  let w = ow, h = oh; let imgSmoothing: ImageSmoothingQuality = "high";
  if (ow > docW || oh > docH) {
    const choice = await _openBigImportSheet(ow, oh, docW, docH);
    if (!choice) { (bitmap as ImageBitmap).close?.(); return; }   // user 取消
    w = choice.w; h = choice.h;
    imgSmoothing = choice.mode === "nearest" ? "low" : "high";
  }
  // 新建空层
  const layer = doc.addLayer(file.name.replace(/\.[^.]+$/, ""));
  if (!layer) {
    (bitmap as ImageBitmap).close?.();
    setStatus(`图层已达上限 (${doc.maxLayers})，无法导入`);
    return;
  }
  // bbox 中心：默认 doc 中心；opts.center（doc 坐标）可指定（Ctrl+V 传视口中心）
  const ccx = opts.center?.x ?? docW / 2;
  const ccy = opts.center?.y ?? docH / 2;
  layer.bboxX = Math.floor(ccx - w / 2);
  layer.bboxY = Math.floor(ccy - h / 2);
  layer.bboxW = w;
  layer.bboxH = h;
  const c = (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(w, h)
    : (() => { const x = document.createElement("canvas"); x.width = w; x.height = h; return x; })();
  layer.canvas = c;
  const lctx = c.getContext("2d", { willReadFrequently: false })!;
  layer.ctx = lctx;
  lctx.imageSmoothingEnabled = imgSmoothing !== "low";
  lctx.imageSmoothingQuality = imgSmoothing;
  // 缩小且非 nearest（像素画保持硬边）→ step-halving 抗锯齿；否则原样画
  const lsrc = (imgSmoothing !== "low" && (w < ow || h < oh)) ? smartResample(bitmap, w, h) : bitmap;
  lctx.drawImage(lsrc, 0, 0, w, h);
  (bitmap as ImageBitmap).close?.();
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
  _store.edits.mark();
  updateSaveStatus();
  // 触发 wp:histchange 让保存状态同步
  window.dispatchEvent(new CustomEvent("wp:histchange", { detail: { canUndo: input.canUndo(), canRedo: input.canRedo() } }));

  // v111: 自动 lift 全图入 transform（user：「导入图片到图层之后自动全选图片进入 transform 模式」）
  try {
    const sel = _makeFullLayerSelection(layer);
    if (sel) {
      doc.selection = sel as typeof doc.selection;
      setTool("lasso");
      const ok = input.lasso.liftSelectionForTransform(layer);
      if (ok) {
        (editMode.enterTransient as (n: string, o?: TransientOpts) => void)("transform", { apply: _commitTransform, abort: _cancelTransform });
        input.lasso.setMode("free");
        updateLassoToolbar();
        _suppressTransientPanels("transform");
        board.invalidateAll();
        setStatus(`已导入：${file.name}（拖角变换 → 应用 / 取消）`);
        return;
      }
    }
  } catch (e) { console.warn("[import auto-transform]", e); }
  setStatus(`已导入为新图层：${file.name}`);
}

export function initImportImage(ctx: AppContext) {
  doc = ctx.doc;
  board = ctx.board;
  input = ctx.input;
  editMode = ctx.editMode;
  setStatus = ctx.setStatus;
  updateSaveStatus = ctx.updateSaveStatus;
  renderLayersPanel = ctx.renderLayersPanel;
  setGalleryOpen = ctx.setGalleryOpen;
  uniqueLocalName = ctx.uniqueLocalName;

  // 图层面板「导入图片」按钮 → file picker（强制叠层，复位 _addImportAsNewDoc）。
  document.getElementById("layerImportPhotoBtn")?.addEventListener("click", _openImagePicker);

  // file-input plumbing：按文件类型分流（.ora→adopt / image→As{NewDoc|Layer}）。
  els.oraFileInput.addEventListener("change", async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    // 图库里"导入照片"语义：把照片当新 doc 打底（不是叠到当前）
    const asNewDoc = _addImportAsNewDoc;
    _addImportAsNewDoc = false;
    if (!file) return;
    const isOra = /\.(ora|zip)$/i.test(file.name);   // .zip = 加密容器导出件（ADR-0012）
    const isImage = (file.type || "").startsWith("image/");
    try {
      if (isOra) {
        const nm = stripSessionExt(file.name) || "未命名";
        // 外来文件可能是加密容器（可能用与图库不同的密码）→ busy 外解锁 + 显式密码解，
        //   再按落库 name 记忆（onPasswordVerified：全局空→上位 / 否则 per-name 覆盖）。
        let plain: Blob = file;
        if (await _store.looksEncrypted(file)) {
          const pw = await ensureUnlockedForBlob(file);
          if (pw == null) { setStatus("已取消导入（需要密码）", true); return; }
          const out = await _store.unsealWith(file, pw);
          if (!out) { setStatus("导入失败（密码不对）", true); return; }
          plain = out;
          onPasswordVerified(nm, pw);
        }
        const loaded = await decodeOraToDoc(plain);
        session.adopt(loaded as PaintDoc, nm);
        setStatus(`已导入：${nm}`);
        setGalleryOpen(false);
      } else if (isImage) {
        if (asNewDoc) {
          await importImageAsNewDoc(file);
          setGalleryOpen(false);
        } else {
          await importImageAsLayer(file);
        }
      } else {
        setStatus(`不支持的文件类型：${file.type || file.name}`);
      }
    } catch (err) {
      console.warn("[import] failed:", err);
      setStatus("导入失败：" + errMsg(err));
    }
  });

  // v156 桌面拖拽图片到画布 → 导入为新层（落点 = 拖放位置）。external image = new layer 语义。
  window.addEventListener("dragover", (e: DragEvent) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault();   // 允许 drop
  });
  window.addEventListener("drop", async (e: DragEvent) => {
    const files = [...(e.dataTransfer?.files || [])];
    const img = files.find((f: File) => f.type && f.type.startsWith("image/"));
    if (!img) return;                                  // 非图片（如 .ora）不拦，让默认行为
    e.preventDefault();
    if (document.body.dataset.mode === "gallery") { setStatus("退出图库后再拖入图片", true); return; }
    const center = board.screenToDoc(e.clientX, e.clientY);
    try { await importImageAsLayer(img, { center }); }
    catch (err) { setStatus(`拖入失败：${errMsg(err)}`, true); }
  });

  // 图库「导入照片」入口（galleryAddPopup → addImportPhoto）设 _addImportAsNewDoc 经此函数。
  // app.js 的 addImportPhoto 按钮仍直接调 els.oraFileInput.click()，需先 setAddImportAsNewDoc(true)。
}

// 图库「导入照片 / 剪贴板新建」语义切换器：app.js addImportPhoto / addImportClipboard 路径要置 true。
export function setAddImportAsNewDoc(v: boolean) { _addImportAsNewDoc = v; }
