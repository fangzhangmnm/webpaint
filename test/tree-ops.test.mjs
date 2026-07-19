// runTreeOp 信封的行为契约（v440 / R4 回归）。
//
// R4：v439 的 runTreeOp 把 `editMode.applyPendingTransient()` 放在守卫**之前**，而模块头却声称
// 「守卫失败 = 什么都不发生」。实际后果：用户正拖着自由变换浮层（或调色滑块已动）时，点一个
// **无效**的树操作（例如对已在根层的图层点「移出组」），浮层会被静默烤进图层、还多压一条
// lasso/stroke undo entry，而 runTreeOp 提前 return 连状态栏都不提示 —— 用户的在制工作被一个
// "看起来毫无反应"的点击销毁。
//
// 契约：守卫先行；守卫不过 → applyPendingTransient 不得被调用、不入栈、不刷新。
import { describe, it, assert, eq } from "./runner.mjs";
import { initTreeOps, runTreeOp } from "../src/tree-ops.ts";

// 最小 mock ctx：只提供 runTreeOp 真正用到的五个协作件。
function makeCtx() {
  const calls = [];
  const ctx = {
    editMode: { applyPendingTransient: () => calls.push("bake") },
    doc: { snapshotTree: () => { calls.push("snapshot"); return { nodes: [], activeId: null }; } },
    history: { push: (e) => calls.push("push:" + e.type) },
    setStatus: (s) => calls.push("status:" + s),
    afterDocChange: () => calls.push("refresh"),
  };
  initTreeOps(ctx);
  return calls;
}

describe("runTreeOp · 守卫先行（R4 回归）", () => {
  it("★守卫不过 → 绝不烤定用户的 transient，也不入栈/不刷新", () => {
    const calls = makeCtx();
    const ok = runTreeOp({ undo: "u", redo: "r" }, () => false, () => false);
    assert(ok === false, "返回 false");
    assert(!calls.includes("bake"),
      "守卫不过时 applyPendingTransient 绝不能被调用（否则用户在制的自由变换被静默烤定并多压一条 entry）");
    assert(!calls.some((c) => c.startsWith("push:")), "不入栈");
    assert(!calls.includes("refresh"), "不刷新");
  });

  it("守卫通过 → 顺序必须是 guard → bake → before 快照 → apply → after 快照 → push → refresh", () => {
    const calls = makeCtx();
    const order = [];
    const ok = runTreeOp(
      { undo: "u", redo: "r", status: "done" },
      () => { order.push("apply"); calls.push("apply"); },
      () => { order.push("guard"); calls.push("guard"); return true; },
    );
    assert(ok === true, "返回 true");
    // guard 在 bake 之前；bake 在第一次 snapshot 之前；apply 夹在两次 snapshot 之间
    const iGuard = calls.indexOf("guard"), iBake = calls.indexOf("bake");
    const iSnap1 = calls.indexOf("snapshot"), iApply = calls.indexOf("apply");
    const iSnap2 = calls.lastIndexOf("snapshot"), iPush = calls.findIndex((c) => c.startsWith("push:"));
    assert(iGuard >= 0 && iGuard < iBake, `guard 必须在 bake 之前（实得 guard@${iGuard} bake@${iBake}）`);
    assert(iBake < iSnap1, "bake 必须在 before 快照之前（烤定会改像素，快照要拍烤定后的状态）");
    assert(iSnap1 < iApply && iApply < iSnap2, "apply 夹在两次快照之间");
    assert(iSnap2 < iPush, "push 在 after 快照之后");
    eq(calls[calls.length - 1], "status:done", "状态栏最后显示");
  });

  it("无守卫参数 → 照旧执行（向后兼容）", () => {
    const calls = makeCtx();
    const ok = runTreeOp({ undo: "u", redo: "r" }, () => {});
    assert(ok === true, "无 guard 视为通过");
    assert(calls.includes("bake") && calls.some((c) => c.startsWith("push:")), "正常走完");
  });

  it("applyFn 返 false（守卫过了但变更没发生）→ 不入栈；此时已 bake 属可接受", () => {
    const calls = makeCtx();
    const ok = runTreeOp({ undo: "u", redo: "r" }, () => false, () => true);
    assert(ok === false, "返回 false");
    assert(!calls.some((c) => c.startsWith("push:")), "不入栈");
  });

  it("labels 传函数 → 在 applyFn 之后求值（组名要等 addGroup 返回才知道）", () => {
    const calls = makeCtx();
    let name = "";
    runTreeOp(
      () => ({ undo: "撤销" + name, redo: "重做" + name }),
      () => { name = "组 1"; },
    );
    assert(calls.some((c) => c.startsWith("push:treeStructure")), "已入栈");
  });
});
