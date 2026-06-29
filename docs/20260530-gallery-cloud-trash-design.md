# Gallery × OneDrive × Trash 同步设计（v141-v146 重做）

> 本文记录这一轮（gallery-first 改造 + 回收站 + 云端同步重设）的全部设计决策、踩到的坑、
> 以及未来抽象成 **sibling-shared library** 时该把哪些 machinery 放进库里。
>
> 应用：WebPaint 当前；将来 sibling 复用 = WebXiaoHeiWu / AtlasMaker / JustReadBooks /
> JustReadPapers / RealHome / Background Radio（都是 OneDrive AppFolder 单 user 沙盒 + IDB cache）。

---

## 0. 设计理念

**红线（不可妥协）**：
1. **永不静默丢数据**。任何"删除"等价于"移动到回收站"；任何"覆盖"先做冲突检测。
2. **本地永不被云端 list 缺失自动删除**。云端 list 拿不到本地 cache 也仍可用（设备 B 删了不连带 A 失数据）。
3. **每个长 op 都有视觉反馈**（fullscreen spinner / status）+ 防误点（busy lock）。
4. **跨设备 reconcile 不能假设两边同步**。本地 IDB 是 cache；云端是 source of truth（有云时）；离线时本地降级为 source。

**Gallery-first 设计**：
- 启动 → 默认进 **gallery**（图库）；有上次 active session → 自动打开进画布；没有 → 停 gallery
- `_activeSessionName = null` ⇔ 用户在 gallery（未绑任何画作）
- `_activeSessionName = "foo"` ⇔ 用户在 canvas 编辑 foo
- 点 gallery btn = **explicit consent save**：本地 + 云端一起推 → 退到 gallery
- 删 / 卸载 active session → 自动回 gallery（不创建空白占位 doc）

**State persistence**：
- `localStorage.webpaint.currentSessionName` 单字段持久化 active session name
- 空字符串 `""` = "在 gallery 没绑画作"，refresh 后停 gallery
- **不再加额外 flag**（用 `_activeSessionName == null` 已足够区分）

---

## 1. Session 4 态 icon（gallery tile）

| 状态 | 条件 | icon | 含义 |
|---|---|---|---|
| 仅本地 | `isLocal && !isCloud` | HDD 圆柱 | 没登云 / 没推 |
| 仅云端 | `!isLocal && isCloud` | cloud outline | 云端有但没拉到本地 |
| 本地+云已同步 | `isLocal && isCloud && !isCloudDirty(name)` | cloud + ✓ | 完全同步 |
| 本地+云未推 | `isLocal && isCloud && isCloudDirty(name)` | cloud + ↑ | 本地有未推改动（autosave 不动云端，cloud-dirty 维持 true 直到 Ctrl+S 或退 gallery 触发 push） |

`isCloudDirty(name)` 单 flag per session：`localStorage.webpaint.cloudDirty:<name>`
- 任何 `wp:histchange` 事件 → setCloudDirty(name, true)
- push 成功 → setCloudDirty(name, false)
- pull 成功 → setCloudDirty(name, false)
- 默认（key 不存在）→ true（保守，需要主动 push）

---

## 2. Trash 模型

**有云就不留本地 trash**（关键决策，反 JRB 双份策略）：

| 删除时状态 | 本地动作 | 云端动作 |
|---|---|---|
| 仅本地 | IDB rename `foo` → `trash:<ts>-<counter>:foo` | — |
| 仅云端 | — | `move foo.ora → .trash/foo [<ts>].ora` |
| 本地+云 | **直接 IDB delete**（云端是 source of truth） | move 到 `.trash/foo [<ts>].ora` |

**为什么有云就不留本地 trash？**
- 双份在跨设备时乱：A 删 → A 的本地 trash + 云端 trash + B 一旦同步看见两条
- 恢复时要两边都恢复
- 红线"不丢"已经由云端 trash 满足，本地 trash 多余

**Cloud-dirty 时删除 → 警告**：本地+云时 isCloudDirty=true 表示本地有未推改动。
删 = 本地直接 delete + 云端进 trash → 未推改动**丢失**。confirm sheet 显式警告。

### 2.1 Trash key 设计

```
trash:<timestamp>-<counter>:<originalName>
```
- `<timestamp>` = `Date.now()`（ms 精度）
- `<counter>` = 模块内自增（防同 ms 内多次 trash 同名 collision）
- 永不冲突 ✓

Parse 正则：`/^trash:(\d+)(?:-\d+)?:(.+)$/s`（兼容旧无 counter 格式）

### 2.2 Cloud trash 文件名

