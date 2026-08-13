# JupyterLocal→WSL 全量迁移 + journals 备份 — grill 收束记录（动手日 SSoT）

> as-of 2026-08-13（grill session，全部 user 当场拍板；只讨论未动手）
> 上游：`20260810-v08-stabilize-v09-foundation-handoff.md` §4.0/§4.1/§5（本 doc 细化+部分 supersede §5 的"私仓"表述）

## 0. 摸底事实（2026-08-12 实测）

- `/mnt/d/JupyterLocal` 全量 49G；PWAProjects 仅 1.6G；**my_llama 41G（git 无 remote，distill 烧过真金白银，不可再生）**；
  TinyEncyclopediaSFT 5G（git+remote，但大文件是否都 push 了动手日要核）；其余零碎。
- WSL vhdx 本来就在 D 盘（`D:\WSL\Ubuntu\ext4.vhdx`，54G 现值 / 1007G 上限，盘内余 912G）→ 迁移=D 盘内部搬家。
- `~/JupyterLocal` 与 `~/jupyter` 现在都是 symlink（分别指 /mnt/d/JupyterLocal 和 OneDrive/jupyter）。
- journals 全家 13 夹 ~2.6M/51 文件；user 的 OneDrive 体系=人生领域分桶+YYYYMMDD 时间序+ARCHIVE 状态夹。

## 1. 拍板清单

1. **新根 = `~/jupyter`（全小写）**。删占位的旧 symlink（OneDrive 桶照走 `~/onedrive/jupyter`）；
   `~/JupyterLocal` symlink 迁移完删。**内层带空格日期名一律不动**（去空格是西化纪元的事）。
2. **旧副本**：拷贝+验证通过后立刻改名 `/mnt/d/JupyterLocal` → `/mnt/d/.JupyterLocal`
   （user 提案：旧路径响亮失效，杀掉残留旧应用/旧 session 的静默分叉）→ 观察期 1-2 周
   → git+remote 部分删（可 re-clone）；**无 remote 大宗（my_llama 等）长期留 NTFS 当冷快照**，
   清不清理随缘，风险敞口为零。
3. **vhdx 回收**：开 sparse（`wsl --manage Ubuntu --set-sparse true`），失败退手动 Optimize-VHD。
   此项 user 宣布不再内耗。
4. **third-party 检疫桶**（只约束增量，存量不整理）：
   - 规则一句话：**不是你写的也不是 AI 现写的字节，落 `~/jupyter/third-party/<来源名>/`**，项目里 symlink 引用。
   - **按可再生成本分楼层**：轻层（<10G 量级）住 ext4；**重层（大模型、烧钱 checkpoint）物理住 NTFS
     （如 `D:\assets\`）+ symlink 进 third-party/**——vhdx 里永远不放"再生要花银子"的东西
     （vhdx=单蛋篮，corruption 按全损规划；大文件顺序读走 DrvFS 性能可接受）。
   - 落家族 CLAUDE.md 两行（user：coding agent 时代就是一个 CLAUDE.md convention 的事）。
5. **透镜惯例（收窄版）**：`.code-workspace` 多根工作区解决"一次 session 横跨多个家"
   （例：Pauli Twirling + weekly report to Vito）。**只配给活过几周的重项目**——
   30 分钟项目的诞生仪式必须是零，任何 symlink/接线模式对启动有毒（user 原话裁定）。
6. **yyyymmdd 体系裁定**：它是 append-only 事件日志不是分类法，写入零决策+新近=相关+日期是跨桶外键，
   polymath 对症；真实弱点只有"不记死亡"（ARCHIVE 夹手动补丁+冷备份兜底）和"横切关系"（透镜层解）。
   **不迁 PARA 类语义分类系统**。

## 2. journals 备份 — 终案（per-atom auto-git）

设计演化（记下来防 re-litigate）：OneDrive rsync 镜像案 → 全量 overlay 隐形仓案，**都被 user 否**。
否决理由是架构级的：user 体系不变量="文件夹=原子"（独立移动/归档/弃坑/删除），
全局 overlay 是横跨所有原子的隐形全局状态，违反原子性。终案：

- **每个 `journal{,s}/` 自己是一个微型 git 仓**（`journal/.git`），remote = OneDrive 每原子一个 bare 仓：
  `onedrive/jupyter/journal_backups/<项目名>.git`，`gc.auto=0`（对象库纯追加，OneDrive 同步友好）。
- **零仪式**：init 全自动——**AI ritual 全量扫 `~/jupyter` 找 journal 夹，缺 .git 就补建+建 remote+push**
  （user 拍板：「A这个可以ai ritual。ai全量扫然后补建」）。30 分钟弃坑项目自动覆盖。
- **原子性**：remote 地址在原子自己的 `.git/config` 里随夹走→改名/搬家免疫；删项目→bare 仓留（删除不传播）；
  想抹掉某项目历史→删那一个 bare 仓，其他原子无关（独立可查、独立可毁=焦虑的真解药）。
- **硬规则 #2 精确化（user 同意）**：AI 可跑机械脚本（逐字节、只增、commit+push），源 journal 内容零碰；
  这不算 AI 写日记。
- **大文件哨兵**：>10M 的 journal 文件只警告不自动 commit（git 历史吃进去吐不出来）。
- **护栏**：不进全局 CLAUDE.md（user：「我自己记着就行」）；deadman=bare 仓最后 commit 龄，
  AI ritual 是主触发；build.sh ritual / cron 兜底可选，未强制。
- **信任面零扩张**：全走 OneDrive（Microsoft 本来就持有 user 日记），不引入 GitHub 私仓。
- 双副本构造性成立：工作侧 journal/.git 带全量历史，bare 仓炸了不丢，反之亦然。
- **送命题（journal 公开与否）继续挂起**，§5 的"公开=从干净快照另立公仓"原文不动。本案与其完全解耦。

## 3. 未拍板 / 动手日待办

- **charter 边界未拍**：per-atom 体系只收 journal{,s}/，还是也收其他夹缝人类手工
  （PWAProjects 根的家族 CLAUDE.md——现在裸奔无 remote；各项目 gitignored 的 `甲方需求/`）。
  家规备份的家（MyPWAPatterns vs family-meta 小仓）未拍。user 说自己记着，AI 勿自作主张。
- 动手日 checklist：选不干活的时点；rsync 跑两遍（第二遍追增量；AvgDump 类热文件夹注意）；
  Claude meta 迁移按 §4.1（slug 改名+绝对路径 grep+新 session 验证记忆/技能/权限后才删旧副本）；
  TinyEncyclopediaSFT 核实 remote 覆盖率；`.claude/worktrees` 等仓内 meta 一并随仓走。
- sweeper 脚本的家：MyPWAPatterns（家族工具 canonical 位）——建脚本时落位。
