# sync-store —— domain glossary（架构用语 SSoT）

> 这个文件给 store 引擎里的概念**命名**。架构评审/重构按这里的词走，别漂成 "service / handler / manager"。
> 红线设计见 README.md（新 API SSoT）+ OLD-ENGINE.md（旧引擎 seam）。

## 版本谱系（git 心智模型）

云文件的历史是一条版本链，每版一个 **etag**（云盖的版本号，每次写都变）：`v1→v2→v3…`。本地编辑是挂在某个节点上的一枝；push = 把这枝嫁接回树，**只在分叉节点还是 tip 时**（If-Match）。

- **etag** — 云端给每个文件版本的不透明版本号。变 = 云端被写过。
- **`_base`（seen version）** — 本 tab 同步到/看到的云 tip（git HEAD）。每次看到云端（open/pull/push 成功）更新。
- **`_parent`（branch-point / parentBase）** — 本 tab **当前未推编辑**分叉自的云版（git merge-base）。在 clean→dirty 边沿从 `_base` 抓一次、冻住，直到这枝推上去。**push 的 If-Match 唯一来源。**
- **dirty** — 本文件有挂在 `_parent` 上、还没推成功的本地枝（git working-tree-dirty）。= 它守护的"未推字节"（已 durably 在本地 IDB cache）的旗子。
- **bypass** — 坏状态：dirty 却没 `_parent`（编辑没走标脏正门 → 不知分叉自哪 → push 无法定 If-Match）。**设计上做成不可表示**（见 local-head）。

## local-head（深模块）

> **职责**：追踪"**本 tab 对每个文件，相对云端站在哪**" = (`_base` 看到的版本, `_parent` 分叉点, dirty 有没未推枝)。= git 的 HEAD + merge-base + working-tree-dirty 三合一。

- **per-tab**：`_base`/`_parent` 是 `createStore` 闭包里的内存 Map → 天然 per-tab（每 tab 独立 JS 堆）。**绝不**放共享 kv（W2：别的 tab 改了共享 etag，本 tab 陈旧推会被误判无冲突 → 静默覆盖）。
- **dirty 双机制**：per-tab 内存活视图 + kv shared-durable（跨 reload/tab-close 兜底；寿命对齐 IDB 里的未推字节）。
- **`recordEdit(name)` 是唯一标脏入口**：原子地 set dirty + `_parent ← _base` → **dirty-without-parent 不可表示**（bypass 结构性消除，不是事后绊线）。
- **seenBase 回退**：`_base` 缺失时回退读 cloud kv etag——**仅**用于 open/refresh 的"云端动没动"比较（非破坏性），**永不**作 dirty 的 If-Match。local-head 是**唯一**碰这个回退的地方（两条 etag 轨道唯一接触点，可审计）。
- **两条 etag 轨道分开**：local-head 拥 per-tab `_base`/`_parent`；cloud-sync 拥 kv 持久 etag。只在 open/adopt 单向 seed（kv→`_base`），绝不反向。
- **藏在接口后、app 永不 import**：local-head 是 store 的**内部脊椎**，不在 README.md 的 app 面（file/collection/...）里露出；消费它的只有库内深模块（push / freshness / delete / identity / offload / safe-resolve），各自只调它的 8 个方法（`ifMatchFor` / `seenBase` / `isDirty` / `recordEdit` / `markSeen` / `markSynced` / `onPushed` / `forget`）。**它就是最底的版本谱系脊椎，上面没有另一层。**（注：JRP 才把它从 WebPaint 的 `store.ts` inline 抽出来；WebPaint 仍 inline，未来 adapt 回去时以本模块为准。）

## 红线优先级（取舍时按此排）

1. **绝不静默覆盖 / 绝不丢数据**（最高）——If-Match 用 `_parent` 不用 `_base`/共享 etag；陈旧 etag 当 If-Match 必 412 安全 surface。
2. **绝不让脏字节进 merge**（captive-portal HTML / 截断）。
3. **freshness / 别读陈旧**（较低，但**是 JRP 的命**："各端接着读"=新设备一开就要最新）——seenBase 回退服务这条。

## 相邻模块（深模块现状）

- **substrate**：编辑游标 + push-serialize（serialize/serialize2）+ save 合流。local-head 与它并列为两根有状态脊椎。
- **cloud-sync**：CloudSync 层，拥 kv 持久 etag + 云操作（push/pull/fetchMeta/trash/…）。
- 已抽并由 `create-store.ts` 组合：**seal**（加密透明）· **safe-resolve**（永不丢字节）· **push** · **freshness** · **delete** · **identity** · **trash** · **local-head** · **offload**（本地副本去留守卫）· **reconcile**（cloud-gone 安全收敛）· **collection**。

