# Brush engine v0

只够用，故意不复杂。Procreate 那种东西要一层层叠 dynamics，先把"线落下去"这件事跑通。

## 数据 / 渲染分离（继承 ScratchPad 的洞察）

ScratchPad 的 `docs/stroke-rendering.md` 末尾有一段重要修正：**压感开关切的是数据层语义**，不是渲染分支。

WebPaint 是栅格，没有"笔画对象"留着以后重渲，但同一逻辑仍然适用：
- 压感关 → `effectivePressure()` 返 1.0 → 进 BrushEngine 时 `p=1`
- `BrushSettings.pressureToSize / pressureToOpacity` 默认开
- 关压感 = 渲染端永远拿到满压，与"开启压感但有人画得很轻"在数据上等价
- 这样一来开关关掉以后，鼠标和触屏（无压感传感器）走的是同一条逻辑分支

## v0 的 stamp 算法

```
on extendStroke(x2, y2, p2):
  d = dist(last, this)
  step = max(0.5, settings.size × settings.spacing)
  while accumDist + d ≥ next * step:
    沿 last→this 线插值出 (px, py, pp)
    stamp(px, py, pp)
    next++
  accumDist = (accumDist + d) % step
```

- spacing 默认 **0.12**（直径的 12%），Procreate 的默认在 5-10% 之间；偏大一点降低 stamp 数让低端 iPad 不掉帧
- 每个 stamp = 预渲染的圆形 radial-gradient bitmap，**drawImage** 一次
- stamp cache key = `{size, hardness, color, mode}`；任一改 → 重做一次
- erase 用 `globalCompositeOperation = "destination-out"`，stamp 颜色当 alpha 用

## 压感映射

```
sizeMul     = pressureToSize    ? p^sizeCurve    : 1     (默认 sizeCurve = 0.6)
opacityMul  = pressureToOpacity ? p^opacityCurve : 1     (默认 opacityCurve = 0.6)

stampSize   = settings.size    × sizeMul
stampAlpha  = settings.opacity × opacityMul
```

`0.6` 来自 ScratchPad 经验值（`hw[i] = 0.3 + 0.7 × p^0.6`）。WebPaint 没有 0.3 偏置 —— 一期允许笔尖轻到几乎不可见，模拟铅笔起笔很轻的真实感。开发到水彩 / 厚涂 preset 时再加偏置。

`pressureToOpacity` 默认 **关**：粗细变化 + 满 opacity 看起来像油画 / marker；同时改 opacity 才像水彩 / 铅笔 —— 这是 preset 之间的差异，不该默认开。

## 已修的 bug（v0 第一次反馈后）

> **2026-05-25**：user "笔迹小圆点断断续续的；快速大幅度拖动会卡"。
>
> 三处一起修，详见 [performance.md](performance.md)：
> 1. `extendStroke` 的 `t = (nextAt - traveled) / dist` 与 `traveled = -accumDist` 联用 = `(step + accumDist) / dist`，符号反了 → 跨段时 stamp 位置不均、漏一颗 → 视觉断断续续。正确：`segPos = step - accumDist`，之后每 step 一颗。
> 2. step 用 `baseSize × spacing` 而不是 `actualSize（含压感）× spacing` → 压感低时笔尖瘦但间距没缩 → 散点。Procreate 是当前直径百分比，已改为一致。
> 3. `_getStamp` 的 cache key 含 size → 压感每变就 cache miss → 每颗 stamp 都新建 canvas + radialGradient + fillRect = 主线程被拖死。已改为 key=`{color, hardness, mode}`，按 base size 烤一次，stamp 时 drawImage 缩放到 actual。

> **2026-05-25 user**："笔压也能控制 alpha"。
> 默认 `pressureToOpacity = true`。size + alpha 同时受压感控。后期 preset UI 拆开。

## 已知问题（用户应该会反馈的）

1. **狗牙**：圆形 stamp 在大 size 下、缩放放大查看时，stamp 边缘的 alpha 衰减不够 GPU-AA 光滑。可能要：
   - 增大 stamp 内部分辨率（现在 = size+2，过紧）
   - 给 stamp 加一圈 erode（pre-blur 用 filter）
   - 或者别用 stamp，改 Path2D 描边（仅 round 笔可走这条）
2. **超细线的密度感**：当 size = 1-2 时，stamp 直径取整后变成 2-3 像素，stamp spacing 又 ≥0.5px → 看起来像点状。可能要在 size < 4 时切到 Path2D 描边。
3. **stamp 累积过亮**：满 opacity 反复 stamp 会产生饱和带。Photoshop 用 "flow vs opacity" 解决（flow = 每 stamp 透明度；opacity = 整笔上限）。一期没区分，统一 settings.opacity 作为每 stamp 透明度。后期补 flow vs opacity 分离。
4. **没有 angle / tilt 利用**：Pencil 提供 `tiltX/tiltY` 和 `altitudeAngle`，可以做斜笔铅笔效果。未做。
5. **没有 jitter / scatter**：草图笔刷需要少量抖动。未做。
6. **平滑 α=0.65 直接抄 ScratchPad 的**。栅格画线可能想要不同值 —— 等用户反馈。
7. **没有 cache 笔画路径**：每个 pointermove 都直接 stamp 进 layer.ctx；不需要中间存。但这也意味着取消笔画必须靠 undo before-snapshot 把整张图刷回来。已实现，但代价较大。

## 接下来（presets 阶段要做的事）

> **status 2026-05-25**：user 说"brush preset 我之后会和你说。现在只需要一个"。
> 一期当前只暴露这一个默认圆笔。下面的 preset 表先记在脑子里，等 user 具体方向再开工。

按 proposal 的"先托起肌肉记忆"，preset 优先级：

| Preset | 关键 dynamic | 难度 |
| - | - | - |
| anime lineart | 硬边、高 hardness、关 opacity-pressure、size-pressure 浅曲线（基本恒定） | 低（v0 加 hardness=1 prefab 就行） |
| fuzzy sketch | 软边、关 size-pressure、开 opacity-pressure，可能加 jitter | 中 |
| watercolor-ish | 软边、低 opacity-flow、stamp 之间多一道 dirty-color 混合 | 高（要实现 dirty color） |
| 贴图 texture | 中等 hardness、开 size+opacity 双压感、stamp 用噪声纹理 | 中（要加自定义 stamp 纹理） |
| 厚涂 | hard + low flow + 高密度 spacing + 可能加 angle | 中 |

水彩混色和自定义 stamp 纹理是两个独立扩展点，做完它们 4/5 preset 就齐了。
