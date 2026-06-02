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
    // v150 试 expo：双边指数权重平均（正权重 → 凸组合 → 角点零 ringing / 无 overshoot）。
    //   bench：角点 ringing 0%（quad 8.9%），但红十字 κ 跳变 ~18%（quad ~0.5%），尖端贴指靠 ramp。
    //   τ = W/2，截断 |Δs| ≤ W。内缩(bias) 是 feature（毛笔甩尖），不修。
    const tau = W / 2;
    let sw = 0, ax = 0, ay = 0;
    for (let j = i; j >= 0; j--) { const d = si - this.rs[j]; if (d > W) break; const w = Math.exp(-d / tau); sw += w; ax += w * this.rx[j]; ay += w * this.ry[j]; }
    for (let j = i + 1, n = this.rx.length; j < n; j++) { const d = this.rs[j] - si; if (d > W) break; const w = Math.exp(-d / tau); sw += w; ax += w * this.rx[j]; ay += w * this.ry[j]; }
    const fx = ax / sw, fy = ay / sw;
    // 端点 ramp：缺 lookahead 处把平滑淡回 raw（钉笔尖/落笔）
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
