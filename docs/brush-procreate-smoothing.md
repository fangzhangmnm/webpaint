# 笔刷平滑 — 时间常数指数追踪（一行模型）

> as-of v249 / 2026-06-13。取代 `brush-frozen-tail-smoothing.md`（弧长二次 WLS quad）与
> `stroke-smoother-time-gate.md`（时间门）。依据：用户 `docs/brush proposal 20260613.md` 最终节。
> **当前实现以 `src/stroke-smoother.js` 为准。**

## 模型：核心就一行

```
out += (pen − out) · (1 − exp(−dt / tau))
```

`out` = 平滑笔尖，`pen` = 当前笔位（去抖后），`dt` = 距上次更新的**真实经过时间**(ms)，
`tau` = 时间常数(ms，从 streamline 滑块映射)。**笔尖永远滞后笔一个固定时长 tau**——与输入采样率、
笔速、几何形状全部无关。

## 为什么这一行抵掉前面所有机器

前面四版（quad 弧长回归 / 一阶 EMA+lookahead / 二阶 SmoothDamp+弧线收笔 / 连续曲率门控）都是
**用复杂机器去重建一个本该从这个时间滤波器白白掉出来的行为**。逐条对应：

- **跟笔** —— 滤波器永远朝**当前**笔位收敛、从不停追。所谓「跟笔手感」本质就是这个一致的指数追踪。
  （曲率门控在平滑区把系数压低 → 笔尖停止追踪、落后不确定距离 = 用户感觉的「没跟笔/不可控」。）
- **可控** —— 滞后恒 = `tau`（时长）。同样的手部动作 → 同样的滞后，每次都一样 → 手能建立肌肉记忆。
  几何相关的平滑（曲率门控）同动作给不同滞后，没法形成肌肉记忆。
- **顿（有限半径的顿）** —— **涌现，不用造**：稳态空间滞后 = `速度 × tau`。转角你本来就会自然减速
  （运动控制的 2/3 幂律：v ∝ R^⅓），速度掉下来 → 滞后缩小 → 笔尖贴住笔 → 转角被保成**紧而平滑
  的弯**。直线段速度高 → 滞后大 → 重平滑。一个滤波器、一个 tau，「直线顺 + 转角紧」**零检测、零阈值**
  → **不会有多边形**（v247 阈值+锚点正是栽在多边形上）。Procreate 文档说的「越快平滑越狠」不是测速
  机制，是固定时间滞后的涌现结果——文档描述症状，时间常数才是病因。
- **去抖** —— 手抖 ~8–12Hz；tau ~60–100ms 时截止频率 ~2–3Hz → 手抖在**任何速度下**都被衰减（频域
  滤波，与笔速无关，含慢速直线——曲率门控处理不干净的那个 case）。这也是它比曲率门控更「可控」的根因：
  全程频率响应一致。
- **帧率/采样率无关** —— `exp(−dt/tau)` 用真实 `dt` → 与采样率解耦。naive 的 `out += (pen−out)·k`
  用每采样点固定 `k`，平滑强度被绑死在采样率上（不同速度手感不一致），这是之前所有版本的 bug 源头。

## 算法（`stroke-smoother.js`，纯几何无 canvas）

```
每 push(x, y, p, t):
  ① stabilization 死区（与 tau 正交：硬空间阈值 vs 频域）：
       d = dist(raw, stabAnchor); if d>r: stabAnchor += (raw−stabAnchor)·(d−r)/d
       s = stabAnchor                                    # 去抖后的 raw
  ② 时间缓冲（committed）：时间常数指数追踪
       dt = t − lastT;  alpha = 1 − exp(−dt/tau)         # tau=0 → alpha=1 直通
       out += (s − out) · alpha
       → out 追加进 cx（因果终值，逐点烤进 frozen buffer）
  ③ 贴笔尖弧 tail（transient 预览，每 push 重画）：从 out → pen 画一段二次 Bézier
       来向 = committed 路径上「~d 弧长之前」的 heading（动量方向，d=|pen−out|）
       control = out + 来向̂ · d · tailBow；末点钉 pen（贴指）
       直行→来向朝 pen→退化直线；弯笔→来向≠chord→鼓成动量弧
```

