# Brush 设计笔记

User × Claude 讨论沉淀。和 [[brush-v0.md]] 不同：v0 写"现在的实现"，这份写"决策、为什么、还没做的"。

## 当前模式：累积型 stamp 笔刷（accumulate-by-length）

适用：默认笔刷、橡皮、未来的 pen/pencil/marker。

```
on extendStroke(x, y, p):
  L = hypot(x - lastX, y - lastY)
  while accumDist + (L - segPos) >= step:
    在 lerp 点撒一颗 stamp 到 buffer，accumDist = 0
  accumDist += L - segPos
```

特征：
- **沿路径每 step doc-px 一颗 stamp**，**step 走当前 stamp 的有效半径**：
  `step = max(0.5, size × p^sizeCurve × spacing)`。
  - 旧版（v19..v28）step = size × spacing 是整笔常量。在压感关 / 满压时没问题，
    低压感时 stamp 直径缩成 size × p^0.6 但 step 没缩 → 笔触上能看到一颗颗豆。
  - v30 改成 step 用 current event 的 pressure 算，低压感时 step 跟着缩，
    豆豆消失。
  - 注意：早期一度禁了 step 走 pressure（v19）是因为当时 stamp 之间的 accumDist
    会被 step 反复缩涨干扰；buffer 架构（v28）+ timeStamp 单调过滤（v26）后
    这个干扰被消化掉了，可以放心走 pressure。
- **一笔一 buffer**：layer-size RGBA 离屏 canvas
- **per-stamp alpha 不含 s.opacity**：只含 `p^opacityCurve`（压感）
- **endStroke 一次性合成**：buffer × s.opacity 写进 layer
  - paint：`source-over`
  - erase：`destination-out`
- **结果**：低 opacity 笔触折返不叠暗 / 不叠擦。max alpha = s.opacity，无论折返几次

### 为什么不直接 per-stamp 写 layer

旧版（v0..v27）就是 per-stamp 写 layer。问题：
- brush.opacity = 0.3，画一笔重叠折返：每颗 stamp source-over 0.3 → 两颗叠成 0.51 → 越叠越深
- 用户审美：折返应该等同一次描深，**不**等于多次描深

Procreate 也是这么做的（"max ladder + ×opacity 末尾"）。Canvas 2D 没有 pixel-perfect alpha-max 原语，用 buffer + source-over 在 1.0 自然封顶 = 一阶近似，够用。

### Live preview

- paint：board 在 layer 之上 composite buffer × s.opacity
- erase：board 把 layer 画进临时合成 canvas，对它 dst-out buffer × s.opacity，再画到屏幕（屏幕 ctx 是 `alpha:false`，对 dst-out 不可预期）

### iPad coalesced 边界过滤（重要前置条件）

input.js 必须按 `ev.timeStamp` 严格单调过滤 raw event，否则 path arc-length 会被 Safari iOS 的 coalesced 边界回放注水 → 几十 doc-px 周期的疏密波。详见 [[brush-density-wave.md]] 和 [[ipad-coalesced-events.md]]。

---

## 未来模式：时间累积型笔刷（accumulate-by-holding-time）

适用：**喷枪 / 喷枪橡皮 / 水彩湿润扩散 / 涂抹工具**。

```
on tick (rAF 或固定间隔):
  while hold_time_since_last_tick > tick_interval:
    在 cursor 当前位置 + scatter 撒一颗 stamp，直接写 layer（不走 buffer）
    hold_time -= tick_interval
```

特征：
- **按 holding 时间叠加**，不是按路径长度
- 停在原地不动 → 时间累计 → 持续叠深
- **不走 buffer**：因为用户**要的就是无限叠深**（喷枪本来就是这个语义）
- 每 tick 直接 per-stamp source-over 到 layer.ctx
- 喷枪橡皮同理，per-stamp dst-out 到 layer

### 为什么不走 buffer

buffer 路径的核心是"折返不叠"，那是涂色笔刷的需求。喷枪反过来：**叠**就是它的物理直觉（颜料持续喷出来）。强行走 buffer 会让喷枪在原地按住几秒后停在 s.opacity 上不动了，违反直觉。

### 未做，遇到再做

