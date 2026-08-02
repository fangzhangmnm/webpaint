// workpiece + undo-history 契约测试（玩具 operator，假 doc——聚合根只存引用，不挑形状）。
// 钉死：对称 swap 往返、checkpoint 整点语义、compound 原子回滚、配额按整 checkpoint 驱逐+dispose、
// 不可恢复协议弃整栈、锁重入 throw、mut() 无锁 throw。这些是 0.4 undo 重构的全部承重墙。
import { describe, it, assert, eq } from "./runner.mjs";
import { Workpiece, DocumentOperator } from "../src/workpiece/workpiece.ts";
import { UndoHistory } from "../src/workpiece/undo-history.ts";

// 玩具状态：doc = { v: number }。SetOp 把 v 设成 args.to，swap 语义（replaced = 旧值）。
class SetOp extends DocumentOperator {
  kind = "set";
  forward(w, args, data) {
    const doc = this.mut(w).doc;
    const old = doc.v;
    doc.v = data !== undefined ? data : args.to;
    return { ok: true, replaced: old };
  }
  backward(w, args, data) {
    const doc = this.mut(w).doc;
    const old = doc.v;
    doc.v = data;
    return { ok: true, replaced: old };
  }
}
class FailOp extends SetOp { kind = "fail"; forward() { return { ok: false, msg: "nope" }; } }
class ThrowOp extends SetOp { kind = "throw"; forward() { throw new Error("boom"); } }
// 配额可变的 op：estimate 读 args.cost()（模拟「压缩后 usage 上涨」）；dispose 记账。
class CostOp extends SetOp {
  kind = "cost";
  estimateQuotaBytes(args) { return args.cost(); }
  disposeData(args) { args.disposed = true; }
}

function mk(opts = {}) {
  const doc = { v: 0 };
  const events = { unrecoverable: 0, changes: 0, applied: [] };
  const h = new UndoHistory({
    maxQuotaBytes: opts.maxQuotaBytes ?? 1 << 30,
    onUnrecoverable: () => { events.unrecoverable++; },
    onChange: () => { events.changes++; },
    onApplied: (i) => { events.applied.push(`${i.dir}:${i.kind}`); },
  });
  const w = new Workpiece(doc, h);
  return { doc, w, h, events, set: new SetOp() };
}

describe("undo-history · 对称 swap 往返", () => {
  it("run → undo → redo → undo，值与 canUndo/canRedo 全程一致", () => {
    const { doc, w, h, set } = mk();
    eq(h.run(w, set, { to: 5 }).ok, true);
    eq(doc.v, 5);
    eq(h.run(w, set, { to: 9 }).ok, true);
    eq(doc.v, 9);
    assert(h.canUndo() && !h.canRedo());
    h.undo(w); eq(doc.v, 5);
    h.undo(w); eq(doc.v, 0);
    assert(!h.canUndo() && h.canRedo());
    h.redo(w); eq(doc.v, 5);
    h.redo(w); eq(doc.v, 9);
    h.undo(w); eq(doc.v, 5);
    eq(w.isDirty, true, "operator 提交置 isDirty");
    assert(w.commitVersion >= 4, "每次提交/undo/redo bump commitVersion");
  });

  it("ok:false 的 op：栈不动、状态由 op 自行保证未变", () => {
    const { doc, w, h } = mk();
    const st = h.run(w, new FailOp(), { to: 7 });
    eq(st.ok, false);
    eq(doc.v, 0);
    assert(!h.canUndo(), "失败不入栈");
  });

  it("undo 过再 run → redo 段被截断且 dispose", () => {
    const { w, h, set } = mk();
    const a1 = { to: 1, cost: () => 8, disposed: false };
    const a2 = { to: 2, cost: () => 8, disposed: false };
    const cost = new CostOp();
    h.run(w, cost, a1);
    h.run(w, cost, a2);
    h.undo(w);
    h.run(w, set, { to: 3 });
    assert(a2.disposed, "被截断的 redo 段必须 dispose（句柄释放）");
    assert(!a1.disposed, "游标下方的不动");
  });
});

describe("undo-history · checkpoint 整点", () => {
  it("三个微步一个封口 → 一次 undo 全回、一次 redo 全来", () => {
    const { doc, w, h, set } = mk();
    h.run(w, set, { to: 1 }, { checkpoint: false });
    h.run(w, set, { to: 2 }, { checkpoint: false });
    h.run(w, set, { to: 3 }, { checkpoint: false });
    h.sealCheckpoint();
    h.undo(w);
    eq(doc.v, 0, "整组回到 0");
    assert(!h.canUndo() && h.canRedo());
    h.redo(w);
    eq(doc.v, 3, "整组重来到 3");
  });

  it("顶端未封口就 undo → 补封再撤（不半途卡住）", () => {
    const { doc, w, h, set } = mk();
    h.run(w, set, { to: 1 });
    h.run(w, set, { to: 2 }, { checkpoint: false });   // 未封口
    h.undo(w);
    eq(doc.v, 1, "未封口的尾组被补封成整点撤掉");
    h.undo(w);
    eq(doc.v, 0);
  });
});

