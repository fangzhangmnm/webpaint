# workpiece v2 施工 handoff（令牌+collector 纪元）
> as-of v0.8.22 / 2026-08-08（T6 GL 双 facade 完毕，下一棒 T7 收口）。读者 = 接手施工的下一个 AI session。
> 拍板（why）= `ai-docs/adr/0008-workpiece-v2-token-collector.md`；目标契约（what）=
> `20260807-workpiece-v2-proposal-h.md`（**pin 住的接口**，形状改动要回写它）；本文 = how/施工序。
> 现状 .h = `api/`（`bash scripts/gen-api.sh` 重生成）。

## 0. 进场必读

- **§0 悬案已裁定（user 2026-08-07）**：不推 dev、不等真机，直接施工。真机批**推迟到 v2 完工后一次交付**
  ——user 原话：「我为什么不会在架构重构阶段实机测试？因为这时候就不是一个 legitimate 的可以跑的
  app，写完了才算数，一口气写不完可以接力。中间怕错可以模块化测试」。中间态靠 node 测试 + tsc 兜，
  别拿半台手术机器去跑真机、也别为此打断施工问人。
  （14 条真机清单仍在 `20260801-v08-epoch-handoff.md` §7+§9，v2 完工后与 v2 新锚合并成一批交付。）
- **过渡态自己裁，不上呈**（user 2026-08-07）：user 只关心终态设计达成度（= ADR-0008 + 提案 .h），
  不关心 legacy 怎么处理——「不要留念旧东西。只要防止这个变成新重构的伤疤然后导致你一直维护旧的
  东西就行」。桥/兼容层的取舍自己拍，唯一硬约束 = 只减不增 + T5 物理删除（见 legacy-bridge.ts 头）。
  **要问 user 的只有非中间态的事**：终态契约（提案 .h）的形状偏离、undo 白/黑名单变动、数据安全。
- push 纪律照旧：新 session 第一批默认不 push；user 本 session 口头授权后可自动推 dev；prod 永远必问。
- 测试基线：1232 node 测试 + tsc 0 错 + `bash scripts/build.sh` 全 lint 过 + `npm run smoke` GL smoke PASSED。
- `test/run.mjs` 是显式清单不是 glob——新测试必须注册。
- 版本：每片 `./bump.sh v0.8.N-日期` patch 递增；**v2 完工要不要 bump 0.9 由 user 显式拍**（minor 权限硬规则）。

## 1. 施工序（切片 = commit/版本粒度；并行度低，按序做）

### T1 · undo-stack v2 + Workpiece 基类（纯新增，与旧栈并存）
- 新文件 `src/workpiece/undo-stack.ts`（UndoStack/UndoStep/WorkpieceComponent/RecordData，零依赖）
  + `src/workpiece/workpiece2.ts`（临时名，T5 收编成 workpiece.ts）：令牌工厂/双计数/注册表/onChange。
- node 测试：token 唯一性/commit 打包/cancel 回滚/自反 swap 往返/配额驱逐/stateVersion 语义
  （画→存→画→undo=clean 三行真值表直接写成测试）。
- 旧 UndoHistory 一字不动，app 未接线——本片零风险。

### T2 · LayerTiles 组件（tile collector + 引用计数）
- tile substrate：从 Layer/LayerPixels 抽出 per-layer tileset + collector（写时扣押被换句柄：
  非本 token 新建→进 collector，本 token 新建→discard——Krita memento 语义）。
- **tileset 引用计数**（json 持有/record 持有各 +1，归零还池；池 FR assert 兜漏）。
- TileReadPort 两档读口落地；computed record 三个白名单 verb + 双捕获断言 + 「flip→undo→逐字节等原图」锚测试。
- 像素路径切换：pixel-tx 的消费方（input 笔刷 commit / filters-adjust / fill / selection-ops 挖洞 /
  toolbar·layers 清除）改走 token+LayerTiles；PixelTx 死。**fill 的 ADR-0004 出入口语义一字不动**。

