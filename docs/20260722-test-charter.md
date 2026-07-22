> as-of v0.4.0 / 2026-07-22

# WebPaint v0.4 渲染/Undo 重构 — 测试宪章（test charter）

本文档挖掘历史 bug 报告，把每一个"曾经掉过的坑"钉到**新架构的哪条保证负责堵它**，再给出可在
node runner 里跑的回归测试草图，最后给每个新模块列测试维度。

**读者提醒**：本轮正在从零写 `src/tiles/cpu-tile-pool.ts`、`src/workpiece/workpiece.ts`、
`src/workpiece/undo-history.ts`、`src/background-sync-jobs.ts` 等模块（写作本文时**尚不存在**）。因此
(b)(c) 里所有 API 形状都是**根据 spec 推断**，凡我拿不准的都标 `【ASSUMPTION】`，让实现者对账后再定。

**引用纪律**：每条声明都带 `文件:行` 出处。spec 指
`journal/20260721 Architecture.md`（人类手写规范，本轮的宪法）。找不到出处的地方我明说"无出处"，不编。

---

## 术语速查（新架构名词 → 出处）

| 名词 | 一句话 | 出处 |
|---|---|---|
| workpiece | 薄聚合容器，运行时数据，无持久化责任，有 isDirty；写必须过 document-operator | spec:7-35 |
| document-operator | 改 workpiece 的唯一入口；抽象接口，**每个操作都有逆元**；同步+上锁 | spec:52-75 |
| undoPackage / redoPackage | operator 产出的内存逆元对象，`getEstimatedQuotaUsage()`，不可序列化 | spec:55-63 |
| undo-history | 按 `maxQuotaBytes` 驱逐；microstep + checkpoint；reference gallery 不进 | spec:86-93 |
| cpu-tile-pool | 256² 只读 tile；unique monotonic id；acquire/release 引用计数；CPU 是 SSoT | spec:94-107 |
| cpu-tile-compression | 副线程/background-sync-jobs 压缩；raw 超配额则阻塞式压缩 | spec:112-118 |
| gpu-tile-pool | 只读；**永不保证 pin**，随时 evict/invalid；是 render-tree 的**纯缓存**非 SSoT | spec:160-177 |
| cpu-gpu-tile-bridge | cpu↔gpu tile 转换 + 对应关系登记的唯一入口；batch only | spec:178-186 |
| render-tree | 纯 view，合成；gl-context-lost / gpu-evict 时自愈 | spec:123-159 |
| background-sync-jobs | 空闲判断深模块；无 threading 时承重；优先级 + quota 表 | spec:248-253 |

---

## (a) 历史 bug 目录

每行：历史故障 → 旧架构里的根因 → 新架构里**具体哪条保证**杀它。overlap 的条目我标了"与 #x 同族"。

### H1 — 撤销更改 / Revert 是死功能

- **现象**：菜单"撤销更改（Revert）"永远报"无快照"，到处坏（非仅离线）。
- **旧架构根因**：`_store.seal` 被删后 checkpoint 读写全成 stub → 没有可回滚的快照。
  出处：`journal/WP feedback arch.md:482`、同文件 bug 表 `:1133`（锚 `session-state.ts:195`）。
  更深一层：autosave/灾难恢复从来没有独立于 store 的模块，checkpoint 责任散在 store 里被一起删掉。
- **新架构杀它**：autosave/灾难恢复是独立 checkpoint 模块，**ora 格式跨版本鲁棒、写成功了再删旧的**、
  min 时间周期、user save / 进出 workbench / tab 后台事件都 checkpoint，且**不许弄错 isDirty**。
  出处：spec:36-44。→ revert = 读最近 checkpoint 重建 workpiece。
- **配套云侧坑（同族，autosave 完整性）**：
  - R4 revert 绕过 clean→dirty 门 → 快进无备份吃掉 revert 结果。出处：`docs/reports/20260610-cloud-data-safety-audit-v228.md:35-39`。
  - K10 autosave 写盘中 Ctrl+S 被静默丢弃、谎报已推。出处：同文件 `:54`。
  - 这两条是"autosave 落盘/dirty 记账"层面的完整性坑，spec:41-44 的"阻塞锁写不锁读 + 别弄错 isDirty"是对口保证。

### H2 — 图层组操作 corrupt editor history（含 "layer not synced:92"）

