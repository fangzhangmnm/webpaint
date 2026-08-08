// v0.7.35 · 栈引用完整性不变式 → **T3b-2 改写为 v2 令牌墙锚**（handoff §2 指定：别删，改写）。
// 旧病理：import 越狱裸 doc.addLayer + replaceFromBytes 不记账 → 栈上出现引用「历史不知道的层」
// 的记录 → 跨树 undo 静默丢画 / redo 不可恢复弃栈。
// v2 下这类病理**结构上不存在**：结构写必须持令牌（无令牌 → _componentWrite throw），持令牌的写
// 被 collector 自动收进 record——「忘记记账」没有物理路径。本文件三组：
//   ① 令牌墙：无令牌的 verb 写 → substrate 拒绝（旧病理的新形态钉子）；
//   ② 合规 import 形状（门面 addLayer 微步 + token 内像素 + lift）跨步 undo/redo 全程健康；
//   ③ v0.7.41 导入=一个 undo 整点（微步聚合 + lift 封口）。
// 不直接 import src/import-image.ts（拽 els/i18n/store 整串 DOM 依赖）——测的是它必须遵守的流程形状。
import { describe, it, assert, eq } from "./runner.mjs";
import { PaintingWorkpiece } from "../src/workpiece/painting-workpiece.ts";
import { PaintingView, flattenViewLeaves } from "../src/workpiece/painting-view.ts";
import { Workpiece } from "../src/workpiece/workpiece.ts";
import { LegacyHistory, LegacyOpsComponent } from "../src/workpiece/legacy-bridge.ts";
import { makeOperators } from "../src/workpiece/operators.ts";
import { LayerTree } from "../src/workpiece/layer-tree.ts";
import { FloatingTransform } from "../src/floating-transform.ts";

// 测试卫生：统一释放（防 tile-pool FR 泄漏 assert 刷屏；同 float-ops.test.mjs）
const _ctxs = [];
function mk() {
  let unrec = 0;
  const h = new LegacyHistory({ maxQuotaBytes: 1 << 30, onUnrecoverable: () => { unrec++; } });
  const wp2 = new PaintingWorkpiece({ undo: h.stack, tree: { width: 512, height: 512 } });
  const doc = new PaintingView(wp2);
  const w = new Workpiece(doc, h);
  const legacy = new LegacyOpsComponent(w);
  wp2.attachLegacy(legacy);
  h.attach(wp2, legacy, (on) => wp2.layerTiles._suspendCollect(on));
  const ops = makeOperators({ fillColor: { get: () => "#000", set: () => {} } });
  const lt = new LayerTree({ w, history: h, tree: wp2.layerTree, tiles: wp2.layerTiles, port: doc });
  const ft = new FloatingTransform();
  ft.attach(doc, h, wp2.floatLayer, wp2.selection);
  _ctxs.push({ h, w, wp2 });
  return { doc, wp2, w, h, ops, lt, ft, unrec: () => unrec };
}
// 不透明标记块（值可辨认，供逐字节比对）
function fillBuf(wpx, hpx) {
  const buf = new Uint8ClampedArray(wpx * hpx * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = 40; buf[i + 1] = 50; buf[i + 2] = 60; buf[i + 3] = 255; }
  return buf;
}
const hasLayer = (doc, id) => flattenViewLeaves(doc.layers).some((l) => l.id === id);

describe("栈完整性 · ① 令牌墙：无令牌写 → substrate 拒绝（旧「不记账越狱」病理的新形态钉子）", () => {
  it("layerTree verb / layerTiles verb 在令牌外被调 → throw；令牌内写自动进 record", () => {
    const { doc, wp2, h, w } = mk();
    // 旧越狱姿势 = 裸 doc.addLayer：v2 里根本没有这个门——结构写只有 verb，verb 必须持令牌。
    let threw = 0;
    try { wp2.layerTree.addLayer("越狱层"); } catch { threw++; }
    try { wp2.layerTiles.putRegion(doc.activeLayer.id, 0, 0, 1, 1, new Uint8ClampedArray(4)); } catch { threw++; }
    eq(threw, 2, "无令牌的结构/像素 verb 全被拒（忘记记账结构上不可能）");
    eq(h.depth, 0, "栈未被污染");
    // 同一动作持令牌 → 自动记账成一步（对照组）
    const tok = wp2.begin("对照");
    const leaf = wp2.layerTree.addLayer("合规层");
    assert(leaf, "令牌内 verb 成功");
    tok.commit();
    eq(h.depth, 1, "commit 自动入栈");
    h.undo(w);
    eq(hasLayer(doc, leaf.id), false, "undo 摘层——账本与状态永远一致");
  });
});