### T3 · LayerTree 纯 json 化 + load 令牌化
- TreeJson 结构共享 substrate；verbs 按提案 .h（含 mergeDown 字节递入、setTreeProp、setActive 不记账）。
- ora/psd 解码器改产 plain data（json + tile 字节）→ `PaintingWorkpiece.load()` 令牌灌入 + 清栈；
  编码器走 exportData（冻结语义沿 freezeDocForEncode）。**杀 ctx.docRaw / DocView / readDoc()**。
- 修 TreeStructureOp bounded 泄漏（引用计数下所有权变算术——回归测试钉住「删组→驱逐→无泄漏」）。
- 波及最大的一片：board/render 喂树从 doc.layers 改 layerTree.view() 映射；30 个 import doc.ts 的
  文件逐个改读口。tsc 是审计器。

### T4 · Selection / FloatLayer / PendingFill / persp 组件化
- SelectionComponent（值语义现成）；LassoEngine 保持 entry 契约，consumer 改 token+set。
- FloatLayerComponent：float-ops 语义整体迁移（测试锚 float-ops.test 改挂新 API，行为不变）。
- PendingFill + color-target：色板 target 切换（fill 预览期指 PendingFill.color，防抖入栈同 v0.7.8）；
  FillColorOp 死；**笔刷色从此不被 undo 碰**（新增行为锚测试）。
- persp 迁入 PerspComponent（recorded）：doc-ops 的 persp 信封退役；持久化仍进 desk 文件。
- step.hint 落地：唯一住户 = docTransform 的 viewport 还原（闭包捕前后视口小对象）。

### T5 · 旧机器拆除 + rename 片
- 拆：operators.ts / undo-history.ts(旧) / write-gate.ts / doc-view.ts / ~~pixel-tx.ts~~(T2 已拆) / selection-face.ts /
  layer-tree.ts(v1 门面) / workpiece.ts(v1) / **legacy-bridge.ts**；workpiece2/layer-tree2 收编正名。
  行为锚测试全部迁 v2 后才准删旧测试。
- **交付判据（user 2026-08-07 语义）：上列文件物理不存在。在则重构未交付。**
- rename 片（单独 commit）：PaintDoc 残余语义清理、dials/desk 改名（`useDials()`）、
  旧轨 webpaint/state.json 停写（读兼容留存量 + 注释注明拔除版本）、「doc」词回归 user 术语。
- CLAUDE.md 硬规则条目改写成 v2 语言（令牌/组件），ADR-0007 标 superseded-by-0008。

### T6 · GL 双 facade
- GlRoom 引用包（五件套唯一实例）；RenderTreeGL 拆 RenderTree + RasterService。
  **两 facade 必须共享同一 bridge/pool 实例**（烤定搭 base-tile 便车；拆成两套缓存=每笔整层重传）。
- 行为不变纯搬家：gl-smoke + fillParity 是锚。

### T7 · 收口
- `bash scripts/gen-api.sh` 重打 .h，与提案 .h 对账（形状偏差要么回写提案要么改实现）；
- CONTEXT.md 词条更新（token/collector/record/组件表）；handoff 进度节；真机批清单汇总一次交付。

## 1.5 施工进度（as-of v0.8.13 / 2026-08-07，worktree-workpiece-v2 分支）

> user 已裁定 §0 悬案：**不推 dev、不等真机，直接开工**（2026-08-07 本 session）。

- **T1 ✓**（v0.8.9）：undo-stack.ts + workpiece2.ts + 22 测试。提案回写：UndoStepInput（id 栈分配）/
  depth()/CollectorComponent.sealRecord/onTokenLeak/_componentWrite/tokenOpen/abandon。
- **T2 ✓**（v0.8.10）：**关键架构决定——迁移期唯一 undo 栈**。v2 UndoStack 立刻成权威；旧 operator
  流经 `legacy-bridge.ts`（LegacyHistory 实现 HistoryFacade，调用方零改动；checkpoint/compound
  映射成令牌）骑上 v2 栈。LayerTiles collector = **substrate 层写时扣押**（tile-layer.ts
  setTileSwapObserver——engine 直写也收得到 + 自动登记 touched）。PixelTx 死；input/filters-adjust/
  selection-ops/toolbar/blender-sync/fill-mode 全部令牌化。
  ⚠ 已知过渡态：floating-transform 三处 `_initialBefore` 在 compound 内双记账（内容正确、
  多存一份共享句柄；T4 float 组件化时消除）。