## 离线副本 —— keepOffline / offload（无 LRU、无 pin）

> 本地副本的语义收敛成**一个 bit：在本地 / 不在本地**（= kept offline / 不）。LRU 已废弃 → 没有「受保护 vs 可驱逐」两层 → "pin" 这词没有指称对象，整套 pin/unpin/evict/force 坍缩成两个动词。

- **keepOffline** — 确保本地有一份副本（未缓存则 acquire）。`autoCacheOpenedFile:true` 下开即等价自动 keepOffline。**不叫 download**：`open` 内部已含下载子过程，叫 download 会误导。
- **offload** — 移除本地副本（≠ delete，云端不动）。**红线守卫全在 `offload` 深模块一处**，复用 local-head 的 etag 谱系逻辑（不发明）：合法 = `clean ∧ 在线 ∧ 已登录 ∧ head.seenBase!=null（曾 synced = 有已知云版 = re-fetchable，对齐 WebPaint「有 etag」）∧ cloud.fetchMeta 存在 ∧ meta.size>0（挡 0B 幻象）`。cloudMoved（云端 etag≠seenBase 但有完整版）仍合法。**非法（dirty / 离线 / 未登录 / local-only / cloud-gone / 0B）= 本地是世界唯一副本 → 抛 `OffloadIllegalError`**（不软返回 kept；经 ui.reportError 出 banner，UX 不该暴露非法 offload）。要清掉唯一副本走 **delete** 语义，不是 offload。
- **autoCacheOpenedFile**（store ctor）— 消费模式。`true`=读者/编辑器（JRP/JRB/WebPaint…），开即留本地；`false`=流式/过路消费（RealHome/Background Radio），开不留本地、只显式 keepOffline 才落地（⚠TODO 未实现，连 §2 range/streaming 一起设计）。

## 反-duplicate 不变量（本库存在的唯一意义 = AI 不得绕）

> **本地副本的存在与去留 = store 独占职责。** app 唯一接口是 `file.keepOffline / offload / isKeptOffline` + `store.localKeys`。app 端**拿不到** etag / dirty / online / 云端有没有——这些 truth 全在库里。

故 app 层出现任何回答「**什么在本地 / 要不要留 / 能不能安全删 / 容量 / LRU / frecency / 陈旧锁 / cloud-gone 收敛**」的逻辑 = **duplicate，必删**（它结构上喂不到输入，是死代码）。adapt 旧 app（如 WebPaint）回本库时跑 leak-test：

```
grep -rnE 'evict|offload|LRU|frecency|cacheCap|ensureRoom|storage\.estimate|reconcileCloudGone|idleLock|什么在本地' <store/ 之外的 app 层>
```

store/ 外每一处命中都是 jailbreak（WebPaint 已知三处：`session-state.ts` 驱逐守卫 / `app-store.ts` cloud-gone 收敛 / `cloud-freshness.ts` 陈旧锁——吸进库后旧码喂不到输入、自然枯死）。

## reconcile —— cloud-gone 安全收敛（#43，已落地安全子集）

> 参考 WebPaint v227-228 etag-tombstone（GUID-free）**对齐移植**；只做不丢字节的那一半。`store.reconcile({activeName?})`，app 在 gallery list-fetch 时调（JRP 在 `persistence.listGallery`）。

- **纯分类器** `classifyCloudGone(localNames, cloudNameSet, {seenBase, isDirty, authoritative, skip?})` → 返回该 demote 的 clean 孤儿（可穷举单测）。
- **规则**：曾 synced（`seenBase!=null`）的 clean 本地、云端 path 没了 → **demote 成 local-only**（`cloud.clearState` + `head.forget` 清两轨 etag，**本地 blob 原地留着、不 trash、不 hardDelete**）。dirty 孤儿 → **留着 no-op**（未推字节只此一份）。从没 synced → 真本地文件、永不碰。在云端 → 不是孤儿。
- **失败-fetch 守卫（命门）**：`authoritative = 在线 ∧ listAll.complete ∧ files 非空`，否则整个 no-op——partial 里「缺失」≠云端真没了；空列表多半未登录/网抖。绝不据 partial/空列表降级。
- **K1**：可传 `activeName` 跳过当前打开的 doc（JRP 的 PDF 只读、demote 也无害，可不传）。
- **暂不做（仍 ⏸）**：裂卡 E / cloud-move A→B 的 **ghost UI / split-card / 阅读位置 re-key**（WebPaint 那版未真机验）。本模块只保证「clean 孤儿安全降级、绝不丢」，不解决 move 产生的重复卡或丢绑定。

