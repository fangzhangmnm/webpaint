# WebPaint 0.4 · S7 会话交接（第四棒 → 第五棒）

> 写于 2026-07-22，S7 完工之后。给下一个 fresh agent；自包含，但内容细节一律以 repo 文档为准
> （本文只做路由，不复述）。上一棒交接 = docs/20260722-v04-s6-session-handoff.md（已过时，留档）。

## 现状一句话

**S7（render-tree + gpu-tile-pool + cpu-gpu-tile-bridge，7a/7b/7c 全片）已落 v0.4.8**，在分支
`worktree-v04-s7-render-tree`（0b3caf0，worktree = `.claude/worktrees/v04-s7-render-tree`）+
**draft PR #8**（https://github.com/fangzhangmnm/webpaint/pull/8）。**未 merge main、未真机**；
main = origin/main 仍是 e2bd316（v0.4.7）。824 node 测试 + tsc + esbuild + SwiftShader smoke 全绿
（smoke 含 11 条执行器端到端 vs compositeLayers，maxΔ=1）。
S7 是纯渲染重构，**用户可见语义零变化**——四个旧模块死（gl-doc-renderer/tile-backend-gl/
tile-store/tile-index），换来：commit 只传变更 tile、描边中静止图层并进缓存段（pass 数从层数
掉到个位）、累积器 straight rgba8 显存减半、GPU 态可随时蒸发自愈。

> **第五棒补记（2026-07-22）**：分支重连 node_modules 后三重再验绿（tsc 0 / 824 node / GL smoke），
> merge-ready（可 ff）。四份真机清单已去重并批成 **`docs/20260722-v04-device-test-batch.md`**（总单，
> 按 iPad 动线排序，行为变化预告在前）。本棒为后台 job，按 2026-07-18 指令只 commit 分支不动 main——
> **merge PR #8 仍留给用户**（本地 `git merge --ff-only worktree-v04-s7-render-tree && git push origin main`
> 即可，别用 GitHub squash——会砸掉成对 commit）。下下棒从总单接 bug 反馈批。

## 下一棒是什么

1. **用户 merge PR #8 → main**（或 agent 按用户指示 merge+push dev）——真机要走 /dev/ 部署，
   必须先上 main。worktree 政策：merge 后改动要真正回到主 checkout 的 main（别只留 remote）。
2. **真机批（S0–S7 全部积压，四份清单同批交付）**：
   - `docs/20260722-v04-batch1-handoff.md` §3（batch1 全家）
   - `docs/20260722-v04-s5-selection-tiles.md` §3（选区 tile 化）
   - `docs/20260722-v04-s6-float-workpiece.md` §4（浮层整链 + 三个行为变化）
   - `docs/20260722-v04-s7-render-tree.md` §2（S7：性能/显存读数 + dodge/burn u8 观感）
   真机是用户在 iPad 上做；agent 的活是接 bug 反馈批逐条修（math/手感类 bug 禁猜测式调试，
   先写清输入/输出问题陈述）。
3. **S8（编辑逻辑迁移）**：真机验完才准动；开工前轻量 plan（施工图 = batch1-handoff §4-S8 +
   S7 报告 §3 交接点）。注意 S8 里 checkpoint-autosave 归属要**先跟人类对齐**（spec:26 明说）。

## 必读文档（顺序）

1. `journal/20260721 Architecture.md` — 人类 spec，pin 死不 re-litigate。
2. `docs/20260722-v04-batch1-handoff.md` — 路线图 + 现状地图（§4-S7 已标 ✅ 指向 S7 报告）。
3. `docs/20260722-v04-s7-render-tree.md` — S7 报告：§0 轻量 plan（含实现级数据结构钉死）、
   §1 施工记录（**两处对 handoff 的偏差交代**：7c 拆两半夹在 7a/7b 两侧；golden 用池化快照
   非图像 hash）、§2 真机待验、§3 遗留/S8 交接。
4. `docs/20260722-test-charter.md` — 历史 bug → 架构保证映射（H2 的 LAYER_NOT_SYNCED 已从
   构造上消灭；H7 液化 RED 仍留给 S8）。

## 只在本会话、没进文档的琐碎

- worktree 跑 tsc/test 需 `ln -s` 主 checkout 的 node_modules（本会话完工已删，接手要重连）。
- smoke golden 基线 `test/gl-smoke/goldens.json` 已录入 git（本机 SwiftShader）；换机器假红的话
  `SMOKE_UPDATE_GOLDEN=1 npm run smoke` 重录。缺文件时自动首录，不会挡人。
- **u8 累积器如果真机上 dodge/burn/软边累积刺眼**：`render-tree-gl.ts` ctor 的 `accumPrec`
  参数一行拨回 `"f16"`（显存代价回去，视觉回 v0.4.7 精度）。这是预埋的逃生门。
- HUD 第二行新读数：`sb<本帧建段> sh<段命中>`，`!`=显存 quota 塞不下段缓存降级。
  描边中的健康形态 = `sb0 shN` + `Np` 个位数；`!` 常亮 = 调 board.ts 里 poolCapacityForBudget 预算。
- board.ts 的 `forceGLResyncUnderFloat`/`_wasFloatActive`/liveSync provider 现在是**冗余但无害**
  的 hint（执行器忽略，contentVersion 快路径自愈）——别当 bug 修，S8 动 brush 接缝时顺手拆。
- `test/gl-smoke/preview.ts` 每帧 markDirty 是**有意的**（量整树重合成 fps 的 worst case），别"优化"掉。
- GLCompositor 自己的树递归 composite() 保留着当 smoke harness 的规范参照，生产不走它——别删。
- 三个待人类拍板项从 S6 原样继承（都别自作主张）：① accept 后选区去留（现状=清）；
  ② reject 在 AA 软边的覆盖率损失；③ 点选图层是否入 undo。
- 本会话开工时用户明确点名「rendertree refactor 第四轮」= 人类决定跳过「先真机再 S7」的旧序；
  S8 没有这样的授权，**默认回到「真机验完才动」**。

## Suggested skills

- `diagnose` — 真机 bug 批回来逐条走（reproduce→minimise→问题陈述→修→回归测试）。
- `EnterPlanMode` — S8 开工前的轻量 plan（对齐 batch1-handoff §4-S8：brush doc-FBO 单张方案、
  tile-diff commit、液化 doc-space 重写、filter-brush 抽象类；**手感数学一个字节不动**）。
- `simplify` / `/code-review` — 大片落完后的质量收口可选。
- 不需要 `pwa-cloud-store`（本纪元不碰 `src/store/**`；真机 bug 牵到 store 红线 → escalate human）。
