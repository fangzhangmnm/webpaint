# Store 抽取（sync-store pilot in WebPaint）

> 给下一个 AI / 我自己。这是把 app.js 里的同步编排收拢成深 **Store** 模块的施工图。
> 上游需求：MyPWAPatterns `docs/sync-library-spec.md`（RFC）+ `docs/MASTER.md §A`（红线）。
> 架构 review：MyPWAPatterns `docs/reports/20260604-webpaint-architecture-review.html` 候选 1。

## 决定（2026-06-04）

- **先在 WebPaint 内部建 Store**（`src/store/`），验稳再整体 lift 到 MyPWAPatterns/sync-store。不先在共享 repo 立架子（spec §9 的反向）——配合「理欠债」节奏，改动闭环、真机验证快。
- **名字 = Store**（已入 CONTEXT.md）。跟 spec `store.*` 同名，零翻译。
- **不是 facade**（spec §8 弯路1 的教训）：Store **吸收** app.js 的编排（saveAndPush / queueSave / checkCloudETag / 412 flow），cloud.js/storage.js/session.js 这些**本来就深**的 adapter 原地保留、被 Store 内部调用。死掉的弯路是「只 re-export 没搬逻辑」。
- **薄 strangler**：一次搬一个 flow，先 push。dirty/etag 状态暂留 cloud.js 的 localStorage（候选 2 / KV seam 留到后面单独做）。

## seam 形状

```
app.js (UI)  ──{ busy, onConflict }──►  Store（src/store/）
                                          │ 拥有：push-vs-pull 顺序、race serialize、
                                          │       412 fail-fast、trash-vs-delete、etag/dirty
                                          ▼
                          cloud.js / storage.js / session.js（内部 adapter，暂留）
                                          ▼
                          CloudProvider（OneDrive=graph.js 包装 / Mock）
```

## CloudProvider 契约（目的地，spec §4.2 对齐）

错误约定：抛 `Error` 且带 `.status`（404/409/412），与现有 graph.js `err.status` 完全一致 —— 这样 cloud.js 里 `e.status === 412/409` 的判断在 graph→provider 替换后**原样可用**。

```
CloudItem = { id, name, size, eTag, lastModifiedDateTime, isFolder, path?, downloadUrl? }

list(folder="")                                  → CloudItem[]（一层 children）
getItemByPath(path)                              → CloudItem | null
download(id)                                     → Blob（整文件）
downloadRange(id, offset, length)                → ArrayBuffer（offset=null → 取末尾 length 字节，thumb 用）
upload(path, blob, { contentType, eTag?, conflictBehavior })  → CloudItem
   · eTag 给且与云端不一致 → throw 412（pushSession 依赖）
   · conflictBehavior="fail" 且 path 已存在 → throw 409
   · "replace"（默认）覆盖并 bump etag
delete(id)                                       → void（folder 连子树）
ensureFolder(path)                               → folderId（逐段建、幂等、缓存）
move(id, targetFolderId, { newName?, eTag?, conflictBehavior })  → CloudItem
   · conflictBehavior="fail" 且目标名占用 → throw 409（restore 防覆盖循环依赖）
rename(id, newName, eTag?)                       → CloudItem
getApprootId()                                   → rootId
```

OneDriveProvider 将来 = graph.js 的薄包装（path→approot、downloadUrl CDN 优化都已在 graph.js）。

## 切片计划

