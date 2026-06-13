// 位置平滑 — 时间常数追踪 + 动量弧 tail。双路径 A/B（dev 面板 firstOrder live 切换对比）。
// 详 docs/brush-procreate-smoothing.md。
//
// 共同：committed out = 笔尖以固定时间常数 tau 追踪 pen（用真实 dt）→ 滞后≈速度×tau（一致、跟笔、可控、
//   顿涌现、去抖、帧率无关）。先死区(stabilization)、再追踪。贴笔尖弧 tail = 每 push 重画到光标的预览，
//   抬笔 finish() 整段转正。cx=[committed out…, 弧 tail(末点=pen)]，frozenIndex=_committed-1。
//
// 【A 二阶 SmoothDamp（默认 false=A）】body = 临界阻尼 SmoothDamp(pos+vel,smoothTime=tau,真实 dt)。
//   弧 tail = 从 (pos, vel·bow) 非破坏继续 flush 到光标 = 动量弧。vel 是连续状态 → 弧稳。body 转角带轻微动量。
// 【B 一阶 EMA + heading（firstOrder=true）】body = 一阶 `out += (pen−out)(1−exp(−dt/tau))`（转角更干净不冲）。
//   弧 tail = 二次 Bézier，控制点沿 **heading**（out 速度的低通，时间常数 tau → 对弯笔滞后于 chord → 出弧）。
//   heading 是平滑状态 → 弧稳（v250 乱闪是因为用几何回看重建 heading，这里换成低通状态）。

const FALLBACK_DT = 16;   // 无时间戳（形状工具合成笔触）兜底 dt(ms)
const FLUSH_DT = 6;       // A 的 tail flush 每 tick dt(ms)（只决定采样密度）

export class StrokeSmoother {
  // opts: { tau(ms), deadzone(doc px), tailBow(弧增益,1=自然), firstOrder(true=B/false=A) }
  constructor(opts = {}) {
    this.tau = Math.max(0, opts.tau || 0);
    this.r = Math.max(0, opts.deadzone || 0);
    this.bow = opts.tailBow == null ? 1 : Math.max(0, opts.tailBow);
    this.firstOrder = !!opts.firstOrder;
    this.cx = []; this.cy = []; this.cp = [];
    this._committed = 0; this._tailLen = 0;
    this.seq = 0;
    this._ox = 0; this._oy = 0; this._vx = 0; this._vy = 0;   // A:pos+vel / B:out+heading
    this._sx = 0; this._sy = 0;        // 死区锚（去抖后的 pen）
    this._lastT = null; this._lastP = 0;
    this._started = false;
  }

  get count() { return this.cx.length; }

  push(x, y, p, t) {
    this.seq++;
    if (!this._started) {
      this._started = true;
      this._ox = x; this._oy = y; this._vx = 0; this._vy = 0; this._sx = x; this._sy = y;
      this._lastT = (t == null ? null : t); this._lastP = p;
      this.cx.push(x); this.cy.push(y); this.cp.push(p);
      this._committed = 1; this._tailLen = 0;
      return;
    }
    for (let i = 0; i < this._tailLen; i++) { this.cx.pop(); this.cy.pop(); this.cp.pop(); }

    // ① stabilization 死区（硬空间阈值，与时间常数正交）
    if (this.r > 0) {
      const dx = x - this._sx, dy = y - this._sy, d = Math.hypot(dx, dy);
      if (d > this.r) { const k = (d - this.r) / d; this._sx += dx * k; this._sy += dy * k; }
    } else { this._sx = x; this._sy = y; }

    // ② 时间缓冲追踪
    let dt = FALLBACK_DT;
    if (t != null) { dt = this._lastT == null ? FALLBACK_DT : Math.max(0.001, t - this._lastT); this._lastT = t; }
    if (this.tau <= 0) {
      this._ox = this._sx; this._oy = this._sy; this._vx = 0; this._vy = 0;
    } else if (this.firstOrder) {                       // B：一阶 EMA + heading 低通
      const a = 1 - Math.exp(-dt / this.tau);
      const nox = this._ox + (this._sx - this._ox) * a, noy = this._oy + (this._sy - this._oy) * a;
      const ivx = (nox - this._ox) / dt, ivy = (noy - this._oy) / dt;   // 瞬时 out 速度(px/ms)
      this._vx += (ivx - this._vx) * a; this._vy += (ivy - this._vy) * a;  // heading = 低通速度(时间常数 tau)
      this._ox = nox; this._oy = noy;
    } else {                                            // A：二阶时间制 SmoothDamp
      const s = smoothDamp(this._ox, this._oy, this._vx, this._vy, this._sx, this._sy, this.tau, dt);
      this._ox = s[0]; this._oy = s[1]; this._vx = s[2]; this._vy = s[3];
    }
    this.cx.push(this._ox); this.cy.push(this._oy); this.cp.push(p);
    this._committed = this.cx.length;
    this._lastP = p;

    this._tailLen = this._buildTail(p);
  }

