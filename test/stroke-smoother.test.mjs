// 主笔刷平滑 StrokeSmoother：Procreate EMA + 死区 + 贴笔尖契约。doc px。
// 详 docs/brush-procreate-smoothing.md。验：贴笔尖 / 因果不回改 / 帧率无关 / 死区 / frozenIndex 契约。
import { describe, it, assert } from "./runner.mjs";
import { StrokeSmoother } from "../src/stroke-smoother.js";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const feed = (sm, pts) => { for (const [x, y, p = 0.5] of pts) sm.push(x, y, p); };

describe("stroke-smoother · StrokeSmoother（EMA + 死区 + 贴笔尖）", () => {
  it("笔尖 = raw（stab=0）：最后一个顶点永远 = 最新 raw（贴指）", () => {
    const sm = new StrokeSmoother({ step: 10, a: 0.5, deadzone: 0 });
    feed(sm, [[0, 0], [37, 0], [88, 0]]);
    const last = sm.count - 1;
    assert(near(sm.cx[last], 88) && near(sm.cy[last], 0), `笔尖应 = raw(88,0)，实得(${sm.cx[last]},${sm.cy[last]})`);
  });

  it("frozenIndex = 提交锚点数−1（笔尖永不冻）", () => {
    const sm = new StrokeSmoother({ step: 10, a: 0.5 });
    feed(sm, [[0, 0], [100, 0]]);
    assert(sm.frozenIndex() === sm.count - 2, `frozenIndex 应 = count-2，实得 ${sm.frozenIndex()} / count ${sm.count}`);
  });

  it("单点 tap：count=1，frozenIndex=−1（无可冻锚点）", () => {
    const sm = new StrokeSmoother({ step: 10, a: 0.5 });
    sm.push(5, 5, 0.8);
    assert(sm.count === 1 && sm.frozenIndex() === -1, `tap 应 count=1/fi=-1，实得 ${sm.count}/${sm.frozenIndex()}`);
    assert(near(sm.cx[0], 5) && near(sm.cy[0], 5), "tap 顶点 = raw");
  });

  it("seq 每 push +1（overlay 缓存键，慢速不落锚也要刷 tail）", () => {
    const sm = new StrokeSmoother({ step: 100, a: 0.5 });
    sm.push(0, 0); sm.push(1, 0); sm.push(2, 0);   // 位移 < step，不落锚点但 seq 仍推进
    assert(sm.seq === 3, `seq 应 = 3，实得 ${sm.seq}`);
  });

  it("EMA 因果：已提交锚点永不回改（后续 push 不动旧锚点）", () => {
    const sm = new StrokeSmoother({ step: 10, a: 0.6 });
    feed(sm, [[0, 0], [50, 0]]);
    const snap = sm.cx.slice(0, sm._committed);
    feed(sm, [[50, 40], [50, 90]]);                // 继续画，拐弯
    for (let i = 0; i < snap.length; i++) assert(near(sm.cx[i], snap[i]), `锚点 ${i} 被回改：${snap[i]}→${sm.cx[i]}`);
  });

  it("a=0：提交锚点落在原始直线上（重采样直通，无平滑偏移）", () => {
    const sm = new StrokeSmoother({ step: 10, a: 0, deadzone: 0 });
    feed(sm, [[0, 0], [100, 0]]);
    for (let i = 0; i < sm._committed; i++) assert(near(sm.cy[i], 0), `a=0 锚点应在 y=0 线上，锚点 ${i} y=${sm.cy[i]}`);
  });

  it("帧率无关：同几何不同事件密度 → 提交锚点逐点相同", () => {
    const A = new StrokeSmoother({ step: 10, a: 0.5 });
    const B = new StrokeSmoother({ step: 10, a: 0.5 });
    A.push(0, 0); A.push(100, 0);                                  // 一大步
    B.push(0, 0); for (let x = 10; x <= 100; x += 10) B.push(x, 0); // 十小步
    assert(A._committed === B._committed, `锚点数应相等：${A._committed} vs ${B._committed}`);
    for (let i = 0; i < A._committed; i++)
      assert(near(A.cx[i], B.cx[i], 1e-6), `锚点 ${i} 不一致：${A.cx[i]} vs ${B.cx[i]}`);
  });

  it("死区：纯亚半径抖动被完全吃掉（不落锚点、笔尖钉原位）", () => {
    const sm = new StrokeSmoother({ step: 5, a: 0, deadzone: 5 });
    feed(sm, [[0, 0], [3, 0], [0, 0], [3, 0], [-2, 0]]);   // 全程位移 < 5
    assert(sm._committed === 0, `亚半径抖动不应落锚点，实得 ${sm._committed}`);
    assert(Math.abs(sm.cx[sm.count - 1]) <= 5, "笔尖被死区钉在原点附近");
  });

  it("死区：超半径运动照常通过（按 d−r 前进）", () => {
    const sm = new StrokeSmoother({ step: 10, a: 0, deadzone: 5 });
    sm.push(0, 0); sm.push(20, 0);                          // d=20>r=5 → 去抖点到 15
    const last = sm.count - 1;
    assert(near(sm.cx[last], 15), `去抖笔尖应到 15，实得 ${sm.cx[last]}`);
  });
});
