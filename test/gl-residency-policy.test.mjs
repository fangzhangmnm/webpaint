// 驱逐决策的纯逻辑（v440 / R10 + 修 H 的补测）。
//
// 背景：GLDocRenderer 的构造函数急切创建 4 个 GL 对象，类在 node 里造不出来。v439 就是拿这个当
// 理由，把修 G/H 的那两个新方法**一条测试都没写**。但 drainPendingEvict 的判定一个 GL 对象都不碰
// ——「类构造不了」不等于「逻辑测不了」。这里把判定抽成 planEvictions 后补上覆盖。
//
// 承重不变量（修 H 得来的）：**已离树的叶永不驱逐**。它的像素此刻只剩 CPU raw 这一份
// （GPU tiles 已被 syncAll 的树差对账回收），驱逐即永久丢失 + 撤销复活空壳层 + 每帧抛
// LAYER_NOT_SYNCED。
import { describe, it, assert, eq } from "./runner.mjs";
import { planEvictions } from "../src/gl/gl-doc-renderer.ts";

const leaf = (id) => ({ id, isGroup: false });

describe("planEvictions · 驱逐决策（R10 + 修 H）", () => {
  it("★已离树的叶：永不驱逐，且从待办里移除", () => {
    const a = leaf(1);
    const plan = planEvictions([a], new Set(), () => true);
    eq(plan.evict.length, 0, "离树的叶绝不驱逐（它的像素只剩 CPU 这一份）");
    eq(plan.keep.size, 0, "也不该留在待办里（这个对象身份不会再回到树上）");
  });

  it("在树 + GPU 已有 tiles → 驱逐", () => {
    const a = leaf(1);
    const plan = planEvictions([a], new Set([a]), () => true);
    eq(plan.evict.length, 1, "可以驱逐");
    assert(plan.evict[0] === a, "就是它");
    eq(plan.keep.size, 0, "已处理，不留待办");
  });

  it("在树但 GPU 上还没有 tiles → 留到下一帧（驱逐后无处 readback）", () => {
    const a = leaf(1);
    const plan = planEvictions([a], new Set([a]), () => false);
    eq(plan.evict.length, 0, "此刻不驱逐");
    eq(plan.keep.size, 1, "留着，等下次 syncAll 之后再说");
  });

  it("★多个待办不会互相覆盖（R10：单槽会让先登记的永不被驱逐）", () => {
    const a = leaf(1), b = leaf(2), c = leaf(3);
    const live = new Set([a, b, c]);
    const plan = planEvictions([a, b, c], live, () => true);
    eq(plan.evict.length, 3, "三个都要被驱逐（render 早返回期间攒下的待办不能丢）");
  });

  it("身份按**对象**而非 id 判定（id 会被 insertLayerAt 复用）", () => {
    const stale = leaf(7);          // 旧对象
    const fresh = leaf(7);          // 同 id、不同对象（restoreSnapshotAll 重建过）
    const plan = planEvictions([stale], new Set([fresh]), () => true);
    eq(plan.evict.length, 0, "同 id 但不是同一个对象 → 不驱逐（那是别人的层）");
    eq(plan.keep.size, 0, "陈旧对象从待办移除，不长期滞留");
  });

  it("混合场景：可驱逐的驱逐、待定的保留、离树的丢弃", () => {
    const ok = leaf(1), pending = leaf(2), gone = leaf(3);
    const live = new Set([ok, pending]);
    const plan = planEvictions([ok, pending, gone], live, (id) => id === 1);
    eq(plan.evict.length, 1, "只驱逐 ok");
    assert(plan.evict[0] === ok);
    eq(plan.keep.size, 1, "pending 留下");
    assert(plan.keep.has(pending));
  });
});
