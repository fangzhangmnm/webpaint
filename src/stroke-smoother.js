// 位置平滑 — Procreate 两参（二阶临界阻尼 SmoothDamp + 死区 + 贴笔尖 + 弧线 tail）。
// 详 docs/brush-procreate-smoothing.md。
//
// 为什么二阶：一阶 EMA 收笔朝单点逼近 = 直弦 → 直尾巴。SmoothDamp 带 vel 状态，落点有切向动量 →
// 收笔顺动量冲出再弯回 = 自然弧线（直线段切向=指向终点 → 仍直收）。临界阻尼 → body 不抖。
//
// 模型：raw → ① 死区 → ② 固定弧长 Δ 重采样 → ③ SmoothDamp 跟随（提交锚点，因果不回改、帧率无关）。
//
// **弧线 tail（v244b）**：tail 不再是「最后锚点→光标」的直线桥，而是每 push 从落点(带 vel)非破坏地
// SmoothDamp flush 到光标得到的**一段弧**（= 抬笔会得到的形状），挂在锚点串后面当 transient 预览。
// 这样画途中预览 = 最终落定。抬笔 finish() = 把当前这段预览弧整段转正 → 预览与结果必然一致。
//
// 契约（brush.js 用）：push / update(空) / finish / frozenIndex / count / seq / cx,cy,cp。
//   cx/cy/cp = [已提交锚点(0.._committed-1) … transient 弧 tail(_committed..end，末点=光标)]。
//   frozenIndex() = _committed-1（弧 tail 永不冻，每 push 重建）。

export class StrokeSmoother {
  // opts: { step:重采样间隔(doc px), lag:目标滞后(doc px), deadzone:死区半径(doc px) }
  //   lag=0 & deadzone=0 → 不平滑（重采样直通）。smoothTime T = lag/step。
  constructor(opts = {}) {
    this.step = Math.max(0.25, opts.step || 2);
    const lag = Math.max(0, opts.lag || 0);
    this.T = lag > 0 ? lag / this.step : 0;
    this.r = Math.max(0, opts.deadzone || 0);
    // 转角门控（edge-preserving，双边滤波思路）：输入方向在 cornerSpan 跨度上的相邻夹角 > cornerDeg
    //   时，把转角顶点钉成**硬锚点**（pos 复位到顶点、vel 清零）→ 棱角 crisp、两腿各自平滑。
    //   用 input-dir 变化检测（与 lag 无关；vel-vs-(q-pos) 在大 lag 下检测不到角）。
    //   **span 跨度**是关键：在 ~6px 跨度上测方向 → sub-span 手抖不会被误判成角（jitter robust）。
    //   cornerCos = cos(cornerDeg)。null/undefined = 不门控（旧行为；测试不传则全程满平滑）。
    this.cornerCos = (opts.cornerCos == null) ? null : opts.cornerCos;
    this.cornerSpan = Math.max(opts.cornerSpan || 0, this.step);

    this.cx = []; this.cy = []; this.cp = [];
    this._committed = 0;        // 已提交锚点数；其后是 transient 弧 tail
    this._tailLen = 0;          // 当前 transient 点数（弧 tail，每 push 弹掉重建）
    this.seq = 0;

    this._px = 0; this._py = 0; // 平滑落点 pos
    this._vx = 0; this._vy = 0; // 速度（二阶状态，动量来源）
    this._stabX = 0; this._stabY = 0;
    this._lastSX = 0; this._lastSY = 0;
    this._lastInP = 0;
    this._accum = 0;
    this._started = false;
    // 转角检测：span 锚点 + 上段输入方向（跨 push 持续）
    this._cqx = 0; this._cqy = 0;
    this._dirX = 0; this._dirY = 0; this._haveDir = false;
  }

  get count() { return this.cx.length; }