| 切片 | 内容 | prod 风险 | 验证 | 状态 |
|---|---|---|---|---|
| **A** | CloudProvider 契约 + MockCloudProvider + 零依赖 runner + contract test（钉死 412/conflictBehavior/byte-range/trash-move/restore 防覆盖语义） | 零（纯新增 `src/store/` + `test/`） | `node test/run.mjs` | ✅ 完成（19 test） |
| **B** | 给 cloud.js 加可注入 graph 接缝（`__setGraph`），让真 cloud.js 跑在 Mock 上 → 真行为 characterization | 低（行为不变的机械改） | cloud.js orchestration test over Mock | ✅ 完成（+10 test，共 29） |
| **C1a** | `src/store/store.js` 的 `flow.push` core：串行化/不丢编辑/lost-response 自愈/退避重试。注入 cloud.js 当 adapter | 零（纯新增） | `node test/run.mjs`（B1/B2/B5/retry 转绿） | ✅ 完成（+8 test，共 43） |
| **C1b-push** | app.js `saveAndPushViaStore()` 走 `store.flow.push`，**flag `webpaint.storeFlowPush` 默认关**灰度 | 低（默认关=零变化） | build 绿 + **真机翻 flag 验** | 🟡 已接、未真机验 |
| C1b-rest | open/exit/delete 接线 + 真 LocalAdapter（包 session.js） | 中 | 真机 | 待 |
| **C2** | `flow.openSession` core：in-sync/absent/offline/skip → 本地；云端更新 → pull(先备份后覆盖)/keep/branch。E8 跳过到离线 | 零（纯新增） | `node test/run.mjs`（9 test 绿） | ✅ 完成 |
| **C3** | `flow.exitSession` core：H3 先 flush→push→才可清 active；冲突/未推编辑→不清；离线→deferred 允许退出 | 零（纯新增） | 同上（4 test 绿） | ✅ 完成 |
| C4 | 412 冲突 flow（pull/keep/branch）入 Store | 中 | 同上 | 待 |
| **C5** | `flow.delete`（三态决策 + 不留双份 trash + 护栏）/ `replayDelete`（C7 重连收敛）/ `restore` / `purge` | 零（纯新增） | `node test/run.mjs`（12 test 绿） | ✅ 完成 |
| **C4** | base-etag 归属：收进每-tab 内存（`store.adoptBase`），堵多 tab 静默覆盖（W2 红线） | 中（cloud.pushSession +opts、app adopt 处 seed） | 两-tab Mock 测（复现+修复）+ **真机多 tab 验** | 🟡 已修、未真机验 |
| 后续 | 候选 2：dirty/etag/active/settings → `store.kv`，删光裸 localStorage（红线 #7） | 中 | in-memory KV adapter test | 待 |
| 抽出 | 验稳后整体 lift `src/store/` → MyPWAPatterns/sync-store，cloud.js→OneDriveProvider | — | contract test 在新 repo 复跑 | 待 |

## Slice B 实现细节（给下一个 AI）

让真 cloud.js 在 node 跑通做了 3 件小事：

1. **auth.js node-safe 守卫**：`MSAL_URL` 那行原本模块顶层裸读 `document.baseURI`，node import 即崩。加 `typeof document !== "undefined"` 守卫，浏览器行为完全不变。（cloud.js→graph.js→auth.js 是静态 import 链，不守卫连 import 都过不了。）
2. **cloud.js strangler 注入缝**：`import * as _realGraph` + `let graph = _realGraph` + `__setGraph(g)`；`let _isSignedIn = isSignedIn` + `__setSignedIn(fn)`。所有内部 `graph.X(...)` / `_isSignedIn()`。prod 默认真实现，行为不变。**这两个缝就是将来 Store 注入 CloudProvider 的点**。
3. **test 基建**（`test/helpers.mjs`）：
   - `memLS()` —— 内存 localStorage（cloud.js 的 etag/dirty 缓存读全局 `localStorage`，node 无）。import cloud.js **前**装 `globalThis.localStorage`。
   - `graphFromProvider(provider)` —— 把 clean MockCloudProvider 包成 graph.js 表面形态（关键：`isFolder` ↔ graph 的 `it.file`/`it.folder`）。这是 strangler 期临时桥；cloud.js 逻辑搬进 Store、改成直接消费 clean provider 后退役。

钉住的真行为（10 条）：首推缓存 etag+清 dirty、**别处改过→412→CloudConflictError**、pull 永远 duplicate、trash move-aside+清本地态、**restore 撞名退 (2) 不覆盖**、硬删清态、同/跨 folder rename。

## 故障注入 + Store 验收红线（B 之后补，来自 potential-bugs.md）

mock 原本只模拟「快、可靠、原子」的云。补了 **fault 注入面**（`mock.injectFault({op, kind, status, times})`）：
- `kind:"error"` → 操作前抛 `httpError(status)`（限流/5xx/写前中断，云端不变 = clean fail）
- `kind:"lostResponse"` → **先真的写入（etag 变了）再抛无 status 的网络错**（B5 假 412 的源头；upload/move 支持）

