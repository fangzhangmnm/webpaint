# C 骑士（前后端分域）施工 handoff

> as-of v0.8.23 / 2026-08-09（**策划收口，施工未开始**）。读者 = 接棒的下一个 AI session。
> 契约（what，pin 住）= `20260808-c-headless-proposal.md`（grill 后终版，形状变了要回写它）；
> why = `ai-docs/adr/0009-gl2port-and-determinism.md` + ADR-0008；
> 拍板出处 = `20260809-c-backend-grill.md`（五轮 grill，引 user 原话前先查它）。
> 施工模式 = v2 同款马拉松接力（user：「写好之后handoff，然后就可以和上一次一样handoff接力做了」）。

## 0. 进场必读

- **push 纪律**：新 session 第一批默认不 push；user 本 session 口头授权后可自动推 dev；prod 永远必问。
  worktree 铁律：改完 merge/ff 回**本地** main（出过 remote 领先 local）。
- **版本**：每片 `./bump.sh v0.8.N-日期` patch 递增（doc-only 片不 bump）；**骑士做完前不 bump 0.9**
  （user 2026-08-08：「现在只是 0.8 的前 1/3」）；bump minor 必须 user 显式说版本号。
- **测试基线**：1232 node 绿 + tsc 0 + `bash scripts/build.sh` 全 lint + `npm run smoke` GL smoke
  PASSED。`test/run.mjs` 是显式清单，新测试必须注册。
- **中间态纪律**（v2 同款，user 拍板沿用）：不推 dev 不等真机直接接力施工；「写完了才算数，一口气
  写不完可以接力。中间怕错可以模块化测试」；过渡态自己裁不上呈，上呈只有终态契约偏离/undo 白黑
  名单/数据安全。**测试分级从 C8 起生效前，先维持全量 npm test**；C8 落地后中间棒可只跑相关模块+tsc。
