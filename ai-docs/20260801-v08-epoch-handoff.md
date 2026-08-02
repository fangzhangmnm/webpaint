# v0.8 重构纪元 handoff：workpiece 写面收权 + sidecar 分离
> as-of v0.8.0-2026-08-01（开版空壳）；施工进度见文末 §8（v0.8.1 S1 ✅ / v0.8.2 S2 ✅）
> 读者：接手 v0.8 的下一个 AI session。拍板记录 = `ai-docs/adr/0007-workpiece-undo-scope-and-sidecar.md`（why 在那里，本文是 how/施工序）。所有「user 拍板」出处 = 2026-08-01 session（import-破坏-undo 根因讨论）。

## 0. 现状快照（进场必读）

- **prod = main = v0.7.41**（2026-08-01 推的，含 v0.7.35–41 七批：undo 越狱止血 / GPU 驱逐修复 / transform 复位钮 / 从图层建选区+送 fill / 上下文钮 / 蚂蚁线 per-tool / 导入单整点）。
- ⚠ **v0.7.35–41 的真机验证清单还没跑**（12 条，见本文 §7）。v0.8 第一次真机批请合并执行。
- 止血只是止血：`import-image.ts` / `blender-sync.ts` 补了记账，但**接缝还敞着**——`ctx.doc` 仍是可变 `PaintDoc` 本体，忘记记账依旧零反馈。v0.8 的全部意义 = 让这类漏洞在结构上不可能。
- 测试基线：1161 node 测试 + tsc + gl-smoke 全绿。`test/undo-stack-integrity.test.mjs` 是本纪元的核心回归锚。
- ⚠ 教训（v0.7.35 踩过）：**`test/run.mjs` 是显式 import 清单不是 glob**——新建测试文件必须注册，否则静默不跑还以为绿。

## 1. 定案摘要（细节与原话见 ADR-0007）

1. **workpiece = undo system 的监管对象，全部作用域**。与「是否进 ora」无关。可撤销的都是 workpiece component（selection、floating 在内）。
2. **写面收权 = 门面式 + composition**：workpiece 聚合若干 component，每个 component 实现同一份「写即记账」契约；doc 退化为最薄聚合容器；**workpiece 构造时注入新创建的 undo system**（`new Workpiece(doc, history)`，capability 绑构造期）。
3. **DocView**：`ctx.doc` 换成手写只读窄接口 → 裸写 = 编译错。`Readonly<T>` 不冻方法，必须显式窄接口。
4. **①型 pre-apply 契约（先裸改后补账）整体退役** → tx 令牌（范本 = `src/workpiece/pixel-tx.ts`，像素路径原样保留）或收编为 component。「不记账」从默认态变成显式声明态。
5. **割3 dev 断言**：PaintDoc mutator 入口「不在 operator 锁内 ∧ 不持 tx 令牌 → throw」。预览令牌化之前开不了（会误报）。
6. **sidecar**（命名定案；workbench 被否 = editor app runtime 语义）= **跟 ora 走 ∧ 不进 undo** 的 doc 级状态。成员：参考图（side-windows）、editor-state.json、未来 timelapse。给它正名的 changed 通道，杀掉 `side-windows.ts` 里伪造 `wp:histchange` 的姿势。
7. **「doc mutation 必须走 undo」升为硬规则**，落本仓 CLAUDE.md——**在手术完成时写**（S6），别在还做不到的时候先立牌坊。
8. 割1（runAddLayer 信封）**永久跳过**——被门面取代。

## 2. 施工序（切片 = commit/版本粒度，v0.8.x 递增）

### S1 · 构造注入 + 结构类写面收进 workpiece
- `app.ts`：`new Workpiece(doc)` → `new Workpiece(doc, history)`（history 先建；`UndoHistory` 的 onChange/onApplied 闭包引用 board/renderLayersPanel，注意初始化顺序，必要时 late-bind 回调）。
- workpiece 长出**结构类写 API**（composition：建议先一个 `LayerTreeComponent`）：`addLayer(name?, fillFn?)`、`removeLayer`、`duplicateLayer`、`moveLayer`、`group/ungroup`、`mergeDown`、`setLayerProp`…内部 = mutate + 自动 `history.run(对应 op)`。args 组装（locateNode/prevActiveId 那套舞蹈）**下沉进 component**，调用点只剩意图。
- 改道现有调用点：`layers-panel.ts`（加/删/复制/移动/组操作）、`selection-ops.ts:52`、`import-image.ts`、`blender-sync.ts`、`explode-layers.ts`。v0.7.41 的「import 单整点」语义要保住（component API 需要 `{checkpoint:false}` 之类的透传，或提供 compound 括号）。
- 测试：undo-stack-integrity 全绿不动；每个改道点的既有测试（layers-panel 没测试——顺手补最小的）。

