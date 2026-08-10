# C4 · 多步操作普查——transaction 协议定形 + EditMode 归属

> as-of v0.8.28 / 2026-08-10。性质：**C4 切片产物**（提案 §5 切片表）；协议节与 EditMode 裁定
> 已回写 `20260808-c-headless-proposal.md` §6.1/§6.2（那边是 pin 住的契约，本文是证据与细账）。
> 读者 = C5–C8 接棒 AI。file:line 打 timestamp 会漂——信代码不信本文。
> 上游：ADR-0008（令牌+collector 元规则）、`20260809-c-backend-grill.md` §五.7
> （user：「做一个普查看一下他们的本质再想办法设计抽象，而不是纸上谈兵」）。
> 勘探方法：四路并行全代码勘探（stroke+形状笔 / transform+persp / 液化+区域滤镜 / 魔棒拖选+fill+选区笔），
> 关键机制（workpiece 令牌墙、SelectionComponent/PreviewTx、EditMode）另行人工复核。

## 0. 普查对象与三类本质

对象 = 提案点名 8 类 + 顺手 2 类（选区笔、fill 换色）。分类轴（提案 C4 行原文）：

- **一次终值**：交互只产一个终值，substrate 在 commit 一刻被令牌写一次；交互期 substrate 零写。
- **参数重算**：源冻结 + 参数可变，预览 = 纯函数(源, 参数)，任意时刻可整体重算；commit = 用当前参数落一次终值。
- **累积真改**：逐事件追加、路径依赖（时间积分/自引用），无法由终值参数重算复现。

## 1. 分类总表

| 操作 | 本质 | 交互期写谁 | 预览宿 | 令牌粒度 | undo entries | EditMode | cancel |
|---|---|---|---|---|---|---|---|
| 笔画 buffered | 累积真改 | 无（smoother 缓冲） | overlay | 1 手势=1 token（贯穿） | layerTiles | 持久 brush/eraser | token.cancel，无痕 |
| 笔画 pixelMode | 累积真改 | **真层就地写** | live-sync（无旗） | 同上 | layerTiles | 同上 | collector 回滚 |
| 形状笔 buffered | **参数重算**（纯几何，t 无关） | 无 | overlay | 1 手势=1 token | layerTiles | 持久 shapeBrush | token.cancel；改参数=abort 重来 |
| 形状笔 pixelMode | 参数重算（实现成就地写） | 真层每帧 restore+重画 | live-sync | 同上 | layerTiles | 同上 | preSnap restore + token.cancel 双保险 |
| 液化/滤镜笔 | 累积真改（笔间累积；笔内保源重算） | **真层就地写** | live-sync | 1 笔=1 token | layerTiles | 持久 filterBrush | 有代码路径无 UI 入口 |
| 区域滤镜 adjust | 参数重算 → 一次终值落层 | 引擎自持 out buffer | **surrogate** | 1 面板会话=1 token 挂起 | layerTiles（commit 才有） | transient adjust，ctrlZ=abort | token.cancel = 无痕 no-op |
| 自由变换 | 参数重算（lift 源冻结）| 引擎自持 _live mesh | **float**（recorded 组件） | 多整点：lift/每拖 1 步/stamp/accept | tiles+sel+float / float meta | transient transform，**ctrlZ=history** | reject=可再撤销的整点，非 undo |
| 魔棒拖选 | 累积真改（union 单向长大+stopMask 读自己预览） | selection `_rawWrite` 每 move | 无旗（预览=doc.selection 本身） | 抬笔 1 token | selection | lasso/fill 下手势 | magicDragCancel 还原 orig |
| fill 预览 | **一次终值** | pendingFill.setColorLive（声明态） | overlay（每帧现算零 buffer） | 换色防抖 350ms 1 步；commit compound 1 步 | pendingFill / tiles+selection | fill 本身是 EditMode，切出=commit | 切文档=丢弃 |
| 选区笔 | 一次终值 | 无 | overlay（selPenBand） | 抬笔 1 token | selection | 寄居 lasso/fill | brush.cancelStroke，无痕 |
| persp 编辑 | desk 累积真改（非 doc 数据） | desk 直写（零令牌） | 无（gizmo+DOM 手柄） | **0 token 0 步** | 无（remap 例外见卡片） | transient perspEdit，ctrlZ=abort | **不存在**（apply≡abort≡关 UI） |

