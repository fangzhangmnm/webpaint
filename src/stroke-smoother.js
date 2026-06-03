// 位置平滑：时间门控的弧长窗口 + 边缘 ramp。给 frozen/tail 分段提供平滑中心线。
// 详 docs/brush-frozen-tail-smoothing.md 和 docs/adr/0001-time-gated-arc-smoothing.md。
//
// 模型：
//   raw[i]   —— 输入点（doc 坐标 x/y + 压感 p + 累积弧长 s_i + 时间戳 t_i）
//   窗口     —— 同时满足 |Δs| ≤ W（弧长）且 |Δt| ≤ T（时间）的样本；权重 = 弧长三角权 (1−|Δs|/W)
//   估计子   —— degree 2：局部二次 WLS 取中心（保曲率/不内缩，默认）；degree 0：加权均值（内缩/毛笔甩尖）
//   C[i]     —— raw[i] + r_i·(fit − raw[i])
//
//   时间门的意义（核心）：dwell(顿) = 高时间近零位移，弧长里几乎不存在 → 纯弧长会把顿的尖角磨圆。
//     时间门让笔速 < W/T 时把时间上久远的进/出腿剔除 → 顿处只剩 dwell → 保住尖角。
//     笔速 ≥ W/T（快速）时时间门不 bind → 退化成纯弧长 = 与旧版逐字节相同（快速手感零回归）。
//
//   ramp r_i = clamp(rightFrac, 0, 1)，rightFrac = 笔尖 reach（弧长/时间较大者）：
//     笔尖处→0 → r=0 → C=raw（钉笔尖，线到手）；其余 r=1 用平滑值。
//     v159：**不再钉起笔**（Procreate 落地即平滑）。起笔单边窗口的二次外插 overshoot 由 balance 兜底
//     （窗口对称度 balance: 1=均衡用二次 / 0=单边用加权均值=凸组合不外插）。
//
//   frozenIndex —— (tip_s − s_i ≥ W) 或 (tip_t − t_i ≥ T) 的最大 i：窗口不再可能进新样本 → 定型可冻。
//
// 纯几何，无 canvas。压感原样挂 C[i].p（引擎侧已过 pressureLPF）。

export class StrokeSmoother {
  // opts: { W (弧长 doc px), T (时间 ms), deflate (bool) }
  constructor(opts = {}) {
    this.W = Math.max(0, opts.W || 0);
    this.T = opts.T > 0 ? opts.T : Infinity;   // ≤0 → 无时间门（退化纯弧长）
    this.deflate = !!opts.deflate;             // true → 0 阶（内缩）；false → 2 阶（保曲率）
    this.rx = []; this.ry = []; this.rp = []; this.rs = []; this.rt = [];
    this.cx = []; this.cy = []; this.cp = [];
    this.cFrozenCount = 0;
  }

  get count() { return this.rx.length; }
  get tipS()  { return this.rs.length ? this.rs[this.rs.length - 1] : 0; }
  get tipT()  { return this.rt.length ? this.rt[this.rt.length - 1] : 0; }

  push(x, y, p, t) {
    const n = this.rx.length;
    let s;
    if (n === 0) s = 0;
    else { const dx = x - this.rx[n - 1], dy = y - this.ry[n - 1]; s = this.rs[n - 1] + Math.hypot(dx, dy); }
    // 时间戳须单调不减（input 已过 timeStamp 单调过滤）；兜底 clamp 防倒退
    const tt = (typeof t === "number") ? (n ? Math.max(t, this.rt[n - 1]) : t) : (n ? this.rt[n - 1] : 0);
    this.rx.push(x); this.ry.push(y); this.rp.push(p); this.rs.push(s); this.rt.push(tt);
  }