describe("undo-history · compound 原子回滚", () => {
  it("中途失败 → 已入栈微步倒序回滚并弹掉，回到进入前整点", () => {
    const { doc, w, h, set } = mk();
    h.run(w, set, { to: 100 });
    const r = h.compound(w, () => {
      h.run(w, set, { to: 1 }, { checkpoint: false });
      h.run(w, set, { to: 2 }, { checkpoint: false });
      const st = h.run(w, new FailOp(), { to: 3 }, { checkpoint: false });
      if (!st.ok) throw new Error("microstep failed");
      return "unreached";
    });
    eq(r.ok, false);
    eq(doc.v, 100, "回滚到 compound 前");
    h.undo(w);
    eq(doc.v, 0, "上一个整点仍完好可撤");
  });

  it("全成 → 自动封口为一个整点", () => {
    const { doc, w, h, set } = mk();
    const r = h.compound(w, () => {
      h.run(w, set, { to: 1 }, { checkpoint: false });
      h.run(w, set, { to: 2 }, { checkpoint: false });
      return 42;
    });
    eq(r.ok, true); eq(r.value, 42);
    h.undo(w);
    eq(doc.v, 0, "一次 undo 全回");
  });
});

describe("undo-history · 配额驱逐（整 checkpoint + dispose + 重扫）", () => {
  it("超配额 → 最老整组驱逐并 dispose；最新组绝不驱逐", () => {
    const { w, h } = mk({ maxQuotaBytes: 100 });
    const cost = new CostOp();
    const mkArgs = (to) => ({ to, cost: () => 40, disposed: false });
    const a1 = mkArgs(1), a2 = mkArgs(2), a3 = mkArgs(3);
    h.run(w, cost, a1);
    h.run(w, cost, a2);
    eq(h.quotaUsage(), 80, "两组 80 ≤ 100 不驱逐");
    h.run(w, cost, a3);          // 120 > 100 → 驱逐最老
    assert(a1.disposed, "最老组被驱逐并 dispose");
    assert(!a2.disposed && !a3.disposed);
    eq(h.quotaUsage(), 80);
  });

  it("单步 usage 事后上涨（模拟 tile 被压缩）→ 下次 push 重扫触发驱逐", () => {
    const { w, h } = mk({ maxQuotaBytes: 100 });
    const cost = new CostOp();
    let grow = 10;
    const a1 = { to: 1, cost: () => grow, disposed: false };
    const a2 = { to: 2, cost: () => 10, disposed: false };
    h.run(w, cost, a1);
    h.run(w, cost, a2);
    grow = 500;                              // a1 的 tile「被压缩后归本栈 own」→ usage 涨
    const a3 = { to: 3, cost: () => 10, disposed: false };
    h.run(w, cost, a3);                      // push 重扫 → 驱逐 a1
    assert(a1.disposed, "重扫看见上涨 → 驱逐");
    assert(!a2.disposed);
  });

  it("clear 弃整栈并 dispose 全部", () => {
    const { w, h } = mk();
    const cost = new CostOp();
    const a1 = { to: 1, cost: () => 1, disposed: false };
    h.run(w, cost, a1);
    h.clear();
    assert(a1.disposed);
    assert(!h.canUndo() && !h.canRedo());
  });
});

describe("undo-history · 不可恢复协议 + 锁", () => {
  it("operator 抛异常（非原子失败）→ 弃整栈 + onUnrecoverable", () => {
    const { w, h, events, set } = mk();
    h.run(w, set, { to: 1 });
    h.run(w, new ThrowOp(), { to: 2 });
    eq(events.unrecoverable, 1);
    assert(!h.canUndo(), "整栈已弃（undo 不可信）");
    assert(!w._isLocked(), "锁必须已释放（finally 语义）");
  });

  it("undo 途中 backward 抛异常 → 同样弃栈上报", () => {
    class BadBack extends SetOp { kind = "badback"; backward() { throw new Error("corrupt"); } }
    const { w, h, events } = mk();
    h.run(w, new BadBack(), { to: 1 });
    eq(h.undo(w), false);
    eq(events.unrecoverable, 1);
    assert(!h.canUndo());
  });

  it("operator 里嵌套 run（重入）→ 锁拒绝 → 走不可恢复（两层保险生效）", () => {
    const { w, h, events, set } = mk();
    const self = h;
    class Nested extends SetOp {
      kind = "nested";
      forward(wp, args, data) { self.run(wp, set, { to: 9 }); return super.forward(wp, args, data); }
    }
    h.run(w, new Nested(), { to: 1 });
    eq(events.unrecoverable, 1, "嵌套 operator 被锁拒绝并按非原子异常处理");
  });

  it("mut() 无锁直调 → throw（privacy 第二道门）", () => {
    const { w } = mk();
    class Sneaky extends SetOp { kind = "sneak"; peek(wp) { return this.mut(wp); } }
    let threw = false;
    try { new Sneaky().peek(w); } catch { threw = true; }
    assert(threw, "锁外 mut() 必须 throw");
  });

  it("onApplied 事件流带方向与 kind（app 接 toast/面板刷新）", () => {
    const { w, h, events, set } = mk();
    h.run(w, set, { to: 1 });
    h.undo(w);
    h.redo(w);
    eq(JSON.stringify(events.applied), JSON.stringify(["do:set", "undo:set", "redo:set"]));
  });
});
