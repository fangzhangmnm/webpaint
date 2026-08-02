# v0.8 recon F · 插件化接缝评估（封建骑士）（易过期）

> as-of v0.8.0 / 2026-08-02
> 性质：Explore agent 勘探快照原样 dump + 拷问补充。file:line 会漂——信代码不信本文。
> ⚠ 本骑士与 **ADR-0001** 有正面张力，动工前必须先处理（见下）。
> 索引：`20260802-v08-recon-index-six-knights.md`

## 拷问补充

1. **ADR-0001 冲突的建议解法（未拍板）**：ADR-0001 否决的是 Op/Tool **注册表**，且原文预言「下次会再次建议收成 Op/Tool 注册表。别提」。勘探数据支持一个中间立场：shape-brush 的插件化瓶颈**不是**缺 registry（engine-registry/CAPS/toolToRole 表格登记只占 3 行），而是**四个横切面没有 per-feature 收纳单元**（toolbar 手工接线 / index.html 静态 markup / i18n 单表 / workbench-state 双块）——这四个都是 D 骑士的任务。即 **F 的割点在 D 身上，ADR-0001 可以不推翻**；要新立的是「contribution 单元自带 view/文案/持久化声明」。若最终仍要动 Tool 轴，需 human 显式推翻 ADR-0001。
2. **「插件自带文案」是未解题**：filter 插件 title 是插件文件里的中文硬字符串（绕开 i18n 换免改中心文件，代价=不被翻译）；i18n 单表「漏译=编译错」强保证 vs 插件自治正面冲突，F 开工前要裁决。
3. **共享数学不随插件删**：color-dist 被 lasso 魔棒共用的先例——插件依赖规则要为「共享底座」留位。
4. 越狱预警：AI 看到「拆插件」会直奔 Op/Tool 注册表（ADR-0001 明令别提）；core.core 空心化焦虑会诱导把 strokes/canvas-operations 全塞回 core——core 边界建议等 C 的 headless 契约稳定后再裁。

---

## 以下为勘探原文（2026-08-02）

### 1. ADR-0001 定了什么、还剩多少

ai-docs/adr/0001-contribution-plugin-boundary.md（accepted 2026-06-08）：
- **只承认两类 contribution 插件：Filter 和 Exporter**（:6）。Op（crop/flip/resize）和 Tool（brush/lasso 等）收注册表的提议被明确否决。
- 论证框架：操作 = 触发→pending→提交 三轴（:10）。提交轴已被 history command pattern 覆盖；pending 轴唯一需要状态机的形态已被 EditMode transient 覆盖（:13）；触发轴（菜单/按钮/快捷键位置）「刻意异构，不要抽象」（:14）。
- Tool 侧更强论断（:20）：可插的一半（liquify/锐化/模糊）已经是 filter 插件、走 filterBrush role「加新效果零 input.js 改动」；不可插的一半（新输入生命周期）= 教 input.js 新节律 = 核心手术，「不是插」。
- :30-32 预言了本次勘探：「下次会再次建议收成 Op/Tool 注册表。**别提**」——浅的是 bespoke UI，该抽成 view 模块，不是缺框架。

**遵守度：基本全在**。filters registry 活着（src/filters.ts:117 makeRegistry，src/plugins/ 7 个插件文件含 liquify），exporters registry 活着（src/exporters.ts:40，内建 png/jpg/ora/psd 都走 registerExporter :58-79），第三方口子 window.WebPaint.registerFilter/registerExporter 仍暴露（dev-console.ts:75）。20260530-filter-plugin-architecture.md 的契约（static id/title/modes/bake、自注册、菜单订阅 onFilterRegistered 动态渲）与代码一致（filters-adjust.ts:13,392）。**注意**：ADR-0001 立场与「把 shape-brush 做成可装卸插件」正面冲突——shape-brush 后来（ADR-0005）以「第四个 pixel-stroke 引擎」身份加进核心表格，代价见 §2。

### 2. 三个「准插件」耦合度抽查