- **现象**（人类原话）："有 group 相关操作的时候会 corrupt editor history，比如 uncaught error
  `layer not synced:92`，我点了清空 layer 之后也 undo 失败了。" 出处：`journal/WP feedback arch.md:1338`。
  人类在同处**明确要求架构层面强制保证每个 operator 实现 undo**（或确认 pixel-edit 是否已托底）。
- **旧架构根因（三重）**：
  1. **operator 无逆元强制**：α 命令模式靠各模块自觉注册 handler，图层组 op 同时碰多个图层，
     中途某步抛异常 → 前几步已改、undo 栈指向一个**从未存在过的状态**。旧 undo 设计见
     `docs/20260527-undo-architecture.md`（handler 注册分散、纪律靠人守）；当前实现
     `src/history.ts`（UndoStack α 形态，`max=50`，无事务/回滚语义）。
  2. **`layer not synced:92` 的确切来源**：`src/gl/gl-doc-renderer.ts:291`
     `throw new Error("LAYER_NOT_SYNCED:${leaf.id}")` —— GL 合成时叶子图层不在 sync 表里就抛。
     92 是**数字图层 id**（见 H4）。这是一个**未捕获异常打断 op 中途**，把 history 留在半损坏态。
  3. 异常发生后 undo 栈**照旧被使用** → 后续 undo 崩/污染（见 H6）。
- **新架构杀它**：
  - **每个 operator 保证原子性 + 可逆性**（抽象接口强制 forward/backward + undoPackage）。出处：spec:52-64。
  - **事务回滚协议**：容器边做边攒逆元，任一 microstep 失败就把已攒逆元倒着施加回去，
    对外像什么都没发生，**报错、不写 undo history**。出处：`journal/WP feedback arch.md:1728-1731`、spec:66、spec:92。
  - **不可恢复错协议**：无法原子回滚 = full undo stack corrupted → discard all + workpiece
    integrity-check & autoheal + ui error banner。出处：spec:65、`journal/WP feedback arch.md:1777`。
  - **render-tree 自愈**：GL desync（LAYER_NOT_SYNCED 的病根）不再是致命异常——gpu tile missing
    是日常事件，render-tree 从 active-session 重新合成。出处：spec:156。

### H3 — 清空图层后 undo 失败（H2 子集，单列因回归点独立）

- **现象**：见 H2 引文"点了清空 layer 之后也 undo 失败"。`journal/WP feedback arch.md:1338`。
- **旧架构根因**：clear 的历史语义是"不可撤销，烧掉"——旧策略文档明说 clear button =
  `clearActiveLayer + clearHistory`，**不进 undo**。出处：`docs/20260526-undo-strategy.md:56`。
  于是 clear 之后 undo 栈已被清或与图层实际状态错位 → undo 失败。当前 `src/doc.ts:798` 仍有
  "清空当前 layer 像素（不删 layer）"的裸操作。
- **新架构杀它**：active-session 里能被用户认作"我的画"的一切都必须可 undo（undo 从 active-session
  接口契约上长出来）。出处：`journal/WP feedback arch.md:1685`。clear = 一个 upsertTile 类
  operator，被清掉的旧 tile 句柄进 undoPackage（spec:77-81 upsertTile 样例：`undoData=旧 tile`）。

### H4 — Undo 多米诺骨牌效应 / 图层 id 复用

- **现象**：undo 错误的"多米诺骨牌效应"。人类原话："图层 id 必用 UUID，解决 undo 错误的多米诺骨牌
  效应，必做。" 出处：`journal/WP feedback arch.md:1520`（另 `:1460/1577/1588`）。
- **旧架构根因**：图层 id 是**数字单调计数器且会复用**。当前 `src/doc.ts:18`
  `let _layerIdCounter = 1`，`:119`/`:249` `this.id = _layerIdCounter++`。旧 undo 设计更进一步
  **主动让删掉的层"用同一个 id 复活"**（`docs/20260527-undo-architecture.md:139` layerSpec
  `id: 12  // **同一个 id 复活**`、`:151` "关键：layer id 不变"、`:154` 取消 `dropHistoryForLayer`）。
  → 一旦某 id 被两个不同生命周期的图层用过，undo entry 里 `refsLayer(id)` 就会作用到**错误的层**，
  一步错步步错 = 多米诺。`LAYER_NOT_SYNCED:92`（H2）正是"undo 指向一个 sync 表里已不存在的数字 id"的症状。