`test/cloud-faults.contract.test.mjs` 三块：
1. mock 故障面自检（3 绿）
2. cloud.js 当前行为 characterize（3 绿）——含一条**已知差距**：lost-response 后重推同一份，当前 cloud.js 误报 `CloudConflictError`（B5 未防御）。
3. **Store 验收红线（7 条 `todo`）**——C1+ 落地后逐条改成 `it()` 变绿：

| todo | 来源 | 谁实现 |
|---|---|---|
| flow.push 串行化（在途 push 第二次排队，不假 412） | B1 | C1 |
| flow.push 不丢编辑（PUT 在途落键 → 按 `_editVersion` 重标 unpushed） | B2 最微妙 race | C1 |
| flow.push lost-response 自愈（重推前拉云比 hash，相等即成功） | B5/W1 | C1 |
| flow.push 退避重试（429/5xx → backoff） | §10.4 | C1 |
| flow.openSession 慢网无硬超时 + 可跳过到离线 | E8 | C2 |
| list reconcile：list 返回 0 但缓存有 N 项 → 不 ghost | A2 | 后续（gallery） |
| trash move lost-response 重连按 GUID 收敛 | C7 | C5 |

**不在本层 provider 测试范围**：auth/MSAL（F 系列）、加密（G 系列）、reader 专属（I 系列）——归各自模块。

## 待澄清/待修（user 2026-06-04 flag）

- **「smart save icon 本地 vs 云端要不一样」**（UI 层，user 说缓做）：澄清=保存按钮图标要区分「只存本地」vs「已同步到云」。现状机器其实已分：local-only→`ICON_DISK`、synced→`ICON_CLOUD_CHECK`、cloud-dirty→`ICON_UPLOAD`（computeSaveState/updateSaveStatus, app.js ~2749-2773）。基本已有，细化（更醒目区分 / 状态时机）留 UI 那轮。自动保存确认只本地（A7），唯一自动碰云=退图库（consent push）。
- **登出/SSO 抖动期间编辑标云脏**：已修（app.js histchange 去掉 isSignedIn 门控，见 potential-bugs B10）。

## C1a 完成：`src/store/store.js` 的 flow.push core

`createStore({ cloud, maxAttempts, backoffMs, sleep })` → `store.flow.push(name, { encode, getEditVersion, onConflict })`。
编排在 Store，底层注入 cloud.js 当 adapter（strangler）。四条红线实现方式：

- **B1 串行化**：per-name promise 链，第二次 push 等第一次 `_doPush` 跑完才启动 → upload 并发数恒 ≤1。
- **B2 不丢编辑**：push 前记 `v0=getEditVersion()`，成功后若 version 变了 → `dirtyAfter:true` 且重新 `setCloudDirty(true)`（cloud.pushSession 内部那句无条件 `setCloudDirty(false)` 被这层覆盖回来）。
- **B5 自愈**：**只编码一次**、重试复用同一份字节；412 → `pullSession` 拉云逐字节比对，相等 → `status:"healed"` 不弹冲突；不等 → `onConflict({name})` 交 UI。
- **retry**：`_retriable`(无 status / 429 / 5xx) → 退避重试到 `maxAttempts`；400 等立即抛。

返回 `{ status:"pushed"|"healed"|"conflict", dirtyAfter, choice? }`。

测试 `test/store-flow-push.contract.test.mjs`（8 绿）。**注意诚实边界**：全部对着 MockCloudProvider 验，证明的是「provider 表现得像我的 mock 时编排正确」，**没碰真 OneDrive**——同 fidelity caveat。`flow.push` 还**没接进 app.js**，app 的真实保存路径目前一字未动。

## C2/C3 完成：openSession / exitSession core

`store.flow.openSession(name, { isOnline, probe, onNewer, backupLocal, pullCloud, adopt, saveBranch })`
- 决策：离线/skip/cloud-absent/in-sync → `{source:"local"}`；云端 etag ≠ base → `onNewer` 弹 pull/keep/branch，**绝不静默覆盖**。
- **pull 顺序红线**（A4/A10）：`_safePull` = 先 `backupLocal`（失败即 abort，绝不 pull/adopt）→ `pullCloud` → `adopt`。
- **E8**：`probe`（用户「跳过到离线」）与 metadata fetch `Promise.race`，无硬超时，skip 即用本地。

