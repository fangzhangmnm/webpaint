# 不为文档操作（crop/flip/resize）建 Op 插件注册表

**Status:** accepted（2026-06-08，candidate 2 grilling）

把 fx 的注册表接缝（filters.js）泛化时，曾提议把 crop / flip / resize 这类「文档操作」也收成一个 **Op 插件注册表**（见 docs/reports/20260608-ui-deepening-and-plugin-survey.html 候选 2）。**决定不做**——经论证，「Op」不是一个缺失的抽象，它已经被两道**正交的、已存在的深接缝**完整覆盖，再建框架是浅包装。

## 论证

每个「操作」拆三段：`触发(invocation) → [可选]待定交互(pending) → 提交(commit = 改 doc + 压 undo)`。

- **提交轴**：`history.js` 的 command pattern（`history.push({type})` + `registerHandler(type,{undo,redo})`）。领域无关，已有 14 种 op 共用（图层增删/合并/移动/改名/属性、描边、选区、**docTransform=crop/flip/resize**）。深、已做。
- **待定交互轴**：pending 恰好只有三种——**无**（一击：flip、裁到选区、图层操作）、**表单**（off-canvas 自模态：resize 的 W/H 弹窗）、**画布持续交互**（live preview + commit/cancel + ctrl-z=取消 + 跟画画冲突：crop-自由、transform gizmo、adjust 滤镜预览）。**只有第三种需要状态机，而那个状态机就是 EditMode 的 transient 系统**（`enterTransient(name,{apply,abort})` + canDraw 门 + ctrlZ 路由 + returnTool）。前两种是退化情形，套 transient 是纯开销。
- **触发轴**：菜单/按钮/右键/快捷键——浅且**刻意异构**（位置是编辑决策），不要抽象。

所以不存在「统一所有 UI 模式」的单一抽象：模式的差异恰好就在唯一重要的维度上（有没有跟画布冲突的待定相），而那一维已被 transient 捕获。

## 驳回的替代方案

统一命令框架 `Command = {id, label, ui: oneShot|form|canvas, commit}`：`canvas` 驱动无法通用（crop 8-handle ≠ transform gizmo ≠ adjust 预览，退化成 `enterTransient`+bespoke 回调 = 现状）；`oneShot` 驱动 = 一行；唯一有汁水的是 `form` 驱动（声明式表单），但全仓 form 弹窗只有 resize 一个（filter 自带 buildBody 是另一套）。为 1 个用户造声明式表单框架不划算。

## 落地

仅做一处微清理：`runDocTransform(label, applyFn)` 收口四处手抄的「before 快照→改 doc→after 快照→压 docTransform」提交信封，把「docTransform 必须是完整 undo 事务」从纪律变结构。无新框架。

## 给未来 fresh 勘探的提示

下次重新勘探会再次看到 crop/flip/resize 是「app.js 里几个浅 handler」，并很可能再次建议「收成 Op 注册表」。**别提**——浅的是那些 bespoke UI（crop overlay / resize dialog），它们该抽成各自消费 transient+undo 接缝的 view 模块（那是 candidate 1：UI 抽出），不是缺一个 Op 框架。
