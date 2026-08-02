// v0.8.4 · S4「割3」write-gate 行为锁（ADR-0007）：PaintDoc mutator 窗口外裸调 → violation；
// 声明窗口（operator 锁 / component 创建段 / treeTx mutate 段 / docWriteWindow）内静默。
// ⚠ gate 是模块级单例：每条测试 arm 后必须 finally 里 disarm（armDocWriteGate(null)），
//   否则毒到后面所有直捅 doc 的引擎级测试文件。
import { describe, it, assert, eq } from "./runner.mjs";
import { PaintDoc, flattenLeaves } from "../src/doc.ts";
import { Workpiece } from "../src/workpiece/workpiece.ts";
import { UndoHistory } from "../src/workpiece/undo-history.ts";
import { makeOperators } from "../src/workpiece/operators.ts";
import { LayerTree } from "../src/workpiece/layer-tree.ts";
import { armDocWriteGate, docWriteWindow, enterDocWrite, exitDocWrite } from "../src/workpiece/write-gate.ts";

const _ctxs = [];
function mk() {
  const doc = new PaintDoc({ width: 64, height: 64 });
  const h = new UndoHistory({ maxQuotaBytes: 1 << 30, onUnrecoverable: () => {} });
  const w = new Workpiece(doc, h);
  const ops = makeOperators({ applyDocTransformUi: () => {}, fillColor: { get: () => "#000", set: () => {} } });
  const lt = new LayerTree({ w, doc, history: h, ops });
  _ctxs.push({ doc, h });
  return { doc, w, h, ops, lt };
}
function withArmed(fn) {
  const hits = [];
  armDocWriteGate((what) => hits.push(what));
  try { fn(hits); } finally { armDocWriteGate(null); }
  return hits;
}

describe("write-gate · 割3 断言", () => {
  it("未武装（node 测试默认）：裸调静默", () => {
    const { doc } = mk();
    doc.addLayer("裸");   // 不炸
    eq(flattenLeaves(doc.layers).length, 2, "裸调生效（引擎级测试合法姿势）");
  });

  it("武装后：窗口外裸调 → violation 点名方法", () => {
    const { doc } = mk();
    const hits = withArmed(() => {
      doc.addLayer("越狱");
      doc.setActiveById(doc.layers[0].id);
    });
    eq(hits.join(","), "addLayer,setActiveById", "逐个点名");
  });

  it("component 写面（addLayer/setActive/treeTx）不触发", () => {
    const { doc, lt } = mk();
    const hits = withArmed(() => {
      const a = lt.addLayer("合规");
      assert(a.ok, "component 加层 ok");
      lt.setActive(doc.layers[0].id);
      const r = lt.treeTx((d) => d.addGroup("组"));
      assert(r.ok, "treeTx ok");
    });
    eq(hits.length, 0, "全程零 violation");
  });

  it("operator 锁内（history.run 驱动的 forward/backward）不触发", () => {
    const { doc, w, h, ops, lt } = mk();
    lt.addLayer("层2");
    const hits = withArmed(() => {
      // RemoveLayerRecordOp.forward 在锁内调 doc.removeLayer/layerSpec；backward 调 insertLayerAt/setActiveById
      const st = h.run(w, ops.removeLayer, { layerId: doc.activeId, layerName: "层2" });
      assert(st.ok, "run ok");
      h.undo(w);
      h.redo(w);
    });
    eq(hits.length, 0, "锁内写全程零 violation");
  });

  it("docWriteWindow 可重入 + enter/exit 配对", () => {
    const { doc } = mk();
    const hits = withArmed(() => {
      docWriteWindow(() => docWriteWindow(() => doc.addLayer("嵌套窗")));
      enterDocWrite();
      try { doc.addLayer("手动窗"); } finally { exitDocWrite(); }
      doc.addLayer("窗外");
    });
    eq(hits.join(","), "addLayer", "只有窗外那次被点名");
  });
});

describe("write-gate 收尾", () => {
  it("清栈并释放本文件 doc tiles（gate 已解除武装）", () => {
    armDocWriteGate(null);   // 防御性再解除（毒不得后面的引擎级测试）
    for (const { doc, h } of _ctxs) {
      h.clear();
      for (const leaf of flattenLeaves(doc.layers)) leaf.pixels?.dispose?.();
      doc.selection?.dispose?.();
    }
    _ctxs.length = 0;
    assert(true, "disposed");
  });
});
