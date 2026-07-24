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

## 后果

- 旧 #22 的三条红线全部作废，**别再引用它们当依据**；本 ADR 是 supersede 记录。
- bucket.ts 及全部接线已整删（严禁念旧原则：刚 vibe 出来的代码最值得被推翻）；
  唯一保留 vetted 的 `floodSelectFrom` 内核（归魔棒独有）。
- 像素正确性由 gl-smoke `fillParity` 钉（golden 对 CPU fillOnLayer / commit≡live /
  lockAlpha / 导出与缩略图不漏预览）。
- 顺手修（user pin）：idle autosave 经 `ctx.isMidOperation()` 让路，不打断
  笔画/浮层变换/transient/fill 预览；crash-safety flush（pagehide/blur）不受此门
  （数据安全词典序优先）。
