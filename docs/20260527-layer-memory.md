# 图层内存模型：bbox + 按分辨率 cap 层数

2026-05-27 决策。给下个 AI 看：实现多图层时**用 Procreate 模式（封顶层数）**，不要走 LRU 复杂度。bbox 是运行时和保存格式双重必要。

## 频率分层 → 预算分层

不同操作的延迟预算差几个数量级：

| 操作 | 频率 | 预算 |
|---|---|---|
| stylus 位置更新 | 60-240 Hz | 4-16 ms |
| 一笔 endStroke | 1-5 Hz | <100 ms |
| 图层切换 / show-hide / 新建 | "手指头那么快" ~1 Hz | 几百 ms |

PNG decode (createImageBitmap) 2048² 在 iPad 上 50-200 ms。塞进"图层切换 + 加载文件"档没问题，**绝不**塞进 stamp / composite 档。

## 死路：mid-stack PNG composite + LRU

直觉上"让中间叠层是 PNG，需要时才 decode"是不可行的：

- composite 60 Hz × N 层 × drawImage 每帧
- decode 50-200 ms / 层 不可能塞进 16 ms 帧
- 一旦 decode → 必须缓存 → 那就是 LRU
- LRU = 复杂状态机（dirty / pin / encode-on-evict / decode-on-show）+ 一堆 corner case（active 锁 / visible 强住 / dirty 重压缩）

**全砍掉**。换 Procreate 模式：

## 真路径：所有层 resident + cap N + bbox

```
所有 layers 永远 resident（→ stamp/composite 路径 zero decode latency）
+ cap N 层（防 OOM 闪退；按画布分辨率算 N）
+ bbox 压每层实际内存（avg ~25% 满分辨率）
```

### N 公式（按设备 RAM × 画布分辨率，**悲观估计**）

cap 是"最坏每一层都占满 doc 也不爆"的承诺，不靠 bbox 兜底。bbox 省下的内存是"赚的"。

```js
// doc.js 已实现：export function computeMaxLayers(canvasW, canvasH)
const deviceMemoryGB = navigator.deviceMemory ?? 4;      // Chrome/Edge/Firefox 有；Safari iOS 没 → fallback 4 GB
const deviceMemoryMB = deviceMemoryGB * 1024;
const budgetMB = clamp(deviceMemoryMB * 0.15, 64, 192);  // 留 85% 给 OS / 别的 tab / stroke buffer / undo / JS heap
const perLayerMB = (canvasW * canvasH * 4) / 1e6;        // 悲观：每层占满
const maxLayers = clamp(budget / perLayer, 2, 64);
```

`navigator.deviceMemory` 在 **Safari iOS 不可用**（截至 2025），fallback 当 4 GB（保守，撑得起入门 iPad）。Chrome / Edge / Firefox 有，会按真实 RAM 走。

为啥取 15%：iOS Safari 单 tab canvas 池总共 ~384 MB；我们还要装：
- 屏幕 canvas（~4-16 MB）
- stroke buffer（最坏 16 MB）
- erase composite（~16 MB）
- 压缩中的 undo ImageData（瞬态 16 MB）
- JS heap（modules / state，~50 MB）

加起来 ~100 MB 固定开销。给图层留 192 MB 是上限，64 MB 是下限保证至少 2 层。

| 设备 / 画布 | deviceMemory | budget | per-layer 满 | cap |
|---|---|---|---|---|
| iPad mini 6 / 2048² | (Safari→4 fallback) | 64 MB | 16 MB | 4 |
| iPad Pro M1 (16 GB) / 2048² | 8 | 192 MB | 16 MB | 12 |
| 高内存 PC / 2048² | 16 | 192 MB | 16 MB | 12 |
| iPad Pro / 4096² | 8 | 192 MB | 64 MB | 3 |
| A4 300dpi (2480×3508) on iPad | (fallback 4) | 64 MB | 35 MB | 2 |

UI 死上限 N=64。达到时给"图层数已达上限"warning，不让点新建。

**注意 cap 偏紧**：4 层在 anime 工作流是不够的（线稿 + 底色 + 阴影 + 高光 + 参考 ≥ 5 层）。
所以：
1. 初版要鼓励 user 选合理的画布尺寸（2048² 而不是 4096²，A4 300 DPI 已经吃紧）
2. 后期如果 bbox 实测平均占用 << 100%，可以暴露"高级模式"放宽 cap（user 同意承担 OOM 风险）
3. 或者实测内存（performance.memory 在 Chrome 有；Safari 无），动态调整 cap

### bbox 数据结构

```js
{
  bboxX, bboxY,        // doc 坐标，左上角
  bboxW, bboxH,        // 实际 canvas 尺寸
  canvas: Canvas,      // bboxW × bboxH，比 doc 小
  ctx,
}
```

