// 位置平滑 — Procreate 三参模型（v243 重写，取代弧长二次 WLS quad）。
// 详 docs/brush-procreate-smoothing.md。
//
// 模型：raw 点流 → ① stabilization 死区拉绳 → ② 按固定弧长 Δ 重采样 → ③ streamline EMA。
//   EMA 因果 → 锚点落定即终值、永不回改（不用每帧重算后缀，这是比 quad 简单的关键）。
//   重采样在固定弧长上 → 帧率/事件密度无关。
//
// 贴笔尖：cx/cy/cp = [已提交锚点…, 笔尖]。frozenIndex() = 锚点数−1（笔尖永不冻）。
//   tail 段 = 最后锚点 → 笔尖（直线，brush.js 每帧重画 → 贴指）。抬笔时整段转正 = catch-up。
//   笔尖 = 死区输出（stab=0 → = raw 精确贴指）。
//
// 与 brush.js 的契约（仅这些）：push / update(空) / frozenIndex / count / seq / cx,cy,cp。

export class StrokeSmoother {
  // opts: { step:弧长重采样间隔(doc px), a:streamline EMA 保留系数∈[0,1), aP:压感 EMA, deadzone:死区半径(doc px) }
  constructor(opts = {}) {
    this.step = Math.max(0.25, opts.step || 2);
    this.a  = clamp01x(opts.a  || 0);     // 0 = 不平滑（重采样直通）
    this.aP = clamp01x(opts.aP || 0);
    this.r  = Math.max(0, opts.deadzone || 0);

    this.cx = []; this.cy = []; this.cp = [];   // 锚点串 + 末尾笔尖
    this._committed = 0;                         // 已提交锚点数（cx[0.._committed-1]）；笔尖 = cx[_committed]
    this.seq = 0;                                // push 序号（brush.js overlay 缓存失效用，每 push +1）

    // EMA / 死区 / 重采样状态
    this._emaX = 0; this._emaY = 0; this._emaP = 0;
    this._stabX = 0; this._stabY = 0;            // 死区锚（滞后 raw 半径 r）
    this._lastSX = 0; this._lastSY = 0;          // 上次去抖点（重采样起点）
    this._lastInP = 0;                           // 上次 raw 压感（段内压感插值用）
    this._accum = 0;                             // 重采样累积弧长余量
    this._started = false;
  }

  get count() { return this.cx.length; }

  push(x, y, p) {
    this.seq++;
    if (!this._started) {
      this._started = true;
      this._emaX = x; this._emaY = y; this._emaP = p;
      this._stabX = x; this._stabY = y;
      this._lastSX = x; this._lastSY = y; this._lastInP = p;
      this._accum = 0;
      // 笔尖（暂无锚点，count=1，frozenIndex=-1）
      this.cx.push(x); this.cy.push(y); this.cp.push(p);
      this._committed = 0;
      return;
    }
    // 去掉旧笔尖（笔尖不提交，每 push 重置）
    this.cx.pop(); this.cy.pop(); this.cp.pop();

    // ① stabilization 死区：半径 r 内不动，超出才拉
    if (this.r > 0) {
      const dx = x - this._stabX, dy = y - this._stabY;
      const d = Math.hypot(dx, dy);
      if (d > this.r) { const k = (d - this.r) / d; this._stabX += dx * k; this._stabY += dy * k; }
    } else {
      this._stabX = x; this._stabY = y;
    }
    const sx = this._stabX, sy = this._stabY;

    // ② 重采样去抖点段 lastS→s，每 step 落 q；③ 对 q 做 EMA → 提交锚点
    const segdx = sx - this._lastSX, segdy = sy - this._lastSY;
    const L = Math.hypot(segdx, segdy);
    let pos = 0;
    while (this._accum + (L - pos) >= this.step) {
      pos += this.step - this._accum;
      this._accum = 0;
      const t = L > 0 ? pos / L : 1;
      const qx = this._lastSX + segdx * t;
      const qy = this._lastSY + segdy * t;
      const qp = this._lastInP + (p - this._lastInP) * t;
      this._emaX += (qx - this._emaX) * (1 - this.a);
      this._emaY += (qy - this._emaY) * (1 - this.a);
      this._emaP += (qp - this._emaP) * (1 - this.aP);
      this.cx.push(this._emaX); this.cy.push(this._emaY); this.cp.push(this._emaP);
    }
    this._accum += L - pos;
    this._lastSX = sx; this._lastSY = sy; this._lastInP = p;
    this._committed = this.cx.length;

    // 重挂笔尖（= 去抖点，stab=0 时即 raw）
    this.cx.push(sx); this.cy.push(sy); this.cp.push(p);
  }

  // 已提交锚点的最大下标（笔尖 = _committed 永不冻）。无锚点 → -1。
  frozenIndex() { return this._committed - 1; }

  // EMA 因果、锚点不回改 → 无需重算。留空保持契约。
  update() {}
}

function clamp01x(v) { return v < 0 ? 0 : v >= 1 ? 0.999 : v; }
