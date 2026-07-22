// document-operator 在**真 PaintDoc** 上的可逆性集成测试（test charter (b)：历史 bug 的回归护栏）。
// 每族 op：do → undo → 深比对回到原态 → redo → 比对到新态。node 可测面（mergeDown 走 canvas 合成，
// 归 smoke/真机批）。
import { describe, it, assert, eq } from "./runner.mjs";
import { PaintDoc, flattenLeaves } from "../src/doc.ts";
import { Workpiece } from "../src/workpiece/workpiece.ts";
import { UndoHistory } from "../src/workpiece/undo-history.ts";
import { makeOperators } from "../src/workpiece/operators.ts";
import { appTilePool } from "../src/tiles/app-tile-pool.ts";

function mk() {
  const doc = new PaintDoc({ width: 512, height: 512 });
  const w = new Workpiece(doc);
  let unrec = 0;
  const h = new UndoHistory({ maxQuotaBytes: 1 << 30, onUnrecoverable: () => { unrec++; } });
  const ops = makeOperators({ applyDocTransformUi: () => {} });
  return { doc, w, h, ops, unrec: () => unrec };
}
const px = (r, g, b, a) => new Uint8ClampedArray([r, g, b, a]);

describe("operators · SwapPixels（事务型：引擎先画，before 句柄零拷贝）", () => {
  it("画一笔 → undo 回原态 → redo 回新态（像素逐点验证）", () => {
    const { doc, w, h, ops } = mk();
    const L = doc.activeLayer;
    L.pixels.putRegion(10, 10, 1, 1, px(1, 2, 3, 255));      // 底色（不进 undo 的初态）
    const before = L.snapshot();
    L.pixels.putRegion(10, 10, 1, 1, px(9, 9, 9, 255));      // 引擎改动
    L.pixels.putRegion(300, 300, 1, 1, px(5, 5, 5, 255));
    eq(h.run(w, ops.pixels, { layerId: L.id, _initialBefore: before }).ok, true);
    h.undo(w);
    eq(L.sampleAt(10, 10)[0], 1, "undo 回底色");
    eq(L.sampleAt(300, 300)[3], 0, "undo 后第二点消失");
    h.redo(w);
    eq(L.sampleAt(10, 10)[0], 9, "redo 回笔迹");
    eq(L.sampleAt(300, 300)[0], 5);
    h.undo(w);
    eq(L.sampleAt(10, 10)[0], 1, "二次 undo 仍精确（对称 swap 无衰减）");
  });

  it("层被删后 undo 该笔 → 不可恢复协议（弃栈上报），不炸不错删", () => {
    const { doc, w, h, ops, unrec } = mk();
    const L = doc.addLayer("受害者");
    const before = L.snapshot();
    L.pixels.putRegion(0, 0, 1, 1, px(7, 7, 7, 255));
    h.run(w, ops.pixels, { layerId: L.id, _initialBefore: before });
    doc.removeLayer(L.id);                                   // 直接删（绕 undo——模拟腐坏场景）
    eq(h.undo(w), false);
    eq(unrec(), 1, "layer gone → 不可恢复弃栈（诚实，不吞错照报成功）");
  });
});

