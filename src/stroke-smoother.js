// 位置平滑：lookahead 窗口平均 + 边缘 ramp。给 frozen/tail 分段提供平滑中心线。
// 详 docs/brush-frozen-tail-smoothing.md。
//
// 模型：
//   raw[i]      —— 输入点（doc 坐标 + 压感 + 累积弧长 s_i），按到达顺序 push
//   winAvg_i    —— [s_i−W, s_i+W] 内 raw 的三角权重平均（W = lookahead，doc px）
//   r_i         —— clamp(min(leftReach, rightReach)/W, 0, 1)；缺 lookahead 处平滑淡出
//   C[i]        —— raw[i] + r_i·(winAvg_i − raw[i])
//
//   端点效应（关键）：tip 处 rightReach=0 → r=0 → C[tip] = raw[tip]（钉到笔尖，线到手）；
//                   落笔处 leftReach=0 → r=0 → C[0] = raw[0]（钉到落笔点）。
//
//   frozenIndex —— s_tip − s_i ≥ W 的最大 i。这些 C[i] 的窗口已满且不再变 → 可冻结。
//
// 纯几何，无 canvas。压感不做空间平滑，原样挂在 C[i].p（引擎侧已过 pressureLPF）。

export class StrokeSmoother {
  constructor(lookahead) {
    this.W = Math.max(0, lookahead || 0);
    // raw 平行数组
    this.rx = []; this.ry = []; this.rp = []; this.rs = [];
    // 平滑中心线平行数组（与 raw 同索引）
    this.cx = []; this.cy = []; this.cp = [];
    this.cFrozenCount = 0;   // 前这么多 C 已 final（窗口满），缓存不再重算
  }

  get count() { return this.rx.length; }
  get tipS()  { return this.rs.length ? this.rs[this.rs.length - 1] : 0; }

  push(x, y, p) {
    const n = this.rx.length;
    let s;
    if (n === 0) {
      s = 0;
    } else {
      const dx = x - this.rx[n - 1], dy = y - this.ry[n - 1];
      s = this.rs[n - 1] + Math.hypot(dx, dy);
    }
    this.rx.push(x); this.ry.push(y); this.rp.push(p); this.rs.push(s);
  }

  // s_tip − s_i ≥ W 的最大 i；没有则 −1
  frozenIndex() {
    if (this.W <= 0) return this.rx.length - 1;   // 退化：无平滑，全部立即可冻
    const thresh = this.tipS - this.W;
    // rs 升序，二分找 rs[i] ≤ thresh 的最大 i
    let lo = 0, hi = this.rs.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.rs[mid] <= thresh) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  _computeC(i) {
    const W = this.W;
    const xi = this.rx[i], yi = this.ry[i];
    if (W <= 0) { this.cx[i] = xi; this.cy[i] = yi; this.cp[i] = this.rp[i]; return; }
    const si = this.rs[i];
    // 三角权重「局部二次加权最小二乘」，取中心(û=0)的常数项 = 平滑位置。
    // 二次拟合保到二阶导 → 圆弧不内缩、保曲率；红十字 artifact 比 expo 小 ~30×（bench 实测 quad 胜）。
    // 软肋：负旁瓣 → 角点/稀疏点 overfit 时会 ringing（待 limiter 兜）。
    // 点不够(<3 distinct s)→ det≈0 → 降回加权均值兜底。û = (s−si)/W ∈ [−1,1] 归一化条件数。
    let m0 = 0, m1 = 0, m2 = 0, m3 = 0, m4 = 0;          // Σ w·û^k
    let bx0 = 0, bx1 = 0, bx2 = 0, by0 = 0, by1 = 0, by2 = 0;
    const acc = (j) => {
      const u = (this.rs[j] - si) / W;
      const w = 1 - Math.abs(u);
      const u2 = u * u;
      m0 += w; m1 += w * u; m2 += w * u2; m3 += w * u2 * u; m4 += w * u2 * u2;
      const X = this.rx[j], Y = this.ry[j];
      bx0 += w * X; bx1 += w * u * X; bx2 += w * u2 * X;
      by0 += w * Y; by1 += w * u * Y; by2 += w * u2 * Y;
    };
    for (let j = i; j >= 0; j--) { if ((si - this.rs[j]) / W > 1) break; acc(j); }
    for (let j = i + 1, n = this.rx.length; j < n; j++) { if ((this.rs[j] - si) / W > 1) break; acc(j); }
    // 解对称 3×3 M=[[m0,m1,m2],[m1,m2,m3],[m2,m3,m4]] 的第 0 行（只要 a0 = 值@û=0）
    const c00 = m2 * m4 - m3 * m3;
    const c01 = m2 * m3 - m1 * m4;
    const c02 = m1 * m3 - m2 * m2;
    const det = m0 * c00 + m1 * c01 + m2 * c02;
    let fx, fy;
    if (Math.abs(det) > 1e-9 && m0 > 0) {
      fx = (c00 * bx0 + c01 * bx1 + c02 * bx2) / det;
      fy = (c00 * by0 + c01 * by1 + c02 * by2) / det;
    } else {                                  // 退化（点太少/共线）→ 加权均值兜底
      fx = m0 > 0 ? bx0 / m0 : xi;
      fy = m0 > 0 ? by0 / m0 : yi;
    }
    // 端点 ramp：缺 lookahead 处把拟合淡回 raw（钉笔尖/落笔；也防一侧窗口下二次外插发散）
    const leftReach = si, rightReach = this.tipS - si;
    const r = Math.max(0, Math.min(1, Math.min(leftReach, rightReach) / W));
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