  _buildTail(tp) {
    if (this.tau <= 0) return 0;
    const ox = this._ox, oy = this._oy, sx = this._sx, sy = this._sy;
    const dx = sx - ox, dy = sy - oy, d = Math.hypot(dx, dy);
    if (this.firstOrder) {
      // B：二次 Bézier，控制点沿 heading（弯笔 heading≠chord → 鼓；直行 heading≈chord → 直）
      if (d < 0.5) return 0;
      let ux = this._vx, uy = this._vy, ul = Math.hypot(ux, uy);
      if (ul < 1e-4) { ux = dx / d; uy = dy / d; } else { ux /= ul; uy /= ul; }
      const cxp = ox + ux * d * this.bow * 0.5, cyp = oy + uy * d * this.bow * 0.5;
      const N = Math.max(1, Math.ceil(d / 2)); let n = 0;
      for (let i = 1; i <= N; i++) {
        const u = i / N, mu = 1 - u;
        this.cx.push(mu * mu * ox + 2 * mu * u * cxp + u * u * sx);
        this.cy.push(mu * mu * oy + 2 * mu * u * cyp + u * u * sy);
        this.cp.push(tp); n++;
      }
      return n;
    }
    // A：从 (pos, vel·bow) 继续 SmoothDamp flush 到 pen = 动量弧
    let px = ox, py = oy, vx = this._vx * this.bow, vy = this._vy * this.bow;
    if (d < 0.5 && Math.hypot(vx, vy) < 0.5) return 0;
    let n = 0, lax = px, lay = py;
    const MAX = Math.ceil(this.tau / FLUSH_DT * 6) + 64;
    for (let i = 0; i < MAX; i++) {
      if (Math.hypot(px - sx, py - sy) < 0.2 && Math.hypot(vx, vy) < 0.5) break;
      const s = smoothDamp(px, py, vx, vy, sx, sy, this.tau, FLUSH_DT);
      px = s[0]; py = s[1]; vx = s[2]; vy = s[3];
      if (Math.hypot(px - lax, py - lay) >= 0.15) { this.cx.push(px); this.cy.push(py); this.cp.push(tp); n++; lax = px; lay = py; }
    }
    this.cx.push(sx); this.cy.push(sy); this.cp.push(tp); n++;
    return n;
  }

  finish() {
    if (!this._started) return;
    this._committed = this.cx.length;
    this._tailLen = 0;
  }

  frozenIndex() { return this._committed - 1; }
  update() {}
}

// 时间制 SmoothDamp（临界阻尼，Game Programming Gems 4 有理近似）。smoothTime 与 dt 同量纲(ms)。
function smoothDamp(px, py, vx, vy, tx, ty, smoothTime, dt) {
  const omega = 2 / smoothTime, x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const cdx = px - tx, cdy = py - ty;
  const tmx = (vx + omega * cdx) * dt, tmy = (vy + omega * cdy) * dt;
  return [tx + (cdx + tmx) * exp, ty + (cdy + tmy) * exp, (vx - omega * tmx) * exp, (vy - omega * tmy) * exp];
}