`cx/cy/cp = [committed out(0.._committed−1) … 贴笔尖弧 tail(_committed..end，末点=pen)]`，`frozenIndex()=_committed−1`。

**两层 = 「时间缓冲 + 重画最后一段」≈ Procreate 的动作**：
- **时间缓冲**（committed out）= 一致滞后 `速度×tau` 的平滑骨架，因果终值、逐点烤死。
- **贴笔尖弧 tail** = 每 push 从滞后 out 弯到光标的预览（跟笔、弯笔出弧）。**抬笔 `finish()` = 把这段弧整段
  转正**（`_committed=count`，点不动）→ **预览所见即所得、画到头**。
- 关键坑：tail 的「来向」不能用 out 的瞬时速度（EMA 的 out 永远朝 pen 追 = chord 方向 → 永不鼓）；要用
  committed 路径**往回 ~d 弧长的 heading**（动量/来向），它对弯笔才 ≠ chord → 出弧。`tailBow` 控鼓度。

## 参数映射（`input.js`）

```
tau      = streamline    · SMOOTH.tauMaxMs           # 时间(ms)，scale 无关（屏幕滞后=屏幕速度×tau 天然随缩放一致）
deadzone = stabilization · SMOOTH.stabMaxPx / scale  # 死区半径(doc px)
```

**两参 per-brush**（笔刷设置）：`streamline`(→tau)、`stabilization`(→deadzone)。`SMOOTH`（dev 面板 live 可调）
默认：`tauMaxMs=160`（0.5→80ms，tremor 截止 ~2Hz）、`tailBow=0.5`（弧 tail 鼓度）、`stabMaxPx=8`、`rawStaticSq`、`pressureAlpha`。
出厂默认 streamline 0.15（轻）、勾线 0.45。**压感**走引擎侧 `pressureLPF`（per-brush ms，本就是同一类时间
滤波器，= Procreate 的 StreamLine-Pressure 子滑块），不在本模块重复。

## 分档

- **画笔 / 橡皮（buffered）**：本模块（时间缓冲 + 死区 + 贴笔尖弧 tail）。
- **smudge / 像素**：`stroke-input-smooth.js`（死区 + 一阶 EMA per-event）。**TODO**：未改成时间常数版
  （仍是固定 k，采样率相关）；这类笔非精度追踪，暂可接受，要严谨可同样改 dt 版。
- **液化 / filter brush**：raw 无位置平滑。

## 待做（backlog）

- **顿感 → 线宽**（手速驱动，慢→粗 = 马克笔/毛笔积墨的实体顿）。位置平滑已让顿「在几何上」涌现；
  线宽那一份是视觉增强，动引擎 size 路径（压感算 size 那条，钉死的手感区），单独做。
- **跑在渲染时钟**（而非输入事件）：iPad 笔 ~240Hz 有抖动、ProMotion 120Hz；存带时间戳的 raw 样本，
  每渲染 tick 用渲染 dt 推进 out → 输入率与滤波率彻底解耦，手感更稳。当前是输入事件驱动 + 真实 dt
  （已基本帧率无关，bench dt4 vs dt16 差 3.7–14.5%，tau 越大越准）。

## 砍掉的东西（别再找 / 别复活）

四版机器全删：quad WLS（`_computeC`/m0..m4）、frozen/tail lookahead、二阶 SmoothDamp（`dampStep`/弧线收笔，
**注：贴笔尖弧 tail 用 Bézier 重新做回来了，但不再是 SmoothDamp 二阶**）、连续曲率门控（Menger `κ`/
`smoothstep`/`cornerKeep`/`R_min`）、内缩 deflate、轻压 boost、时间门 dwellMs、速度自适应 V_REF、
streamline-pressure、转角阈值+硬锚点。
配置项删：`resampleStepPx/streamlineMaxLagPx/cornerFloorPx/curvatureAlpha/lookaheadCap/...`。
**经验（为什么走了四版弯路）见 `docs/lessons-brush-smoothing.md`。**
