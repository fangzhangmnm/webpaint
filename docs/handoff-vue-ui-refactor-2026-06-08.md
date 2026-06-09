# Handoff · WebPaint Vue / data-driven UI 重构（2026-06-08）

人类输入：停，这份文档可能存在误导，批判性地读。具体做vue地ai说这篇文档太想当然了

> 给即将做「app.js UI → data-driven 深模块 + 薄 Vue + TS」那个 agent。
> 读这份**之前**先读三份配套报告（别重新勘探，会被自己的幻觉带偏）：
> - `docs/reports/20260608-ui-deepening-and-plugin-survey.html` —— 5 个候选 + 接缝裁决
> - `docs/reports/20260608-appjs-anatomy-pie.html` —— 6705 行按职责/去向
> - `docs/reports/20260608-binding-nature-and-reactive-collapse.html` —— **本 handoff 的论证全文**
> 领域语言：`CONTEXT.md`（PaintDoc/Engine/Brushrack/ResolvedBrush/当前笔）。红线：`../20260601 MyPWAPatterns/docs/MASTER.md` §A。

## 0. 一句话警告（最重要，别跳过）

**绑定不会因为「套上 Vue」而消失，只会因为「SSoT 搬进响应式容器」而蒸发。**
如果你把 `updateSaveStatus()` / `refreshCurrentBrush()` / `applyToolState()` 这类命令式同步**搬进 Vue 的 `methods`**，你只是把 1055 行换了个地方写——**白干，还多一层 Vue 包装**。
赢的唯一形态：让 `toolStates / color / store.status` 变成 `ref/reactive`，绑定变成 `computed` + 模板插值，然后**删掉**那些手动同步函数。

## 1. 现状：机制已拆净，剩的是绑定壳

candidate 2（Exporter 注册表，`exporters.js`）和 candidate 3（ResolvedBrush，`resolved-brush.js`，`getBrushSettings:()=>_currentBrush` frozen）**已落地**。Store 机制（push-serialize/etag/.trash/编辑游标/busy/status）已在 `src/store/`，`app.js` 只读 `_store.busy/edits/cloud.status`。

**但 app.js 还是 6705 行，一行没少。** 因为它 ~65% 的本性是「绑定 + UI 构造」，抽深模块碰不到。实证：
- `app.js:409 refreshCurrentBrush()` / `:423 applyToolState()` / `:466 sliderPosToSize` / `:519 selectBrushPresetForTool` —— ResolvedBrush 值走了，slider DOM ⇄ dial ⇄ 派生值 ⇄ invalidate 的绑定全留着。
- `app.js:2745 computeSaveState()` 已经只读 `_store.*`（机制在 Store）；`:2755 updateSaveStatus()` 6 个 `else if` 把 status 映射成 `ICON_* innerHTML` + tooltip —— 纯绑定。

## 2. 该做什么（落地序，照报告的 Top recommendation）

机制已拆，**别再抽第 N 个深模块**——边际收益趋零。下一步杠杆 = **响应式 SSoT**：

1. **建响应式 SSoT 核**（小，手写或 Vue `reactive`，别上 Pinia 这种重物除非真需要）。
   把这些搬进响应式图：`toolStates`(per-tool dial) · `color` · `editMode.current()` · `_store.status`(派生) · gallery list/folder · 笔架列表 · panel 开合。
2. **派生变 computed**：`currentBrush = computed(()=>resolveBrush(...))` → 删 `refreshCurrentBrush()`。纯派生函数（resolveBrush / gallery-model / brush-rack-view）保持**纯**、node 可测，computed 只是调它。
3. **UI 退成薄 Vue**：slider = `v-model`、save 按钮 = `:data-state` + `{{ icon }}`、gallery/rack/色轮/笔设置 = 组件 render+emit。删手动同步函数。
4. **菜单/工具栏 data-driven**：消费 `listFilters()/listExporters()` + 未来的 Op/Tool 注册表（candidate 2 已起头），别再手搓静态 HTML。
5. 残下 ~440 行真编排（consent 手势 / boot / panel 互斥 / SW）= app.js 该留的全部。

