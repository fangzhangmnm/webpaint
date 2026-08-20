// 职责（单一）：选区 → 剪贴板 / 复制为浮层 / 提取选区像素。
//   - _extractSelectionRegionBytes：当前层 ∩ 选区 → 裁好形状的 straight RGBA 字节（纯函数）。
//   - selectionToNewLayer({move})：选区像素抽成新层（复制 / 移动），含 undo 记账。导出供 toolbar 等模块用。
//   - v156 剪贴板 / 复制为浮层 快捷键：wp:copy / wp:paste / wp:duplicateFloat 等 window 事件的逻辑。
//     入口在 input.ts KEYBOARD_SHORTCUTS（hub）；run 派发 window 事件，逻辑搬到这（要 doc/import/setColor）。
//     Ctrl+T 直接复用 lassoTransformBtn.click()，不在此。剪贴板仅走系统剪贴板，无内部 buffer / token。
//   - v0.9.22 剪贴板正宫化（spec ai-docs/20260819-clipboard-and-local-file-spec.md）：
//     wp:copyMerged（Ctrl+Shift+C / 双击 Ctrl+C 升级）、wp:cut（Ctrl+X）、原生 paste 事件通道
//     （粘贴主通道——clipboardData 免权限弹窗、白送 Shift+Insert；wp:paste 的 clipboard.read()
//     留给按钮入口）。纯策略（双击窗口/护栏）在 clipboard-policy.ts。
import { readImageFromClipboard, writeImageBlobToClipboard, copyImageToClipboard } from "./session.ts";
import { isDoubleCopy } from "./clipboard-policy.ts";
import { encodePngFromBytes } from "./backend/png-codec.ts";
import { Selection } from "./backend/selection.ts";
import { disposeViewSnap as disposeLayerSnap, type ViewLeafSnap as LayerSnap } from "./backend/workpiece/painting-view.ts";
import { countViewLeaves } from "./backend/workpiece/painting-view.ts";
import { requireEditableLeaf } from "./editable-leaf.ts";
import { reportError } from "./error-badge.ts";
import { updateLassoToolbar } from "./toolbar.ts";
import { t } from "./i18n/index.ts";
import type { AppContext } from "./app-context.ts";

// 错误信息提取（catch 子句 e 在 strict 下是 unknown）。
const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e);

// doc 活层的最小结构（只描述本文件用到的读/写面；像素全走字节口）。
interface LayerLike {
  bboxX: number; bboxY: number; bboxW: number; bboxH: number;
  getImageData(x: number, y: number, w: number, h: number): ImageData;
  editRegionBytes(x: number, y: number, w: number, h: number, fn: (buf: Uint8ClampedArray) => void): void;
}
interface TransientOpts { apply?: () => void; abort?: () => void; }

// app 单例 / 跨模块函数（initSelectionOps 注入）
let doc: AppContext["doc"], board: AppContext["board"], input: AppContext["input"];
let editMode: AppContext["editMode"], history: AppContext["history"], layers: AppContext["layers"];

let setStatus: AppContext["setStatus"], _afterDocChange: AppContext["afterDocChange"];
let _commitTransform: AppContext["_commitTransform"], _cancelTransform: AppContext["_cancelTransform"], _suppressTransientPanels: AppContext["_suppressTransientPanels"];
let importImageAsLayer: AppContext["importImageAsLayer"];
let isMidOperation: AppContext["isMidOperation"];

