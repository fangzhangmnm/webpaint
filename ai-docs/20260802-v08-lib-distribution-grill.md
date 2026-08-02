# v0.8 E 骑士 · 抽库/分发机制科普与选项谱系（grill 记录）

> as-of 2026-08-02
> 性质：**科普+讨论记录，流派未选定、无拍板**。user 问「比起复制来复制去的土方，正规的开发手段是什么」，本文是回答的固化，供 E 骑士（gallery 共享库）和未来所有家族抽库（store 收敛、pwa pattern）开工前参考。
> 上游：`20260802-v08-recon-e-gallery-family.md` §4（byte-identical 考古：FORK-BASE 一次性戳、6 周漂成 32 文件全 differ）+ 拍板项 5（分发机制先补课）。

## user 的问题与直觉（2026-08-02 原意归纳）

- 现状 copy 来回是土方子；也许该让每个库成为 repo/package + 版本 pin 系统。
- 真诉求：**A 改库、B 不用立刻跟——B 攒了十几次修改之后才跳到最新版，慢慢想怎么接**。
- 「每个项目应该 pin 自己的版本，而不是引用一个大家都在改的文件夹。」

## 定性

这个直觉在正规世界有名字：**pinned dependency + immutable release**——整个包管理生态的默认哲学。土方唯一不正规的地方是**快照没有身份**（无版本号、无不可变性、无对账手段），而不是「复制」本身——复制 = vendoring，本身是正规手段之一。

## 四大流派谱系

1. **Registry + semver + lockfile**（npm 主流）：库发布不可变的 `1.2.3`；消费者声明范围、lockfile 钉实际版本；B 读 CHANGELOG 决定何时跳。自建私有 registry（Verdaccio）对 solo 是 overkill，不推荐——registry 不是必需品，见 2。
2. **无 registry 的 npm 原生玩法**：
   - **`npm pack` tarball**：库一条命令产出 `lib-1.2.0.tgz`；消费者 `npm i ../packages/lib-1.2.0.tgz`；**tarball commit 进消费者 repo = 同时满足家族 vendor 硬规则**；lockfile 钉版本，tsc/esbuild 走正常 node_modules 解析。
   - **git 依赖钉 tag/sha**（`github:you/lib#v1.2.0`）：零基建、精确 pin；但 install 要网、node_modules 不进 repo，与「物理进 repo」精神有摩擦。
3. **Vendoring 家族**（正规化的「复制」）：
   - **git submodule**：指针 pin，语义完美但**不是物理文件**（违 vendor 红线精神）+ UX 烦，不推荐。
   - **git subtree**：库文件**物理合进** app repo（红线满足）+ 真三方合并——B 跳版本 `git subtree pull` 真合并而非手对 diff；反向 `subtree push` 把在地修改流回库 repo。**唯一原生支持家族「流1」模式（引擎在 app 里在地开发、稳了回流 canonical）的方案**。代价：git 操作有学习曲线、冲突时绕。
   - **Go/Chromium 式 vendor 目录 + 版本戳**：= 现有土方 + 三件缺的东西（见建议阶梯 1）。
4. **Monorepo live-at-head**（Google 流派）：所有库+消费者一仓、人人用 HEAD、版本偏斜靠「一 commit 改库+全部调用点」消灭，前提是强 CI 全绿。这是「大家都在改的文件夹」的**正规化版本**——与「B 不立刻跟」的核心诉求正面相反。家族物理上像 monorepo（兄弟文件夹）但要的是 semver 群岛；**不选它是对的，不是没见识**。

## 家族自己的证据（选型时最硬的输入）

- **两个成功案例（icons、colors）的配方** = 库是 SSoT + 消费者 pull 一份**生成物快照** + 零共享源码语义。pull 那一刻就是天然 pin。
- **一个失败案例（sync-store）的死因不是缺 npm**：是「回流 canonical」这步手动、可跳过、无报警——六周 32 文件全漂而无人知晓（recon-e §4）。任何机制都不会替你执行 release，它们只是让 release 变便宜、让漂移变响。

## 建议阶梯（按投入排；未拍板，E 开工前选）

1. **起步（土方转正）**：每库自立 repo + git tag + CHANGELOG；消费者仍复制，但快照带三件新东西——① `LIB-VERSION` 戳文件（版本号+源 commit）② 同步走脚本不走手（`tools/lib-sync --pull v1.2.0`）③ **对账进测试**（`--check` = 本地快照 vs tag 逐字节 diff，漂了测试红）。保留全部现有优点（物理文件/零基建/AI 可执行）。
2. **npm 化**：库 `npm pack` 出 tarball，tarball commit 进消费者 repo，lockfile 钉版本。多一层 package.json 规范（exports/types），esbuild/tsc 接得更顺。
3. **真双向合并（引擎类库、流1 模式受益者：gallery/store）**：subtree。
4. **别做的**：自建 registry、submodule、live-at-head。

## 通用纪律（不分流派）

**release 必须是一条 AI 能跑的命令**（bump+changelog+tag+pack 一气呵成），否则回流又退化成「有空再说」。家族历史证明：**回流步骤的摩擦系数才是抽库成败的真变量，机制选型是第二位的。**

## 状态

- 流派未选定；与 recon-e「开工前拍板项 5（分发机制先补课）」对接——E 动工前从建议阶梯里选档。
- 同样适用于：store 收敛落地（ADR-0019/20/21）、未来 pwa pattern wizard 化。
