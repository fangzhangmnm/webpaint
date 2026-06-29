# 笔刷数学模型（v98 起的 Krita-aligned 重写）

> 写这份的动机：v80–v97 之间笔刷的语义反复改了五六次（dual-buffer、
> stroke-buffer/direct-layer、airbrush 标志、sizeMin/flowMin、PS approach-by-flow
> 各试一遍），每次都是"概念糊了"。v98 终于查了 Krita 官方文档和 PS 社区资料把
> 模型对齐到了工业界的命名和算子。这份是给下个 AI / 下个我看的，**不要再发明新模型**。

## TL;DR

```
per stamp at pressure p：
  p' = p ^ pressureGamma
  size_mul = signed_lerp(sizeCoeff, p')
  flow_mul = signed_lerp(flowCoeff, p')
  opa_mul  = signed_lerp(opaCoeff,  p')
  size_eff = preset.size × size_mul
  stamp_α  = state.brush.flow × flow_mul × opa_mul        ← user.opacity 不在 α_dab！

per pixel under stamp footprint：
  dab_α    = stamp_α × shape_α(local)
  buildup: buffer = 1 − ∏(1 − dab_α)   ← Canvas2D 原生 source-over（GPU）
  wash:    buffer = max(buffer, dab_α)  ← Canvas2D 没 alpha-max，JS per-pixel

endStroke composite to layer：
  globalAlpha = user.opacity      ← Π 外那一层乘 opacity
  source-over (or destination-out for erase)
```

**为啥 opacity 必须在 Π 外**：flow 在 Π 内、opacity 在 Π 外是 PS / Krita 的标准。
spacing=100% 无重叠时 Π 退化为单项 → flow 和 opacity 可交换；spacing<100% 有重叠时
flow 被 Π 放大、opacity 不被 → "10%flow×100%opa" 出现 19%（重叠×2），而
"100%flow×10%opa" 永远 10%。这个不对称就是它俩之所以是两个东西的根本原因。

**compositeMode 是 per-brush 标志**，wash / buildup 二选一。

## 关键概念（**别再混淆**）

### opacity vs flow

- **opacity** = 整笔的 alpha **上限**。slider 2 调。
- **flow**    = 单个 dab 的 alpha **强度**。藏在 brush settings 「默认值」+「高级」里调。
- **两者永远相乘**，不是 max / 不是 add。Krita 4.2 起的标准；之前是加算被当 bug 修了。
- 文献佐证：PS 大佬给的判据——"spacing=100% (dab 不重叠) 时，10%flow+100%opacity 和
  100%flow+10%opacity 视觉完全相同"——说明就是相乘。

### Wash vs Build-Up

是**两个不同的合成算子**，不是 opacity / flow 各自的 buffer：

- **Wash** (= Krita Alpha Darken)：`buffer = max(buffer, dab_α)`。自交不变深、单笔
  有 cap（cap = stamp_α_peak）。**Normal brush 默认走这条**。
- **Build-Up** (= Krita source-over)：`buffer = buffer + dab_α × (1 − buffer)`。
  累积，单笔可达 1.0。**喷枪 feel 走这条**。

数学上"Wash 不变深"的根源是 max 算子：dab 都是同一个 α 时 max 一直是那个 α，
不会因为重复涂深下去。Build-Up 用 source-over，每个 dab 都 1−(1−α)^n 地往上爬。

### sizeCoeff / opaCoeff / flowCoeff (−1..1 signed)

```
signed_lerp(coeff, p) = amp + (1 − amp) × p   if coeff ≥ 0
                     = 1   + (amp − 1) × p   if coeff < 0
其中 amp = 1 − |coeff|
```

直觉：
- `coeff = 0`：永远 1（不响应压感）
- `coeff = +1`：满压感，`p=0 → 0`，`p=1 → 1`
- `coeff = -1`：反向，`p=0 → 1`，`p=1 → 0`
- 中间值：amp 是 min 端值，sign 决定哪头是 amp

任何 coeff 下 `signed_lerp ∈ [amp, 1]`，最大永远 1（base 自己），sign 只调换 min/max 的方向。

### preset 不存 opacity / flow

**preset 存的是 character**：sizeCoeff、opaCoeff、flowCoeff、pressureGamma、
compositeMode、defaultOpa、defaultFlow、spacing、hardness、shape、pixelMode、smudge。

