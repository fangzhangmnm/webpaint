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
持久化 + 同步的**深模块**（施工中，`src/store/`）。拥有全部 safety machinery：push-vs-pull 顺序、race serialize、412 fail-fast、trash-vs-delete 判定、etag/dirty 状态。对 UI 只暴露 flow 接口，UI 传 `encode/adopt/getEditVersion/onConflict/onNewer/busy` 等回调，红线在库内 enforce 不在 UI。**flow 全集**（均已接消费面）：`push`（B1串行/B2不丢编辑/B5自愈/retry/C4多tab）、`open`（C2 云端 gate：keep/pull/branch，备份先于覆盖）、`rename`（**具名文件**：encode 可选——active 传活 doc 字节，图库非活动从 local.get 取既存字节不重编码；synced→服务端 move 保 etag；dirty→push新+trash旧；本地先存新后删旧；云端 best-effort=cloudDeferred）、`saveAs`（写新身份、旧不动）、`acquire`（cloud-only 首取→本地）、`delete`（三态 move-aside）、`restore`/`purge`（本地+云端一条路）。**身份变更与图库的删/改名/移动/还原/彻底删全部走 flow**（不再在 app 里拼 cloud.*+local* 两腿）。退出 = consent push（C3/H3 先 flush 后清）由 app 的 `saveAndPush`+`_exitCanvasToGallery` 承担（富版本：带冲突 UI/checkpoint/离线提示），**不**走库内 close（曾有、被取代、已删）。`replayDelete`（C7 离线删重连重放）= NOT-WIRED aspirational，待离线删除队列持久化（C1b）才启用。除 flow 外还持 **state-as-store** 小面：`cloud.status`（喂 save 按钮 icon）、`edits`（编辑游标 SSoT：`mark/version`——B2 与本机合流共用同一游标）、`session`（save 合流 coalescer：app 注入 `doLocal/doPush`，Store 串「连按 Ctrl+S 不串 N 次」）、`settings`（通用 KV）。活动 item 指针归 session.js 的 `webpaint.currentSessionName`（含 boot-load 失败的 phantom-path 保护）；曾有的 `store.active` 双源失同步、已删。内部调 CloudProvider（OneDrive/Mock 等 adapter）+ 本地 IDB。WebPaint 是 MyPWAPatterns `sync-store` 抽象的 pilot：先在本仓内部收拢，验稳再整体抽出。提案见 [[docs/sync-store-extraction.md]] 与 MyPWAPatterns `sync-library-spec.md`。**按 storage shape 分层（2026-06 定）**：现在的 store.js 把「底座」和「Work-file 冲突语义」糊在一起，要拆成 **Substrate**（底座：provider 抽象 / GUID-via-thumb / etag·If-Match / `.trash` 机制 / 本地 GUID↔path index / push-serialize / eviction guard，shape 无关）+ shape-specific flow：**WorkFileFlow**（文档=opaque blob，整文件 leave/save-as/weak-override+`.backup`，即今天的 flow）、**FolderFlow**（笔架/滤镜预设/文档预设…**每种一个 blob**；merge **确定性·深模块自持**=entry-grained LWW by uat，**零 app 回调**，item=`{id,name,uat,…opaque}`、库只认 id/uat、其余黑盒搬运；app 只给 cloud 名）、**Registry/Cue**（pointer/进度/settings；与 Folder **同一套 entry-merge 引擎**，区别只在 transport=住 localStorage·boot 同步先载，为 never-block 启动；**唯一**需 app 回调的是 entry **字段级**合并：一条记录里 position=LWW、bookmarkSet=并集——ADR-0004，罕见）。施工序：先并排建 FolderFlow（笔架切过去验稳），底座后抽。ADR 依据：MyPWAPatterns ADR-0011（四 shape）/ ADR-0004（Cue·user-action-time merge）/ ADR-0001（per-Data-class config）。
_Avoid_: cloud / storage / sync manager（那些是它的内部 adapter，不是 Store 本身）, facade（弯路1：透传 re-export 已失败，Store 必须**吸收**编排而非包装）, 「笔架走 Work-file flow」（弯路2：笔架是 Folder 不是 Work-file，shape 不同，见 [[Brushrack]]）

