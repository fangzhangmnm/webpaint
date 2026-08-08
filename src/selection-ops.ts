// 职责（单一）：选区 → 剪贴板 / 复制为浮层 / 提取选区像素。
//   - _extractSelectionRegionCanvas：当前层 ∩ 选区 → 裁好形状的 canvas（纯函数）。
//   - selectionToNewLayer({move})：选区像素抽成新层（复制 / 移动），含 undo 记账。导出供 toolbar 等模块用。
//   - _makeFullLayerSelection：给整层做全白 mask 当 selection（导入图片后自动全选用）。导出供 app.js import 流程用。
//   - v156 剪贴板 / 复制为浮层 快捷键：wp:copy / wp:paste / wp:duplicateFloat 三个 window 事件的逻辑。
//     入口在 input.js KEYBOARD_SHORTCUTS（hub）；run 派发 window 事件，逻辑搬到这（要 doc/import/setColor）。
//     Ctrl+T 直接复用 lassoTransformBtn.click()，不在此。Ctrl+C/V 仅走系统剪贴板，无内部 buffer / token。
import { readImageFromClipboard, writeImageBlobToClipboard } from "./session.ts";
import { Selection } from "./selection.ts";
import { disposeLayerSnap, type LayerSnap } from "./doc.ts";
import { countViewLeaves } from "./workpiece/painting-view.ts";
import { requireEditableLeaf } from "./editable-leaf.ts";
import { reportError } from "./error-badge.ts";
import { updateLassoToolbar } from "./toolbar.ts";
import { t } from "./i18n/index.ts";
import type { AppContext } from "./app-context.ts";

// 错误信息提取（catch 子句 e 在 strict 下是 unknown）。
const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e);

// doc 活层 / Selection 的最小结构（doc/selection.js 未类型化 → 只描述本文件用到的几何字段）。
interface LayerLike { bboxX: number; bboxY: number; bboxW: number; bboxH: number; canvas: CanvasImageSource; }
// （v0.4.6：Selection.maskCanvas 死 → 本文件 Canvas2D 合成走 materializeMaskCanvas() 物化缓存）
interface TransientOpts { apply?: () => void; abort?: () => void; }

// app 单例 / 跨模块函数（initSelectionOps 注入）
let doc: AppContext["doc"], board: AppContext["board"], input: AppContext["input"];
let editMode: AppContext["editMode"], history: AppContext["history"];
let workpiece: AppContext["workpiece"];
let setStatus: AppContext["setStatus"], _afterDocChange: AppContext["afterDocChange"];
let _commitTransform: AppContext["_commitTransform"], _cancelTransform: AppContext["_cancelTransform"], _suppressTransientPanels: AppContext["_suppressTransientPanels"];
let importImageAsLayer: AppContext["importImageAsLayer"];

// 当前层 ∩ 选区（无交集 → null）→ 裁好选区形状的离屏 canvas（仅剪贴板 PNG 编码用——
// v0.6.41 去 canvas 化：像素在字节里裁好，canvas 只在编码边界包一次、不回流画作）。
function _extractSelectionRegionCanvas(layer: LayerLike, sel: Selection) {
  const lbX = layer.bboxX, lbY = layer.bboxY, lbW = layer.bboxW, lbH = layer.bboxH;
  const x0 = Math.max(lbX, sel.bboxX), y0 = Math.max(lbY, sel.bboxY);
  const x1 = Math.min(lbX + lbW, sel.bboxX + sel.bboxW), y1 = Math.min(lbY + lbH, sel.bboxY + sel.bboxH);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const img = (layer as unknown as { getImageData: (x: number, y: number, w: number, h: number) => ImageData }).getImageData(x0, y0, w, h);
  const mask = sel.materializeMaskRegion(x0, y0, w, h);
  for (let i = 0; i < w * h; i++) img.data[i * 4 + 3] = Math.round(img.data[i * 4 + 3] * mask[i] / 255);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d")!.putImageData(img, 0, 0);
  return c;
}

