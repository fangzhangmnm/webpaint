# 选区笔（sub-tool "pen"）——笔刷手感画选区

> as-of v0.7.25 / 2026-07-30

## 拍板链（user 2026-07-30）

- 与魔棒/矩形/椭圆**平级的 lasso/fill 子工具**（不是顶级工具）。
- **「不接 ResolvedBrush 才会屎山，尽量避免一个逻辑写两条」**——笔刷管线动力学
  （spacing/压感/taper/引擎平滑）零重写，完整复用。
- 预览 = A 档：描边中**色带**（stamp overlay 固定色 #3b82f6、半透明），蚂蚁线冻结在旧选区，
  **抬笔才**建 Selection + 一次蚂蚁线（实时逐帧重建是 O(整图) 的坑，见勘察：并集 bbox 物化 +
  字符串 key 轮廓链接；真实时留给将来「增量 bbox + 整数 key」两处凿墙）。
- 三变体抄内置笔手感，名字不叫橡皮：硬圆（硬橡皮 args）/ 勾线 / 像素。减选不做独立橡皮——
  布尔组槽 subtract 就是减选。

## 架构（勘察结论的落地）

关键事实：**buffered 笔画全程不碰 layer 像素**（一笔活在 smoother buffer，`collectStamps()`
抬笔吐纯数据 `{stamps,shape,bbox}`）。所以：

- down（input.`_beginLasso` 分叉）：`resolveSelPenBrush(variant,size)`（`sel-pen.ts`，
  BrushPreset 逐字段抄 builtin-brushes.json）→ `brush.beginStroke(锚点叶, …)`。锚点叶只供
  docW/docH + overlay z 位置，永不被写。lasso 状态机零介入（`rec._lassoMode="selpen"`）。
- 预览：现有 stamp overlay 拉取口（`collectActiveStamps` 加 `selPenBand` 旗）→ board 跳过
  selMask/lockAlpha 裁剪；fill 工具里与 fill 预览同帧共存时色带优先（不再 reportError）。
- 抬笔（`_endSelPen`）：
  - 硬圆/勾线 → 新透传 `RenderTreeGL.rasterizeStampsToBytes`（借光栅器打 bbox FBO + readPixels，
    不进树不碰 tile）→ α≥128 二值。
  - 像素变体 / GL 不可用回退 → `stampsToBinaryGray8`（注入引擎 `pixelDiscInto` Bresenham 字节核，
    与像素笔同一 disc 实现）。像素变体 preset **不带 pixelMode**（动力学 buffered 同源，
    落纸才走 disc）——与真像素笔的差异：无逐点即时落纸，预览是软边色带、抬笔才是精确圆盘。
  - → `Selection.fromGray8Region`（恒二值不变量）→ `lasso._applySelectionUpdate`（setOp 合成）
    → `_pushSelEntry` 一笔一条 selectionChange。undo 事务（PixelTx）根本不建。
- cancel：`_abortLasso` 头部 `_abortSelPen()`（双指手势/pointercancel 无痕，同 cancelDrawing 语义）。

## 深模块碰撞面

tiles：零。render-tree：新增 `rasterizeStampsToBytes`（~15 行只读透传）+ overlay 输入两个旗，
不改任何现有路径。undo：零（树外目标本来就静默不入栈，这里直接不开事务）。

## knob / 持久化

`editorState.selPen = { variant, sizeHard, sizeInk, sizePixel }`（per-doc 跟 ora；不进笔架/云同步）。
UI：Row1 变体组槽（文字下拉，SSoT=`SEL_PEN_VARIANTS`）+ 笔径 ramp-slider（分段档位=brush-size
段表裁到变体上限 300/60/64）。图标暂借 `#pencil`，`select-pen` 已登记 SVG Icons/TODO.md。

## 已知边界

- 需要一个可写叶当预览锚点（组/隐藏层选中时提示后拒绝起笔——与画笔一致；纯选区语义上不必要，
  是预览锚点约束，将来「浮在最顶的 overlay kind」可解）。
- 软边 hardness 对最终选区几乎无效（二值阈值只取 128 等值线）——变体差异有意落在
  spacing/平滑/taper/压感上。
- fill 的「切走工具=commit+清选区」语义不变（选区笔在 fill 内用不触发；批量填色流程在 fill 内闭环）。
