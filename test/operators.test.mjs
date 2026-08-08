// legacy 残余 operator 在 **v2 树模式工件**上的可逆性集成测试（T3b-2 换基座）。
// 已迁走的 op 族（add/remove/move/prop/reference/treeStructure/mergeDown/docTransform）的行为锚
// 在 workpiece-layer-tree.test.mjs（门面）+ layer-tree2.test.mjs（verb 契约）；本文件只测残余集：
//   fillColor / docResize（T3b-2 新立：几何变换实例交换）+ 清栈后 tileset/池的所有权收支。
// （SwapPixelsOp 已死——T4b：像素事务归 token+LayerTiles 写时扣押，锚在 layer-tiles/float-ops 测试。）
// 「层被删后 undo 该笔」的栈序腐坏在 v2 下结构上不可能（栈序保证 undo 必先穿过删层步）；
// 桥的不可恢复协议锚在 legacy-bridge.test.mjs（compound/swap 中途失败 → 弃栈）。
import { describe, it, assert, eq } from "./runner.mjs";
import { PaintingWorkpiece } from "../src/workpiece/painting-workpiece.ts";
import { PaintingView, flattenViewLeaves } from "../src/workpiece/painting-view.ts";
import { Workpiece } from "../src/workpiece/workpiece.ts";
import { LegacyHistory, LegacyOpsComponent } from "../src/workpiece/legacy-bridge.ts";
import { makeOperators } from "../src/workpiece/operators.ts";
import { appTilePool } from "../src/tiles/app-tile-pool.ts";

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
  let _color = "#1b1b1b";   // fillColor op 的注入色钩子（真 app = state.color / fill-mode 回灌抑制）
  const ops = makeOperators({ fillColor: { get: () => _color, set: (hex) => { _color = hex; } } });
  _ctxs.push({ h, wp2 });
  return { doc, wp2, w, h, ops, unrec: () => unrec, color: () => _color, setColor: (hex) => { _color = hex; } };
}
const px = (r, g, b, a) => new Uint8ClampedArray([r, g, b, a]);

describe("operators · 像素事务（T4b：token + 写时扣押取代 SwapPixelsOp）", () => {
  it("令牌内画一笔 → undo 回原态 → redo 回新态（像素逐点验证）", () => {
    const { doc, wp2, w, h } = mk();
    const L = doc.activeLayer;
    L.pixels.putRegion(10, 10, 1, 1, px(1, 2, 3, 255));      // 底色（令牌外直写，不进 undo 的初态）
    const t = wp2.begin("stroke");
    L.pixels.putRegion(10, 10, 1, 1, px(9, 9, 9, 255));      // 引擎改动（写时扣押）
    L.pixels.putRegion(300, 300, 1, 1, px(5, 5, 5, 255));
    t.commit();
    h.undo(w);
    eq(L.sampleAt(10, 10)[0], 1, "undo 回底色");
    eq(L.sampleAt(300, 300)[3], 0, "undo 后第二点消失");
    h.redo(w);
    eq(L.sampleAt(10, 10)[0], 9, "redo 回笔迹");
    eq(L.sampleAt(300, 300)[0], 5);
    h.undo(w);
    eq(L.sampleAt(10, 10)[0], 1, "二次 undo 仍精确（对称 swap 无衰减）");
  });
});

