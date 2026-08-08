# WebPaint Context

WebPaint 的领域语言。栅格绘画 PWA：模型(PaintingWorkpiece) ⇄ 显示(Board/GL) ⇄ 输入(Input)+引擎。
本文件是 `/improve-codebase-architecture`、`/grill-with-docs` 等技能的领域词表——只收本项目特有的概念，通用编程词不进。

## Language

**PaintingWorkpiece（活文档）**:
绘画的模型 = **外部唯一引用**（ADR-0008：持有 doc 数据结构本身即违规）。`Workpiece` 基类（app-agnostic：令牌工厂/undo 栈/双计数/组件注册；见 [[Workpiece / WriteToken（令牌元规则）]]）+ 组件表（全 recorded）：`layerTree`（结构 json）/ `layerTiles`（tile 扁平仓）/ `selection` / `floatLayer` / `pendingFill` / `persp`。silent 槽（参考图/palette）本纪元未组件化——palette 归 desk、参考图走 sidecar 现状；升格=注册表改一个字段。装载/导出 = `load(PaintingData)`（解码器产 plain data 令牌灌入 + 清栈 + markSaved）/ `exportData()`（冻结快照）。`ctx.doc` = PaintingView 端口（读面 + 选区镜像口 + ViewLeaf 读写面），不是逃生门。
_Avoid_: PaintDoc（**测试基座残余**，生产零引用、头注禁新 import，随 freezeDocForEncode 拆）, document, canvas (canvas 专指 HTML `<canvas>` 元素), docRaw / DocView / readDoc（v2 拆除）

**Layer / ViewLeaf**:
一张像素位面。活文档的叶 = **ViewLeaf**（PaintingView 端口，带 `snapshot()/restoreFromSnapshot()` 读写面，引擎/codec 消费）；像素 substrate = per-layer tileset（`src/tiles/tile-layer.ts` 的 LayerPixels，经 [[LayerTiles（tile collector）]] 记账）。
_Avoid_: surface, bitmap, Layer 类（doc.ts 内=测试基座残余）, 「一个 OffscreenCanvas」（tiles 化前的旧实况）

**Board**:
显示层。把 doc 合成到可见 `<canvas>`，做视口变换；只**读** doc 渲染，不写像素。
_Avoid_: viewport, view, renderer

**Input / InputController**:
pointer/wheel/键盘 → 行为。屏幕坐标转 doc 坐标，驱动各引擎。
_Avoid_: controller, handler

**AppContext（组合根装配上下文）**:
[[PaintingWorkpiece（活文档）]]/[[Board]]/[[Input / InputController]]/EditMode/history/rack… 这些核心单例 + 跨模块函数，由组合根（`app.ts`）一次构造、即刻冻结成一个显式 `ctx`，传给每个深模块的 `initX(ctx)` 接线。是 app 层布线的**单一类型契约**（`src/app-context.ts` 的 `AppContext` interface）——取代肢解期那套 `let doc:any …; initX(ctx)` 各抄一份的散落约定。改 ctx 形状 → 编译器即点出受影响模块。
_Avoid_: rt（旧全局占位）, DI container / service locator（这只是显式参数对象，不是框架）, god-object

**Engine**:
把一笔落到 layer 像素上的东西（BrushEngine / LiquifyEngine / FilterBrushEngine / ShapeBrushEngine / LassoEngine）。统一节律 begin/extend/end/cancel。pixel-stroke 家族的成员判定与 begin 期策略 = `engine-registry.ts` 的纯数据表（加引擎 = 加一行）。
_Avoid_: ShapesEngine（旧名——v257 删掉的 ctx.fillRect 直填旧实现；现行 = ADR-0005 形状笔 `src/shape-brush.ts`）