需要解决：
- input 端要给 brush 输送 rAF tick（或 brush 内部 setInterval），现在 brush 只在 pointermove 时被驱动
- stop-when-static 阈值（停笔 N 毫秒后不再继续喷）
- scatter（喷点随机偏移）参数
- 喷枪 vs 普通笔刷的 brush-preset 分类

---

## 未来模式：水彩混色

适用：水彩笔刷。

每个 stamp 之前从 layer 当前位置**拉一下底色**，和 brush 当前色按某个比例混，得到新色，再 stamp 出去。需要：
- per-stamp `getImageData` 采样（贵；可能要 worker 或 WebGL）
- 混色比例（湿度参数）
- 决定 stamp 用混色还是 brush 色 + 混色 modifier

延后。

---

## 未来：dual brush / 抖动 / 自定义纹理

预留 hook（写在脑子里）：
- 自定义 stamp 纹理（图片 / 噪声）
- dual brush：两个 stamp 叠加（一个粗一个细）
- 抖动：size / opacity / rotation / scatter 都加随机
- pressure dynamics 曲线：不只是 pow，可以是 LUT

这些都是"preset 系统"问题，等 brush preset UI 接好再说。

---

## Taper-in（笔触起手 fade-in） — v33 default 开

### 问题（user 2026-05-27 v32 测试）

笔尖**碰撞落笔瞬间 pressure 偏重** → 起手鼓"萝卜尖"。Apple Pencil 物理上前几个
sample 直接是接触力度，不像真画师从轻到重渐入。

### 实现（v33）

```js
// BrushSettings
taperIn: 1.5,         // fade-in 长度 = size × taperIn doc-px。0 = 关
taperFloor: 0.4,      // touchdown 时 envelope 取的下限，保证 dot tap 还可见
```

```js
// brush.js _stampOne
if (s.taperIn > 0) {
  const taperLen = s.size * s.taperIn;
  const t = Math.min(1, st.strokeDist / taperLen);
  const env = s.taperFloor + (1 - s.taperFloor) * t;  // 0.4 ramp 到 1.0
  p *= env;     // 乘进 effective pressure，同时影响 size 和 opacity
}
```

`st.strokeDist` 在 extendStroke 每颗 stamp 之前 += step。touchdown 在 strokeDist=0
时 env=0.4，subsequent stamps 线性 ramp 到 1.0。

### Why no taperOut

抬笔时机**不可预知**（pointerup 才知道，但那时之前的 stamps 已经画进 buffer）。
回溯改像素 messy：要 store undo-able stamp 列表 + 抬笔时 rewind + re-stamp 它们带
fade。复杂度不值得。

更重要的是：Pencil 物理 pressure 抬笔时本来就会**掉到 0**（v4 那个 lastP fallback
是为了**防**掉太狠），所以抬笔端**已经自然 fade**。问题主要是 touchdown 端，
那里 sensor 一接触就是接触瞬间力度，物理 fade-in 不存在。所以只补 fade-in。

### Marker preset（未来）

硬尖 / 不要 taper 的 preset：`taperIn: 0`。其他全部 default 1.5 + 0.4 floor。

## TODO 清单（按预期实现顺序）

## TODO 清单（按预期实现顺序）

- [x] accumulate-by-length（paint）— v0 起就有
- [x] accumulate-by-length（erase）— v29 起入 buffer
- [x] buffer max-alpha 等价 — v28
- [x] step 走 current pressure 有效半径 — v30
- [x] streamline（位置 IIR LPF）— v30
- [x] **taper-in（起手 fade-in）** — v33 default 1.5 size 长度 + 0.4 floor。taperOut 不做（抬笔时机不可知 + Pencil 物理已自然 fade）
- [ ] accumulate-by-holding-time（喷枪）— 等用户开口
- [ ] 水彩混色
- [ ] dual brush / 抖动
- [ ] 自定义 stamp 纹理（PNG / 噪声）
- [ ] pressure 曲线 LUT
- [ ] brush preset UI + 序列化（json）

---

## Procreate / 业界对照

- Procreate：accumulate-by-length 是默认；airbrush 是 special preset，确实按时间叠
- Photoshop：accumulate-by-length + 一个 "Flow" 参数（每颗 stamp 自己的小 opacity），airbrush 是单独按钮 toggle
- Krita：同 Procreate，airbrush mode 独立
- 共同点：**两种模式分开是行业惯例**，不要试图统一进一个累积器
