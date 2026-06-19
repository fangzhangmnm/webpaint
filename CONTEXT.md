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

**AppContext（组合根装配上下文）**:
[[PaintDoc]]/[[Board]]/[[Input / InputController]]/EditMode/history/rack… 这些核心单例 + 跨模块函数，由组合根（`app.js`）一次构造、即刻冻结成一个显式 `ctx`，传给每个深模块的 `initX(ctx)` 接线。是 app 层布线的**单一类型契约**（`src/app-context.ts` 的 `AppContext` interface）——取代肢解期那套 `let doc:any …; initX(ctx)` 各抄一份的散落约定。改 ctx 形状 → 编译器即点出受影响模块。
_Avoid_: rt（旧全局占位）, DI container / service locator（这只是显式参数对象，不是框架）, god-object

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
**已完成的整合·别再提议搬**：compose/invert/outline/applyMaskPostStroke/fill/clear/crop 等 mask 代数**早已全在 selection.js**（见 `lasso.js:30` 注释）；lasso.js 只**构造** Selection（freehand/rect/ellipse/magic）并 `Selection.compose` 委托，不重复实现代数。lasso.js 大（63KB）是因为浮动 gizmo 的透视/单应矩阵数学（`invertMat3`=3×3 矩阵求逆，≠ 选区反选）+ 选区构造，不是冗余代数。历轮 AI（含 fresh explorer）反复幻觉「lasso 该把 mask 操作收回 selection」——那是 2026-05 就做完的事，勘探到此即可停。

**浮层变换（Float / FloatingTransform）**:
选区像素被「抬起 → 自由变换（移动/缩放/旋转/透视）→ 落回」的瞬态。**深模块 `src/floating-transform.js`（v291 落地 Slice 0-4，node 测 388 过、未真机；从 lasso.js 抽出——lasso 1077→370 行，只产 Selection + 经 facade 驱动 Float）**。
- **复数 source**：active 是单叶 → 1 个 source（= 今日行为）；active 是**组** → 组内**所有叶子和子树（含隐藏）各一个 source**（语义 = 整组一起动；图层无多选，**组是唯一多层语义**）。
- **一个 gizmo / 一个 transform** 驱动全部 source。gizmo 包围盒 = 调**规范合成器**画**组的可见 composite** 再 trim-to-content（隐藏叶**不参与定框**，但**参与变换** = 随组移动、落回各自层）。每个 source = `{layer, canvas, srcRect, preSnap}`，commit **各自写回自己的 layer**（一条**多层 undo entry** `[{layerId,before,after}]`）。
- **渲染接缝**：合成器新增 `floatFor(node)`（与 [[Board]] 注入的 `overlayFor` 平级），把浮层像素插在**源层 z 位**（修「浮层盖在所有层之上」的旧 board overlay 行为）；gizmo 框线/handles **仍是 board overlay**（工具 UI 永在最上）。2×2 homography（`renderQuadPerPixel`/`invertMat3`）**不变**——多 source 时每 source 各自的 dest quad = 同一 H 作用到该 source 的 srcRect 四角；只改「在哪合成、有几份」。
- **变形模式 = 深模块 adapter**（[[TransformMode]]）：free/uniform/distort/(warp) 各自一个 adapter 满足共同 `TransformMode` 接口（handles / 约束 drag / meshN），Float 持当前 adapter。**warp 当前实现是错数学屎山，2026-06-19 删除**；以后用正确数学重加（届时也支持组）。v1 只 free/uniform/distort（均 2×2 单 homography）。
_Avoid_: 单层 float（旧 premise，已被复数 source 取代）, 把浮层画在所有层之上（旧 board overlay 行为）, 旧 4×4 warp / drawMesh / Catmull-Rom 升采样（已删的错数学）

**TransformMode（变形模式）**:
[[浮层变换（Float / FloatingTransform）]] 的变形约束策略，深模块 adapter（Strategy）。接口 = `handles(mesh)`（露哪些把手）+ `applyHandleDrag(mesh, handleId, dx, dy) → newMesh`（约束数学，**纯函数·node 可测**）+ `meshN`。free=平行四边形仿射 TRS、uniform=锁长宽比、distort=自由四边形/透视；warp=逐点（待重加）。Float 只持「当前 adapter + mesh + sources」，约束逻辑下沉各 adapter。
_Avoid_: mode 字符串大 switch（旧 drag handler 的分支地狱）