`store.flow.exitSession(name, { flush, encode, getEditVersion, onConflict })`
- **H3 顺序**：先 `flush`（RAM→IDB 落地）→ `push` → 才返回 `canClearActive`。绝不在保存前清状态。
- `canClearActive = (pushed|healed) && !dirtyAfter`：冲突或 PUT 期间有新编辑 → false（留住别丢）。
- 离线/重试耗尽 → `{status:"deferred", canClearActive:true, queued:true}`（本地已存、云端排队，E4 离线第一公民）。

测试 `test/store-flow-open-exit.contract.test.mjs`（13 绿）。同 fidelity caveat：对 Mock 验，未碰真 OneDrive，未接 app。

## C5 完成：delete / replayDelete / restore / purge

`store.flow.delete(name, { isOnline, localExists, localTrash, localHardDelete, confirm, onDirtyWarn })`
- 三态（MASTER 删除模型）：仅本地 → 本地 move-aside；仅云端 → 云端 `.trash`；**本地+云端 → 云端进 `.trash`(SoT) + 本地直接删，不留双份**（C1 弯路）。
- 护栏（H2）：`confirm` 强制；`cloud-dirty` 额外 `onDirtyWarn`（C3）。
- **数据安全**：云端进 trash **失败则抛、本地绝不删**（已测两边都还在）。
- 离线 → 本地 move-aside + `queuedCloudDelete` + 带 `baseEtag`，不碰云（E4）。

`store.flow.replayDelete(name, { baseEtag })`（**C7 重连收敛**）：云端没动→进 trash；已被删→静默收敛；被别处改过(etag 变)→`conflict-edit-wins` 不删、留给用户（delete-vs-edit 默认 edit-wins）。

`restore`（撞名→(2)，委托 cloud.js）/ `purge`（danger confirm 强制）。

测试 `test/store-flow-trash.contract.test.mjs`（12 绿）。

**当前总计：67 passed, 0 failed, 1 todo**（剩 A2 list-reconcile，归 gallery 层）。

Store 现已收拢全部核心 flow：**push / openSession / exitSession / delete / replayDelete / restore / purge**。

## 接口定稿（C1b 接线前）

3 个设计决定落实：

1. **busy 回调**：每个 flow 可选 `busy(label, fn)` 包住耗时段（接 app 的 lockSyncGate spinner）。默认直跑。
2. **push 真冲突一致化**：push/exit 撞真 412 仍只返回 `choice`（执行 pull/branch 由 C1b 复用 openSession 的 `_safePull` 路径接线时统一）；openSession 自己执行。
3. **本地归 Store**：加 `store.local` adapter（IDB），`backupLocal/pullCloud/saveBranch/flush/localTrash/...` 这些回调全删。

**Store 自己管两件 adapter**：
- `cloud`（CloudProvider，经 cloud.js）
- `local`（`store.local` 契约：`save/get/exists/backup/trash/hardDelete/restore`）。真 adapter 包 session.js/storage.js，C1b 写；现在用 `src/store/mock-local.js` 的 MockLocal 测。本地红线（一文件一原子 put H1、move-aside、不硬删用户数据）住这里。

**仍由调用方提供的回调**（真·doc/UI/env）：`encode()` · `adopt(bytes,name)` · `getEditVersion()` · `isOnline()` · UI: `confirm/busy/onConflict/onNewer/onDirtyWarn`。

**#2 强退安全原则（已测）**：flow 只在原子提交点写持久状态，**绝不在 await UI 回调时留半设的持久标志**。等 `onNewer/onConflict` 时强退 = 丢在途决定，云端/本地/base-etag 都没动 → 重入按 base-etag 重新检测同一分歧（幂等）。`_safePull` 的覆盖被「备份是复制（原件留着）+ 一次原子 save」双保护。**一个 C1b 必做**：`flow.delete` 离线的 `queuedCloudDelete` 队列必须持久化进 IDB（不能只 RAM），否则强退丢队列、云端文件复活。

**当前总计：69 passed, 0 failed, 1 todo**。

## C1b-push 已接（灰度，未真机验）