// 当前层 ∩ 选区（无交集 → null）→ 裁好选区形状的 straight RGBA 字节（仅剪贴板 PNG 编码用——
// C3 债 b：编码走 encodePngFromBytes，全程零 canvas、零 premult 往返）。
function _extractSelectionRegionBytes(layer: LayerLike, sel: Selection): { data: Uint8ClampedArray; w: number; h: number } | null {
  const lbX = layer.bboxX, lbY = layer.bboxY, lbW = layer.bboxW, lbH = layer.bboxH;
  const x0 = Math.max(lbX, sel.bboxX), y0 = Math.max(lbY, sel.bboxY);
  const x1 = Math.min(lbX + lbW, sel.bboxX + sel.bboxW), y1 = Math.min(lbY + lbH, sel.bboxY + sel.bboxH);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const img = layer.getImageData(x0, y0, w, h);
  const mask = sel.materializeMaskRegion(x0, y0, w, h);
  for (let i = 0; i < w * h; i++) img.data[i * 4 + 3] = Math.round(img.data[i * 4 + 3] * mask[i] / 255);
  return { data: img.data, w, h };
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
  // v0.8.1（S1）：加层走 ctx.layers 门面（创建即记账，prevActiveId 自动拍 = 当前 active = src）。
  // compound 把 [addLayer, pixels] 封成一个整点：undo 先还原源层像素、再摘掉新层 + active 回源层。
  // v0.8.2（S2→T5）：move 挖洞在同一 withPoint 令牌内，tile 换手由 LayerTiles 写时扣押。
  const r = history.withPoint(move ? "moveToNewLayer" : "copyToNewLayer", {}, () => {
    const a = layers.addLayer(move ? t("name.moveToNewLayer") : t("name.copyLayer"), { checkpoint: false });
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
//   隐式全选在 lift 编排内部构造，不再手写 doc.selection。）

export function initSelectionOps(ctx: AppContext) {
  doc = ctx.doc;
  board = ctx.board;
  input = ctx.input;
  editMode = ctx.editMode;
  history = ctx.history;
  layers = ctx.layers;
  setStatus = ctx.setStatus;
  _afterDocChange = ctx.afterDocChange;
  _commitTransform = ctx._commitTransform;
  _cancelTransform = ctx._cancelTransform;
  _suppressTransientPanels = ctx._suppressTransientPanels;
  importImageAsLayer = ctx.importImageAsLayer;
  isMidOperation = ctx.isMidOperation;

  // 提取「本次要复制的字节」：当前层 ∩ 选区（无选区 → 整层）。copy 和 cut 共用；失败已报状态行。
  const grabActiveLayerBytes = (): { layer: LayerLike; px: { data: Uint8ClampedArray; w: number; h: number } } | null => {
    const layer = requireEditableLeaf(doc, setStatus) as LayerLike | null;   // 组 → 标准状态行（组 composite 复制是后话，先拒）
    if (!layer) return null;
    let px: { data: Uint8ClampedArray; w: number; h: number } | null;
    if (doc.selection) {
      px = _extractSelectionRegionBytes(layer, doc.selection as unknown as Selection);
      if (!px) { setStatus(t("se.selectionOutsideLayer"), true); return null; }
    } else {
      if (layer.bboxW <= 0 || layer.bboxH <= 0) { setStatus(t("se.layerEmpty"), true); return null; }
      px = { data: layer.getImageData(layer.bboxX, layer.bboxY, layer.bboxW, layer.bboxH).data, w: layer.bboxW, h: layer.bboxH };
    }
    return { layer, px };
  };
  // lazy promise：blob 生成放进 ClipboardItem，保 Safari user-gesture
  const writePngBytes = (px: { data: Uint8ClampedArray; w: number; h: number }) =>
    writeImageBlobToClipboard(encodePngFromBytes(px.data, px.w, px.h).then((png) => new Blob([png as BlobPart], { type: "image/png" })));

  // Ctrl+C：当前层 ∩ 选区（无选区 → 整层）→ 系统剪贴板 PNG。
  // v0.9.22 双击升级（human 拍板）：短窗内第二次 = 合并复制覆写（第一下已照常入剪贴板，无丢失）。
  let _lastCopyAt = 0;
  window.addEventListener("wp:copy", async () => {
    const now = Date.now();
    const dbl = isDoubleCopy(_lastCopyAt, now);
    _lastCopyAt = now;
    if (dbl) { window.dispatchEvent(new CustomEvent("wp:copyMerged")); return; }
    // v0.9.26（user 真机反馈 2026-08-20：「float 没落地的时候 ctrl c 无反应」）：按决定性动作惯例
    //   （saveNow/导入收口同款）先 commit 悬着的 transform 再复制——用户按 Ctrl+C 的意图是"拿走现在看到的"。
    if (editMode.hasPendingTransient()) editMode.applyPendingTransient();
    const got = grabActiveLayerBytes();
    if (!got) return;
    try {
      await writePngBytes(got.px);
      setStatus(doc.selection ? t("se.copiedSelectionToClipboard") : t("se.copiedLayerToClipboard"));
    } catch (e) {
      reportError(new Error(t("se.copyFailed", { error: errMsg(e) })), "warning");   // #34：iPad 剪贴板权限被拒走 banner
    }
  });
  // Ctrl+Shift+C / 双击 Ctrl+C：合并复制——合成图 ∩ 选区 mask（无选区 = 整张合成图）。
  // 零配置直出透明 PNG（不吃导出菜单 defringe/bg 配置——快捷键是反射动作，配置留给导出菜单）。
  window.addEventListener("wp:copyMerged", async () => {
    if (editMode.hasPendingTransient()) editMode.applyPendingTransient();   // 浮层先落地：合成里才有它（v0.9.26）
    const sel = doc.selection as unknown as Selection | null;
    const rect = sel ? { x: sel.bboxX, y: sel.bboxY, w: sel.bboxW, h: sel.bboxH } : null;
    const mask = sel ? sel.materializeMaskRegion(sel.bboxX, sel.bboxY, sel.bboxW, sel.bboxH) : null;
    try {
      await copyImageToClipboard(doc as unknown as Parameters<typeof copyImageToClipboard>[0], "merged", rect, false, "transparent", mask);
      setStatus(sel ? t("se.copiedMergedSelectionToClipboard") : t("se.copiedMergedToClipboard"));
    } catch (e) {
      reportError(new Error(t("se.copyFailed", { error: errMsg(e) })), "warning");
    }
  });
  // Ctrl+X：剪切 = 复制 + 从活层擦除（选区形状 dst-out；无选区 = 清整层 bbox）。一次 undo。
  // 复制失败就不擦——剪切绝不许退化成纯删除（数据安全词典序）。
  window.addEventListener("wp:cut", async () => {
    if (editMode.hasPendingTransient()) editMode.applyPendingTransient();   // 浮层先落地再剪（v0.9.26，同 Ctrl+C）
    const got = grabActiveLayerBytes();
    if (!got) return;
    try { await writePngBytes(got.px); }
    catch (e) { reportError(new Error(t("se.copyFailed", { error: errMsg(e) })), "warning"); return; }
    const sel = doc.selection as unknown as Selection | null;
    const layer = got.layer;
    const r = history.withPoint("cutClip", {}, () => {
      if (sel) {
        sel.clearOnLayer(layer as unknown as Parameters<Selection["clearOnLayer"]>[0]);
      } else {
        layer.editRegionBytes(layer.bboxX, layer.bboxY, layer.bboxW, layer.bboxH, (buf) => {
          for (let i = 3; i < buf.length; i += 4) buf[i] = 0;
        });
      }
    });
    if (!r.ok) { setStatus(errMsg(r.msg), true); return; }
    board.invalidateAll();
    setStatus(sel ? t("se.cutSelectionToClipboard") : t("se.cutLayerToClipboard"));
  });
  // 粘贴共用落点：blob → 新层，视口居中（复用 importImageAsLayer；新层 + 自动进 transform）
  const pasteBlobAsLayer = async (blob: Blob) => {
    const file = new File([blob], "paste.png", { type: blob.type || "image/png" });
    const r = board.canvas.getBoundingClientRect();
    const center = board.screenToDoc(r.left + r.width / 2, r.top + r.height / 2);
    await importImageAsLayer(file, { center });
  };
  // 按钮入口（图层面板「导入剪贴板」/ lasso ⋯）：click 不产生原生 paste 事件 → 主动 clipboard.read()
  window.addEventListener("wp:paste", async () => {
    let blob;
    try { blob = await readImageFromClipboard(); }
    catch (e) { reportError(new Error(t("se.clipboardReadFailed", { error: errMsg(e) })), "warning"); return; }   // #34
    if (!blob) { setStatus(t("se.clipboardNoImage"), true); return; }
    await pasteBlobAsLayer(blob);
  });
  // v0.9.22 粘贴主通道 = 原生 paste 事件（spec：clipboardData 免权限弹窗；覆盖 Ctrl+V/Shift+Insert/
  // iPad 三指捏合粘贴）。input.ts 的 Ctrl+V 表项改 display-only——keydown preventDefault 会杀掉本事件。
  window.addEventListener("paste", (e: ClipboardEvent) => {
    // 真文本输入里让原生粘贴走（同 input.ts _keydown 的豁免口径，v0.5.5）
    const tgt = e.target as HTMLElement | null;
    if (tgt) {
      const tag = tgt.tagName;
      const type = (tgt as HTMLInputElement).type;
      if (tag === "TEXTAREA" || (tag === "INPUT" && type !== "range" && type !== "checkbox" && type !== "radio" && type !== "button") || tgt.isContentEditable) return;
    }
    if (document.body.dataset.mode === "gallery") return;    // 图库有自己的「从剪切板新建」入口
    if (isMidOperation()) return;                            // iPad 三指误触护栏：笔画/变换拖动中不收
    const items = e.clipboardData?.items;
    let f: File | null = null;
    if (items) for (const it of items) { if (it.kind === "file" && it.type.startsWith("image/")) { f = it.getAsFile(); if (f) break; } }
    if (!f) { setStatus(t("se.clipboardNoImage"), true); return; }
    e.preventDefault();
    void pasteBlobAsLayer(f).catch((err) => reportError(new Error("[paste] import failed: " + String(err)), "warning"));
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