### S2 · 预览/①型退役 → tx 令牌
- 审计清单（7 个①型 operator：pixels / selection / layerProp(_initialOld) / fillColor / addLayer / treeStructure / docTransform）逐个定去向：改②型（forward 自己动手）或包进 component/tx。
- 裸写 `doc.selection` 的 live 预览点（合法但裸）：`lasso.ts:276,467,488,503`、`toolbar.ts:415,470`（扩缩预览）、`fill-mode.ts:86`、lineart 预览。做一个 `SelectionComponent`：`beginPreview() → 写 → commitEntry()/abort()`（形状同 pixel-tx）。
- `filters-adjust.ts:179`、`shape-brush.ts:161,335`、`layers-panel.ts:161`（删组补空层）同样归位。
- 像素路径（笔刷 → pixel-tx）**不动**。

### S3 · DocView 编译级收口
- 新文件 `src/workpiece/doc-view.ts`：手写只读接口（width/height/layers 遍历/activeLayer/locateNode/getImageData/snapshot 读族/selection 读…零 mutator）。
- `app-context.ts:103` `doc: PaintDoc` → `doc: DocView`。跑 `tsc --noEmit`——报错清单就是残余裸写点的**完备**枚举，逐个改道 S1/S2 的 API。
- 装载写（ora decode / newDoc 建独立 PaintDoc）不受影响——它们拿的是真 PaintDoc，挂进 workpiece 后才收权（「attach 即相变」）。
- 完成判据：`grep` 不再需要——编译器就是审计。

### S4 · 割3 dev 断言
- PaintDoc mutator 入口：`if (!lockHeld && !txOpen) throw`（dev 模式；prod 走 reportError warning 不炸用户）。S2 完成前开不了，开了就别再关。

### S5 · sidecar 落地
- 命名一律 **sidecar**；术语表（CONTEXT.md）拆死两个 "reference"：参考**层**指定（`referenceLayerId`，workpiece 侧，可撤销）≠ 参考**图**（sidecar 侧）。
- changed 通道：`wp:sidecarchange`（或 session.markSidecarDirty()——实现自选，语义 = 「合法不记账的 doc 级持久态改了」）。保存门（`topbar-menu.ts:88` 唯一编辑门）改听两个信号。
- 杀 `side-windows.ts:127` 伪造 `wp:histchange`；`session-state.ts:580` markEdited 注释同步改（它现在只剩参考窗一个正当用户）。
- ⚠ workbench-state 有「别把 dirty 标记加回来」的钉子（desk 语义长注释）——editor-state 这个 sidecar 成员**绕开**统一 dirty 通道还是回访那颗钉子，做之前想清楚写进 commit message。

### S6 · 硬规则落盘 + 文档收口
- 本仓 CLAUDE.md 加硬规则：「doc mutation 必须走 undo（workpiece 写面）；裸改 = 编译错+dev throw」。
- CONTEXT.md 更新 workpiece/sidecar 词条；ADR-0007 补「已实施」标记。

## 3. 已知地雷（施工时会踩的）

- `restoreTree` 不 dispose 消失层的 tile 句柄（`operators.ts:292-294` 已注明的已知取舍）——S1 动树 API 时别顺手"修"出双 dispose。
- `Selection` 所有权纪律（双 dispose throw）；`_applySelectionUpdate` 的中间产物就地释放约定（`lasso.ts:497`）。
- fill-mode 的出入口语义（ADR-0004 + 修订5 one-shot 携入）是 user 多轮拍板——S2 收编 fill 预览时一字不动。
- `wireSlotMenu` 三调用点 / 小三角语义 / v0.6.31 长按回滚——UI 层的既定判决别在重构中复活。
- blender `overwriteLeaf` 走 pixel-tx 是合规样板，别当裸写改。
- worktree 政策：改完必须 merge 回 main；`test/run.mjs` 手动注册新测试文件。