**user 当场调**：state.toolStates[t] 里的 `size`、`opacity`、`flow`。选 preset 时，
把 preset.defaultOpa / defaultFlow 拷给 toolState 当初值；user 之后随便改。

这避免了「preset 改一下 opacity 就回写预设」的混乱。preset 是 character，slider 是 expression。

## 默认笔架配置（v98）

| Brush | mode | sizeCoeff | opaCoeff | flowCoeff | defOpa | defFlow | spacing | hardness |
|---|---|---|---|---|---|---|---|---|
| 铅笔 | wash | 0.4 | 0.7 | 0.3 | 0.6 | 1.0 | 6% | 0.5 |
| 勾线 | wash | 0.8 | 0 | 0 | 1.0 | 1.0 | 4% | 1.0 |
| 平涂 | wash | 0.8 | 0 | 0 | 1.0 | 1.0 | 6% | 1.0 |
| 大喷枪 | buildup | 0 | 0 | 1.0 | 1.0 | 0.1 | 5% | 0 |
| 小喷枪 | buildup | 0.4 | 0 | 1.0 | 1.0 | 0.15 | 5% | 0.15 |
| 涂抹 | (smudge path) | 0.2 | — | — | — | — | 6% | 0.6 |
| 硬橡皮 | wash | 0.8 | 1.0 | 0 | 1.0 | 1.0 | 4% | 1.0 |
| 软橡皮 | buildup | 0 | 0 | 1.0 | 1.0 | 0.08 | 5% | 0 |
| 像素笔 | (pixelMode path) | 0 | 0 | 0 | 1.0 | 1.0 | 50% | 1.0 |

**没有 airbrush 标志**——它就是 `compositeMode=buildup + opaCoeff=0 + flowCoeff=1 + defaultFlow≈0.1`。

## Canvas2D 实现注意（双 path）

### 为啥分 path

`α_buf = 1 − ∏(1 − dab_α)` (Build-Up) 正好是 Porter-Duff source-over——Canvas2D 原生、GPU 走。
但 `α_buf = max(dab_α)` (Wash) Canvas2D **没原生**：

- `lighten` 是 RGB max + alpha 还是 source-over（对 alpha 没用）
- `lighter` 是加算
- `destination-over` 只在背景透明时 paint，不是 max
- WebGL fragment shader 可以但 v98 没接

所以 Wash **必须** JS per-pixel。Build-Up 走原生省 GPU。两条 path 共存。

### Build-Up path（原生）

- `bufferCanvas` = RGBA Canvas2D，per stamp `drawImage(coloredStamp, globalAlpha = stamp_α)` source-over
- `coloredStamp` = cached colored radial-gradient canvas (key = color|hardness|mode)
- shape rotation/aspect: `ctx.save / translate / rotate / scale / drawImage / restore`
- endStroke composite: `drawImage(bufferCanvas)` 到 layer with `globalAlpha = user.opacity`
- 内存：4 bytes/px (RGBA Canvas)，overlay 直接复用 bufferCanvas（不额外）

### Wash path（JS per-pixel）

- `bufferData` = Uint8ClampedArray (W×H bytes, α only)
- per stamp 遍历 footprint，shape α 解析公式，`buf[i] = max(buf[i], stamp_α × shape_α × 255)`
- endStroke composite: 转 RGBA tmp canvas (color × α)，`drawImage` 到 layer with `globalAlpha = user.opacity`
- 内存：1 byte/px (buffer) + 4 bytes/px (overlayCanvas lazy build) = 5 总
- shape α 解析:
  ```js
  dist = sqrt(dx² + dy²)             // round
  dist = sqrt((cos×dx+sin×dy)² + ((-sin×dx+cos×dy)/aspect)²)  // ellipse
  shape_α = dist < innerR ? 1 : (radius - dist) / decayLen
  ```

### pixelMode 短路（不进 buffer）

```js
ctx.fillStyle = color
ctx.imageSmoothingEnabled = false
ctx.globalAlpha = stamp_α × user.opacity    // opacity 这里乘（没 buffer 兜底）
ctx.fillRect(整数 snap)
```

### smudge 短路（不进 buffer）

每 dab sample 当前 layer 像素 → blend with `st.loaded` → 输出新 color stamp →
`drawImage(coloredStamp, globalAlpha = stamp_α × user.opacity)` 直接进 layer。
每 dab 颜色不同 → 不 cache，每颗现做。

