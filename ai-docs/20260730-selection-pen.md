# 选区笔（sub-tool "pen"）——笔刷手感画选区

> as-of v0.7.26 / 2026-07-31

## v0.7.26 笔架化 +卡死修复（supersedes 本文 knob 节）

- **配置全归笔架**（user：「笔架不是有滤镜笔画画笔橡皮笔吗，加一个选区笔就行了」）：rack 第四工具
  类别 `"selPen"`，`getRackToolKey` 把 lasso/fill 映射过去；`toolStates.selPen` dial（序列化泛型遍历
  白送）；builtin-brushes.json 出厂三支 `default-selpen-hard/ink/pixel`（硬圆/勾线/像素，args 逐字段
  抄硬橡皮/勾线/像素笔；像素带 pixelMode:true=精确落纸标记，描边时压平走 buffered 动力学）。
  v0.7.25 的自有变体下拉/笔径滑条/editorState.selPen 全部退役（那就是 user 点名的造轮子）。
- **入口（v0.7.28 定稿）**：pen 子模式旁挂笔架图标钮 `#selPenRackBtn`（滤镜笔 `#filterBrushOpenRack`
  同款，context-aware 只在 pen 时显示）；切走子工具/工具自动收笔架。曾试过的两个二次点入口
  （lasso/fill 工具钮 v0.7.26、子工具菜单已选再点 v0.7.27）user 判「别扭」已回滚——
  RACK_PANEL_BY_TOOL 的 lasso/fill 映射保留仅为 panel 注册。粗细 = 左栏 dial
  （pen 子工具时 dialReactive.canDraw 放行，写的就是 toolStates.selPen）。
- **补种注意**：内置笔自愈只在笔架**全空**时触发——存量账户要拿到三支出厂选区笔需手点
  「还原内置笔刷」（非破坏 setItem）；没拿到之前 fallback = DEFAULT 兜底笔（可用，硬圆手感）。
- **卡死 RCA（v0.7.25 真机：鼠标一点就死）**：选区笔起笔漏初始化 `rec.smP`（压感 EMA 哨兵）→
  `undefined<0` 为假 → NaN 压感 → `_walkStamps` 的 `while(true)` break 条件遇 NaN 永假 → 死循环。
  修复 = 起笔四件套锚定 + `effectivePressureFor` 硬化（`!(smP>=0)` 即重置，防这一类漏初始化复发）。

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
