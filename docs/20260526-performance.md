# 性能（perf-aware from the start）

> user 反馈 2026-05-25：
> > 一开始性能 aware 就应该 be mindful。

这是个原则：写代码时就要考虑 hot path 的 alloc / cache miss / 多余 redraw，而不是出问题再补。

## 已落的快赢

### 1. Brush stamp cache key 不含 size

**坑**：原本 `_getStamp(size, hardness, color, mode)` 把 `size` 写进 key。`size` = 基础大小 × 当前压感缩放，每颗 stamp 都不一样 → cache miss → 每颗都 `document.createElement("canvas") + radialGradient + fillRect`。Pencil 240Hz 下相当于 200+/秒在分配 canvas + 上传 GPU 贴图。

**改**：cache key = `{color, hardness, mode}`；按 `settings.size`（即 user 滑条的最大值）烤一次，stamp 时用 `drawImage(..., destW, destH)` 缩放到本颗 actual size。base canvas 最小 64px 让小笔尖缩放后还有 AA。

### 2. step（stamp 间距）按当前 actual size 算

Procreate 的 spacing 是**当前直径**的百分比，不是最大直径。一致才不会"压感低 → 笔尖瘦 → 间距没缩 → 散点"。

```
sizeMulNow = pressureToSize ? p^sizeCurve : 1
step = max(0.5, settings.size × sizeMulNow × spacing)
```

### 3. extendStroke 的 segPos 公式修正

原本 `t = (nextAt - traveled) / dist` 与 `traveled = -accumDist` 联用，等价于 `(step + accumDist) / dist` —— 符号反了。结果跨段时 stamp 位置不均、偶尔漏一颗，肉眼就是"小圆点断断续续"。

正确：`segPos = step - accumDist`（首颗），之后每隔 `step` 一颗。详见 [20260526-brush-v0.md](20260526-brush-v0.md)。

### 4. layer ctx 的 `imageSmoothingQuality = "low"`

Stamp 是缩放 drawImage，bilinear 完全够；某些浏览器 `"high"` 会走更贵的滤波（lanczos / bicubic）。每颗 stamp 都付一次代价没意义。在 `Layer` ctor 里设一次。

最终合成（`board.render()`）的 `imageSmoothingQuality` 走"远小于 1 时 low，否则 high"，因为它一帧只一次，可以贵一点。

### 5. rAF 合并 render

`board.requestRender()` flag-based + rAF coalesce → 一帧最多 render 一次，不管 stamp 喊了多少次。已经做了。

### 6. Dirty-rect 合成（2026-05-25 落）

`Board` 加了 `markDocDirty(x0,y0,x1,y1)` 和 `markFullDirty()`。`BrushEngine` 在每颗 stamp 后累积 doc-px bbox，`InputController` 一帧 `extendStroke` 完调 `brush.flushDirty()` 把 bbox 交给 board。render 时：

- `_dirtyFull` 或没有 dirty rect → 走旧的全屏 render（视口 / 主题 / 光标变化时）
- 否则走 `_renderPartial(docRect)`：在 dirty 屏幕矩形上 `ctx.clip()` 后重画底色 + doc 背景 + 逐 layer。GPU 端依然要采 layer texel，但只在 dirty 像素上算 + blit

省的量随**笔触越细 / 视口越大 / 缩放越小**越多。最大 win 在快速大幅细笔触场景（之前每帧都全屏 drawImage 2048²）。

边界注意：
- 笔触期间 cursor preview 不画（input.js 在 _down 里 `board.setCursor(null)`），避免 cursor 触发全屏 dirty
- 笔触结束后下次 hover，cursor 重出 → 整张 dirty 一次，自然回归
- pan / pinch / 缩放 / 主题切 / undo/redo / clear 都打 `_dirtyFull`，下一帧全画一次

### 7. Undo 链化（2026-05-25 落）