- **红线照旧**：src/store/** 改前 escalate；doc mutation 必须持令牌（ADR-0008）；journal/ 不碰。

## 1. 施工序 = 提案 §5 切片表（C0→C9）。本节只补每片的「how 情报」

- **C0 改名表+顺手修**：全文件对照表放 `ai-docs/20260809-file-naming-survey.md`（打 timestamp 可
  过期，不承诺维护）。已核实的错位样本：`lasso.ts`（826 行 = 套索手势 + 自由变换编排 + 魔棒/泛洪/
  相似色算法本体三合一，头注释只认前两者）；`lineart/`（= Fourey–Tschumperlé–Revoy 2018 flat
  coloring 论文实现，非「勾线」）→ `backend/algorithms/flat-coloring/`。**color window 退化**：
  「切到fill的时候填色没有立刻反应全局颜色的颜色」——T4c registerColorTarget 色板 target 切换的
  UX 缺口，修复入口在 color-panel/fill-mode 接线，修完记真机锚。
- **C1 Gl2Port**：现状唯一创建点 gl-context.ts:68（ctor 内 getContext）、唯一调用 gl-board.ts:35。
  全仓 GL 动词面已核实：按名 shader 画 quad（TRIANGLES×6）+ gl-stamp 一次 drawArraysInstanced +
  FBO 借还 + blend 状态 + 纹理上传 + readPixels——接口就这几个动词，别扩。行为不变纯搬家，
  gl-smoke 是锚。
- **C2 目录格律**：lint 挂点 = scripts/build.sh 现有分层 lint 段（v0.4/B 段同款写法）。gallery 搬家
  时把 recon-e 点名的双向依赖记文件头（gallery.ts 直调 session.* 7 处、session-state 反向调
  gallery.refresh() 3 处）——E 骑士开工清单，本轮不斩。
- **C3 canvas 债+lasso 拆**：字节继任者都已在（resample-bytes v0.6.46、editRegionBytes v0.6.41、
  selection gray8 本体）；债表见提案 §4。lasso 拆的验收 = user 原话「每个文件，模块能解释清楚
  做什么，而不是『有关部门』」。
- **C4 普查**：对象=stroke/transform/curve slider/液化/魔棒拖选/形状笔 pixelMode/persp 编辑/fill
  预览。已核实的两条现状路：region filter = surrogate 模式（开面板取 token→bake 纯函数写替身
  buffer→GL 显示→commit/cancel，真层零改动，**这就是 transaction 协议的原型**）；液化/filter-brush
  = 就地写真层+live-sync 每帧重传（undo 记账正确，违的是预览语义——ADR-0008 显式记名 defer，
  非违令）。普查产物回写提案 §6 留白。
- **C5 StrokeSession**：手感数学（StrokeSmoother/压感 LPF）随迁 backend；brush.ts:117,139 壁钟
  dt→事件 t 顺手账同片落。引擎侧本就吃标量（brush.beginStroke(layer,settings,x,y,p,mode,smooth,t)），
  事实解耦已成，抽的是事务生命周期（input.ts:918-940 一带的 commit/finalize/记账编排）。
  ResolvedBrush 快照锁定一笔（画一半动笔=下一笔生效）。
- **C6 违规户迁移**：液化第一户（liquify-engine putImageData 就地写→surrogate 化），魔棒拖选、
  形状笔 pixelMode 跟上。行为锚先迁后拆。
- **C7 装配**：app-context 39 键的 backend 瘦版；B2 store 窄接口一并裁（20260801-v08-epoch-handoff
  §9 挂点）；多 tab 租户+dispose；接口文件两份（backend interface + frontend toolkit .h）；sidecar 槽
  （editor-session 的 peek 已是雏形）。
- **C8 SoftGl2Port+MCP**：迂腐语义模拟（GL 规范公式忠实，不复刻硬件数值/instancing）；现成种子
  = test/gl-smoke/reference-2d.ts（2D 规范合成器）+ ARCHIVE/old-brush-cpu-raster.ts（CPU 笔刷
  栅格器）。node 无真 WebGL2（headless-gl 只有 WebGL1 已否）；全量层用 Playwright headless
  Chrome（SwiftShader，dev-only）三方对拍。MCP 红队动词：create/crop/draw/circle/undo/redo/export
  （user：「你多红队一点」）。
- **C9 reference window 组件**：家族 web component 约定试点（vendor .mjs/属性事件/宿主 store 解耦）；
  embedding 终态 = webcomponent 壳 + Worker backend（iframe 手势稀烂已否，降级为不信任第三方场景）。

## 2. 地雷

- **别把 SoftGl2 当用户路径**：无 WebGL2 照旧响亮失败（「CPU 性能不可接受」维持原判）。
- **shader 注册表纪律**：新 shader 不配 CPU 版必须显式 GPU-only 登记——静默缺席=对表测试红。
- **热路径栅格只准走 Gl2Port**；新独立 CPU 像素算法要 user consent + algorithms/ 落户。
- 三面预览旗语义（overlay/surrogate/float，ADR-0008 §8）与 fill 的 ADR-0004 出入口语义一字不动。
- workpiece v2 令牌墙别绕：backend interface 化是给现有 verbs 穿接口衣，不是重造写路径。
- 搬目录时 import 路径大改——tsc 是审计器，一片一搬别攒大爆炸。
- 提案 §6 留白**不许提前固化**（transaction 细节/EditMode 归属等 C4 普查产出）。

## 3. 悬账（不在本纪元/等排期）

- 真机批 24 条未跑（`20260807-workpiece-v2-handoff.md` §4，12+2+10 口径）——C 批的新真机锚
  （color window 修复、C6 三户手感）往里追加，攒批一次交付。
- B 剩余批：password 契约、单 .html 发行（非 mhtml；资源 base64 内联，可出单文件+目录双产物）、
  pwa wizard、三兄弟对齐——排 C 之后另立 handoff（user：「这样更彻底」）。
- UX 抽象层系统 grill（排 UI 骑士侧）；gallery/editor 组件化（E/embedding 骑士）；bodypaint
  （远期；机制备忘 = grill 记录 §七.4：texture 空间 full-quad 反算 screen 采样 stroke buffer
  + delta-z screening，对 backend 只是多一个映射函数）。

## 4. 施工进度（接棒者按片追记）

- **C0 ✅ v0.8.24（2026-08-09）**：①全文件对照表落 `20260809-file-naming-survey.md`（211 文件×
  实际做什么×提案去处，含重点错位样本/死代码候选两节）；②改名落地：`lineart/`→`flat-coloring/`、
  `lineart-oracle.ts`→`flat-coloring-oracle.ts`、`stylize_filters.ts`→`stylize-filters.ts`（持久化
  key/算法 id "lineart"/类名符号均未动，符号改名排 C3）；③color window 退化已修：色板 target 从
  「仅预览期」扩到 **fill 工具全程**（旧行为：无选区期改色写笔刷色、pendingFill seed 陈旧→圈选
  预览用旧色）——fill 里改色一律改 PendingFill，预览挂着才走防抖记账，无预览改色=换 seed 不占
  undo 步；笔刷色全程不动（T4c 锚不变）。测试 1233 绿（+1 行为锚 fill-mode.test.mjs）。
  **真机锚（追加进真机批）**：进 fill→（无选区时）色窗换色→点选区，预览色 = 色窗色；✓ 连续填
  下一块色不丢；出 fill 色窗回笔刷色。
- **C1 ✅ v0.8.25（2026-08-10）**：①契约落 `src/common/gl2-port.ts`（Gl2Caps/FBOPrec/PooledFBO/
  Gl2Port——isLost/generation/onInvalidated 多播 + program 按名 + FBO 借还 + quadVAO；`gl` 裸口
  **显式标注过渡负债**，C5/C8 收编、SoftGl2Port 前清零——终态契约没有它）；②实现体落
  `src/shell/browser-gl2-port.ts`（GLContext 现体改名翻入，getContext 唯一创建点在 board.ts
  `_setupGLBoard` 壳侧造好递入；onLost/onRestored 单槽回调删除，gl-board 唯一订户改 onInvalidated，
  行为不变）；③src/gl 零 getContext 达成：gl-context.ts 删除、全 gl/ 文件改持 Gl2Port 类型
  （import 方向 gl→common）；RasterService.compositeToCanvas / GLCompositor.warpToCanvas 两个
  canvas 包装撤出（唯一消费者 board.ts:compositeNodesToCanvas / smoke harness warpToCanvasVia
  本地自包字节→canvas）。④GPU tile arena 归 Port（多 tab 记账）**未动**——排 C7。验收：tsc 0、
  1233 绿、build lint 全过、GL smoke PASSED。无新真机锚（行为不变纯搬家；context-loss 自愈路径
  真机批已有旧锚覆盖）。
- **C2 ✅ v0.8.26（2026-08-10）**：①五目录格律 lint 挂 build.sh「0.7 C2 目录格律」段（v0.4 同款
  写法）：common 禁一切 ../、backend 只准 common+vendor、frontend 只准 common+backend+vendor、
  shell 无约束、gallery 检疫无约束；禁浏览器词（common+backend 代码行禁 document/window/navigator/
  localStorage/sessionStorage/getContext/createElement/addEventListener，注释豁免）；**负测试已验证
  两类违规都咬人**。②gallery 8 文件搬入 `src/gallery/`（flat，不细分）：gallery-model/-path/-shell +
  ui/gallery.ts→gallery.ts + ui/gallery-view-model.ts + cloud-auth-ui + cloud-thumbs +
  cloud-thumb-cache；双向依赖记账落 gallery.ts 文件头 + session-state.ts `let gallery` 旁
  （实数 10/5+2，recon-e 7/3 过期）。③common 种子搬迁：tiles/tile-geometry.ts、color-dist.ts
  → src/common/（提案 §1 点名；backend/frontend 住户排 C3/C5）。验收：tsc 0、1233 绿、
  新 lint 绿+防退化验证、GL smoke PASSED。行为不变纯搬家，无新真机锚。
- **C3 部分 ✅ v0.8.27（2026-08-10）——已交付**：①**algorithms/ 立户**：flat-coloring/、bspline、
  rotsprite、resample-bytes、color-cluster 迁 `src/backend/algorithms/` + 注册清单
  `backend/algorithms/README.md`（含待迁挂账：pixel-conic 被 perspective-frame/shape-geometry 拆分
  拖住、rasterizePolygonGray8 被 Selection→common 拖住）。②**lasso 拆**：魔棒三内核（泛洪/容隙
  EDT 闭/同色全图）析出 `magic-wand.ts`（零 Selection/UI 知识，WandSourceLayer 结构面）；lasso.ts
  留同签名 Selection 包装出口——test/flood-select、similar-select 行为锚零改动全绿。③**债 a**：
  resample.ts 物理不存在——smartResample/fitWithin 死；缩略图（ora 自适应+peek）/mergedimage/导出
  PNG/blender 推图/参考图缩存全走 areaResampleBytes+encodePngFromBytes；解码读出/canvasToBlob 幸存
  三函数落 `shell/image-io.ts`；RESAMPLE_MODES+fillResampleSelect 落 `frontend/resample-modes.ts`。
  ④**债 c**：selection.toCanvas 早已零消费（本轮核实，判据已满足）。⑤**债 d**：
  renderDocToImageBlob 全字节（PNG=UPNG 纯字节含 crop/JPG=字节铺底+canvas 仅当编码器）；
  encodePngFromCanvas 后门从 ora/session 拔除（png-codec 里的导出函数还在，剩余消费者=0，下一棒
  顺手删）。**真机锚（追加真机批）**：存档缩略图/图库 peek/mergedimage 观感如旧；导出 PNG 透明保持、
  JPG 底色正确、含选区裁剪导出；blender 推图 POT 缩放；参考图 >2048 导入缩存。
  ~~**C3 剩余（下一棒接着做）**：⑥债 b、⑦死代码、⑧符号改名~~（↓ v0.8.28 收账完毕）
- **C3 完 ✅ v0.8.28（2026-08-10）**：①**债 b 实勘比 handoff 估的小得多**——真写者早在 v0.6.39-46
  批已字节化，剩的全是死声明/死 getter：selection-ops 剪贴板复制是唯一 `.canvas` 真读者（→
  encodePngFromBytes 全字节）；filters-adjust/import-image/selection.ts 三处接口成员纯死（剪除）；
  Selection 的 fromAlphaCanvas/materializeMaskCanvas 死口拆除（lasso 早走 rasterizePolygonGray8）；
  ViewLeaf canvas/ctx/_mat 物化视图拆除，bbox= contentBounds rev-keyed 缓存，releaseMaterialized/
  countMat 档随葬（board 双份计费分支删）；encodePngFromCanvas 后门删除。**src/ 生产面零 canvas
  facade**；canvas trio 迁 `test/gl-smoke/canvas2d-facade.ts`（2D 参照域合法住所）。
  ②**死代码比 handoff 估的更大**：doc.ts **物理消灭**（PaintDoc/Layer/LayerGroup/树工具/freeze
  全系生产零引用——活面只剩预算三件迁 painting-view + LayerSnap 消费者切 ViewLeafSnap）；
  gallery-model merge/slice/classify 系列拆除（store 库 listing/trash-merge/reconcile 已收编，
  锚在 store 侧测试）；psd 死变量 c+死类型/cloud-thumb-cache fileSize 死参链/session-name _opts/
  survey §3 化石注释全清；tsconfig include 死条目清扫（+补 backend/gallery/workpiece glob）。
  ③**12 个 PaintDoc-fixture 测试迁 v2 基座**：brush-collect-stamps/shape-brush/liquify-bbox=
  wp2 rig 换壳；doc-offset/doc-rotate=LayerPixels 内核直测（零 stub canvas，+flippedHorizontal
  新锚）；crop-geometry=lp.cropped+resampleBytes 组合；ora-tree=OraDoc 鸭形直构；selection-tiles
  fromLayerAlpha=LayerPixels 鸭形；layer-cap-budget=computeMaxLayers 纯函数+PaintingView 装配；
  **doc-mergedown-clip=LayersFace.mergeDown 真路径新覆盖**（同一 setDocCompositorBytes 注入 seam，
  旧注「mergeDown 走 GL node 不可测」不成立，clip 语义+undo 还原全锚）；freeze-encode/layer-tree
  删除（死行为；v2 锚在 painting-workpiece/workpiece-layer-tree/layer-tree-json）。gl-smoke
  harness 两处 PaintDoc→wp2 rig，reference-2d 类型改本地鸭形。④⑧符号改名：LineartOracle→
  FlatColoringOracle 族（Params/Partition/DEFAULT_PARAMS/buildPartition）；`"lineart"` 持久化
  key 与算法 id 挂钩的 lasso 公有方法名（setLineartX/lineartReady/lineartDebug）不动。
  验收：tsc 0、**1186 绿**（1233−47：删死行为锚、增 v2 锚）、build 四 lint 全过、GL smoke
  PASSED（含迁移后 mergedown/brushpipe 对拍）。无新真机锚（行为不变；剪贴板复制 PNG 已有
  旧锚覆盖，属真机批既有条目）。**下一片 = C4 普查**（预览/事务违规户盘点，产物回写提案 §6）。
- **C4 ✅ doc-only（2026-08-10，不 bump）**：普查产物落 `20260810-c4-transaction-census.md`
  （四路全代码勘探：11 张事实卡带 file:line + 分类总表 + 结构发现链）；transaction 协议 +
  EditMode 归属已回写提案 §6.1/§6.2（原「留白」节改组为 §6.3）。要点：①三类本质→三形态
  （一次终值=原子 verb；累积真改=stroke 档**一个**，全笔类共用；参数重算=filter 档
  begin/setParams/commit/cancel，原型=filters-adjust surrogate 逐字升格）；②互斥=单令牌墙
  接口化（第二 begin/开着时 undo/冲突 verb→响亮拒绝）；③transform 裁定**无档口**（frontend
  括号+原子 verb 序列；ctrl-z 分叉的结构根源=有无挂起令牌——挂了事务栈被锁只能 abort，
  想中途 undo 就不能挂）；④EditMode 归 frontend（backend 只有「有无 open transaction」，
  两层防线分工入契约）；⑤C6 施工单细化（液化笔内替身化用现成 startSnap 冻结源/形状笔
  替身重画最易迁/魔棒迁预览宿两候选路 C6 现场定）。**普查新发现的账**：无令牌像素写只
  静默不记账（观察者 `!tokenOpen` early-return，layer-tiles.ts:349）→ C7 硬化候选；三处
  doc-code 分歧记录在案待 human（census §7：ADR-0008 §6 PendingFill 清不在 fill commit 步、
  ADR-0006 persp「ctrl-z 回快照」代码不存在 apply≡abort、液化 cancel 注释过时）。无代码
  改动、无新真机锚。**下一片 = C5 StrokeSession**（事务代码迁出 input.ts + 手感数学随迁
  backend + 壁钟→事件 t；census §2.1/§3.8 是现成情报）。
- **C4 裁决落地 ✅ v0.8.29（2026-08-10）**：census §7 两分歧获 user 裁决同 session 落地。
  ①fill commit 步补「PendingFill 清」（`clearRecorded` 记账清 + 留在 fill 时 re-seed 刚落地色
  ——「✓ 连续填下一块」色不丢；user「应该清」）；**顺手抓获并修出口错序真 bug**：切工具路径
  曾先 clear 后 commit → 预览绿落地红（`_fillColor` 回退笔刷色），加 `_flushColorEntry(force)`
  保切出路径换色 entry 不丢。②persp VP 编辑全量进 undo（user「拖一次可以undo一次」）：
  `PerspComponent.commitPreApplied` + persp-edit 拖动/重置/锁切换各收口一步、ctrl-z 改
  history（transform 同款）、undo 中 gizmo onChange 重灌；ADR-0006 补修订记录、ADR-0008
  §4/§6 补落地注。测试 1191 绿（+5：fill 落色 WYSIWYG/commit 三件套/clearRecorded/persp
  拖动记账/no-op 不占步）。**真机锚（追加真机批）**：fill 换色→切工具，落地色=预览色；
  ✓ 连续填两块不同色各自正确、undo 逐步回；persp 编辑拖 VP→ctrl-z 回拖前、连拖三次撤三次、
  重置/锁切换也各占一步、undo 中手柄跟着跳。
- **C5 ✅ v0.8.30（2026-08-10）**：①**StrokeSession 落 `src/stroke-session.ts`**：
  input._beginStroke/_endStroke/_abortStroke/_beginFilterBrush 里的令牌开合/GPU commit/选区
  finalize/记账编排物理迁出（input 只剩手势路由 + 投喂 (x,y,p,t) + 「取下 session 调收口」的
  转发）；session 对象 = 令牌句柄（backend `strokeBegin→StrokeId` 的进程内化身，全部笔类共用
  一个档口，C7 api 化时逐字升格）；deps 全函数面六个点（begin/tokenChanged/tokenBeforeImage/
  getSelection/commitStamps/invalidate——后两个是屏显侧（board）注入，终态归 backend 自持，
  C7/C8 收编）。filterBrush begin 失败路径改 session.cancel() 收口（原 token.cancel 语义不变，
  多一次无害 invalidate）。②**手感数学迁 backend**：stroke-smoother.ts →
  `src/backend/stroke-smoother.ts`（纯数学零依赖，过 C2 格律）；压感 LPF 从 brush.ts 析出成
  `PressureLPF` 类同住。③**壁钟→事件 t（census §2.1 排的顺手账）**：_pressureLPF 的
  performance.now() 拔除，dt = 事件 timeStamp 差（无 t → FALLBACK_DT=16，同 StrokeSmoother
  惯例；「同一笔两套时钟」收成一套事件钟）——backend 决定论：同一 (x,y,p,t) 序列 → 同一输出
  （ADR-0009；C8 SoftGl2/MCP 回放前提）。gl-smoke golden 在 ±ε 内未移位，无需重录。
  验收：tsc 0、**1201 绿**（+10：session 5 锚=一笔一步/cancel 无痕/单令牌墙 throw/GPU 委托跳
  finalize/选区 finalize 兜底；PressureLPF 5 锚=直传/事件钟/兜底/决定论）、build 五 lint 全过、
  GL smoke PASSED。**真机锚（追加真机批）**：压感笔刷（pressureLPF>0 的笔）快甩起伏一笔——
  粗细跟压感的响应比 v0.8.29 略更跟手（coalesced 批的 dt 不再被处理时刻钟压扁），无尖刺无断笔。
  **Gl2Port 动词面全量收编（§6.3 点名 C5/C8）本片未动**——C5 没碰 gl/，排 C8。
  **下一片 = C6 违规户迁移**（液化第一户笔内替身化 → 魔棒拖选、形状笔 pixelMode 跟上；
  census §6 施工单是现成情报，行为锚先迁后拆）。
- **C6 前半 ✅ v0.8.31（2026-08-10）——户1 液化/滤镜笔 + 户2 形状笔 pixelMode**：
  ①**StrokeShadow 替身叶落 `src/stroke-session.ts`**：像素 = 真叶零拷贝快照克隆（tile 句柄
  共享），呈现 ViewLeaf 引擎读写面（bbox/getImageData/putImageData/editRegionBytes/snapshot 系
  ——引擎零改动）；session 五参改 preview 三态（overlay/livesync/shadow），`session.target` =
  引擎写靶。**描边期真层零写**；End = 句柄 diff（CoW：id 不变⇔没写过）putTile 落账真层——
  undo 包 = 引擎真触过的 tile 集（与旧 in-place 扣押集逐 tile 相同）+ 删格（被擦空）写透明
  回收；Cancel = 丢替身零回滚。替身自身换手被 collector 扣押但 seal 作废（layer-tiles 既有
  「解析不到 layerId 的实例」机制，头注就是为临时实例留的——workpiece 零改动）。
  ②**显示 = surrogate 影子变体**：SurrogateInput 拆 Plane/Shadow 联合（gl-room），render-tree/
  raster-service 按 `"pixels" in surrogate` 分派——影子走 syncLeafSafe **per-tile 增量上传**
  （未变 tile 句柄同真叶 → GPU 桥去重免费；对比 adjust 平面替身全 bbox 重传）；吸管
  pickColor 同路 WYSIWYG；markDocDirty 门补 `!_strokeShadow`（段缓存 sb0 承诺不破）。
  board.setStrokeShadow 开关，接 StrokeSessionDeps.setShadow（deps 第七点，board 注入）。
  ③**接线**：filterBrush（液化+锐化模糊）与形状笔 pixelMode → "shadow"；draw/erase pixelMode
  维持 livesync（stroke 档合法的令牌内真层写，提案 §6.1——**非违规户不迁**）；buffered 照旧
  overlay。形状笔 preSnap-restore/cancel 双保险退役成无害冗余（restore 落在替身上）。
  ④**顺手账（census §6.4/§7.3）**：液化 cancelStroke v1「PixelEdit abort」化石注释清；adjust
  commit `replaceFromBytes`（整层 clear+重写）→ `applyRegionDiff`（逐 tile memcmp 只封真变
  tile，undo 包 = 实际改动，字节逐位同旧）；filters.ts BrushLayer 死 `ctx` 声明剪除。
  ⑤ADR-0008 后果节补 C6 落地注；census 尾注更新。验收：tsc 0、**1209 绿**（+8：替身生命周期
  5 锚=真层零写/落账一步/cancel 无痕/no-op/删格回收 + finalize 次序 + 液化全程替身集成 2 锚
  =字节与 in-place 逐位一致/cancel 逐位不变）、build 五 lint 全过、GL smoke PASSED。
  **真机锚（追加真机批）**：液化推/收/胀/旋手感与 v0.8.30 无差（含选区边界三模式、采样核
  切换）；液化/模糊锐化描边中二指转手势 = 无痕取消（此前靠 collector 回滚，现在丢替身）；
  形状笔像素模式拖拽预览如旧、Esc/切子工具取消无痕；调整面板（HSV 等）Apply 后 undo 正常。
  **偏差记录**：参考窗 live 镜像（wp:docpixeldirty 消费者）在液化/形状笔像素描边中显笔前内容、
  抬笔跟上（与 adjust 面板预览同款既有语义——compositeOnce 导出路径不传 surrogate）。
  **C6 剩余 = 户3 魔棒拖选**（census §6.3 两候选路现场定）+ 液化 cancel UI 入口（UX 判断，
  留人类拍板）。
- **C6 完 ✅ v0.8.32（2026-08-10）——户3 魔棒拖选**：现场定 **census §6.3 路 a**（PreviewTx 化）
  ——路 b（预览全引擎自持）被否的理由：stopMask「本笔已选也成墙」（v0.7.23 语义，路径依赖是
  真需求）+ 蚂蚁线/fill overlay 每帧读 doc.selection，重接三个读面换零用户可见收益。落地：
  ①`SelectionPreviewTx` 构造参数放宽成 `SelectionPreviewPort` 最小口（view/_rawWrite——纯类型
  放宽零行为变化），lasso 经 doc 端口适配 `{view:()=>doc.selection,_rawWrite:v=>doc.selection=v}`
  ——node 假 doc 直测不必长组件；②magic drag 四函数（begin/step/end/cancel）的手搓 custody
  （_magicOrig 保管/prev dispose 杂耍/cancel 还原）退役，全走 tx（write 换手 dispose、commit
  净零变化不产 entry、abort 无痕）；entry 形状不变（input._pushSelEntry 零改动）。验收：tsc 0、
  **1209 绿**（magic-drag 4 既有行为锚零改动全过 = 先迁后拆证明）、build 五 lint、GL smoke
  PASSED。无新真机锚（行为不变；魔棒拖选真机锚在既有真机批）。**C6 三户清账完毕**；液化
  cancel UI 入口留人类拍板（UX）。**下一片 = C7 装配**（app-context 39 键 backend 瘦版 + B2
  store 窄接口 + 多 tab 租户 dispose + 接口文件两份 + sidecar 槽；census 普查新账「无令牌像素
  写静默不记账」的 throw 硬化也排 C7，见 §7/新发现节）。
- **C7 第一棒 ✅ v0.8.33（2026-08-10）——substrate 搬家 + WebPaintBackend 装配**：
  ①**backend 物理搬家**：workpiece/、tiles/、selection.ts、doc-render.ts、layers-face.ts、zip.ts、
  ora-stack-xml.ts、png-codec.ts、ora.ts 全部迁 `src/backend/`（~130 文件 import 路径 tsc 审计）；
  四处纯化手术（行为均不变）：ora-stack-xml 版本戳改参数（encodeDocToOra `opts.wroteWith` 必填，
  壳传 WEBPAINT_VERSION）、ora reportError 改注入槽 `setOraLogReporter`（app.ts boot 接 error-badge
  funnel，tiles 泄漏上报同款）、png-codec canvas 回退路移壳 `shell/image-io.installPngDecodeFallback`
  （headless 无回退 → UPNG 硬解兜底）、painting-view `navigator.deviceMemory` 改 `setDeviceMemoryGB`
  注入、zip.ts window→globalThis（node shim 同挂）。②**C2 lint 升格 node 真路径解析**
  （scripts/lint-dirs.mjs；旧 grep 分不清 backend 子目录互引和逃逸，且**仓路径带空格时 URL.pathname
  %20 会静默扫空假绿**——用 fileURLToPath + 自检；负测试两类咬人重验）。③**观察者多租化**：
  tile 换手观察者全局单槽→**多播注册表**（旧单槽第二个 LayerTiles 静默偷钩 = 双 backend 坏账）+
  tileset **所有权戳**过滤（无主临时件如 StrokeShadow 沿旧「谁令牌开谁扣押、seal 作废」语义）；
  LayerTiles.dispose() 退租。④**装配**：接口 `backend/webpaint-backend-interface.ts`（.h，纯标量墙）
  + `backend/webpaint-backend.ts`（born-loaded 工厂 blank/open 魔数嗅探 PK/8BPS/PNG/位图、dispose、
  encodeOra（sidecar 原样携带）、exportImage（GL 缺席响亮失败）、层结构 verbs=LayersFace 穿衣、
  undo/redo、onChange；stroke/filter 档口契约 pin、进程内实现响亮 throw 占位等 C8）。
  ⑤**决定论 encode**：ora zip entry 时间戳钉死 1980 epoch（同内容→同字节；提案 §3 已回写）。
  验收：tsc 0、**1221 绿**（+12：工厂 3/逐字节 round-trip 3+sidecar/exportImage 响亮失败 2/双 backend
  并发 2/dispose/onChange）、build 全 lint、GL smoke PASSED。无新真机锚（搬家+新增面，无 UI 行为
  变化；「iCCP PNG 导入照常」由回退移壳覆盖，属既有导入锚）。~~**C7 剩余（后棒）**~~（↓ v0.8.34-38
  清账完毕）。
- **C7 完 ✅ v0.8.34-38（2026-08-10）——后棒五片清账**：
  ①**v0.8.34 壳迁移**：app.ts 消费 `WebPaintBackend.blank({2048×2048}, inject)`——组合根不再自装配
  history/wp2/view/layers（唯一装配根 = backend，UNDO 配额归它）；壳编排经 `inject.hooks`
  （onHistChange→wp:histchange / onApplied→面板+重绘 / onUnrecoverable→banner / status→状态栏）+
  persp host 注入；ctx 加 `backend` 键（五引擎键保留 = 协作面直取投影，收敛留后续骑士）；换文档仍走
  wp2.load（tab 管理器「弃旧建新」= embedding 纪元）。行为不变纯搬家。
  ②**v0.8.35 psd 实勘改判**：全仓**无 psd 解码器**——psd 是只写格式（handoff 原「psd open 路由」
  的前提不成立）；编码器 psd.ts 物理迁 `src/backend/psd.ts`（已零 canvas），open 对 8BPS 响亮失败
  =终态、错误文案改诚实（「转存 .ora/.png 再导入」）。
  ③**v0.8.36 无令牌像素写硬化**（census §3.6）：`_onTileSwap` 静默口收死——suspend 白名单窗放行 →
  他家 backend 放行 → **无令牌 + 有主（我的 substrate）= 响亮 throw**；无主临时件（替身/scratch/
  内核直测）令牌外照旧放行；dispose/驱逐/换血路先摘戳（`_disposeOwned`——record 驱逐的逐格 notify
  发生在令牌外，属 collector 自家授权释放）。测试种子写全量迁显式声明态：`test/helpers.mjs seedWrite`
  （经 `_collectorOwner` 戳开 suspend 窗）+ 纯引擎 rig 三文件（shape-brush/brush-collect-stamps/
  layer-cap-budget）整体声明 scratch 域；gl-smoke harness mergedown fill 同改。+3 负/正锚。
  ④**v0.8.37 B2 裁定落地**：app 消费面实测**只有四面**（file/files/collection/encryption，其余 grep
  命中皆旧注释）→ `AppStorePort = Pick<Store, 四面>` 落接缝 app-store.ts（**派生**自库类型 SSoT，
  零镜像零 drift）；AppContext.store 换窄 Port；Collection/EncryptedBlob 类型经接缝转口（app-prefs/
  app-state 的 type-only import 擦除、不成 i18n 运行时环）。**全量手写镜像裁定不做**——headless 分层
  = WebPaintBackend 零 store 依赖，「物理删除仍编译」无受益方（epoch-handoff §B2 的怀疑成立）。
  ⑤**v0.8.38 per-tenant 合成注入**：backend/LayersFace 各持 `inject.compositorBytes`
  （encodeOra/exportImage/mergeDown），缺省回落 doc-render 全局接缝（壳单租户语义不变；psd/session
  等壳模块继续吃全局面）；app.ts 注入 board 面 thunk；双 backend 各持己面锚。**arena 归 Port 推迟
  C8**：接口形状与 SoftGl2Port 同批设计（§6.3 不提前固化）；多 backend 记账串账已由多播观察者+
  所有权戳解决，GPU 配额的租户记账等第二真租户（C8 mock multiplayer/embedding）。
  ⑥收尾：filter 档口 wire 两条 pin 进接口文件（互斥 = per-backend 令牌墙，跨租户互斥结构上不存在；
  超时 = 进程内无超时/远程断联即 cancel，数值随 C8 transport 定）；**frontend toolkit .h** 落
  `20260810-frontend-toolkit-h.md`（策展索引，签名真值=api/；物理搬 toolkit/ 归 UI/E 骑士）。
  验收：tsc 0、**1225 绿**（1221+3 硬化锚+1 per-tenant 锚）、build 五 lint 全过、GL smoke PASSED。
  **真机锚（追加真机批）**：画/擦/液化/形状笔/调整/变换/填色/裁剪全流程无「无令牌像素写」红 banner
  （硬化误伤探测——任何一处弹了就是抓到真 bug 或白名单漏登记）；开画→画→存→图库缩略图/导出
  PNG·JPG/mergedimage 观感如旧（壳迁移+per-tenant 注入回归）；`?nostore` 打开照常能画能导出
  （B2 窄 Port 不改运行时）。**下一片 = C8**（SoftGl2Port + MCP + 测试分级；`gl` 裸口收编 + arena
  归 Port 接口同批设计）。
- **C8 第一棒 ✅ v0.8.39（2026-08-10）——动词面收编（`gl` 裸口清零）+ arena 归 Port**：
  ①**契约**（`src/common/gl2-port.ts`）：`gl` 裸口与 quadVAO 删除——绘制只剩两个动词
  `draw`/`drawInstanced`（按名 shader 画单位 quad；spec 自带 target/viewport/clear/scissor/
  blend/uniforms/textures，无 ambient 状态）+ `readPixels`/`clearFBO` + 纹理三动词
  （`createTexture`/`uploadTexture` rgba8|rgba16f|r8|r32f/`deleteTexture`）+ `createTileArena`。
  全句柄不透明（PooledFBO 的 fbo/tex 字段收进实现体；SoftGl2Port 自造同形对象的前提）。
  契约细则：mat3 一律 row-major（实现体自转置）、bool→int、未声明 uniform 静默跳过
  （null-location 语义，调用方可无条件传全量）、sampler 单元按声明序归实现体+未提供绑占位
  （「未绑 sampler 落单元 0 与 sampler2DArray 冲突 0x502」经典 quirk 收进壳）、blend 枚举封闭
  三态（none/premult-over/max-alpha）。②**BrowserGl2Port**：link 时 getActiveUniform 反射
  （uniform 类型分派表 + sampler 固定单元）、port 持 instanced VAO（loc0 quad+loc1 vec4/实例）、
  `BrowserTileArena`（原 GLGpuTileBackend 翻入壳；copySlice 收显式源 FBO 参数——ambient
  READ_FRAMEBUFFER 拔除）。③**消费面清零**：gl-compositor/gl-stamp/gl-room/gpu-tile-pool/
  raster-service/render-tree 零 `gl.*`；GLStampRasterizer 只剩 shader 源+实例打包+两个 spec；
  IndexTexture 走 r32f 纹理动词；pass 手工 placeholder/单元编号整删；GlRoom.backend →
  GlRoom.arena（Gl2TileArena，池记账 GpuTilePool 结构面不变，fake backend 只改 copySlice 签名）；
  render-tree present 的 void clear 并进 draw spec。④smoke harness + reference-gl-compositor
  同步迁移（纹理助手/readback 走动词；harness 屏幕读回/getError/readSliceRaw 留 BrowserGl2Port
  具体类 `gl`——壳侧合法，契约面摸不到）。验收：tsc 0、**1225 绿**、build 五 lint 全过、
  GL smoke PASSED（行为不变纯收编，golden 未移位、no GL error）。无新真机锚（对比锚 =
  真机批既有全流程绘画条目）。
- **C8 第二棒 ✅ v0.8.40（2026-08-10）——SoftGl2Port + shader CPU 对表**：
  ①`src/backend/soft-shaders.ts` = CPU 对表（ADR-0009 决定 5）：composite 全变体（12 blend ×
  tiled/group/overlay × overlay blendMode——逐行镜像 compositeFragSource，含 erase/lockAlpha/
  selMask/clip 双模/sampleTiled）、stamp-accum（instanced 光栅语义：像素中心落实例 quad 内）、
  stamp-color、warp/warpbake（bilinear/bicubic 反振铃限幅/spline B 样条全采样器族镜像
  WARP_FUNCS）、checker、present；**GPU_ONLY 显式登记**（present-affine 屏显专属）；未登记名
  → program() 响亮 throw `SHADER_NO_CPU_EQUIV`（对表纪律结构化——新 shader 溜不进来）。
  ②`src/backend/soft-gl2-port.ts` = Gl2Port 全动词纯软实现：**u8 目标逐写量化**（GPU
  blend→store 同步语义——wash/buildup 逐 dab 量化次序逐位对齐）、三态 blend/scissor/clear、
  软 arena、FBO 池借还 stale 语义同 GPU、决定论（无时钟无随机；f16 舍入/光栅 tie-break 不复刻，
  golden ±ε 吸收）。target:"screen" 软域响亮 throw（headless 无屏，present 走 FBO+readPixels）。
  ③blend 枚举+W3C 公式 CPU 版抽 `src/common/blend-modes.ts`（GLSL 版留 blend-glsl 并
  re-export；双实现同步纪律入注，锚 = smoke 2D-vs-GL diff + soft 对拍）。④**milestone：真消费
  类无 GL 跑通**——GLStampRasterizer/GLCompositor/GlRoom/RasterService 拿 SoftGl2Port 在 node
  完成栅格/合成/**bakeStamps 笔迹烤定全链**（+14 锚：对表 throw/round-trip/wash·buildup·椭圆·
  scissor 逐位 ±1/四 blend 模式 vs W3C ±1/烤定预乘域 ±4+selMask 裁剪）。验收：tsc 0、
  **1239 绿**、build 五 lint、GL smoke PASSED。无新真机锚（软域不进用户路径）。
  ~~**C8 剩余（接力）**：③backend stroke/filter 档口接通~~（↓ v0.8.41 stroke 档已接；filter 档
  + ④MCP + ⑤测试分级 + ⑥arena 记账仍开放）。
- **C8 第三棒 ✅ v0.8.41（2026-08-10）——栅格域归 backend + stroke 档口接通**：
  ①**搬家（tsc 审计，行为不变）**：gl 消费链 9 文件 + render-plan 迁 `src/backend/gl/`（提案 §1
  「backend = Gl2Port 消费侧」的物理达成；src/gl、src/render 目录消灭）；gl-board.ts 迁
  `src/shell/`（屏显 facade，与 browser-gl2-port 同域）；brush.ts、stroke-session.ts 迁
  `src/backend/`（stroke-session 的引擎 import 换结构面 `StrokeEngine` 接口——backend 不点名
  具体引擎类，filter-brush 三参 extendStroke 可赋四参位）；ResolvedBrush 类型+resolveBrush 纯函数
  拆 `src/common/resolved-brush.ts`（提案 §1 点名 common 住户；src/resolved-brush.ts 只剩 Vue
  装配 makeCurrentBrush + re-export 保存量路径）；current-brush-config.ts 迁 common；
  SMOOTH_DEFAULTS 抽 `src/common/smooth-defaults.ts`（smooth-config 留运行时可变副本+prefs）。
  ②**stroke 档口真实现**（webpaint-backend.ts）：inject 收 `gl?: Gl2Port` 缺省懒建 SoftGl2Port
  （闲置 backend 零付费；GlRoom 预算同壳 256MB）；strokeBegin = 快照钉细（扁平 ResolvedBrush
  字段 + 可选 mode:"brush"|"erase"，缺字段 DEFAULT_CONFIG 兜底）+ StrokeSession 进程内升格
  （deps = input._strokeDeps 的 headless 化身：commitStamps 走本 backend RasterService.bakeStamps
  ——board._overlayInputFrom 语义一字不动含 selMask/lockAlpha/erase/Π-outer；invalidate/setShadow
  无屏 no-op）；**引擎 beginStroke 迟到首点**（strokeBegin 无坐标，首个 append 点才 begin）；
  平滑推导 = _resolveSmooth 的 backend 版（SMOOTH_DEFAULTS 常数、deadzone 单位 doc px、scale≡1）；
  strokeEnd 计步经 History onChange rev 计数（no-op 不 push → false）。③**undo/redo 门口令牌墙**：
  open stroke 期间 backend.undo/redo **必须在门口 throw**——放行到 History 的话 workpiece
  beforeApply 的 throw 会被当 swap 中途失败走**不可恢复协议弃整栈**（本棒实测抓获，两层防线
  在 backend 面的实体即此门）。④提案 §3 注入清单回写（gl 已收；clock/uuid 实勘无需求：backend
  无时钟无随机=ADR-0009 决定论构成部分）。验收：tsc 0、**1247 绿**（+8：一笔一步 undo/redo 逐位
  /no-op/cancel 无痕/单令牌墙三拒/决定论两 backend 逐字节同图/pixelMode livesync/erase）、
  build 五 lint 全过、GL smoke PASSED（搬家后全链重验）。无新真机锚（档口不进浏览器用户路径；
  壳仍走 input.ts→StrokeSession 同一实现）。~~**C8 剩余（接力）**：③b filter 档~~（↓ v0.8.42
  已接；④MCP + ⑤测试分级 + ⑥arena 记账仍开放）。
- **C8 第四棒 ✅ v0.8.42（2026-08-10）——filter 档口接通 + kernel 域析出**：
  ①**纯度实勘**（handoff 点名的前置勘探）：六个 region filter（hsb/colorBalance/curves/mosaic/
  halftone/stainedGlass）bake 全是纯 typed-array 函数、零 DOM 零随机（stainedGlass 抖动 =
  确定性 hash，ADR-0009 天然满足）；DOM 只在 buildBody/注册面——filters.ts 本体（registry+
  DOM helper+color-brush 行为）**不迁**，只析计算面。②**kernel 域落 `src/backend/filters/`**：
  kernel.ts（FilterKernel 契约 + FilterParams/clamp8 SSoT）+ hsb-kernel/color-balance-kernel/
  curves-kernel（buildCurveLut 导出——UI 画曲线与 bake 同一条 LUT）/stylize-kernels + index.ts
  注册清单（静态封闭集 6 个，未注册 id 响亮 throw，同 shader 对表纪律）；plugins/ 四文件改
  UI 面委托 kernel（`static bake = XKernel.bake`，行为字节不变）；液化/锐化模糊 brush-only
  不入册（走 filter-brush/stroke 流）。③**档口真实现**（webpaint-backend.ts）：begin =
  getFilterKernel + 叶解析（组/缺叶/空层响亮 throw）+ `wp2.begin("adjust")` 挂令牌 + 冻结源
  `leaf.pixels.getRegion(bbox)` + 选区 materializeMaskRegion 物化；setParams = 参数合并到
  defaults 底座（MCP 传部分参数即完整集）+ 从冻结源纯函数重 bake（**不累积**）；commit =
  applyRegionDiff 逐 tile memcmp 落层一步（identity → 零扣押 → false 不占步）；cancel =
  token.cancel 无痕（真层零写）。单令牌墙扩双档：stroke/filter 互斥 + 开着期间 undo/redo
  门口 throw + dispose interrupt=cancel 两档都收。验收：tsc 0、**1255 绿**（+8：响亮拒绝/
  参考 bake 逐位+undo/redo/重算不累积/identity 不占步+cancel 无痕/单令牌墙双向/选区 mask
  逐位/kernel 清单+defaults JSON-able/dispose 收口）、build 五 lint 全过、GL smoke PASSED。
  无新真机锚（档口不进浏览器用户路径；adjust 面板走原 surrogate 流未动，kernel 委托字节
  逐位同旧）。~~**C8 剩余（接力）**：④MCP~~（↓ v0.8.43 已接；⑤测试分级 + ⑥arena 记账仍开放）。
- **C8 第五棒 ✅ v0.8.43（2026-08-10）——MCP server + 红队 + crop verb**：
  ①**crop 进接口**（C8 验收点名 create/draw/**crop**/undo/redo/export；§6.3 其余 doc 几何 verbs
  仍留白）：`crop(x,y,w,h)` = doc-ops runDocTransform 的 headless 同构——同一批 substrate verbs
  （resizeAllLeaves exchange / 树 setTreeProp / 选区 croppedTo pre-applied / persp remap VP 平移），
  UI 随行（viewport/fitToScreen）是壳 step.hint headless 不存在；负向扩张 v127 语义、1..8192。
  ②**MCP server 落 `scripts/mcp-server.mjs`**（`npm run mcp`）：手搓 stdio newline-delimited
  JSON-RPC 2.0（家规 vendor 一切——MCP SDK 不进 repo），tool 清单 = 接口文件机械翻译（提案 §3
  「同一把刀」）：生命周期 create/open_file/dispose + 读面 + 层结构 9 verbs + crop + undo/redo +
  stroke 档四连调 + `draw` 便捷一笔 + filter 档四连调 + `filter_list` + export_image/encode_ora
  （base64 或 path 落盘）。栅格/合成 = server 级 SoftGl2Port 注入（gl + compositorBytes 同一软域
  ——「SoftGl2Port 兜底也能跑（MCP server 成立）」达成；C7 全局接缝缺省语义不动，「无 GL 响亮失败」
  锚照旧）。node 侧两个补件：ImageData 最小 shim（ora encode 面拿它当字节容器——encode 面改纯
  bytes 读口是 canvas 债余账）+ ensureZipLoaded（复用 test/zip-node.mjs 装载器）。后端 throw →
  tool isError + 原文案（响亮拒绝穿墙而出，server 本体不死）。③**红队 `test/mcp-redteam.test.mjs`**
  （spawn 真子进程走真 stdio，非进程内假打）：握手/验收动词在册；全流程 create→draw 斜线→圆
  （stroke 三连调）→crop→undo/redo→filter→export png 魔数→ora PK 魔数；**决定论穿墙**（同指令
  序列两次 → export base64 逐字符同，ADR-0009 过 MCP 面仍成立）；敌意输入 server 不死（未知
  tool/坏 JSON 行/坏 stride/非法 crop/无文档就画/令牌墙 undo·第二 begin·错 id → 全 isError 后
  继续服务）。验收：tsc 0、**1256 绿**（+1 红队全景锚）、build 五 lint、GL smoke PASSED。
  无新真机锚（MCP 不进浏览器路径）。**观察记录**：套件里 tile-pool FR 泄漏警告 ~4 条（GC 时机
  漂移、不计失败）在 v0.8.41 基线已存在，非本批引入——测试 rig 释放卫生的既有噪音，待清账。
  ~~**C8 剩余（接力）**：⑤测试分级~~（↓ v0.8.44 前半已落；三方 golden + ⑥ 仍开放）。