- **新架构杀它**：layer 运行时生成 **non-colliding uuid（session 内部单调计数器，永不复用）**；
  hierarchy 存 id，layers 按 id 管 tile；ora 文件里才用数字 id（向后兼容），uuid 是 session 内部身份。
  出处：spec:16、spec:51。→ 复活的层拿新 uuid，旧 undo entry 找不到就是找不到，不会张冠李戴。

### H5 — active-session 与 undo-history 共享 / 别名同一个 tile

- **现象**：无独立 bug 报告，是人类在契约阶段**预防性画的红线**（tile 重构最容易踩）。
- **旧架构根因**：诱惑在于复用 GPU arraybuffer 或图层管理系统来替 undo 省存储。人类点名批判这种
  "拿一个不被回收的 pin 兜底"的隐性契约。出处：`journal/WP feedback arch.md:1424-1431`。
  若 active layer 和 undo 副本指同一块内存，in-place 编辑会**同时改掉 undo 记录** → undo 还原出垃圾。
- **新架构杀它**：
  - **严禁** active-session 和 undo-history 引用同一个 tile；可以**指针转让**（不 memcpy、地址不变）
    但两者**交集必须为零**，写 straightforward，别玩树根花活。出处：`journal/WP feedback arch.md:1630`。
  - tile **只读**、unique monotonic id、**acquire/release 显式引用计数**、用已释放句柄立刻抛错。
    出处：spec:97-101、`journal/WP feedback arch.md:1668-1671`。
  - CPU tile 是 SSoT（raw vs compressed），不与 GPU tile 绑定。出处：spec:102、spec:166。

### H6 — 未预期异常后 undo history 损坏仍被使用

- **现象**：H2 的收尾病理——异常打断后 undo 栈半损坏但照旧被 undo/redo → 崩溃或二次污染。
- **旧架构根因**：无"异常发生后该丢什么"的协议。GL context lost（tab 后台一下）也会误伤 undo。
- **新架构杀它**（两档，别搞混）：
  - **合规错**（可原子回滚）→ operator `return {success:false, reason}`，undo 栈安全。出处：spec:66、
    `journal/WP feedback arch.md:1777` "operation not performed (reason string)"。
  - **未预期错**（无法保证原子性，罕见）→ throw → 触发**从 active-session 重建 render-tree +
    清空 undo history + 弹窗报错**（相当于重启，此时 undo history 不可信）。出处：spec:67、
    `journal/WP feedback arch.md:1777`、`:1793`。
  - **GL context lost 特例**：应尽量做成**可恢复**（atoms resilient to GL context loss），
    用 RAM tile 兜底，**不因单纯 context lost 就丢 undo**——只有当异常使原子性无法保证时才丢。
    出处：spec:68、`journal/WP feedback arch.md:1778-1779`、`:1792-1793`。

### H7 — 液化选区 mask 按 layer.bbox 烤的"半拉" bug（**当前 live bug**，本轮交接）

- **现象**：有选区时，把内容推出旧 layer.bbox 边界的液化笔迹，越界那半被当成"选区外"不液化 = 半拉。
  出处：spec:268（交接指令）、人类 `journal/WP feedback arch.md:333` "for liquify, its a
  degeneration"。
- **旧架构根因（已读代码确证）**：
  1. mask 被烤进一个**与 layer.bbox 对齐、尺寸 = `layer.bboxW × layer.bboxH`** 的数组。
     出处：`src/plugins/liquify-engine.ts:96-107`（`lbW/lbH = layer.bboxW/H`，maskData 按此尺寸 getImageData）。
  2. `cellIn(ix,iy)` 对**落在 [maskX, maskX+maskW) × [maskY, maskY+maskH)（即 layer.bbox）之外**的
     cell 一律返回 `false`。出处：`:178-182`。
  3. 但 v363-364 把 footprint 和 dispField **夹到 doc 边界（不是 layer.bbox）**——tile 时代
     `layer.ensureBbox` 已是 no-op，靠 bbox 夹会截掉推出旧内容边的像素（原本就是修一个 degeneration）。
     出处：`:141-146`、`:153`。
  4. 结果：dest 像素 `(wx,wy)` 落在旧 layer.bbox 外时 `inMask(wx,wy)` = false →
     `src/plugins/liquify-engine.ts:238` 走"dest 在选区外 → 不液化，原像素直采"分支。**doc 空间里明明在选区内的
     像素，因为落在旧 layer.bbox 外被误判为选区外。**
