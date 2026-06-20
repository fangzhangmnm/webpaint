# JS → TS 迁移：进度与策略

> as-of v309 / 2026-06-20。本文是 how 类文档（最易腐烂）——与代码矛盾时信代码（`tsconfig.json` 的 `include` 是唯一真相）。
> v309 cleanup（非迁移批）：① purge 从未实装的 canvas smudge 工具（engine/UI/tool/data 全删，留 toolbar/palette 两处旧值迁移 fallback，待将来重写）。② liquify 引擎 `src/liquify.ts` → `src/plugins/liquify-engine.ts`（与其 filter 插件 `plugins/liquify.js` 同处；gate 路径同步更新）。③ palette 的 mini「涂抹」混色模式 id `smudge`→`mix`（避免与 canvas smudge 混淆；这是独立的调色板混色功能，非画布工具）。
> 完整勘探报告：`docs/reports/2026-06-19-js-ts-migration-deepening-review.html`（gitignored，仅本机）。

## 北极星 + 原则（用户钉死，2026-06-19）

**TS 的唯一目标 = 让 coding agent 少制造熵。** 由此：
1. **新 code / 新 feature 一律 `.ts`、零 `any` 出生**（硬规则，无例外）。
2. **seam 优先**（agent 必穿、否则猜错的边界 = 最高杠杆，如 [[AppContext]]），但**不**因「将来要 greenfield 重写」
   就跳过屎山——屎山恰是 agent 制造熵最多的地方；type 它本身就是整理 + 发现（逼出真实形状与隐藏耦合），
   且让日后重写**更安全**（重写有类型契约要满足）。
3. 屎山按**「诚实描述现状」**类型化（不设计理想类型），文件内仍 seam → 内部 的顺序，可随 feature 触碰增量推进。

> 注：这条修正了早期「app 层 greenfield、别 type 内部」的口径——只有重写**迫在眉睫**时才该停在 seam；
> 这些 god-file 碎片已盘踞数月，故 type 它们是净收益。与 CLAUDE.md「大胆重写」不冲突：先给类型网，再大胆重写。

## 核心认识：迁移有两条正交轴

1. **轴 1 · 扩展名（广度）**：`.js` → `.ts`。机械活；因 import 带显式扩展名，改名要同步改每个上游的 `from "./x.js"`。
2. **轴 2 · 检查（深度）**：把 `.ts` 拉进 `tsc --noEmit` 硬门并给真类型。**杠杆在这条轴上。**

> 关键陷阱：单纯把 `.js` 改成 `.ts` **不等于**类型化。`tsconfig.json` 的 `include` 是一份**显式准入名单**，
> 只有名单里的文件才被 tsc 检查。改了名却没进名单 = 「看起来迁完了，其实全是 `any`、tsc 从不看」。
> **策略：以深度为先导，广度顺带**——每次把一个文件拉进门时才改它的扩展名，绝不为改名而改名。

## 门的机制（`tsconfig.json`）

- `strict: true` + `verbatimModuleSyntax: true`（类型-only import 必须写 `import type`）。
- `allowJs: true, checkJs: false`：门内文件可 import 仓里未类型化的 `.js`，它们以**推断/松类型**穿过接缝、不报错。
- **准入即受检**：把文件加进 `include` = 从此它的类型契约被 `npm run typecheck`（= build.sh step 0 硬门）持续验证。
- ⚠️ 加一个 `.ts` 进门会**连带把它 import 的其它 `.ts` 拉进程序并检查**（`.js` 不会，被 `checkJs:false` 挡住）。
  所以迁移要挑「只 import `.js` 或无 import」的文件，避免一次拖进一片未检查的 `.ts` 引爆历史错误。

## 进度

### ✅ store 深模块（v223 起）
`src/store/**` —— 全 strict TS，真契约（`store/types.ts` 14 个 interface、判别联合 status、`Bytes`/`Blob` 边界）。
被 Uint8Array/Blob 类型 bug 雷击两次后纳入。~157 个 store 测试命中此处。