原本 `{before, after}` 双份 × 20 = 640MB → 改成"每状态一份" snapshot 链 + pointer = 320MB。详见 [20260526-undo-strategy.md](20260526-undo-strategy.md)。下一档 PNG blob 异步压缩，再下一档 tile-diff（和 dirty-rect 共享 bbox 追踪）。

### 8. Smoothing catch-up tail 过滤（2026-05-25 落）

IIR α=0.65 的 smX 在 raw 停手后还在指数收敛 → 末端塞一串小 delta → 局部 stamp pile-up = "细笔触每隔一段一个比较粗的结"。fix：input.js 跟踪 `lastStampedX/Y`（屏 px），smX 相对它移动 < 0.5 px² 的事件**不发** extendStroke（smX 仍在 tick，迟早超阈值后正常发）。catch-up tail 直接被吞掉。

## 还能挤的（按收益排序）

| 优化 | 收益 | 工程量 | 触发条件 |
| - | - | - | - |
| **Dirty-rect 合成** | 大；render() 只 blit 改动的矩形区域 | 中；要追踪 stroke bbox 和 invalidate region | 单笔触掉帧 |
| **Undo snapshot 用 createImageBitmap / 不阻塞** | 中；缓解笔起手的 hitch | 小-中 | 起笔有明显顿挫 |
| **多 stamp 一次 fillPath / 累计到 Path2D** | 小-中；减少 drawImage 次数 | 中；要重写 brush 的累积逻辑 | 高频率 stamp 仍卡 |
| **OffscreenCanvas + Worker 渲染** | 中；render 不卡主线程 | 大；要把 doc / layer 序列化进 worker | 主线程其他任务（picker drag）也卡 |
| **WebGPU** | 大但杠杆在 dynamics，不在单圆笔 | 很大；新写 brush 后端 | 水彩 / 厚涂 / 液化 / 多图层合成上来再说 |

## WebGPU 立场

user 提议 "也许 webgpu?"。**当前不上 WebGPU**，理由：

1. **单图层圆笔不 GPU-bound**：瓶颈是 alloc / cache miss / 多余 redraw，这些 Canvas2D 修了就消失。WebGPU 帮不了。
2. **真正的杠杆在 brush dynamics**：
   - 水彩混色 = 每颗 stamp 采样底层 + 混色写回。Canvas2D 的 `getImageData` 太慢。WebGPU 的 storage texture / compute shader 是天生为此设计的。
   - 厚涂 normal-map 浮雕、自定义 stamp 纹理批量绘、液化 / smudge 的 displacement —— 全是 shader 活。
   - 多图层合成（10+ layers 各种 blend mode）—— WebGPU instanced 一次过。
3. **架构已经留好**：`BrushEngine` 是单一 API（begin / extend / end），doc / board / input 都不感知后端。哪天换成 `WebGPUBrushEngine` 是 brush.js 内部改造，外部不动。
4. **iPad Safari 17.4+ / Quest 都支持**，但要 vendor / shim 一些 polyfill，包尺寸也会涨。值得做，但应该是"水彩 / 液化阶段一起规划"，不是现在。

**触发开始 WebGPU 的条件**：
- 水彩 preset 在 Canvas2D 上确实不流畅；或
- 多图层（>5）的合成丢帧；或
- 液化在 Canvas2D 上需要 putImageData/getImageData 循环，明显卡。

## 写代码时的 perf 反射弧（checklist）

- **每次 pointermove / 每颗 stamp / 每帧 render** 是 hot path。这些地方：
  - 不 `new` 大对象 / 大数组
  - 不 createElement / createCanvas
  - 不 getImageData（O(n) 拷贝 + 同步阻塞）
  - 不 createRadialGradient / createPattern
  - 不 toDataURL / toBlob
- **缓存 key 别含每次都变的参数**（典型：含 size 的 cache 在压感作用下变废）
- **rAF 合并写操作**，不要每次 mutation 都立即 render
- **DOM 读写分开**（getBoundingClientRect 后再改样式），避免强制 reflow
- **避免在 hot path 上读 CSS 变量**（`getComputedStyle` 阻塞 layout）—— 主题色一次取出来存