composite：
```js
ctx.drawImage(layer.canvas, 0, 0, bboxW, bboxH,
              tx + bboxX*scale, ty + bboxY*scale, bboxW*scale, bboxH*scale)
```

一次 drawImage 不变，源贴图小 → GPU 带宽反而省。

### grow / shrink 策略

- **grow（eager）**：stamp 落在当前 bbox 外 → realloc 大一圈的 canvas（带 ~1.5× 边距防频繁 realloc），drawImage 旧的过去。stamp 路径 O(1) realloc + 1 次 drawImage，**不**逐像素扫描。
- **shrink（lazy）**：擦完后 bbox 名义大于实际。只在 idle / save / 切走 active 时扫一遍 alpha bounds 后 shrink。stamp 路径绝不扫。

### 空层起手

新建图层 bbox 为空 (W=0/H=0)。**第一颗 stamp 才分配**，按 stamp 位置 + 1.5× 边距开 canvas。空层占 0 内存。

### 背景填充层

如果用户全填充 → bbox = 全 doc，占满层大小。和 naive 没区别但常见 anime layer 都是局部。

## stamp 路径 invariant（不许破）

1. **没有 PNG decode 调用**
2. **bbox grow 是 O(1) 分配 + 1 次 drawImage**
3. **没有 LRU lookup / cache miss**

只要三条不破，stamp 永远 60Hz。

## 保存格式：.ora + bbox PNG

OpenRaster spec 的 `<layer x="..." y="..." src="...">` 直接对应 bbox：

```xml
<image w="2480" h="3508">
  <stack>
    <layer name="背景" src="data/0.png" x="0" y="0" opacity="1" .../>
    <layer name="底色脸" src="data/1.png" x="820" y="640" opacity="1" .../>
    <layer name="眼睛" src="data/2.png" x="1000" y="1200" opacity="1" .../>
    ...
  </stack>
</image>
```

保存就是把每层 (bboxX, bboxY, canvas) 直接序列化进 zip。PNG 是 **比特级无损**（DEFLATE + filter），跨所有 .ora reader（Krita, MyPaint, GIMP, Photoshop 插件）完全兼容。

### A4 .ora 典型大小

A4 @ 300 DPI ≈ 2480×3508，无损 PNG 估算（按内容稀疏度）：

| 层类型 | PNG 大小 |
|---|---|
| 草稿 / 线稿（黑线 + 透明） | 100-300 KB |
| flat color | 200-500 KB |
| Cel 阴影 / 高光 | 150-400 KB |
| 喷枪渐变 | 300-800 KB |
| 厚涂底色（满画布纹理） | 1-3 MB |
| 导入参考照片 | 500 KB - 2 MB |

**典型 anime 立绘 .ora（A4, 10-15 层）≈ 5-12 MB**。
重厚涂 / 多 ref：15-25 MB。
极端：30-50 MB。

iPad PWA 存储 ≥ 几 GB，分享 / 同步速度 OK。

bbox 保存比满分辨率保存能再省 30-60%（多数层只覆盖局部）。

## GPU 压缩纹理（备注）

GPU 直接采压缩纹理（DDS / KTX / ASTC / BC7）确实存在，但**只在 WebGL / WebGPU 路径下**。Canvas 2D 的 drawImage 只吃 Image / Canvas / ImageBitmap，没办法直接吃压缩贴图。

如果将来要把内存压到极限，路径是**整个 paint engine 迁 WebGPU**，layer texture 用 GPU 压缩格式存。phase 1 别想。

## 实现顺序

1. **改 layer 数据结构**：加 bboxX/Y/W/H。phase 1 初始 bbox = 满分辨率，保持现行为。
2. **加 grow 接口**：`layer.ensureBbox(x0,y0,x1,y1)` 给 stamp 调，eager realloc + copy。
3. **stamp 路径改 layer-local 坐标**：stamp 输入 doc 坐标，减去 bboxX/Y 后画进 canvas。
4. **stroke buffer 按 active layer bbox 分配 + grow 联动**。
5. **多图层 + UI**：layers panel，新建 / 删除 / 重排 / 透明度 / 可见 / 重命名。
6. **按 N 公式 cap 新建**：到上限时 grey out + warning。
7. **lazy shrink**：切走 active 时 / save 前扫 alpha bounds shrink。
8. **.ora 导入导出**：用 bbox 直接序列化，零转换。

## 反方与平衡

- **代码复杂度**：bbox 加 ~150-200 行（grow / 坐标平移 / shrink）。LRU 砍掉省 ~100 行。
- **cap 太严**：用户做超多图层时会撞墙。但 Procreate 也是这样，工作流上接受。
- **shrink 时机**：保守只在 active 切走时扫。其他时候多花点内存换简单。
