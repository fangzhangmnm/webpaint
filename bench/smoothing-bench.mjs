// 平滑算子 benchmark：量几何导数 dy/dx, d²y/dx², d³y/dx³ 的连续性 + overshoot。
// 关心的不是内缩(bias，是 feature)，而是「人工不连续」(眼睛能看 G²~G³) 和「overfit shooting」。
//
// 跑：node bench/smoothing-bench.mjs
//
// 三个 smoother 同台（都套同一个 tail ramp，以暴露红十字处的 ramp 拐角）：
//   ① mean —— 三角权重滑动平均（最初版 / 0 阶）
//   ② expo —— 双边指数权重平均（用户提议：指数/damping，正权重→无 overshoot）
//   ③ quad —— 三角权重局部二次回归（上一轮 production / 负旁瓣→可能 overshoot）

// ---------- 输入曲线 ----------
// 椭圆上臂 θ∈[20°,160°]（避开 θ=0/180 的竖切线，dy/dx 全程有限）。ds 由真实弧长累积。
function genEllipse(a, b, deg0, deg1, n, noiseAmp = 0) {
  const pts = [];
  let prev = null, s = 0;
  // 伪噪声：固定（无 Math.random），高频正弦叠加，幅度 noiseAmp（screen px）
  const noise = (k) => noiseAmp * (Math.sin(k * 2.3) + Math.sin(k * 5.1 + 1.7)) / 2;
  for (let k = 0; k < n; k++) {
    const t = deg0 + (deg1 - deg0) * k / (n - 1);
    const r = t * Math.PI / 180;
    let x = a * Math.cos(r), y = b * Math.sin(r);
    if (noiseAmp) { const nx = noise(k), ny = noise(k + 100); x += nx; y += ny; }
    if (prev) s += Math.hypot(x - prev[0], y - prev[1]);
    pts.push({ x, y, s });
    prev = [x, y];
  }
  return pts;
}

// ---------- fit 函数：给定 raw + i + W，返回该点的平滑「拟合位置」(未加 ramp) ----------
function fitMean(raw, i, W) {
  const si = raw[i].s; let sw = 0, ax = 0, ay = 0;
  for (let j = i; j >= 0; j--) { const d = si - raw[j].s; if (d > W) break; const w = 1 - d / W; sw += w; ax += w * raw[j].x; ay += w * raw[j].y; }
  for (let j = i + 1; j < raw.length; j++) { const d = raw[j].s - si; if (d > W) break; const w = 1 - d / W; sw += w; ax += w * raw[j].x; ay += w * raw[j].y; }
  return [ax / sw, ay / sw];
}
function fitExp(raw, i, W) {
  const tau = W / 2, si = raw[i].s; let sw = 0, ax = 0, ay = 0;   // 截断 |Δs|≤W(≈2τ)
  for (let j = i; j >= 0; j--) { const d = si - raw[j].s; if (d > W) break; const w = Math.exp(-d / tau); sw += w; ax += w * raw[j].x; ay += w * raw[j].y; }
  for (let j = i + 1; j < raw.length; j++) { const d = raw[j].s - si; if (d > W) break; const w = Math.exp(-d / tau); sw += w; ax += w * raw[j].x; ay += w * raw[j].y; }
  return [ax / sw, ay / sw];
}
function fitQuad(raw, i, W) {   // 三角权重局部二次 WLS，û=(s-si)/W 归一化，取 û=0 常数项
  const si = raw[i].s; let m0 = 0, m1 = 0, m2 = 0, m3 = 0, m4 = 0, bx0 = 0, bx1 = 0, bx2 = 0, by0 = 0, by1 = 0, by2 = 0;
  const acc = (j) => { const u = (raw[j].s - si) / W; const w = 1 - Math.abs(u); const u2 = u * u; m0 += w; m1 += w * u; m2 += w * u2; m3 += w * u2 * u; m4 += w * u2 * u2; const X = raw[j].x, Y = raw[j].y; bx0 += w * X; bx1 += w * u * X; bx2 += w * u2 * X; by0 += w * Y; by1 += w * u * Y; by2 += w * u2 * Y; };
  for (let j = i; j >= 0; j--) { if ((si - raw[j].s) / W > 1) break; acc(j); }
  for (let j = i + 1; j < raw.length; j++) { if ((raw[j].s - si) / W > 1) break; acc(j); }
  const c00 = m2 * m4 - m3 * m3, c01 = m2 * m3 - m1 * m4, c02 = m1 * m3 - m2 * m2;
  const det = m0 * c00 + m1 * c01 + m2 * c02;
  if (Math.abs(det) < 1e-9) return [bx0 / m0, by0 / m0];
  return [(c00 * bx0 + c01 * bx1 + c02 * bx2) / det, (c00 * by0 + c01 * by1 + c02 * by2) / det];
}

