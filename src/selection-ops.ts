// 职责（单一）：选区 → 剪贴板 / 复制为浮层 / 提取选区像素。
//   - _extractSelectionRegionCanvas：当前层 ∩ 选区 → 裁好形状的 canvas（纯函数）。
//   - selectionToNewLayer({move})：选区像素抽成新层（复制 / 移动），含 undo 记账。导出供 toolbar 等模块用。
//   - _makeFullLayerSelection：给整层做全白 mask 当 selection（导入图片后自动全选用）。导出供 app.js import 流程用。
//   - v156 剪贴板 / 复制为浮层 快捷键：wp:copy / wp:paste / wp:duplicateFloat 三个 window 事件的逻辑。
//     入口在 input.js KEYBOARD_SHORTCUTS（hub）；run 派发 window 事件，逻辑搬到这（要 doc/import/setColor）。
//     Ctrl+T 直接复用 lassoTransformBtn.click()，不在此。Ctrl+C/V 仅走系统剪贴板，无内部 buffer / token。
import { readImageFromClipboard, writeImageBlobToClipboard } from "./session.js";
import { Selection } from "./selection.js";
import { countLeaves } from "./doc.js";
import { compressPixelSnap } from "./pixel-edit.js";
import { requireEditableLeaf } from "./editable-leaf.ts";
import { updateLassoToolbar } from "./toolbar.ts";

// app 单例 / 跨模块函数（initSelectionOps 注入）
let doc: any, board: any, input: any, editMode: any, history: any;
let setStatus: any, layerSpecFrom: any, _afterDocChange: any;
let _commitTransform: any, _cancelTransform: any, _suppressTransientPanels: any;
let importImageAsLayer: any;

// 当前层 ∩ 选区（无交集 → null）→ 裁好选区形状的离屏 canvas
function _extractSelectionRegionCanvas(layer, sel) {
  const lbX = layer.bboxX, lbY = layer.bboxY, lbW = layer.bboxW, lbH = layer.bboxH;
  const x0 = Math.max(lbX, sel.bboxX), y0 = Math.max(lbY, sel.bboxY);
  const x1 = Math.min(lbX + lbW, sel.bboxX + sel.bboxW), y1 = Math.min(lbY + lbH, sel.bboxY + sel.bboxH);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const cx = c.getContext("2d");
  cx.drawImage(layer.canvas, x0 - lbX, y0 - lbY, w, h, 0, 0, w, h);
  cx.globalCompositeOperation = "destination-in";   // 裁到选区形状
  cx.drawImage(sel.maskCanvas, sel.bboxX - x0, sel.bboxY - y0);
  cx.globalCompositeOperation = "source-over";
  return c;
}

// 选区 → 新层。move=true 同时从源层挖洞（移动语义），含 undo 记账。
export function selectionToNewLayer({ move }) {
  const sel = doc.selection;
  if (!sel) { setStatus("没选区"); return; }
  if (countLeaves(doc.layers) >= doc.maxLayers) { setStatus(`图层数已达上限 ${doc.maxLayers}`); return; }
  const src = doc.activeLayer;
  if (!src) return;
  if (src.isGroup) { setStatus("请先选择一个图层（组不能这样操作）"); return; }
  const beforeActive = move ? src.snapshot() : null;
  const newL = doc.addLayer(move ? "移到新层" : "复制层");
  if (!newL) return;
  // 把 newL 的 bbox / canvas 重设为 selection bbox
  newL.bboxX = sel.bboxX;
  newL.bboxY = sel.bboxY;
  newL.bboxW = sel.bboxW;
  newL.bboxH = sel.bboxH;
  newL.canvas.width = sel.bboxW;
  newL.canvas.height = sel.bboxH;
  newL.ctx = newL.canvas.getContext("2d", { willReadFrequently: false });
  newL.ctx.imageSmoothingEnabled = true;
  newL.ctx.imageSmoothingQuality = "low";
  // 把 active ∩ selection 的像素 copy 进 newL
  newL.ctx.drawImage(src.canvas, src.bboxX - sel.bboxX, src.bboxY - sel.bboxY);
  newL.ctx.globalCompositeOperation = "destination-in";
  newL.ctx.drawImage(sel.maskCanvas, 0, 0);
  newL.ctx.globalCompositeOperation = "source-over";
  if (move) {
    src.ctx.save();
    src.ctx.globalCompositeOperation = "destination-out";
    src.ctx.drawImage(sel.maskCanvas, sel.bboxX - src.bboxX, sel.bboxY - src.bboxY);
    src.ctx.restore();
  }
  const loc = doc.locateNode(newL.id);   // {parentId, index}：组内也精确（撤销 insertLayerAt 用）
  const newLayerSpec = layerSpecFrom(newL);
  const afterActive = move ? src.snapshot() : null;
  history.push({
    type: "selectionToLayer",
    isMove: move,
    newLayerSpec, insertIndex: loc.index, parentId: loc.parentId,
    activeLayerId: src.id,
    beforeActive, afterActive,
  });
  // 异步压缩 newL pixels（同 removeLayer 路径）
  compressPixelSnap(newLayerSpec, (blob) => { newLayerSpec.blob = blob; });
  if (move && beforeActive) compressPixelSnap(beforeActive, (blob) => { beforeActive.blob = blob; });
  if (move && afterActive)  compressPixelSnap(afterActive,  (blob) => { afterActive.blob = blob; });
  _afterDocChange();
  setStatus(move ? "已移到新层" : "已复制到新层");
}

