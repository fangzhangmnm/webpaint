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

**Stroke smoother**:
笔触位置平滑：把 raw 输入点序列变成平滑的中心线（笔迹脊线），抑制手抖、保住有意的形状。强度由 streamline 参数控制。是 Input→Engine 之间的一级处理。
_Avoid_: streamline (那是它的强度参数 / UI 名), stabilizer, 防抖

**Dwell (顿)**:
落笔中**故意的停顿**——高时间、近零位移，常在转角，语义 =「这个角要保住、别被磨圆」。平滑须能识别并保住它；弧长维度看不见 dwell（几乎不累积弧长），只有**时间维度**能。
_Avoid_: pause / stop（泛词）, hover

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

**Store**:
持久化 + 同步的**深模块**（施工中，`src/store/`）。拥有全部 safety machinery：push-vs-pull 顺序、race serialize、412 fail-fast、trash-vs-delete 判定、etag/dirty 状态。对 UI 只暴露 flow 接口，UI 传 `encode/adopt/getEditVersion/onConflict/onNewer/busy` 等回调，红线在库内 enforce 不在 UI。**flow 全集**：`push`（B1串行/B2不丢编辑/B5自愈/retry/C4多tab）、`open`（C2 云端 gate：keep/pull/branch，备份先于覆盖）、`close`（H3 先flush后清）、`rename`（synced→服务端 move 保 etag；dirty→push新+trash旧；本地先存新后删旧；云端 best-effort=cloudDeferred）、`saveAs`（写新身份、旧不动）、`acquire`（cloud-only 首取→本地）、`delete`（三态 move-aside）、`replayDelete`、`restore`、`purge`。身份变更（取名/本地改名/UI）仍归 app；机制全在库内。内部调 CloudProvider（OneDrive/Mock 等 adapter）+ 本地 IDB。WebPaint 是 MyPWAPatterns `sync-store` 抽象的 pilot：先在本仓内部收拢，验稳再整体抽出。提案见 [[docs/sync-store-extraction.md]] 与 MyPWAPatterns `sync-library-spec.md`。
_Avoid_: cloud / storage / sync manager（那些是它的内部 adapter，不是 Store 本身）, facade（弯路1：透传 re-export 已失败，Store 必须**吸收**编排而非包装）