  push(x, y, p) {
    this.seq++;
    if (!this._started) {
      this._started = true;
      this._px = x; this._py = y; this._vx = 0; this._vy = 0;
      this._stabX = x; this._stabY = y;
      this._lastSX = x; this._lastSY = y; this._lastInP = p;
      this._accum = 0;
      this._cqx = x; this._cqy = y;                        // 转角 span 锚点起点
      this.cx.push(x); this.cy.push(y); this.cp.push(p);   // 笔尖
      this._committed = 0; this._tailLen = 1;
      return;
    }
    // 弹掉上一帧的 transient 弧 tail（永不冻、不入提交）
    for (let i = 0; i < this._tailLen; i++) { this.cx.pop(); this.cy.pop(); this.cp.pop(); }

    // ① stabilization 死区
    if (this.r > 0) {
      const dx = x - this._stabX, dy = y - this._stabY;
      const d = Math.hypot(dx, dy);
      if (d > this.r) { const k = (d - this.r) / d; this._stabX += dx * k; this._stabY += dy * k; }
    } else { this._stabX = x; this._stabY = y; }
    const sx = this._stabX, sy = this._stabY;

    // ② 重采样 lastS→s；③ 每采样点 q 做 SmoothDamp（推进真 pos/vel）→ 提交锚点
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
      // 转角检测（input-dir 在 cornerSpan 跨度上变化，lag 无关 + jitter robust）：
      //   走够一个 span 就比相邻 span 方向；夹角 > cornerDeg → span 起点(顶点) 钉硬锚点。
      if (this.cornerCos != null) {
        const ax = qx - this._cqx, ay = qy - this._cqy, al = Math.hypot(ax, ay);
        if (al >= this.cornerSpan) {
          const ndx = ax / al, ndy = ay / al;
          if (this._haveDir && (ndx * this._dirX + ndy * this._dirY) < this.cornerCos) {
            this.cx.push(this._cqx); this.cy.push(this._cqy); this.cp.push(qp);   // 硬锚顶点
            this._px = this._cqx; this._py = this._cqy; this._vx = 0; this._vy = 0;
          }
          this._dirX = ndx; this._dirY = ndy; this._haveDir = true;
          this._cqx = qx; this._cqy = qy;
        }
      }
      const s = dampStep(this._px, this._py, this._vx, this._vy, qx, qy, this.T);
      this._px = s[0]; this._py = s[1]; this._vx = s[2]; this._vy = s[3];
      this.cx.push(this._px); this.cy.push(this._py); this.cp.push(qp);
    }
    this._accum += L - pos;
    this._lastSX = sx; this._lastSY = sy; this._lastInP = p;
    this._committed = this.cx.length;

    // 重建 transient 弧 tail：从真 pos/vel 的**拷贝** flush 到光标，末点钉光标（贴指）
    this._tailLen = this._buildTail(sx, sy, p);
  }

  // 从 (pos,vel) 的拷贝 SmoothDamp flush 到 (tx,ty)，追加弧点，末点 = (tx,ty)。返回追加点数。
  _buildTail(tx, ty, tp) {
    let n = 0;
    if (this.T > 0) {
      let px = this._px, py = this._py, vx = this._vx, vy = this._vy;
      let lax = px, lay = py;
      const MAX = Math.ceil(this.T * 6) + 64;
      for (let i = 0; i < MAX; i++) {
        if (Math.hypot(px - tx, py - ty) < 0.2 && Math.hypot(vx, vy) < 0.2) break;
        const s = dampStep(px, py, vx, vy, tx, ty, this.T);   // tail = 到光标的平滑 catch-up（转角已在提交段硬锚）
        px = s[0]; py = s[1]; vx = s[2]; vy = s[3];
        if (Math.hypot(px - lax, py - lay) >= 0.15) {     // 去冗余（settle 处别堆点）
          this.cx.push(px); this.cy.push(py); this.cp.push(tp); n++; lax = px; lay = py;
        }
      }
    }
    this.cx.push(tx); this.cy.push(ty); this.cp.push(tp); n++;   // 钉光标（画到头/贴指）
    return n;
  }

  // 抬笔收尾：把当前预览弧 tail 整段转正（= 预览所见即所得）。
  finish() {
    if (!this._started) return;
    this._committed = this.cx.length;
    this._tailLen = 0;
  }

  frozenIndex() { return this._committed - 1; }   // 弧 tail 永不冻

  update() {}                                     // 因果、锚点不回改 → 无需重算
}

// 一步 SmoothDamp（临界阻尼，Game Programming Gems 4 有理近似；dt=1/步）。T<=0 → 直接吸到 target。
function dampStep(px, py, vx, vy, tx, ty, T) {
  if (T <= 0) return [tx, ty, 0, 0];
  const omega = 2 / T, x = omega;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const cdx = px - tx, cdy = py - ty;
  const tmx = vx + omega * cdx, tmy = vy + omega * cdy;
  return [tx + (cdx + tmx) * exp, ty + (cdy + tmy) * exp, (vx - omega * tmx) * exp, (vy - omega * tmy) * exp];
}
