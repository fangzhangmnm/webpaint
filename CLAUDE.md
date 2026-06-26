# WebPaint（家族总规则见上级 CLAUDE.md）

Procreate 级绘画 PWA + **家族 sync-store 引擎的开发面**（shared-lib-workflow 流 1：引擎在 `src/store/` 在地改、真机测，稳了才 merge 回 canonical）。UI 中文。iPad 是手感的最终裁判。

- **红线区**：`src/store/**`（深模块，全 TS，改前 escalate human + 读 MASTER §A）。接缝 = `src/app-store.js` + `src/store/local-adapter.ts`，app 专属只进接缝。
- `journal/cached feedback.md` = 人类专属反馈日志，AI 只读，永不写。
- 人类钉死的区域：手感（streamline/taper/压感 gamma）、UI/UX 决策、store model。其余按 greenfield 标准大胆重构。
- 测试纪律：mock + node test 先行（store 200+ 测试）；需要真机的积批，"我只测一次。就是交付"；每 commit bump vN + 版本水印（反煤气灯——不确定部署版本时先对水印）。
- 云同步已知弱点清单：`docs/backlog.md` 的「云同步审计 2026-06-09」节 + `docs/reports/2026-06-09-store-cloud-sync-audit.md`（gitignored，只在本机）。
- **worktree 落地**：在 worktree 里改完别只 push remote——改动也要带回 local 工作区（merge/ff 本地 main，或把文件落回主 checkout），否则 local 落后于 remote、下个 agent 在旧版上接着改（曾出现 remote=v256 而 local main=v242）。

## 发版 ritual（main → /dev/；prod 另说）
> as-of v326 / 2026-06-26。`main` 分支 = dev 渠道：push 后 GH Actions 把 main 的 `dist/` + 源原样部署到 `/dev/` 路径。`prod` 是**另一条分支**，push prod 前必问 human（家族总规则 #5）。

每次发 dev 走这 4 步（**成对 commit**：先源、后 bundle）：
1. **bump 版本**：`./bump.sh vN-YYYY-MM-DD`（N 单调+1，日期=发版日；唯一版本号在 `src/version.ts`，esbuild inline 进 bundle、SW/index.html 都读它）。
2. **commit 源**：`git add src test && git commit -m "vN: <一句话>"`。
3. **构建**：`bash scripts/build.sh`——前置 `tsc --noEmit` 门（不过不准发）；esbuild bundle → `dist/webpaint-<hash>.mjs`（content-hash 命名）；`sed` 改 `index.html` 指新 hash；清旧 hash bundle。**别手改 dist/ 或 index.html 的 hash**。
4. **commit bundle + push**：`git add dist index.html && git commit -m "vN: dev bundle (webpaint-<hash>) — <一句话> smoke" && git push origin main`。

跑测试：`npm test`（node test runner；store 200+ 测试）。`bump.sh` 的 sed 目标是 `src/version.ts`（v315 起 .js→.ts，别再回 .js）。