### ✅ batch 1 · 纯叶子 on-ramp（v294，2026-06-19）
11 个纯·已测·低耦合叶子迁入门，typecheck + 388 测试全绿、esbuild bundle 解析通过：

| 文件 | 角色 |
|---|---|
| `gallery-path.ts` | 图库路径代数（纯字符串） |
| `crop-geometry.ts` | Crop 框 8-handle 几何（纯数学） |
| `pointer-route.ts` | 指针 → role 路由决策（纯） |
| `registry.ts` | Contribution 注册表原语（泛型 `Registry<T>`） |
| `editable-leaf.ts` | `requireEditableLeaf` UI 谓词包装 |
| `engine-registry.ts` | `PIXEL_STROKE_SPECS` dispatch SSoT |
| `gallery-model.ts` | 图库 local⊕cloud 合并 / 文件夹切片（纯数据） |
| `brush-rack-view.ts` | 笔架 sheet 纯 view-model |
| `pointer-gesture.ts` | 双指手势数学（pinch/rot/tap，纯） |
| `resolved-brush.ts` | `ResolvedBrush` 派生（原有 JSDoc → TS interface） |
| `ora-stack-xml.ts` | ORA stack.xml 树↔XML（纯结构，DOM 类型） |

迁移纪律（本批已遵守，后续沿用）：**真类型，零新 `any`**；唯一的领域接缝（`resolved-brush` spread 未类型化的
`DEFAULT_SETTINGS`）用一处带注释的 `as BrushSettings` 断言，不用 `any`。行为逐字保持
（如 `Date.parse(x||0)` → `Date.parse(String(x||0))`，运行时等价）。

### ✅ batch 2 · AppContext seam + 首批消费方（v295，2026-06-19）
[[AppContext]] 装配契约落地（`src/app-context.ts`，gated）+ 首批 `initX` 消费方入门。typecheck + 388 测试全绿、bundle 通过。

| 文件 | 做了什么 |
|---|---|
| `app-context.ts` | **新** · `AppContext` interface（= app.js 39 键 ctx）。引擎单例 `import type` 自未类型化 .js class（拿 JS 推断形状、零迁移、不连带拖 .ts 进门）；反应式态/rack/浮窗/gallery 在此**诚实描述**，随源逐步收敛。 |
| `els.ts` | candidate 4 核：`byId<T>()` helper → els.* 断言**非空** `HTMLElement`（消费方不再 `!`/`?.`）。 |
| `safe-ls.ts` | 去 `any` → `string \| null`。 |
| `fullscreen-busy.ts` | `withBusy<T>` 泛型 + null 安全（经 app-store.js 级联带入门）。 |
| `theme.ts` · `platform-guards.ts` · `cloud-auth-ui.ts` | `initX(ctx: AppContext)` + 模块单例 `let x: AppContext["x"]`，去 `any`。 |

**关键发现（决定后续排序）**：
- **级联穿 `.js`**：gate 一个消费方会把它 import 的 `.ts` 全拖进门并检查——**即使中间隔着 `.js`**
  （`cloud-auth-ui → app-store.js(.js 不检) → fullscreen-busy.ts(.ts 必检)`）。所以「能否清爽 gate」看的是
  **`.ts` 依赖闭包**，不是文件自身 any 数。屎山消费方（toolbar/session-state/layers-panel…）彼此 + 向
  session-state.ts(66) 级联 → 不能单独 gate。
- **`any` 数严重低估 strict 摩擦**：消费方一旦 gate，每个 `els.*` 的 `|null`、每个未类型 event handler 都点亮——
  故先做 `els.ts` 非空（candidate 4）= **mass 消费方入门的前置**（否则人人淹在 `!` 里）。

### ✅ batch 3 · app 层基础叶子 + color-panel 消费方（v296，2026-06-19）
gate 一批**被多个消费方依赖的基础叶子**——它们在很多消费方的 `.ts` 闭包里，先 gate 它们 = 缩小后续每个消费方的闭包。
typecheck + 388 测试全绿、bundle 通过。新 gated 8 个：