进 .trash 时**始终**加 timestamp 后缀（即使无冲突）：
```
foo.ora → .trash/foo [1700001234567].ora
```
原因：
- 同名多次删除永不在 .trash 内冲突
- 恢复时 strip `[<ts>]` 后缀拿原名

### 2.3 恢复防覆盖

**本地恢复**：parse trashKey 拿 originalName → check `listSessionIds` 看是否冲突 → 冲突自动 `(2)(3)...` 后缀。
**云端恢复**：1→100 候选名 `foo / foo (2) / foo (3) / ... / foo [<ts>]`，每次 `moveItemToFolder` with `conflictBehavior=fail`，409/412 重试下一候选名。

### 2.4 Trash UI

视图切换 = `_galleryView = "files" | "trash"`
- Trash bar 独立 header（红色高亮 + 返回 btn + ⋯ menu）
- ⋯ menu 内 "清空回收站"（防误触放 menu 不放 bar 主视）
- 每条 trash = 独立 tile（**按 trashKey/itemId 唯一**，不按 originalName 合并！按 name 合并会让同名多次删除互相覆盖）
- 同名多次显示多个 tile，meta 行标 "本地 · time 删除" 或 "云端 · time 删除"
- 操作 = 恢复 / 永久删除

---

## 3. 同步红线坑（这一轮新发现 + 修）

### 3.1 Cloud push race（v144 修）

**场景**：Ctrl+S 触发 push（async） → user 立刻点 gallery → `_exitCanvasToGallery` 调 `saveAndPush` 第二次 → 第二次 push 用 push 1 之前的**旧 etag** → 服务器返 412 → 弹"云端有新版本"backup sheet（假阳性）。

**修**：`saveAndPush` 入口 `if (_cloudPushing) await _awaitCloudPushIdle()`。

`_awaitCloudPushIdle`：
```js
async function _awaitCloudPushIdle() {
  if (!_cloudPushing) return;
  showFullscreenBusy("正在同步到云端…");
  try { while (_cloudPushing) await new Promise(r => setTimeout(r, 80)); }
  finally { hideFullscreenBusy(); }
}
```

### 3.2 退 gallery 不保存（v144 fix）

**初版 bug**：`_exitCanvasToGallery` 先 `_docDirty = false` 再 `setGalleryOpen(true)` → setGalleryOpen 内 `if (_docDirty) await saveNow()` 永远 skip。

**修**：先 `await saveAndPush()` 再 clear active state。
**升级**：点 gallery = explicit consent save → `saveAndPush`（含云推），不仅 saveNow（local only）。

### 3.3 Lazy session blank-skip（v140-v143 演变 → 最终去除）

**问题历史**：
- v143 删 active → `_resetCanvasToBlank` 创"未命名"占位 doc + 直接 `saveSession` 写 IDB → 累积空白 record
- v144 → 改为 lazy save（占位 doc 不写 IDB，画第一笔触发 autosave 才写） + `_isLazyBlankSession` flag → `_docIsBlankUnnamed` 自检 bbox 非空时 clear flag
- v146 → 索性去掉 reset blank 概念，gallery-first：删 active → `_exitCanvasToGallery`（直接进 gallery，no occupied "未命名"）

教训：**lazy save / occupied placeholder doc 是反模式**，gallery-first 直接绕开。

### 3.4 Trash 视图同名 collision（v145 修）

**初版 bug**：trash 视图按 `originalName` 合并 entries → 同名多次删除互相覆盖 → 只显示一个。
**修**：每条 trash 独立 tile（key = `trashKey` / `itemId`）。同名多个 tile 按删除时间排序。

### 3.5 Cloud download URL metadata RTT（v141 优化）

**问题**：每张 thumbnail 拉之前都要先 `GET /me/drive/items/{id}?$select=@microsoft.graph.downloadUrl` 拿 CDN URL → 再 Range request → 每张 2 RTT。

**修**：`listChildren` 的 `$select` 加 `@microsoft.graph.downloadUrl` → list 一次性带回 50+ 个 URL → 后续 byte-range 直接打 CDN → 每张 1 RTT。
**Edge case**：URL 1h 过期 → 401/403 → 自动重申请 `getDownloadUrl(itemId)` 一次重试。

### 3.6 云端 move 默认 replace（v143 修）

**Bug**：`PATCH /me/drive/items/{id}` 不指定 `@microsoft.graph.conflictBehavior` 时 OneDrive 默认 `replace` → 移动到 .trash 时如果 .trash 内同名文件 → **静默覆盖**那个文件（data loss）！

