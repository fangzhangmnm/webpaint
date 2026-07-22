> ⚠ 已过时留档（S7 已由第四棒完成，见 docs/20260722-v04-s7-session-handoff.md）。原件写在 /tmp，2026-07-22 迁入 docs 防过夜蒸发。

# WebPaint 0.4 · S6 会话交接（第三棒 → 第四棒）

> 写于 2026-07-22，S6 完工 + 用户已 merge main 之后。给下一个 fresh agent；自包含，但内容细节一律以
> repo 文档为准（本文只做路由，不复述）。

## 现状一句话

**main = origin/main = e2bd316（v0.4.7）**：0.4 纪元 S0–S6 全部落地并 merge（80bedc1 = S6 代码，
e2bd316 = handoff 文档补记）。803 node 测试 + tsc + esbuild 绿。**S0–S6 全部未真机**。
draft PR #7（https://github.com/fangzhangmnm/webpaint/pull/7）已被用户 merge，可关闭/无需再动。
worktree `.claude/worktrees/v04-s6-float-workpiece`（分支 worktree-v04-s6-float-workpiece）已完成使命，可删。

## 下一棒是什么

1. **真机批（先于一切）**：三份清单同批交付——
   - `docs/20260722-v04-batch1-handoff.md` §3（batch1 全家）
   - `docs/20260722-v04-s5-selection-tiles.md` §3（选区 tile 化）
   - `docs/20260722-v04-s6-float-workpiece.md` §4（浮层变换整链 + 三个行为变化）
   真机是用户在 iPad 上做的；agent 的活是接住 bug 反馈批、逐条修（math/手感类 bug 禁猜测式调试，
   先写清输入/输出问题陈述）。
2. **S7（render-tree + gpu-tile-pool + bridge）**：真机验完才准动；开工前必须对该片单独做轻量 plan
   （施工图 = batch1-handoff §4-S7；spec 行号在该条目里）。

## 必读文档（顺序）

1. `journal/20260721 Architecture.md` — 人类 spec，pin 死不 re-litigate。
2. `docs/20260722-v04-batch1-handoff.md` — 路线图 + 现状地图 + 暗坑（§0 已更新到 S6 后状态）。
3. `docs/20260722-v04-s6-float-workpiece.md` — S6 报告：**§2 三个行为变化是真机沟通重点**
   （transform 期 Ctrl+Z=history、reject=identity 写回 stamp 保留、lift 即清选区），§5 是 S7 交接点
   （floatSourceCanvas 懒物化 = bridge 化的替换点）。
4. `docs/20260722-test-charter.md` — 历史 bug → 新架构保证的映射（S7 的 leaky-GPU 模拟测试维度在此）。

## 只在本会话、没进文档的琐碎

- worktree 里跑 tsc/test 需 `ln -s` 主 checkout 的 node_modules（S5/S6 都这么干的，完工删掉，别入 git）。
- `bump.sh` 用法照旧：`./bump.sh v0.4.8-YYYY-MM-DD`（AI 只准 bump patch）。
- S6 期间自查过的数据安全点（结论=安全，真机不用特殊照顾）：autosave（implicit）在 transient 中被
  `saveNow` 原有守卫跳过 → 不会把「挖了洞、浮层像素不在 doc」的状态偷偷落盘；显式保存/裁切/图库
  等入口都先 `applyPendingTransient`（= 先 accept）。
- 浮层期间切文档 = `input.clearHistory()` → `workpiece.dropFloats()` 直接弃浮层像素（旧版更糟，
  是引擎私有态悬空）；这是有意为之，别当 bug 修。
- 三个待人类拍板项（都别自作主张）：① accept 后选区去留（现状=清，spec:219 留了口）；
  ② reject 在 AA 软边的覆盖率损失若真机觉得刺眼（换方案与 spec「不要缓存」冲突）；
  ③ 点选图层是否入 undo（batch1 遗留）。

## Suggested skills

- `diagnose` — 真机 bug 批回来时逐条走（reproduce→minimise→问题陈述→修→回归测试）。
- `EnterPlanMode`（内置 plan 模式，非 skill）— S7 开工前的轻量 plan 用它，产出对齐
  batch1-handoff §4-S7 的实现级数据结构（pass 列表形状/缓存 key/pin 回调协议）。
- `simplify` / `/code-review` — S7 这种大片落完后的质量收口可选。
- 不需要 `pwa-cloud-store`（本纪元不碰 `src/store/**`；若真机 bug 牵到 store 红线区 → escalate human）。
