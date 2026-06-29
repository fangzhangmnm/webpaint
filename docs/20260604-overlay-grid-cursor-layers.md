# 0002 — 三层渲染：美术 canvas / overlay canvas / 光标 DOM

Status: Accepted · 2026-06-03 · v163

## Context

像素栅格（v163）一上就卡。根因不是栅格本身贵，而是**它画在主 canvas 的 `_renderFull` 里**：

- 画笔行进中**每个 pointermove 强制 full render**（`_renderPartial` 见 overlay provider 就转 `_renderFull`，
  历史上为修 Windows hidpi 黑边 sliver）。
- 于是每帧都把整屏栅格线重新 stroke 一遍。阈值越低 → 可见格子越多 → 每帧几百条 1px AA 线。
- 更隐蔽的：有选区时 `_drawLassoOverlay` 每帧调 `selection.outline()`（marching squares 抽轮廓）——
  **画笔每一帧都在重抽选区边界**。

关键事实：视口不变时，栅格 + 蚂蚁线**逐帧完全一样**。我们在 60fps 重新栅格化一张静态图。

光标、蚂蚁线画在主 canvas 上本来就错位——它们是**瞬态 UI**，不该混进美术内容的逐帧重绘。

## 弯路：overlay canvas（已废）

先试过把栅格 + 套索 overlay 一起搬到独立 **overlay canvas**，靠
`stroking = _overlayProvider?.() || _strokeActiveHint?.()` 在画笔行进时跳过重画。**没用**，两个坑：

1. **检测漏洞**：`_overlayProvider = brush.getLiveOverlay()` 对 **pixel / smudge（immediate 笔）返回 null**；
   `_strokeActiveHint` 只认 filterBrush（液化）。→ 像素笔画画时 `stroking=false` → overlay 每帧照重画。
   而像素画 zoom 下用的正是像素笔 → 栅格依旧每帧重栅格化，一点没改善。
2. **显存**：全屏 overlay canvas（iPad dpr2 ~50MB）。本就内存紧。

## 第二个弯路：CSS gradient（已废）

试过 `#boardGrid` 用 `repeating-linear-gradient` div（period=`scale`px）。**不卡了但渲染不对**：
少线、粗细不一、只有放很大才看得见。根因 = CSS gradient 在**浮点 zoom** 下把 1px 线画在 device-px 网格的
分数位置 → 光栅化丢线 / AA 抹成不同宽度；周期小时 AA 到近乎透明。查网证实：fractional DPR/zoom 下
CSS gradient、`image-rendering:pixelated`、SVG background 都非均匀（web.dev devicePixelContentBox、
多篇 HiDPI canvas 文）。**业界做法**：像素画编辑器/批注工具都用 canvas，按 device px 对齐画线。

## Decision

栅格走**独立 canvas**，但只在视口变时重画（不是每帧）：

1. **美术 canvas**（`#board`）：底色 + 图层 + live stroke + **套索 overlay（蚂蚁线/floating/handles）** + doc 边框。
   蚂蚁线留主 canvas（只有选区时才逐帧——旧行为，没退化）。
2. **像素栅格 = 独立 canvas**（`#boardGrid`，`pointer-events:none`, z-index 1）：`_syncGrid()` 仅在视口签名
   （scale/tx/ty/rot/enabled/docW/H/canvas.width）变时 `_drawGrid()`。stroke 中视口不变 → no-op → 对**所有笔型**
   （含 immediate/pixel，根除检测漏洞）零逐帧成本。画法：rot=0 时按 `round(screen×dpr)` 取整 `fillRect(_,_,1,_)`
   → 1 device px、无 AA、清晰均匀；rot≠0 走 AA stroke（罕见）。只画可见 doc 区间。
   **显存**：backing 按需分配 = 一张主 canvas 大小；隐藏 / 缩到阈值下时 `width=0` 释放 → 只在高 zoom 看栅格时占用。
3. **光标 = DOM div**（`#boardCursor`, z-index 2）：`transform` 移动，GPU 合成。hover 不再 full render。

```
requestRender() { this.onViewportChange?.(); this._syncGrid(); ... }   // sig 守卫，stroke 中 no-op
```

## Consequences

- (+) 栅格清晰均匀（device-px 对齐 fillRect）、对所有笔型零逐帧成本。
- (+) 显存只在高 zoom 看栅格时占一张屏；隐藏即释放（不像第一版常驻 overlay canvas）。
- (+) hover 只改光标 div transform，不再 full render。
- (+) z 序正确：栅格 canvas(1) 在美术之上、光标 div(2) 在其上；蚂蚁线在主 canvas 上画 → 视觉盖在栅格上（合理）。
- (−) pan/zoom 手势每帧重画栅格 canvas（clear + ~数百 fillRect，便宜；非画笔 hot path）。
- (−) rot≠0 栅格走 AA stroke，不强求 device 对齐（像素画一般不转）。
- 教训：浮点 zoom 下要清晰像素栅格，**必须** canvas 按 device px 画线；CSS/SVG/gradient 都做不到均匀。