**liquify——最接近骑士（≈4-5 文件可拔）**
本体：src/plugins/liquify.ts + liquify-engine.ts，经 barrel src/plugins/index.ts:16 一行 import 自注册。core 反向引用：app.ts:269,271,315、index.html:1025 **全是注释零真实接线**；els.ts/toolbar.ts 零引用。真实残留三处：① workbench-state.ts:192,332-333 editorState.liquify.{bleed,sample} 按插件名硬编码在 core 状态（filters-adjust.ts:275,277,349-352,370 读写；UI 渲染本身声明驱动——Filter.sampleModes/boundaryModes 声明才出下拉，「删 filter 即删 UI」filters-adjust.ts:356 自证）② resample.ts:13-18 中央 RESAMPLE_MODES 表里 "liquify" context 字符串 4 处 ③ edit-mode.ts:46 filterBrush CAPS 行是通用的不算专属。**今天删 liquify = 删 2 插件文件 + barrel 1 行 + 清 2 处残留 ≈ 4-5 文件。全仓最好的可 jettison 样板。**

**shape-brush——最深的封臣（≈16 文件）**
本体：src/shape-brush.ts（482 行）+ 卫星 shape-geometry.ts、pixel-conic.ts、perspective-frame.ts、persp-edit.ts。要删就得动：
1. input.ts——import（:28）、字段+构造（:331,366）、快捷键 S（:261-262）、engine union 断言（:895）、Shift 约束反转（:1401,1418）
2. pointer-route.ts:19 toolToRole case
3. engine-registry.ts:39 PIXEL_STROKE_SPECS 行
4. edit-mode.ts:48 CAPS 行
5. **toolbar.ts 27 处**：上下文工具栏接线（:768-843）、PANELS 映射（:642）、rack alias（:359-360）、persp provider（:894-899）、active 态（:108-136,181）
6. brush-rack-controller.ts:170-175 rack alias
7. workbench-state.ts:170,309-316 per-doc 持久化默认值 + 手写 getter 镜像两块 + persp 态（restoreShapePersp）
8. app.ts:267（viewportRot provider）、:220-222（undo 还原 persp）、:347（initPerspEdit）
9. board.ts:24-25,639 persp gizmo 绘制接缝（provider 注入式，算干净接缝但仍是 core 文件里的专属代码）
10. index.html:384 工具按钮 + :578-860 区间 36 处 shape 标记
11. i18n/strings.ts——tool.shapeBrush(:20)、sc.shapeBrush(:546) + **30 个 sb.* key**
12. persp-edit.ts:396 反向依赖 editMode.current() !== "shapeBrush"

公道地说：2/3/4 是每处一行的表格登记（ADR 设计如此），**重灾区 = toolbar 27 处手工接线 + index.html 静态 markup + i18n 30 key + workbench-state 双块**。

**color-names——中间态（≈6-8 文件，资产/部署链耦合）**
本体：src/color-name.ts（337 行）+ color-cluster.ts；color-dist.ts 是共享底座（lasso 魔棒也用 lasso.ts:25，**不可随插件删**）。反向引用：app.ts/toolbar.ts/els.ts 零直接引用（好）；消费者两个：explode-layers.ts:10（按颜色拆分 sheet，经 layers-panel.ts:40,495 挂载）、ui/color-wheel.ts:18（HEX 框色名搜索）。index.html:957（explode sheet markup）、:1410（色轮挂载点，通用）。i18n：strings.ts:186,203-205,211；词库显示名刻意不走 i18n（:212——category.label 随 colors.json 走，加词库零改码）。资产链：color-words.json 根目录 runtime fetch（color-name.ts:52）+ **deploy.yml 白名单**（:67——漏了静默 404，v0.7.33 踩过）。

### 3. 注册机制现状

