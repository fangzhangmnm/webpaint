// 平滑台架 — 验时间常数指数追踪 out += (pen−out)·(1−exp(−dt/tau)) 的几条主张。
// 详 docs/20260613-brush-procreate-smoothing.md。跑：node bench/smoothing-bench.mjs
//
//   ① 固定时间滞后 + 采样率无关 —— 滞后 ≈ v·tau，dt 不同（240Hz vs 60Hz）滞后接近。
//   ② 顿涌现 —— 滞后 = 速度×tau：慢→贴笔、快→重平滑。零检测。
//   ③ 转角涌现 —— L 角处自然减速 → 滞后缩小 → 角被保成紧而平滑的弯（无阈值/无锚点 → 无多边形）。
//   ④ 去抖 —— tau 是频域滤波：手抖在任何速度下都被衰减。

import { StrokeSmoother } from "../src/stroke-smoother.js";

const noise = (k, amp) => amp * (Math.sin(k * 2.3) + Math.sin(k * 5.1 + 1.7)) / 2;

// 沿 +x 匀速 v(px/ms)、步长 dt(ms) 喂到 X；返回稳态滞后
function rampLag(tau, v, dt, X) {
  const sm = new StrokeSmoother({ tau }); let t = 0, x = 0;
  for (; x <= X; x += v * dt) { sm.push(x, 0, 0.5, t); t += dt; }
  return (x - v * dt) - sm._ox;
}

console.log("\n===== ① 固定时间滞后（≈ v·tau）+ 采样率无关 =====");
for (const tau of [40, 80, 160]) {
  const a = rampLag(tau, 1, 4, 800), b = rampLag(tau, 1, 16, 800);   // 240Hz vs 60Hz 量级
  console.log(`  tau=${tau}ms, v=1px/ms: 滞后 dt4=${a.toFixed(1)}px dt16=${b.toFixed(1)}px (≈v·tau=${tau}; 两者差 ${(Math.abs(a - b) / a * 100).toFixed(1)}%)`);
}

console.log("\n===== ② 顿涌现：滞后 = 速度×tau（慢贴笔 / 快重平滑），零检测 =====");
for (const v of [0.2, 0.5, 1, 2]) {
  console.log(`  tau=80ms, v=${v}px/ms: 稳态滞后 = ${rampLag(80, v, 8, 1000).toFixed(1)}px`);
}

console.log("\n===== ③ 转角涌现：L 角处减速 → 滞后缩小 → 角紧而平滑（无多边形）=====");
{
  // 真实手感：进/出角各匀速，角附近按高斯减速（幂律的近似）。带时间戳喂。
  function lcorner(tau, slowAtCorner) {
    const sm = new StrokeSmoother({ tau }); let t = 0;
    const emit = (x, y, dt) => { sm.push(x, y, 0.5, t); t += dt; };
    const speed = (d) => slowAtCorner ? (0.3 + 1.7 * Math.min(1, Math.abs(d) / 40)) : 1.2;  // 距角 d，近角慢
    let x = 0; while (x <= 100) { emit(x, 0, 2 / speed(100 - x)); x += 2; }      // +x 进角
    let y = 2; while (y <= 100) { emit(100, y, 2 / speed(y)); y += 2; }          // +y 出角
    sm.finish();
    let m = Infinity; for (let i = 0; i < sm._committed; i++) m = Math.min(m, Math.hypot(sm.cx[i] - 100, sm.cy[i]));
    // 多边形检测：角邻域相邻步转角 max/avg
    let mx = 0, sum = 0, cnt = 0;
    for (let i = 1; i < sm._committed - 1; i++) {
      const ax = sm.cx[i] - sm.cx[i - 1], ay = sm.cy[i] - sm.cy[i - 1], bx = sm.cx[i + 1] - sm.cx[i], by = sm.cy[i + 1] - sm.cy[i];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by); if (la < 1e-6 || lb < 1e-6) continue;
      let c = (ax * bx + ay * by) / (la * lb); c = Math.max(-1, Math.min(1, c)); const ang = Math.acos(c) * 180 / Math.PI;
      mx = Math.max(mx, ang); sum += ang; cnt++;
    }
    return { round: m, turnMax: mx, turnAvg: sum / cnt };
  }
  for (const tau of [40, 80]) {
    const s = lcorner(tau, true), c = lcorner(tau, false);
    console.log(`  tau=${tau}ms 角处减速: 圆角=${s.round.toFixed(1)}px(小=尖)  转角max/avg=${s.turnMax.toFixed(0)}/${s.turnAvg.toFixed(0)}°  | 不减速(匀速): 圆角=${c.round.toFixed(1)}px`);
  }
}

console.log("\n===== ④ 去抖：tau 频域衰减手抖（与速度无关）=====");
for (const [tau, v] of [[0, 1], [80, 1], [80, 0.3]]) {
  const sm = new StrokeSmoother({ tau }); let t = 0, x = 0;
  while (x <= 300) { sm.push(x, noise(x, 1.5), 0.5, t); x += v * 8; t += 8; }
  let s = 0; for (let i = 0; i < sm._committed; i++) s += sm.cy[i] * sm.cy[i];
  console.log(`  tau=${tau}ms v=${v}: 残余RMS = ${Math.sqrt(s / sm._committed).toFixed(3)}px`);
}