- **T3a ✓**（v0.8.11）：layer-tree2.ts（TreeJson 换根收集）+ LayerTiles tileset 注册表
  （引用计数，record 驱逐才释放——**删组泄漏回归锚已钉**）。
- **T3b-1 ✓**（v0.8.12）：PaintingWorkpiece 树模式（opts.tree）+ load(PaintingData) 令牌灌入
  + exportData 冻结快照 + addGroup/loadRoot verb。PaintingData 定形见提案 .h。
- **T3b-2 ✓**（v0.8.13）：**app cutover 完成——PaintDoc 出局，树模式 = 文档 SSoT**。
  - app.ts：`wp2 = PaintingWorkpiece({tree})` + `doc = new PaintingView(wp2)`（端口，DocView 同形
    读面 + 选区过渡宿）——board/input/lasso/引擎/23 个消费文件几乎零语义改动（类型 Layer→ViewLeaf
    等机械换名）。ctx.docRaw / DocView / readDoc() 全杀（readView() 是 port 管道，T5 随 v1 拆）。
  - 门面换心：layer-tree.ts 保名，方法体全走 `history.withPoint`（共享令牌，checkpoint:false 聚合
    语义保住）+ layerTree2 verbs；treeTx 退役，组合动作各归各名（addGroup/ungroup/collapseGroup/
    moveIntoGroup/moveOutOfGroup/explodeLayer/stampAll）；undo/redo 状态栏文案走 statuses→step.hint。
  - operators.ts 瘦身：7 族结构 op + DocTransformOp 删；残余 = pixels/selection/fillColor/float 三件
    套 + 新 DocResizeOp（实例交换）。doc-ops 换 v2 脊柱：flip/rot90/offset 走 computed 白名单、
    crop/cropResample/resample 走 exchange+DocResizeOp、json 尺寸走 setTreeProp(width/height)、
    viewport/persp 还原 = **step.hint 落地**（compound({hint})，T4 待办只剩 persp 组件化）。
  - codec：decodeOraToPainting 产 PaintingData（sidecar 随行）；保存 = wp2.exportData() →
    paintingDataToEncodeDoc（纯切片，无句柄无 dispose）；session-state 装载 = input.clearHistory →
    wp2.load → clearSelectionOnLoad；newDoc/import/revert 全令牌化。freezeDocForEncode 仅测试在用。
  - 测试：1239 绿 + tsc 0 + build.sh lint 过。行为锚已迁：workpiece-layer-tree.test（v2 门面）、
    operators.test（残余集+DocResize+所有权收支）、integrity ①改写成「无令牌 verb → throw」令牌墙锚
    （旧病理结构上不可能）、write-gate.test 裁成机械契约。float-ops/selection-face 测试仍跑 PaintDoc
    基座（结构兼容，T4 迁移时重写）。
  - ⚠ 施工中抓到的真雷（已修，后续别再踩）：**实例交换段必须 _suspendCollect**——mapLeaf 造新实例
    的 putRegion 会被写时扣押逮到（seal 时已 exchange 装上、解析到 layerId → across drift 炸 undo）。
  - ⚠ 已知过渡态：fillLayer0/decoder 基线写 = 无令牌白写（load 前基线，不入 undo，es.adopted 管脏）；
    panel 命名 helper（图层 N/组 N）落 layers-panel；组折叠仍在 panel collapsedIds（从未持久化）。
