# contribution 插件的边界：不建 Op / Tool 插件注册表
> created 20260608

**Status:** accepted（2026-06-08，candidate 2 grilling）

把 fx 的注册表接缝（filters.js）泛化时，曾提议把 crop / flip / resize（**Op**）和 brush/eraser/picker/lasso（**Tool**）也收成插件注册表（见 docs/reports/20260608-ui-deepening-and-plugin-survey.html 候选 2）。**两者都决定不做**——经论证，它们不是缺失的抽象，已被既有深接缝覆盖；再建框架是浅包装。**真正做成 contribution 插件的只有 Exporter（已落地）；Filter 本就是。**

## 论证

每个「操作」拆三段：`触发(invocation) → [可选]待定交互(pending) → 提交(commit = 改 doc + 压 undo)`。

- **提交轴**：`history.js` 的 command pattern（`history.push({type})` + `registerHandler(type,{undo,redo})`）。领域无关，已有 14 种 op 共用（图层增删/合并/移动/改名/属性、描边、选区、**docTransform=crop/flip/resize**）。深、已做。
- **待定交互轴**：pending 恰好只有三种——**无**（一击：flip、裁到选区、图层操作）、**表单**（off-canvas 自模态：resize 的 W/H 弹窗）、**画布持续交互**（live preview + commit/cancel + ctrl-z=取消 + 跟画画冲突：crop-自由、transform gizmo、adjust 滤镜预览）。**只有第三种需要状态机，而那个状态机就是 EditMode 的 transient 系统**（`enterTransient(name,{apply,abort})` + canDraw 门 + ctrlZ 路由 + returnTool）。前两种是退化情形，套 transient 是纯开销。
- **触发轴**：菜单/按钮/右键/快捷键——浅且**刻意异构**（位置是编辑决策），不要抽象。

所以不存在「统一所有 UI 模式」的单一抽象：模式的差异恰好就在唯一重要的维度上（有没有跟画布冲突的待定相），而那一维已被 transient 捕获。

## Tool 同理（更强）

可插的那一半工具（liquify / 锐化 / 模糊 / 未来 stamp 类效果）**已经是插件**——走 filter 注册表 + `filterBrush` role，加新效果零 input.js 改动。不可插的那一半是深核：brush/eraser/smudge/airbrush 是**同一个 BrushEngine** 的 config/preset（不是独立工具单元）；lasso/选区/shapes 有 bespoke **输入生命周期**（path/gizmo/drag/hitTest 在 input.js），新生命周期 = 教 input.js 一套新节律 = 核心手术，不是「插」。tool dispatch 本身已高度表格化（`pointer-route` tool→role、`engine-registry` role→spec、`edit-mode` CAPS per-tool 能力），都测过。故 tool 注册表负价值。

## 驳回的替代方案

统一命令框架 `Command = {id, label, ui: oneShot|form|canvas, commit}`：`canvas` 驱动无法通用（crop 8-handle ≠ transform gizmo ≠ adjust 预览，退化成 `enterTransient`+bespoke 回调 = 现状）；`oneShot` 驱动 = 一行；唯一有汁水的是 `form` 驱动（声明式表单），但全仓 form 弹窗只有 resize 一个（filter 自带 buildBody 是另一套）。为 1 个用户造声明式表单框架不划算。

## 落地

仅做一处微清理：`runDocTransform(label, applyFn)` 收口四处手抄的「before 快照→改 doc→after 快照→压 docTransform」提交信封，把「docTransform 必须是完整 undo 事务」从纪律变结构。无新框架。

## 给未来 fresh 勘探的提示

下次重新勘探会再次看到 crop/flip/resize 是「app.js 里几个浅 handler」、tool 配置散在 app.js 多处，并很可能再次建议「收成 Op / Tool 注册表」。**别提**——浅的是那些 bespoke UI（crop overlay / resize dialog）和 per-tool rack 配置，它们该抽成各自消费 transient+undo 接缝的 view 模块（那是 candidate 1：UI 抽出），不是缺一个 Op/Tool 框架。