| 文件 | 做了什么 |
|---|---|
| `surfaces.ts` · `signals.ts` | 本就全 typed，零改动入门（z-order 栈 / 反应式 docVersion）。 |
| `session-name.ts` | `(s:any)` → `(s:{name:string})` 等小修。 |
| `anchored-popup.ts` | 6 个 DOM `any` → `HTMLElement \| null`。 |
| `sheets.ts` | 泛型 `resolveAndClose<T>`；非标 CSS 走 `style.setProperty("-webkit-text-security")`（去 `as any`）；`syncGate`/`lockSyncGate`/`settleSyncGate` typed。 |
| `color-panel.ts` | `initX(ctx: AppContext)` + `state: AppContext["state"]` + `colorWheel: ReturnType<typeof mountColorWheel>`；event handler typed（`PointerEvent`/`CustomEvent`）。 |
| `ui/color-wheel.ts` · `ui/color-model.ts` | 经 color-panel 级联带入门（本就 well-typed，零改动）——顺带推进 candidate 1（UI）。 |

> 唯一 `as`：`mountColorWheel(els.colorPanelBody as HTMLElement)`——`colorPanelBody` 是 `querySelector`（非 byId）故 `Element|null`，
> 但它是必存在的挂载点。byId 体系外的 querySelector 元素，到用处再断言。

### ✅ batch 4 · session-state + editor-state hub（v297，2026-06-19）
活动文档生命周期 hub（`session-state.ts` 729 行 / 46 any）+ 编辑器 RAM SSoT（`editor-state.ts`）入门。
解锁多数消费方闭包的底部（`cloud-freshness`/`topbar-menu`/`boot`/`import-image`/`gallery-shell` 全向 session-state 级联）。
typecheck + 388 测试全绿、bundle 通过。

| 文件 | 做了什么 |
|---|---|
| `editor-state.ts` | `state: any/dialReactive: any` → 真 `EditorRuntimeState`/`DialReactive`（owner 构造、契约在 [[AppContext]]）。重构构造序（toolStates 先建 → state 字面量一次成形）+ 逐属性显式 `defineProperty`。`serializedToolStatePatch(current: ToolDial, saved: unknown)`。 |
| `session-state.ts` | ctx 单例 → `AppContext[...]`；SSoT 变量（`_activeSessionName: string\|null` 等）；函数参数（`GalleryItem` / `LoadedDoc` / ORA-meta 形状）；`catch (e)` + `errMsg(e)` 辅助；`initSession(ctx: AppContext)`。 |
| `app-context.ts` | hub 用到的句柄收紧：`ReferenceWindowHandle`/`PaletteWindowHandle`（分参考/调色板）、`RackHandle.applyToolState`、`GalleryHandle.setFolder`、`gateCloudSyncOnOpen` 返 `Promise`。 |
| `sheets.ts` | `lockSyncGate`/`settleSyncGate` 的 value `unknown` → `string`（gate 永远吐选择字符串；满足 store onConflict 的 `Promise<string>`）。 |