**修**：`moveItemToFolder` 默认 `conflictBehavior=fail`，409/412 → caller 兜底加 `[<ts>]` 后缀重试。

### 3.7 PopUp 系统 (v146)

每个 popup 个别调 z-index + position 易乱。Helper：

```js
function openAnchoredPopup(popupEl, anchorEl, { alignRight = true, offsetY = 4 } = {}) {
  // 用 getBoundingClientRect 算 anchor 下方 fixed 定位 + z-index 200
  // setTimeout 0ms 挂 outside-click handler（避免本次 click 立刻关）
}
```

但用过的 case 发现：**最简还是 parent-relative + absolute 位置**（如果 anchor 在固定 container 内）。Helper 留给 dynamic case。

### 3.8 Tile fixed size + 2-row meta (v140-v145)

Tile 180×238：thumb 180×180 + name 1 行 + meta 1 行（淡色 11px：state icon + time · size）+ padding。
- thumb 背景 = 白色（user 偏好）；不用棋盘格
- 自适应 thumb encoding：256→192→128 PNG，目标 ≤70KB（云端 80KB suffix range 1-shot 命中）

---

## 4. Graph API helpers（cloud.js / graph.js 边界）

### graph.js（纯 Graph wrapper，应用无关）
- `listChildren(subfolder)`：带 `@microsoft.graph.downloadUrl` $select
- `getItemByPath(path)`：metadata + eTag
- `downloadItemBlob(itemId)`
- `downloadItemRange(itemId, offset, length)`：HTTP Range，suffix `bytes=-N` 或 prefix
- `downloadRangeFromUrl(downloadUrl, offset, length)`：直接打 CDN
- `getDownloadUrl(itemId)`：重申请短效 URL
- `uploadFileToApproot(path, blob, ct, {conflictBehavior, eTag})`
- `deleteItem(itemId)`
- `moveItemToFolder(itemId, parentId, {eTag, newName, conflictBehavior})`：**默认 fail**
- `renameItem(itemId, newName, eTag)`：PATCH name only
- `getApprootId()` + `ensureSubfolder(name)`（带 cache）

### cloud.js（WebPaint sync 逻辑，复用模式）
- `pushSession(name, oraBlob)`：If-Match + 412 → CloudConflictError
- `pullSession(name)`：clear cloud-dirty
- `pullSessionByPath(path)`：含子文件夹
- `listCloudSessionsRecursive()`：walk approot，**skip 顶层 .trash**
- `listCloudTrash()`：.trash 内 ora
- `trashCloudSession(name)`：始终加 `[<ts>]` 后缀 + move to .trash
- `restoreCloudFromTrash(itemId, targetName)`：100 候选名循环 conflictBehavior=fail
- `purgeCloudTrashItem(itemId)`：DELETE
- `renameCloudSession(oldName, newName)`：PATCH name + 迁移 etag 缓存

---

## 5. 抽象库分界：哪些 machinery 放库 vs 留 app

> 用户要求：safety machinery 放 library 层；app 只调 high-level API，不重做 race / orphan / collision 兜底。

### 库（`@local/sync-cache` 假名）应该提供：

**Storage primitives**：
- `openSyncDB(dbName)` → IDB wrapper
- `getItem(id)` / `putItem(id, pkg)` / `deleteItem(id)` / `listIds()` / `renameKey(old, new)` **atomic**

**Trash API**（高层）：
```ts
trash.delete(name, {hasCloud}) // 智能：有云→本地删+云端 .trash；只本地→IDB rename
trash.list()                   // 返 [{trashKey, originalName, deletedAt, source, ...}]
trash.restore(trashKey)        // 自动 name collision (2)(3)
trash.purge(trashKey)
trash.empty()
```

**Cloud sync helpers**：
- `cloudPush(name, blob, {clearDirty}) → {etag}` with race serialize（内部 _awaitIdle）
- `cloudPull(name) → {blob, etag}`
- `cloudMove(itemId, targetFolderId, {newName, conflictBehavior="fail"})`
- `cloudRename(name, newName)`
- `cloudList({skipFolders: [".trash"]})`
- `cloudListTrash()`
- `getOrFetchThumbnail(itemId, etag, size, downloadUrl?)` with IDB cache + etag invalidation + 401 retry

**Conflict / orphan handlers**：
- `cloudDirty.is(name) / set(name, bool)`
- `etag.known(name) / set(name, etag)`
- Unique name across local + cloud
- `withBusy(label, fn)` + outside click 关 popup helpers

**App 留**：
- 数据本身的语义（什么是 doc / brush / page / book）
- UI 渲染（tile 怎么画、菜单内容）
- 业务规则（什么算 cloud-dirty trigger，autosave 节奏）