// ---------- ramp 形状（决定红十字处连续到几阶导）----------
const RAMPS = {
  none: () => 1,                                      // 不加 ramp：C=fit，红十字数学上不存在(连续)，但尖端滞后~W/3
  linear: (u) => u,                                   // G⁰：G¹ 断
  smoothstep: (u) => u * u * (3 - 2 * u),             // G¹：G² 断
  smootherstep: (u) => u * u * u * (u * (u * 6 - 15) + 10),  // G²：G³ 断
};

// ---------- 套 tail ramp（production 现用 linear），产出平滑中心线 C ----------
function smooth(raw, W, fitFn, rampFn = RAMPS.linear) {
  const tipS = raw[raw.length - 1].s;
  const C = [];
  for (let i = 0; i < raw.length; i++) {
    const [fx, fy] = fitFn(raw, i, W);
    const si = raw[i].s;
    const r = rampFn(Math.max(0, Math.min(1, Math.min(si, tipS - si) / W)));
    C.push([raw[i].x + r * (fx - raw[i].x), raw[i].y + r * (fy - raw[i].y)]);
  }
  return C;
}
function frozenIndex(raw, W) { const tipS = raw[raw.length - 1].s; let ans = -1; for (let i = 0; i < raw.length; i++) if (tipS - raw[i].s >= W) ans = i; return ans; }

// ---------- 几何导数（central diff w.r.t. 索引，链式法则消去参数）----------
function geomDerivs(C, k) {
  const X = (j) => C[j][0], Y = (j) => C[j][1];
  const dx = (X(k + 1) - X(k - 1)) / 2, dy = (Y(k + 1) - Y(k - 1)) / 2;
  const ddx = X(k + 1) - 2 * X(k) + X(k - 1), ddy = Y(k + 1) - 2 * Y(k) + Y(k - 1);
  const dddx = (X(k + 2) - 2 * X(k + 1) + 2 * X(k - 1) - X(k - 2)) / 2;
  const dddy = (Y(k + 2) - 2 * Y(k + 1) + 2 * Y(k - 1) - Y(k - 2)) / 2;
  const y1 = dy / dx;
  const y2 = (dx * ddy - dy * ddx) / (dx ** 3);
  const y3 = ((dx * dddy - dy * dddx) * dx - 3 * ddx * (dx * ddy - dy * ddx)) / (dx ** 5);
  return { y1, y2, y3 };
}

// ---------- 运行 ----------
const W = 40;
const fits = { "①mean": fitMean, "②expo": fitExp, "③quad": fitQuad };

function report(title, raw) {
  const fi = frozenIndex(raw, W);
  console.log(`\n===== ${title}  (n=${raw.length}, W=${W}, 红十字@index ${fi}) =====`);
  for (const [name, fn] of Object.entries(fits)) {
    const C = smooth(raw, W, fn);
    // 红十字前后各取 3 个点(避开 FD 跨界)，看 y2/y3 跳变
    const lo = fi - 4, hi = fi + 4;
    const before = geomDerivs(C, lo), after = geomDerivs(C, hi);
    // 跳变检测：红十字邻域 y2 的相邻一阶差分最大值（人工不连续 → spike）
    let maxJump2 = 0, maxJump3 = 0;
    for (let k = fi - 6; k <= fi + 6; k++) {
      const a = geomDerivs(C, k), b = geomDerivs(C, k + 1);
      maxJump2 = Math.max(maxJump2, Math.abs(b.y2 - a.y2));
      maxJump3 = Math.max(maxJump3, Math.abs(b.y3 - a.y3));
    }
    console.log(` ${name}: y''[前]=${before.y2.toExponential(2)} [后]=${after.y2.toExponential(2)}` +
      ` | 红十字邻域 max|Δy''|=${maxJump2.toExponential(2)}  max|Δy'''|=${maxJump3.toExponential(2)}`);
  }
}

