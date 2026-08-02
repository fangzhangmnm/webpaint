// v0.7.35 · 栈引用完整性不变式（import 越狱修复的行为锁）。
// 背景：import-image / blender-sync 曾裸 doc.addLayer + replaceFromBytes 不记账（还伪造
// wp:histchange），随后 auto-lift 却入栈 —— 栈上出现引用「历史不知道的层」的记录：
//   · undo 跨过更早的 treeStructure 时 restoreTree 按旧快照重建 → 该层被静默销毁（丢画）；
//   · 再 redo 到 liftFloat 时 leafById 找不到层 → ok:false → onUnrecoverable → 整栈被弃。
// 本文件两组测试：
//   ① 钉住病理（0.8 写面收权前的接缝现状记录）：不记账加层 + lift → 跨树 undo/redo 必炸栈；
//   ② 修后合规（import 形状 = 像素先填 + AddLayerRecordOp 后记，同 selection-ops copy 模式）：
//      同样的跨树 undo/redo 全程健康、层与像素逐字节回放。
// 不直接 import src/import-image.ts（拽 els/i18n/store 整串 DOM 依赖）——测的是它必须遵守的流程形状。
import { describe, it, assert, eq } from "./runner.mjs";
import { PaintDoc, flattenLeaves } from "../src/doc.ts";
import { Workpiece } from "../src/workpiece/workpiece.ts";
import { UndoHistory } from "../src/workpiece/undo-history.ts";
import { makeOperators } from "../src/workpiece/operators.ts";
import { FloatingTransform } from "../src/floating-transform.ts";

// 测试卫生：统一释放（防 tile-pool FR 泄漏 assert 刷屏；同 float-ops.test.mjs）
const _ctxs = [], _orphans = [];   // _orphans：病理测试里被 restoreTree 静默丢掉的层（所有权归测试）
function mk() {
  const doc = new PaintDoc({ width: 512, height: 512 });
  let unrec = 0;
  const h = new UndoHistory({ maxQuotaBytes: 1 << 30, onUnrecoverable: () => { unrec++; } });
  const w = new Workpiece(doc, h);
  const ops = makeOperators({ applyDocTransformUi: () => {} });
  const ft = new FloatingTransform();
  ft.attach(w, h, ops);
  _ctxs.push({ doc, w, h });
  return { doc, w, h, ops, ft, unrec: () => unrec };
}
// 不透明标记块（值可辨认，供逐字节比对）
function fillBuf(wpx, hpx) {
  const buf = new Uint8ClampedArray(wpx * hpx * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = 40; buf[i + 1] = 50; buf[i + 2] = 60; buf[i + 3] = 255; }
  return buf;
}
const hasLayer = (doc, id) => flattenLeaves(doc.layers).some((l) => l.id === id);
// 一条已入栈的 treeStructure（before/after 都不含之后才导入的层）——制造「跨树 undo」条件。
// ①型 pre-applied：夹在两次 snapshotTree 之间裸加一层（layers-panel _deleteLayer 同款合法用法）。
function recordTreeOpAddingLayer(doc, w, h, ops, name) {
  const before = doc.snapshotTree();
  const L = doc.addLayer(name);
  const after = doc.snapshotTree();
  const st = h.run(w, ops.treeStructure, { before, after });
  assert(st.ok, "treeStructure 入栈");
  return L;
}

describe("栈完整性 · ① 病理钉子：不记账的加层 + lift = 跨树 undo/redo 炸栈（0.8 前接缝现状）", () => {
  it("undo 跨树静默销毁未记账层；redo 到 liftFloat 找不到层 → onUnrecoverable + 整栈被弃", () => {
    const { doc, w, h, ops, ft, unrec } = mk();
    recordTreeOpAddingLayer(doc, w, h, ops, "L2");           // 栈: [treeStructure]
    // —— 旧 import 的越狱姿势：裸加层 + 填像素，不记账 ——
    const L3 = doc.addLayer("jailbreak-import");
    L3.replaceFromBytes(fillBuf(32, 32), 100, 100, 32, 32);
    _orphans.push(L3);
    eq(ft.lift(L3, { fallbackFullLayer: true }), true);      // 栈: [treeStructure, liftFloat]
    h.undo(w);                                               // lift 撤掉：像素回 L3，尚无事
    eq(unrec(), 0);
    eq(L3.sampleAt(110, 110)[3], 255, "undo lift：像素回到层上");
    h.undo(w);                                               // 跨树：restoreTree(before) 不认识 L3
    eq(unrec(), 0, "静默——这正是可怕之处");
    eq(hasLayer(doc, L3.id), false, "未记账层被 restoreTree 静默销毁（用户的图丢了）");
    h.redo(w);                                               // treeStructure forward（after 也没有 L3）
    eq(hasLayer(doc, L3.id), false);
    h.redo(w);                                               // liftFloat forward：layer gone → 不可恢复
    eq(unrec(), 1, "redo liftFloat 找不到层 → onUnrecoverable");
    eq(h.canUndo(), false, "整栈被弃");
    eq(h.canRedo(), false);
  });
});

