# editor-session —— domain glossary（架构用语 SSoT）

> 给本模块的概念命名。架构评审/重构按这里的词走。红线/用法见 README.md。

## editor-session（深模块）
一个 doc「从打开到关闭、保持同步」的生命周期编排者。app-agnostic：注入 `editor` 适配器 + `store`（消费）+ `policy`。**是 sync-store 的消费者，不创建 store。**

## editor（适配器，app 注入）
app 的编辑引擎暴露的最小面：`adopt(bytes)` / `encode()→bytes` / `onChange(cb)` / `thumb?()`。editor-session 不懂内容，只调这四个。**editor 绝不碰 store**（持久化对它透明）。

## 两种「脏」——**别混**（这是本模块存在的一半意义）
- **内存脏（memory-dirty）** = editor 自上次落盘后改过、还没 encode 落本地。**本模块 track**（`isDirty()`），app 层概念。驱动 autosave cadence。
- **sync 脏（sync-dirty / unpushed）** = 本地有字节还没推到云。**sync-store 的事**，读 `store.listAllItems` 的 syncState（unpushed/conflict）。**本模块不碰、不暴露**。
- 关系：`flushLocal` 把内存脏 → 落本地（内存脏清零，变成 sync 脏）；`flushAndPush` 再把 sync 脏推掉。「是否 dirty 该推」的**决策**是本模块 + policy 的事（按事件：退出/失焦/idle），不是查库。

## LifecyclePolicy（app 注入，app-agnostic）
autosave / push 策略——**每 app 不同**：`autosaveMs`（本地自动存间隔）、`pushOn`（何时 consent-push：exit/blur/idle）、`idleMs`。本模块给机制 + 通用触发点，时机由 policy 定。WebPaint = `{autosaveMs:180000, pushOn:["exit"]}`。

## consent-gated push（红线，继承 sync-store ADR-0016/0018）
opaque Work（画作/PDF-as-bytes）的 push 必须**用户 consent**（退出/Ctrl+S）。autosave **只 `flushLocal`（不推）**——自动推 opaque Work = 违反 consent。故 `save({tryPush:false})` 是 autosave 的唯一合法路径。

## StoreLike（结构类型）
editor-session 消费的 store 最小面（`file(name,{isZip}).{open,save,rename,delete}` + `reconcile?`）。真 sync-store 天然满足；测试可 mock（本模块的测试就是 mock store + mock editor，证 app-agnostic）。