## 2. 事实卡

### 2.1 笔画 brush / eraser

- 生命周期：EditMode gate（input.ts:530-541，`!canDraw()` → touch 降级 hold）→ `_beginStroke`（input.ts:882-907）→ 每事件 `extendStroke`（input.ts:677-719，画笔 coalesced 逐个不丢帧）→ 抬笔 `_endStroke`（input.ts:912-937）/ cancel `_abortStroke`（input.ts:938-945；触发：pointercancel/二指转手势/长按转吸管/platform-guards 自愈/`abortActiveStroke()`）。
- 令牌：**直接 `wp2.begin("stroke")`（input.ts:890），不走 history.withPoint**；一次手势=一个 token=一步；no-op 笔画 collector 空不占步。
- 写面：buffered 描边中**完全不写真层**（点只进 smoother，brush.ts:187-191），抬笔 `board.commitBrushStroke` 一刻落层；pixelMode 每 stamp `editRegionBytes` 就地写真层（brush.ts:459-473）。两者都是令牌内裸写 substrate，记账靠 tile 换手观察者写时扣押、首捕获赢（layer-tiles.ts:348-354）。
- undo step：仅 layerTiles 一条。finalize 选区兜底（CPU 路径 applyMaskPostStroke，input.ts:928-933）仍在同一令牌内。
- 本质：**累积真改**。settings 在 begin 冻结（画一半动笔=下一笔生效，ResolvedBrush 快照）；但 smoother 是带状态的时间积分（pos+vel），压感 LPF 吃**壁钟** `performance.now()`（brush.ts:117,139），位置平滑吃事件 timeStamp——**同一笔两套时钟并存**（C5 已排的顺手账）。出端 taper 是唯一「终值一次算」的部分（endStroke dry-walk 量总长）。
- 预览：buffered=overlay（stamp provider → board GPU overlay，selection/lockAlpha/blend 全在 shader，live 即 commit 所见）；pixelMode=无旗，live-sync 每帧按 tile 身份增量重传（gl-room.ts:143-175）。

### 2.2 形状笔 shapeBrush（含 pixelMode）

- 同一条 pixel-stroke 生命线（engine-registry 表路由），一次拖拽=一个 token=一步（grid N 条线也一步）。
- 本质：**参数重算**——合成结果是纯几何函数：`_inner` 合成描边传 `t=null`、恒压 0.5、smooth 直通（shape-brush.ts:324-326），与事件时序无关；每次 `extendStroke` 全量 `_resynth()`。Shift 反转约束=中途改参数整体重算的实证（shape-brush.ts:92-96）；其余参数改动=工具栏显式 `abortActiveStroke()`（toolbar.ts:782/803/830/840，「画一半切子工具=cancel 不进 undo」）。
- pixelMode 的「参数重算被实现成就地写」：begin 拍 `preSnap = layer.snapshot()`，每帧 `restoreFromSnapshot(preSnap)` 擦回起笔态再重画（shape-brush.ts:335-360）——restore 也走观察者、首捕获赢，undo 包不被中间帧污染。cancel 双保险（preSnap restore + token.cancel）。
- 预览：buffered=overlay（与 brush 同槽）；pixelMode=live-sync（collectStamps 硬返 null，「预览即最终」同一份真层字节）。

### 2.3 液化 liquify / 滤镜笔 filterBrush

