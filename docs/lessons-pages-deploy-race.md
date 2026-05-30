# 教训：GitHub Pages deploy race（main+prod 同 push）

## 现象（v130 踩到的）

我 push main 之后立刻 merge → push prod。两个 workflow 几乎同时触发。GitHub Actions 两边都 success，但 prod 的根目录 (`https://fangzhangmnm.github.io/webpaint/`) 仍然 serve **旧 prod tree 的内容**（旧 hash bundle），而新 hash bundle 在 prod 分支里明明存在，URL 取也 404。

## 根因：concurrency 队列 + checkout 时机 + Pages 单 deploy 槽

我们的 deploy.yml 有：

```yaml
on:
  push:
    branches: [main, prod]
concurrency:
  group: pages
  cancel-in-progress: false   # ← 元凶
```

`cancel-in-progress: false` = 新触发的 workflow 排队等前一个跑完。

实际时间线：

```
T+0    push main         → workflow A 触发，runner 起来
T+1s   workflow A: checkout prod
       ← 这一刻 prod 还是旧 tip（我还没 push prod）
T+10s  push prod         → workflow B 触发，被 A 占着 group 排队
T+15s  workflow A 拼装 site/：
         site/index.html、site/dist/* 都来自旧 prod tree
       upload-pages-artifact + deploy-pages
       → Pages 切到 A 的 artifact，根路径 = 旧 prod ✓
T+30s  workflow A 完成，workflow B 解锁
T+35s  workflow B: checkout prod
       ← 这次拿到新 prod tip
       拼装 site/，正确内容
       upload + deploy
       → 但 Pages **静默 collapse** 掉了 B 的 deploy
          （GH Pages 对同 environment 的连续 deploy 有自己的 dedup / 不告诉你）
```

A 的 success 是真 deploy；B 的 success 是 Action 步骤层面 success，但 Pages 实际并没切到 B 的 artifact。结果：根路径卡在 A 部署的旧内容。

dev (/dev/) 没事，因为 main-tree 在 A workflow 里 checkout 时已经是新的。

## 关键认知

1. **`actions/checkout@v4 ref: prod` 是在 step 执行时拉 prod 当前 tip**，不是 workflow 触发时的 snapshot。若 step 跑在 push 之前，拿到的就是旧 tip。
2. **GH Pages 同 environment 不接受并发 deploy**。多个 deploy-pages 同一 env 队列里，可能只第一个生效。official 文档说"only one deployment can be active per environment"，但什么时候 collapse、collapse 哪个，没明确。
3. `concurrency.cancel-in-progress: false` 意图是「保护正在 deploy 的工作不被打断」，但跟 #2 一组就变成「锁死第一个赢家」。

## 修法：cancel-in-progress: true

```yaml
concurrency:
  group: pages
  cancel-in-progress: true   # 改这里
```

新语义：B 触发时若 A 还在跑就**取消 A**。B 重新跑，此时 prod 早已 push 上去，checkout 拿到对的 tip，部署对的内容。

副作用：连续 push（调代码 1 分钟 push 3 次）只最后一次 deploy 生效。对 dev/ 这无所谓——中间状态本来就没人看。

这种 race 不会再咬人。

## 救活已经搞砸的 deploy

如果已经踩进去（live 还显示旧内容）：

```bash
# 切到出问题的分支，push 个 empty commit 强制重 deploy
git checkout prod
git commit --allow-empty -m "force redeploy"
git push origin prod
git checkout main
```

新 workflow 跑一遍，prod tree 已稳定到正确状态，deploy 一次就好。

## 相关阅读

- [docs/dev-prod-split.md] dev/prod 分支策略论证（如果有的话；workflow 注释提到了）
- GitHub docs: <https://docs.github.com/en/actions/using-jobs/using-concurrency>
- actions/deploy-pages 行为：<https://github.com/actions/deploy-pages>

## 适用范围

任何用 **action 部署到 GH Pages 的多分支 repo** 都该用 `cancel-in-progress: true`，除非你确实需要"上一个 deploy 跑完再排下一个"且能接受静默 collapse 风险。sibling family 的其他 PWA 用同 deploy 模板的也都需要改。