- **C8 第六棒 ✅ v0.8.44（2026-08-10）——测试分级前半 + 全量画作 round-trip + mock multiplayer**：
  ①**分级骨架**：`npm run test:full` = 快层(run.mjs) + 全量层(`test/run-full.mjs` 显式注册) +
  GL smoke 三段链；快层开发期快捷 = **`TEST_FILTER=<子串> npm test`**（runner.run() 过滤器——
  §0「中间棒可只跑相关模块+tsc」的实体；只是过滤器不是分层，交付验收仍全量）。
  ②**全量画作 round-trip**（`full-painting-roundtrip.test.mjs`）：结构丰富画作（4 叶+嵌套组+
  属性全谱 mode/opacity/clipping/lockAlpha/visible + 6 笔含 pixelMode/erase + hsb/stainedGlass
  filter + 负向扩张 crop）→ encodeOra→open→encodeOra **逐字节** + 两代 exportImage 逐字节
  （SoftGl2 全域注入 = MCP server 同款）+ 构建路径决定论（同脚本两次→同 ora 字节）。
  两条实勘语义记录：backgroundColor 不进 .ora（既有语义，bg 归壳 sidecar——对比剔除）；
  lockAlpha 空层落不了笔（行为正确，剧本须先画后锁）。
  ③**mock multiplayer**（`full-mock-multiplayer.test.mjs`）：**两 backend 共享同一 SoftGl2Port**
  ——交错作画（A open stroke 期间 B 整笔/B undo 穿插 A filter 事务）后各租户字节 = 各自 solo
  参考**逐位**（共享 Port 不串台）；令牌墙 per-backend（跨租户互斥结构上不存在——接口 wire
  裁定的实测）；dispose A 后 B 照画照导出（退租不拖累邻居）。**⑥ 要的「第二真租户」自此存在**。
  ④顺手：run-full/mcp-server 补 DOMParser shim（open .ora 的 parseStackXml；xml-shim 复用）。
  验收：tsc 0、快层 **1256 绿** + 全量层 3 绿 + TEST_FILTER 快捷验证（8/1256）、build 五 lint、
  GL smoke PASSED。无新真机锚（纯测试面）。**C8 剩余（接力）**：⑤后半 = 三方 golden ±ε
  （gl-smoke harness.ts 注入 SoftGl2 第三比较器——SoftGl2 是纯 TS 可进浏览器页与 GL/2D ref
  同页对拍；SwiftShader 在 CI/WSL、真 GPU 在 user 真机同一套锚）+ ⑥arena 租户配额记账
  （mock multiplayer 已备好第二真租户；Gl2Port.createTileArena 的配额/退租接口 + backend
  dispose 释放 _room arena——SoftGl2 靠 GC、真 GPU 要显式 free）。
