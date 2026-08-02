// v0.8.2 · S2 SelectionFace 行为锁（ADR-0007 ①型退役：选区写面唯一记账口 + 预览 tx 窗口）。
// 守的契约：
//   - beginPreview：write 换预览（旧预览 ≠origin 就地 dispose；write(origin) 合法）；
//     commit 无变化不占 undo 步 / 有变化记账（before=origin 交 op）后 undo/redo 往返；
//     abort 无痕还原 origin、预览产物 dispose；收口后再用 → throw。
//   - commitPreApplied：pre-applied swap 的唯一记账口（undo 回 before）。
import { describe, it, assert, eq } from "./runner.mjs";
import { PaintDoc, flattenLeaves } from "../src/doc.ts";
import { Selection } from "../src/selection.ts";
import { Workpiece } from "../src/workpiece/workpiece.ts";
import { UndoHistory } from "../src/workpiece/undo-history.ts";
import { makeOperators } from "../src/workpiece/operators.ts";
import { SelectionFace } from "../src/workpiece/selection-face.ts";

const _ctxs = [];
function mk() {
  const doc = new PaintDoc({ width: 64, height: 64 });
  const h = new UndoHistory({ maxQuotaBytes: 1 << 30, onUnrecoverable: () => {} });
  const w = new Workpiece(doc, h);
  const ops = makeOperators({ applyDocTransformUi: () => {}, fillColor: { get: () => "#000", set: () => {} } });
  const face = new SelectionFace({ w, doc, history: h, ops });
  _ctxs.push({ doc, h });
  return { doc, w, h, face };
}
const box = (x, y, wd, ht) => {
  const g = new Uint8Array(wd * ht).fill(255);
  return Selection.fromGray8Region(x, y, wd, ht, g);
};

describe("selection-face · 预览 tx", () => {
  it("write 换预览：旧预览就地 dispose、origin 保管；write(origin) 回原选区", () => {
    const { doc, face } = mk();
    const origin = box(0, 0, 4, 4);
    doc.selection = origin;   // 装载态（测试播种）
    const tx = face.beginPreview();
    const p1 = box(0, 0, 8, 8);
    tx.write(p1);
    eq(doc.selection, p1, "预览上台");
    assert(!origin.disposed, "origin 保管不 dispose");
    const p2 = box(2, 2, 8, 8);
    tx.write(p2);
    assert(p1.disposed, "旧预览就地 dispose");
    tx.write(origin);
    eq(doc.selection, origin, "write(origin) 回原选区");
    assert(p2.disposed, "预览产物 dispose");
    tx.abort();   // 收口（已在 origin，无事发生）
    eq(doc.selection, origin, "abort 后仍 origin");
    assert(!origin.disposed, "origin 存活");
  });

  it("commit 无变化 → 不占 undo 步；有变化 → 记账后 undo/redo 往返", () => {
    const { doc, h, w, face } = mk();
    const t0 = face.beginPreview();
    eq(t0.commit().changed, false, "无变化 commit");
    eq(h.depth, 0, "栈未动");
    const tx = face.beginPreview();   // origin = null
    const p = box(0, 0, 6, 6);
    tx.write(p);
    const r = tx.commit();
    assert(r.changed && r.ok, "记账成功");
    eq(h.depth, 1, "一条 entry");
    h.undo(w);
    eq(doc.selection, null, "undo 回 origin(null)");
    assert(!p.disposed, "预览在 redo 包里存活");
    h.redo(w);
    eq(doc.selection, p, "redo 回预览");
  });

  it("abort 无痕还原 origin、预览 dispose；收口后再用 throw", () => {
    const { doc, face } = mk();
    const origin = box(0, 0, 3, 3);
    doc.selection = origin;
    const tx = face.beginPreview();
    const p = box(1, 1, 5, 5);
    tx.write(p);
    tx.abort();
    eq(doc.selection, origin, "还原 origin");
    assert(p.disposed, "预览 dispose");
    let threw = false;
    try { tx.write(null); } catch { threw = true; }
    assert(threw, "收口后 write throw");
  });
});

describe("selection-face · commitPreApplied", () => {
  it("pre-applied swap 记账：undo 回 before", () => {
    const { doc, h, w, face } = mk();
    const before = box(0, 0, 4, 4);
    doc.selection = before;
    const after = box(0, 0, 9, 9);
    doc.selection = after;   // 引擎已换好（entry 契约形态）
    const st = face.commitPreApplied(before);
    assert(st.ok, "记账 ok");
    h.undo(w);
    eq(doc.selection, before, "undo 回 before");
    h.redo(w);
    eq(doc.selection, after, "redo 回 after");
  });
});

// 测试卫生：清栈释放（栈内 Selection 由 op disposeData 处理）
describe("selection-face 收尾", () => {
  it("清栈并释放 doc tiles/selection", () => {
    for (const { doc, h } of _ctxs) {
      h.clear();
      doc.selection?.dispose?.();
      doc.selection = null;
      for (const leaf of flattenLeaves(doc.layers)) leaf.pixels?.dispose?.();
    }
    _ctxs.length = 0;
    assert(true, "disposed");
  });
});
