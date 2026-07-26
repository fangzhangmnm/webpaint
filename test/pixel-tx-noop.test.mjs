// PixelTx no-op 守卫（v0.6.17，user：笔/滤镜笔/形状笔画下去若画布无任何实质变化，不占 undo 步）。
// 谓词 = LayerPixels.snapshotEquals：tile 句柄图与 before 逐格同 id ⇔ 没写过（CoW 纪律）。
// 三支笔 + 液化全走 PixelTx.commit 这一个 choke point，这里在事务层直测。
import { describe, it, assert, eq } from "./runner.mjs";
import { PaintDoc, flattenLeaves } from "../src/doc.ts";
import { disposePixelsSnapshot } from "../src/tiles/tile-layer.ts";
import { Workpiece } from "../src/workpiece/workpiece.ts";
import { UndoHistory } from "../src/workpiece/undo-history.ts";
import { makeOperators } from "../src/workpiece/operators.ts";
import { PixelEdits } from "../src/workpiece/pixel-tx.ts";

// 测试卫生：统一释放（防 tile-pool FR 泄漏 assert 刷屏；见 shape-brush.test.mjs 同款）
const _ctxs = [];
function mk() {
  const doc = new PaintDoc({ width: 512, height: 512 });
  const w = new Workpiece(doc);
  const h = new UndoHistory({ maxQuotaBytes: 1 << 30 });
  const ops = makeOperators({ applyDocTransformUi: () => {} });
  const edits = new PixelEdits({ doc, w, history: h, ops });
  _ctxs.push({ doc, h });
  return { doc, w, h, edits };
}
const px = (r, g, b, a) => new Uint8ClampedArray([r, g, b, a]);

describe("PixelTx no-op 守卫（空笔画不进 undo history）", () => {
  it("begin → 一个像素都没写 → commit 返 false、栈不长（画布外整笔的形态）", () => {
    const { doc, h, edits } = mk();
    const L = doc.activeLayer;
    const tx = edits.begin(L, "空笔");
    eq(tx.commit(), false, "no-op commit 返 false");
    eq(h.canUndo(), false, "★不占 undo 步");
  });

  it("擦空白区（写全透明到本就没 tile 的格）→ 仍是 no-op", () => {
    const { doc, h, edits } = mk();
    const L = doc.activeLayer;
    const tx = edits.begin(L, "擦空白");
    L.pixels.putRegion(100, 100, 1, 1, px(0, 0, 0, 0));   // 全透明写入：_setTileBuf bbox=null → 不建格
    eq(tx.commit(), false, "透明写空白区 = 无实质变化");
    eq(h.canUndo(), false, "★不占 undo 步");
  });

  it("真写了像素 → 正常入栈，undo 可还原（守卫不误伤）", () => {
    const { doc, w, h, edits } = mk();
    const L = doc.activeLayer;
    const tx = edits.begin(L, "真笔");
    L.pixels.putRegion(10, 10, 1, 1, px(9, 9, 9, 255));
    eq(tx.commit(), true, "真变化照常入栈");
    eq(h.canUndo(), true, "占一步");
    h.undo(w);
    eq(L.sampleAt(10, 10)[3], 0, "undo 还原");
  });

  it("写后又擦回原样（同格换了句柄）→ 按现约定仍入栈（字节比对刻意不做，诚实交代）", () => {
    const { doc, h, edits } = mk();
    const L = doc.activeLayer;
    L.pixels.putRegion(10, 10, 1, 1, px(1, 2, 3, 255));
    const tx = edits.begin(L, "写又擦");
    L.pixels.putRegion(11, 10, 1, 1, px(9, 9, 9, 255));
    L.pixels.putRegion(11, 10, 1, 1, px(0, 0, 0, 0));    // 同 tile 擦回 → 新句柄、字节等价
    eq(tx.commit(), true, "句柄变了就入栈（O(tiles) 结构比较，不做逐字节）");
  });

  it("snapshotEquals：restore 的 acquire 副本同 id → 等价；写入换句柄 → 不等价", () => {
    const { doc } = mk();
    const L = doc.activeLayer;
    L.pixels.putRegion(5, 5, 1, 1, px(7, 7, 7, 255));
    const snap = L.pixels.snapshot();
    eq(L.pixels.snapshotEquals(snap), true, "未动 → 等价");
    L.pixels.restore(snap);
    eq(L.pixels.snapshotEquals(snap), true, "restore 装 acquire 副本（同 id）→ 仍等价");
    L.pixels.putRegion(5, 5, 1, 1, px(8, 8, 8, 255));
    eq(L.pixels.snapshotEquals(snap), false, "写入换句柄 → 不等价");
    disposePixelsSnapshot(snap);
  });
});

// 测试卫生：统一释放（防 tile-pool FR 泄漏 assert 刷屏；见 shape-brush.test.mjs 同款）
describe("pixel-tx-noop 收尾", () => {
  it("清栈并释放本文件的 doc tiles", () => {
    for (const { doc, h } of _ctxs) {
      h.clear();
      for (const leaf of flattenLeaves(doc.layers)) leaf.pixels?.dispose?.();
      doc.selection?.dispose?.();
    }
    _ctxs.length = 0;
    assert(true, "disposed");
  });
});