- 生命周期：进模式（filters-adjust.ts:268-287，先 `applyPendingTransient()` 烤掉开着的 adjust，不碰 doc 不拿令牌）→ 一笔 = `wp2.begin("stroke")`（input.ts:984；begin 失败显式 `token.cancel()` 防单令牌门死锁）→ 每 move coalesced 只跑最后一个 → 抬笔 `token.commit()`。**cancel 有代码路径（二指转手势/abortActiveStroke）但无 UI 入口**。
- 写面：每 event 算出 dst 后 `layer.putImageData` **就地写真层**（liquify-engine.ts:305；色彩笔 filters.ts:285 同）；live-sync 每帧增量重传。undo 记账合规（一笔的 tile 笔前句柄一步入栈）——违的只是预览语义（ADR-0008:125 记名 defer，非违令）。
- 本质：**笔间纯累积真改**（每笔重拍 startSnap、dispField 新建，第二笔的源=第一笔已落层结果；reconstruct 只能还原当前笔）；**笔内已是保源重算形态**（startSnap 全程只读、每像素从 startSnap 重采样不叠糊，liquify-engine.ts:243-249）——这正是 C6 替身化的现成抓手。
- 引擎：5 variant（push/pinch/bloat/twirl×2）+ reconstruct（UI 未暴露）；采样核 nearest/bilinear/bicubic/spline；选区边界 edge/clip/import。
- EditMode：持久工具 filterBrush（canDraw:true, ctrlZ:history）；开滤镜面板前整个退出 filterBrush（v232 user bug 的钉子，filters-adjust.ts:100-103）。

### 2.4 区域滤镜面板 adjust（curve slider）——**filter 档口的现成原型**

- 生命周期：开面板 = `_initFilterSurrogate`（tiles 直读 bbox 字节 + 选区 mask 物化，源 srcImg 冻结）→ **`wp2.begin("adjust")`** → `board.setActiveLayerSurrogate` → `enterTransient("adjust", {apply/abort})`（filters-adjust.ts:94-153）。滑条每动 = rAF coalesce 一帧最多一次 `Filter.bake(src→out)` **全 bbox 纯函数重算**写引擎自持 out buffer（:157-171）。commit = 撤 surrogate + `replaceFromBytes(out)` + `token.commit()`（:173-184）；cancel = `token.cancel()`（真层零写 → touched 空 → 无痕 no-op，:185-188）。
- 令牌粒度：**一次面板会话一个 token，挂起任意长人类时间**；不跨 await（全同步）。挂起的意义 = **源的互斥租约**：单令牌墙保证冻结的 srcImg 不会因并发写真层而 stale。
- undo：一步，仅 layerTiles；注意 `replaceFromBytes` = `lp.clear()`+整 bbox putRegion → collector 扣押**整层**tile 旧句柄（undo 包比 bbox 大，C6/C7 效率账）。参数本身不进 undo（无 params 组件）。
- 预览：surrogate 旗；帧是全 bbox 重传无 tile 增量（gl-room.ts:177-185）；吸管/合成读替身（WYSIWYG）。
- EditMode：transient adjust（canDraw:false 结构性挡起笔；ctrlZ=abort-transient；点工具=apply；save/进图库=applyPendingTransient 烤进）。

### 2.5 自由变换 free transform（浮层）

