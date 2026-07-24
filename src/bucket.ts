// 油漆桶（#22，v0.5 user 拍板的 spec）—— tap 一下 = 「魔棒同款 flood + 一次性填色」深模块。
//
// 语义（三条都是拍板红线）：
//   1. **不碰选区**：不产生、不修改 doc.selection。flood 结果只当一次性 fill mask，用完即弃。
//   2. **被现有选区裁剪**：有选区时填充范围 = flood ∩ doc.selection；无选区 = flood 本身。
//   3. 配置跟文件走（editorState.bucket：threshold / expand toggle / expandPx），与魔棒选区的
//      expand 配置**分开**（editorState.magicWand）。expand 开 = flood 后 Selection.morphed 防漏白。
//
// 复用面：flood 内核 = lasso.ts 的 floodSelectFrom（v242 语义原样）；取样源 = doc.getFloodSourceLayer()
//   （参考层优先——描线稿参考、往别的层上填色的工作流与魔棒一致）；写入 = requireEditableLeaf 谓词
//   把关的活动叶 + Selection.fillOnLayer + 事务型 ops.pixels（可 Ctrl+Z）。
//
// 接线：input.ts 在 role==="bucket" 的 pointerdown 派 window "wp:bucketTap"（doc 坐标）；app.ts initBucket。

import { Selection } from "./selection.ts";
import type { LayerSnap } from "./doc.ts";
import { floodSelectFrom } from "./lasso.ts";
import { requireEditableLeaf } from "./editable-leaf.ts";
import { editorState } from "./workbench-state.ts";
import { t } from "./i18n/index.ts";
import type { AppContext } from "./app-context.ts";

let doc: AppContext["doc"];
let board: AppContext["board"];
let history: AppContext["history"];
let workpiece: AppContext["workpiece"];
let ops: AppContext["ops"];
let state: AppContext["state"];
let setStatus: AppContext["setStatus"];

interface LayerLike {
  id: number;
  snapshot(): LayerSnap;
  canvas: HTMLCanvasElement;
}

function bucketFillAt(x: number, y: number) {
  const layer = requireEditableLeaf(doc, setStatus) as LayerLike | null;   // 组/隐藏/无层 → 标准状态行
  if (!layer) return;
  const cfg = editorState.bucket;
  let mask = floodSelectFrom(doc, { x, y }, doc.getFloodSourceLayer(), cfg.threshold);
  if (!mask) { setStatus(t("bk.nothingToFill")); return; }
  // 自动扩张（防漏白描边）：toggle 开才做；量在详细配置里调（开的默认 1px）
  if (cfg.expand && cfg.expandPx > 0) {
    const m = mask.morphed(cfg.expandPx, doc.width, doc.height);
    if (m) { mask.dispose(); mask = m; }
  }
  // 被现有选区裁剪：∩ doc.selection（compose 只读消费输入——doc.selection 决不 dispose）
  if (doc.selection) {
    const clipped = Selection.compose(doc.selection as Selection, mask, "intersect");
    if (clipped !== mask) mask.dispose();
    if (!clipped || clipped === (doc.selection as Selection)) { setStatus(t("bk.outsideSelection")); return; }
    mask = clipped;
  }
  const before = layer.snapshot();   // 归属转给 ops.pixels（run 之后不许 dispose）——同 lassoFillBtn
  mask.fillOnLayer(layer as unknown as Parameters<Selection["fillOnLayer"]>[0], state.color);
  history.run(workpiece, ops.pixels, { layerId: layer.id, _initialBefore: before });
  mask.dispose();   // 一次性 mask，用完即弃（不碰 doc.selection）
  board.invalidateAll();
  setStatus(t("se.filled", { color: state.color }));
}

export function initBucket(ctx: AppContext) {
  doc = ctx.doc;
  board = ctx.board;
  history = ctx.history;
  workpiece = ctx.workpiece;
  ops = ctx.ops;
  state = ctx.state;
  setStatus = ctx.setStatus;
  window.addEventListener("wp:bucketTap", ((e: CustomEvent<{ x: number; y: number }>) => {
    bucketFillAt(e.detail.x, e.detail.y);
  }) as EventListener);
}
