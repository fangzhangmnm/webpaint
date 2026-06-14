// 位置平滑 — 时间制二阶临界阻尼 SmoothDamp（时间缓冲）+ 动量弧 tail。详 docs/brush-procreate-smoothing.md。
//
// 两层：
//   【时间缓冲 committed】二阶临界阻尼 SmoothDamp，**smoothTime = tau（时间制，用真实 dt）**：
//     状态 = pos(out) + vel。稳态滞后 ≈ 速度×tau（一致时间滞后，与采样率/笔速/几何无关）→ 跟笔、可控、
//     顿涌现（转角自然减速→滞后缩小→角紧、无多边形）、去抖（二阶低通，全速一致衰减）、帧率无关（真实 dt）。
//     比一阶 EMA 多一个 **vel 动量状态**——弧白嫖它、不用估算 heading。
//   【动量弧 tail】每 push 从 (pos, vel·bow) 的拷贝**非破坏地继续跑 SmoothDamp 飞向光标** → 一段弧（贴笔尖预览）。
//     弧来自 vel 的切向动量；直行 vel 朝光标 → 退化直线。vel 是平滑积分的连续状态 → 弧帧间稳、**不闪**。
//     抬笔 finish() = 把这段弧整段转正 → 预览所见即所得（≈ Procreate 的动作）。
//
// 注：一阶 EMA + 直线 tail 的方案 B 实测与 A 几乎一样、A 略好（B 的直线 tail 看得出来），已弃；详 lessons #15。
//     之前觉得平滑「不行」主要是 **stabilization 没开（=0）的煤气灯**，不是 A/B 算法差别——开了死区就好。
//
// 缩放一致：tau 是时间、scale 无关；deadzone 才 ÷scale。
//
// 契约（brush.js 用）：push(x,y,p,t) / update(空) / finish / frozenIndex / count / seq / cx,cy,cp。
//   cx/cy/cp = [committed out(0.._committed-1) … 动量弧 tail(_committed..end，末点=pen)]，frozenIndex=_committed-1。

const FALLBACK_DT = 16;   // 无时间戳（形状工具合成笔触）兜底 dt(ms)
const FLUSH_DT = 6;       // tail flush 每 tick dt(ms)（只决定弧采样密度，不决定弧形）

export class StrokeSmoother {
  // opts: { tau:时间常数(ms,0=不平滑), deadzone:死区半径(doc px), tailBow:弧动量增益(1=自然,>1 更鼓,0=直) }
  constructor(opts = {}) {
    this.tau = Math.max(0, opts.tau || 0);
    this.r = Math.max(0, opts.deadzone || 0);
    this.bow = opts.tailBow == null ? 1 : Math.max(0, opts.tailBow);
    this.cx = []; this.cy = []; this.cp = [];
    this._committed = 0; this._tailLen = 0;
    this.seq = 0;
    this._ox = 0; this._oy = 0; this._vx = 0; this._vy = 0;   // pos + vel（二阶动量状态）
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

    // ① stabilization 死区（与 tau 正交：硬空间阈值 vs 频域）
    if (this.r > 0) {
      const dx = x - this._sx, dy = y - this._sy, d = Math.hypot(dx, dy);
      if (d > this.r) { const k = (d - this.r) / d; this._sx += dx * k; this._sy += dy * k; }
    } else { this._sx = x; this._sy = y; }

    // ② 时间缓冲：二阶时间制 SmoothDamp（推进 pos + vel）
    let dt = FALLBACK_DT;
    if (t != null) { dt = this._lastT == null ? FALLBACK_DT : Math.max(0.001, t - this._lastT); this._lastT = t; }
    if (this.tau > 0) {
      const s = smoothDamp(this._ox, this._oy, this._vx, this._vy, this._sx, this._sy, this.tau, dt);
      this._ox = s[0]; this._oy = s[1]; this._vx = s[2]; this._vy = s[3];
    } else { this._ox = this._sx; this._oy = this._sy; this._vx = 0; this._vy = 0; }
    this.cx.push(this._ox); this.cy.push(this._oy); this.cp.push(p);
    this._committed = this.cx.length;
    this._lastP = p;

    // ③ 动量弧 tail：从 (pos, vel·bow) 继续 flush 到 pen
    this._tailLen = this._buildTail(p);
  }

  // 非破坏地从 (pos, vel·bow) 继续 SmoothDamp 飞向 pen，收集弧点，末点钉 pen。返回点数。
  _buildTail(tp) {
    if (this.tau <= 0) return 0;
    let px = this._ox, py = this._oy, vx = this._vx * this.bow, vy = this._vy * this.bow;
    const sx = this._sx, sy = this._sy;
    if (Math.hypot(px - sx, py - sy) < 0.5 && Math.hypot(vx, vy) < 0.5) return 0;   // 笔尖≈光标且无动量 → 无 tail
    let n = 0, lax = px, lay = py;
    const MAX = Math.ceil(this.tau / FLUSH_DT * 6) + 64;
    for (let i = 0; i < MAX; i++) {
      if (Math.hypot(px - sx, py - sy) < 0.2 && Math.hypot(vx, vy) < 0.5) break;
      const s = smoothDamp(px, py, vx, vy, sx, sy, this.tau, FLUSH_DT);
      px = s[0]; py = s[1]; vx = s[2]; vy = s[3];
      if (Math.hypot(px - lax, py - lay) >= 0.15) { this.cx.push(px); this.cy.push(py); this.cp.push(tp); n++; lax = px; lay = py; }
    }
    this.cx.push(sx); this.cy.push(sy); this.cp.push(tp); n++;   // 钉光标（贴指/画到头）
    return n;
  }

  // 抬笔收尾：动量弧 tail 已抵光标 → 整段转正（预览所见即所得）。
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