- app.js 加 `import * as cloudMod`、`createStore`，顶部 `const _store = createStore({ cloud: cloudMod })`。
- flag：**dev 路由默认开**（iPad 无控制台，`location.pathname` 含 `/dev/` 或 localhost），**prod 默认关**；显式 `localStorage["webpaint.storeFlowPush"]="1"|"0"` 可覆盖。dev 不影响 prod（分开部署）。
- `saveAndPush()` 开头 `if (USE_STORE_PUSH) return saveAndPushViaStore()`。
- `saveAndPushViaStore()`：本地保存/离线/登录门控与原版一致；"云推+412" 段换成 `store.flow.push({encode,getEditVersion,onConflict})`。真冲突 → flow.push 返 `{status:"conflict",choice}`，复用既有 primitives 执行 pull/rename/branch。
- 原 `saveAndPush` 旧路径**一字未改**（flag 关时跑它），可随时回退。

**新路径相对旧路径的行为差异**（要真机确认）：
- 多了 B1 串行 / B2 不丢编辑（PUT 期间落键→推完仍 dirty）/ B5 lost-response 自愈（412 先拉云比字节，相等不弹冲突）/ retry 退避。
- B5 自愈会在 412 时**多一个 GET**（拉云比对）才决定是否弹冲突——真冲突仍会弹。

### 真机验证清单（只有你能做）
1. build + 部署 **dev channel**（dev 默认开，iPad 直接生效，无需控制台）。
2. 改一笔 → Ctrl+S → 状态应「已同步到云端」；OneDrive 里 .ora 更新。
3. 多设备冲突：设备 B 改并推；设备 A Ctrl+S → 应弹「云端有更新版本」三选项；分别试 pull/rename/branch。
4. **C4 多 tab**（同一设备同一浏览器）：tab A、tab B 都打开同一画 → A 改并 Ctrl+S → 切到 B 改并 Ctrl+S → **B 应弹冲突**（不是静默"已同步"）。这是 C4 修的红线。
5. 回退（prod 或想关）：`localStorage.setItem("webpaint.storeFlowPush","0")` 刷新 → 旧路径。
6. 验稳后：删旧 saveAndPush push 段 + 设 prod 默认开；再接 C1b-rest。

## C4 完成：base-etag 归属 / 多 tab 修复

- 根因：cloud.js 的 etag 存共享 `localStorage["webpaint.etag:<name>"]`；tab A 推成功改了它 → tab B 读到 A 的新 etag → If-Match 误通过 → 静默覆盖 A（W2 / ADR-0009）。
- 修：base-etag 收进 **Store 实例（=tab）内存** `_base`，`store.adoptBase(name, etag)` 在 app `adoptLoadedDoc` 处捕获（打开这画时的云端版本）。`flow.push` 用它当 If-Match（`cloud.pushSession(name, bytes, { baseEtag })`），**成功只推进自己的**，绝不每次读共享 LS。
- cloud.js 改：`pushSession(name, ora, { baseEtag })` 可选参数（传了用它含 null=强推；不传回落 getKnownETag，向后兼容）。
- 测 `test/store-multitab.contract.test.mjs`（3）：① 两 tab 各 adoptBase → 陈旧推 412 不覆盖（修复）② 不 adoptBase 回落共享 LS → 静默覆盖（bug 复现）③ 同 tab 连推自己推进 base。
- 注：openSession 被 C1b-rest 接线时也应 seed base（in-sync→meta.etag、pull→云端 etag）；当前走 app.adoptLoadedDoc 已覆盖 push 路径。
- **当前总计：72 passed, 0 failed, 1 todo**。

## 下一片 C1b-rest（要真机验）

app.js 的 `saveAndPush`/`queueSave`/`runQueuedSave` 改调 `store.flow.push`：
- `encode` = 现有 `encodeDocToOra`（saveNow 先写 IDB，再把 ora bytes 交给 flow.push）
- `getEditVersion` = app 的 `_editVersion` 游标
- `onConflict` = 现有 `lockSyncGate` 的 pull/keep/branch sheet
- `busy` = lockSyncGate spinner（flow 已支持可选 `busy(label,fn)`）
- `local` = 真 LocalAdapter（包 session.js/storage.js，满足 `store.local` 契约）替换 MockLocal
- `adopt` = adoptLoadedDoc（bytes→活编辑器）；离线删除队列持久化进 IDB

这步动 god file 保存路径，发版后必须真机推一次确认 412/race 行为。

## 跑测试

```
node test/run.mjs
```
零依赖（不引 jest/vitest，spec §5.5）。runner 在 `test/runner.mjs`，入口 `test/run.mjs`。