**parentBase（编辑租约 / edit-lease）**:
「当前未推编辑派生自哪个云版」的权威（`store.js` 的 `_parent` Map）。在 **clean→dirty 门**（`cloudState.setDirty(name,true)` 的 false→true 边沿——app 经 `setCloudDirty` 走门，**不**直连低层 `cloud.setDirty`）捕获一次 = 取当时的 `_base`（本 tab 已见云版，episode 内幂等）；push 拿它当 **If-Match 唯一来源**（绝不回退跨 tab 共享 etag——W2 红线）；push/pull/heal/refresh 采纳云版后清除。**bypass 守卫**：已有云版基准 + dirty + 无 parentBase → push 抛（编辑路径绕过门 = loud failure 而非静默丢更新；ADR-0016 §Why 的结构锁）。reload 后内存丢、`cloud.isDirty` 持久 → `adoptBase` 对 dirty item 补捕。ADR-0016 §4。已实现（node 对抗测试覆盖，**未真机回归**）。
_Avoid_: base-etag（裸词；`_base`=本tab已见版、会蛙跳，parentBase 才是 If-Match 源）, baseFor 跨 tab 回退（**已删**的 W2 隐患）, leapfrog base

**Fast-forward（refresh / 干净快进）**:
`store.flow.refresh(name)` = 事件驱动的「干净 Work 无损快进到云端最新」。app 在 **focus / visibilitychange / online** 且活动 doc 干净时调（复用 SW-poke 钩子，`maybeFastForwardActive`，视口在 FF 前后保留=设备态不跟着跳）。只 `fetchMeta`/etag（etag 真动才拉内容）；dirty → no-op（绝不在事件里弹 sheet）。`open` 同理：clean+云动 → **静默 FF**（无 onNewer sheet、`_safePull` 跳 backup），dirty+云动 → 才弹 keep/pull/branch。串行交接（放下 A 拿起 B → B 聚焦先 FF 再落笔）由此天然变成干净 If-Match push（0 412、0 backup）。**硬约束**：绝不每笔/每编辑触发（ADR-0016 §7）。视图态（viewport）**不进同步字节**、只随本地 IDB 落盘（`_buildOraMeta({withViewport})`；ADR-0016 §6）。
_Avoid_: 后台 idle 轮询（那是 active-agent，另一个更大 ADR，**不在此**）, 每笔/每编辑轮询, 把 viewport 烤进同步 .ora（跨设备字节不一致、纯平移算冲突）

**Brushrack（笔架）**:
笔刷预设集合，storage shape = **Folder**（**不是** Work-file / shared-file——那是文档）。物理上单 blob 传输，内部是 GUID-keyed 条目：`{ version, brushes:[{id:GUID, uat, name, folder, ...params}], trash:[{id:GUID, uat}], resetAt }`。同步走 **FolderFlow**（≠ 文档的 WorkFileFlow）：按 GUID **union-merge** → 同 GUID 撞按 `uat` **LWW**（`uat`=last **user-action-time**=显式「保存/更新预设·创建·改名·移 folder·删」的时刻，**绝不用 save/sync/上传时间**，ADR-0004 红线）→ `trash` 在场=真删（**缺席≠删除**）→ `resetAt`=恢复出厂 watermark（max-wins，凡 `uat≤resetAt` 落）。改不同刷=无损自动、**零冲突 UI**（正确的 shape 让冲突消失，旧那套 lossy「拉云端丢本地/覆盖云端丢云端」对话框该删）。**这一级不做 surfaced `.backup`**：安全网=用户手动导入导出；罕见同刷丢可接受（输的最多留成 OneDrive 里看不见的死文件，无恢复 UI）。**不持 activeByTool**（见 [[活动笔刷引用]]）。
_Avoid_: singleton blob（不是单体——单体不能 keep-both/merge）, shared-file / Work-file（那是文档的 shape）, HIGH/MEDIUM 安全级（是 blob-vs-folder 的误框）

**活动笔刷引用（Brush ref）**:
「某画当前每个工具用哪把刷」——**per-doc / per-ORA**，不属于笔架。存在画作 Work-file 的 `webpaintState.toolStates[tool]`（每工具 `{id:GUID, name}`），随画同步。载入时按 **GUID→name 双重 match** 解析到当前笔架（GUID 失败用 name 兜底——跨设备/重导入换了 GUID 仍能认）。不同画常用刷不同，所以它属于画不属于架。
_Avoid_: rack.activeByTool（**旧幻觉**：把「当前刷」当成笔架的全局字段——错且历轮 AI 反复幻觉；现已确认 app.js 真正读的是 per-doc `toolStates.activeBrushId`，rack.activeByTool 只剩 makeDefaultRack/mergeMissingDefaults/死的 conflict-merge 在喂，应废）