- **backgroundColor 全量删除 ✅ v0.8.45（2026-08-10）**：v0.8.44 全量 round-trip 测试暴露
  「bg 不进 .ora、round-trip 静默回白」的契约缺口，上呈后 **user 拍板：「和ora对齐，全量删
  background color，没有底色图层就是透明」**。落地：①数据模型剔字段——TreeJson/PaintingData/
  PaintingView getter/BackendDocInfo/blank() meta/setTreeProp 联合型全删（考古：app 从无设置
  入口，board 注释「一期固定白」，全仓写入点全是硬编码 #ffffff——字段从未活过）；②壳侧四个
  消费点改**显示/压底常量白**：board docBg（棋盘开关照旧看透明）、吸色压底（input.ts）、JPG
  导出白底直下（session.ts，PNG 本就保透明 v134 锚不动）、参考窗底（reference.ts）——屏显
  与导出行为逐像素不变；③MCP create 工具剔参数；④测试更新：layer-tree-json 驱逐锚换
  referenceLayerId（同为 doc 级 unique 树 prop，锚语义不变）、round-trip docInfo 恢复全字段
  对比（缺口闭环：字段没了自然不再丢）。验收：tsc 0、快层 1256 绿 + 全量层 3 绿、build 五
  lint、GL smoke PASSED、MCP server 冒烟 OK。无新真机锚（行为逐像素不变；棋盘/导出既有
  真机锚覆盖）。