- **新架构杀它**：selection-mask 是 workpiece 里的**单通道 tile 层、进 undo history**——即
  **doc 空间**（tile 按 doc 坐标寻址），不再与某个图层的 bbox 对齐。出处：spec:18、spec:208-210
  "selection-mask 是 8-bit cpu tile pool"。→ mask 判定与 layer.bbox 解耦，边界 degeneration 消失。
  **注意**：液化本身要在后续 slice 重写（迁 GPU / filter-brush 抽象类，spec:206-207）；本轮只保证
  **数据结构（doc-space mask tile）**就位，H7 的回归测试现在会 **RED**，液化重写后转 GREEN（见 (c)）。

### H8 — Undo 内存爆炸（历史 OOM 压力）

- **现象**：非崩溃 bug，是长期内存压力。旧 snapshot 链 20 步 = 320MB。出处：`docs/20260526-undo-strategy.md:7`、`:24-33`。
- **旧架构根因**：整图 ImageData 快照链，或 α 命令模式每 stroke 存 PNG。无按字节的配额驱逐。
- **新架构杀它**：undo-history **按 `maxQuotaBytes` 驱逐**；`getEstimatedQuotaUsage()` 每次 push 扫一遍
  （压缩前 tile 记 0、走 uncompressed tile 总池不额外占 undo 配额，压缩后被 undo own、usage 才涨）；
  **只数压缩后字节**，raw 超额由 tile hot quota 兜底（强制压缩）。出处：spec:86-89、
  `journal/WP feedback arch.md:1707-1709`、`:1723`。

---

## (b) 回归测试清单

针对**正在写**的新模块。每条 = 测试名 + setup + 断言。API 形状 `【ASSUMPTION】` 标注，实现者对账后改。
运行位：全部**可在 `node test/run.mjs` 里跑**（纯数据/句柄逻辑，无 GL）。GL 侧另见 (c) 的 leaky-gpu 与 smoke。

> 接入方式（沿用现有 runner）：新建 `test/cpu-tile-pool.test.mjs` 等，
> `import { describe, it, assert, eq } from "./runner.mjs"`，在 `test/run.mjs` 里加一行 import。
> 未实现的规格用 `todo("...")` 挂红线清单（runner 支持，见 `test/runner.mjs:15`）。

### 对 H4（id 多米诺）→ workpiece / hierarchy

- **`layer uuid 单调不复用`**
  - setup：new workpiece；`op.addLayer()` ×3 记录返回的 id；`op.removeLayer(id2)`；再 `op.addLayer()`。
  - 断言：4 个 id 全不相等；删除后新建的 id **不等于**任何历史 id（含被删的 id2）。
  - 【ASSUMPTION】addLayer operator 返回新层 uuid / status。spec:16 只保证 non-colliding+monotonic，未定 API 名。
- **`undo 复活的层拿新 id，旧 entry 不误伤`**
  - setup：addLayer→得 idA；stroke on idA（进 undo）；removeLayer(idA)（进 undo）；undo（复活）。
  - 断言：复活层 id ≠ idA（**否决旧 `docs/20260527-undo-architecture.md:151` 的"同 id 复活"**）；
    对复活层再 undo（撤 stroke）作用到正确的层，不抛 LAYER_NOT_SYNCED。

### 对 H5（tile 别名）→ cpu-tile-pool

- **`active 与 undo 的 tile 交集为零（指针转让后源失效）`**
  - setup：pool.acquire 一个 tile 句柄 h；op.upsertTile 覆盖它 → undoPackage 应**接管旧 tile 句柄**。
  - 断言：workpiece 现在持有的 tile id ≠ undoPackage 持有的 tile id（zero intersection，`journal:1630`）；
    对旧句柄再操作立刻抛错（use-after-transfer）。【ASSUMPTION】"指针转让"= 句柄所有权移交，源句柄失活。
- **`只读 tile：写已 seal 的 tile 抛错`**
  - setup：`t = pool.allocate(); fill(t); t.seal();` 然后尝试写 t。
  - 断言：抛错。出处依据 spec:97 "tile 只读"、spec:110-111 allocate→seal 转不可变。
- **`用已释放句柄立刻抛错`**
  - setup：`h = pool.acquire(id); h.release();` 然后 `h.readInto(buf)`。
  - 断言：抛错（spec:100 "用已释放的句柄立刻抛错"）。
- **`引用计数：release 到 0 才真回收，非 0 不回收`**
  - setup：acquire 同一 id 两次（refcount=2）；release 一次。
  - 断言：tile 仍可读；再 release，第三次 acquire 该 id 应 miss/需重建。【ASSUMPTION】refcount 语义 spec:99。
