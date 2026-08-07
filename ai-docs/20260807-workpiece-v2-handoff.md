# workpiece v2 施工 handoff（令牌+collector 纪元）
> as-of v0.8.8 / 2026-08-07。读者 = 接手施工的下一个 AI session。
> 拍板（why）= `ai-docs/adr/0008-workpiece-v2-token-collector.md`；目标契约（what）=
> `20260807-workpiece-v2-proposal-h.md`（**pin 住的接口**，形状改动要回写它）；本文 = how/施工序。
> 现状 .h = `api/`（`bash scripts/gen-api.sh` 重生成）。

## 0. 进场必读

- **前置悬案（比开工更优先）**：v0.8.1–7 + v0.8.8 已 merge 本地 main，**未 push origin、真机 14 条未跑**
  （清单 = `20260801-v08-epoch-handoff.md` §7 12 条 + §9 两条）。**建议序：先问 user 推 dev → 跑真机批
  → 再动 v2**。理由：v2 要拆 S2–S4 的脚手架，先让现状行为在真机上钉成锚，拆的时候才有对照。
- push 纪律照旧：新 session 第一批默认不 push；user 本 session 口头授权后可自动推 dev；prod 永远必问。
- 测试基线：1189 node 测试 + tsc 0 错 + `bash scripts/build.sh` 全 lint 过。
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
- 拆：operators.ts / undo-history.ts(旧) / write-gate.ts / doc-view.ts / pixel-tx.ts / selection-face.ts /
  layer-tree.ts(v1 门面) / workpiece.ts(v1)；workpiece2 收编正名。行为锚测试全部迁 v2 后才准删旧测试。
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