describe("栈完整性 · ② 修后合规：import 形状（像素先填 + AddLayerRecordOp）跨树 undo/redo 全程健康", () => {
  it("undo×3 层干净消失 + active 复位；redo×3 层与像素逐字节回放 + 浮层回来；零 unrecoverable", () => {
    const { doc, w, h, ops, ft, unrec } = mk();
    const L1 = doc.activeLayer;
    recordTreeOpAddingLayer(doc, w, h, ops, "L2");           // 栈: [treeStructure]
    doc.setActiveById(L1.id);
    // —— v0.7.35 起 import 的合规形状（import-image.ts / blender-sync.ts 同款）——
    const src = fillBuf(32, 32);
    const prevActiveId = doc.activeLayer?.id ?? null;
    const L3 = doc.addLayer("imported");
    L3.replaceFromBytes(src, 100, 100, 32, 32);
    const loc = doc.locateNode(L3.id);
    const st = h.run(w, ops.addLayer,
      { layerId: L3.id, index: loc.index, parentId: loc.parentId, prevActiveId, layerName: L3.name });
    assert(st.ok, "addLayer 记录入栈");
    eq(ft.lift(L3, { fallbackFullLayer: true }), true);      // 栈: [treeStructure, addLayer, liftFloat]

    h.undo(w);                                               // 撤 lift：像素回层、浮层消失
    eq(w.readFloatState(), null);
    h.undo(w);                                               // 撤 addLayer 记录：层被摘、active 复位
    eq(hasLayer(doc, L3.id), false, "undo：导入的层干净消失");
    eq(doc.activeLayer?.id, prevActiveId, "undo：active 回到导入前");
    h.undo(w);                                               // 撤 treeStructure：跨树无事
    eq(h.canUndo(), false, "栈见底");
    eq(unrec(), 0, "全程零 unrecoverable");

    h.redo(w);                                               // treeStructure
    h.redo(w);                                               // addLayer：层带像素回放
    eq(hasLayer(doc, L3.id), true, "redo：导入的层回来");
    const back = flattenLeaves(doc.layers).find((l) => l.id === L3.id);
    const got = back.pixels.getRegion(100, 100, 32, 32);
    assert(src.every((v, i) => v === got[i]), "redo：像素逐字节回放");
    eq(doc.activeLayer?.id, L3.id, "redo：active = 导入层");
    h.redo(w);                                               // liftFloat：能找到层
    assert(w.readFloatState(), "redo：浮层回来");
    eq(unrec(), 0);
  });
});

describe("栈完整性 · ③ v0.7.41 导入=一个 undo 整点（addLayer 微步 + liftFloat 封口）", () => {
  it("单次 undo：浮层与导入层一起消失、active 复位；单次 redo 全回放", () => {
    const { doc, w, h, ops, ft, unrec } = mk();
    const src = fillBuf(32, 32);
    const prevActiveId = doc.activeLayer?.id ?? null;
    // —— v0.7.41 起 import 的合规形状：checkpoint:false 微步 + lift 封口 ——
    const L3 = doc.addLayer("imported");
    L3.replaceFromBytes(src, 100, 100, 32, 32);
    const loc = doc.locateNode(L3.id);
    const st = h.run(w, ops.addLayer,
      { layerId: L3.id, index: loc.index, parentId: loc.parentId, prevActiveId, layerName: L3.name },
      { checkpoint: false });
    assert(st.ok, "addLayer 微步入栈");
    eq(ft.lift(L3, { fallbackFullLayer: true }), true, "liftFloat 默认封口 → 整组闭合");
    h.undo(w);                                           // 只按一次
    eq(w.readFloatState(), null, "一次 undo：浮层消失");
    eq(hasLayer(doc, L3.id), false, "一次 undo：导入层同整点消失");
    eq(doc.activeLayer?.id, prevActiveId, "active 回导入前");
    h.redo(w);                                           // 只按一次
    eq(hasLayer(doc, L3.id), true, "一次 redo：层带像素回放");
    assert(w.readFloatState(), "一次 redo：浮层回来");
    const back = flattenLeaves(doc.layers).find((l) => l.id === L3.id);
    eq(back.pixels.isEmpty(), true, "redo 后像素在浮层里（层挖空）——lift 状态完整回放");
    eq(unrec(), 0, "全程零 unrecoverable");
  });
});

// 测试卫生：统一释放
describe("undo-stack-integrity 收尾", () => {
  it("清栈、收浮层并释放本文件的 doc tiles", () => {
    for (const { doc, w, h } of _ctxs) {
      h.clear();
      w.dropFloats();
      for (const leaf of flattenLeaves(doc.layers)) leaf.pixels?.dispose?.();
      doc.selection?.dispose?.();
    }
    for (const L of _orphans) { try { L.pixels?.dispose?.(); } catch { /* 已随包释放 */ } }
    _ctxs.length = 0; _orphans.length = 0;
    assert(true, "disposed");
  });
});