### 未来 color variation hook（粒子 / scatter / texture brush）

当前两条 buffer path 都假设**整笔 brush.color 固定**。Build-Up 缓存 colored stamp 一次，
Wash buffer 只存 α 合成时填一次。**真正 per-stamp 变色**（粒子效果、color jitter、
按 height 染色之类）走法：

- **Build-Up**：`drawImage(perStampColoredStamp)` 每颗现做或维护 N-bucket cache。
  buffer 是 RGBA Canvas 天然能存多色，Porter-Duff 自动正确混色 ✓
- **Wash**：buffer 得扩成 RGBA Uint8 (4× memory) 才能存色；JS per-pixel 写时需要
  「max α 时连 color 一起更新」语义（即 stamp_α 最大那颗的 color 留下来），
  不是 Porter-Duff blend。

texture brush（preset.shape.kind = "texture"）现在没接进新 path，留到 v99+，
等真要做时按上面 hook 走。


## 系统 anti-spike taper vs 笔刷 stylistic taper

**两件事，分开**：

- **系统 anti-spike**：BrushSettings.taperIn / taperFloor（默认 1.5 / 0.4）。Apple Pencil
  落笔瞬间会 spike 出萝卜尖。引擎首 1-2 颗 stamp 用 floor=0.4 envelope 压低 p。
  **藏起来，user 看不到**。
- **笔刷 stylistic taper**：preset.taper.in / preset.taper.out。勾线 preset 起末 0.3，
  user 可见、可改。

v97 之前一直混在一起，导致用户改 taper 会破坏 anti-spike 行为。

## 历史教训

### v80–v82：dual-buffer 误入
最早试过 buffer + 单独的 cap canvas。Canvas2D 没法 max blend，复杂、坑多。

### v83–v90：stroke-buffer + direct-layer
按 spacingKind = distance / time 切换是否走 buffer。time 模式 setInterval 跨平台
不一致；direct-layer 路径和 smudge 共用。v97 全删，time 模式重 distance 实现。

### v91–v96：airbrush 当 flag
"airbrush" 当 engine flag 决定走 direct-layer。v97 改名 `airbrush: bool`。v98 删，
让 compositeMode + opaCoeff + defaultFlow 涵盖。

### v97：sizeMin / flowMin (PS-like)
线性 min model：`mul = min + (1−min) × p`。功能上能跑，但失去 cap-by-pressure
那一层；只是当时还没意识到 Wash vs Build-Up 是两种合成算子。

### v98：Krita-aligned (这一版）
查了 Krita 文档（开源、规范清晰）+ PS 社区资料，对齐到工业界命名：
- **opacity 在 Π 外，flow 在 Π 内**——这是 PS/Krita 的真正命门。无重叠时俩可换，
  重叠时 flow 被累积非线性放大、opacity 不被
- Wash (max) / Build-Up (source-over) 是 per-brush 合成算子
- 三个 signed coeff + pressureGamma 描述压感动力学
- preset 不存 user 值，存 defaultOpa / defaultFlow 当 hint
- Canvas2D 双 path：Build-Up 原生 source-over (GPU)；Wash JS per-pixel max

**关于 user.opacity 烤进 α_dab 的错误**：v98 初稿曾把 `stamp_α = flow × opacity × ...`
（user.opacity 在 Π 内），数学上 flow 和 opacity 变成可交换的——50%×100% = 100%×50%，
不对。修正后 `stamp_α = flow × opa_mul`（只有 pressure-modulated 的 opa_mul 在 Π 内），
`user.opacity` 在 endStroke composite 那一步乘（Π 外）。这一刀是模型的核心，别再越界。

**不要再发明新模型**。下次想动模型前，先重读这份 + Krita 文档。

## 参考资料

- Krita 手册 "Brush Settings > Painting Modes"：Wash / Build-Up 公式
- Krita 4.2 changelog：flow × opacity 从加算改乘算的 bug fix
- Adobe 论坛专家回复：PS dab spacing 100% 时 10%flow×100%opa = 100%flow×10%opa
- WebPaint v98 commit 体例：sizeCoeff/opaCoeff/flowCoeff/pressureGamma/compositeMode/defaultOpa/defaultFlow