## 3. 响应式边界（硬约束，越界 = 性能死）

**绝不能进 Vue 响应式图：**
- 画布像素 · `doc.layers` 的 ImageData/Float32 · in-flight stroke · Board viewport/stamp 缓存。
- `reactive()` 的 Proxy 代理每像素 = 每次读写触发 trap = 死。
- 引擎 `invalidateStamp()` / board 重绘那几行**故意留命令式**——它是「响应式 UI 态」与「裸引擎态」之间的**桥**，不是要消除的绑定。

| 进响应式图 | 留命令式（边界外） |
|---|---|
| toolStates(dial) · color · store.status · gallery/rack 列表 · panel 开合 | PaintDoc.layers 像素 · 当前 stroke · Board viewport · 引擎 stamp 缓存 |

## 4. 接缝已验证（别重新论证，别幻觉）

| 接缝 | 状态 | 证据 |
|---|---|---|
| 色轮输出 = 仅 `setColor(hex)` | ✅ 窄 | 全仓唯一写 `state.color` |
| 小窗（`palette.js`/`reference.js`） | ✅ 已是自洽深模块 | 注入回调 `onColorSampled/getCurrentColor`，挂壳即可 |
| 当前笔 = ResolvedBrush 不可变值 | ✅ 已落地 | `resolved-brush.js`，rack⟂engine 结构保证 |
| filter / exporter = 注册表插件 | ✅ 已落地 | `filters.js` / `exporters.js` |
| active-per-tool（toolStates）存 ORA | ✅ = per-doc 耦合点 | `webpaint/state.json`，按 GUID→name 解析（CONTEXT [[活动笔刷引用]]） |
| 选区 / 图层 | ❌ 不插件化 | 深核 / 结构（CONTEXT 明确警告别收 mask） |

## 5. TS 策略（用户定调）

mix ts/js，类型**只钉在深接缝**：`Contribution` 契约（Exporter/Op/Tool/Filter static 形状）· `ResolvedBrush`/`Color` 值（`readonly`）· view-model in/out · `store.*` 公开面。
**不 typed**：god file 残留编排、引擎热路径内部、还在动的 store 内部。不要为了类型把没理干净的 noodle 固化。可先 `// @ts-check` + JSDoc，不阻塞拆分；是否上 esbuild ts 转译是独立小决定。

## 6. 红线 / 项目纪律（违反 = 数据丢失或返工）

- **DEV 自动 build+commit+push 是常态；PROD push 必须先问人**（memory `feedback_ask_before_pushing_prod`）。
- 纯中文 UI；**不用 alert/prompt/confirm**（iPad PWA）；用 inline/sheet/状态行。
- 同步红线（MASTER §A）：If-Match·move-aside·GUID 身份——**别在 UI 重构里顺手碰 Store 同步**，那是另一条轴（candidate 5，缓做）。
- 笔刷手感/压感类改动**必须 push 才能真机验**；桌面能验的小改不急 commit（memory `feedback_commit_cadence`）。
- **别自称「浏览器里验过了」**——说「未真机验」并列出用户该验的点（memory `feedback_no_browser_self_claim`）。

## 7. 注意：app.js 正被并发编辑

写这些报告时另一个 agent 在落 candidate 3，行号会漂（行 396 一小时内从 `applyBrushPresetFrozen` 变成 `当前笔（ResolvedBrush）` banner）。**动手前 re-grep banner 对齐当前行号**，别信本文件里的绝对行号。

## Suggested skills

- `grill-with-docs` —— 动 SSoT 形状 / 响应式边界前，先把「哪些 state 进图、computed 的依赖图、edit→flush 的 consent 点」grill 清楚，并就地更新 `CONTEXT.md`（新词如「响应式 SSoT」「Contribution」该进词表）。
- `improve-codebase-architecture` —— 每轮重构后 start-fresh 重勘，对抗 vibe-coding 熵（用户既定工作法）。
- `prototype` —— 若对「响应式核 vs Vue reactive vs 裸 signal」拿不准，先做一个抛弃型 SSoT 原型验证绑定是否真蒸发，再动主仓（参 `tmp/gallery-vue-proto/`）。