**形状笔（ShapeBrushEngine）**:
一个 shape = 一个 stroke 的笔（对标滤镜笔，**不是**带 gizmo 的可编辑对象；ADR-0005）。按下→拖动（live 预览 = 每 move 按几何整形重合成）→抬手落像素；中断 = cancel 不进 undo。子工具 line/rect/circle/**grid**（尺笔退化版：nu×nv 格默认 2×6=6头身+中线，border 默认关，多线一条 undo）。几何纯函数层 `src/shape-geometry.ts`（直线 15° 画布吸附 / 矩形 frame 相对 AABB / 圆弧鼠绘拟合：闭合 = frame 轴 AABB **max 范数**（切线边界哲学）、弧 = LSQ 椭圆→Kasa 圆回落 + **winding ≥360° 才闭合**）。恒压 0.5、强制无 taper（覆写冻结 ResolvedBrush）；共享 brush 笔架与当前笔（`getRackToolKey` alias；v0.6.25 pin 进 brush-rack-reactive 测试）。live/commit 走既有 stamp overlay 与 `commitBrushStroke`（同一份 StampCollect，多 polyline 引擎内 merge）；pixelMode = 每帧 `restoreFromSnapshot` + 逐像素 exact-once（Bresenham 家族 + 全形状 seen-set 去重）。
_Avoid_: 手势识别自动 snap（判定延迟，被否）, adjusting 态/手柄（从没要过）, defaultPressure 字段（撤案——鼠标主路径本就恒 0.5）, 旧 src/shapes.js 的直填路线

**透视 frame（PerspConfig / [[形状笔（ShapeBrushEngine）]] 全局）**:
形状笔的几何参考系（ADR-0006）：align-to-viewport（默认）或透视平面。配置 per-ora（`desk.persp`）：VP 0-3（vp1/vp2 水平对按 x 排序 + lockHorizon 默认开；vp3 竖直族=三点透视，只有位置）+ 参考点 + 平面（地板/墙/左墙/右墙——按 VP 数动态过滤）。核心机制 = **两角定形→单位方 homography**（`src/perspective-frame.ts`）：透视矩形=四边形、透视椭圆=内切圆的像、grid 间距=cross-ratio；正方/正圆约束走 **planeMetric**（v0.6.10 经典约定重建视点→平面欧氏度量，推翻早期"不可定义"判决）。isometric 模式（v0.6.20）：PerspConfig.axes 三平行族（2:1 惯例固定轴），零奇点走仿射路径、度量解析仿射、编辑面 = box 独任（persp.iso.box）。地平线奇点：**无路径"结构性免疫"**（两角定形的导出角跨线即落奇点，v0.6.18 修"天空第二个矩形"）——quadFromCorners 跨线走 chart 平面坐标、越线角垂直回缩钉 ε 带；徒手拟合走 chart 的 **ε 规则**（pencil 枚举坐标 1/max(w,ε) 饱和、平行枚举坐标真发散 clamp +BIG 不翻负）。像素透视圆 = Zingl 有理二次 Bézier（`src/pixel-conic.ts`，权重解析零可调）。VP 编辑 = crop 同款 transient（`src/persp-edit.ts`，DOM 手柄画布外可拖、参考点射线只在编辑模式显示）。doc 裁剪/旋转/翻转/偏移 → `wp2.persp.remapForDocTransform`（PerspComponent，recorded；T4d——记账面刻意收窄=只有 doc 变换 remap，VP 编辑器仍 desk 直写不进栈，user 拍板「VP setting 不进 undo history」；旧 docTransform persp 信封退役）。
_Avoid_: 尺笔自带透视模式（被全局 frame 吃掉）, 3D grid（弃案：两角点拖不出第三轴，手动画）, grid 最小间距护栏（弃案：不可控）, 把 VP 存 viewport/设备态（它是画的属性，跟 ora 走）
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
**已完成的整合·别再提议搬**：compose/invert/outline/applyMaskPostStroke/fill/clear/crop 等 mask 代数**早已全在 selection.js**（见 `lasso.js:30` 注释）；lasso.js 只**构造** Selection（freehand/rect/ellipse/magic）并 `Selection.compose` 委托，不重复实现代数。lasso.js 大（63KB）是因为浮动 gizmo 的透视/单应矩阵数学（`invertMat3`=3×3 矩阵求逆，≠ 选区反选）+ 选区构造，不是冗余代数。历轮 AI（含 fresh explorer）反复幻觉「lasso 该把 mask 操作收回 selection」——那是 2026-05 就做完的事，勘探到此即可停。
**v2 组件形（T4a）**：`wp2.selection` = **pre-applied 双轨**——`_rawWrite` 预览直写（lasso 引擎/预览窗；显式声明态）+ `set`/`commitPreApplied(before)` 令牌记账（首捕获赢、中间产物即弃）；`beginPreview()` 预览窗（origin 保管/abort 无痕，commit 返 `{changed, before}`——**记账归调用方** withPoint）。`ctx.doc.selection` 是镜像口。SelectionFace / SwapSelectionOp / SelectionPreviewTx 独立类均死。

**浮层变换（Float / FloatingTransform）**:
选区像素被「抬起 → 自由变换（移动/缩放/旋转/透视）→ 落回」的瞬态。**深模块 `src/floating-transform.js`（v291 落地 Slice 0-4，node 测 388 过、未真机；从 lasso.js 抽出——lasso 1077→370 行，只产 Selection + 经 facade 驱动 Float）**。
- **复数 source**：active 是单叶 → 1 个 source（= 今日行为）；active 是**组** → 组内**所有叶子和子树（含隐藏）各一个 source**（语义 = 整组一起动；图层无多选，**组是唯一多层语义**）。
- **一个 gizmo / 一个 transform** 驱动全部 source。gizmo 包围盒 = 调**规范合成器**画**组的可见 composite** 再 trim-to-content（隐藏叶**不参与定框**，但**参与变换** = 随组移动、落回各自层）。每个 source = `{layer, canvas, srcRect, preSnap}`，commit **各自写回自己的 layer**（一条**多层 undo entry** `[{layerId,before,after}]`）。
- **渲染接缝**：合成器新增 `floatFor(node)`（与 [[Board]] 注入的 `overlayFor` 平级），把浮层像素插在**源层 z 位**（修「浮层盖在所有层之上」的旧 board overlay 行为）；gizmo 框线/handles **仍是 board overlay**（工具 UI 永在最上）。2×2 homography（`renderQuadPerPixel`/`invertMat3`）**不变**——多 source 时每 source 各自的 dest quad = 同一 H 作用到该 source 的 srcRect 四角；只改「在哪合成、有几份」。
- **变形模式 = 深模块 adapter**（[[TransformMode]]）：free/uniform/distort/(warp) 各自一个 adapter 满足共同 `TransformMode` 接口（handles / 约束 drag / meshN），Float 持当前 adapter。**warp 当前实现是错数学屎山，2026-06-19 删除**；以后用正确数学重加（届时也支持组）。v1 只 free/uniform/distort（均 2×2 单 homography）。 **v0.6.21 参考 frame 有向化**：gizmoBbox→gizmoFrame(origin/ux/uy)，distort 双手柄——圆=转像素（恒可用）、方=转参考 frame 轴不动像素（mesh 转 dθ + frame 复合 H⁻¹∘R∘H；仅 mesh 仿射时露，拖过透视角 isAffineQuad 判据自动收回，圆转不误收）；这是 warp 重加的 frame 地基。
**v2 组件形（T4b）**：状态机收进 `wp2.floatLayer`（FloatLayerComponent：install/setTransform/drop + dropForLoad；record 双轨 state/meta，同 token meta→drop 升格 state）；lift/stamp/accept/reject 的**编排**留 FloatingTransform 引擎（一个 withPoint 整点：挖洞/烤层像素 = LayerTiles 写时扣押、选区/浮层各自分账）。float 类型族在 `src/workpiece/float-component.ts`。
_Avoid_: 单层 float（旧 premise，已被复数 source 取代）, 把浮层画在所有层之上（旧 board overlay 行为）, 旧 4×4 warp / drawMesh / Catmull-Rom 升采样（已删的错数学）, LiftFloatOp 三元组 / _initialBefore 双记账（v2 已消灭）

**TransformMode（变形模式）**:
[[浮层变换（Float / FloatingTransform）]] 的变形约束策略，深模块 adapter（Strategy）。接口 = `handles(mesh)`（露哪些把手）+ `applyHandleDrag(mesh, handleId, dx, dy) → newMesh`（约束数学，**纯函数·node 可测**）+ `meshN`。free=平行四边形仿射 TRS、uniform=锁长宽比、distort=自由四边形/透视；warp=逐点（待重加）。Float 只持「当前 adapter + mesh + sources」，约束逻辑下沉各 adapter。
_Avoid_: mode 字符串大 switch（旧 drag handler 的分支地狱）

**requireEditableLeaf（可写叶谓词）**:
「能否在当前 active 节点写像素」的**唯一**判定（`doc` 上）。`requireEditableLeaf({allowHidden}) → leaf | null(+标准状态行)`：active 是组 → 硬拒「请选择一个图层」；active 隐藏叶 → 默认软拒「图层已隐藏」（`allowHidden` 放行）。**所有写/读单叶像素的命令穿它一处**（填充/清除/调整/滤镜/拷贝/魔术棒/吸色 raw/nudge…），取代散在 input.js:402、selection-ops.ts:44、filters 漏查的 ad-hoc `isGroup`/`!visible`。例外 = 变换/Ctrl+D（组合法，深化目的）+ doc 级命令（裁剪/合并）。EditMode CAPS 精神往「目标轴」延伸。
_Avoid_: 各命令各抄一句 isGroup/!visible（面条 + 漂移源）

**Workpiece / WriteToken（令牌元规则）**:
文档 mutation 的元规则（ADR-0008 §1-2，supersede ①型/②型 operator 模型）：写前 `wp2.begin()` 拿**令牌**（同时只准一个，第二次 begin=throw=泄漏查获点，FR 兜底报警）；组件 verb **直接写** substrate，被换下的旧数据由该组件自己的 **collector** 静默扣押（异质收集：tiles 收句柄、json 收快照、值对象收引用；非本 token 新建→扣押、本 token 新建→discard）；`commit()` = 各被摸 collector `sealRecord()` 打包 → **一个 UndoStep 入栈**；`cancel()` = 倒序自反 swap 回滚无痕。**record = 纯数据 + component 层 dispatch**（`swapRecord` 自反/对合：undo 倒序、redo 正序再调一次，不存在「undo 生成 redo」；不存函数引用）。computed record（白名单只有 flip/rot90/offsetWrap）零负载 swap=再变换一次，**双捕获断言**防平行路径。无令牌写 = `_componentWrite` throw——「忘记记账」**结构上不存在**。「不记账」必须是显式声明态（`_rawWrite` 预览直写 / `setActive` 焦点 / load 灌入）。共享令牌编排走 `ctx.history.withPoint`。undo 白/黑名单（判据「这个值变了，用户期待 ctrl-z 撤它吗」）变动须问 user——见 ADR-0008 §4 表。
_Avoid_: 手写 forward/backward 逆元（operators ①/②型，v2 已死）, write-gate dev 断言（v2 拆除，结构锁取代）, workbench（被否——语义是 editor app runtime）, 函数注册成字符串（= operator 注册表换门牌复活）

**LayerTree（结构 json 组件）+ LayersFace（ctx.layers）**:
结构 = `wp2.layerTree`：**纯 json 树**（TreeJson 结构共享非深拷、可持久化）+ 每叶 pixelsRef 指向 LayerTiles；verbs = addLayer/duplicate/remove/move/mergeDown（合成字节外部烤好递入）/setLayerProp/setTreeProp(width/height)/addGroup/loadRoot（换整根，load 用）+ `setActive`（显式声明的不入 undo 焦点写）；record = 换根收集。app 侧门面 = `src/layers-face.ts`（LayersFace，**`ctx.layers`**）：每方法一个 `history.withPoint` 整点，组合动作各归各名（ungroup/collapseGroup/moveIntoGroup/moveOutOfGroup/explodeLayer/stampAll），状态栏文案走 statuses→step.hint。
_Avoid_: treeTx（tx 窗口已溶解成令牌+verbs）, workpiece.layers（v1 载体死）, doc.addLayer + 手工 RecordOp（旧姿势）, 在 app 层拼 locateNode/prevActiveId 舞蹈

**Sidecar**:
「跟 ora 走 ∧ 不进 undo history」的 doc 级状态（ADR-0007 命名定案）。成员：参考**图**（side-windows 的 referenceImage blob）、editor-state.json（desk）、未来 timelapse。变更通道 = `wp:sidecarchange`（驱动编辑门/落盘推云，不碰 undo 按钮态）——但 **desk 不发信号**（v409「desk 无 dirty」钉子：只拖面板不落盘，落盘时捎带快照）。**术语拆死**：参考**层**指定（`referenceLayerId`，workpiece 侧，layerTree verb 记账可撤销）≠ 参考**图**（sidecar 侧，不进 undo）——两个 "reference" 是两个东西。v2 注：sidecar = **silent 形容词不开新 workpiece**（ADR-0008 §3）；参考图/palette 本纪元未组件化（palette 已归 desk），`wp:sidecarchange` 通道仍在，组件化那天信号统一从 workpiece 出。
_Avoid_: workbench-state 当 sidecar 统称（workbench 语义被否）, 伪造 wp:histchange 标脏（v0.8.5 已杀的旧姿势）, 给 desk 加 dirty 标记（v409 钉子）

**Snapshot**:
某一刻 leaf 像素的拷贝（ViewLeafSnap，tiles 句柄制）。引擎 live 预览重合成（每帧 `restoreFromSnapshot`）与浮层 lift 的机制；**不再是 undo 的原子**——v2 undo 的原子 = record（collector 扣押的句柄/快照/引用）。
_Avoid_: backup, capture, 「snapshot 入 undo 栈」（v1 心智）

**UndoStack / UndoStep / History（编排器）**:
v2 配额制 undo 栈（`src/workpiece/undo-stack.ts`，零依赖）。UndoStep = `{id, entries:[{c, data}], label?, hint?}`——id 栈分配单调永不复用（= stateVersion 的锚）；undo=entries 倒序 `swapRecord`、redo=正序再调一次（自反）；配额驱逐 `disposeRecord` 释放资源（tile 引用计数 −1）。`hint` = 非权威附注单闭包（三纪律：非权威/lossy 无害/消费在 app；唯一住户 = viewport 还原）。**History**（`src/workpiece/history.ts`，`ctx.history`）= v2 编排器：`withPoint(label, opts, fn)` 共享令牌开/续/封（`checkpoint:false`=留开聚合微步、嵌套骑外层令牌、fn throw→cancel 回滚）+ `sealCheckpoint()` 手势封口 + undo/redo 门（开着的令牌下禁 undo）+ 不可恢复协议（swap 抛→弃栈+回调）。dirty 派生 `stateVersion !== lastSaved || silentDirty`（画→存→画→undo=clean 真值表）；commitVersion 单调（undo 也 +1，渲染缓存失效）——两计数语义不同不许合并。
_Avoid_: UndoHistory / History entry / Microstep / {op,args,data} 逆包（v1 旧栈，v2 物理拆除）, LegacyHistory（T5 已死的迁移桥）, command, action, isDirty 可变布尔（退役——dirty 是派生）

**LayerTiles（tile collector）**:
像素 substrate = `wp2.layerTiles`：per-layer tileset 扁平仓 + **substrate 层写时扣押** collector（`tiles/tile-layer.ts` 的 setTileSwapObserver——engine 直写也被逮到 + 自动登记 touched；Krita memento 语义）。**tileset 引用计数**：json 持有/record 持有各 +1，归零还池（池 FR assert 兜漏）——record 驱逐才释放，「删组→驱逐→无泄漏」有回归锚。读口两档：**TileReadPort**（身份制零拷贝，render/bridge 用）+ `getRegion`（引擎/导出）。整树几何 = `resizeAllLeaves`（exchange record：undo 包=另一侧实例自反互换；map 期间挂起收集的纪律收在 verb 内）。净零变化不占 undo 步。
_Avoid_: PixelTx / pixelHistory（v2 物理拆除）, 手撒 snapshot+ops.pixels 裸调, 调用方碰 _suspendCollect（T5a 起收进 verb）, undo manager, stroke recorder

**PendingFill（fill 预览色）**:
色板 = 编辑器，指向 color target：平时 `brush.color`（**永不 undo**）；fill 预览期自动指 `wp2.pendingFill.color`（color-panel registerColorTarget 切换；进入时从笔刷色同步初值）。预览期 setColor/吸管/色词 = 真 undo step（防抖合并沿 v0.7.8：`setColorLive` 直写中间值 + `commitPreApplied` 防抖 flush 一步）；commit = [tiles+选区清+PendingFill 清] 一步。收益：**undo 永远不再改用户调色盘上的当前色**（pending-fill.test 行为锚）。region 归 Selection（fill=选区的消费视图，ADR-0004 不动）。
_Avoid_: FillColorOp（v2 已死）, _expectFromHistory 回灌抑制（机制死——undo 翻 substrate → onChange 刷显示）, 把笔刷色入 undo

**dials / desk**:
RAM 反应式层 = `useDials()`（Vue 惯例名；原 createEditorState，T5d 换名）；**desk** = per-doc 桌面 struct（原 editorState；持久化文件 `.webpaint/editor-state.json` 名未改）。判据（ADR-0008 §4）：**调好的手感是偏好不是创作**——笔刷色/dial/容差/面板布置不进 undo；v409「desk 无 dirty」钉子仍在。旧轨 `webpaint/state.json` 已停写（v0.8.21）：它独有的 toolDials/palette/blender 三组迁 desk（opaque json 整包收放），读兼容留存量、拔除另议。
_Avoid_: editorState / createEditorState（旧名，T5d 换毕）, 把 dial 写进 undo, 给 desk 加 dirty 标记

**GlRoom / RenderTree / RasterService（GL 双 facade）**:
render 侧三件（T6，ADR-0008 §8）：**GlRoom** = 机房（GLContext/GpuTilePool/CpuGpuTileBridge/GLCompositor 五件套唯一实例 + 共享台面：叶驻留 leaves+sync 族、pseudo 装置 overlay·float·selMask·fillTex、composeSteps 合成机、onInvalidate 失效信号、HUD 观测口）；**RenderTree** = tree composite（renderFrame/段缓存/display 快路径/pin provider）；**RasterService** = 一次性算像素（bakeStamps/rasterizeStampsToBytes/warpToBytes/compositeOnce/pickColor——零帧状态，C 骑士 headless 的显形接缝）。**两 facade 必须共享同一 bridge/pool 实例**（烤定搭 base-tile 便车；拆两套缓存=每笔整层重传）。workpiece/引擎零 GL：GPU 只算不管账，账本永远是 CPU 句柄。
_Avoid_: render-tree-gl（T6 拆除）, facade 各持缓存, GPU 侧记账, `(tree as any)._bridge` 私字段挖法（走 room.bridge 正路）

**EditMode**:
独占编辑状态机的 SSoT（`src/edit-mode.js`）。**单轴**：`current()` 是一个 enum（CAPS 的 key），持久工具（brush/eraser/lasso/...）和 transient（transform/crop/adjust）平级。能力表 CAPS（canDraw/allowsColor/cursor/ctrlZ/transient）按 current() 查表 → 谓词。输入 gating、UI 显隐/cursor、ctrl-z 语义全从 current() 派生。叫 EditMode 不叫 Mode 因为 "mode" 在本仓重载（L.mode 混合 / liquify.mode / body.dataset.mode）。提案见 [[ai-docs/20260531-tool-mode-state-machine.md]]。
_Avoid_: tool state, app state, mode manager, Mode（裸"mode"歧义）

**Transient**:
EditMode 里"多 step、需 commit/cancel、ctrl-z=取消"的那类 mode（transform / crop / adjust），与持久工具平级（CAPS `transient:true`）。canDraw=false → 期间结构上不可能起 stroke。结束回到进来前的持久工具（_returnTool，内部，brush 兜底）。两个语义旋钮在 CAPS：onToolSwitch（点工具=apply/cancel）、returnTo。区别于单次手势进行中（那是一个开着的令牌）。
_Avoid_: pending state, temporary mode, overlay, 双轴/second axis

**Store**:
持久化 + 同步的**深模块**（施工中，`src/store/`）。拥有全部 safety machinery：push-vs-pull 顺序、race serialize、412 fail-fast、trash-vs-delete 判定、etag/dirty 状态。对 UI 只暴露 flow 接口，UI 传 `encode/adopt/getEditVersion/onConflict/onNewer/busy` 等回调，红线在库内 enforce 不在 UI。**flow 全集**（均已接消费面）：`push`（B1串行/B2不丢编辑/B5自愈/retry/C4多tab）、`open`（C2 云端 gate：keep/pull/branch，备份先于覆盖）、`rename`（**具名文件**：encode 可选——active 传活 doc 字节，图库非活动从 local.get 取既存字节不重编码；synced→服务端 move 保 etag；dirty→push新+trash旧；本地先存新后删旧；云端 best-effort=cloudDeferred）、`saveAs`（写新身份、旧不动）、`acquire`（cloud-only 首取→本地）、`delete`（三态 move-aside）、`restore`/`purge`（本地+云端一条路）。**身份变更与图库的删/改名/移动/还原/彻底删全部走 flow**（不再在 app 里拼 cloud.*+local* 两腿）。退出 = consent push（C3/H3 先 flush 后清）由 app 的 `saveAndPush`+`_exitCanvasToGallery` 承担（富版本：带冲突 UI/checkpoint/离线提示），**不**走库内 close（曾有、被取代、已删）。`replayDelete`（C7 离线删重连重放）= NOT-WIRED aspirational，待离线删除队列持久化（C1b）才启用。除 flow 外还持 **state-as-store** 小面：`cloud.status`（喂 save 按钮 icon）、`edits`（编辑游标 SSoT：`mark/version`——B2 与本机合流共用同一游标）、`session`（save 合流 coalescer：app 注入 `doLocal/doPush`，Store 串「连按 Ctrl+S 不串 N 次」）、`settings`（通用 KV）。活动 item 指针归 session.js 的 `webpaint.currentSessionName`（含 boot-load 失败的 phantom-path 保护）；曾有的 `store.active` 双源失同步、已删。内部调 CloudProvider（OneDrive/Mock 等 adapter）+ 本地 IDB。WebPaint 是 MyPWAPatterns `sync-store` 抽象的 pilot：先在本仓内部收拢，验稳再整体抽出。提案见 [[ai-docs/20260604-sync-store-extraction.md]] 与 MyPWAPatterns `20260531-sync-library-spec.md`。**按 storage shape 分层（2026-06 定）**：现在的 store.js 把「底座」和「Work-file 冲突语义」糊在一起，要拆成 **Substrate**（底座：provider 抽象 / GUID-via-thumb / etag·If-Match / `.trash` 机制 / 本地 GUID↔path index / push-serialize / eviction guard，shape 无关）+ shape-specific flow：**WorkFileFlow**（文档=opaque blob，整文件 leave/save-as/weak-override+`.backup`，即今天的 flow）、**FolderFlow**（笔架/滤镜预设/文档预设…**每种一个 blob**；merge **确定性·深模块自持**=entry-grained LWW by uat，**零 app 回调**，item=`{id,name,uat,…opaque}`、库只认 id/uat、其余黑盒搬运；app 只给 cloud 名）、**Registry/Cue**（pointer/进度/settings；与 Folder **同一套 entry-merge 引擎**，区别只在 transport=住 localStorage·boot 同步先载，为 never-block 启动；**唯一**需 app 回调的是 entry **字段级**合并：一条记录里 position=LWW、bookmarkSet=并集——ADR-0004，罕见）。施工序：先并排建 FolderFlow（笔架切过去验稳），底座后抽。ADR 依据：MyPWAPatterns ADR-0011（四 shape）/ ADR-0004（Cue·user-action-time merge）/ ADR-0001（per-Data-class config）。
_Avoid_: cloud / storage / sync manager（那些是它的内部 adapter，不是 Store 本身）, facade（弯路1：透传 re-export 已失败，Store 必须**吸收**编排而非包装）, 「笔架走 Work-file flow」（弯路2：笔架是 Folder 不是 Work-file，shape 不同，见 [[Brushrack]]）, **repo**（弯路3：原型 NOTES 的速记名；已定名=**Store**，公开面叫 `store.*`，别再引入 repo 当第二个名字制造双名漂移）

**L4 facade 定稿（2026-06-07 grill，源自 tmp/gallery-vue-proto/NOTES.md；落地中）**：
把今天 30+ 入口的宽接口（`flow.*`×10 + `edits.*` 散 33 处 + `setCloudDirty` 门漏给 app 调 + `cloud.status` + app 的 `_docSaving/_cloudPushing/_awaitCloudPushIdle` transient）**收成深 facade**。架构=**共享 Substrate + 两个 facade 类型**（`createWorkFileStore` / `createFolderStore`，**笔架=第二 Store 实例**，不是同一类型的开关）。
- **公开面 `store.*`**：读 `status(id)`→{sync, busy, fresh}（**只读派生，app 绝不自算**）· `list/folders/isPinned`；写 `edit()` · `save(id)` · `refresh` · `open/acquire/create/rename/delete/restore/purge/emptyTrash/saveAs/pin`；异常 `onException(fn)`。
- **`edit()` 吸三样**：编辑游标（取代散 33 处的 `edits.mark/markSaved/localDirty`）+ **parentBase 门**（取代 app 调的 `setCloudDirty`——门 footgun 消失）+ **落盘节奏**（取代 app 的 setInterval/visibility/pagehide autosave 触发，连带 `&& !_docSaving` 守卫全消）。app 只在编辑点 `edit()`、生命周期事件 `flush()`。
- **`status` 吸 saving/pushing busy**：删 app 的 `_docSaving/_cloudPushing/_awaitCloudPushIdle`（后者本是 app 重抄 Store 已有的 push-serialize）。app 只读 status，不再自己拼图标态。
- **`onException` = fire-and-forget 通知闭集**（offline/auth/quota）；**keep/pull/branch 决策留 `save/open` 的逐调用回调**（决策属于「那一次操作」，不进全局流）。
- **`save` 多态（仅 work-file）**：float 首推=占 gallery 槽+bound+首 push；bound=push If-Match。**folder.save=确定性 entry-merge，无决策、无 float、结构上不发 conflict**。
- **shape 分叉线**：work-file.save 带决策回调 + float 多态 + newer 冲突；folder.save 无决策（uat-LWW 自动合并）。共同面（edit/status/flush/list/onException 通知）走同一 Substrate。
- **仍 app 注入**（非公开面，`configure`）：`encode/adopt/persistGuard`——doc 是 canvas-bound，Store **不自 encode**；blank/floating/newer 这些 doc 语义守卫留在注入回调里。**Store 拥「何时写」，app 拥「写什么/要不要写」**。
- **副产**：rack 并入后 `store.status` **取代 `deriveRackCloudState`**（画作与笔架两套 sync-icon 态机合一，消报告 C4 的手抄本）。
- **前置红线**：gallery merge `name→GUID`（[[Brushrack]] 的身份同款；memory `gallery_guid_divergence`）在 L3 gallery-flow 修；**promote 共享库前必修**。
- **Substrate 实测边界修正（① 施工发现）**：真正 shape-agnostic、两 facade 都共享的只有 **push-serialize（B1 同名串行）+ 编辑游标（④）+ save 合流 coalescer（④）+ byte utils**——已下沉 `src/store/substrate.js`（`createSubstrate()`，node 测 `test/substrate.test.mjs`，163 passed）。**`_base`/`parentBase`/`_doPush`/`_safePull`/冲突解析是 work-file 的 If-Match 机制**（folder 走确定性 merge、不用 parentBase）→ **留 store.js（=WorkFileFlow）**。早先把「etag·If-Match/parentBase门」整体划进 Substrate 是过度；cloud-level etag/If-Match（cloud-sync.js）确为两 shape 共享，但 store 内的 parentBase 权威不是。
- **落地序**：① 抽 Substrate（**done** v186：共享原语下沉）→ ② store facade 收口（**done** v187-v193，真机验过）：②a `store.edit()` 收编辑游标+parentBase 门、删 `setCloudDirty` footgun；②b `store.busy`（saving/pushing）归 store、`computeSaveState` 只读 store；②c `store.autosave`（configure/start/flush）收 autosave cadence（3min+生命周期）；②d `store.busy.whenPushIdle()` 真信号取代 80ms 轮询。→ ③ `createFolderStore`（**done** v194-v195，node 测过未真机）：rack=第二 Store 实例（`src/store/folder-store.js`），内置 FolderFlow + 防抖 cadence（edit/flush/sync）+ busy + status（含 busy 态机）；删 app 的 `_rackSyncTimer/_scheduleRackSync` + `deriveRackCloudState`（C4 两套 sync-icon 态机合一）；app 经 `rackStore.configure` 注入 snapshot/onResult/canSync/onBusyChange（模型/UI 语义留 app）。→ ④ **C1 的 in-file-GUID 尝试已回滚（v199，真机暴露问题）**：store 须**文件格式无关**（mp3/txt 兄弟）、自铸 id 多设备分叉、id↔path 注册表是灾难。**身份定 = path/name**（接受多设备改名裂卡=数据不丢的 UX 疣）。salvage = store 暴露 `getTailBytes` 原语、thumb 留 app。全文 [[ai-docs/20260607-sync-identity-decision.md]]。剩 ④ 的 **L3 gallery-flow** middleware + **预存待修**（D 同名异内容碰撞推裸报错 / F 改名延迟锁屏 / C 0B 复验）+ 渲染线(pixel brush 等)单独 → ⑤ card view 浅 Vue。
- **② 施工发现（重要，修正 grilling 假设）**：save 路径**早已是 coalescer(`store.session`)-fronted**（`session.configure({doLocal:saveNow, doPush:saveAndPush})`，Ctrl+S/按钮→`session.request("push")`）。`saveAndPush` 余下全是 **UI 编排**（冲突 sheet / checkpoint / 版本-newer 确认 / status / renderGallery）——按 grilling 决策（冲突决策留逐调用、onException 只通知）本就该留 app。所以 grilling 时定的「**`store.save` 多态(float→bound) + `onException` 闭集**」**不是 core-store mechanism**：`store.save` 会是 `session.request("push")` 的薄别名（无实质 depth），float→bound 是新建作品的命名/占槽 UX，onException 需 flow 内部发射——**三者都归 L3 gallery-flow / 新建-doc UX 那轮做**，不在 store 收口内。② 的 mechanism 已收尽（edit/busy/autosave/whenPushIdle + 既有 flow/coalescer/parentBase）。

**parentBase（编辑租约 / edit-lease）**:
「当前未推编辑派生自哪个云版」的权威（`store.js` 的 `_parent` Map）。在 **clean→dirty 门**（`cloudState.setDirty(name,true)` 的 false→true 边沿——app 经 `setCloudDirty` 走门，**不**直连低层 `cloud.setDirty`）捕获一次 = 取当时的 `_base`（本 tab 已见云版，episode 内幂等）；push 拿它当 **If-Match 唯一来源**（绝不回退跨 tab 共享 etag——W2 红线）；push/pull/heal/refresh 采纳云版后清除。**bypass 守卫**：已有云版基准 + dirty + 无 parentBase → push 抛（编辑路径绕过门 = loud failure 而非静默丢更新；ADR-0016 §Why 的结构锁）。reload 后内存丢、`cloud.isDirty` 持久 → `adoptBase` 对 dirty item 补捕。ADR-0016 §4。已实现（node 对抗测试覆盖，**未真机回归**）。
_Avoid_: base-etag（裸词；`_base`=本tab已见版、会蛙跳，parentBase 才是 If-Match 源）, baseFor 跨 tab 回退（**已删**的 W2 隐患）, leapfrog base

**Fast-forward（refresh / 干净快进）**:
`store.flow.refresh(name)` = 事件驱动的「干净 Work 无损快进到云端最新」。app 在 **focus / visibilitychange / online** 且活动 doc 干净时调（复用 SW-poke 钩子，`maybeFastForwardActive`，视口在 FF 前后保留=设备态不跟着跳）。只 `fetchMeta`/etag（etag 真动才拉内容）；dirty → no-op（绝不在事件里弹 sheet）。`open` 同理：clean+云动 → **静默 FF**（无 onNewer sheet、`_safePull` 跳 backup），dirty+云动 → 才弹 keep/pull/branch。串行交接（放下 A 拿起 B → B 聚焦先 FF 再落笔）由此天然变成干净 If-Match push（0 412、0 backup）。**硬约束**：绝不每笔/每编辑触发（ADR-0016 §7）。视图态（viewport=zoom/pan）是设备本地态，**不进任何 .ora 字节**（本地落盘 / 云端同步一律不带，`_buildOraMeta` 单一形状；ADR-0016 §6）→ 所有 .ora 字节统一(本地==云端)。取舍（用户定 2026-06-06）：**重开一律 fitToScreen、不记忆视口**；活动中的事件驱动 FF 例外——内存里前后存还当前视口（`maybeFastForwardActive`，不碰字节），背景快进不跳画面。
_Avoid_: 后台 idle 轮询（那是 active-agent，另一个更大 ADR，**不在此**）, 每笔/每编辑轮询, 把 viewport 烤进 .ora（任何一份——跨设备字节不一致、纯平移算冲突、改名非活动会泄进云端）

**Brushrack（笔架）**:
笔刷预设集合，storage shape = **Folder**（**不是** Work-file / shared-file——那是文档）。物理上单 blob 传输，内部是 GUID-keyed 条目：`{ version, brushes:[{id:GUID, uat, name, folder, ...params}], trash:[{id:GUID, uat}], resetAt }`。同步走 **FolderFlow**（≠ 文档的 WorkFileFlow）：按 GUID **union-merge** → 同 GUID 撞按 `uat` **LWW**（`uat`=last **user-action-time**=显式「保存/更新预设·创建·改名·移 folder·删」的时刻，**绝不用 save/sync/上传时间**，ADR-0004 红线）→ `trash` 在场=真删（**缺席≠删除**）→ `resetAt`=恢复出厂 watermark（max-wins，凡 `uat≤resetAt` 落）。改不同刷=无损自动、**零冲突 UI**（正确的 shape 让冲突消失，旧那套 lossy「拉云端丢本地/覆盖云端丢云端」对话框该删）。**这一级不做 surfaced `.backup`**：安全网=用户手动导入导出；罕见同刷丢可接受（输的最多留成 OneDrive 里看不见的死文件，无恢复 UI）。**不持 activeByTool**（见 [[活动笔刷引用]]）。
_Avoid_: singleton blob（不是单体——单体不能 keep-both/merge）, shared-file / Work-file（那是文档的 shape）, HIGH/MEDIUM 安全级（是 blob-vs-folder 的误框）

**当前笔（ResolvedBrush）**:
BrushEngine 唯一吃的**不可变值**（`src/resolved-brush.js` 的 `resolveBrush()` → `Object.freeze`）。从 SSoT **纯函数派生、整体替换**：① 当前工具 dial（`toolStates` 的 size/opacity/flow，per-doc）② 活动预设的冻结字段（笔架）③ 全局 `color` ④ 全局压感开关（`pressureToSize/Opacity`）。`app.js` 的 `refreshCurrentBrush()` 在 dial 改 / 切工具 / 选预设 / 改色 / 切压感后重派生 `_currentBrush`，`getBrushSettings()` 返回它。**mental model**（user）：没有笔架时 `resolveBrush(preset=null)` 用 `DEFAULT_SETTINGS`（brush.js）兜底出完整可画的笔——console 设一下工具即可绘画；**rack 只是当前笔的生产者之一**。意义：drawing 核心只经两个窄值耦合——色轮→`color`、笔架→ResolvedBrush——「rack⟂engine」由值的不可变性**结构性保证**，不再靠约定。落地 2026-06-08（candidate 3，[[活动笔刷引用]] 的下游；node 测 `test/resolved-brush.test.mjs`，**未真机验**）。
_Avoid_: state.brush（**已废**的可变 working-snapshot 单例——曾被 applyBrushPresetFrozen/applyToolState/syncBrushColor 三处原地改，引擎按引用持有；现收敛成此值）, BrushSettings 单例, working snapshot（裸词，歧义）

**活动笔刷引用（Brush ref）**:
「某画当前每个工具用哪把刷」——**per-doc / per-ORA**，不属于笔架。存在画作 Work-file 的 `webpaintState.toolStates[tool]`（每工具 `{id:GUID, name}`），随画同步。载入时按 **GUID→name 双重 match** 解析到当前笔架（GUID 失败用 name 兜底——跨设备/重导入换了 GUID 仍能认）。不同画常用刷不同，所以它属于画不属于架。
_Avoid_: rack.activeByTool（**旧幻觉**：把「当前刷」当成笔架的全局字段——错且历轮 AI 反复幻觉；现已确认 app.js 真正读的是 per-doc `toolStates.activeBrushId`，rack.activeByTool 只剩 makeDefaultRack/mergeMissingDefaults/死的 conflict-merge 在喂，应废）