describe("operators · DocResize（T3b-2：crop/resample 的实例交换 + 树尺寸同步翻）", () => {
  it("crop 形（compound：exchange + docResize 微步 + setTreeProp）→ undo 回原尺寸与像素 → redo 回裁后", () => {
    const { doc, wp2, w, h, ops, unrec } = mk();
    const L = doc.activeLayer;
    L.pixels.putRegion(400, 400, 1, 1, px(4, 4, 4, 255));
    L.pixels.putRegion(8, 8, 1, 1, px(2, 2, 2, 255));
    const r = h.compound(w, () => {
      // 实例交换段挂起收集（doc-ops runDocTransform 同款纪律）：新实例构造期的 putRegion 不许
      //   被写时扣押（记录归 DocResizeOp），否则 undo 炸 across 断言。
      const old = [];
      wp2.layerTiles._suspendCollect(true);
      try {
        for (const leaf of flattenViewLeaves(doc.layers)) {
          const np = leaf.pixels.cropped(0, 0, 256, 256);
          old.push({ layerId: leaf.id, lp: doc.exchangeLeafPixels(leaf.id, np) });
        }
      } finally {
        wp2.layerTiles._suspendCollect(false);
      }
      const st = h.run(w, ops.docResize, { _initial: { leaves: old } }, { checkpoint: false });
      if (!st.ok) throw new Error(st.msg);
      wp2.layerTree.setTreeProp("width", 256);
      wp2.layerTree.setTreeProp("height", 256);
    }, { label: "crop" });
    assert(r.ok, "crop compound ok");
    eq(doc.width, 256, "裁后尺寸");
    eq(doc.activeLayer.sampleAt(8, 8)[0], 2, "保留区像素还在");
    h.undo(w);
    eq(doc.width, 512, "undo 回原尺寸");
    eq(doc.activeLayer.sampleAt(400, 400)[0], 4, "裁掉的像素回来了");
    h.redo(w);
    eq(doc.width, 256, "redo 回裁后");
    eq(doc.activeLayer.sampleAt(400, 400)[3], 0, "redo 后裁外像素不在");
    h.undo(w);
    eq(doc.activeLayer.sampleAt(400, 400)[0], 4, "二次 undo 仍精确");
    eq(unrec(), 0, "全程无不可恢复");
  });

  it("缺 _initial → run 拒绝（防误用为操作型）", () => {
    const { w, h, ops } = mk();
    eq(h.run(w, ops.docResize, {}).ok, false);
  });
});

describe("operators · 所有权收支（清栈+换文档后池不留本套件的 tile）", () => {
  it("一串操作 + 清栈 + load 空文档 → 池计数回落到进入前", () => {
    const before = appTilePool().stats().count;
    const { doc, wp2, w, h, ops } = mk();
    const L = doc.activeLayer;
    L.pixels.putRegion(0, 0, 2, 2, new Uint8ClampedArray(16).fill(9));
    const t = wp2.begin("stroke");
    L.pixels.putRegion(64, 64, 2, 2, new Uint8ClampedArray(16).fill(7));
    t.commit();
    h.undo(w); h.redo(w); h.undo(w);
    h.clear();
    // 换文档：旧根 record 随 load 清栈驱逐 → 旧 tileset 引用计数归零还池（换文档零手工 dispose）。
    wp2.load({ width: 8, height: 8, nodes: [{ name: "空", visible: true, opacity: 1, mode: "source-over", clippingMask: false, lockAlpha: false, pixels: null }] });
    eq(appTilePool().stats().count, before, "undo 包/旧文档像素全部归还（无泄漏）");
  });
});

// v0.7.8：fill 预览期换色入 undo（事务型，色已被 UI 改掉，run 带 _initialBefore）
describe("operators · FillColor（fill 预览期换色可撤销）", () => {
  it("换色 → undo 回旧色 → redo 回新色（对称 swap 无衰减）", () => {
    const { w, h, ops, color, setColor } = mk();
    setColor("#ff0000");                                     // UI 已改（pre-applied）
    eq(h.run(w, ops.fillColor, { value: "#ff0000", _initialBefore: { v: "#1b1b1b" } }, { label: "fillColor" }).ok, true);
    h.undo(w);
    eq(color(), "#1b1b1b", "undo 回旧色");
    h.redo(w);
    eq(color(), "#ff0000", "redo 回新色");
    h.undo(w);
    eq(color(), "#1b1b1b", "二次 undo 仍精确");
  });

  it("缺 _initialBefore → run 拒绝（防误用为操作型）", () => {
    const { w, h, ops } = mk();
    eq(h.run(w, ops.fillColor, { value: "#00ff00" }).ok, false);
  });
});

// 测试卫生：统一释放（清栈 + 换空文档 = record 驱逐 → tileset 归零还池；防 FR 泄漏 assert 刷屏）
describe("operators 收尾", () => {
  it("清栈并释放本文件的工件资源", () => {
    for (const { h, wp2 } of _ctxs) {
      h.clear();
      wp2.load({ width: 4, height: 4, nodes: [{ name: "空", visible: true, opacity: 1, mode: "source-over", clippingMask: false, lockAlpha: false, pixels: null }] });
    }
    _ctxs.length = 0;
    assert(true, "disposed");
  });
});
