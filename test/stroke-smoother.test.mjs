// 主笔刷平滑 StrokeSmoother：Procreate SmoothDamp（二阶临界阻尼）+ 死区 + 贴笔尖 + 弧线收笔。doc px。
// 详 docs/brush-procreate-smoothing.md。验：贴笔尖 / 因果不回改 / 帧率无关 / 死区 / 收笔弧线 / frozenIndex 契约。
import { describe, it, assert } from "./runner.mjs";
import { StrokeSmoother } from "../src/stroke-smoother.js";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const feed = (sm, pts) => { for (const [x, y, p = 0.5] of pts) sm.push(x, y, p); };

describe("stroke-smoother · StrokeSmoother（SmoothDamp + 死区 + 弧线收笔）", () => {
  it("笔尖 = raw（stab=0）：最后顶点永远 = 最新 raw（贴指）", () => {
    const sm = new StrokeSmoother({ step: 10, lag: 20, deadzone: 0 });
    feed(sm, [[0, 0], [37, 0], [88, 0]]);
    const last = sm.count - 1;
    assert(near(sm.cx[last], 88) && near(sm.cy[last], 0), `笔尖应 = raw(88,0)，实得(${sm.cx[last]},${sm.cy[last]})`);
  });

  it("frozenIndex = 提交锚点数−1（弧 tail 永不冻）", () => {
    const sm = new StrokeSmoother({ step: 10, lag: 20 });
    feed(sm, [[0, 0], [100, 0]]);
    assert(sm.frozenIndex() === sm._committed - 1, `frozenIndex 应 = _committed-1，实得 ${sm.frozenIndex()} / _committed ${sm._committed}`);
    assert(sm.count > sm._committed, `弧 tail 应在提交段之后（count ${sm.count} > _committed ${sm._committed}）`);
  });

  it("单点 tap：count=1，frozenIndex=−1（无可冻锚点）", () => {
    const sm = new StrokeSmoother({ step: 10, lag: 20 });
    sm.push(5, 5, 0.8);
    assert(sm.count === 1 && sm.frozenIndex() === -1, `tap 应 count=1/fi=-1，实得 ${sm.count}/${sm.frozenIndex()}`);
    assert(near(sm.cx[0], 5) && near(sm.cy[0], 5), "tap 顶点 = raw");
  });

  it("seq 每 push +1（overlay 缓存键，慢速不落锚也要刷 tail）", () => {
    const sm = new StrokeSmoother({ step: 100, lag: 50 });
    sm.push(0, 0); sm.push(1, 0); sm.push(2, 0);   // 位移 < step，不落锚但 seq 仍推进
    assert(sm.seq === 3, `seq 应 = 3，实得 ${sm.seq}`);
  });

  it("因果：已提交锚点永不回改（后续 push 不动旧锚点）", () => {
    const sm = new StrokeSmoother({ step: 10, lag: 24 });
    feed(sm, [[0, 0], [50, 0]]);
    const snapX = sm.cx.slice(0, sm._committed), snapY = sm.cy.slice(0, sm._committed);
    feed(sm, [[50, 40], [50, 90]]);                // 继续画，拐弯
    for (let i = 0; i < snapX.length; i++)
      assert(near(sm.cx[i], snapX[i]) && near(sm.cy[i], snapY[i]), `锚点 ${i} 被回改`);
  });

  it("lag=0：提交锚点落在原始直线上（重采样直通，无平滑偏移）", () => {
    const sm = new StrokeSmoother({ step: 10, lag: 0, deadzone: 0 });
    feed(sm, [[0, 0], [100, 0]]);
    for (let i = 0; i < sm._committed; i++) assert(near(sm.cy[i], 0), `lag=0 锚点应在 y=0，锚点 ${i} y=${sm.cy[i]}`);
  });

  it("帧率无关：同几何不同事件密度 → 提交锚点逐点相同", () => {
    const A = new StrokeSmoother({ step: 10, lag: 20 });
    const B = new StrokeSmoother({ step: 10, lag: 20 });
    A.push(0, 0); A.push(100, 0);                                  // 一大步
    B.push(0, 0); for (let x = 10; x <= 100; x += 10) B.push(x, 0); // 十小步
    assert(A._committed === B._committed, `锚点数应相等：${A._committed} vs ${B._committed}`);
    for (let i = 0; i < A._committed; i++)
      assert(near(A.cx[i], B.cx[i], 1e-6) && near(A.cy[i], B.cy[i], 1e-6), `锚点 ${i} 不一致`);
  });

  it("死区：纯亚半径抖动被完全吃掉（不落锚、笔尖钉原位）", () => {
    const sm = new StrokeSmoother({ step: 5, lag: 0, deadzone: 5 });
    feed(sm, [[0, 0], [3, 0], [0, 0], [3, 0], [-2, 0]]);   // 全程位移 < 5
    assert(sm._committed === 0, `亚半径抖动不应落锚点，实得 ${sm._committed}`);
    assert(Math.abs(sm.cx[sm.count - 1]) <= 5, "笔尖被死区钉在原点附近");
  });

  it("死区：超半径运动照常通过（按 d−r 前进）", () => {
    const sm = new StrokeSmoother({ step: 10, lag: 0, deadzone: 5 });
    sm.push(0, 0); sm.push(20, 0);                          // d=20>r=5 → 去抖点到 15
    const last = sm.count - 1;
    assert(near(sm.cx[last], 15), `去抖笔尖应到 15，实得 ${sm.cx[last]}`);
  });

  it("live 预览 tail = 弧（弯笔途中 transient tail 多点、末点钉光标、离弦>0）", () => {
    const sm = new StrokeSmoother({ step: 8, lag: 40 });
    for (let k = 0; k <= 60; k++) { const t = k / 60 * Math.PI / 2; sm.push(100 * Math.cos(t), 100 * Math.sin(t), 0.5); }
    // 未抬笔：transient 弧 tail = cx[_committed .. count-1]
    const tailN = sm.count - sm._committed;
    assert(tailN > 2, `弯笔预览 tail 应是多点弧，实得 ${tailN} 点`);
    const cur = [sm.cx[sm.count - 1], sm.cy[sm.count - 1]];        // 末点 = 光标（四分圆终点 (0,100)）
    assert(near(cur[0], 0, 1e-6) && near(cur[1], 100, 1e-6), `预览 tail 末点应钉光标(0,100)，实得(${cur[0]},${cur[1]})`);
    const a0 = sm._committed - 1;                                  // 弧起点（最后提交锚点）
    const ax = sm.cx[a0], ay = sm.cy[a0], len = Math.hypot(cur[0] - ax, cur[1] - ay) || 1;
    let dev = 0;
    for (let i = a0 + 1; i < sm.count - 1; i++)
      dev = Math.max(dev, Math.abs((cur[0] - ax) * (ay - sm.cy[i]) - (ax - sm.cx[i]) * (cur[1] - ay)) / len);
    assert(dev > 0.5, `预览 tail 应弯（离弦>0.5），实得 ${dev.toFixed(2)}`);
    // 抬笔即所见：finish 只是把这段弧转正，点不变
    const snapX = sm.cx.slice(), snapY = sm.cy.slice();
    sm.finish();
    for (let i = 0; i < snapX.length; i++) assert(near(sm.cx[i], snapX[i]) && near(sm.cy[i], snapY[i]), `finish 改了点 ${i}`);
  });

  it("转角门控：直角变尖（圆角半径骤降）；不门控时被磨圆", () => {
    const cc = Math.cos(35 * Math.PI / 180);
    const L = []; for (let x = 0; x <= 100; x += 2) L.push([x, 0]); for (let y = 2; y <= 100; y += 2) L.push([100, y]);
    const cornerRound = (opts) => { const sm = new StrokeSmoother(opts); feed(sm, L); sm.finish();
      let m = Infinity; for (let i = 0; i < sm._committed; i++) m = Math.min(m, Math.hypot(sm.cx[i] - 100, sm.cy[i])); return m; };
    const off = cornerRound({ step: 2, lag: 24 });
    const on  = cornerRound({ step: 2, lag: 24, cornerCos: cc, cornerSpan: 6 });
    assert(off > 6, `不门控直角应被磨圆(>6px)，实得 ${off.toFixed(2)}`);
    assert(on < off * 0.6, `门控应让直角更尖(<0.6×不门控)，实得 ${on.toFixed(2)} vs ${off.toFixed(2)}`);
  });

  it("转角门控 jitter robust：手抖不被误判成角（残余 RMS 不升）", () => {
    const cc = Math.cos(35 * Math.PI / 180);
    const noise = (k) => 1.5 * (Math.sin(k * 2.3) + Math.sin(k * 5.1 + 1.7)) / 2;
    const Nz = []; for (let x = 0; x <= 200; x += 2) Nz.push([x, noise(x)]);
    const rms = (opts) => { const sm = new StrokeSmoother(opts); feed(sm, Nz); sm.finish();
      let s = 0; for (let i = 0; i < sm._committed; i++) s += sm.cy[i] * sm.cy[i]; return Math.sqrt(s / sm._committed); };
    const off = rms({ step: 2, lag: 24 });
    const on  = rms({ step: 2, lag: 24, cornerCos: cc, cornerSpan: 6 });
    assert(on <= off * 1.1, `span 检测应让手抖不触发硬锚（RMS 不升），实得 ${on.toFixed(3)} vs ${off.toFixed(3)}`);
  });

  it("收笔 finish：钉终点（画到头）", () => {
    const sm = new StrokeSmoother({ step: 8, lag: 30 });
    const line = []; for (let x = 0; x <= 120; x += 6) line.push([x, 0]);
    feed(sm, line);
    sm.finish();
    const last = sm.count - 1;
    assert(near(sm.cx[last], 120) && near(sm.cy[last], 0), `收笔应钉终点(120,0)，实得(${sm.cx[last]},${sm.cy[last]})`);
  });

  it("收笔 finish：直线笔 → 直收（弧偏离≈0）；弯笔 → 弧收（动量出弧，偏离>0）", () => {
    const chordDev = (sm, fromIdx, toIdx, tipIdx) => {   // finish 锚点离 [起锚→终点] 弦的最大垂距
      const ax = sm.cx[fromIdx], ay = sm.cy[fromIdx], bx = sm.cx[tipIdx], by = sm.cy[tipIdx];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      let max = 0;
      for (let i = fromIdx + 1; i < toIdx; i++) {
        const d = Math.abs((bx - ax) * (ay - sm.cy[i]) - (ax - sm.cx[i]) * (by - ay)) / len;
        if (d > max) max = d;
      }
      return max;
    };
    // 直线笔
    const A = new StrokeSmoother({ step: 8, lag: 40 });
    const al = []; for (let x = 0; x <= 160; x += 6) al.push([x, 0]);
    feed(A, al); const a0 = A._committed - 1; A.finish();
    const aDev = chordDev(A, a0, A._committed, A.count - 1);
    assert(aDev < 0.5, `直线笔收笔应直，弧偏离=${aDev.toFixed(2)} 应<0.5`);
    // 弯笔（圆弧）
    const B = new StrokeSmoother({ step: 8, lag: 40 });
    const bl = []; for (let k = 0; k <= 40; k++) { const t = k / 40 * Math.PI / 2; bl.push([100 * Math.cos(t), 100 * Math.sin(t)]); }
    feed(B, bl); const b0 = B._committed - 1; B.finish();
    const bDev = chordDev(B, b0, B._committed, B.count - 1);
    assert(bDev > 0.5, `弯笔收笔应出弧（动量），弧偏离=${bDev.toFixed(2)} 应>0.5`);
  });
});
