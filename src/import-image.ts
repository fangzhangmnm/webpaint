// 职责（单一）：图片/.ora 导入——照片新建 doc / 叠为新层 / 文件选择器 / 大图导入询问 sheet / 拖拽落图。
// 三条入口：
//   _openImagePicker()      图层面板「导入图片」按钮 → 触发 oraFileInput（强制走 importImageAsLayer）
//   importImageAsNewDoc()   图库「导入照片 / 剪贴板新建」语义：照片当新 doc 打底（doc 尺寸 = 照片，cap 8192）
//   importImageAsLayer()    photobash / Ctrl+V 粘贴 / 桌面拖拽：图片叠为当前 doc 的新层（含自动 lift transform）
// oraFileInput change-handler 按文件类型分流（.ora→session.adopt / image→As{NewDoc|Layer}）。
// 大图（> 画布）走 _openBigImportSheet 询问 fit / 保原 / 自定义尺寸。
// 与 app 经 ctx 绑核心单例（doc/board/input/...）；leaf 依赖直接 import（session/PaintDoc/resample/ora/els）。

import { els } from "./els.ts";
import { session } from "./session-state.ts";
import { PaintDoc } from "./doc.js";
import { decodeImageFile, smartResample } from "./resample.js";
import { decodeOraToDoc } from "./ora.js";
import { store as _store } from "./app-store.js";
import { setTool, updateLassoToolbar } from "./toolbar.ts";
import { _makeFullLayerSelection } from "./selection-ops.ts";
import { _suppressTransientPanels, _commitTransform, _cancelTransform } from "./transient-panels.ts";

// app 单例 / 跨模块函数（initImportImage(ctx) 装入）。
let doc: any, board: any, input: any, editMode: any;
let setStatus: any, updateSaveStatus: any;
let applyCheckerboard: any, renderLayersPanel: any, setGalleryOpen: any, uniqueLocalName: any;

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
export async function importImageAsNewDoc(file: any) {
  const bitmap = await decodeImageFile(file);
  const w = Math.min(8192, bitmap.width);
  const h = Math.min(8192, bitmap.height);
  if (_store.edits.localDirty()) await session.save();
  const fresh = new PaintDoc({ width: w, height: h });
  doc.layers = fresh.layers;
  doc.activeIndex = 0;
  doc.width = w; doc.height = h;
  els.canvasSizeLabel.textContent = `${w}×${h}`;
  // 把照片直接画到 base layer 全图（覆盖 bbox 到整 doc）
  const layer = doc.layers[0];
  layer.name = file.name.replace(/\.[^.]+$/, "") || "图像";
  layer.bboxX = 0; layer.bboxY = 0;
  layer.bboxW = w; layer.bboxH = h;
  const c = (typeof OffscreenCanvas !== "undefined")
    ? new OffscreenCanvas(w, h)
    : (() => { const x = document.createElement("canvas"); x.width = w; x.height = h; return x; })();
  layer.canvas = c;
  layer.ctx = c.getContext("2d", { willReadFrequently: false });
  layer.ctx.imageSmoothingEnabled = true;
  layer.ctx.imageSmoothingQuality = "high";
  // 超 8192 缩小走 step-halving 抗锯齿；否则原样画
  const src = (w < bitmap.width || h < bitmap.height) ? smartResample(bitmap, w, h) : bitmap;
  layer.ctx.drawImage(src, 0, 0, w, h);
  bitmap.close?.();
  applyCheckerboard(false);    // v125: 导入新作品默认关棋盘
  const stem = file.name.replace(/\.[^.]+$/, "") || "导入";
  const name = await uniqueLocalName(stem);
  session.setName(name);
  input.clearHistory();
  board.invalidateAll();
  board.fitToScreen();
  renderLayersPanel();
  _store.edits.mark();
  session.resetSavedAt();
  updateSaveStatus();
  await session.save();
  // v133 revert checkpoint
  session.markOpenedNow();
  session.writeCheckpoint(name).catch((e: any) => console.warn("[revert] photo-import checkpoint:", e));
  setStatus(`新建（照片）：${name}（${w}×${h}）`);
}

// 把图片当一个新图层叠进当前 doc（photobash / 参考图工作流）。
// 居中对齐；如果图片比 doc 大，按比例缩到 80% 短边，避免一上来就盖死。
// v134 big-import sheet：图片 > 画布 弹询问
//   resolve { w, h, mode } 或 null（取消）
function _openBigImportSheet(ow: number, oh: number, docW: number, docH: number) {
  const backdrop = document.getElementById("bigImportBackdrop");
  const sheet = document.getElementById("bigImportSheet");
  const wIn = document.getElementById("bigImportW") as HTMLInputElement;
  const hIn = document.getElementById("bigImportH") as HTMLInputElement;
  const modeSel = document.getElementById("bigImportMode") as HTMLSelectElement;
  const info = document.getElementById("bigImportInfo");
  const okBtn = document.getElementById("bigImportConfirm");
  const cancelBtn = document.getElementById("bigImportCancel");
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
  return new Promise((resolve) => {
    const cleanup = () => {
      backdrop.classList.add("hidden");
      sheet.classList.add("hidden");
      (okBtn as any).onclick = null;
      (cancelBtn as any).onclick = null;
      (backdrop as any).onclick = null;
    };
    (okBtn as any).onclick = () => {
      const w = Math.max(1, Math.min(8192, parseFloat(wIn.value) | 0));
      const h = Math.max(1, Math.min(8192, parseFloat(hIn.value) | 0));
      const mode = modeSel.value || "bicubic";
      cleanup();
      resolve({ w, h, mode });
    };
    (cancelBtn as any).onclick = () => { cleanup(); resolve(null); };
    (backdrop as any).onclick  = () => { cleanup(); resolve(null); };
  });
}

