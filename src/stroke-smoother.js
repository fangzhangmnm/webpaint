// 位置平滑 — 时间常数指数追踪（v249，一行模型）。详 docs/brush-procreate-smoothing.md。
//
// 核心就一行：out += (pen − out) · (1 − exp(−dt/tau))
//   dt = 距上次更新的**真实经过时间**(ms)，tau = 时间常数(ms，从 streamline 滑块映射)。
//   笔尖永远滞后笔**一个固定时长 tau**——与输入率、笔速、几何形状全部无关。
//
// 为什么这一行抵掉前面所有机器（转角检测/锚点/Menger 曲率/SmoothDamp/重采样，全删）：
//   · 跟笔   —— 滤波器永远朝**当前**笔位收敛、从不停追（曲率门控在平滑区让笔尖任意落后 = 把追踪掐了）。
//   · 可控   —— 滞后恒 = tau（时长），同动作同滞后 → 肌肉记忆。几何相关平滑同动作不同滞后、没法形成。
//   · 顿     —— **涌现**：稳态空间滞后 = 速度×tau。转角自然减速(幂律) → 滞后缩小 → 笔尖贴笔 → 角保成紧而
//               平滑的弯；直线段速度高 → 滞后大 → 重平滑。零检测、零阈值 → **不会有多边形**。
//   · 去抖   —— 手抖 ~8–12Hz，tau ~60–100ms 时截止 ~2–3Hz → 手抖**任何速度下**都被衰减（频域，与笔速无关）。
//   · 帧率无关 —— exp(−dt/tau) 用真实 dt → 与采样率解耦（naive 固定 k 的 EMA 被绑死在采样率上，旧 bug 源头）。
//
// 缩放一致：tau 是时间、scale 无关；屏幕滞后 = 屏幕速度×tau，天然随缩放一致（doc 内 deadzone 才 ÷scale）。
//
// 契约（brush.js 用）：push(x,y,p,t) / update(空) / finish / frozenIndex / count / seq / cx,cy,cp。
//   cx/cy/cp = [已提交 out…, 最新 out(=tip)]。out 因果终值 → frozenIndex=_committed-1（仅末点留作 tip 渲染）。

const FALLBACK_DT = 16;   // 无时间戳（如形状工具合成笔触）时的名义 dt(ms)

export class StrokeSmoother {
  // opts: { tau:时间常数(ms,0=不平滑), deadzone:死区半径(doc px) }
  constructor(opts = {}) {
    this.tau = Math.max(0, opts.tau || 0);
    this.r = Math.max(0, opts.deadzone || 0);
    this.cx = []; this.cy = []; this.cp = [];
    this._committed = 0;
    this.seq = 0;
    this._ox = 0; this._oy = 0;        // out（平滑笔尖）
    this._sx = 0; this._sy = 0;        // 死区锚（去抖后的 raw）
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
      this.cx.push(x); this.cy.push(y); this.cp.push(p);   // 起点
      this._committed = 0;
      return;
    }
    // ① stabilization 死区（与 tau 正交：硬空间阈值 vs 频域）
    if (this.r > 0) {
      const dx = x - this._sx, dy = y - this._sy, d = Math.hypot(dx, dy);
      if (d > this.r) { const k = (d - this.r) / d; this._sx += dx * k; this._sy += dy * k; }
    } else { this._sx = x; this._sy = y; }

    // ② 时间常数指数追踪：out 朝去抖 raw 收敛，滞后恒 tau
    let alpha = 1;
    if (this.tau > 0) {
      let dt = FALLBACK_DT;
      if (t != null) { dt = this._lastT == null ? FALLBACK_DT : Math.max(0, t - this._lastT); this._lastT = t; }
      alpha = 1 - Math.exp(-dt / this.tau);
    } else if (t != null) { this._lastT = t; }
    this._ox += (this._sx - this._ox) * alpha;
    this._oy += (this._sy - this._oy) * alpha;
    this.cx.push(this._ox); this.cy.push(this._oy); this.cp.push(p);
    this._committed = this.cx.length - 1;   // 末点 = tip(不冻)，其余冻
    this._lastP = p;
  }

  // 抬笔收尾：朝最后 raw(去抖 s) 跑几个 tick 直到 settle。收尾段速度本就慢 → 尾巴是一小段、不甩直线。
  finish() {
    if (!this._started) return;
    if (this.tau > 0) {
      const alpha = 1 - Math.exp(-FALLBACK_DT / this.tau);
      let it = 0;
      while (Math.hypot(this._ox - this._sx, this._oy - this._sy) > 0.2 && it++ < 240) {
        this._ox += (this._sx - this._ox) * alpha;
        this._oy += (this._sy - this._oy) * alpha;
        this.cx.push(this._ox); this.cy.push(this._oy); this.cp.push(this._lastP);
      }
    }
    this.cx.push(this._sx); this.cy.push(this._sy); this.cp.push(this._lastP);   // 钉终点（画到头）
    this._committed = this.cx.length;
  }

  frozenIndex() { return this._committed - 1; }
  update() {}
}
