# JS → TS 迁移：进度与策略

> as-of v295 / 2026-06-19。本文是 how 类文档（最易腐烂）——与代码矛盾时信代码（`tsconfig.json` 的 `include` 是唯一真相）。
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

## 待迁（按风险，勿盲目铺开）

- **AppContext 消费方 rollout（candidate 2 续）**：剩 ~18 个 `initX`。**先做 candidate 4**（els 收窄到具体元素类型
  + 其余非空），再按 **`.ts` 依赖闭包**成簇 gate（一簇 = 一个连通子图一起入门）。每簇：`initX(ctx: AppContext)` +
  模块单例 typed + 修 strict-null/event 类型。屎山内部按「诚实描述现状」类型化（北极星：少熵）。
- **高入度 JS 接缝**（`any` 从源头扩散）：`doc.js`(8↘) `session.js`(10↘) `ora.js`(8↘)。按入度给真类型——
  也会自动收紧 `AppContext` 里 `import type` 的引擎单例形状。`app-store.js`(16↘) = **红线接缝**，改前 escalate human。
- **手感红区**（`input.js` 1171 行未测 · `brush.js` · `stroke-smoother.js`）= 用户钉死区。
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