export async function importImageAsLayer(file: any, opts: any = {}) {
  const bitmap = await decodeImageFile(file);
  const ow = bitmap.width, oh = bitmap.height;
  const docW = doc.width, docH = doc.height;
  // v134 (user：「导入超大图片弹 sheet」) bitmap 比 doc 大 → 询问 fit / 保原 / 自定义
  let w = ow, h = oh, imgSmoothing = "high";
  if (ow > docW || oh > docH) {
    const choice = await _openBigImportSheet(ow, oh, docW, docH) as any;
    if (!choice) { bitmap.close?.(); return; }   // user 取消
    w = choice.w; h = choice.h;
    imgSmoothing = choice.mode === "nearest" ? "low" : "high";
  }
  // 新建空层
  const layer = doc.addLayer(file.name.replace(/\.[^.]+$/, ""));
  if (!layer) {
    bitmap.close?.();
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
  layer.ctx = c.getContext("2d", { willReadFrequently: false });
  layer.ctx.imageSmoothingEnabled = imgSmoothing !== "low";
  layer.ctx.imageSmoothingQuality = imgSmoothing;
  // 缩小且非 nearest（像素画保持硬边）→ step-halving 抗锯齿；否则原样画
  const lsrc = (imgSmoothing !== "low" && (w < ow || h < oh)) ? smartResample(bitmap, w, h) : bitmap;
  layer.ctx.drawImage(lsrc, 0, 0, w, h);
  bitmap.close?.();
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
      doc.selection = sel;
      setTool("lasso");
      const ok = input.lasso.liftSelectionForTransform(layer);
      if (ok) {
        editMode.enterTransient("transform", { apply: _commitTransform, abort: _cancelTransform });
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

export function initImportImage(ctx: any) {
  doc = ctx.doc;
  board = ctx.board;
  input = ctx.input;
  editMode = ctx.editMode;
  setStatus = ctx.setStatus;
  updateSaveStatus = ctx.updateSaveStatus;
  applyCheckerboard = ctx.applyCheckerboard;
  renderLayersPanel = ctx.renderLayersPanel;
  setGalleryOpen = ctx.setGalleryOpen;
  uniqueLocalName = ctx.uniqueLocalName;

  // 图层面板「导入图片」按钮 → file picker（强制叠层，复位 _addImportAsNewDoc）。
  document.getElementById("layerImportPhotoBtn")?.addEventListener("click", _openImagePicker);

  // file-input plumbing：按文件类型分流（.ora→adopt / image→As{NewDoc|Layer}）。
  els.oraFileInput.addEventListener("change", async (e: any) => {
    const file = e.target.files && e.target.files[0];
    // 图库里"导入照片"语义：把照片当新 doc 打底（不是叠到当前）
    const asNewDoc = _addImportAsNewDoc;
    _addImportAsNewDoc = false;
    if (!file) return;
    const isOra = /\.ora$/i.test(file.name);
    const isImage = (file.type || "").startsWith("image/");
    try {
      if (isOra) {
        const loaded = await decodeOraToDoc(file);
        const nm = file.name.replace(/\.ora$/i, "") || "未命名";
        session.adopt(loaded, nm);
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
    } catch (err: any) {
      console.warn("[import] failed:", err);
      setStatus("导入失败：" + (err && err.message || err));
    }
  });

  // v156 桌面拖拽图片到画布 → 导入为新层（落点 = 拖放位置）。external image = new layer 语义。
  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault();   // 允许 drop
  });
  window.addEventListener("drop", async (e: any) => {
    const files = [...(e.dataTransfer?.files || [])];
    const img = files.find((f: any) => f.type && f.type.startsWith("image/"));
    if (!img) return;                                  // 非图片（如 .ora）不拦，让默认行为
    e.preventDefault();
    if (document.body.dataset.mode === "gallery") { setStatus("退出图库后再拖入图片", true); return; }
    const center = board.screenToDoc(e.clientX, e.clientY);
    try { await importImageAsLayer(img, { center }); }
    catch (err: any) { setStatus(`拖入失败：${err.message || err}`, true); }
  });

  // 图库「导入照片」入口（galleryAddPopup → addImportPhoto）设 _addImportAsNewDoc 经此函数。
  // app.js 的 addImportPhoto 按钮仍直接调 els.oraFileInput.click()，需先 setAddImportAsNewDoc(true)。
}

// 图库「导入照片 / 剪贴板新建」语义切换器：app.js addImportPhoto / addImportClipboard 路径要置 true。
export function setAddImportAsNewDoc(v: boolean) { _addImportAsNewDoc = v; }