- **`FinalizationRegistry 泄漏断言（node 有 gc 时）`**
  - setup：acquire 一个句柄，丢弃引用不 release，`global.gc()`（node `--expose-gc`）。
  - 断言：FR 回调报告"句柄未 dispose 就被 GC = 泄漏引用计数"。出处：spec:101。
  - 标注：node 无 `--expose-gc` 时 `todo(...)` 挂起，别硬跑。

### 对 H8（配额驱逐）→ undo-history

- **`按 maxQuotaBytes 驱逐到整 checkpoint`**
  - setup：undoHistory(maxQuotaBytes=N)；push 若干带 checkpoint 标记的 microstep 直到超 N。
  - 断言：驱逐后剩余项**边界落在 checkpoint 上**（spec:91 "驱逐必须到整 checkpoint"），
    quota ≤ N。
- **`getEstimatedQuotaUsage 随压缩上涨`**
  - setup：push 一个含未压缩 tile 的 undoPackage；读 usage；触发压缩；再读 usage。
  - 断言：压缩前该 tile 计 0（走总池）；压缩后被 undo own，usage 上涨。出处：spec:88-89。
  - 【ASSUMPTION】undoPackage 暴露 `getEstimatedQuotaUsage()`（spec:62），压缩状态可注入/mock。
- **`microstep 无 checkpoint 时补一个 + warning`**
  - setup：push microstep 不带 checkpoint marker；undo。
  - 断言：undo 补一个 checkpoint 并 emit warning（spec:91 "原则上不应该，弹 warning"）。

### 对 H2/H6（operator 原子性 + 异常协议）→ document-operator / workpiece

- **`microstep 中途失败 → 全回滚 + 不写 undo`**
  - setup：合成 operator 含 3 microstep，注入第 2 步抛"可原子回滚"错。
  - 断言：workpiece 状态 = 操作前（byte-equal）；undo-history 长度不变（没写进去）；返回 success=false + reason。
    出处：spec:66、`journal:1728-1731`。
- **`不可原子回滚异常 → discard 全栈 + integrity heal + banner 标志`**
  - setup：注入一个"无法回滚"的 throw。
  - 断言：undo-history 被清空；workpiece 跑过 integrity-check（autoheal 钩子被调）；error banner 状态置位。
    出处：spec:65、`journal:1777`。【ASSUMPTION】banner 用可观测的状态/回调，非真 DOM。
- **`同步锁：读写不重入`**
  - setup：在一个 operator 执行中途（mock 内）尝试再开一个 operator 写，或读裸内部。
  - 断言：抛"workpiece 已锁"。出处：spec:69-71（两层保险：operator 必同步 + 上锁；读也不行，但有导出 escape hatch）。
- **`GL context lost 兜底不丢 undo`**（node 用 mock tile provider 模拟）
  - setup：undoPackage 的 tile 只在 GPU；模拟 gpu-tile-pool 报该 tile invalid；对该 package 做 undo。
  - 断言：从 CPU/RAM tile ssot 重建、undo 成功、**undo-history 未被清空**（区别于 H6 的真异常）。
    出处：spec:68、`journal:1792-1793`。
  - 标注：这是 leaky-gpu 全量模拟的一个切片（见 (c)）。

### 对 H1（autosave/checkpoint）→ background-sync-jobs / checkpoint

- **`checkpoint 有最小周期，不每次空闲都写 idb`**
  - setup：background-sync-jobs 注入假时钟；连发多次空闲触发，间隔 < 最小周期。
  - 断言：checkpoint handler 实际落盘次数 ≤ 预期（受 min period 节流）。出处：spec:42。
- **`写成功再删旧 checkpoint`**
  - setup：mock 存储；写新 checkpoint 时注入失败。
  - 断言：旧 checkpoint 仍在（未先删）；isDirty 未被错误清掉。出处：spec:39、spec:44。
- **`revert = 读最近 checkpoint 重建 workpiece`**
  - setup：编辑→checkpoint→再编辑（未 checkpoint）；revert。
  - 断言：workpiece 回到 checkpoint 态；此路**不复现** H1 的"永远无快照"。出处：spec:36-40、H1。
  - 【ASSUMPTION】checkpoint 模块归属未定（spec:26/263 说要在整理 workbench-session 时想清楚）——
    测试挂在"能读回最近 checkpoint"这个行为契约上，不绑具体模块名。
