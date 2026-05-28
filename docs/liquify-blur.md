# 液化糊问题 — 为什么 Procreate 不糊，我们糊

> v46 后 user 反馈：液化反复拖几下，画面明显糊掉。Procreate 不糊。先论证再做。

## 1. 糊的来源

每次 `extendStroke` 做的事：

```
src = getImageData(layer)            // 当前像素 = 上一次 putImageData 的结果
for each (x, y) in brush footprint:
    (dx, dy) = mode(x - cx, y - cy, ...)
    sx = (x - dx), sy = (y - dy)     // backward sample 浮点坐标
    dst[x, y] = bilinear(src, sx, sy)
putImageData(dst, layer)
```

**糊点 = bilinear**。每次 backward sample 时：
- 整数源点：bilinear → 单像素值，无损（4 个权重里 3 个为 0，1 个为 1）
- 非整数源点（绝大多数情况）：bilinear 把 4 邻居加权平均 → 一次低通滤波

液化是**反复迭代**的：第 N 次的 `src` = 第 N-1 次的 `dst`。每次都过一道低通 → 总等效频响 = `LP^N`。N=20 次抹一下，原图的高频细节（线稿边、锐角）就被磨成一坨灰。

**关键观察**：糊**不是**因为 displacement 错了，而是因为**重采样链路本身耗散**。即使 displacement = (0, 0)，反复 bilinear 自身也会糊（虽然此时 sx=x sy=y 都是整数，bilinear 退化为 identity；但只要 displacement 不全是整数像素，就跑不掉）。

## 2. Procreate 怎么不糊

我没拆过 Procreate 代码。**合理推测**（按效果反推）几条路径，按可信度排序：

### 路径 A：累积 displacement field，每次都从原图重采样（最可信）

不在 layer 像素上反复迭代，而是**保存一个累积的 displacement field**。每次 event：

```
stroke.dispField += new_event_disp_at_each_pixel
preview = sample(stroke.startSnapshot, x - stroke.dispField[x,y])
```

- `stroke.startSnapshot` = 笔触起手那一刻的 layer 像素（不变）
- `stroke.dispField` = 整个笔触期间累积的总位移场（每像素一个 vec2）
- 每帧从原图重采样**一次**。bilinear 只过一次低通，无论用户拖多久。
- endStroke 时把最终结果烤回 layer。

我们的 v46 实现没有保存 startSnapshot 和 dispField，直接在 layer 上 in-place 迭代 → bilinear 链式叠加 → 糊。

**这是 Procreate 不糊的核心机制。** 几乎可以确信。

### 路径 B：bilinear 改成 bicubic / Lanczos

更高阶的插值滤波器频响更平。但**它们也是低通**，N 次链式仍然糊，只是更慢。不能根本解决。

### 路径 C：用矢量笔触 / mesh warp，最终 rasterize 一次

整个笔触在矢量域累积变形，松手时一次 rasterize。同 A 但走 GPU mesh。可信度低 —— Procreate 液化是连续 push pixels，不像 mesh。

### 结论：A 是出路

## 3. 我们要怎么改

### 3.1 数据结构改造

`LiquifyEngine._stroke` 新增字段：
- `startSnap`: 笔触起手时 `layer.snapshot()` 的副本（含 bbox + ImageData）
- `dispField`: `Float32Array(2 * docW * docH)`（**只覆盖 brush 路径触及过的 bbox**，不全 doc 大）
  - 实际上 `Float32Array(2 * fieldW * fieldH)`，`fieldX/Y/W/H` 在 stroke 期间随 brush footprint 动态扩张
  - dx, dy 各一通道

### 3.2 流程改造

**beginStroke**：
- 拍 `startSnap` = layer.snapshot()
- `dispField` 按当前 brush 半径预分配，bbox 跟随后续 event 扩张

**extendStroke(x, y)**：
1. brush footprint bbox = `[cx-R, cy-R, cx+R, cy+R]`
2. 扩张 `dispField` 的 bbox 把 footprint 包进来（线性 alloc & copy）
3. 对 footprint 内每像素：
   - 算这次 event 的 `(ddx, ddy)`（push / pinch / bloat / twirl 公式不变）
   - `dispField[x, y].dx += ddx`，`dy += ddy`  ← **累加**而非替换
4. 重采样整个 dispField bbox：
   - 对每像素，从 `startSnap` 的 `(x - dispField[x,y].dx, y - ...dy)` bilinear 取
   - putImageData 到 layer
5. board.markDocDirty(dispField.bbox)

**endStroke**：清掉 startSnap / dispField。

**cancelStroke**：layer.restoreFromSnapshot(startSnap)。

### 3.3 性能账

每个 event 现在干：
- 累加：bbox 内 N 像素 × 2 写 ≈ N 次 ops
- 重采样：bbox 内 N 像素 × 4 tap bilinear ≈ 4N typed-array reads

R=60, bbox=120×120=14400 像素，56K reads/event。比 v46 的 ~31K 单 footprint 翻倍但仍在 16ms 内。

**warning**：dispField bbox 会随用户拖动持续扩张。从右上拖到左下 → bbox 覆盖整个轨迹长方形。1024×512 路径 → 524K 像素 × 5 ops = 2.5M ops/event。可能需要：
- bbox 不无限扩张，按 viewport 分块（chunked dispField）
- 或：把多个 event 的累积摊到 rAF 节流，每帧只跑一次 resample

但 v47 第一版**不要**做 chunk，先实现 A 看效果。

### 3.4 Undo 影响

`_endLiquify` push 的 history entry schema 不变：`{ before, after }` 仍是整层 snapshot。Undo / redo 行为不变。dispField 只是 stroke 期间的临时状态，不进 history。

### 3.5 不糊验证用例

- 笔尖小幅 push → 反复拉同一处 100 次 → 颜色保真（线条不出现 box blur 模糊）
- pinch / bloat 反复操作 → 不出现"水彩晕开"
- 切回原位（手动反向 push）→ 应该接近还原（位移场 = 0 → 直接从 startSnap 取）
  - 这条尤其能区分实现：v46 永远还原不回去，因为每次 bilinear 都吃掉一点；A 路径下，dispField=0 = 取原图 = 完美还原

## 4. 实现优先级

v48 已做 A 路径（见 src/liquify.js）。

### 与论证的差异
- **option (b)**：每个 event 只重采样 footprint 内（dispField 这次变了的那块），footprint 外的 layer 像素保留上次的结果。这正确因为 dispField 在 footprint 外没动 → 那块的 layer 结果上次已对。比"重采整个 dispField bbox"省 10×–100×。
- **reconstruct 模式**：原本 user 说 "听起来是好东西、先不做"，但 path A 实现起来就一行：`dispField *= (1 - α)`。所以顺手加上当第 5 个 mode。

### 验证（user 在 iPad 上）
- 笔尖小幅 push → 反复拉同一处 100 次 → 颜色应保真（线条不糊）
- pinch / bloat 反复 → 不出现"水彩晕开"
- 推一个图形再切 reconstruct 涂回去 → 应接近原始（dispField → 0）
- 大半径 R=200 + 长笔触 → 内存：dispField 跟 layer bbox 同大小，最坏 2048² × 8B ≈ 32MB，可接受
