# 笔刷平滑 — Procreate 三参重写

> as-of v243 / 2026-06-13。取代 `brush-frozen-tail-smoothing.md`（弧长二次 WLS quad）与
> `stroke-smoother-time-gate.md`（时间门，已 superseded）。依据：用户 `docs/brush proposal 20260613.md`
> （Procreate Handbook 行为描述 + Krita 源码反推）。

## 为什么重写

旧主笔刷平滑 = 弧长三角权**局部二次回归（quad）** + frozen/tail lookahead（`stroke-smoother.js`
v148–v242）。数学甜点没错，但：

1. **overcomplex**（用户裁定）。每点一个 WLS 窗口、每帧重算后缀、负旁瓣 overshoot、内缩 bias、
   时间门反号…一堆耦合旋钮，调不动、解释不清。
2. **参数没接全**：per-preset 有 `streamline/stabilization/pullStabilizer/motionFilter` 四字段，
   但主笔刷**只接了 `streamline`**。用户在预设里设的 `stabilization` 对主笔刷完全没生效——
   "以为在调的旋钮根本没连上"。
3. 用户要的是 **Procreate 的简单模型**，不是 Krita 四档。

## 目标模型（只此三参）

| 参数 | 本质 | 滤什么 |
|---|---|---|
| **streamline** | 拉绳 EMA（对**重采样后**的点） | 低频曲线形状（带滞后地重塑） |
| **streamline-pressure** | 同一套 EMA 套到压感通道 | 压感抖动（宽度不抖） |
| **stabilization** | 死区拉绳（dead-zone pulled-string） | 高频手抖（半径内不动） |

**剃刀掉**：`motionFilter`（用户在 Procreate 里从不开，算法也没公开依据）、`pullStabilizer`
（非 Procreate 概念）。两字段在旧数据里容忍读取但不再生效、不再出现在 UI。

## 算法（`stroke-smoother.js`，纯几何无 canvas）

输入：raw 点流 `(x, y, p)`（doc 坐标）。每点先死区、再按弧长重采样、再 EMA。

```
每 push(x, y, p):
  ① stabilization 死区：
       d = dist(raw, stabAnchor)
       if d > r:  stabAnchor += (raw − stabAnchor)·(d−r)/d   # 半径 r 内不动，杀手抖
       s = stabAnchor                                         # 去抖后的 raw
  ② 重采样：从 lastS 沿直线走到 s，每 step(=Δ) 落一个采样点 q（压感线性插值）
  ③ streamline EMA（对每个 q）：
       ema += (q − ema)·(1 − a)        # a∈[0,1)，越大滞后越重
       emaP += (qP − emaP)·(1 − aP)
       → ema 作为**已提交锚点**追加进 cx/cy/cp
```

**帧率无关**：EMA 跑在**固定弧长 Δ** 的重采样点上，不是 raw event 上。120Hz / 60Hz / 鼠标
事件密度不同，落锚点数只取决于走过的弧长 → 平滑强度一致。（旧 quad 也是弧长无关，但靠每帧
重算窗口换来；这里是结构性免费。）

**EMA 因果 → 锚点永不回改**：`ema_n` 只依赖 `ema_{n-1}` 和 `q_n`，一旦落定就是终值。
所以**不用每帧重算后缀**（quad 的大头开销），锚点只追加。这是"比我们想的简单"的关键。

## 贴笔尖（保留，简单做法）

渲染线 = **已提交锚点串** ⊕ **一条从「最后锚点」直连「真实笔尖」的活动 tail**（直线段）。

- `cx/cy/cp = [锚点₀ … 锚点_{m−1}, 笔尖]`，`count = m+1`，`frozenIndex() = m−1`。
- frozen 段（`[0, m−1]`）= EMA 锚点，烤进 stroke buffer，永不再画。
- tail 段 = `锚点_{m−1} → 笔尖`，**每帧清掉重画**（笔尖随手移动 → 贴指）。
- 笔尖 = 死区输出（stab=0 时 = raw 精确贴指；stab>0 时滞后半径 r，这是稳定的代价）。
- **抬笔 catch-up**：endStroke 把 tail 整段（…→笔尖）转正烤死 → 线画到头、不"画不到头"。

EMA 锚点滞后笔尖约 `lag = Δ·a/(1−a)`（直线段把这段差补成直线）。锚点串随你画过去逐 Δ 吸收。
所以稳态画面 = 平滑已提交轨迹 + 一小段直连光标的桥。streamline 越大桥越长（高 streamline =
牺牲贴笔尖换更顺，这是 Procreate 同款取舍——重 streamline 本来就拖尾）。

## 参数映射（`input.js`，scale 已知处算）

screen px 量纲 → doc px（÷scale），让手感随缩放一致：

```
Δ_doc   = SMOOTH.resampleStepPx / scale
L_doc   = streamline          · SMOOTH.streamlineMaxLagPx / scale   # 目标滞后(弧长)
a       = L_doc / (L_doc + Δ_doc)                                   # 线性化滞后控制
Lp      = streamlinePressure  · SMOOTH.pressureMaxLagPx / scale
aP      = Lp / (Lp + Δ_doc)
r_doc   = stabilization       · SMOOTH.stabMaxPx / scale            # 死区半径
```

`a = L/(L+Δ)` 而非 `a = streamline` 直取：EMA 滞后对 a 在 a→1 处极敏感，直取会让滑块"前 90%
没感觉、最后 10% 暴冲"。按目标滞后长度反解 a → 滑块线性可用。

`SMOOTH`（dev 面板 live 可调、自测）默认：
`resampleStepPx=2, streamlineMaxLagPx=24, pressureMaxLagPx=24, stabMaxPx=8`。

## 分档

- **画笔 / 橡皮（buffered）**：本模块（EMA + 死区 + 贴笔尖 catch-up）。
- **smudge / 像素**：`stroke-input-smooth.js` 同三参的 per-event 版（无 lookahead/catch-up，
  直接出去抖点；这类笔无法重画 tail，只需去抖）。
- **液化 / filter brush**：raw 无位置平滑。

## 砍掉的东西（别再找）

quad WLS（`_computeC`/m0..m4 矩）、frozenIndex 的 Wmax 保守冻结、内缩 deflate、轻压 boost、
时间门 dwellMs、速度自适应 V_REF。都是旧 quad/四件套的零件，本模型不需要。
`smoothBoost/deflate/vref/lookaheadCap` 配置项删除。