## migration / schema-version（深模块，ADR-0019）

> as-of v397 / 2026-07-13：**框架保留、迁移清空**。WebPaint 无用户、无后向兼容 → 历史 V001（webpaint-anchor）/ V002（裸名→全名）
> 两条迁移的搬迁逻辑（tax）已删，库以**最新标准**出生（身份=全名 X.ora、appId 命名空间、dirty 双轨从出生即成立，无需搬迁）。
> 跨版本收敛仍靠**显式版本迁移**，不靠愈合（不写 `?? ora` 类 read-fallback）——只是当前注册表为空。

- **schema-version** — kv 里一枚戳 `${appId}.store.schema = vNNN-yyyymmdd`。字符串序即版本序（NNN 零填充）。= "这个客户端的 on-disk 结构有多新"，让陈旧可见（家族"缓存无失效机制→让龄可见"同源）。
- **migration（深模块）** — 引擎内部，app 碰不到（ADR-0021 四面）。boot 时 `createStore` 在 ready-gate 前 `await runMigrations`：读戳 → 按有序注册表 `MIGRATIONS` 跑欠的迁移 → **run 成功后才盖新戳**（崩了不盖→重跑）。**现 `MIGRATIONS` 为空** → 编排跑空、不盖戳（新装即最新）。
- **框架留着待将来** — 真有用户、真要改 kv/IDB 结构时，往 `MIGRATIONS` 加**第一条** `Migration`（version 单调），编排自动接管。`runMigrations(ctx, migrations?)` 的 migrations 参数默认 = `MIGRATIONS`（测试注入合成列表验编排机制：单调/幂等/崩溃安全）。
- **幂等 + 崩溃安全（机制仍在）** — 逐条迁移 run 成功才盖戳；抛则不盖、下次从该条重跑（红线：绝不在目标 durably 写成前删源，护未推的世界唯一副本）。migration.test.mjs 用合成迁移守这套机制。
- **dirty 双轨（ADR-0020，运行时不变）** — 工作文件 dirty 在 **local-head**（`${appId}.head.dirty:`，缺失=clean）；collection dirty 在 **cloud-sync**（`${appId}.sync.dirty:`，缺失=脏）。这是**运行时记账**，不是迁移——清 tax 不影响它。

## app 命名空间 / 同 origin 隔离（ADR-0022，2026-07-12 真机事故根治）

> IndexedDB 和 localStorage 按 **origin**（scheme+host+port）隔离、**不按 path**。GitHub Pages 的 project site 同 origin（`user.github.io/webpaint/` 与 `/jrp/` 只 path 不同）。写死的库名/键前缀 → 兄弟 PWA 共用一份存储 = 灾难。

- **事故背景**：store-cutover 曾把 WebPaint 换成引擎写死的通用名（`sync-store-cache`、`sync.etag:`…），与同 origin 的 JRP **共用一个 IDB + 一批键** → 文件互漏、`store.schema` 互踩跳迁移 → 图库显 0 B。用户真机抓到。
- **根治**：`createStore` 加**必填 `appId`**。所有持久化标识据它派生（`storeNamespace(appId)`，运行时深模块，非迁移）：IDB 库 `${appId}.sync-store-cache`；localStorage `${appId}.sync.*`（cloud-sync appKey=`${appId}.sync`）/`${appId}.head.*`（local-head keyPrefix=`${appId}.head`）/`${appId}.store.schema`/`${appId}.folders.pending`。不传 `appId` → 抛错，绝不静默共用。WebPaint=`"webpaint"`、JRP=`"jrp"`。
- **∴ 所有键都带 `${appId}.` 前缀**——`storeNamespace(appId)` 是单一真源（`create-store` 取 `dbName`/`foldersPendingKey`；将来的迁移经 `MigrationCtx.ns` 取 `dbName`/`etagPrefix`/`dirtyPrefixes` 改结构）。旧库名 `webpaint`/`sessions`（曾是 V001 迁移源，现无用户已随 tax 一起不再引用）。
- **follow-up**：JRP 侧同一引擎也需接 `appId="jrp"`（当前它还用裸 `sync.*`；WebPaint 命名空间成 `webpaint.*` 后已不再和它撞，但 JRP 对未来兄弟仍有同样潜在 bug）——走 pwa-cloud-store bake 回时补。
