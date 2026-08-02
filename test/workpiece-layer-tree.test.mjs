// v0.8.1 · S1 LayerTree component 行为锁（ADR-0007 写面收权：写即记账，一体不可拆）。
// （区分 layer-tree.test.mjs——那是 PaintDoc 树模型的结构测试；本文件测 workpiece 门面。）
// 守的契约：
//   - addLayer/duplicateLayer = 创建即记账（undo 摘层回 prevActive、redo 连像素恢复）；
//   - deleteGroup 删到 0 叶自动补空层；removeLayer keep-one 守卫透传；
//   - treeTx：mutate 中止（null/false）不入栈；成功前后快照对称 undo/redo；
//   - setLayerProp 操作型 + initialOld pre-applied 两形态；clearLayer 事务型像素还原；
//   - 装配纪律：未装配访问 throw、重复装配 throw。
// mergeDown 走 canvas 合成，node 不可测（归 gl-smoke/真机批，同 operators.test 注）。
import { describe, it, assert, eq } from "./runner.mjs";
import { PaintDoc, flattenLeaves, countLeaves } from "../src/doc.ts";
import { Workpiece } from "../src/workpiece/workpiece.ts";
import { UndoHistory } from "../src/workpiece/undo-history.ts";
import { makeOperators } from "../src/workpiece/operators.ts";
import { LayerTree } from "../src/workpiece/layer-tree.ts";

// 测试卫生：统一释放（防 tile-pool FR 泄漏 assert 刷屏；同 operators.test.mjs）
const _ctxs = [];
function mk() {
  const doc = new PaintDoc({ width: 128, height: 128 });
  let unrec = 0;
  const h = new UndoHistory({ maxQuotaBytes: 1 << 30, onUnrecoverable: () => { unrec++; } });
  const w = new Workpiece(doc, h);
  const ops = makeOperators({
    applyDocTransformUi: () => {},
    fillColor: { get: () => "#000000", set: () => {} },
  });
  const lt = new LayerTree({ w, doc, history: h, ops });
  _ctxs.push({ doc, h });
  return { doc, w, h, ops, lt, unrec: () => unrec };
}
const px = (r, g, b, a) => new Uint8ClampedArray([r, g, b, a]);
const readPx = (L, x, y) => Array.from(L.getImageData(x, y, 1, 1).data).join(",");   // eq 是严格 !== → 转字符串比对

describe("workpiece-layer-tree · 装配纪律", () => {
  it("未装配访问 workpiece.layers → throw；重复装配 → throw", () => {
    const doc = new PaintDoc({ width: 64, height: 64 });
    const h = new UndoHistory({ maxQuotaBytes: 1 << 20, onUnrecoverable: () => {} });
    const w = new Workpiece(doc, h);
    let threw = false;
    try { void w.layers; } catch { threw = true; }
    assert(threw, "未装配访问必须 throw");
    const ops = makeOperators({ applyDocTransformUi: () => {}, fillColor: { get: () => "#000", set: () => {} } });
    new LayerTree({ w, doc, history: h, ops });
    void w.layers;   // 装配后可访问
    let threw2 = false;
    try { new LayerTree({ w, doc, history: h, ops }); } catch { threw2 = true; }
    assert(threw2, "重复装配必须 throw");
    _ctxs.push({ doc, h });
  });
});

describe("workpiece-layer-tree · addLayer（创建即记账）", () => {
  it("add → 记账后填像素 → undo 摘层回 prevActive → redo 连像素恢复", () => {
    const { doc, w, h, lt, unrec } = mk();
    const base = doc.activeLayer;
    const a = lt.addLayer("导入测试");
    assert(a.ok, "addLayer ok");
    const L = a.layer;
    eq(doc.activeLayer.id, L.id, "新层为 active");
    L.pixels.putRegion(7, 7, 1, 1, px(9, 8, 7, 255));   // 记账后初始化像素（合规窗口）
    eq(countLeaves(doc.layers), 2, "两叶");
    h.undo(w);
    eq(countLeaves(doc.layers), 1, "undo 摘层");
    eq(doc.activeLayer.id, base.id, "active 回创建前");
    h.redo(w);
    eq(countLeaves(doc.layers), 2, "redo 恢复层");
    const L2 = flattenLeaves(doc.layers).find((x) => x.name === "导入测试");
    assert(L2, "redo 后层还在");
    eq(readPx(L2, 7, 7), "9,8,7,255", "redo 连像素恢复");
    eq(unrec(), 0, "全程无不可恢复");
  });

  it("checkpoint:false 微步与后续步封成一个整点（v0.7.41 import 单整点语义）", () => {
    const { doc, w, h, lt } = mk();
    lt.addLayer("微步层", { checkpoint: false });
    const L = doc.activeLayer;
    lt.setLayerProp(L.id, "opacity", 0.5);   // 默认封口 → [addLayer, prop] 一个整点
    eq(countLeaves(doc.layers), 2, "加层生效");
    h.undo(w);
    eq(countLeaves(doc.layers), 1, "一次 undo 整包消失（含加层）");
  });
});