## 4. 版本与发布纪律

- v0.8.0 = 开版空壳（docs→ai-docs 改名 + 本 handoff）。手术切片从 **v0.8.1** 起每片一个 patch。
- 每片 ritual：`./bump.sh` → `npm test` + `npm run typecheck`（S3 起 tsc 就是主审计）→ commit 源 → `bash scripts/build.sh` → commit dist。
- push prod 永远先问 human（硬规则5）。

## 5. 悬而未决（接手先看）

1. **v0.7.35–41 真机清单未跑**（§7）。
2. reset 图标真图未入库（图标库 TODO.md 已登记 `reset-transform`，「回中」stopgap 顶位中；入库后重跑 extract+inline 收货）。
3. 图标库生成物（`assets/icons.svg`/`icons-catalog.md` 的 `finger` data-note）还写着旧 `docs/` 路径——SSoT 在图标库 `build.py`，宿主不手改生成物；下次图标库 session 顺手改。
4. 割2/S3 期间 `readDoc()`（现全库唯一调用点 floating-transform.ts:421）可能被 DocView 取代——收口时清理。

## 6. 参考文件速查

| 关注点 | 路径 |
|---|---|
| 拍板记录（why） | `ai-docs/adr/0007-workpiece-undo-scope-and-sidecar.md` |
| undo 栈 / 锁 / compound | `src/workpiece/undo-history.ts`、`src/workpiece/workpiece.ts` |
| operator 全家 + ①型清单 | `src/workpiece/operators.ts`、`src/workpiece/float-ops.ts` |
| tx 令牌范本 | `src/workpiece/pixel-tx.ts` |
| 信封先例（另一形态） | `src/doc-ops.ts` runDocTransform |
| 止血现场（S1 要改道的） | `src/import-image.ts`、`src/blender-sync.ts`、`src/selection-ops.ts`、`src/layers-panel.ts` |
| 回归锚 | `test/undo-stack-integrity.test.mjs`、`test/float-ops.test.mjs`、`test/undo-history.test.mjs` |
| sidecar 现场 | `src/side-windows.ts`、`src/workbench-state.ts`、`src/session-state.ts:580`、`src/topbar-menu.ts:88` |

## 7. 真机验证清单（v0.7.35–41 遗留，一次交付）

1. 导入大图→transform→commit→**一次 undo 整个导入消失**（v0.7.41 单整点）→redo 全回放，无红 banner。
2. 导入后移层/合并再跨树 undo/redo，历史存活。
3. Blender 拉贴图 undo/redo（无环境跳过）。
4. 显存压力下（大文档反复开关图层）缩放平移无 256px 串 tile。
5. doc A 导出单层→同尺寸 doc B 导入逐像素归位；更大居中；更小走 sheet。
6. 复位钮：任意缩放旋转后→原尺寸+居中+锐利，commit 与原像素一致；undo 一步回复位前。
7. 从图层建选区：普通层/空层提示/组与隐藏层拒绝；lasso 与 fill 两菜单入口。
8. 选区→送入填色：进 fill 保选区；classic+union 下选区当墙且选区内种子能填；退出再进照旧清（one-shot）。
9. fill 布尔单击 toggle（无菜单无三角，title 显当前态）；lasso 与其余 3 槽行为不变。
10. Row1 同槽互斥钮（无选区=全选/有选区=反选）；Ctrl+A / Ctrl+Shift+I；⋯ 菜单旧项消失。
11. 蚂蚁线：新 doc 双默认开；selection/fill 各自独立开关、per-doc 持久；老 doc fill 偏好回开（预期内已同意）。
12. i18n 抽查 en/ja/tok 新文案（复位/从图层建选区/送入填色）；水印 v0.8.0。

## 8. 施工进度（2026-08-02 session 追记）

### S1 ✅ v0.8.1：构造注入 + LayerTreeComponent
- `new Workpiece(doc, history)`（capability 绑构造期）；`workpiece.layers` = `src/workpiece/layer-tree.ts`
  （组合根装配自注册——值 import 会成 workpiece→layer-tree→operators→workpiece 环，operators 的
  extends 在 eval 期就要 DocumentOperator）。