- **T4 ✓**（v0.8.14-17，2026-08-07 本棒）：selection/float/pendingFill/persp 四片组件化全落，
  **operators.ts 残余集只剩 DocResizeOp 一族**（SwapSelectionOp/SwapPixelsOp/FillColorOp/float
  三件套全死）。组件定形已回写提案 .h「其余组件」节（形状与蓝图的偏离都在那——读它）：
  - **T4a**（v0.8.14）SelectionComponent：pre-applied 双轨（_rawWrite 预览直写 + set/
    commitPreApplied token 记账，首捕获赢/中间产物即弃）；PaintingView.selection 收成镜像口；
    SelectionFace 门面换心走 withPoint（调用方零改动）；doc-ops 选区微步直写组件 verb。
  - **T4b**（v0.8.15）FloatLayerComponent：状态机 verbs（install/setTransform/drop + dropForLoad），
    record 双轨 state/meta；lift/stamp/accept/reject 编排留 FloatingTransform（withPoint 一个
    令牌整点：挖洞/烤层=LayerTiles 扣押、选区/浮层各自分账）；float 类型族迁 float-component.ts；
    三处 _initialBefore 双记账消灭；v1 workpiece internals 只剩 doc。
    ⚠ 迁移注记：旧锚「源层被外力删掉→不可恢复」在 v2 结构上不可能（树只能经 recorded verb 改），
    float-ops.test 头注留档；桥的不可恢复协议锚在 legacy-bridge.test。
  - **T4c**（v0.8.16）PendingFill + 色板 target 切换（color-panel registerColorTarget）：fill
    预览期 setColor/吸管/色词全改 pending 色，**笔刷色不被 undo 碰**（pending-fill.test 行为锚）；
    undo/redo 翻 substrate → onChange 刷显示，_expectFromHistory 回灌抑制机制死。
  - **T4d**（v0.8.17）PerspComponent：**记账面刻意收窄 = 只有 doc 变换 remap**（doc-ops 七处
    remapShapePersp → 组件 verb，persp 信封退役，hint 只剩 viewport）。VP 编辑器仍 desk 直写
    不进栈——user 拍板「VP setting 不进 undo history」（persp-edit.ts _finish 注）与 ADR-0008
    升格不冲突：升格解决的是「undo 不同步还原=透视静默错位」。未动 undo 白名单，无需上呈。
  - 测试 1252 绿 + tsc 0 + build.sh lint 过；新增 pending-fill/persp-component 两测试文件
    （test/run.mjs 已注册），selection-face/float-ops/operators/undo-stack-integrity/
    selection-tiles/fill-mode 换 v2 基座锚语义逐条保留。
- **T5 ✓**（v0.8.18-21，2026-08-08 本棒）：拆旧 + rename 片全落，**交付判据达成——§1 T5 清单文件
  物理不存在**（operators/undo-history/write-gate/selection-face/layer-tree(v1门面)/workpiece(v1)/
  legacy-bridge 全删；doc-view T3b 已拆）。四片：
  - **T5a**（v0.8.18）DocResizeOp 收编 `LayerTiles.resizeAllLeaves`（exchange record，
    undo 包=另一侧实例自反互换；map 期间挂起收集的纪律收进 verb——调用方不再碰 _suspendCollect）；
    host 增 exchangePixels；operators.ts 死；operators.test → doc-resize.test（纯 v2 基座）。
  - **T5b**（v0.8.19）`src/workpiece/history.ts` = **History 编排器**（LegacyHistory 的 v2-native
    后继：withPoint 共享令牌开/续/封 + sealCheckpoint + undo/redo 门 + 不可恢复协议；compound 并入
    withPoint，run 死）。门面迁 app 侧：layer-tree(v1门面) → `src/layers-face.ts`（LayersFace，
    **ctx.layers**；v1 载体死）；SelectionFace 死——SelectionPreviewTx 收编 selection-component
    （commit 返 {changed, before}，**记账归调用方** withPoint）；ctx.workpiece 死。测试：
    legacy-bridge.test → history.test、selection-face.test → selection-preview.test、
    undo-history/write-gate.test 删（锚在 undo-stack/integrity）。
  - **T5c**（v0.8.20）收编正名：workpiece2.ts→workpiece.ts、layer-tree2.ts→layer-tree.ts
    （类 LayerTree2→LayerTree）；layer-tree2.test→layer-tree-json.test。
  - **T5d**（v0.8.21）rename 片：createEditorState→**useDials**、editorState→**desk**（240 处机械换名，
    形状不变）；**旧轨 webpaint/state.json 停写**（ADR-0008 §9——它独有的 eraser/filterBrush/selPen
    dial、palette、blender 三样迁进 desk 新组 toolDials/palette/blender，opaque json 整包收放；
    activeId 本就在 stack.xml webpaint:active；读兼容留存量，拔除另议）；PaintDoc 判定=测试基座残余
    （生产零引用，头注禁新 import；gl-smoke/旧基座测试迁 v2 后随 freezeDocForEncode 拆）；
    PaintingView **定案正名保留端口形**（提案 T5 评估选项①）；CLAUDE.md 硬规则改写 v2 语言、
    ADR-0007 标 superseded-by-0008、提案 .h 全部回写（History/LayersFace/exchange record/desk 三组）。
  - 测试 1232 绿 + tsc 0 + build.sh lint 过（净 -21：旧栈/桥/门面测试删、history/selection-preview/
    doc-resize 新增）。
