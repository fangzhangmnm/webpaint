# Canvas 边沿 / partial-render 两个坑 (v124 修)

下次写 canvas pipeline 时翻一下，这俩都是**症状玄学、根因清晰、一招毙命**的坑。

---

## 坑 1：bilinear 在 quad 边缘采样出黑边

### 症状
导入图片 → 进 transform → 拖角缩放或旋转 → **应用（盖印）后图片边缘有黑色细线 + 半透明 fade**。
源图 ROW = w-1 那列在 Paint 里看明明是实色。

### 根因
[src/lasso.js renderQuadPerPixel](../src/lasso.js) 里 inverse homography 把 dst 像素映射回源坐标
`(sx, sy) ∈ [0, srcW] × [0, srcH]`。注意右开闭：sx 可能 = srcW。

老 `bilinearSample`：
```js
const x0 = ix, x1 = ix + 1;
const p00 = (x0 >= 0 && x0 < w && ...) ? ... : -1;
const p10 = (x1 >= 0 && x1 < w && ...) ? ... : -1;
// ...
for (let c = 0; c < 4; c++) {
  let v = 0;
  if (p00 >= 0) v += sdat[p00 + c] * w00;
  if (p10 >= 0) v += sdat[p10 + c] * w10;
  // ...
  ddat[dstIdx + c] = v;  // <-- 这里！
}
```

在 sx ∈ [w-1, w) 时：
- ix = w-1, x0 = w-1 (valid), x1 = w (**INVALID**)
- p10 = -1, skip
- 输出 = sdat[p00] * w00 + ... = `sdat[p00] * (1 - fx)`
- 当 fx → 1（sx 接近 w）：输出 → 0 = **transparent black**

包括 alpha 通道。所以最边缘的目标像素：alpha 从 255 渐淡到 0，RGB 也跟着乘 (1-fx) 变暗。**看上去就是黑色细线 + 边缘 fade**。

### 修
**clamp 到 edge (replicate)**：
```js
const x0 = ix < 0 ? 0 : (ix >= w ? w - 1 : ix);
const x1 = (ix + 1) < 0 ? 0 : ((ix + 1) >= w ? w - 1 : (ix + 1));
// ... 总是 valid index，weights 加到 1.0
```

边缘像素现在 = 两个采样都是 column w-1 → 输出 = 源边缘像素全值 = 正确。

### Takeaway
- "weighted sum 但跳过 invalid neighbor" 是 **数学错误**，因为 weight 不再加到 1.0
- 正确处理：要么 **normalize**（除以 valid weight 之和），要么 **replicate edge**
- bilinear 在源边沿是个**很容易踩**的坑，几乎任何"图像 resample with affine/homography"代码都有
- caller 已 clamp `u, v ∈ [0,1]`，但 `u * srcW = srcW` 仍是合法 source coord (right-open) ≠ 合法 array index (right-closed)
- **liquify.js 有它自己的 bilinearSample**，那个的 skip-invalid 是**对的**（液化采样到 layer bbox 外应该 transparent，不该 replicate）。两个 bilinear 共存因为语义不同——不要"统一"成同一份

---

## 坑 2：Windows partial-render clip 在 stroke 时撒黑框

### 症状
**Windows 上**画画时 stroke 沿线撒一堆**细矩形轮廓**（不是实心块），大小 ≈ stamp / 上次 buffer bbox 尺寸，**抬笔后干净**。Mac / iPad 不复现。

### 第一招（失败）

直觉：partial render 算 `ctx.rect + clip + fillRect` 用浮点 `sx, sy, sw, sh`，Windows Skia GPU 在 DPR>1 时 clip vs fillRect 处理边界**不完全一致** → 1 px sliver 没被任何东西画过 → 主 canvas `{alpha: false}` 初始黑色露 = 看上去就是 dirty rect 的黑色 outline。

修：取整 + 1 px 外扩：
```js
const sx = Math.floor(...) - 1;
const sw = Math.ceil(...) - sx + 1;
```

**没用**。可能 Skia GPU 上游 transform 还有别的 round-off。

### 第二招（成功）—— 兜底全屏

```js
_renderPartial(docRect) {
  // 套索浮层 / 选区已经强走 _renderFull
  // v124：有 live overlay（stroke / liquify 进行中）也强走 _renderFull
  if (this._overlayProvider?.()) {
    this._renderFull(); return;
  }
  // ... 原 partial 逻辑
}
```

stroke 期间一帧多几个 fillRect 在 hidpi 上微秒级，**60fps 安全**。换掉 partial render 的 clip sliver bug 不再可能发生。

### Takeaway
- "我能修这个 sub-pixel rounding bug" 经常是**幻觉**，GPU 路径上有太多浮点转整数的环节，client code 控不住
- 当 **stroke 进行中** 一帧 cost 不变（user 在画，CPU 反正满载），是**最适合"放弃 optimization"** 的时机
- partial render 的设计前提是"小改动只画 dirty rect"——当 stroke 高频 _markDirty 时这个前提已经 broken（dirty 区每帧扩、合并 rect 也会越来越大），全屏反而稳
- "兜底全屏" 不丢任何 invariant —— full render 是 partial 的 superset。永远是 valid fallback

---

## 共通教训

两条都属于"**根因清晰但症状不直观**"。debug 流程：

1. **观察症状到根因的距离**：
   - 黑边 vs bilinear math——表面是渲染，根因是数学
   - Windows 黑框 vs partial clip——表面是 GPU 渲染，根因是 partial render 的设计前提失效
2. **看是不是平台特定**：仅 Windows 出 = GPU 路径相关；全平台都出 = 算法/数据问题。两者修法不同
3. **GPU 浮点 bug 没法在 user code 修**：要么改架构（全屏 fallback）要么换 renderer（WebGL/WebGPU 自己控）
4. **caller / callee 假设要齐**：bilinear 的 caller 假设 `u ∈ [0,1]` 合法，callee 假设 `index < length`——边界处出岔。**重新读 caller 的约束**是 debug 第一步