- 门面 API：addLayer/duplicateLayer/removeLayer/deleteGroup/moveLayer/mergeDown/setLayerProp/
  setReferenceLayer/clearLayer + **treeTx 结构 tx 窗口**（mutate 拿可变 doc，前后 snapshotTree 自动入栈）。
  记账失败摘回新层（不留无账层）。改道：layers-panel / import-image / blender-sync / selection-ops /
  explode-layers。行为锁：`test/workpiece-layer-tree.test.mjs`。

### S2 ✅ v0.8.2：①型退役审计 + SelectionFace + PixelTx 归位
7 个①型 operator 逐个定去向（「不记账」已从默认态变成显式声明态）：

| operator | 去向 |
|---|---|
| pixels | pixel-tx 唯一形态（S2 新增：commit 透传 checkpoint + `dispose()` 弃快照不还原）。归位：filters-adjust("adjust")、toolbar 选区内清除("clearSel")、topbar 清空活动层("clearDoc")、selection-ops 挖洞("moveToLayer"，compound 内 checkpoint:false)。**保留原样（合规深模块编排）**：floating-transform（compound 内三处，本就贴 history API 的组件级模块）、fill-mode._doCommit（ADR-0004 出入口语义钉死，GL commitFill+handedOff 还原逻辑不换壳） |
| selection | 唯一入口 = `workpiece.sel`（`src/workpiece/selection-face.ts`）：commitPreApplied 记账口 + beginPreview 预览 tx（origin 保管/write 换预览就地 dispose/commit 无变化不占步/abort 无痕）。**LassoEngine 保持 entry 契约**（选区生产引擎，node 直测 magic-drag/polygon 等；组件化选区引擎留给 C 骑士 headless 分层）。toolbar 扩缩预览 = 预览 tx 第一个住户 |
| layerProp(_initialOld) | 透明度 slider 经 `workpiece.layers.setLayerProp({initialOld})`（S1 已收） |
| fillColor | 留 fill-mode 编排（desk 态经注入钩子；防抖合并/回灌抑制是 ADR-0004 语义的一部分） |
| addLayer | S1 门面「创建即记账」，首跑 pre-apply 语义消失 |
| treeStructure | S1 treeTx 唯一入口（layers-panel 组操作/explode/stampAll 全走它） |
| docTransform | `doc-ops.runDocTransform` 共同脊柱**就是** tx 信封（before/after snapshotAll + 压栈唯一入口）；S4 的令牌在此处拿 |

- 语义副作用（有意，v0.6.17 no-op 家族）：选区内清除/清空活动层/挖洞若实际未改像素 → 不占 undo 步。
- 行为锁：`test/selection-face.test.mjs`。

### S3 ✅ v0.8.3：DocView 编译级收口
- `src/workpiece/doc-view.ts`：手写只读窄接口（字段全 readonly、layers=ReadonlyArray、零 mutator；
  类型经 `PaintDoc[...]` 索引取，源变自动跟）。`AppContext.doc: DocView`——裸写 = 编译错。
- 新增 `AppContext.docRaw: PaintDoc`：**声明写者名单**（仅二）——session-state（装载/换文档生命周期）、
  doc-ops（runDocTransform tx 信封）。引擎单例（input/lasso/board/floating-transform）经构造注入
  拿真 PaintDoc，不走 ctx。用 docRaw 绕 DocView = 越狱（S4 dev 断言是第二道网）。
- 焦点写显式化：`LayerTree.setActive(id)`（不入 undo，现状保持——点选活动层不占 undo 步）；
  topbar 清空活动层改走 `workpiece.layers.clearLayer`。
- 读者签名放宽（PaintDoc→DocView / Node[]→readonly）：exporters.encode、session.renderDocToImageBlob/
  copyImageToClipboard、psd、reference.setLiveSource/toggleLive、doc-render/board 合成面、
  doc.ts 树读 helper（eachLeaf/flattenLeaves/findNodeById/countLeaves）、OraDoc/EncodeDoc.layers。
- `readDoc()` 留作 workpiece 的引擎级只读 escape（floating-transform 两处消费；返回 Readonly，无写险）。
