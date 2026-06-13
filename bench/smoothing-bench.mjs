// 平滑台架 — 验真实生产 StrokeSmoother（Procreate EMA + 死区 + 贴笔尖）的三条主张。
// 详 docs/brush-procreate-smoothing.md。跑：node bench/smoothing-bench.mjs
//
//   ① 帧率无关  —— 同几何、不同事件密度 → 提交锚点应几乎重合（重采样跑在固定弧长上）。
//   ② 贴笔尖    —— 笔尖顶点恒 = 最新 raw（滞后 0）；锚点滞后随 a 增大，量出来核对。
//   ③ 去抖      —— 噪声直线，量平滑后残余偏离随 streamline / stabilization 下降。

import { StrokeSmoother } from "../src/stroke-smoother.js";

// 固定伪噪声（无 Math.random）：高频正弦叠加
const noise = (k, amp) => amp * (Math.sin(k * 2.3) + Math.sin(k * 5.1 + 1.7)) / 2;

// 采样一条圆弧（半径 R，扫 deg 度，n 点），可叠噪声
function arc(R, deg, n, amp = 0) {
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = (deg * Math.PI / 180) * k / (n - 1);
    pts.push([R * Math.cos(a) + noise(k, amp), R * Math.sin(a) + noise(k + 100, amp)]);
  }
  return pts;
}
function densify(pts, factor) {                 // 线性插值加密事件（同几何、更多点）
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++)
    for (let j = 1; j <= factor; j++) {
      const t = j / factor;
      out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]);
    }
  return out;
}
function run(pts, opts) { const sm = new StrokeSmoother(opts); for (const [x, y] of pts) sm.push(x, y, 0.5); return sm; }
function anchorsAtArcLen(sm) {                   // 提交锚点 + 各自累积弧长
  const out = []; let s = 0;
  for (let i = 0; i < sm._committed; i++) {
    if (i > 0) s += Math.hypot(sm.cx[i] - sm.cx[i - 1], sm.cy[i] - sm.cy[i - 1]);
    out.push([s, sm.cx[i], sm.cy[i]]);
  }
  return out;
}
// 把 B 的锚点按弧长插到 A 的弧长上，量逐点偏差（帧率无关 metric）
function divergence(a, b) {
  let max = 0;
  for (const [s, ax, ay] of a) {
    let j = 0; while (j < b.length - 1 && b[j + 1][0] < s) j++;
    const [s0, x0, y0] = b[j], [s1, x1, y1] = b[Math.min(j + 1, b.length - 1)];
    const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    max = Math.max(max, Math.hypot(ax - (x0 + (x1 - x0) * t), ay - (y0 + (y1 - y0) * t)));
  }
  return max;
}

const STEP = 2;
console.log("\n===== ① 帧率无关（R=100 半圆，1× vs 3× 事件密度，max 锚点偏差应≈0）=====");
for (const sl of [0.3, 0.6, 0.9]) {
  const L = sl * 24, a = L / (L + STEP);
  const base = arc(100, 180, 120);
  const A = anchorsAtArcLen(run(base, { step: STEP, a }));
  const B = anchorsAtArcLen(run(densify(base, 3), { step: STEP, a }));
  console.log(`  streamline=${sl} (a=${a.toFixed(3)}): max 偏差 = ${divergence(A, B).toFixed(4)} px`);
}

console.log("\n===== ② 贴笔尖（笔尖滞后恒 0；锚点滞后随 a 增）=====");
for (const sl of [0, 0.3, 0.6, 0.9]) {
  const L = sl * 24, a = L / (L + STEP);
  const line = []; for (let x = 0; x <= 200; x += 4) line.push([x, 0]);
  const sm = run(line, { step: STEP, a });
  const tip = sm.cx[sm.count - 1];
  const lastAnchor = sm._committed > 0 ? sm.cx[sm._committed - 1] : tip;
  console.log(`  streamline=${sl}: 笔尖滞后=${(200 - tip).toFixed(2)}px(应0)  末锚滞后笔尖=${(tip - lastAnchor).toFixed(2)}px`);
}

console.log("\n===== ③ 去抖（噪声=1.5px 直线，残余偏离 RMS 越小越稳）=====");
for (const [sl, stab] of [[0, 0], [0.3, 0], [0.6, 0], [0, 0.5], [0.6, 0.5]]) {
  const L = sl * 24, a = L / (L + STEP);
  const line = []; for (let x = 0; x <= 200; x += 3) line.push([x, noise(x, 1.5)]);
  const sm = run(line, { step: STEP, a, deadzone: stab * 8 });
  let sq = 0; for (let i = 0; i < sm._committed; i++) sq += sm.cy[i] * sm.cy[i];
  const rms = sm._committed ? Math.sqrt(sq / sm._committed) : 0;
  console.log(`  streamline=${sl} stabilization=${stab}: 残余 RMS = ${rms.toFixed(3)} px`);
}