// 旋转不变的有符号曲率（角点测试用，避开 dy/dx 竖切线奇点）
function curvature(C, k) {
  const dx = (C[k + 1][0] - C[k - 1][0]) / 2, dy = (C[k + 1][1] - C[k - 1][1]) / 2;
  const ddx = C[k + 1][0] - 2 * C[k][0] + C[k - 1][0], ddy = C[k + 1][1] - 2 * C[k][1] + C[k - 1][1];
  return (dx * ddy - dy * ddx) / Math.pow(dx * dx + dy * dy, 1.5);
}
// 角点：沿 +x 走 L，转 deg°，再走 L。真曲率=两段 0、拐点一个正峰。ringing = 曲率反号(负)。
function genCorner(L, deg, n, noiseAmp = 0) {
  const pts = []; const r = deg * Math.PI / 180; const half = Math.floor(n / 2);
  const noise = (k) => noiseAmp * (Math.sin(k * 2.3) + Math.sin(k * 5.1 + 1.7)) / 2;
  let s = 0, prev = null; const step = L / half;
  for (let k = 0; k < n; k++) {
    let x, y;
    if (k <= half) { x = -L + k * step; y = 0; }
    else { const d = (k - half) * step; x = d * Math.cos(r); y = d * Math.sin(r); }
    if (noiseAmp) { x += noise(k); y += noise(k + 100); }
    if (prev) s += Math.hypot(x - prev[0], y - prev[1]);
    pts.push({ x, y, s }); prev = [x, y];
  }
  return pts;
}

// 圆（真曲率 κ=1/R 恒定）→ 基线 κ 是平的，红十字处任何 κ 偏离都是纯 artifact。
function genCircle(R, totalDeg, n, noiseAmp = 0) {
  const pts = []; let s = 0, prev = null;
  const noise = (k) => noiseAmp * (Math.sin(k * 2.3) + Math.sin(k * 5.1 + 1.7)) / 2;
  for (let k = 0; k < n; k++) {
    const a = (totalDeg * Math.PI / 180) * k / (n - 1);
    let x = R * Math.cos(a), y = R * Math.sin(a);
    if (noiseAmp) { x += noise(k); y += noise(k + 100); }
    if (prev) s += Math.hypot(x - prev[0], y - prev[1]); pts.push({ x, y, s }); prev = [x, y];
  }
  return pts;
}
// 最小二乘直线在 xt 处的外推
function linEval(xs, ys, xt) {
  const n = xs.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx); return (sy - b * sx) / n + b * xt;
}
// 红十字(fi)处 κ 跳变：frozen 侧外推到 fi vs tail 侧外推到 fi
function kappaJump(C, fi) {
  const fxs = [], fys = [], txs = [], tys = [];
  for (let k = fi - 6; k <= fi - 2; k++) { fxs.push(k); fys.push(curvature(C, k)); }
  for (let k = fi + 2; k <= fi + 6; k++) { txs.push(k); tys.push(curvature(C, k)); }
  return Math.abs(linEval(fxs, fys, fi) - linEval(txs, tys, fi));
}

// ===== 圆：红十字处 κ artifact（越小越「看不出红十字」）+ 尖端滞后 =====
console.log(`\n===== 圆 R=100 (真κ=1e-2 恒定)：红十字 κ 跳变(artifact) + 尖端滞后 =====`);
{
  const circ = genCircle(100, 200, 400, 0);
  const fi = frozenIndex(circ, W), last = circ.length - 1;
  console.log(` raw 基线 κ跳变=${kappaJump(circ.map(p => [p.x, p.y]), fi).toExponential(2)} (应≈0，确认 metric 干净)`);
  for (const [name, fn] of Object.entries(fits)) {
    for (const rname of ["none", "linear", "smootherstep"]) {
      const C = smooth(circ, W, fn, RAMPS[rname]);
      const lag = Math.hypot(C[last][0] - circ[last].x, C[last][1] - circ[last].y);
      console.log(`   ${name}+${rname.padEnd(12)}: κ跳变=${kappaJump(C, fi).toExponential(2)}  尖端滞后=${lag.toFixed(2)}px`);
    }
  }
}

// 角点：测 overfit shooting = 曲率反号(ringing)。正峰=圆角(好)，负值=overshoot(坏)。
console.log(`\n===== 角点 ringing (转 50°) =====`);
for (const noiseAmp of [0, 1.0]) {
  const corner = genCorner(120, 50, 280, noiseAmp);
  console.log(` 噪声=${noiseAmp}px:`);
  for (const [name, fn] of Object.entries(fits)) {
    const C = smooth(corner, W, fn);
    let kmax = 0, kmin = 0;
    for (let k = 4; k < C.length - 4; k++) { const kv = curvature(C, k); if (kv > kmax) kmax = kv; if (kv < kmin) kmin = kv; }
    const ring = kmax > 0 ? (-kmin / kmax * 100) : 0;
    console.log(`   ${name}: 圆角峰κ=${kmax.toExponential(2)}  最负κ=${kmin.toExponential(2)}  ringing=${ring.toFixed(1)}%`);
  }
}
