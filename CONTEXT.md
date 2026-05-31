# WebPaint Context

WebPaint 的领域语言。栅格绘画 PWA：模型(PaintDoc) ⇄ 显示(Board) ⇄ 输入(Input)+引擎。
本文件是 `/improve-codebase-architecture`、`/grill-with-docs` 等技能的领域词表——只收本项目特有的概念，通用编程词不进。

## Language

**PaintDoc**:
绘画的模型。持有 layer 数组、当前选区、背景色；不知道屏幕/工具/笔刷。
_Avoid_: document, canvas (canvas 专指 HTML `<canvas>` 元素)

**Layer**:
一张像素位面 = 一个 OffscreenCanvas + bbox。拥有 `snapshot()/restoreFromSnapshot()`。
_Avoid_: surface, bitmap

**Board**:
显示层。把 doc 合成到可见 `<canvas>`，做视口变换；只**读** doc 渲染，不写像素。
_Avoid_: viewport, view, renderer

**Input / InputController**:
pointer/wheel/键盘 → 行为。屏幕坐标转 doc 坐标，驱动各引擎。
_Avoid_: controller, handler

**Engine**:
把一笔落到 layer 像素上的东西（BrushEngine / LiquifyEngine / FilterBrushEngine / ShapesEngine / LassoEngine）。统一节律 begin/extend/end/cancel。
_Avoid_: tool (tool 是 UI 层的工具选择), brush (brush 专指圆笔引擎)

**Selection**:
选区，doc 的一等公民。`{ bboxX,bboxY,bboxW,bboxH, maskCanvas }`，mask alpha=255 内/0 外。null=无选区=全图可作用。
_Avoid_: mask (mask 是 selection 的实现细节), marquee

**Snapshot**:
某一刻 layer 像素的拷贝 `{ bboxX/Y/W/H, imageData }`，空层 imageData=null。undo 的原子。
_Avoid_: backup, capture

**History entry**:
UndoStack 里一步可撤销操作的最小数据壳，按 `type` dispatch 到注册的 handler。领域无关。
_Avoid_: command, action, undo step

**PixelEdit**:
一次"按-拖-抬"产生的像素编辑事务模块。`begin(layer,type)` 拍 before-snapshot，`commit()` 拍 after、压缩、入栈，`abort()` 还原。自己注册 stroke/liquify/filterBrush 三类 handler。拥有 snapshot 压缩与还原原语。
_Avoid_: undo manager, snapshot manager, stroke recorder