- **`按优先级调 handler，input event 插队后停在跑完当前`**
  - setup：注册两个不同优先级 handler；quota 表给定；模拟 input event 插队。
  - 断言：高优先先跑；quota 用完或插队时**跑完当前 handler 后停**；循环类 request-next 放队尾。出处：spec:249-253。

### 对 H7（液化边界）→ 见 (c)，现在 RED

液化选区边界测试不针对上述四个新模块，而针对 selection-mask 的 doc-space 契约 + 液化重写。
**现在写下来会 RED**（液化仍按 layer.bbox），液化迁 GPU/filter-brush 后转 GREEN。详见 (c) 末节。

---

## (c) 新模块测试计划（每模块的测试维度）

### cpu-tile-pool（`src/tiles/cpu-tile-pool.ts`）

| 维度 | 要点 | 出处 |
|---|---|---|
| 身份 | unique monotonic id；开新文档/reload 清空池 | spec:97, spec:107 |
| 只读 | allocate→写→seal→不可变；写已 seal 抛错 | spec:97, spec:110-111 |
| 引用计数 | acquire/release；用已释放句柄抛错；refcount>0 不回收 | spec:99-100 |
| 泄漏断言 | FinalizationRegistry：未 dispose 被 GC → 报泄漏（仅 assert，非析构） | spec:101 |
| 位深 | 32/8/1 bit（1bit 在 GPU 变 8bit）往返 | spec:105 |
| bbox 派生 | 每 tile 顺带算 bbox；全局 bbox = 对 tile bbox 求 aabb | spec:106, spec:1726 |
| 零拷贝 GPU 对接 | allocate 返回可写 buffer + 句柄，GL 填完 seal；texSubImage3D 吃 Uint8Array 视图 | spec:108-111 |
| 配额 | raw tile 超 raw quota → create 时**阻塞式压缩**（宁可卡顿） | spec:116 |
| **别名红线** | active 与 undo 的 tile **零交集**；指针转让后源句柄失活 | journal:1630 |

### cpu-tile-compression（`src/tiles/cpu-tile-compression.ts`【ASSUMPTION 文件名】）

| 维度 | 要点 | 出处 |
|---|---|---|
| 副线程/降级 | 有 worker 走 worker，无则走 background-sync-jobs 循环小原子 | spec:113 |
| 顺序 | 按创建顺序**从最古老到最新**压缩（tile 只读，可压到最新） | spec:115 |
| 阻塞压缩 | raw 超配额时 create-tile 触发同步压缩 | spec:116 |
| 手动 compact | 暴露 app 酌情调（内存压力/保存/切 app/开大文档前），非 user UI | spec:117-118 |
| PNG 算法 | 不走 canvas；对二次元典型内容（大片空白/线稿/纯色/渐变/厚涂/照片）压缩率与正确性 | spec:119-122 |
| 往返无损 | 压缩→解压 byte-equal | spec:112（"tile 只读"隐含无损） |

### workpiece + operators（`src/workpiece/workpiece.ts`）

| 维度 | 要点 | 出处 |
|---|---|---|
| 私有边界 | 内部数据模块私有；只有 operator 子类经 `mut(doc)` 拿 mutable 视图，其他路径拿不到 | spec:72-75 |
| 锁 | 一次只一个 operator 写；同步；读也不并发（有导出 escape hatch） | spec:69-71 |
| 逆元完整 | 每个 operator 有 forward/backward + undoPackage；undo→redo→undo 往返一致 | spec:52-64 |
| 原子回滚 | microstep 失败倒放已攒逆元；success=false；不写 undo | spec:66, journal:1728-1731 |
| 不可回滚协议 | throw → 清 undo + integrity heal + banner | spec:65, journal:1777 |
| 样例 op | upsertTile（旧 tile 进 undoData）、invertibleTransform（in-place 无 data、pixel-perfect）、crop/extension、hierarchyOperation（active/reference 层处理） | spec:76-85 |
| id | layer uuid 单调不复用；hierarchy 存 id | spec:16, spec:51 |
| isDirty | 编辑置 dirty；checkpoint/save 别弄错 | spec:8, spec:44 |
| 选区 | selection-mask 单通道 tile 层、**doc 空间**、进 undo | spec:18, spec:208-210 |
| float | lift/transform-metadata/stamp/accept/reject 各步进 undo（reject 非 undo=回滚 transform，pixel-accurate identity 写回不走 warp 采样器） | spec:212-225 |