describe("workpiece-layer-tree · duplicateLayer", () => {
  it("复制含像素 → undo/redo 往返", () => {
    const { doc, w, h, lt } = mk();
    const src = doc.activeLayer;
    src.pixels.putRegion(3, 3, 1, 1, px(1, 2, 3, 255));
    const a = lt.duplicateLayer(src.id);
    assert(a.ok, "duplicate ok");
    eq(readPx(a.layer, 3, 3), "1,2,3,255", "像素已复制");
    h.undo(w);
    eq(countLeaves(doc.layers), 1, "undo 摘复制层");
    eq(doc.activeLayer.id, src.id, "active 回源层");
    h.redo(w);
    eq(countLeaves(doc.layers), 2, "redo 恢复");
  });
  it("复制缺失 id → {ok:false,'missing'}", () => {
    const { lt } = mk();
    eq(lt.duplicateLayer(99999).msg, "missing", "reason 透传");
  });
});

describe("workpiece-layer-tree · removeLayer / deleteGroup", () => {
  it("最后一张叶 keep-one 守卫拒删", () => {
    const { doc, lt } = mk();
    const st = lt.removeLayer(doc.activeLayer.id, doc.activeLayer.name);
    eq(st.ok, false, "拒绝");
    eq(countLeaves(doc.layers), 1, "层还在");
  });
  it("deleteGroup 删到 0 叶自动补空层；undo 树整还原", () => {
    const { doc, w, h, lt } = mk();
    // 唯一叶移进组 → 删组 = 删到 0 叶
    const leafId = doc.activeLayer.id;   // addGroup 会把 active 设为组本身 → 先记叶 id
    const r0 = lt.treeTx((d) => { const g = d.addGroup("组"); return d.moveIntoGroup(leafId, g.id) ? g : null; });
    assert(r0.ok, "建组+移入");
    const gid = r0.value.id;
    const st = lt.deleteGroup(gid, { undoStatus: "恢复组", redoStatus: "删除组" });
    assert(st.ok, "删组 ok");
    eq(countLeaves(doc.layers), 1, "补了空层");
    assert(!doc.layers.some((n) => n.isGroup), "组已删");
    h.undo(w);
    assert(doc.layers.some((n) => n.id === gid), "undo 组回来了");
    h.redo(w);
    assert(!doc.layers.some((n) => n.isGroup), "redo 再删");
  });
});

describe("workpiece-layer-tree · treeTx", () => {
  it("mutate 返回 null → 中止不入栈", () => {
    const { h, lt } = mk();
    const d0 = h.depth;
    const r = lt.treeTx(() => null);
    eq(r.ok, false, "中止");
    eq(h.depth, d0, "栈未动");
  });
  it("statuses 从 mutate 返回值算（addGroup 命名进 undo/redo 文案）", () => {
    const { doc, w, h, lt } = mk();
    let sawName = "";
    const r = lt.treeTx((d) => d.addGroup("甲组"), (g) => { sawName = g.name; return { undoStatus: "撤" + g.name, redoStatus: "重" + g.name }; });
    assert(r.ok, "ok");
    eq(sawName, "甲组", "statuses 拿到返回值");
    h.undo(w);
    assert(!doc.layers.some((n) => n.isGroup), "undo 组消失");
    h.redo(w);
    assert(doc.layers.some((n) => n.isGroup), "redo 组回来");
  });
});

describe("workpiece-layer-tree · setLayerProp / clearLayer / moveLayer", () => {
  it("操作型 prop：undo/redo 值往返", () => {
    const { doc, w, h, lt } = mk();
    const L = doc.activeLayer;
    lt.setLayerProp(L.id, "visible", false);
    eq(L.visible, false, "生效");
    h.undo(w);
    eq(L.visible, true, "undo 回");
    h.redo(w);
    eq(L.visible, false, "redo 回");
  });
  it("initialOld pre-applied（透明度 slider 形态）：undo 回旧值", () => {
    const { doc, w, h, lt } = mk();
    const L = doc.activeLayer;
    L.opacity = 0.3;   // 拖动期实时已写
    const st = lt.setLayerProp(L.id, "opacity", 0.3, { initialOld: { v: 1 } });
    assert(st.ok, "提交补账 ok");
    h.undo(w);
    eq(L.opacity, 1, "undo 回拖动前");
    h.redo(w);
    eq(L.opacity, 0.3, "redo 回拖后");
  });
  it("clearLayer：undo 像素还原", () => {
    const { doc, w, h, lt } = mk();
    const L = doc.activeLayer;
    L.pixels.putRegion(5, 5, 1, 1, px(4, 5, 6, 255));
    assert(lt.clearLayer(L.id).ok, "清空 ok");
    eq(readPx(L, 5, 5).split(",")[3], "0", "已清");
    h.undo(w);
    eq(readPx(L, 5, 5), "4,5,6,255", "undo 还原像素");
  });
  it("moveLayer 同级往返", () => {
    const { doc, w, h, lt } = mk();
    lt.addLayer("上层");
    const top = doc.activeLayer;
    assert(lt.moveLayer(top.id, -1).ok, "下移 ok");
    eq(doc.layers[0].id, top.id, "在底");
    h.undo(w);
    eq(doc.layers[1].id, top.id, "undo 回顶");
  });
});

// 测试卫生：统一释放（防 tile-pool FR 泄漏 assert 刷屏）
describe("workpiece-layer-tree 收尾", () => {
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