- 会话形状 = **多整点，无挂起事务**：`liftFloat`(1 步：挖洞 tiles+清 selection+float install 三组件同 step 分账) → `floatTransform`×N（**每次拖动/切模式/flipH/rotate90 各 1 步**，仅 float meta entry，recordBytes 恒 256）→ `stampFloat`×M（可选，仅 tiles）→ `acceptFloat`/`rejectFloat`(1 步，tiles+float state)。全部走 `history.withPoint` + 组件 verb（`_componentWrite` 门），无 `_rawWrite`。
- 拖手柄期间：**零令牌零 substrate 写**，只动引擎自持 `_live.mesh`（floating-transform.ts:340-361，「拖动中只动 _live，热路径零 operator」）；抬手 `endDrag` 才 `withPoint("floatTransform")` 落终值（mesh 真动过才 push，点一下就松≠空整点）。
- 本质：**参数重算**——源 = lift 冻结的不可变 float tiles；每帧从 lift 源重采样（永不叠加重采样）；「多次拖动的累积」= mesh 四角点的累积位置（每 drag 从 beginDrag 快照绝对重解，homography 四角闭式解），不是矩阵累乘。commit `_bakeDown` 与 live 同采样器（零 preview/commit 漂移），整数刚体走逐字节无损快路。累积真改只有三处：lift 挖洞、stamp、commit/reject 写回——全是原子整点。
- **reject ≠ undo**：identity 写回也是可再撤销的整点。ctrlZ="history"（与 adjust 分叉）：中途 undo 逐整点回退，undo 越过 lift → reconciler（transient-panels.ts:71-101，histchange 微任务对账）静默退 transient；redo 回来重新 enterTransient。
- 预览：float 旗（recorded 组件非预览；真正未记账 transient 只有 `_live`）；board 每帧只更 hinv，源纹理不变。

### 2.6 魔棒拖选 magic wand drag

- 生命周期：down 只进 tentative，move 超 8 screen-px 升级 magic-drag（input.ts:728-746）→ `beginMagicDrag`（lasso.ts:439-445，**不开令牌**）→ 每 move flood 查询结果单向 `union` 进引擎自持 `_magicAccum`，再 `compose(orig, accum, setOp)` **`_rawWrite` 直写 doc.selection 当预览**（lasso.ts:447-469 → painting-view.ts:318）→ 抬笔 `magicDragEnd` 返 {before,after}，一个 `withPoint("selection")` + `commitPreApplied(before)` 记账一步（input.ts:1460-1463）→ cancel 还原 orig 无痕（lasso.ts:483-493）。
- 本质：**累积真改**——accum 不可回退地长大；且 classic+union 的 stopMask 直接读**当前 doc.selection（含本笔预览）**当墙（lasso.ts:408-411）——路径依赖，不可由终值重算复现。容差/蔓延距离是 dial 不是拖动量（改了不重跑选区）。
- 违规形态精确说法：不是裸写（裸写结构上不存在），是**预览态整个住进 selection substrate**（`_rawWrite` 显式声明态被当预览宿用）——ADR-0008 记名违规户的实义。
- 净零变化不占步（final===orig 返 null + sealRecord 同引用返 null 双保险）。

### 2.7 fill 预览 pendingFill——**「一次终值」的模范**

- fill = 一等持久 EditMode（非 transient，切出=commit，语义在 fill-mode.ts modechange 钩子；transient 是括号不是切出：`isTransient()` 时 return，只跟踪上一个持久模式）。
- 预览 = **零 buffer**：board 每帧从 provider 现算 FillOverlayInput（1×1 色+selection bboxMask），走 brush overlay 同槽同构造函数（`_fillInputFrom` 预览/commit 共用，SSoT 含 lockAlpha）。唯一进 workpiece 的是 PendingFill.color。
- 三种令牌粒度：①换色 = `setColorLive` 声明态直写 + **仅 `fillPreviewActive()` 才起 350ms 防抖**一步（`withPoint("fillColor")`，undo/redo 时窗口作废防幽灵合并）；无预览改色=换 seed 零记账（v0.8.24 锚）。②commit = 一个 compound 步（`withPoint("fill")` 内 commitFill+清选区；换色 entry 在开令牌**前**先落栈保 undo 顺序；commit 失败 throw → token.cancel 一体无痕）。③进/出 fill 清选区各自独立 selection 步。
- **与 ADR-0008 §6 的字面出入（分歧记录 §7）**：ADR 写「commit=[tiles+selection 清+PendingFill 清]一步」，现状 commit 步只含 tiles+selection；`pendingFill.clear()` 在切出 fill 的 modechange 时单独调、不记账。

### 2.8 选区笔 selPen——**干净对照组**