// 选区 → 新层。move=true 同时从源层挖洞（移动语义）。undo = compound(addLayer 记录 + 源层 pixels swap)：
//   compound 倒序回放 → undo 先还原源层像素、再摘掉新层 + active 回到源层（与旧 selectionToLayer entry 语义一致）。
export function selectionToNewLayer({ move }: { move: boolean }) {
  const sel = doc.selection;
  if (!sel) { setStatus(t("se.noSelection")); return; }
  if (countViewLeaves(doc.layers) >= doc.maxLayers) { setStatus(t("se.maxLayersReached", { max: doc.maxLayers })); return; }
  const src = doc.activeLayer;
  if (!src) return;
  if (src.isGroup) { setStatus(t("se.selectLayerFirstGroup")); return; }
  // v0.8.1（S1）：加层走 workpiece.layers 门面（创建即记账，prevActiveId 自动拍 = 当前 active = src）。
  // compound 把 [addLayer, pixels] 封成一个整点：undo 先还原源层像素、再摘掉新层 + active 回源层。
  // v0.8.2（S2）：move 挖洞走 pixelHistory 事务（before 快照/入栈收进 tx；挖洞前 begin）。
  const r = history.compound(workpiece, () => {
    const a = workpiece.layers.addLayer(move ? "移到新层" : "复制层", { checkpoint: false });
    if (!a.ok) throw new Error(a.msg);
    const newL = a.layer;
    // 把 active ∩ selection 的像素 copy 进 newL（v0.6.41 全字节：tiles 直读 → alpha×mask → 直落 tile）
    const region = src.getImageData(sel.bboxX, sel.bboxY, sel.bboxW, sel.bboxH);
    const selMask = sel.materializeMaskRegion(sel.bboxX, sel.bboxY, sel.bboxW, sel.bboxH);
    for (let i = 0; i < sel.bboxW * sel.bboxH; i++) region.data[i * 4 + 3] = Math.round(region.data[i * 4 + 3] * selMask[i] / 255);
    newL.replaceFromBytes(region.data, sel.bboxX, sel.bboxY, sel.bboxW, sel.bboxH);
    if (move) {
      // 从源层挖洞（dst-out 选区形状：alpha 衰减、RGB 保留）。v2（T2）：compound 的令牌开着，
      // 换手由 LayerTiles collector 写时扣押——不再需要 pixelHistory 事务（空挖 = 零换手 = 零记账）。
      src.editRegionBytes(sel.bboxX, sel.bboxY, sel.bboxW, sel.bboxH, (buf) => {
        for (let i = 0; i < sel.bboxW * sel.bboxH; i++) {
          if (selMask[i]) buf[i * 4 + 3] = Math.round(buf[i * 4 + 3] * (255 - selMask[i]) / 255);
        }
      });
    }
  });
  if (!r.ok) { setStatus(errMsg(r.msg), true); _afterDocChange(); return; }
  _afterDocChange();
  setStatus(move ? t("se.movedToNewLayer") : t("se.copiedToNewLayer"));
}

// （_makeFullLayerSelection 已删 v0.4.7：唯一调用方 import-image 改走 lift 的 fallbackFullLayer——
//   隐式全选在 LiftFloatOp 内部构造，不再手写 doc.selection。）

export function initSelectionOps(ctx: AppContext) {
  doc = ctx.doc;
  board = ctx.board;
  input = ctx.input;
  editMode = ctx.editMode;
  history = ctx.history;
  workpiece = ctx.workpiece;
  setStatus = ctx.setStatus;
  _afterDocChange = ctx.afterDocChange;
  _commitTransform = ctx._commitTransform;
  _cancelTransform = ctx._cancelTransform;
  _suppressTransientPanels = ctx._suppressTransientPanels;
  importImageAsLayer = ctx.importImageAsLayer;

  // Ctrl+C：当前层 ∩ 选区（无选区 → 整层）→ 系统剪贴板 PNG
  window.addEventListener("wp:copy", async () => {
    const layer = requireEditableLeaf(doc, setStatus) as LayerLike | null;   // 组 → 标准状态行（组 composite 复制是后话，先拒）
    if (!layer) return;
    let canvas;
    if (doc.selection) {
      canvas = _extractSelectionRegionCanvas(layer, doc.selection as unknown as Selection);
      if (!canvas) { setStatus(t("se.selectionOutsideLayer"), true); return; }
    } else {
      if (layer.bboxW <= 0 || layer.bboxH <= 0) { setStatus(t("se.layerEmpty"), true); return; }
      canvas = document.createElement("canvas");
      canvas.width = layer.bboxW; canvas.height = layer.bboxH;
      canvas.getContext("2d")!.drawImage(layer.canvas, 0, 0);
    }
    try {
      // lazy promise：blob 生成放进 ClipboardItem，保 Safari user-gesture
      await writeImageBlobToClipboard(new Promise<Blob>((res) => canvas.toBlob(res as BlobCallback, "image/png")));
      setStatus(doc.selection ? t("se.copiedSelectionToClipboard") : t("se.copiedLayerToClipboard"));
    } catch (e) {
      reportError(new Error(t("se.copyFailed", { error: errMsg(e) })), "warning");   // #34：iPad 剪贴板权限被拒走 banner
    }
  });
  // Ctrl+V：系统剪贴板图 → 新层，视口居中（复用 importImageAsLayer）
  window.addEventListener("wp:paste", async () => {
    let blob;
    try { blob = await readImageFromClipboard(); }
    catch (e) { reportError(new Error(t("se.clipboardReadFailed", { error: errMsg(e) })), "warning"); return; }   // #34
    if (!blob) { setStatus(t("se.clipboardNoImage"), true); return; }
    const file = new File([blob], "paste.png", { type: blob.type || "image/png" });
    const r = board.canvas.getBoundingClientRect();
    const center = board.screenToDoc(r.left + r.width / 2, r.top + r.height / 2);
    await importImageAsLayer(file, { center });
  });
  // Ctrl+D：当前选区 → 原位浮层（不挖洞）= 非破坏性 lift + transform
  window.addEventListener("wp:duplicateFloat", () => {
    if (editMode.current() === "fill") { setStatus(t("fm.noTransform"), true); return; }   // v0.6.24：fill 不 lift（半定义态审计#10）
    if (input.lasso.hasFloating()) return;
    if (!doc.selection) { setStatus(t("se.selectBeforeDuplicateFloat"), true); return; }
    const ok = input.lasso.liftSelectionForTransform(doc.activeLayer, { cut: false });
    if (ok) {
      (editMode.enterTransient as (n: string, o?: TransientOpts) => void)("transform", { apply: _commitTransform, abort: _cancelTransform });
      updateLassoToolbar();
      _suppressTransientPanels("transform");
      board.invalidateAll();
      setStatus(t("se.duplicatedAsFloat"));
    }
  });
}