### 5.1 Provider 抽象（架空 MSAL/Graph）

> 用户进一步要求：以后**完全不碰 MSAL** → 库要架空云服务 provider，便于换 Google Drive / Dropbox / 自建 WebDAV / S3。

**Provider interface**（库内部统一调）：
```ts
interface CloudProvider {
  // 鉴权（黑盒，provider 内部）
  isAuthed(): boolean
  signIn(): Promise<void>
  signOut(): Promise<void>

  // CRUD
  list(folder = ""): Promise<CloudItem[]>      // 单层
  getItemByPath(path): Promise<CloudItem|null>
  download(id, range?: {offset, length}): Promise<ArrayBuffer|Blob>
  upload(path, blob, {eTag, conflictBehavior}): Promise<CloudItem>
  delete(id): Promise<void>
  move(id, parentId, {newName, conflictBehavior}): Promise<CloudItem>
  rename(id, newName): Promise<CloudItem>
  ensureFolder(path): Promise<string>           // 返 folder id
}

interface CloudItem {
  id: string
  name: string
  size: number
  eTag: string
  lastModifiedDateTime: string
  isFolder: boolean
  downloadUrl?: string                          // optional 优化（OneDrive Graph 给；其它不一定）
}
```

**Provider 实现**：
- `OneDriveProvider`：MSAL + Graph API（当前 WebPaint / WXHW / AtlasMaker / JRB / JRP 都用）
- `GoogleDriveProvider`：OAuth + Drive API（未来）
- `WebDAVProvider`：basic auth + WebDAV verbs（自建网盘）
- `LocalFileSystemProvider`：File System Access API（纯本地"模拟云"测试用）

**Sync layer 完全不知道 provider 是谁**：
```ts
const sync = createSyncEngine({ provider: new OneDriveProvider(opts), db: idbWrapper });
await sync.trash.delete(name);
await sync.cloud.push(name, blob);
```

App 启动时挑 provider，sync engine 无感切换。

**关键设计**：
- ETag / conflictBehavior 等 cloud-side concept 抽象到 provider 接口（Graph 直接支持；其它 provider 需要模拟，比如 WebDAV 用 If-Match header）
- byte-range download 是可选优化（provider 不支持就 fallback 整下载）
- thumbnail 缓存逻辑在 sync engine 层，跟 provider 无关

### Sibling 复用调研

| 项目 | 现成功能 | 复用库的 win |
|---|---|---|
| **WebXiaoHeiWu** | doc.deletedAt 标 trash + cross-folder sync（早期实现，乱） | 替换为库 → 简化 50% |
| **AtlasMaker** | 没 trash；有 subfolder slash-path | 加 trash + 复用 folder helper |
| **JustReadBooks** | .trash folder + move-based trash（最 robust） | 跟库设计同源，最少改 |
| **JustReadPapers** | trash folder（无点前缀） | 加冲突防覆盖 |
| **RealHome** | worldStore.deletedAt（VR 风格 inline） | 跨设备 sync 弱 |

→ 复用 win 最大：WebXiaoHeiWu / RealHome（写过但不鲁棒）；JRB / AtlasMaker 锦上添花。

---

## 6. 未做的（next phase）

- **加密**：AtlasMaker 双层 zip 模式（外层明文 zip 装内层加密 blob + 加密 thumb），byte-range 拉缩略图仍 work
- **子文件夹**：listCloudFolder by path + breadcrumb UI + move between folders + create/rename/delete folder
- 这两个都应该**先抽象库再扩展**，避免在 WebPaint 改完再 port 到 sibling 时全部 reimplement

---

## 7. 开发顺序选项（这条 doc 写完后 user 决定）

### Option A：先做加密 + 子文件夹（在 WebPaint 里）
- 优点：feature 进度更快推进
- 缺点：之后抽库要把 WebPaint 写的 cloud + sync 全部 refactor

### Option B：先抽象库（library extraction）
- 优点：加密 + 子文件夹直接在 lib 实现，sibling 立刻受益
- 缺点：暂停 feature 进度 1-2 周；refactor 风险

### Option C：先 doc + 红线 freeze（本文）→ B 路径
- 这是当前选择
- 用本文当 spec，启动 lib design

---

## 8. 一行回顾

> Gallery-first + 有云就不留本地 trash + saveAndPush 串行化（防 race） + cloud move 默认 fail（防覆盖） + trash 视图 trashKey 唯一（防同名 collision） + lazy session 反模式不要做 + 4 态 icon 表达 cloud-dirty。

红线兜住，feature 自由长。