- 描边期 substrate 零写（笔画活在 smoother buffer，overlay 色带预览带 selPenBand 旗——唯一被允许与 fill overlay 共存者）；抬笔 GPU/CPU 光栅化 α≥128 二值 → compose → 一个 `withPoint("selection")` 终值写一步。cancel 无痕。**不是违规户**：预览完全在引擎自持物里，substrate 只在终点被令牌写一次。

### 2.9 persp 编辑

- **0 令牌 0 undo 步**：进出=开关 UI；每 pointermove 直写 desk（`desk.persp.*`+box 槽，per-ora editor-state 持久化）；VP snap 像素中线、box C/D 角走阻尼 Gauss-Newton 从当前参数增量求解。PerspComponent.set() 预留口零调用方；唯一进栈的 persp 写是 doc-ops 几何变换的 `remapForDocTransform`（与 VP 编辑正交；其 undo 是整包 wholesale restore——撤销 doc 几何会把该步之后的 VP 编辑一并盖回，结构后果记录在案）。
- **分歧记录（§7）**：ADR-0006 与 persp-edit.ts:11 头注都写「取消/ctrl-z=回快照」，但代码无任何快照/回滚——`enterTransient` 的 apply 和 abort 传的是**同一个 `_finish`**（persp-edit.ts:359），EditMode 的 apply/abort 二分在此塌缩为「关 UI」；ctrlZ=abort-transient 实效=「退出且不回滚」，且编辑期间 undo/redo 被吞。
- 对 desk 而言累积真改；对显示而言参数重算（角点每帧由纯函数从 (VP, box.A, t) 重算）。它根本不是 doc mutation——backend interface 无此操作，归 frontend+desk。

## 3. 结构发现（协议的证据链）

1. **单令牌墙已经是互斥原语**。workpiece「同时只准一个开着的令牌」（workpiece.ts:71-88）+「令牌开着时禁 undo/redo」（workpiece.ts:57-60 beforeApply throw）——这两条合起来就是 grill §五.7 拍板的「同时最多一个 open transaction」，不需要发明新机制，只需要把它接口化。
2. **ctrl-z 语义分叉的结构根源 = 有无挂起令牌**。adjust 挂着 token → 栈被 beforeApply 锁死 → ctrlZ 只能是 abort-transient；transform 手势之间零挂起 → 栈自由 → ctrlZ=history 逐整点回退 + reconciler 对账。这不是两个 UX 偏好，是同一条互斥定律的两个投影。后来者判据：**想要会话中途 undo/redo，就不能挂事务；挂了事务，ctrl-z 必须先收口**。
3. **两层防线实证，各司其职缺一不可**。EditMode canDraw=false 让 adjust 期间的起笔在 UI 层被拒（fail-safe、不响），令牌墙从未在正常流被触发但兜住一切 bug（fail-loud throw）。普查全程未发现绕过两层的写路径——除 §3.6 的观察者静默口。
4. **预览有三种宿，只有一种合规**：①引擎自持物（overlay stamps/_live mesh/out buffer/fill provider/_magicAccum）——合规；②substrate 声明态直写（selection `_rawWrite`、pendingFill.setColorLive）——灰色：机制显式，但魔棒把整个预览住进去，违「预览是引擎自持物」；③真层就地写（液化/pixelMode）——违规户本体，live-sync 是它的显示补丁。
5. **挂起令牌 = 冻结源的租约**。adjust 的 token 挂整个面板期不是为了记账（touched 恒空直到 commit），是为了**互斥保源**：srcImg 冻结后若允许并发写真层，预览与 commit 都会 stale。filter 档口的 begin 必须开 token 的理由即此。
6. **无令牌像素写不 throw、只静默不记账**。写门在观察者侧：`_onTileSwap` 首行 `if (!tokenOpen) return`（layer-tiles.ts:349）——留给 load 灌入的口，但也意味着 CLAUDE.md「结构上不存在裸写路径」对**像素**并不成立（结构/选区/浮层成立）。C7 硬化候选：白名单态（load/suspend）之外的无令牌 tile 换手 → throw。
7. **违规三户的本质并不相同，迁移法也不同**（→ §6 施工单）：液化=累积真改是真需求（笔内已保源）；形状笔 pixelMode=参数重算被实现成就地写（最容易迁）；魔棒=预览住进 substrate（迁的是宿，不是算法）。
8. **stroke 档口一个就够**。brush/eraser/液化/形状笔/选区笔全走同一条 pixel-stroke 生命线（engine-registry 纯数据表路由），差异全在 ResolvedBrush 快照与 engineKey 内部——backend interface 不需要 per-tool 档口。