describe("栈完整性 · ② 修后合规：import 形状（门面微步 + token 内像素 + lift）跨步 undo/redo 全程健康", () => {
  it("undo×3 层干净消失 + active 复位；redo×3 层与像素逐字节回放 + 浮层回来；零 unrecoverable", () => {
    const { doc, wp2, w, h, lt, ft, unrec } = mk();
    const L1 = doc.activeLayer;
    lt.addLayer("L2");                                       // 栈: [addLayer(L2)]
    lt.setActive(L1.id);
    // —— T3b-2 起 import 的合规形状（import-image.ts / blender-sync.ts 同款）——
    const src = fillBuf(32, 32);
    const prevActiveId = doc.activeLayer?.id ?? null;
    const a = lt.addLayer("imported", { checkpoint: false });
    assert(a.ok, "addLayer 微步");
    const L3 = a.layer;
    L3.pixels.putRegion(100, 100, 32, 32, src);              // token 开着 → 写时扣押同步收账
    h.sealCheckpoint();                                      // 栈: [addLayer(L2), addLayer+px(L3)]
    eq(ft.lift(L3, { fallbackFullLayer: true }), true);      // 栈: [..., liftFloat]

    h.undo(w);                                               // 撤 lift：像素回层、浮层消失
    eq(wp2.floatLayer.view(), null);
    eq(L3.sampleAt(110, 110)[3], 255, "undo lift：像素回到层上");
    h.undo(w);                                               // 撤 addLayer+px：层被摘、active 复位
    eq(hasLayer(doc, L3.id), false, "undo：导入的层干净消失");
    eq(doc.activeLayer?.id, prevActiveId, "undo：active 回到导入前");
    h.undo(w);                                               // 撤 addLayer(L2)
    eq(h.canUndo(), false, "栈见底");
    eq(unrec(), 0, "全程零 unrecoverable");

    h.redo(w);                                               // addLayer(L2)
    h.redo(w);                                               // addLayer+px：层带像素回放
    eq(hasLayer(doc, L3.id), true, "redo：导入的层回来");
    const back = flattenViewLeaves(doc.layers).find((l) => l.id === L3.id);
    const got = back.pixels.getRegion(100, 100, 32, 32);
    assert(src.every((v, i) => v === got[i]), "redo：像素逐字节回放");
    eq(doc.activeLayer?.id, L3.id, "redo：active = 导入层");
    h.redo(w);                                               // liftFloat：能找到层
    assert(wp2.floatLayer.view(), "redo：浮层回来");
    eq(unrec(), 0);
  });
});

describe("栈完整性 · ③ v0.7.41 导入=一个 undo 整点（addLayer 微步 + liftFloat 封口）", () => {
  it("单次 undo：浮层与导入层一起消失、active 复位；单次 redo 全回放", () => {
    const { doc, wp2, w, h, lt, ft, unrec } = mk();
    const src = fillBuf(32, 32);
    const prevActiveId = doc.activeLayer?.id ?? null;
    // —— v0.7.41 起 import 的合规形状：checkpoint:false 微步 + lift 封口 ——
    const a = lt.addLayer("imported", { checkpoint: false });
    assert(a.ok, "addLayer 微步");
    const L3 = a.layer;
    L3.pixels.putRegion(100, 100, 32, 32, src);
    eq(ft.lift(L3, { fallbackFullLayer: true }), true, "liftFloat 默认封口 → 整组闭合");
    h.undo(w);                                           // 只按一次
    eq(wp2.floatLayer.view(), null, "一次 undo：浮层消失");
    eq(hasLayer(doc, L3.id), false, "一次 undo：导入层同整点消失");
    eq(doc.activeLayer?.id, prevActiveId, "active 回导入前");
    h.redo(w);                                           // 只按一次
    eq(hasLayer(doc, L3.id), true, "一次 redo：层带像素回放");
    assert(wp2.floatLayer.view(), "一次 redo：浮层回来");
    const back = flattenViewLeaves(doc.layers).find((l) => l.id === L3.id);
    eq(back.pixels.isEmpty(), true, "redo 后像素在浮层里（层挖空）——lift 状态完整回放");
    eq(unrec(), 0, "全程零 unrecoverable");
  });
});

// 测试卫生：统一释放（清栈+收浮层 = record 驱逐 → tileset 归零还池）
describe("undo-stack-integrity 收尾", () => {
  it("清栈、收浮层并释放本文件的工件资源", () => {
    for (const { h, wp2 } of _ctxs) {
      h.clear();
      wp2.floatLayer.dropForLoad();
      wp2.load({ width: 4, height: 4, nodes: [{ name: "空", visible: true, opacity: 1, mode: "source-over", clippingMask: false, lockAlpha: false, pixels: null }] });
    }
    _ctxs.length = 0;
    assert(true, "disposed");
  });
});
