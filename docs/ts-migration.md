# JS → TS 迁移：进度与策略

> as-of v294 / 2026-06-19。本文是 how 类文档（最易腐烂）——与代码矛盾时信代码（`tsconfig.json` 的 `include` 是唯一真相）。
> 完整勘探报告：`docs/reports/2026-06-19-js-ts-migration-deepening-review.html`（gitignored，仅本机）。

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

## 待迁（按风险，勿盲目铺开）

- **app 层 UI / 编排**（最大 `any` 债源）：`toolbar.ts`(73) `session-state.ts`(66) `layers-panel.ts`(50)
  `ui/gallery.ts`(38) 等——根因是组装根 `ctx` 无类型，每模块 `let doc:any, board:any…; initX(ctx)`。
  **下一刀（candidate 2）= 定义 `AppContext` 接口，~20 个 `initX` 签上它，一处契约灭 ~150 个 `any`。**
- **高入度 JS 接缝**（`any` 从源头扩散）：`doc.js`(8↘) `session.js`(10↘) `ora.js`(8↘)。按入度给真类型。
  `app-store.js`(16↘) = **红线接缝**，改前 escalate human。
- **手感红区**（`input.js` 1171 行未测 · `brush.js` · `stroke-smoother.js`）= 用户钉死区。
  **最后、保守**：只加类型注解、零行为改动、单独成批交付真机。

## 怎么迁一个文件（per-file 清单）

1. 选满足「只 import `.js`/无 import」的文件（否则会连带拖进未检查的 `.ts`）。
2. `Write` 同名 `.ts`（真类型，零新 `any`，保留中文注释）→ 删 `.js`。
3. 改**每一个**上游的 `from "./x.js"` → `"./x.ts"`（含 `test/*.mjs`；漏一个 = 运行时 "does not provide export"）。
4. 加进 `tsconfig.json` `include`。
5. `npm run typecheck` 绿 + `npm test` 绿（+ 大改时 esbuild bundle 冒烟）。
6. bump `src/version.js` vN + 版本水印。
