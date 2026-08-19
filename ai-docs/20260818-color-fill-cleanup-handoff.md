# color window + fill 模式整顿 · handoff

> as-of v0.9.2 / 2026-08-18。读者 = 接手整顿的下一个 AI session（不熟本仓也能进场）。
> 性质：考古已完成、施工未开始。user 原话：「我最想整顿的是之前 color window 没弄好欠的债，以及 fill 模式混乱的 ux」（journal/20260818 v0.9 feedback thread 2.md:22）。
> 完整考古底账 = `ai-docs/reports/20260818-color-fill-debt-archaeology.md`（**gitignored 仅本机**——换机器丢了就按本文 §2 的出处自己重挖，别信记忆）。

## 0. 进场状态

- main = origin/main = v0.9.2（2197449），工作区干净；prod = v0.8.48。发版 ritual / push 纪律见本仓 CLAUDE.md（新 session 第一批默认不 push，user 本 session 授权后可自动推 dev；prod 永远必问）。
- 本整顿与 0.10 混色纪元、AI 接入相互独立（宏观图景见 memory `project-webpaint-recap-20260818-macro`）。

## 1. 开工第一步 = 问 user，不是读代码

四个悬而未决的拍板项（2026-08-18 已呈报，user 说「这个也不用你管」留给你）：

1. **油漆桶 glitch 具体长什么样？** 这是 v0.9.0 开版时挂账的唯一活 bug，但**全仓语料零复现步骤、零现象描述**（仅 `ai-docs/20260812-v090-epoch-open.md:10-12` 转述 user 一句「油漆桶还是glitch，但是不在0.8处理」）。math/手感类禁猜测式调试——先拿到现象、立问题陈述，再动手。
2. **palette 色卡功能还要不要？**（journal/20260725 v0.6 feedback thread.md:311-312 一整段需求——跟文件走标 dirty/增删/左右排序/分隔符伪分组/批量接口/AI palette generation——从未进任何 backlog，掉缝了。）
3. **palette mixer 小窗半死态删不删？**（v87 实装 → v94 撤 UI 入口；`src/palette.ts` + `index.html` DOM 还在。）
4. **CLAUDE.md:12 的 `journal/cached feedback.md` 是 stale 路径**（文件不存在；实际反馈日志 = journal/ 下 16 个 per-version thread 文件）。修之前要 user 点头（家规文件）。

## 2. 债的底账（压缩版；出处都可自行复核）

**债 A · color window**：
- 核心债 = user「需要**重新设计一下 ux，之前思路不对**」+「UX 专门一层 grill 一个抽象模型（注意不是 UI）」（journal/20260808 v0.8 feedback thread 2.md:76）——C 批收敛时被降格成「顺便修退化」，**重新设计从未开工**（20260810-v08-stabilize-v09-foundation-handoff.md:65-75 明写归 UI 骑士侧「不现在设计」）。退化本体已修：v0.8.16 引入（T4c target 仅预览期）→ v0.8.24 修（扩 fill 全程）→ v0.8.29 补 commit 清。**真机未验**（总单 A4/B5/E1 空框）。
- 记名坑：一个色窗接多个 color、模态/非模态编辑（journal/20260802 thread 1.md:206-210 + ADR-0008 §6「文字多色/模态编辑=已记名坑」）——text tool 的前置。
- 杂质边：`fill-mode.ts → color-panel.ts` 侧向进 UI（recon-f :87,93 判「若进 core 该翻转」），未翻转。

**债 B · fill 模式 UX**：
- 设计本身**不混乱**：ADR-0004（fill=选区消费视图→第一类工具）已落地+四轮修订；mental model 终案=「两个不能互通的工具、实现共用一条 lasso 管线；进 fill=清选区、切走=commit+清，对称无特例」；v0.7.38「送入填色」是唯一 sanctioned 例外。**出入口语义被多份 handoff 标『一字不动』黄线**。
- 真欠的三样：① glitch 本体（见 §1）；② user 点名过两次的「fill 会不会突然变成 selection」**系统性混淆审计 + OO/继承设计 grill**（journal/20260725 v0.6:202）——只做过一次顺手修（v0.6.24），从未系统做；③ UX 抽象模型 grill（与债 A 同一件事，归 UI 骑士）。
- 结构残账：`lasso.ts` god file（826 行=套索手势+自由变换编排+算法三合一；C3.1 已析出 magic-wand.ts，拆户账本仍挂）。
- 真机锚悬空：总单 24 条全 `[ ]`（0.8 收官以「实战使用」代替逐条跑），fill/color 相关 E1/E2/C8/C9/C11/B5/E9——glitch 很可能从这里逃逸。

**勿 re-litigate**（ADR-0004 各修订节已记名否决）：surrogate layer、CPU fillOnLayer+golden、旧 v0.5 #22 三条红线、`_selMem` 共享记忆、Row1 油漆桶 toggle、精确 EDT watershed、减选独立橡皮；「进 fill 一律保留选区」=推翻 v0.6.24，需 user 重新拍板。

## 3. 架构面（摊开给你看，不派复核任务）

先自己独立画一遍风险地图再回头对这节（着眼点问句会锚定审查者——2026-08-18 勘误的教训）。这次整顿会摸到的接缝：

- 色板 target = `registerColorTarget` 注册制防环（color-panel.ts:13-18 / fill-mode.ts:166-169 头注释是现状 SSoT）；**笔刷色永不 undo** 是 T4c 锚。
- fill 预览/commit 走 workpiece v2 令牌纪律（ADR-0008：PendingFill 组件、commit=[tiles+selection 清+PendingFill 清]一步）。
- 整顿≠顺手做 UX 抽象模型 grill——那是 UI 骑士（D）的活，别在这次 scope creep 进去；但整顿产出的证据（混淆案例清单）是 D 的输入，记下来。

## 4. Suggested skills

- glitch 复现后 → `diagnose`（先问题陈述再插桩）。
- 若 user 决定做 UX 重设计 grill → `grill-me` / `grill-with-docs`（把 ADR-0004 黄线带进去）。
- 改动交付后 → `code-review`；涉及色板/fill 持久化字段改动前必须显式获 user 同意（memory 家规）。