**关键发现**：
- **`_store` 其实是 typed 的**：`app-store.js`（.js 不检）re-export `store/index.ts` 的 store，类型穿过 .js 存活 →
  `_store.flow.*` 带 store/** 的真签名（`encode: () => BytesSource | Promise<BytesSource>` 等）。原先 `: any` 把它全遮了。
  教训：别自定义与 store 同名的结果类型（会撞「two FlowResult」），让结果变量 **infer 真类型**。
- **红线区只做类型、零行为改动**：session-state 是 store-orchestration 红线（CLAUDE.md）。所有改动 type-erased
  （注解 / `!` 断言 / `as`）或行为等价（`errMsg` ≡ `e && e.message || e`）；`_store.*` 调用编译后字节不变。
- **未类型 JS-seam 的断言**：`encodeDocToOra`（ora.js 未类型化）推断 `Promise<unknown>` 不满足 `BytesSource`，
  在 `_encodeCurrentOra(): Promise<Blob>` 一处断言（candidate 3 给 ora.js 真类型时移除）。
- **session-state/editor-state 无单测**（survey）：类型绿 + 行为 type-erased 是最强静态保证，但属真机测试批（「我只测一次」）。

### ✅ batch 5 · cloud-freshness + boot 消费方（v298，2026-06-19）
session-state 级联通后，两个 store-orchestration 红线消费方入门。typecheck + 388 测试全绿、bundle 通过。

| 文件 | 做了什么 |
|---|---|
| `cloud-freshness.ts` | ctx 单例 → `AppContext[...]`；`gateCloudSyncOnOpen/checkCloudETag(sessionName: string)`；`formatCloudTime(iso: string\|number)`（`cloudTime` 是 union → `Date.parse(String(iso))`，行为等价）；`onSkip!` 定赋；`errMsg`。 |
| `boot.ts` | `initX(ctx: AppContext)`；`catch (e)` + `errMsg`。`_store` 经升级后的 `ctx.store` 拿真类型。 |
| `app-context.ts` | `store: unknown` → `typeof import("./app-store.js").store`（store 真类型，batch 4 已验证；帮所有用 `ctx.store` 的消费方）。`RackHandle` 补 boot 用的 `load/defaultToolStateFor/checkCloud/refreshCloudState/get/setRack/persist`。 |
| `sheets.ts` | `lockSyncGate` 泛型化 `<T = string>`：多数 value 是选择字符串（满足 store onConflict 的 `Promise<string>`），但 cloud-freshness 用 `{kind:"skip"}` 哨兵——泛型让两者都成立。修正 batch 4 把 value 钉死 string 过窄。`settleSyncGate(value: unknown)`、`_pendingResolve` 擦成 `unknown`（外部 settle 兜底关闭）。 |

**关键发现**：
- **gate value 多态**：`lockSyncGate` 的 action value 不止字符串（cloud-freshness 传对象哨兵）。泛型 `<T=string>` 比钉死 string
  更诚实——每个调用点 infer 自己的 T；外部 `settleSyncGate(null)` 兜底关闭走 `unknown` 擦除。
- **红线消费方同样只做类型**：cloud-freshness/boot 也是 store-orchestration 红线；改动 type-erased 或行为等价
  （`Date.parse(String(iso))` ≡ `Date.parse(iso)`，Date.parse 本就 ToString）。

### ✅ batch 6 · layers-panel keystone（v299，2026-06-19）
图层面板 UI（`layers-panel.ts` 721 行 / 43 any · Vue 组件 + 深 doc 操作）入门 —— keystone，解锁 `layer-undo`。
typecheck + 388 测试全绿、bundle 通过。零 any 出门。

| 做了什么 | 细节 |
|---|---|
| ctx 单例 → `AppContext[...]` | `doc`(PaintDoc)/`board`/`history`/`setStatus`/`afterDocChange`/`layerSpecFrom`。doc 方法（layers/addLayer/locateNode/snapshotTree/mergeDownLayer…）全过——doc.js 推断够用。 |
| 本地 interface 描述未类型化 doc 对象 | `LayerNode`（活层）、`LayerSpec`（可变快照 spec，`blob?: Blob\|null`）、`LayerLeafSnap`/`LayerRowData`/`MoveTarget`（Vue 边界 leaf-by-value 数据）、`LayerRowProps`。 |
| Vue / DOM | `setup(props: LayerRowProps)`；event handler `PointerEvent`/`Event` + `(e.target as HTMLElement\|null)?.closest`；`els.layerAddBtn` 收窄成 `HTMLButtonElement`（candidate 4）。 |
| 未类型 doc-seam 断言 | `doc.locateNode(...)!`、`r.newLayer!`/`r.loc!`、`n.children!`（组必有 children）、mergeDown/duplicate 结果 spec `as LayerSpec`——doc.js/pixel-edit.js 类型化时收紧。 |

**关键发现**：
- **vendored vue 的 `.d.ts` 是手写 stub、不全**：缺 `nextTick` → 补一行 `export function nextTick(...)`（描述 runtime 已有的导出，非改 vue 本体）。后续 UI 组件入门遇缺啥补啥。
- **app-UI 屎山可纯类型化**：layers-panel 非 store 红线，但仍全程 type-erased / 行为等价（`reason ?? ""` 索引、`?.closest` 兜 null）——印证北极星「type 屎山而不改行为」可行。

### ✅ batch 7 · toolbar keystone（v300，2026-06-19）
工具选择 + EditMode→UI 派生 + 套索/选区工具栏（`toolbar.ts` 502 行 / 51 any · 重 DOM）入门 —— 最后一个 keystone，
解锁 `selection-ops`/`filters-adjust`/`transient-panels`/`import-image`。零 any 出门。typecheck + 388 测试全绿、bundle 通过。

| 做了什么 | 细节 |
|---|---|
| ctx 单例 → `AppContext[...]` | 含 `state`/`editMode`/`input`/`rack` 等 14 个。 |
| DOM refs typed | 一个泛型 `byId<T>()` helper；套索工具栏 lets 全 `HTMLElement`/`HTMLElement[]`/`HTMLSelectElement`——**删掉 ~20 处 use-site `as any`**。`els.toolBtns` 收窄 `HTMLElement[]`（candidate 4）。 |
| 本地 interface | `LayerLike`/`StrokeEntry`/`SelEditState`/`TransientOpts`。 |
| 未类型 JS-seam 断言 | `requireEditableLeaf(...) as LayerLike`、`b.dataset.tool!`；`editMode.enterTransient` 推断被 edit-mode.js 的 null 默认窄成 `null\|undefined` → 在调用处把方法断言成真签名 `(n, o?: TransientOpts)=>void`。 |
| app-context | `_suppressTransientPanels: () => void` → `(reason?: string) => void`（toolbar 带 "transform" reason 调）。 |

**关键发现**：
- **DOM 类型化是负 any**：把 module-level DOM lets 从 `any` 改成真元素类型后，散在各处的 `(x as any)` use-site cast 一次性消失（51 any 里很大一块是这种）。typed-at-source > cast-at-use。
- **未类型 .js 的「默认 null 收窄」陷阱**：edit-mode.js `enterTransient(name, {apply=null, abort=null}={})` 被 tsc 推断成 apply/abort: `null` → 传函数报错。在调用处断言方法签名是最小修（candidate 3 给 edit-mode.js 真类型时移除）。

### ✅ batch 8 · toolbar 下游簇（v301，2026-06-19）
toolbar 解锁的 4 个消费方一簇入门：`layer-undo`(4)、`transient-panels`(2)、`selection-ops`(12)、`filters-adjust`(11)。零 any 出门。typecheck + 388 测试全绿、bundle 通过。

| 文件 | 要点 |
|---|---|
| `transient-panels.ts` | ctx 单例 + `_suppressedDuringTransient: {el,id}[]` + `allow: Record<string,string[]>`。 |
| `layer-undo.ts` | ctx 单例 + 9 个 undo handler 回调 `(e: UndoEntry)`。`type UndoEntry = Record<string, any>`——**异构动态 dispatch payload，history.js 是未类型化 owner**；与其编 9 个抛弃型 interface，不如一处带注释的 alias（candidate 3 收紧成判别联合）。 |
| `selection-ops.ts` | ctx 单例 + `LayerLike`（canvas 几何）；canvas `getContext("2d")!`；`requireEditableLeaf(...) as LayerLike`；enterTransient 断言。 |
| `filters-adjust.ts` | ctx 单例 + `FilterLike`/`AdjustLayer`/`AdjustState`（filters.js 未类型化）。filter-brush toolbar 重写：捕获 `const fb = state.filterBrush`（闭包不收窄）+ `Filter as FilterLike`。 |
| `app-context.ts` | `EditorRuntimeState.filterBrush` 加 `params: Record<string,unknown>` + `variantId?`（filters-adjust 读写）。 |

**关键发现**：**动态 dispatch payload 用一处带注释的 `Record<string, any>` alias 是诚实的**——undo entry / filter params 这类「shape 由 push 方决定、owner 是未类型化 .js」的数据，编穷举 interface 是过度工程；一个具名 alias + candidate 3 收紧的备注，比散落 `any` 干净，也不假装确定性。

### ✅ batch 9 · import-image（v302，2026-06-19）
图片/.ora 导入（`import-image.ts` 26 any · canvas 重）入门。零 any 出门。typecheck + 388 测试全绿、bundle 通过。
- ctx 单例 + `ImportLayer`（OffscreenCanvas/HTMLCanvasElement 写像素）+ `BigImportChoice`。
- canvas 联合：`c.getContext("2d", …)!` 捕获到 `const lctx`（避免 layer.ctx 的 null 散读）；`imgSmoothing: ImageSmoothingQuality`。
- big-import sheet DOM 全 `as HTMLElement`（删 `(x as any).onclick`）；`els.oraFileInput` 收窄 `HTMLInputElement`（candidate 4）。
- fillLayer0 经 session.newDoc 的 `(layer: unknown)` 契约 → 内部 `as ImportLayer`。

### ✅ batch 10 · settings-menu ↔ doc-ops 成对（v303，2026-06-19）
互相依赖的一对（`settings-menu` 21 + `doc-ops` 16 any）必须同批 gate。零 any 出门。typecheck + 388 测试全绿、bundle 通过。
- settings-menu：ctx 单例 + `applyX(on: boolean)` ×7 + `ShortcutLike`（KEYBOARD_SHORTCUTS）+ openSheet/closeSheet 容 null。
- doc-ops：ctx 单例 + `Rect`/`CropState`/`TransientOpts`；crop 拖拽 handler `PointerEvent` + `_cropState.startMouse!`（drag 期非空）。
- els：`resampleW/H/Lock/Mode` 收窄 input/select（candidate 4）。

### ✅ batch 11 · 最后一簇消费方（v304，2026-06-19）—— **AppContext 消费方 rollout 完成**
最后 5 个 `initX` 消费方一批入门：`gallery-shell`(19)、`side-windows`(16)、`topbar-menu`(10)、`export-import-menu`(2)、`smooth-dev-panel`(1)。
零 any 出门。typecheck + 388 测试全绿、bundle 通过。
- 套路同前：ctx 单例 → `AppContext[...]`，event handler typed + `e.target as Node`，`errMsg`，DOM null/getContext 收窄。
- `app-context`：`GalleryHandle` 补 `setView/getFolder/emptyTrash`；`RackHandle` 补 `reset/syncCloud` + `get(): {brushes}|null`。
- `els`：`undoBtn/redoBtn`(button)、`referenceFileInput/newDocName/newDocW/newDocH`(input) 收窄（candidate 4）。
- `JSON.parse(localStorage.getItem(K)!)`（getItem 的 string|null → `!` 保原行为，runtime JSON.parse(null) 本就 ToString）。
- topbar-menu/gallery-shell 是 store-orchestration 红线：改动 type-erased / 行为等价。

**🎉 candidate 2（AppContext 消费方 rollout）全部完成**：~22 个 `initX` 消费方全部 gated。

### ✅ batch 12 · 非 ctx 消费方簇（v305，2026-06-19）—— brush-rack keystone
直接构造（不经 ctx）的一簇一批入门：`brush-rack`(22 any，411loc keystone)、`brush-io`(8)、`current-brush`(2)、`dial-controls`(3)、`pwa-shell`(2)、`dev-console`(0)、`save-status`(0)。零 any 出门。typecheck + 388 测试 + bundle 全绿。
- **新 `brush-types.ts`**：brush / 笔架数据形状的**单一 TS 真源**（`Brush` / `BrushRackData`，诚实描述 `brushes.js` 运行时形状 + `[k]:unknown` 兜底）。brush-rack/brush-io 共用，灭掉「同一形状抄两遍」的隐式 any。
- `brush-rack`：`BrushRackDeps` 用 `import type` 绑真单例（`EditorRuntimeState`/`DialReactive`/`EditMode`）+ 本地 `RackStore`/`RackSyncResult` 接口；UI 晚绑字段 `d = deps as Deps & UI`（一处 cast 记录 init() 晚绑，余处全类型化，替原 `(this.d as any).els`）；`_rack` 后置 `!`（编辑/导出路径 rack 必已 load）。
- `dev-console`：`declare global { Window.WebPaint }` 诚实列出挂上的调试成员；`const WP = window.WebPaint = ... || {}` 捕获本地避 strict possibly-undefined。
- 拉入 program 的连带文件修了 2 个潜伏错：`ui/brush-settings.ts` `open(d as BrushDraft)`、`current-brush` `preset as BrushPreset`（同一运行时对象的两个视图）——皆行为等价 cast。
- `save-status` 红线接缝：`session.name as string`（updateSaveStatus 已守门，跨函数 tsc 看不到）。

### ✅ batch 13 · 引擎接缝 .js→.ts 大批转换（v306，2026-06-19）—— 含手感核心
用户解禁：「只加 type 不改手感」→ 一口气转 **8 个引擎 .js→.ts** + gallery UI 簇灭 any。
8 个并行 subagent（每文件一个，铁律：只加注解/cast/interface，绝不改运行时表达式）+ 中心化 rename/改 import 扩展名/收口级联。**388 测试是行为护栏，全程绿**。
- 转换文件：`doc`(950loc/375 err)、`board`(823/290)、`input`(1171/390，手感核心)、`session`(361/36)、`ora`(258/57)、`pixel-edit`(114/45)、`edit-mode`(126/26)、`history`(102/34)。
- gallery UI 簇灭 any：`ui/gallery`(37→0)、`gallery-view-model`(5→0)、`rack-sheet`(2→0)。
- **机制**：`.js→.ts` = git mv + 全仓 import 扩展名 `./X.js`→`./X.ts`（含 app.js / 子目录 `../X.js`）+ 入 gate。运行时 node strip-types 跑 .ts、esbuild 打包，行为零变更。
- **引擎类型从 inferred-any 收成真类型** → 级联到消费方 ~111 个 boundary mismatch。两处引擎根因修一次收掉大半：`history.UndoHandler.refsLayer(id:number)`（layer id 全程 number）、`doc.SelectionLike` 补 bbox/maskCanvas/outline + `LayerSnap.bitmap` 收 ImageBitmap。其余消费方（layers-panel 36、session-state 13、toolbar 12…）3 个并行 agent 在 seam 处 cast 收口（零新 any）。
- **gallery.ts 此前根本没进 program**（gallery-shell 动态 import）→ agent 报 0 是 vacuous；正式入 gate 后暴露 9 个真错（`onUnmounted` 漏在 vue stub、闭包内 `props.cloud!`、TrashGItem cast 等），已修。
- 残留**诚实 boundary any**：`input.ts` 21、`ora.ts` 4 —— 全指向**仍未类型化的 .js 引擎**（`brush.js`/`liquify.js`/`filter-brush.js`/`lasso.js`/`bitmap.js`/`resample.js`）。这些转 .ts 后即可收口（input 的本地 `Doc`/`Board` interface 换成 `import type` 真类型）。

### ✅ batch 14 · 二级引擎簇 .js→.ts（v308，2026-06-19）—— 手感引擎全员入门
11 个二级引擎 .js→.ts：`brush`(933loc/164err)、`floating-transform`(797/233)、`selection`(414/161)、`lasso`(370/181)、`liquify`(329/30)、`layer-composite`(261/37)、`stroke-smoother`(109/117,手感核心)、`stroke-input-smooth`(37)、`filter-brush`(56)、`resample`(97)、`bitmap`(10)。8 并行 subagent，铁律=只加注解/cast，零行为改。388 测试全程绿、tsc 0、bundle 通过。
- **`plugins/liquify.js` 撞名坑**：根 `liquify.js` 改名时 sed 误改了 `plugins/index.js` 的 `./liquify.js`（指 plugins/liquify.js，未转）→ boot smoke 测试当场红。已还原。教训：rename sed 要防同名子目录文件误伤。
- **selection 真类型回填 doc.ts**：`selection.ts` 出真 `Selection` 类 → `doc.ts` 弃 batch-13 的本地 `SelectionLike` 镜像，直接 `import type { Selection }`。顺手纠正 batch-13 我加错的 `SelectionLike.maskData`（真类无此成员）、`outline()` 实为 `Float32Array[]` 非 `number[][]`。
- **级联仅 27 个**（比 batch 13 的 111 小：引擎对引擎的依赖比消费方对引擎少）。selection 根因修掉 7，其余 20 个 1 个 agent seam cast 收口（`Parameters<typeof fn>[N]` 提取真引擎形参类型，零新 any；engine 文件未导出 SubTool/Source/CompositeOpts 等故走 Parameters 间接绑）。
- **brush.ts agent 抓到潜伏 bug**（未改，留给人）：`beginStroke` 里 smudge 的 `loaded` 算了但没写进 stroke 对象 → smudge stamp 路径运行时永不触发。修它=行为改动，超本批范围；手感相关，**需人确认**。

## 待迁（剩余 JS 源）

- **input.ts 本地 interface 清理**（即时可做，已解锁）：input/ora 的 21+4 残留 any 是 input 本地 `Doc`/`Board`/`Layer`/`EditMode`/`History`/`PixelHistory`/`BrushSettings`/`LiquifySettings`/`FilterBrushState` 镜像 interface（`[k]:any`）+ `engine:any`。这些引擎现已全 .ts → 换成 `import type` 真类型即可清掉大半 any + 去掉 batch-13/14 的 `as unknown as Parameters<...>` 收口 cast。focused 小批。
- **支持/功能叶**（batch 15）：`filters`(8imp) `storage`(6) `config`(6) `crypto-state`(7) `brushes`(3) `exporters` `zip` `sevenzip` `cloud-thumbs*` `enc-thumbs` `reference`(495) `palette`(197) `psd`(385) `smooth-config` `panel-state` `version`。
- **红线接缝** `app-store.js`(17imp) = `src/store/**` 的门面，改前 escalate human。
- app.js（组合根）本身仍 .js（god-file 装配，最后处理）。
  **最后、保守**：只加类型注解、零行为改动、单独成批交付真机。

## 怎么迁一簇文件（清单）

1. **算 `.ts` 依赖闭包**：从目标文件出发，跟着 `import … from "./x.ts"`（穿 `.js` 也要跟它的 `.ts` import）
   收集所有**尚未 gated** 的 `.ts`。这一簇要一起入门——闭包里有屎山（如 session-state.ts 66）就先别碰，换更小的簇。
2. 若是 `.js→.ts` 改名：`Write` 同名 `.ts`（真类型，零新 `any`，保留中文注释）→ 删 `.js` →
   改**每一个**上游 `from "./x.js"` → `"./x.ts"`（含 `test/*.mjs`；漏一个 = 运行时 "does not provide export"）。
3. 若已是 `.ts`：`initX(ctx: AppContext)` + 模块单例 `let x: AppContext["x"]`，去 `any`，修 strict-null / event 类型。
4. 把这一簇全部加进 `tsconfig.json` `include`。
5. `npm run typecheck` 绿 + `npm test` 绿（+ 大改时 esbuild bundle 冒烟）。
6. bump `src/version.js` vN + 版本水印。