**requireEditableLeaf（可写叶谓词）**:
「能否在当前 active 节点写像素」的**唯一**判定（`doc` 上）。`requireEditableLeaf({allowHidden}) → leaf | null(+标准状态行)`：active 是组 → 硬拒「请选择一个图层」；active 隐藏叶 → 默认软拒「图层已隐藏」（`allowHidden` 放行）。**所有写/读单叶像素的命令穿它一处**（填充/清除/调整/滤镜/拷贝/魔术棒/吸色 raw/nudge…），取代散在 input.js:402、selection-ops.ts:44、filters 漏查的 ad-hoc `isGroup`/`!visible`。例外 = 变换/Ctrl+D（组合法，深化目的）+ doc 级命令（裁剪/合并）。EditMode CAPS 精神往「目标轴」延伸。
_Avoid_: 各命令各抄一句 isGroup/!visible（面条 + 漂移源）

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
持久化 + 同步的**深模块**（施工中，`src/store/`）。拥有全部 safety machinery：push-vs-pull 顺序、race serialize、412 fail-fast、trash-vs-delete 判定、etag/dirty 状态。对 UI 只暴露 flow 接口，UI 传 `encode/adopt/getEditVersion/onConflict/onNewer/busy` 等回调，红线在库内 enforce 不在 UI。**flow 全集**（均已接消费面）：`push`（B1串行/B2不丢编辑/B5自愈/retry/C4多tab）、`open`（C2 云端 gate：keep/pull/branch，备份先于覆盖）、`rename`（**具名文件**：encode 可选——active 传活 doc 字节，图库非活动从 local.get 取既存字节不重编码；synced→服务端 move 保 etag；dirty→push新+trash旧；本地先存新后删旧；云端 best-effort=cloudDeferred）、`saveAs`（写新身份、旧不动）、`acquire`（cloud-only 首取→本地）、`delete`（三态 move-aside）、`restore`/`purge`（本地+云端一条路）。**身份变更与图库的删/改名/移动/还原/彻底删全部走 flow**（不再在 app 里拼 cloud.*+local* 两腿）。退出 = consent push（C3/H3 先 flush 后清）由 app 的 `saveAndPush`+`_exitCanvasToGallery` 承担（富版本：带冲突 UI/checkpoint/离线提示），**不**走库内 close（曾有、被取代、已删）。`replayDelete`（C7 离线删重连重放）= NOT-WIRED aspirational，待离线删除队列持久化（C1b）才启用。除 flow 外还持 **state-as-store** 小面：`cloud.status`（喂 save 按钮 icon）、`edits`（编辑游标 SSoT：`mark/version`——B2 与本机合流共用同一游标）、`session`（save 合流 coalescer：app 注入 `doLocal/doPush`，Store 串「连按 Ctrl+S 不串 N 次」）、`settings`（通用 KV）。活动 item 指针归 session.js 的 `webpaint.currentSessionName`（含 boot-load 失败的 phantom-path 保护）；曾有的 `store.active` 双源失同步、已删。内部调 CloudProvider（OneDrive/Mock 等 adapter）+ 本地 IDB。WebPaint 是 MyPWAPatterns `sync-store` 抽象的 pilot：先在本仓内部收拢，验稳再整体抽出。提案见 [[docs/sync-store-extraction.md]] 与 MyPWAPatterns `sync-library-spec.md`。**按 storage shape 分层（2026-06 定）**：现在的 store.js 把「底座」和「Work-file 冲突语义」糊在一起，要拆成 **Substrate**（底座：provider 抽象 / GUID-via-thumb / etag·If-Match / `.trash` 机制 / 本地 GUID↔path index / push-serialize / eviction guard，shape 无关）+ shape-specific flow：**WorkFileFlow**（文档=opaque blob，整文件 leave/save-as/weak-override+`.backup`，即今天的 flow）、**FolderFlow**（笔架/滤镜预设/文档预设…**每种一个 blob**；merge **确定性·深模块自持**=entry-grained LWW by uat，**零 app 回调**，item=`{id,name,uat,…opaque}`、库只认 id/uat、其余黑盒搬运；app 只给 cloud 名）、**Registry/Cue**（pointer/进度/settings；与 Folder **同一套 entry-merge 引擎**，区别只在 transport=住 localStorage·boot 同步先载，为 never-block 启动；**唯一**需 app 回调的是 entry **字段级**合并：一条记录里 position=LWW、bookmarkSet=并集——ADR-0004，罕见）。施工序：先并排建 FolderFlow（笔架切过去验稳），底座后抽。ADR 依据：MyPWAPatterns ADR-0011（四 shape）/ ADR-0004（Cue·user-action-time merge）/ ADR-0001（per-Data-class config）。
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
- **落地序**：① 抽 Substrate（**done** v186：共享原语下沉）→ ② store facade 收口（**done** v187-v193，真机验过）：②a `store.edit()` 收编辑游标+parentBase 门、删 `setCloudDirty` footgun；②b `store.busy`（saving/pushing）归 store、`computeSaveState` 只读 store；②c `store.autosave`（configure/start/flush）收 autosave cadence（3min+生命周期）；②d `store.busy.whenPushIdle()` 真信号取代 80ms 轮询。→ ③ `createFolderStore`（**done** v194-v195，node 测过未真机）：rack=第二 Store 实例（`src/store/folder-store.js`），内置 FolderFlow + 防抖 cadence（edit/flush/sync）+ busy + status（含 busy 态机）；删 app 的 `_rackSyncTimer/_scheduleRackSync` + `deriveRackCloudState`（C4 两套 sync-icon 态机合一）；app 经 `rackStore.configure` 注入 snapshot/onResult/canSync/onBusyChange（模型/UI 语义留 app）。→ ④ **C1 的 in-file-GUID 尝试已回滚（v199，真机暴露问题）**：store 须**文件格式无关**（mp3/txt 兄弟）、自铸 id 多设备分叉、id↔path 注册表是灾难。**身份定 = path/name**（接受多设备改名裂卡=数据不丢的 UX 疣）。salvage = store 暴露 `getTailBytes` 原语、thumb 留 app。全文 [[docs/sync-identity-decision-2026-06-07.md]]。剩 ④ 的 **L3 gallery-flow** middleware + **预存待修**（D 同名异内容碰撞推裸报错 / F 改名延迟锁屏 / C 0B 复验）+ 渲染线(pixel brush 等)单独 → ⑤ card view 浅 Vue。
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