### undo-history（`src/workpiece/undo-history.ts`）

| 维度 | 要点 | 出处 |
|---|---|---|
| 配额驱逐 | 按 maxQuotaBytes；驱逐到**整 checkpoint** | spec:87, spec:91 |
| usage | getEstimatedQuotaUsage 每 push 扫；压缩前 0、压缩后涨；只数压缩字节 | spec:88-89, journal:1707-1709 |
| microstep/checkpoint | 多 microstep 进一个 checkpoint；undo 一次到整点；无 checkpoint 补一个+warning | spec:90-91 |
| 纯数据结构 | undo 退化成互逆算子库的消费者，不 own tile 生命周期（借句柄） | journal:1685-1695, journal:1802 |
| 不进栈 | reference gallery 不进 undo/redo | spec:93 |
| 序列化 | undo/redoPackage 是内存对象，**不支持持久化** | spec:63 |

### background-sync-jobs（`src/background-sync-jobs.ts`）

| 维度 | 要点 | 出处 |
|---|---|---|
| 空闲判断 | 统一深模块；各模块注入 callback 带优先级；一模块可注册多 handler | spec:249 |
| 无 threading 承重 | 不支持 worker 时它承载压缩/checkpoint | spec:250, spec:113, spec:40 |
| quota 表 | 停顿后第 x 秒给 y ms quota | spec:251 |
| 调度 | 按优先级；quota 用完或 input 插队 → 跑完当前再停 | spec:252 |
| 循环 handler | request-next-iter 放队尾 | spec:253 |

### gpu-tile-pool（未来 slice；`src/tiles/gpu-tile-pool.ts`【ASSUMPTION】）— 含 spec 钦定的 leaky-gpu 全量模拟

| 维度 | 要点 | 出处 |
|---|---|---|
| **leaky gpu 全量模拟** | 测试套件做一个**对抗式 GPU**：随时 evict/invalid tile，使用者必须自愈；**use-after-free 必抛** | spec:163-164 |
| 永不 pin | gpu tile 随时可 evict/invalid；是 render-tree 的纯缓存非 SSoT | spec:160-162, spec:165 |
| 批次保护 | 当前批次 allocate 的一组 tile，下次 allocate 前不主动清（除非不可抗拒） | spec:169 |
| pin callback | 使用者给"要 pin / 有空建议保留"两档；pool 每帧先扔孤儿、再扔不 pin | spec:171-174 |
| resize | 先删→glFlush→新建，不留 cpu tmp（防 RAM spike OOM），丢的靠 RAM ssot 补 | spec:175-176 |
| 不绑 cpu | 图层组无 cpu-tile 有 gpu-tile；兄弟的孩子无 gpu cache 有 cpu ssot | spec:166 |
| 清空 | 开新文档/reload 清池 | spec:177 |
| 自愈联动 | render-tree 遇 gpu-evict/context-lost 从 active-session 重合成 | spec:156 |

> **leaky-gpu 落点**：GL 真实行为需 Playwright SwiftShader smoke（`test/gl-smoke/`，`npm run smoke`）。
> 但**对抗式 evict 的调度逻辑与句柄失效抛错**可用**假 GPU backend**（现有
> `test/tile-store.test.mjs` 就是 "fake backend round-trip"，见 `test/run.mjs:68`）在 **node 里跑**：
> 注入一个每 N 次调用就 invalid 随机 tile 的 mock，断言使用者自愈 + dead 句柄抛错。真正的像素 parity 留给 smoke。

### render-tree / cpu-gpu-tile-bridge（未来 slice）

| 模块 | 维度 | 出处 |
|---|---|---|
| render-tree | 纯 view；updatedNodes 热路径优化、commit 后重算树；undo/redo/commit invalidate composited cache；跨帧缓存策略（updatedNodes + 兄弟 + 祖先兄弟；剪切基底额外驻留）；requiredNodes 才渲染；export 低频不 update/不引缓存；gl-context-lost 自愈 | spec:123-159 |
| cpu-gpu-tile-bridge | cpu↔gpu 转换唯一入口；存对应关系（tile 只读、复用旧只读 tile）；**batch only**（无单个创建）；大 FBO/贴图 with bbox offset 同时建 cpu+gpu；purge dead tiles（扫两池现存 id）；**禁止**用 dead gpu id 查 cpu id | spec:178-186 |

