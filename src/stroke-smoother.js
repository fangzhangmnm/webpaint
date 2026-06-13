// 位置平滑 — Procreate 两参模型（v243b：一阶 EMA → 二阶临界阻尼 SmoothDamp，出弧线收笔）。
// 详 docs/brush-procreate-smoothing.md。
//
// 为什么二阶：一阶 EMA（拉绳）收笔时朝**单个终点**指数逼近 = 一根直弦 → 直尾巴。SmoothDamp 带
// **速度状态**，抬笔时落点仍有切向动量，弹簧把它拉向终点时会顺动量冲出再弯回 → 自然弧线收笔
// （直线段则切向 = 指向终点 → 仍直收，正确）。临界阻尼 → body 不抖不振铃。
//
// 模型：raw 点流 → ① stabilization 死区 → ② 固定弧长 Δ 重采样 → ③ SmoothDamp（朝重采样点 q 跟随）。
//   SmoothDamp 因果 → 锚点落定即终值、永不回改；重采样在固定弧长 → 帧率/事件密度无关。
//
// 贴笔尖：cx/cy/cp = [已提交锚点…, 笔尖]。frozenIndex()=锚点数−1（笔尖永不冻）。tail = 最后锚点→笔尖
//   的直线桥（live 时贴指）。**抬笔 finish()**：从落点带动量 SmoothDamp 到终点、把弧尾的锚点补出来。
//
// 契约（brush.js 用）：push / update(空) / finish / frozenIndex / count / seq / cx,cy,cp。

export class StrokeSmoother {
  // opts: { step:重采样间隔(doc px), lag:目标滞后(doc px), deadzone:死区半径(doc px) }
  //   lag=0 & deadzone=0 → 不平滑（重采样直通 raw）。smoothTime T = lag/step（步为单位，dt=1/步）。
  constructor(opts = {}) {
    this.step = Math.max(0.25, opts.step || 2);
    const lag = Math.max(0, opts.lag || 0);
    this.T = lag > 0 ? lag / this.step : 0;       // smoothTime（步）；0 = 直通
    this.r = Math.max(0, opts.deadzone || 0);

    this.cx = []; this.cy = []; this.cp = [];     // 锚点串 + 末尾笔尖
    this._committed = 0;                           // 已提交锚点数；笔尖 = cx[_committed]
    this.seq = 0;                                  // push 序号（brush.js overlay 缓存键，每 push +1）

    // SmoothDamp / 死区 / 重采样状态
    this._px = 0; this._py = 0;                    // 平滑落点 pos
    this._vx = 0; this._vy = 0;                    // 速度（二阶状态，动量来源）
    this._stabX = 0; this._stabY = 0;              // 死区锚
    this._lastSX = 0; this._lastSY = 0;            // 上次去抖点（重采样起点）
    this._lastInP = 0;                             // 上次 raw 压感
    this._accum = 0;                               // 重采样累积弧长余量
    this._lastAX = 0; this._lastAY = 0;            // 上次追加的锚点（finish 去冗余用）
    this._started = false;
  }

  get count() { return this.cx.length; }

  // 一步 SmoothDamp（临界阻尼，Game Programming Gems 4 的有理近似；dt=1/步）。T=0 → 直接吸到 target。
  _damp(tx, ty) {
    if (this.T <= 0) { this._px = tx; this._py = ty; this._vx = 0; this._vy = 0; return; }
    const omega = 2 / this.T;
    const x = omega;                               // omega·dt，dt=1
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    let cdx = this._px - tx, cdy = this._py - ty;
    const tmx = (this._vx + omega * cdx);
    const tmy = (this._vy + omega * cdy);
    this._vx = (this._vx - omega * tmx) * exp;
    this._vy = (this._vy - omega * tmy) * exp;
    this._px = tx + (cdx + tmx) * exp;
    this._py = ty + (cdy + tmy) * exp;
  }

  push(x, y, p) {
    this.seq++;
    if (!this._started) {
      this._started = true;
      this._px = x; this._py = y; this._vx = 0; this._vy = 0;
      this._stabX = x; this._stabY = y;
      this._lastSX = x; this._lastSY = y; this._lastInP = p;
      this._lastAX = x; this._lastAY = y;
      this._accum = 0;
      this.cx.push(x); this.cy.push(y); this.cp.push(p);   // 笔尖（暂无锚点）
      this._committed = 0;
      return;
    }
    this.cx.pop(); this.cy.pop(); this.cp.pop();           // 去旧笔尖

    // ① stabilization 死区
    if (this.r > 0) {
      const dx = x - this._stabX, dy = y - this._stabY;
      const d = Math.hypot(dx, dy);
      if (d > this.r) { const k = (d - this.r) / d; this._stabX += dx * k; this._stabY += dy * k; }
    } else { this._stabX = x; this._stabY = y; }
    const sx = this._stabX, sy = this._stabY;

    // ② 重采样 lastS→s；③ 每个采样点 q 做 SmoothDamp → 提交锚点
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
      this._damp(qx, qy);
      this.cx.push(this._px); this.cy.push(this._py); this.cp.push(qp);
      this._lastAX = this._px; this._lastAY = this._py;
    }
    this._accum += L - pos;
    this._lastSX = sx; this._lastSY = sy; this._lastInP = p;
    this._committed = this.cx.length;

    this.cx.push(sx); this.cy.push(sy); this.cp.push(p);   // 重挂笔尖（去抖点）
  }

  // 抬笔收尾：从带动量的落点 SmoothDamp 到终点，把弧尾锚点补出来（取代直线桥）。
  // 直线段收笔仍直（切向=指向终点）；弯笔收笔出弧（动量冲出再弯回）。最后钉终点 = 画到头。
  finish() {
    if (!this._started) return;
    if (this.T <= 0 || this.cx.length === 0) return;       // 无平滑 → 直通，笔尖已在终点
    // 取终点 = 当前笔尖（去抖后的最后落点），先摘掉
    const tx = this.cx[this.cx.length - 1];
    const ty = this.cy[this.cy.length - 1];
    const tp = this.cp[this.cp.length - 1];
    this.cx.pop(); this.cy.pop(); this.cp.pop();
    const MAX = Math.ceil(this.T * 6) + 64;                // 收敛上界（防极端参数死循环）
    for (let i = 0; i < MAX; i++) {
      const settled = Math.hypot(this._px - tx, this._py - ty) < 0.2 && Math.hypot(this._vx, this._vy) < 0.2;
      if (settled) break;
      this._damp(tx, ty);
      if (Math.hypot(this._px - this._lastAX, this._py - this._lastAY) >= 0.15) {  // 去冗余（settle 处别堆点）
        this.cx.push(this._px); this.cy.push(this._py); this.cp.push(tp);
        this._lastAX = this._px; this._lastAY = this._py;
      }
    }
    this._committed = this.cx.length;
    this.cx.push(tx); this.cy.push(ty); this.cp.push(tp);  // 钉终点（画到头）
  }

  // 已提交锚点的最大下标（笔尖永不冻）。无锚点 → -1。
  frozenIndex() { return this._committed - 1; }

  // 因果、锚点不回改 → 无需重算。留空保持契约。
  update() {}
}
