# WeebPaint（家族总规则见上级 CLAUDE.md）

Procreate 级绘画 PWA。UI 中文。iPad 是手感的最终裁判。

- **store 引擎已分仓（cutover v0.9.1，2026-08-14）**：`src/store/` 已删，引擎 = `@internal/store` 包（`../20260813 internal-store/` 仓，tgz 走 `vendor-pkgs/` file: 依赖）。改引擎去库仓（红线区，改前 escalate + 读 MASTER §A + pwa-cloud-store skill）；升级 = 本仓根跑 `bash "../20260813 internal-store/scripts/pull-package.sh" [版本]`（只认已发版；测试+commit 归本仓 session）。接缝 = `src/app-store.ts`（唯一值级 import 点，build.sh lint 守着；`wp:auth-changed` window 广播也由它派发）。缺接口 escalate 改库 API，绝不在 app 端绕（家规）。
- **【硬规则】文档 mutation 必须持令牌记账（workpiece v2，ADR-0008）**：写前 `wp2.begin()` 拿令牌（共享令牌编排走 `ctx.history.withPoint`），组件 verb 直写 substrate、collector 写时扣押自动记账——结构 = `ctx.layers` 门面（LayersFace）/ `wp2.layerTree` verbs、像素 = `wp2.layerTiles`（engine 直写也被观察者逮到）、选区 = `wp2.selection`、浮层 = `wp2.floatLayer`、fill 预览色 = `wp2.pendingFill`、整 doc 几何 = `doc-ops.runDocTransform`。无令牌写 = `_componentWrite` throw（结构上不存在裸写路径）。「不记账」必须是显式声明态（`_rawWrite` 预览直写 / `setActive` 焦点 / load 灌入）；`ctx.doc` 是 PaintingView 端口（读面 + 选区过渡宿），不是逃生门。
- **错误上报（统一）**：全 app + store 的错误唯一汇拢点 = `src/error-badge.ts` 的 `reportError(err, level?)`——
  它是**最终消费者**（唯一 console.log 的地方）。分级：`error`/`warning`→顶层 banner（`#__errBar`，z-9999，盖过
  gallery overlay/busy/gate/modal）、`info`→状态栏、`log`→仅 console（良性 offline/fallback）。
  **别再散落 `console.error/warn` 做错误处理**——funnel 到这里。store 侧走库内 error-handling 的
  `reportStoreError`（store 不 log），createStore 把它接到 app 传进去的 `ui.reportError`（= error-badge）。
- `journal/cached feedback.md` = 人类专属反馈日志，AI 只读，永不写。
- **宣发（launch）已分仓（2026-08-21）**：素材源件 + 宣发工单 + 台账在兄弟目录 `../20260821 WeebPaint宣发/`（私有孵化仓）。B1-B4 前置工单、itch/og/截图交付槽位表、图片素材工单**都在那边**，本仓 ai-docs 已不再持有（`20260821-launch-prep-workorders.md` 已迁出）。起手读那仓的 `ai-docs/20260821-material-inventory-and-doc-index.md`。本仓仍持有的宣发相关件：`ai-docs/20260821-icon-tiers.md`（图标档位+两条别再踩回去的线）、图标输出档（`icon-*.png` / `icon.svg` 的 SSoT 在本仓根，美术 `.ora` 源在宣发仓）。
- 人类钉死的区域：手感（streamline/taper/压感 gamma）、UI/UX 决策、store model。其余按 greenfield 标准大胆重构。
- 测试纪律：mock + node test 先行（store 200+ 测试）；需要真机的积批，"我只测一次。就是交付"；每 commit bump vN + 版本水印（反煤气灯——不确定部署版本时先对水印）。
- **长跑纪律（user 2026-08-10）**：测试/构建每条**实时 flush 耗时**（runner 已内建每测 ms + 总时；≥1s 标黄）；**每测默认 10s 超时墙**，确需更久在声明处 `it(name, fn, { timeout: ms })` 申请（挂死→响亮红，不再吊死全套件）；**全量硬线 <1min**（1-2min = 黄警告需要干预；**2min runner watchdog 硬切** exit 1；不搞分级，交付照跑全量）；长跑输出落**共享日志文件**（`tmp/`，AI 和人类都能随时看），不许把结果攒到最后梭哈；重活（test/smoke/gen-api）**不并行**互相抢。测试异常变慢先怀疑挂死而非"测试就是慢"——2026-08-10 出过：34min"慢" 实为 boot smoke 挂死（全量真实耗时 ~22s），先 `ps` 看 CPU 时间再下结论。注意「全量」= `npm test`（node）；playwright smoke 是另一档（分钟级，不在硬线内）。
- 云同步已知弱点清单：`ai-docs/20260528-backlog.md` 的「云同步审计 2026-06-09」节 + `ai-docs/reports/20260609-store-cloud-sync-audit.md`（gitignored，只在本机）。
- **worktree 落地**：在 worktree 里改完别只 push remote——改动也要带回 local 工作区（merge/ff 本地 main，或把文件落回主 checkout），否则 local 落后于 remote、下个 agent 在旧版上接着改（曾出现 remote=v256 而 local main=v242）。

## 发版 ritual（main → /dev/；prod 另说）

> **版本号权限（user 2026-07-25 硬规则）**：patch（0.0.x）随发版 ritual 由 AI 例行 bump；
> **minor（0.x.0）必须人类 explicit consent**——AI 有权**提议** bump minor，但只有人类明确
> 说出版本号（或明确批准）才准动手；把提议藏在 plan / 一大段文字里不算 consent。
> （背景：形状笔上线时 AI 自判 0.5→0.6——决定本身合理，但未获显式批准。）
> as-of v326 / 2026-06-26。`main` 分支 = dev 渠道：push 后 GH Actions 把 main 的 `dist/` + 源原样部署到 `/dev/` 路径。`prod` 是**另一条分支**，push prod 前必问 human（家族总规则 #5）。

每次push dev 走这 4 步（**成对 commit**：先源、后 bundle）：
1. **bump 版本**：`./bump.sh vN-YYYY-MM-DD`（N 单调+1，日期=发版日；唯一版本号在 `src/version.ts`，esbuild inline 进 bundle、SW/index.html 都读它）。
2. **commit 源**：先 `bash scripts/gen-api.sh` 重打 `api/`（.h 树，供人类参考——重构交付/大功能必打，
   小修看着办，user 要求时必打）；`git add src test api && git commit -m "vN: <一句话>"`。**重构策划**另须
   附「现状 .h + 提案 .h」两份（提案落 ai-docs/，形状改动要回写提案——它是 pin 住的契约）。
3. **构建**：`bash scripts/build.sh`——前置 `tsc --noEmit` 门（不过不准发）；esbuild bundle → `dist/weebpaint-<hash>.mjs`（content-hash 命名）；`sed` 改 `index.html` 指新 hash；清旧 hash bundle。**别手改 dist/ 或 index.html 的 hash**。
4. **commit bundle + push**：`git add dist index.html && git commit -m "vN: dev bundle (weebpaint-<hash>) — <一句话> smoke" && git push origin main`。

跑测试：`npm test`（node test runner；全量 ~30s，每条自带耗时）。`bump.sh` 的 sed 目标是 `src/version.ts`（v315 起 .js→.ts，别再回 .js）。