describe("operators · Add/Remove/Move/Prop/Reference（操作型）", () => {
  it("addLayer 记录 → undo 摘层（active 回退）→ redo 复原（含像素）", () => {
    const { doc, w, h, ops } = mk();
    const prevActiveId = doc.activeId;
    const L = doc.addLayer("新层");
    L.pixels.putRegion(50, 50, 1, 1, px(8, 8, 8, 255));
    const loc = doc.locateNode(L.id);
    eq(h.run(w, ops.addLayer, { layerId: L.id, index: loc.index, parentId: loc.parentId, prevActiveId, layerName: L.name }).ok, true);
    h.undo(w);
    assert(!flattenLeaves(doc.layers).some((x) => x.id === L.id), "undo 摘掉新层");
    eq(doc.activeId, prevActiveId, "active 回创建前（v125）");
    h.redo(w);
    const back = flattenLeaves(doc.layers).find((x) => x.id === L.id);
    assert(back, "redo 复原（同 id）");
    eq(back.sampleAt(50, 50)[0], 8, "像素随 spec 句柄回来");
    eq(doc.activeId, L.id);
  });

  it("removeLayer → undo 复原像素与位置 → redo 再删；keep-one 护栏返回 ok:false", () => {
    const { doc, w, h, ops } = mk();
    const L = doc.addLayer("要删的");
    L.pixels.putRegion(30, 30, 1, 1, px(6, 6, 6, 255));
    eq(h.run(w, ops.removeLayer, { layerId: L.id, layerName: L.name }).ok, true);
    assert(!flattenLeaves(doc.layers).some((x) => x.id === L.id));
    h.undo(w);
    const back = flattenLeaves(doc.layers).find((x) => x.id === L.id);
    assert(back && back.sampleAt(30, 30)[0] === 6, "undo 连像素复原");
    h.redo(w);
    assert(!flattenLeaves(doc.layers).some((x) => x.id === L.id), "redo 再删");
    // keep-one：只剩 1 层时拒绝
    const only = flattenLeaves(doc.layers)[0];
    eq(h.run(w, ops.removeLayer, { layerId: only.id, layerName: only.name }).ok, false);
    assert(flattenLeaves(doc.layers).length === 1, "护栏生效，层还在");
  });

  it("layerProp 双形态：操作型 apply + 事务型 _initialOld；undo/redo 对称", () => {
    const { doc, w, h, ops } = mk();
    const L = doc.activeLayer;
    // 操作型：op 自己写
    h.run(w, ops.layerProp, { layerId: L.id, prop: "visible", value: false });
    eq(L.visible, false);
    h.undo(w); eq(L.visible, true);
    h.redo(w); eq(L.visible, false);
    // 事务型：滑杆已实时写，收尾入栈
    const old = L.opacity;
    L.opacity = 0.3;
    h.run(w, ops.layerProp, { layerId: L.id, prop: "opacity", value: 0.3, _initialOld: { v: old } });
    h.undo(w); eq(L.opacity, old, "undo 回拖动前");
    h.redo(w); eq(L.opacity, 0.3);
  });

  it("moveLayer / referenceLayer 往返", () => {
    const { doc, w, h, ops } = mk();
    const a = doc.activeLayer;
    doc.addLayer("上面");
    eq(h.run(w, ops.moveLayer, { layerId: a.id, delta: 1 }).ok, true);
    eq(doc.layers[1].id, a.id, "上移");
    h.undo(w); eq(doc.layers[0].id, a.id, "undo 回位");
    h.run(w, ops.referenceLayer, { value: a.id });
    eq(doc.referenceLayerId, a.id);
    h.undo(w); eq(doc.referenceLayerId, null);
  });
});

describe("operators · TreeStructure / DocTransform（结构与整 doc 快照）", () => {
  it("编组（事务型 snapshotTree 前后）→ undo 解组还原（叶活引用像素零拷贝）", () => {
    const { doc, w, h, ops } = mk();
    const L1 = doc.activeLayer;
    doc.addLayer("l2");
    const before = doc.snapshotTree();
    doc.groupSelection(L1.id);                       // L1 套进新组（单 id API）
    const after = doc.snapshotTree();
    eq(h.run(w, ops.treeStructure, { before, after }).ok, true);
    assert(doc.layers.some((n) => n.isGroup), "已编组");
    h.undo(w);
    assert(!doc.layers.some((n) => n.isGroup), "undo 解组");
    assert(flattenLeaves(doc.layers).some((x) => x === L1), "叶是同一活对象");
    h.redo(w);
    assert(doc.layers.some((n) => n.isGroup), "redo 再编组");
  });

  it("crop（docTransform 事务型）→ undo 回原尺寸与像素 → redo 回裁后", () => {
    const { doc, w, h, ops } = mk();
    const L = doc.activeLayer;
    L.pixels.putRegion(400, 400, 1, 1, px(4, 4, 4, 255));
    const before = { doc: doc.snapshotAll(), viewport: null };
    doc.cropTo({ x: 0, y: 0, w: 256, h: 256 });
    const after = { doc: doc.snapshotAll(), viewport: null };
    eq(h.run(w, ops.docTransform, { before, after }).ok, true);
    eq(doc.width, 256);
    h.undo(w);
    eq(doc.width, 512, "undo 回原尺寸");
    eq(doc.activeLayer.sampleAt(400, 400)[0], 4, "裁掉的像素回来了");
    h.redo(w);
    eq(doc.width, 256, "redo 回裁后");
  });
});

describe("operators · 句柄收支（清栈后池不留本套件的 tile）", () => {
  it("一串操作 + 清栈 + 层清空 → 池计数回落到进入前", () => {
    const before = appTilePool().stats().count;
    const { doc, w, h, ops } = mk();
    const L = doc.activeLayer;
    const b1 = L.snapshot();
    L.pixels.putRegion(0, 0, 2, 2, new Uint8ClampedArray(16).fill(9));
    h.run(w, ops.pixels, { layerId: L.id, _initialBefore: b1 });
    const L2 = doc.addLayer("t");
    L2.pixels.putRegion(5, 5, 1, 1, px(1, 1, 1, 9));
    const loc = doc.locateNode(L2.id);
    h.run(w, ops.addLayer, { layerId: L2.id, index: loc.index, parentId: loc.parentId, prevActiveId: L.id, layerName: "t" });
    h.undo(w); h.redo(w); h.undo(w); h.undo(w);
    h.clear();
    for (const leaf of flattenLeaves(doc.layers)) leaf.pixels.dispose();
    eq(appTilePool().stats().count, before, "undo 包/层像素全部归还（无泄漏）");
  });
});
