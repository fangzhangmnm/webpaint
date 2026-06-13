// 主笔刷平滑 StrokeSmoother：时间常数指数追踪 out += (pen−out)·(1−exp(−dt/tau))。
// 详 docs/brush-procreate-smoothing.md。验：固定时间滞后 / 帧率(采样率)无关 / 死区 / 收尾钉终点 / 因果。
import { describe, it, assert } from "./runner.mjs";
import { StrokeSmoother } from "../src/stroke-smoother.js";

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
// 按固定 dt(ms) 喂一串点（带时间戳）
const feedT = (sm, pts, dt = 10) => { let t = 0; for (const [x, y, p = 0.5] of pts) { sm.push(x, y, p, t); t += dt; } };
// 沿 +x 匀速 v(px/ms) 喂到 X，步长 dt → 返回稳态滞后 (lastX − out.x)
function rampLag(tau, v, dt, X) {
  const sm = new StrokeSmoother({ tau });
  let t = 0, x = 0;
  for (; x <= X; x += v * dt) { sm.push(x, 0, 0.5, t); t += dt; }
  const lastX = x - v * dt;
  return lastX - sm._ox;
}

describe("stroke-smoother · StrokeSmoother（时间常数指数追踪）", () => {
  it("tau=0：直通（out = raw，无平滑）", () => {
    const sm = new StrokeSmoother({ tau: 0 });
    feedT(sm, [[0, 0], [10, 0], [37, 0]], 10);
    const last = sm.count - 1;
    assert(near(sm.cx[last], 37) && near(sm.cy[last], 0), `tau=0 应直通，实得(${sm.cx[last]},${sm.cy[last]})`);
  });

  it("固定时间滞后：匀速时稳态滞后 ≈ v·tau（二阶 SmoothDamp，时间制）", () => {
    const lag = rampLag(50, 1, 10, 400);       // 二阶临界阻尼跟 ramp 滞后 ≈ v·smoothTime = 50px
    assert(lag > 35 && lag < 60, `稳态滞后应 ≈ v·tau=50px，实得 ${lag.toFixed(1)}`);
  });

  it("滞后随 tau 线性（tau 翻倍 → 滞后≈翻倍）", () => {
    const l1 = rampLag(40, 1, 8, 500), l2 = rampLag(80, 1, 8, 500);
    assert(l2 / l1 > 1.7 && l2 / l1 < 2.3, `tau 翻倍滞后应≈翻倍，实得 ${l1.toFixed(1)}→${l2.toFixed(1)}`);
  });

  it("采样率（帧率）无关：同 tau/同速、dt=4 vs dt=16 → 稳态滞后接近（dt≪tau）", () => {
    const a = rampLag(120, 1, 4, 800), b = rampLag(120, 1, 16, 800);
    assert(Math.abs(a - b) / a < 0.12, `稳态滞后应近采样率无关，实得 dt4=${a.toFixed(1)} dt16=${b.toFixed(1)}`);
  });

  it("顿涌现：慢速段滞后小（贴笔）、快速段滞后大（重平滑）", () => {
    const slow = rampLag(80, 0.2, 8, 200);     // 慢：滞后 = 速度×tau 小
    const fast = rampLag(80, 2.0, 8, 800);     // 快：滞后大
    assert(slow < fast * 0.3, `慢速滞后应远小于快速（顿涌现），实得 slow=${slow.toFixed(1)} fast=${fast.toFixed(1)}`);
  });

  it("收尾 finish：钉终点（画到头）", () => {
    const sm = new StrokeSmoother({ tau: 60 });
    const line = []; for (let x = 0; x <= 200; x += 5) line.push([x, 0]);
    feedT(sm, line, 8); sm.finish();
    const last = sm.count - 1;
    assert(near(sm.cx[last], 200, 1e-9) && near(sm.cy[last], 0, 1e-9), `收尾应钉终点(200,0)，实得(${sm.cx[last]},${sm.cy[last]})`);
  });

  it("死区：纯亚半径抖动被吃掉（笔尖钉原位）", () => {
    const sm = new StrokeSmoother({ tau: 0, deadzone: 5 });
    feedT(sm, [[0, 0], [3, 0], [0, 0], [3, 0], [-2, 0]], 10);
    assert(Math.abs(sm._ox) <= 5, `亚半径抖动应被死区钉住，实得 ${sm._ox.toFixed(2)}`);
  });

  it("因果：已提交点永不回改（后续 push 不动旧点）", () => {
    const sm = new StrokeSmoother({ tau: 50 });
    feedT(sm, [[0, 0], [10, 0], [20, 0], [30, 0]], 10);
    const snapX = sm.cx.slice(0, sm._committed), snapY = sm.cy.slice(0, sm._committed);
    sm.push(40, 20, 0.5, 50); sm.push(40, 60, 0.5, 60);
    for (let i = 0; i < snapX.length; i++) assert(near(sm.cx[i], snapX[i]) && near(sm.cy[i], snapY[i]), `点 ${i} 被回改`);
  });

  it("seq 每 push +1；frozenIndex=_committed−1；单点 tap", () => {
    const sm = new StrokeSmoother({ tau: 50 });
    sm.push(5, 5, 0.8, 0);
    assert(sm.seq === 1 && sm.count === 1 && sm.frozenIndex() === 0, `tap 应 seq1/count1/fi0，实得 ${sm.seq}/${sm.count}/${sm.frozenIndex()}`);
    sm.push(6, 5, 0.8, 10); sm.push(7, 5, 0.8, 20);
    assert(sm.frozenIndex() === sm._committed - 1, `frozenIndex 应 = _committed-1`);
  });

  it("贴笔尖弧 tail：画途中末点 = pen（线贴到光标）", () => {
    const sm = new StrokeSmoother({ tau: 100 });   // 重平滑 → out 明显滞后 → 有 tail
    let t = 0; for (let x = 0; x <= 200; x += 10) { sm.push(x, 0, 0.5, t); t += 8; }
    const last = sm.count - 1;
    assert(near(sm.cx[last], 200, 1e-6) && near(sm.cy[last], 0, 1e-6), `tail 末点应=pen(200,0)，实得(${sm.cx[last]},${sm.cy[last]})`);
    assert(sm.count > sm._committed, `应有 transient tail（count ${sm.count} > _committed ${sm._committed}）`);
    assert(sm._ox < 200, `out（时间缓冲）应滞后于 pen（${sm._ox.toFixed(1)} < 200）`);
  });

  it("弧 tail：直行 → 直线 tail；弯笔 → 鼓向外的弧", () => {
    const tailDev = (pts, bow) => {
      const sm = new StrokeSmoother({ tau: 100, tailBow: bow });
      let t = 0; for (const [x, y] of pts) { sm.push(x, y, 0.5, t); t += 8; }
      const ax = sm.cx[sm._committed - 1], ay = sm.cy[sm._committed - 1];   // out（tail 起点）
      const bx = sm.cx[sm.count - 1], by = sm.cy[sm.count - 1];             // pen（tail 末点）
      const len = Math.hypot(bx - ax, by - ay) || 1; let max = 0;
      for (let i = sm._committed; i < sm.count - 1; i++)
        max = Math.max(max, Math.abs((bx - ax) * (ay - sm.cy[i]) - (ax - sm.cx[i]) * (by - ay)) / len);
      return max;
    };
    const straight = []; for (let x = 0; x <= 200; x += 8) straight.push([x, 0]);
    const curve = []; for (let k = 0; k <= 40; k++) { const a = k / 40 * Math.PI / 2; curve.push([100 * Math.cos(a), 100 * Math.sin(a)]); }
    assert(tailDev(straight, 1) < 0.5, `直行 tail 应是直线，离弦=${tailDev(straight, 1).toFixed(2)}`);
    assert(tailDev(curve, 2) > 1, `弯笔 tail 应鼓成动量弧，离弦=${tailDev(curve, 2).toFixed(2)}`);
  });

  it("方案B（一阶 EMA + heading Bézier）：滞后≈v·tau；直行直 / 弯笔弧；末点=pen", () => {
    // 滞后
    const sm = new StrokeSmoother({ tau: 50, firstOrder: true });
    let t = 0, x = 0; for (; x <= 400; x += 10) { sm.push(x, 0, 0.5, t); t += 10; }
    const lag = (x - 10) - sm._ox;
    assert(lag > 40 && lag < 70, `B 稳态滞后应 ≈v·tau，实得 ${lag.toFixed(1)}`);
    // 直行直 / 弯笔弧
    const tailDev = (pts, bow) => {
      const s = new StrokeSmoother({ tau: 100, tailBow: bow, firstOrder: true });
      let tt = 0; for (const [px, py] of pts) { s.push(px, py, 0.5, tt); tt += 8; }
      const ax = s.cx[s._committed - 1], ay = s.cy[s._committed - 1], bx = s.cx[s.count - 1], by = s.cy[s.count - 1];
      assert(near(bx, pts[pts.length - 1][0], 1e-6) && near(by, pts[pts.length - 1][1], 1e-6), "B tail 末点应=pen");
      const len = Math.hypot(bx - ax, by - ay) || 1; let m = 0;
      for (let i = s._committed; i < s.count - 1; i++) m = Math.max(m, Math.abs((bx - ax) * (ay - s.cy[i]) - (ax - s.cx[i]) * (by - ay)) / len);
      return m;
    };
    const straight = []; for (let px = 0; px <= 200; px += 8) straight.push([px, 0]);
    const curve = []; for (let k = 0; k <= 40; k++) { const a = k / 40 * Math.PI / 2; curve.push([100 * Math.cos(a), 100 * Math.sin(a)]); }
    assert(tailDev(straight, 1) < 0.5, `B 直行 tail 应直，离弦=${tailDev(straight, 1).toFixed(2)}`);
    assert(tailDev(curve, 2) > 1, `B 弯笔 tail 应鼓，离弦=${tailDev(curve, 2).toFixed(2)}`);
  });

  it("finish = 弧 tail 整段转正（预览所见即所得，点不动）", () => {
    const sm = new StrokeSmoother({ tau: 80 });
    let t = 0; for (let x = 0; x <= 150; x += 10) { sm.push(x, x * 0.3, 0.5, t); t += 8; }
    const snapX = sm.cx.slice(), snapY = sm.cy.slice();
    sm.finish();
    assert(sm.count === snapX.length, `finish 不应改点数（${sm.count} vs ${snapX.length}）`);
    for (let i = 0; i < snapX.length; i++) assert(near(sm.cx[i], snapX[i]) && near(sm.cy[i], snapY[i]), `finish 改了点 ${i}`);
  });

  it("无时间戳（合成笔触）：用名义 dt 兜底，不崩、仍平滑", () => {
    const sm = new StrokeSmoother({ tau: 50 });
    sm.push(0, 0, 1); sm.push(50, 0, 1); sm.push(100, 0, 1);   // 无 t
    assert(sm._ox > 0 && sm._ox < 100, `无时间戳应兜底平滑（0<out<100），实得 ${sm._ox.toFixed(1)}`);
  });
});
