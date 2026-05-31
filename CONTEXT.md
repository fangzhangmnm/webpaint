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
选区，doc 的一等公民。**不可变值对象**（bbox + maskCanvas，alpha=255 内/0 外），拥有 mask 操作：compose（并/减/交）、invert、outline（懒算缓存的行军蚁描边）、applyMaskPostStroke、fill/clearOnLayer、croppedTo/resampledTo。compose/invert/transform 返回新 Selection。`doc.selection` 持 Selection|null，null=无选区=全图可作用。undo 只换引用，不深拷。
_Avoid_: mask (mask 是 Selection 的实现细节), marquee, selection state

**Snapshot**:
某一刻 layer 像素的拷贝 `{ bboxX/Y/W/H, imageData }`，空层 imageData=null。undo 的原子。
_Avoid_: backup, capture

**History entry**:
UndoStack 里一步可撤销操作的最小数据壳，按 `type` dispatch 到注册的 handler。领域无关。
_Avoid_: command, action, undo step

**PixelEdit**:
一次"按-拖-抬"产生的像素编辑事务模块。`begin(layer,type)` 拍 before-snapshot，`commit()` 拍 after、压缩、入栈，`abort()` 还原。自己注册 stroke/liquify/filterBrush 三类 handler。拥有 snapshot 压缩与还原原语。
_Avoid_: undo manager, snapshot manager, stroke recorder

**EditMode**:
独占编辑状态机的 SSoT（`src/edit-mode.js`）。**单轴**：`current()` 是一个 enum（CAPS 的 key），持久工具（brush/eraser/lasso/...）和 transient（transform/crop/adjust）平级。能力表 CAPS（canDraw/allowsColor/cursor/ctrlZ/transient）按 current() 查表 → 谓词。输入 gating、UI 显隐/cursor、ctrl-z 语义全从 current() 派生。叫 EditMode 不叫 Mode 因为 "mode" 在本仓重载（L.mode 混合 / liquify.mode / body.dataset.mode）。提案见 [[docs/tool-mode-state-machine.md]]。
_Avoid_: tool state, app state, mode manager, Mode（裸"mode"歧义）

**Transient**:
EditMode 里"多 step、需 commit/cancel、ctrl-z=取消"的那类 mode（transform / crop / adjust），与持久工具平级（CAPS `transient:true`）。canDraw=false → 期间结构上不可能起 stroke。结束回到进来前的持久工具（_returnTool，内部，brush 兜底）。两个语义旋钮在 CAPS：onToolSwitch（点工具=apply/cancel）、returnTo。区别于单次手势进行中（那是 PixelEdit 的 tx）。
_Avoid_: pending state, temporary mode, overlay, 双轴/second axis