| 机制 | 位置 | 性质 |
|---|---|---|
| makeRegistry 原语 | src/registry.ts:35 | 真注册表（Map+监听+列举），恰好 2 adapter：filter、exporter |
| Filter registry | filters.ts:117-135 | 运行时注册、菜单动态渲（filters-adjust.ts:392）、支持热替换 |
| Exporter registry | exporters.ts:40-54 | 同上，导出格式下拉 data-driven（export-import-menu.ts:162） |
| PIXEL_STROKE_SPECS | engine-registry.ts:33-40 | 冻结数据表非运行时注册——加引擎=改这文件 |
| toolToRole | pointer-route.ts:14-24 | 硬编码 switch |
| EditMode CAPS | edit-mode.ts:46-48 | 硬编码表 |
| 内置笔刷 | builtin-brushes.json（根目录 asset runtime fetch，brushes.ts 解析，deploy.yml:66 白名单） | 数据驱动，加笔刷零改码 |
| 菜单项 | index.html 静态 + topbar-menu.ts 手工接线 | 硬接线（唯二例外：filter 菜单、导出格式列表） |

结论：「效果类」有真注册表，「工具类」是编译期数据表，「菜单/UI」基本硬接线——与 ADR-0001 划界完全一致。

### 4. 横切依赖：加功能=改中心文件（四面全中）

1. **i18n**：单表 src/i18n/strings.ts，四语同居强制（漏译=编译错）。加形状笔=+32 key。**例外**：filter 插件 title 是插件内中文硬字符串（plugins/hsb.ts:24、liquify.ts:27,42-54），完全绕开 i18n——「插件如何带自己文案」未解。
2. **图标 sprite**：127 个 symbol 生成后内联 index.html（:75 头注 do not hand-edit）。加图标=重跑 extract-icons.py 改 index.html 生成段。
3. **快捷键**：input.ts 单一 SHORTCUTS 表（约 :190-300）。加工具键=改 input.ts。
4. **editor-state 持久化**：workbench-state.ts 双块手写——默认值 struct + getter/setter 镜像，加一个持久化旋钮改两块；且家族规则要求持久化结构改动先获人类同意。序列化本身泛型遍历，集中在这一个文件。

### 5. selection / transform / fill 依赖草图

```
tiles/* ← selection.ts（叶子，深模块，只依赖 tiles）        selection.ts:26-28
              ↑                ↑
   marching-ants.ts:13    lasso.ts:23 ──→ floating-transform.ts:29 ──→ workpiece/*, bspline, rotsprite
              ↑                ↑  └→ color-dist / lineart-oracle / doc
        board.ts:33-34    input.ts:26,44-45（+ sel-pen）
                               ↑
selection-ops.ts:9 ──→ selection/doc/session ─┐
selection-ops.ts:13 ──→ toolbar.ts  ⚠ 域操作反向 import UI
fill-mode.ts:25 ──→ color-panel.ts(setColor)  ⚠ 侧向进 UI
toolbar.ts:13,14,21 ──→ selection / lasso(MAGIC_ALGORITHMS) / fill-mode
app.ts:53-54 ──→ selection-ops / fill-mode
```

- 无 import 环（toolbar→fill-mode、selection-ops→toolbar 单向不闭环），整体 DAG。selection.ts 干净叶子；floating-transform 不 import selection（lasso 当组合根接线 lasso.ts:29）。
- 两条逆向杂质边：selection-ops.ts:13 → toolbar 的 updateLassoToolbar、fill-mode.ts:25 → color-panel——若进 core 该翻转（事件/回调注入）。
- toolbar.ts（1242 行）是事实中枢 hub——所有工具上下文工具栏接线住这里，shape-brush 27 处耦合的宿主，任何「工具插件化」首先要肢解的对象（正对应 ADR-0001:32「该抽成各自的 view 模块」）。

### 总评：离「封建骑士」多远

- **filter 家族已经是骑士**（自注册、菜单自动出现、删文件即卸载）。
- **color-names 半骑士**（代码侧 2 消费点 core 零引用；asset+deploy 白名单+i18n 少量钉子）。
- **shape-brush 完全的世袭封臣**（≈16 文件），演示了「新输入生命周期」类功能的真实价格——正如 ADR-0001 预言：瓶颈不是缺 Tool registry（表格 3 行），而是 toolbar 手工接线 / index.html markup / i18n 单表 / workbench-state 双块四横切面没有 per-feature 收纳单元。「封建骑士」推进的割点在这四处（每 feature 一个 view/contribution 模块自带 markup/文案/持久化声明），不是再提 Op/Tool 注册表（重提前需人类推翻 ADR-0001）。
