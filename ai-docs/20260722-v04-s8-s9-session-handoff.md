# WebPaint 0.4 · 会话交接（第六棒 → 第七棒：纪元收尾真机总批）

> 写于 2026-07-22 S8+S9 完工后。给下一棒；自包含但只做路由，细节以 repo 文档为准。
> 上一棒交接 = `ai-docs/20260722-v04-s7-session-handoff.md`（其 Sequencing 拍板已执行完毕）。

## 现状一句话

**S8+S9 已按「一口气做完再统一真机」拍板完成**，在分支 `worktree-v04-s8-s9-edit-migration`
（v0.4.10，838 node + tsc + SwiftShader smoke 全绿），**未 merge main、未真机**（后台 job 纪律：
只 commit 分支；merge 回 main 由人类/前台棒执行——worktree 落地铁律仍有效，别让改动烂在分支）。

## 这一棒落了什么（路由）

- **S8 编辑逻辑迁移** = `ai-docs/20260722-v04-s8-edit-migration.md`（plan+报告一体）：
  brush commit 走 GPU merge（live 同一 shader，smoke maxΔ=0）+ tile-diff + GPU 收养；
  液化 doc-space mask（charter **H7 RED×3 转绿**）+ 删 role=liquify 死双轨；
  吸管 GL 化 + board 合成缓存 cluster 死；autosave 冻结快照（存档一致性）+ bg-jobs 空闲驱动；
  hint 机器拆除 + 原地描边不再每帧全段失效；SD 异步范式文档化（报告 §SD）。
- **S9 日落+体重** = `ai-docs/20260722-v04-s9-sunset-weight.md`：
  layer-composite 全删（生产合成收敛到 GL 单引擎，`src/doc-render.ts` 注入面）；
  对拍参照归档 test/gl-smoke/reference-{2d,gl-compositor}.ts（能力零损失）；
  editor-state→workbench-state、tile-pixels→tiles/tile-layer 改名归位；死码清理。
  **体重合同未达标**：24,384 vs ≤23,280（差 1,104）——报告 §2 有逐项「没砍到在哪、为什么」，
  结论 = 剩余质量是新管线本体 + store 红线 + 活功能，再砍需人类新授权。**不糊弄。**

## 下一棒：真机总批（纪元收尾）

- 总单 = `ai-docs/20260722-v04-device-test-batch.md`（§0–§9 旧积压 + **§10 S8 / §11 S9 新增**）。
  对水印 ≥ **v0.4.10**。先 merge main + push dev 再测。
- 用户首轮真机结果仍暂扣（防 breadcrumbing），纪元末揭晓（上一棒交接原话）。
- bug 反馈批逐条修：math/手感 bug 禁猜测式调试（先写清输入/输出问题陈述；建议 diagnose skill）。

## 拍板累积清单（真机批时或之后统一过；1–6 承自上一棒，7–12 本棒新增）

1. checkpoint-autosave / workbench-session 归属——S8 按「机械落地、挂 session-state/editor-session
   不动窝」默认先行，待追认。
2. accept 后选区去留（现状 = 清；spec:219「或者清选区，看UX」）。
3. reject 在 AA 软边选区的覆盖率损失（spec 已预认「不要缓存」）。
4. 点选图层是否入 undo（现状 = 不入）。
5. reference-gallery 归属（spec:26 留空；S8/S9 未碰）。
6. 用户首轮真机结果（暂扣中）。
7. **spec:41「保存阻塞锁 workpiece 写」用不可变 tile 快照达意实现**（一致 + 不阻塞，严格更强）——待追认。
8. 吸管在调整预览开着时取真像素非替身（UI 互斥理论不可达，顺手确认）。
9. 液化死双轨删除后 undo 历史类型统一 "stroke"（旧 "liquify" 标签退役，无 UI 面）。
10. 参考窗镜像 300ms 节流值（跟手感 vs 全量合成成本）。
11. **体重合同缺口 1,104 行的处置**（S9 报告 §2：砍活功能 / 动 store / 手感相邻深切，都需新授权）。
12. handoff 曾点名「liveSyncProvider 拆除」——勘探结论是它不冗余（执行器 updated 集喂口），
    已保留并在其上修了「原地描边全段失效」；如人类仍要拆，需先给替代喂口方案。

## 琐碎（承前，仍有效）

- worktree 跑 tsc/test 需 `ln -s` 主 checkout 的 node_modules 与 tools/esbuild（本棒已链，
  **完工删掉防误 commit**——目前 untracked，未入库）。
- smoke golden 是本机 SwiftShader 基线；换机假红 `SMOKE_UPDATE_GOLDEN=1 npm run smoke` 重录。
- u8 累积器逃生门：`render-tree-gl.ts` ctor `accumPrec` 拨回 `"f16"`。
- HUD 第二行读数：§10 加了「原地描边中 sb 应恒 0」的新预期。
- 对拍参照在 test/gl-smoke/reference-*.ts —— **别删对拍能力**；src 禁 import（build.sh lint）。
- 发版 ritual 照 CLAUDE.md 四步；AI bump patch，minor 要人类。
