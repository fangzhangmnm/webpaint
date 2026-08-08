// v0.8.4 · S4「割3」write-gate 机械行为锁（ADR-0007）——**T3b-2 裁边**：app 已不再武装 gate
// （PaintDoc 出局，「裸写不可能」由 v2 令牌墙结构性给出，锚在 undo-stack-integrity.test ①）。
// 本文件只剩 gate 模块自身的机械契约（arm/violation 点名/窗口重入配对），随 write-gate.ts 在 T5 一起拆。
// ⚠ gate 是模块级单例：每条测试 arm 后必须 finally 里 disarm（armDocWriteGate(null)），
//   否则毒到后面所有直捅 doc 的引擎级测试文件。
import { describe, it, assert, eq } from "./runner.mjs";
import { PaintDoc, flattenLeaves } from "../src/doc.ts";
import { armDocWriteGate, docWriteWindow, enterDocWrite, exitDocWrite } from "../src/workpiece/write-gate.ts";

const _docs = [];
function mkDoc() {
  const doc = new PaintDoc({ width: 64, height: 64 });
  _docs.push(doc);
  return doc;
}
function withArmed(fn) {
  const hits = [];
  armDocWriteGate((what) => hits.push(what));
  try { fn(hits); } finally { armDocWriteGate(null); }
  return hits;
}

describe("write-gate · 机械契约（T5 随模块拆）", () => {
  it("未武装（node 测试默认）：裸调静默", () => {
    const doc = mkDoc();
    doc.addLayer("裸");   // 不炸
    eq(flattenLeaves(doc.layers).length, 2, "裸调生效（引擎级测试合法姿势）");
  });

  it("武装后：窗口外裸调 → violation 点名方法", () => {
    const doc = mkDoc();
    const hits = withArmed(() => {
      doc.addLayer("越狱");
      doc.setActiveById(doc.layers[0].id);
    });
    eq(hits.join(","), "addLayer,setActiveById", "逐个点名");
  });

  it("docWriteWindow 可重入 + enter/exit 配对", () => {
    const doc = mkDoc();
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
  it("释放本文件 doc tiles（gate 已解除武装）", () => {
    armDocWriteGate(null);   // 防御性再解除（毒不得后面的引擎级测试）
    for (const doc of _docs) {
      for (const leaf of flattenLeaves(doc.layers)) leaf.pixels?.dispose?.();
      doc.selection?.dispose?.();
    }
    _docs.length = 0;
    assert(true, "disposed");
  });
});