## 4. transaction 协议（定形——契约文本见提案 §6.1）

三类本质 → 三种指令形态：

- **一次终值 → 普通原子 verb**：内部自带令牌开合，调用返回即入栈一步（或 no-op 不占步）。住户：selection set（魔棒 tap/选区笔/扩缩预览收口）、fill commit、float 五 verb、层树/doc 几何 verbs。
- **累积真改 → stroke 档**（提案 §3 已定：strokeBegin/Append/End/Cancel）：token 贯穿手势，交互期允许令牌内真 substrate 写（记账靠 collector），End 一步入栈、Cancel 回滚无痕。
- **参数重算 → filter 档（preview session）**：begin 冻结源+挂 token（=互斥租约），setParams 纯函数重 bake 替身（不记账不占步），commit 终值一次落层一步，cancel 无痕 no-op。原型 = filters-adjust surrogate 模式逐字升格。

互斥拒绝语义：同时最多一个 open transaction；第二个 begin、开着期间的 undo/redo、冲突 verb → **响亮拒绝（throw）**，不排队、不静默丢弃、不自动收口。dispose 时开着 → cancel 后释放（interrupt=cancel 家规）。

transform 裁定**无档口**：变换会话 = frontend UX 括号（EditMode transient + histchange reconciler），backend 只见原子 verb 序列，每 verb 一步、会话中途 undo/redo 自由。

档口选择判据（后来者用）：交互期需要真 substrate 写或事件流不可重算 → stroke 档；预览可由 (冻结源 × 参数) 纯函数重算 → filter 档；两者都不是 → 拆原子 verbs + frontend 括号。

## 5. EditMode 归属裁定（契约文本见提案 §6.2）

- **backend 无 EditMode**：backend 的「模式」只有一个事实——有无 open transaction。互斥由令牌墙强制（fail-loud）。
- **EditMode 状态机整体归 frontend**（交互仲裁：谁能起手势、点工具=apply/cancel、canDraw fail-safe、ctrl-z 路由）。无 DOM 依赖（唯 `_emit` 的 window.dispatchEvent），随 C5+ 迁 `frontend/`；事件口换回调后可进 toolkit。
- 两层防线分工写进契约：EditMode 挡「正常流不该发生的交互」（fail-safe 不响）；令牌墙挡「任何 bug 的写坏账」（fail-loud throw）。

## 6. C6 违规户迁移施工单（普查产出的 how 情报；行为锚先迁后拆）

1. **液化/滤镜笔（第一户）**：笔内替身化——startSnap 已是冻结源；dst 改写 stroke-scope surrogate buffer（不再 putImageData 真层），live-sync 改读替身（surrogate 机制现成）；End 一次 `replaceFromBytes`（region 版，别学 adjust 整层 clear）+ token.commit；Cancel 丢替身零回滚。收益：cancel 无痕免 collector 回滚、「预览是引擎自持物」成立、顺手可给液化补 cancel UI 入口。行为锚：手感/边界模式/采样核/undo 一笔一步 golden。
2. **形状笔 pixelMode**：每帧 restore+重画 → 替身重画（本质已是参数重算，最容易迁）；preSnap/cancel 双保险退役。
3. **魔棒拖选**：迁的是预览宿。两条候选路（C6 现场定，不预固化）：a) `SelectionPreviewTx` api 化——保 `_rawWrite` 声明态但 commit/abort 结构化（机制现成，selection-component.ts:98-141）；b) 预览全引擎自持（accum+compose 不落 substrate），抬笔一次终值 set——需把 stopMask 从「读 doc.selection」改成显式参数传入查询，且蚂蚁线/fill overlay 的预览读面要跟。
4. 顺手账：液化 cancelStroke 过时注释（v1 PixelEdit 时代，liquify-engine.ts:328-331）随迁清理；adjust commit 的整层 clear→region 替换（undo 包瘦身）同批考虑。