  // 升序数组 arr 里 arr[i] ≤ thresh 的最大 i（没有 → −1）
  _lastLE(arr, thresh) {
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= thresh) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }

  // (tip_s − s_i ≥ W) 或 (tip_t − t_i ≥ T) 的最大 i
  frozenIndex() {
    if (this.W <= 0) return this.rx.length - 1;     // 无平滑 → 全可冻
    const arcAns = this._lastLE(this.rs, this.tipS - this.W);
    const timeAns = (this.T === Infinity) ? -1 : this._lastLE(this.rt, this.tipT - this.T);
    return Math.max(arcAns, timeAns);
  }

  _computeC(i) {
    const W = this.W, T = this.T;
    const xi = this.rx[i], yi = this.ry[i];
    if (W <= 0) { this.cx[i] = xi; this.cy[i] = yi; this.cp[i] = this.rp[i]; return; }
    const si = this.rs[i], ti = this.rt[i];
    let m0 = 0, m1 = 0, m2 = 0, m3 = 0, m4 = 0;
    let bx0 = 0, bx1 = 0, bx2 = 0, by0 = 0, by1 = 0, by2 = 0;
    let wL = 0, wR = 0;                           // 左/右侧权重和，量窗口对称度（边界判定）
    const acc = (j) => {
      const u = (this.rs[j] - si) / W;          // ∈[−1,1]
      const w = 1 - Math.abs(u);                 // 弧长三角权（时间只做硬门，不入权 → 快速=旧版逐字节同）
      const u2 = u * u;
      m0 += w; m1 += w * u; m2 += w * u2; m3 += w * u2 * u; m4 += w * u2 * u2;
      const X = this.rx[j], Y = this.ry[j];
      bx0 += w * X; bx1 += w * u * X; bx2 += w * u2 * X;
      by0 += w * Y; by1 += w * u * Y; by2 += w * u2 * Y;
      if (u < 0) wL += w; else if (u > 0) wR += w;
    };
    // 窗口 = 弧长 ∩ 时间；任一超界即停（s、t 都单调 → 越远只会更超）
    for (let j = i; j >= 0; j--) { if (si - this.rs[j] > W || ti - this.rt[j] > T) break; acc(j); }
    for (let j = i + 1, n = this.rx.length; j < n; j++) { if (this.rs[j] - si > W || this.rt[j] - ti > T) break; acc(j); }

    const meanx = m0 > 0 ? bx0 / m0 : xi, meany = m0 > 0 ? by0 / m0 : yi;
    let fx, fy;
    if (this.deflate) {                          // 0 阶：加权均值（内缩/毛笔甩尖）
      fx = meanx; fy = meany;
    } else {                                     // 2 阶：局部二次 WLS 取中心（保曲率）
      const c00 = m2 * m4 - m3 * m3, c01 = m2 * m3 - m1 * m4, c02 = m1 * m3 - m2 * m2;
      const det = m0 * c00 + m1 * c01 + m2 * c02;
      if (Math.abs(det) > 1e-9 && m0 > 0) {
        fx = (c00 * bx0 + c01 * bx1 + c02 * bx2) / det;
        fy = (c00 * by0 + c01 * by1 + c02 * by2) / det;
      } else { fx = meanx; fy = meany; }         // 点太少 → 均值兜底
    }
    // 边界单边窗口（起笔处只有前向样本）→ 二次会外插 overshoot。按窗口对称度 balance 把拟合
    // 淡回加权均值（均值=凸组合永不外插）。balance: 1=两侧均衡(用二次) / 0=单边(用均值,安全平滑)。
    const balance = (wL > 0 && wR > 0) ? Math.min(wL, wR) / Math.max(wL, wR) : 0;
    fx = meanx + balance * (fx - meanx);
    fy = meany + balance * (fy - meany);
    // ramp：v159 起**不再钉死起笔**（Procreate 落地即平滑：起点用前向 lookahead 重新平滑，
    //   随笔滑出而收敛；上面的 balance 兜底防起笔单边 overshoot）。只保**笔尖**钉 raw（贴指）。
    //   笔尖 reach = 弧长/时间较大者，两者都→0(刚画的) → r→0 → C=raw。
    const rightFrac = Math.max((this.tipS - si) / W, T === Infinity ? 0 : (this.tipT - ti) / T);
    const r = Math.max(0, Math.min(1, rightFrac));
    this.cx[i] = xi + r * (fx - xi);
    this.cy[i] = yi + r * (fy - yi);
    this.cp[i] = this.rp[i];
  }

  // 重算 [cFrozenCount, n) 的 C（frozen 前缀缓存）。每次 O(tail 长度)。
  update() {
    const n = this.rx.length;
    for (let i = this.cFrozenCount; i < n; i++) this._computeC(i);
    const fi = this.frozenIndex();
    if (fi + 1 > this.cFrozenCount) this.cFrozenCount = fi + 1;
    this.cx.length = n; this.cy.length = n; this.cp.length = n;
  }
}
