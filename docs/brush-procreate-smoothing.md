# 笔刷平滑 — Procreate 两参重写

> as-of v244 / 2026-06-13。取代 `brush-frozen-tail-smoothing.md`（弧长二次 WLS quad）与
> `stroke-smoother-time-gate.md`（时间门，已 superseded）。依据：用户 `docs/brush proposal 20260613.md`
> （Procreate Handbook 行为描述 + Krita 源码反推）。
>
> **v243→v244 迭代**：① 平滑核一阶 EMA → **二阶临界阻尼 SmoothDamp**（出弧线收笔，见下）。
> ② streamline 标定加倍（`streamlineMaxLagPx` 24→48）：slider 0.5=旧满劲、0.9 更夸张；出厂默认 streamline
> 折半保手感不变（默认 0.3→0.15、勾线 0.9→0.45）。③ 删 streamline-pressure（time-domain pressureLPF 已够）。
> 最终**两参**：streamline / stabilization。

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
| **streamline** | SmoothDamp 拉绳（二阶临界阻尼，对**重采样后**的点） | 低频曲线形状（带滞后地重塑） |
| **stabilization** | 死区拉绳（dead-zone pulled-string） | 高频手抖（半径内不动） |

**剃刀掉**：`motionFilter`（用户在 Procreate 里从不开）、`pullStabilizer`（非 Procreate 概念）、
`streamlinePressure`（time-domain `pressureLPF` 已平滑压感，多余）。旧数据里容忍读取但不再生效、不再进 UI。

## 算法（`stroke-smoother.js`，纯几何无 canvas）

输入：raw 点流 `(x, y, p)`（doc 坐标）。每点先死区、再按弧长重采样、再 SmoothDamp。

```
每 push(x, y, p):
  ① stabilization 死区：
       d = dist(raw, stabAnchor)
       if d > r:  stabAnchor += (raw − stabAnchor)·(d−r)/d   # 半径 r 内不动，杀手抖
       s = stabAnchor                                         # 去抖后的 raw
  ② 重采样：从 lastS 沿直线走到 s，每 step(=Δ) 落一个采样点 q（压感线性插值）
  ③ SmoothDamp（朝 q 跟随，临界阻尼二阶，状态 = pos + vel，smoothTime T = lag/Δ）：
       GPG4 临界阻尼有理近似；T=0 → pos 直吸 q
       → pos 作为**已提交锚点**追加进 cx/cy/cp（压感直接挂 q 的 raw 压感）
```

**为什么二阶**：一阶 EMA 收笔朝单个终点指数逼近 = 一根直弦 → **直尾巴**。SmoothDamp 带 `vel` 状态，
抬笔时落点仍有切向动量 → 收笔顺动量冲出再弯回 = **自然弧线**（直线段切向=指向终点 → 仍直收）。
临界阻尼 → body 不抖不振铃。一阶无 `vel` 做不出，这是二阶 vs 一阶的本质区别。

**帧率无关**：SmoothDamp 跑在**固定弧长 Δ** 的重采样点上，平滑强度只取决于走过的弧长，
与 120/60Hz/鼠标事件密度无关（bench 实测偏差 0.0000px）。

**因果 → 锚点永不回改**：`pos_n` 只依赖 `(pos,vel)_{n-1}` 和 `q_n`，落定即终值 → **不用每帧重算后缀**，锚点只追加。

## 贴笔尖 + 弧线收笔

渲染线 = **已提交锚点串** ⊕ **transient 弧 tail**（画途中预览 = 抬笔会得到的弧，贴指）。

- `cx/cy/cp = [已提交锚点(0.._committed−1) … 弧 tail(_committed..end，末点=光标)]`，`frozenIndex() = _committed−1`。
- frozen 段 = SmoothDamp 提交锚点（因果终值），烤进 stroke buffer，永不再画。
- **弧 tail（v244b）**：**每 push** 从带动量的落点(pos,vel 的拷贝)非破坏地 SmoothDamp flush 到光标 →
  得到一段弧，挂在提交锚点串后面、末点钉光标。弯笔出弧、直笔仍直。frozenIndex 不含它 → 永不冻、每帧重建。
- **抬笔 `finish()`** = 把当前这段预览弧**整段转正**（`_committed = count`）→ **预览所见即所得**（不重算，点不动）。
- **注**：临界阻尼 under-bow（弧比真曲线浅，bench sl=0.9 约 0.8px vs 真弧 ~2px）；要更夸张的 Procreate 弧就
  把 finish/tail 阻尼调松（增大动量）——device 手感终判。

## 参数映射（`input.js`，scale 已知处算）

screen px 量纲 → doc px（÷scale），让手感随缩放一致：

```
Δ_doc   = SMOOTH.resampleStepPx / scale
lag_doc = streamline    · SMOOTH.streamlineMaxLagPx / scale   # 目标滞后(弧长)；引擎内 T = lag/Δ
r_doc   = stabilization · SMOOTH.stabMaxPx / scale            # 死区半径
```

`SMOOTH`（dev 面板 live 可调、自测）默认：`resampleStepPx=2, streamlineMaxLagPx=48, stabMaxPx=8`。
`streamlineMaxLagPx=48` 标定：slider 0.5 → 24px 滞后（= 旧 24 标定的满格）、0.9 → 43px（更夸张）。
出厂默认 streamline 相应折半（0.3→0.15、勾线 0.9→0.45）保持出厂手感不变。

## 分档

- **画笔 / 橡皮（buffered）**：本模块（SmoothDamp + 死区 + 贴笔尖 + 弧线 finish）。
- **smudge / 像素**：`stroke-input-smooth.js` 两参 per-event 版（死区 + 一阶 EMA，无 lookahead/finish；
  这类笔直接写 layer 无法重画 tail，只需去抖）。
- **液化 / filter brush**：raw 无位置平滑。

## 砍掉的东西（别再找）

quad WLS（`_computeC`/m0..m4 矩）、frozenIndex 的 Wmax 保守冻结、内缩 deflate、轻压 boost、
时间门 dwellMs、速度自适应 V_REF、streamline-pressure（aP/emaP）。旧 quad/四件套或上一版的零件。
`smoothBoost/deflate/vref/lookaheadCap/pressureMaxLagPx` 配置项删除。
