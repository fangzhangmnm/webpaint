# WebPaint（家族总规则见上级 CLAUDE.md）

Procreate 级绘画 PWA + **家族 sync-store 引擎的开发面**（shared-lib-workflow 流 1：引擎在 `src/store/` 在地改、真机测，稳了才 merge 回 canonical）。UI 中文。iPad 是手感的最终裁判。

- **红线区**：`src/store/**`（深模块，全 TS，改前 escalate human + 读 MASTER §A）。接缝 = `src/app-store.js` + `src/store/local-adapter.ts`，app 专属只进接缝。
- `journal/cached feedback.md` = 人类专属反馈日志，AI 只读，永不写。
- 人类钉死的区域：手感（streamline/taper/压感 gamma）、UI/UX 决策、store model。其余按 greenfield 标准大胆重构。
- 测试纪律：mock + node test 先行（store 200+ 测试）；需要真机的积批，"我只测一次。就是交付"；每 commit bump vN + 版本水印（反煤气灯——不确定部署版本时先对水印）。
- 云同步已知弱点清单：`docs/backlog.md` 的「云同步审计 2026-06-09」节 + `docs/reports/2026-06-09-store-cloud-sync-audit.md`（gitignored，只在本机）。
- **worktree 落地**：在 worktree 里改完别只 push remote——改动也要带回 local 工作区（merge/ff 本地 main，或把文件落回主 checkout），否则 local 落后于 remote、下个 agent 在旧版上接着改（曾出现 remote=v256 而 local main=v242）。
