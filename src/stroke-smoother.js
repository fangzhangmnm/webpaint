// 位置平滑 — 时间常数指数追踪（时间缓冲）+ 贴笔尖弧 tail。详 docs/brush-procreate-smoothing.md。
//
// 两层：
//   【时间缓冲 committed】核心一行：out += (pen − out)·(1 − exp(−dt/tau))。
//     out = 平滑笔尖，dt = 真实事件间隔(ms)，tau 从 streamline 映射。笔尖恒滞后笔一个**时长 tau**
//     （与采样率/笔速/几何无关）→ 跟笔、可控、顿涌现（滞后=速度×tau，转角自然减速→角紧、无多边形）、
//     去抖（频域低通、全速一致）、帧率无关（用真实 dt）。out 因果终值，逐点烤进 frozen buffer。
//   【贴笔尖弧 tail】每 push 重画一条从 out（滞后笔尖）→ pen（光标）的弧（二次 Bézier，离开 out 沿最近
//     平滑运动方向的切线 → 弯向光标 = 动量弧；直行则退化为直线）。这是「跟笔预览」——画途中线贴到笔尖、
//     弯笔出弧。抬笔 finish() 把这段弧整段转正 → 预览所见即所得（≈ Procreate 的动作）。
//
// 缩放一致：tau 是时间、scale 无关（屏幕滞后=屏幕速度×tau 天然随缩放一致）；deadzone 才 ÷scale。
//
// 契约（brush.js 用）：push(x,y,p,t) / update(空) / finish / frozenIndex / count / seq / cx,cy,cp。
//   cx/cy/cp = [committed out(0.._committed-1) … 贴笔尖弧 tail(_committed..end，末点=pen)]，frozenIndex=_committed-1。

const FALLBACK_DT = 16;   // 无时间戳（如形状工具合成笔触）时的名义 dt(ms)

export class StrokeSmoother {
  // opts: { tau:时间常数(ms,0=不平滑), deadzone:死区半径(doc px), tailBow:弧 tail 鼓度(0=直,~0.5 自然) }
  constructor(opts = {}) {
    this.tau = Math.max(0, opts.tau || 0);
    this.r = Math.max(0, opts.deadzone || 0);
    this.bow = opts.tailBow == null ? 0.5 : Math.max(0, opts.tailBow);
    this.cx = []; this.cy = []; this.cp = [];
    this._committed = 0; this._tailLen = 0;
    this.seq = 0;
    this._ox = 0; this._oy = 0;        // out（平滑笔尖，时间缓冲）
    this._sx = 0; this._sy = 0;        // 死区锚（去抖后的 pen）
    this._lastT = null; this._lastP = 0;
    this._started = false;
  }

  get count() { return this.cx.length; }

  push(x, y, p, t) {
    this.seq++;
    if (!this._started) {
      this._started = true;
      this._ox = x; this._oy = y; this._sx = x; this._sy = y;
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

    // ② 时间缓冲：时间常数指数追踪
    let alpha = 1;
    if (this.tau > 0) {
      let dt = FALLBACK_DT;
      if (t != null) { dt = this._lastT == null ? FALLBACK_DT : Math.max(0, t - this._lastT); this._lastT = t; }
      alpha = 1 - Math.exp(-dt / this.tau);
    } else if (t != null) { this._lastT = t; }
    this._ox += (this._sx - this._ox) * alpha;
    this._oy += (this._sy - this._oy) * alpha;
    this.cx.push(this._ox); this.cy.push(this._oy); this.cp.push(p);
    this._committed = this.cx.length;
    this._lastP = p;

    // ③ 贴笔尖弧 tail：out → pen 的二次 Bézier（跟笔预览）
    this._tailLen = this._buildTail(p);
  }

  // 从 out（滞后笔尖）到 pen（去抖光标）画一段弧：离开 out 沿**来向**（committed 路径 ~d 弧长前的 heading，
  //   = 动量方向，非 EMA 朝 pen 的 chase 向）→ 弯向 pen = 动量弧。直行则来向=朝 pen → 退化为直线。返回点数。
  _buildTail(tp) {
    const ox = this._ox, oy = this._oy, sx = this._sx, sy = this._sy;
    const dx = sx - ox, dy = sy - oy, d = Math.hypot(dx, dy);
    if (d < 0.5) return 0;                            // 笔尖≈光标 → 无需 tail
    // 来向：从 committed 路径上「累积弧长 ≥ d」之前的点 → out
    let bx = ox, by = oy, acc = 0;
    for (let i = this._committed - 1; i > 0; i--) {
      acc += Math.hypot(this.cx[i] - this.cx[i - 1], this.cy[i] - this.cy[i - 1]);
      bx = this.cx[i - 1]; by = this.cy[i - 1];
      if (acc >= d) break;
    }
    let ux = ox - bx, uy = oy - by;
    const ul = Math.hypot(ux, uy);
    if (ul < 1e-4) { ux = dx / d; uy = dy / d; } else { ux /= ul; uy /= ul; }
    const cxp = ox + ux * d * this.bow, cyp = oy + uy * d * this.bow;   // Bézier 控制点
    const N = Math.max(1, Math.ceil(d / 2));
    for (let i = 1; i <= N; i++) {
      const u = i / N, mu = 1 - u;
      this.cx.push(mu * mu * ox + 2 * mu * u * cxp + u * u * sx);
      this.cy.push(mu * mu * oy + 2 * mu * u * cyp + u * u * sy);
      this.cp.push(tp);
    }
    return N;
  }

  // 抬笔收尾：贴笔尖弧 tail 已抵光标 → 整段转正（预览所见即所得，画到头）。
  finish() {
    if (!this._started) return;
    this._committed = this.cx.length;
    this._tailLen = 0;
  }

  frozenIndex() { return this._committed - 1; }
  update() {}
}
