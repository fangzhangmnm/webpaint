> 🪦 **SUPERSEDED · v243+ 整条删除**：速度自适应 streamline / V_REF 这套**已不存在**（平滑核换成
> 时间常数二阶 SmoothDamp，见 [20260613-brush-procreate-smoothing.md](20260613-brush-procreate-smoothing.md)）。本文仅作
> 历史；**别照它实现任何东西**。

# Streamline 速度自适应 数学（v124g 起）— 已删除，仅存档

## 目的

老 streamline 一阶 IIR LPF 在所有速度下用固定 α，慢笔时 stamp 落点与指尖始终有
固定滞后（user：「拖动落点和笔刷有距离」）。希望：
- **慢笔贴指**（怕滞后）
- **快笔满滤**（怕抖）

## 公式

```
v_ref:    参考速度，CSS px/ms（bake default 0.3，localStorage 'webpaint.vref' 可覆盖）
v:        |Δp| / Δt        （CSS px/ms；clientX 已 DPR 归一，跨设备一致）
t:        clamp(v / v_ref, 0, 1)   // 无量纲
ramp:     smoothstep(t) = t² (3 - 2t)
α_base:   max(0.05, 1 - streamline)  // 老语义
adapt:    streamline (= user 调的 streamline 值本身)
α:        α_base + adapt × (1 - ramp) × (1 - α_base)
        = lerp(α_base, lerp(1, α_base, ramp), adapt)
sm_new:   sm + α × (raw - sm)        // 一阶 EMA
```

## 量纲分析

唯一有量纲量是 `v` 和 `v_ref`，都是 CSS px/ms。比值 `t = v/v_ref` 无量纲，可入 ramp。

**关键**：`v_ref` 是参考量，不是阈值。`ramp(v)` 在 `v = v_ref` 处饱和，但不是
开关 —— 在 [0, v_ref] 之间平滑过渡。

## V_REF 取值依据

CSS px / inch 换算（W3C 定义）：1 inch = 96 CSS px。

| 速度 (in/s) | 速度 (CSS px/ms) | 场景 |
|---|---|---|
| 0.5 | 0.048 | 几乎停手 |
| 1 | 0.096 | 慢仔细 |
| 3 | 0.288 | 典型仔细画 |
| 5 | 0.48 | 流畅笔触 |
| 10 | 0.96 | 自由挥洒 |
| 15+ | 1.4+ | 草草扫线 |

v_ref = 0.3 落在 **3 in/s ≈ 典型仔细画**：超过这个就 ramp 饱和、streamline 满血。

旧版 v124b V_HI = 1.5 = 15 in/s 当"快画"是估错。典型 5 in/s 画速 → ramp 只 0.21，
streamline 几乎被废，user 反映"streamline=1 比之前弱"。v124g 改 V_REF = 0.3 后
典型画速 v=0.5 → t=1.67 → clamp 1 → ramp=1 → streamline 满血还原。

## adaptStrength = streamline 的意图

`adapt = streamline` 让速度自适应**比例缩放**于用户选的 streamline：

| streamline | 慢笔 (ramp=0) | 快笔 (ramp=1) |
|---|---|---|
| 0   | α=1（不滤） | α=1（不滤） |
| 0.3 (default) | α=0.79 | α=0.7 |
| 1   | α=1.0（无滞后） | α=0.05（满滤） |

streamline=0.3 与老版差异 ~0%（慢笔 0.79 vs 老 0.7，肉眼难察）。
streamline=1 慢笔贴指 + 快笔满滤，正是 user 想要的双效。

## 怎么调教 V_REF

```
// 默认 0.3。想让 streamline 更早介入：拉小（如 0.2）。
// 想要更"飞机派"才介入：拉大（如 0.5）。
localStorage.setItem("webpaint.vref", "0.2");
location.reload();
```

后续可在主菜单 → 设置 加一条 slider；目前先 console 调。

## 未实施 / 已知 trade-off

- **帧率独立**：α 是每-event 系数，120 Hz iPad 比 60 Hz 总滤量翻倍。理论上要
  用时间常数 τ + α_eff = 1 - exp(-Δt/τ)。**暂未实施**——iPad/Mac 跨平台差异目前不大。
  以后真踩到再改。
- **DPR 归一**：✓ 已 OK（clientX 是 CSS px）
- **zoom 归一**：✗ 没做。高 zoom 时同手速 → screen px/ms 不变，但 doc px/ms 变大。
  用户感觉"放大画时 streamline 变弱"。修法：v 改 doc px/ms = v_screen / board.zoom。
  暂未实施——user 觉得不影响日常画。