- **T6 ✓**（v0.8.22，2026-08-08 本棒）：GL 双 facade 落地，**render-tree-gl.ts 物理不存在**。
  - `gl-room.ts` = GlRoom：机房五件套唯一实例 + 两 facade 共享台面（叶驻留 leaves+sync 族/
    pseudo 装置 overlay·float·selMask·fillTex/composeSteps 合成机/onInvalidate 失效信号/HUD 观测口）。
    board 输入类型（FloatInput/OverlayInput/SurrogateInput…）+ poolCapacityForBudget 随迁。
  - `render-tree.ts` = RenderTree（tree composite）：renderFrame/段缓存/display 快路径/plan 签名/
    frameStats/pin provider（leaves+segs 两档，注册在 ctor）；订阅 room.onInvalidate 置脏。
  - `raster-service.ts` = RasterService（一次性算像素，C 骑士接缝）：bakeStamps（原
    commitBrushStroke，收尾 room.invalidateTree() 代替直接 markDirty——facade 互不知晓）+
    rasterizeStampsToBytes + warpToBytes + compositeOnce/ToBytes/ToCanvas + pickColor。零帧状态。
  - GLBoard 装配 room+双 facade，对 board.ts 方法面不变（板级仍叫 commitBrushStroke=app 词汇）；
    board.ts 只改 import 来源。harness/preview 改 makeStage(room,tree,raster) 装配，
    旧 `(tree as any)._bridge` 私字段挖法改正路 room.bridge。
  - 提案 .h「render 侧拆分」节已回写落地形（renderFrame 保 v1 扁平入参、GlRoom 台面职责）。
  - 锚全绿：gl-smoke PASSED（含 fillParity/commitParity/clipLive）+ 1232 node + tsc 0 + build.sh lint。
- **T7（下一棒从这开工）**= 收口（§1 T7：.h 对账 ✓已随 T6 重打、CONTEXT.md 词条、真机批清单汇总）。
- **落盘注意**：T1-T4（v0.8.9-17）+ T5（v0.8.18-21）已 ff 进本地 main（2642b00）；本棒 T6
  （v0.8.22）在 worktree-workpiece-v2 分支，进场先在主 checkout
  `git merge --ff-only worktree-workpiece-v2`。

## 2. 地雷

- fill（ADR-0004 修订5 one-shot 携入）与 float（v291 复数 source/v0.6.21 有向 frame）都是 user 多轮
  拍板——迁移=换地基不换行为，测试锚先迁后拆。
- undo-stack-integrity.test 的病理测试（不记账加层→炸栈）在 v2 下语义变化：裸写物理不可能 →
  改写为「无 token 写 → substrate 拒绝」的新锚，别直接删。
- collector 扣押/棄置与 pool FR 的配合：cancel 路径最容易漏 dispose，专门测。
- computed record 双捕获断言开着别关；白名单只有 flip/rot90/offsetWrap 三个。
- 跨 await 挂起 token：并发写靠 EditMode transient 挡（现状机制），别顺手发明全局锁（tool state
  全局类是独立记名坑）。
- worktree 铁律：改完 merge 回本地 main；`test/run.mjs` 手动注册。

## 3. 已记名不在本纪元的坑

预览违规户迁移（液化就地写/魔棒拖选直写 selection/形状笔 pixelMode）、tool state 全局类、
color 编辑器模态化、C 骑士 headless（RasterService 即接缝）、AABB↔tiles service 正名、
desk 文件名迁移、B2 store 窄接口收敛、password 契约拷问。
