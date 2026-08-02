# ADR-0007 · workpiece = undo 作用域；sidecar 分离；写面收权（v0.8 纪元 spec）
> created 20260801
> 状态：已拍板（user，2026-08-01 session，import-破坏-undo 根因讨论）。v0.7.35 只做止血；本 ADR 是 v0.8.0 重构纪元的开工 spec。
> **已实施**（v0.8.1–v0.8.6，2026-08-02）：S1 构造注入+LayerTree / S2 ①型退役+SelectionFace+PixelTx / S3 DocView 编译收口 / S4 write-gate 割3 / S5 wp:sidecarchange / S6 硬规则落 CLAUDE.md。施工记录见 `ai-docs/20260801-v08-epoch-handoff.md` §8。

## 背景（为什么）

「import layer breaks history」审计定性为**接缝漏洞**而非孤立 bug：

- `PaintDoc` 约 40 个 mutator 全公开，同一可变实例经 `ctx.doc` 发给 ~20 个模块；`workpiece.ts` 头注释声称的「写 doc 唯一合法路径 = UndoHistory.run」在组合根（app.ts）被一手作废（`readDoc()` 全库仅 1 个调用点）。
- 合规与越狱只差一行、零反馈：漏掉 `history.run(ops.addLayer)` 编译过、测试绿、运行不报错。
- 越狱已复制传播：blender-sync 抄走 import 的裸加层并把它写成注释里的既定语义。
- 0.4 纪元 spec 白纸黑字「（importer）写也得通过 document-operator」，但「后续切片把 doc 可变方法下沉」没做完——新门建了，旧门没锁。

破坏机理（v0.7.35 的 `test/undo-stack-integrity.test.mjs` 病理测试钉着）：不记账的层被后续入栈的 liftFloat 引用 → undo 跨 treeStructure 时 restoreTree 按旧快照静默销毁该层（丢画）→ redo 找不到层 → onUnrecoverable → 整栈被弃。

## 决策（user 拍板原话归纳，出处 = 2026-08-01 session）

1. **workpiece 的定义 = undo system 的监管对象，全部作用域。就这么简单。** 与「是否进 ora」无关。可撤销的都是 workpiece component（selection、floating 中间态在内）；「预览如果有需要进 undo 的，workpiece 里面加入对应的 component」。
2. **「doc mutation 必须走 undo」升为硬规则**（落 CLAUDE.md，v0.8 实施时）。
3. **写面收权 = 门面式 + composition**：写 API 收进 workpiece；workpiece 聚合若干 component（层树/selection/floating/pixels…），**每个内部数据结构实现同样的『写即记账』契约，doc 只是一个最薄聚合容器**。**workpiece 构建的时候注入新创建的 undo system**（capability 绑在构造期）。
4. **DocView**：`ctx.doc` 换成手写只读窄接口（`Readonly<T>` 不冻方法，必须显式窄接口）——裸写 = 编译错，tsc 自动枚举全部违规点。
5. **①型 pre-apply 契约（「先裸改、记得回来记账」）整体退役**：需要手势期直写的路径走 tx 令牌模式（现成范本 = `src/workpiece/pixel-tx.ts`，像素路径原样保留），或收编为 workpiece component。「不记账」从默认态变成显式声明态。
6. **割3 运行时兜底（user 同意）**：PaintDoc mutator 入口加 dev 断言「不在 operator 锁内且不持 tx 令牌 → throw」，待预览令牌化后开启（在此之前会误报①型，开不了）。
7. **sidecar（命名定案；workbench 被否——workbench 语义是 editor app runtime）**：= 跟 ora 走 ∧ 不进 undo history 的 doc 级状态。成员：参考图（side-windows）、editor-state.json、未来 timelapse。要给它正名的 changed 信号通道（保存门监听），杀掉 side-windows.ts 里伪造 `wp:histchange` 的姿势——那是「合法不记账却无合法标脏通道」逼出来的。
   - 术语地雷：参考**层**指定（`referenceLayerId`，可撤销，workpiece 侧）≠ 参考**图**（sidecar 侧）。文档/命名必须拆死这两个 "reference"。
8. **runAddLayer 信封（审计割1）不做**：会被门面手术整体取代，不做二次翻修。v0.7.35 止血只在 import-image / blender-sync 两处补 AddLayerRecordOp 记账。

## 纪元排法

0.7 止血 + 功能批 → 真机一验 → push prod（硬规则 #5 届时再确认）→ bump **v0.8.0** 按本 ADR 动手术。

## 后果

- v0.8 后新增任何 doc 写路径，忘记记账 = 编译错（DocView）+ dev throw（割3），不再依赖 code review。
- 22 个 import 类入口审计快照（2026-08-01）：真越狱仅 import-image（4 个同源入口）与 blender-sync 拉新层，均已 v0.7.35 止血；换 doc 类（新建/adopt/.ora）走清栈路径，正确；参考图按第 7 条归 sidecar。