## 7. doc–code 分歧记录（信代码；#1/#2 已获 user 裁决并于 v0.8.29 落地）

1. **ADR-0008 §6 vs fill commit**：ADR 写「commit = [tiles+selection 清+PendingFill 清] 一步」；曾漏「PendingFill 清」。**裁决（user 2026-08-10「应该清」）→ v0.8.29 落地**：commit 步内 `clearRecorded()` 记账清；留在 fill 时 commit 后用刚落地的色重新 begin（导航态 re-seed）——「✓ 连续填下一块」色不丢。**顺手证实并修掉出口错序 bug**：切工具路径曾先 `pendingFill.clear()` 再 `_doCommit` → `_fillColor()` 落回笔刷色（预览绿、落地红），行为锚钉住（fill-mode.test.mjs）；切出路径的换色防抖 entry 曾被谓词失真吞掉，`_flushColorEntry(force)` 修。
2. **ADR-0006 / persp-edit.ts:11 vs 代码**：文档写「取消/ctrl-z=回快照」，代码无快照无回滚（apply≡abort≡`_finish`）。**裁决（user 2026-08-10「persp也全量进undo吧，拖一次可以undo一次」）→ v0.8.29 落地**：VP 编辑全量进 undo——`PerspComponent.commitPreApplied`，拖动期 desk 直写当 transient 预览、pointerup 持 before 快照收口一步（重置/锁切换同为一步、整包记账）；perspEdit ctrl-z 语义 abort-transient → **history**（正好落进 §3.2 判据：无挂起令牌的会话 = transform 模式逐整点回退）；undo/redo 期间 gizmo 经 onChange(kind=persp) 重灌 box + 重摆手柄。ADR-0006 已补修订记录。
3. **液化 cancel 注释过时**（见 §6.4，仍待 C6 顺手清）。
4. **recon-e 双向依赖计数已过期**（C2 已实测回写 gallery.ts 头，此处不再重复）。

> 分类表随裁决的更新：persp 编辑一行的「0 token 0 步」自 v0.8.29 起过时——现 = 每拖一步
> （transient 直写 + pointerup 收口），本质归类从「desk 累积真改」改判「参数重算 + 原子整点」
> （transform 同款：会话无挂起事务、每 verb 一步）。fill 一行 commit 步 entries 变为
> tiles+selection+pendingFill 三件套。
>
> C6 落地更新（v0.8.31）：§6.1/§6.2 已施工——液化/滤镜笔与形状笔 pixelMode 的「交互期写谁」
> 自「真层就地写」改为「**stroke 替身叶**」（StrokeShadow，src/stroke-session.ts；显示 = surrogate
> 影子变体增量 sync；cancel = 丢替身零回滚）；§6.4 顺手账两笔已清（液化 cancel 化石注释、
> adjust commit 整层 clear → applyRegionDiff 只封真变 tile）。§3.4 的宿②③中，真层就地写只剩
> draw/erase pixelMode（stroke 档合法写）；魔棒（§6.3）v0.8.32 走路 a 收口——预览宿不动
> （substrate 声明态 + 读面语义全保），托管结构化进 SelectionPreviewTx（手搓 custody 退役）。
> **C6 三户清账完毕。**