- **C8 完 ✅ v0.8.46（2026-08-10）——⑤后半三方 golden + ⑥arena 租户记账**：
  ①**三方 golden（gl-smoke harness `softTripartite`）**：SoftGl2Port 纯 TS 进浏览器页，与真 GPU
  （SwiftShader/CI，真机同一套锚）+ 2D/解析参照**同页同场景**对拍——stamp 栅格（wash/buildup/
  椭圆，GL↔Soft ±1）、合成 blend 五模式（u8 显示精度，Soft↔Canvas2D 过 tolFor、GL↔Soft ≤1）、
  **bakeStamps 笔迹烤定全链**（RasterService/GlRoom 双 Port 同源 LayerPixels，落层字节 GL↔Soft
  ≤2——MCP/headless 栅格域与真机 GPU 等价性的主锚）。②**arena 租户记账**：`Gl2Port.arenaStats`
  （活 arena 数+Σ承诺字节）+ `Gl2TileArena.dispose` 退租语义（幂等；退租后动词响亮 throw
  `ARENA_DISPOSED`——Browser 版 bind null 静默 no-op 比 throw 危险，门口挡）；配额裁决不进 Port
  （各租户 GpuTilePool reserve 已自限），只记账。退租链 `WebPaintBackend.dispose → GlRoom.dispose`
  （新方法：arena+IndexTexture+pseudo 纹理逐个还 Port；**共享 FBO 池不清**——跨租户公共钱包；
  借出 FBO 先归还）。提案 §2 已回写（C8 第七棒节）。③mock multiplayer 补 dispose 记账断言
  （A 退租 count 2→1、bytes 递减、全员退租归零）；soft-gl2-port.test 补两锚（记账/退租/用死租约
  throw + GlRoom.dispose 不清共享池）；harness 补 `arenaAccounting`（真 GL 面同锚）。
  ④环境注：worktree 里 `tools/esbuild/esbuild` 是 gitignored 本机件，smoke 前要从主 checkout 拷。
  验收：tsc 0、快层 **1258 绿**（+2）+ 全量层 3 绿、build 五 lint 全过、GL smoke PASSED（+21 锚：
  tri 18 + arena 3）。无新真机锚（软域/记账不进用户路径；真机批既有全流程条目覆盖）。
  **C8 清账完毕。下一片 = C9 reference window 组件**（家族 web component 约定试点；§1 C9 行）。