// v111: 给 layer 当前 bbox 做一个全白 mask 当 selection（占满整个 layer 像素）
export function _makeFullLayerSelection(layer) {
  return Selection.full(layer.bboxW, layer.bboxH, layer.bboxX, layer.bboxY);
}

export function initSelectionOps(ctx) {
  doc = ctx.doc;
  board = ctx.board;
  input = ctx.input;
  editMode = ctx.editMode;
  history = ctx.history;
  setStatus = ctx.setStatus;
  layerSpecFrom = ctx.layerSpecFrom;
  _afterDocChange = ctx.afterDocChange;
  _commitTransform = ctx._commitTransform;
  _cancelTransform = ctx._cancelTransform;
  _suppressTransientPanels = ctx._suppressTransientPanels;
  importImageAsLayer = ctx.importImageAsLayer;

  // Ctrl+C：当前层 ∩ 选区（无选区 → 整层）→ 系统剪贴板 PNG
  window.addEventListener("wp:copy", async () => {
    const layer = requireEditableLeaf(doc, setStatus);   // 组 → 标准状态行（组 composite 复制是后话，先拒）
    if (!layer) return;
    let canvas;
    if (doc.selection) {
      canvas = _extractSelectionRegionCanvas(layer, doc.selection);
      if (!canvas) { setStatus("选区在图层外，无内容可复制", true); return; }
    } else {
      if (layer.bboxW <= 0 || layer.bboxH <= 0) { setStatus("当前图层为空", true); return; }
      canvas = document.createElement("canvas");
      canvas.width = layer.bboxW; canvas.height = layer.bboxH;
      canvas.getContext("2d").drawImage(layer.canvas, 0, 0);
    }
    try {
      // lazy promise：blob 生成放进 ClipboardItem，保 Safari user-gesture
      await writeImageBlobToClipboard(new Promise((res) => canvas.toBlob(res, "image/png")));
      setStatus(doc.selection ? "已复制选区到剪贴板" : "已复制当前图层到剪贴板");
    } catch (e) {
      setStatus(`复制失败：${e.message || e}`, true);
    }
  });
  // Ctrl+V：系统剪贴板图 → 新层，视口居中（复用 importImageAsLayer）
  window.addEventListener("wp:paste", async () => {
    let blob;
    try { blob = await readImageFromClipboard(); }
    catch (e) { setStatus(`读取剪贴板失败：${e.message || e}`, true); return; }
    if (!blob) { setStatus("剪贴板里没有图片", true); return; }
    const file = new File([blob], "paste.png", { type: blob.type || "image/png" });
    const r = board.canvas.getBoundingClientRect();
    const center = board.screenToDoc(r.left + r.width / 2, r.top + r.height / 2);
    await importImageAsLayer(file, { center });
  });
  // Ctrl+D：当前选区 → 原位浮层（不挖洞）= 非破坏性 lift + transform
  window.addEventListener("wp:duplicateFloat", () => {
    if (input.lasso.hasFloating()) return;
    if (!doc.selection) { setStatus("先框选再 Ctrl+D 复制为浮层", true); return; }
    const ok = input.lasso.liftSelectionForTransform(doc.activeLayer, { cut: false });
    if (ok) {
      editMode.enterTransient("transform", { apply: _commitTransform, abort: _cancelTransform });
      updateLassoToolbar();
      _suppressTransientPanels("transform");
      board.invalidateAll();
      setStatus("已复制选区为浮层（拖动定位 → 应用 / 取消）");
    }
  });
}