### 液化选区边界（H7）— **现在 RED，液化重写后 GREEN**

针对 selection-mask 的 doc-space 契约。**明确标注**：本组测试写下来即挂红（liquify 仍按 layer.bbox）；
它们是液化迁 GPU / filter-brush（spec:206-207）的验收红线，届时转绿。建议先以 `todo(...)` 挂起，
液化重写 PR 里改成 `it(...)`。

- **`选区 mask 是 doc 空间，不随 layer.bbox`**
  - setup：doc 2048²；一个内容只占左上角小 bbox 的图层；选区覆盖 doc 中央（在旧 layer.bbox 之外）。
  - 断言：selection-mask tile 在 doc 中央区域判定"选区内"为真（当前实现 `cellIn` 会返 false → RED）。
    出处对照：`src/plugins/liquify-engine.ts:178-182`（旧行为）、spec:18（新契约）。
- **`液化把内容推出旧 layer.bbox，越界像素仍受选区裁剪`**
  - setup：选区内一笔 push，位移使内容越过旧 layer.bbox 边界。
  - 断言：越界那半**仍按选区裁剪**（在选区内=液化、在选区外=不动），不再出现"半拉"。
    当前实现 `:238` `if(!inMask(wx,wy)) 原像素直采` 会对越界像素误判选区外 → RED。
- **`bleed 三模式（import/clip/edge）在 doc-space mask 下语义不变`**
  - setup：选区边界处分别用三种 bleed。
  - 断言：import 拉外部、clip 设墙、edge 沿射线 march——行为与 `:90-94/240-266` 描述一致，只是判定基底换成 doc-space mask。
  - 标注：edge 的整数 cell march（`:251-261`，v147 修斑马）逻辑要在重写中保留，别回退。

---

## 附：测试基础设施现状（可测边界）

- **node runner**（`node test/run.mjs`，`package.json` scripts.test）：零依赖、ESM 单例共享 `_tests`
  数组；`describe/it/test/todo/assert/eq/throwsStatus`（`test/runner.mjs`）；DOM shim
  必须第一个 import（`test/dom-shim-first.mjs`，`test/run.mjs:2`）。**纯数据/句柄/调度逻辑全在此测**——
  cpu-tile-pool 引用计数、undo-history 配额、operator 原子回滚、background-sync-jobs 调度、
  假 GPU backend 的 leaky 模拟，都不需要真 GL。
- **`.ts` 测试可直接跑**：runner 已有多个 `*.test.ts`（`test/run.mjs:23,27-45`），node24 strip-ts。
  新模块是 `.ts`，测试用 `.mjs` 或 `.ts` 均可，import `../src/tiles/cpu-tile-pool.ts`。
- **需要真 GL 的**（`npm run smoke`，Playwright SwiftShader，`test/gl-smoke/`）：blend 像素 parity、
  真实 gpu-tile-pool 的 texSubImage3D/readPixels 往返、render-tree 合成 golden。
  **leaky-gpu 的对抗调度不必上 smoke**——用假 backend 在 node 测逻辑，smoke 只验真像素（见上）。
- **前例可抄**：`test/tile-store.test.mjs`（fake backend round-trip）、`test/tile-residency.test.mjs`
  （无损压缩备份 + dirty-never-evict 门）、`test/checkpoint-policy.test.mjs`——新模块测试直接借这几个的形。

---

## 未决 / 无出处（诚实交代）

- **checkpoint 模块归属未定**：spec:26、spec:263 明说要在整理 workbench-session 时再想。本文把 H1
  测试挂在"行为契约"（能读回最近 checkpoint）而非具体模块名。
- **operator API 精确签名**：spec:55-60 给了 `operator(document,args,packUndo?)->status?,undoPackage` 的
  形状，但 addLayer 返回 uuid、banner 的可观测方式、`mut(doc)` 的确切名字都未定死——(b)(c) 里相关处已标 `【ASSUMPTION】`。
- **cpu-tile-compression / gpu-tile-pool / cpu-gpu-tile-bridge 文件名**：`src/tiles/` 目录尚不存在，
  文件名是按 spec 术语推断，标 `【ASSUMPTION 文件名】`。
- **液化重写的 slice 边界**：spec:206-207 只说"filter brush 做抽象类、未来迁 GPU、现在可先 CPU"，
  没定这一轮做不做。本文按"本轮只保证 doc-space mask 数据结构、液化重写另开 slice"处理，H7 测试相应标 RED→GREEN。
