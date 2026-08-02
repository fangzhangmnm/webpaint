# ADR-0004：填色 = 选区的消费视图（fill-mode 取代油漆桶，supersede v0.5 #22 拍板）

> created 20260724
> 状态：**已决定 —— v0.5.11 落地**

## 背景

v0.5.2（#22）按当时拍板做了独立油漆桶工具，其 spec 有三条红线：①不产生、不修改
doc.selection；②被现有选区裁剪（flood ∩ selection）；③配置（threshold/expand）跟文件走
`editorState.bucket`，与魔棒的 `editorState.magicWand` **分开**。

2026-07-24 user 本人推翻该设计（journal `20260723 v0.5 batch requests.md` #50 行 +
当日对话多轮辩论）：油漆桶不做单独 icon，改成选区的一个模式（自动填色），预览随选区增减而变，
commit 时才落图层；阈值/自动扩张回归魔棒属性。

## 决定

1. **填色降级为 doc.selection 的消费视图**：choke point = 选区。任何选区生产者
   （魔棒/套索/矩形/椭圆/未来 AI 分割）自动获得填色能力。fill-mode 零 flood 知识。
2. **只 preview 不逐步落文档**（user 自证：逐步 commit 后减选区拿不到原像素；另有半透明
   二次叠色不幂等、undo 配额 churn、autosave 落半成品三刀）。选区编辑照常上 undo 栈。
3. **✓ = 选区的 commit**：填色落层 + 清选区，compound 封一个 undo 整点。
4. **机制参考笔刷**（journal `20260721 v0.4 Architecture Plan.md` L81「commit 和 live 可以用
   同一个 shader，ssot」）：预览与 commit 共用 overlay 槽与合成 shader（`FillOverlayInput` =
   1×1 填色纹理拉伸到选区 bbox × selMask，走 pseudoLayer「不同渲染模式」预留的路）。
   否决过的两个候选：surrogate layer（输在每次选区编辑整层物化+整层纹理上传）、
   CPU fillOnLayer + golden test 钉等价（弱于同 shader SSoT）。
5. **填色尊重 lockAlpha**（user：「填色当然尊重alpha lock」）——与旧 CPU fillOnLayer
   无视锁α不同，是有意行为变更；预览=commit 同参数。吸管在预览中吸预览色（拍板#8 同款）。
6. **配置归位**：threshold 进 `editorState.magicWand`；`editorState.bucket` 删除
   （旧 doc 的 stale 键被 mergeInto 静默忽略）。fill 开关 = `editorState.fillMode.on`
   （per-doc，与其他 toolstate 一视同仁）；**选区不持久化**（user：「选区不进更简单，我更喜欢这样」）
   → 重开文档开关还在、选区重选、预览不复活。
7. 键位：G = 套索+魔棒子工具+填充模式开（一键油漆桶工作流）；L = 套索且填充模式关。
   切走工具/退出模式 = 丢弃预览（interrupt=cancel）。lassoFillBtn（一次性填色）保留。

## 修订记录

- **v0.5.12-15（补账）**：fill 升第一类工具（editorState.fillMode.on 删除，工具身份即模式）；
  出口语义修正——回套索=取消（选区保留）、切去其他工具=commit、✓=commit+清选区、
  文档关闭/切换=丢弃（interrupt=cancel 家规）。§7 的"切走工具=丢弃"就此作废。
- **v0.6.19 / 2026-07-28（user 拍板）**：**切去其他工具 = commit + 清选区**（原"选区保留"
  再修订——进其他工具不留选区，填完切笔要画画，蚂蚁线留着碍事；undo 兜底）。
  回套索出口不变（取消、选区保留）。
- **v0.6.24 / 2026-07-28 晚（user grill 拍板）「彻底不互通」+ fill 顶栏化**：
  - mental model = **两个不能互通的工具、实现共用一条 lasso 管线**。fill 升顶栏一等工具，
    与 lasso 收一个组槽（Row1 油漆桶 toggle 钮退役）；点=激活记忆成员、已激活再点=开组菜单。
  - **进 fill（从任何工具）= 清选区**（undo 兜底）；**切去任何工具（含回 lasso）= commit+清**
    ——对称无特例（v0.5.15「回套索保留选区」与 v0.6.19 的不对称 supersede）。
  - **per-tool 持久化**：editorState.lassoTool{ sub:"rect", setOp:"new" } / fillTool{ sub:"magic",
    setOp:"union" }（v0.5.16 共享 RAM 记忆 _selMem 作废；§7 的「G=魔棒」至此才是真的）。
  - 顺手修混淆审计硬伤：T/Ctrl+J 在 fill 给状态行说法不再静默；多边形会话在 fill 合法；
    fill 补 crosshair 光标；扩张 toggle 提回 Row1（magic 时显，fill 默认魔棒 ≈ 常显 cue）。
- **v0.6.19 / 2026-07-28 蚂蚁线（user 拍板）**：fill 模式下蚂蚁线可关——⋯菜单
  「蚂蚁线」toggle，**默认开**、持久化 `editorState.fillShowAnts`（per-doc desk，已获
  持久化同意）；**toggle 只存在于 fill 模式，非 fill 恒显示无开关**（预览色块本身是选区
  的更强可视化，赛璐璐涂色判色时边界噪音碍观察；正在拖拽的实时虚线另一路不受影响）。
- **v0.7.38 / 2026-08-01 「送入填色」one-shot 携入（user 拍板，本批 journal
  「you should be able to send the selection to color filling mode」）**：lasso ⋯ 菜单新增
  显式命令「送入填色」（`sendSelectionToFill()`，fill-mode.ts）——置一次性旗标后派
  `wp:settool`，进 fill 的钩子消费旗标、**该次不清选区**。这是 v0.6.24「彻底不互通」的
  **唯一 sanctioned 例外**，且只开单向口：出口语义（切走 = commit + 清选区）一字不动；
  旗标 one-shot（下次正常进 fill 照旧清）、走去非 fill 工具即作废。注意携入的选区在
  classic+union 下自动成为 flood 的墙（v0.7.23 stopMask，种子豁免救「框内起点」）。
  别把这条扩大成「进 fill 一律保留选区」——那是推翻 v0.6.24，需要 user 重新拍板。

## 后果

- 旧 #22 的三条红线全部作废，**别再引用它们当依据**；本 ADR 是 supersede 记录。
- bucket.ts 及全部接线已整删（严禁念旧原则：刚 vibe 出来的代码最值得被推翻）；
  唯一保留 vetted 的 `floodSelectFrom` 内核（归魔棒独有）。
- 像素正确性由 gl-smoke `fillParity` 钉（golden 对 CPU fillOnLayer / commit≡live /
  lockAlpha / 导出与缩略图不漏预览）。
- 顺手修（user pin）：idle autosave 经 `ctx.isMidOperation()` 让路，不打断
  笔画/浮层变换/transient/fill 预览；crash-safety flush（pagehide/blur）不受此门
  （数据安全词典序优先）。
