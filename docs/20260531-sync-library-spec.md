# 共用同步库重构需求 (RFC)

> 目标读者：未来的 AI / 我自己。看完这份 doc 应该能进入状态，不用回溯多小时对话。
>
> 状态：**需求整理阶段**。设计 / 实现未开始。
>
> 前置阅读：[20260530-gallery-cloud-trash-design.md](20260530-gallery-cloud-trash-design.md)
> （这一轮 WebPaint v137-v146 重做的全部设计决策、坑、抽象库 propose）

---

## 0. TL;DR

WebPaint 把云端+本地同步逻辑重写过 3-4 次，每次都踩同样的坑（race, orphan, conflict, name collision）。
现在兄弟项目（WXHW / AtlasMaker / JRB / JRP / RealHome）也都在重复造轮，质量参差。

需要抽一个**应用无关的同步库**，把全部 safety machinery（含 UX 护栏）放库里，
兄弟项目装好后写少量胶水即可获得：
- 多云 provider 抽象（OneDrive / GoogleDrive / WebDAV / S3 / 自建）
- 本地 IDB cache + offline-first
- Trash（本地+云 unified）
- 子文件夹结构
- 加密
- Race / conflict / 覆盖防护
- UX 护栏强制（confirm / busy lock / orphan fallback）

---

## 1. 痛点 / 为什么要做

1. **重复造轮**：每个 sibling 自己写 cloud sync，质量参差。WebPaint v146 的红线在 WXHW v0.3 里完全没有。
2. **每个 app 重复踩同样的坑**：push race、412 conflict、orphan 删除、同名覆盖、退到列表不保存…
3. **UX 护栏散在 UI 层**：spec 在脑子里，code 看不出来。新人 / 新 AI 接手一定漏。例：「gallery 应该是主页不是 modal」「editor 一开始不激活」「退 gallery 算 consent push」—— 这些不是 sync 逻辑而是 UX 决策但跟 sync 强耦合。
4. **provider 锁死**：每个 sibling 直接调 MSAL/Graph。换 Google Drive / 自建网盘 = 大改。
5. **加密迟早要做**：AtlasMaker 已经要、WebPaint 私密画也要、WXHW 笔记要。各自写一遍 = 灾难。
6. **spec 对齐成本是真瓶颈**：跟 AI 协作时 code 写得飞快，spec 反复对齐拖慢节奏。**library 把 spec 固化进 API 设计**，AI 只看 contract 不用问 UX。

---

## 2. 目标 / 非目标

### 2.1 目标

- **multi-provider**：OneDrive / GoogleDrive / WebDAV / S3 / 自建 / 测试用 MockProvider
- **offline-first**：本地永远可读写，云端 best-effort
- **safety by default**：race serialize、conflict fail-fast、orphan fallback、覆盖防护
- **UX 护栏强制**：危险操作必须走 flow API + confirm + busy callback
- **app-agnostic structure**：扁平 / 嵌套 / dotfiles / game-slot 都支持
- **加密 first-class**：两层 zip + 名称混淆 + 加密 thumb blob
- **state-as-store**：active selection / settings / dirty flag / etag 都库管理（**app 不再直接碰 localStorage / cookie / sessionStorage**）
- **库自身可测**：MockProvider 跑完整 contract suite，秒级 CI
- **WebPaint 是第一个 consumer**，验证后 sibling port

### 2.2 非目标

- **多用户协同编辑**（CRDT 不在范围；single-user account 同步即可）
- **实时增量 sync**（poll + manual push/pull 即可，不需要 WebSocket）
- **跨 provider 同步**（不支持同一 item 同时存 OneDrive + GoogleDrive 双备份）
- **复杂查询 / index**（库不是数据库，只管文件存取）
- **替换 UI 框架**（库不规定 React/Vue/vanilla；可选 ship Web Components reference）

---

## 3. 用户故事（各 sibling 怎么用）

| App | 用法 |
|---|---|
| **WebPaint** | sessions (.ora) 扁平 → 将来嵌套；brushes (.brushes/) 配置；private 画加密 |
| **WebXiaoHeiWu** | docs (.md/txt) 扁平；笔记全加密；高频 reading-position sync |
| **AtlasMaker** | boards 嵌套 (`characters/wall`)；部分 atlas 加密；大文件分块上传 |
| **JustReadBooks** | books 嵌套（书架分类）；reading position 高频 sync |
| **JustReadPapers** | papers 扁平 + per-paper notes；current-file 状态 |
| **RealHome** | worlds (.glb) 扁平；部分 world 加密；VR session resumption |
| **future game** | saves (per slot) + highscore + replays；高分加密防作弊 |

---

## 4. 范围

### 4.1 持久化抽象

库统一管理：
- **文件型数据**（session / doc / board / atlas / world / save）→ IDB blob 或 OPFS
- **配置 KV**（settings, user prefs, theme, brush size, current-file pointer）→ IDB meta store（不直接用 localStorage）
- **per-item sync state**（etag, cloud-dirty, last-pushed）→ IDB
- **UI state**（gallery view / panel sizes / window positions）→ IDB（**app 不再 localStorage**）

**红线**：app 代码里**不允许出现** `localStorage` / `sessionStorage` / `document.cookie` / `indexedDB` 直调用。
全部走 `store.kv.* / store.items.* / store.session.*` typed API。
**理由**：换 backend 时只动库；跨 device 同步 settings 时只需库扩展，不动 app。

### 4.2 云端 sync

**Provider 接口**（库内部统一）：

```ts
interface CloudProvider {
  isAuthed(): boolean
  signIn(): Promise<void>
  signOut(): Promise<void>

  list(folder?: string): Promise<CloudItem[]>
  getItemByPath(path: string): Promise<CloudItem | null>
  download(id: string, range?: { offset?, length }): Promise<ArrayBuffer | Blob>
  upload(path: string, blob: Blob, { eTag?, conflictBehavior? }): Promise<CloudItem>
  delete(id: string): Promise<void>
  move(id: string, parentId: string, { newName?, eTag?, conflictBehavior? }): Promise<CloudItem>
  rename(id: string, newName: string, eTag?): Promise<CloudItem>
  ensureFolder(path: string): Promise<string>     // 返 folder id

  // Optional 优化
  downloadUrl?(id: string): Promise<string>        // 短效 CDN URL，1h
}

interface CloudItem {
  id: string
  name: string
  size: number
  eTag: string
  lastModifiedDateTime: string
  isFolder: boolean
  downloadUrl?: string
}
```

**实现**：
- `OneDriveProvider` (MSAL + Graph)
- `GoogleDriveProvider` (later)
- `WebDAVProvider` (later)
- `S3Provider` (later)
- `MockCloudProvider`（内存模拟全部 API + race/conflict/412/限流，contract test 用）

**Sync 层调 provider 接口**，不知道是谁。换 provider 只换 constructor。

### 4.3 Trash

参考 WebPaint v141-v146 设计（见 [20260530-gallery-cloud-trash-design.md](20260530-gallery-cloud-trash-design.md) §2）：

| 删除时状态 | 库自动决定行为 |
|---|---|
| 仅本地 | IDB rename `id` → `trash:<ts>-<counter>:id` |
| 仅云端 | move 到 `.trash/<name> [<ts>].ext` |
| 本地+云 | 本地直接 delete + 云端进 trash（云端是 source of truth；**不留双份**） |

恢复：自动 name collision → `(2)(3)...`
永久删：app 显式调；同样走 confirm 护栏

### 4.4 子文件夹

参考 AtlasMaker（slash-path）+ WebPaint future folder。

- `store.items.list({ folder: "characters/wall" })`
- `store.items.move(id, "characters/")` 改 folder
- `store.folders.create / rename / delete`
- 库内 `ensureFolder` 缓存 folder id，避免重复 Graph call
- 嵌套 → trash 时**移到顶层 `.trash`**（不保留原 folder 路径；恢复时回 root）—— **由 library 决定**，避免 sibling 各自玩花样

### 4.5 加密

参考 AtlasMaker 双层 zip + 用户多次提：

```
外层 zip（标准 zip，cloud 不打开 / 不扫描）
├── thumb.blob              ← 加密 PNG/JPEG，**offset last**，1-shot byte-range 拉
│                              名称混淆（hash 后），magic number 标识
├── meta.json.enc           ← 加密 metadata
└── payload.zip.enc         ← 加密的内层 zip

内层 zip（解密后）
├── doc.ora / save.dat / ...
├── images/
└── ...                       ← 内部结构 + 文件名 hash 混淆
```

- key 派生：用户密码 → PBKDF2 → AES-GCM key
- thumb 在外层末尾（沿用 WebPaint v140 思路，byte-range 80KB suffix 一次拉）
- `EncryptionProvider` 抽象（默认 SubtleCrypto；future 可换 libsodium）

### 4.6 离线第一公民

红线：
1. 本地永远可读可写
2. 离线 push → queue + 提示「已暂存，重连后推」
3. 重连 → 自动 reconcile（push queue + pull remote 增量）
4. 离线删除 → 本地 trash + queue 一个云端 delete
5. 离线时 list 显示本地有的；云端的不显示但**本地缺失也不删** ✓
6. 同名冲突 reconcile：本地 "foo" + 云端 "foo" 不同 itemId → 本地自动 `foo (2)`

### 4.7 UX 护栏（关键 enforcement）

**痛点**：很多护栏是 UI/UX 决策而不是 sync 逻辑。如果只放 doc 里，sibling 接手必漏。
必须**通过 API 设计强制**。

**Headless Flow API**：

```js
// ❌ raw destructive API 不暴露
store.items.delete(id);   // throws "use store.flow.delete with confirm"

// ✅ flow 强制 callback
await store.flow.delete(id, {
  confirm: async ({ title, body, danger }) => await myConfirmSheet(...),
  busy: async (label, fn) => await myBusySpinner(label, fn),
});

// 库内固定 orchestration：
// 1. await confirm({ title, body, danger:true })
// 2. if ok → await busy("Deleting…", actualDelete)
// 3. 自动 race serialize / orphan handle / etc
```

`store._unsafe.*` 保留 raw API 给 debug，console warn。

**enforce 配套**：
- **Reference UI**：`@local/sync-store-ui` ship Web Components（gallery / trash / confirm / busy / tile-menu），sibling 想偷懒直接用
- **Contract tests**：库 ship 一份 test runner，sibling CI 跑验证 flow 都走了 confirm/busy
- **Flow intent doc**：每个 flow API JSDoc 标注 UX 历史 incident + rationale

**Flow API 候选清单**：
- `flow.delete(id, ux)` — confirm + busy + cloud-dirty 警告
- `flow.restore(trashKey, ux)` — busy + 自动改名
- `flow.purge(trashKey, ux)` — confirm danger + busy
- `flow.emptyTrash(ux)` — strong confirm + busy
- `flow.rename(id, newName, ux)` — 同名冲突自动 reject，busy
- `flow.push(id, ux)` — busy + cloud conflict sheet（用户选 pull / keep / branch）
- `flow.exitSession(ux)` — autosave + push + 切 active = null（consent save）
- `flow.openSession(id, ux)` — busy + load + adopt
- `flow.offloadLocal(id, ux)` — dirty 警告 + busy

### 4.8 Thumbnail

参考 WebPaint v137-v141 byte-range 实现：
- `store.thumb.get(id, { etag, fileSize })` → Blob
- IDB cache + etag invalidation
- 加密时拉外层 thumb.blob 解密
- 非加密时拉 ora 末尾 80KB 硬扫 PNG sig

### 4.9 State management（取代 localStorage 等）

```js
await store.session.setActive(id);    // 跨 reload 持久化
const id = await store.session.getActive();
await store.session.clearActive();     // gallery-first 状态

await store.settings.set("theme", "dark");
const theme = await store.settings.get("theme");

const dirty = await store.cloud.isDirty(id);
const etag  = await store.cloud.getETag(id);
```

**全部走库的 IDB meta store**。app 一行 `localStorage` 都不该有。

### 4.10 Events

```js
store.on("changed", (id) => { ... });        // item put/delete/rename
store.on("trash:add", (trashKey) => { ... });
store.on("trash:restore", (id) => { ... });
store.on("cloud:dirty", (id, dirty) => { ... });
store.on("cloud:synced", (id) => { ... });
store.on("session:active", (id) => { ... });  // active 切换
store.on("offline:queue", (n) => { ... });    // 队列变化
```

App 订阅事件渲染 UI，**不轮询**。

---

## 5. 关键设计决策

### 5.1 Provider 抽象（架空 MSAL）

**红线**：库主体（sync engine / trash / flow / events）**完全不知道**是哪个云。
MSAL 只出现在 `OneDriveProvider`。

ETag / conflictBehavior 等 cloud-side concept 抽象到 provider interface；不支持的 provider 模拟（WebDAV 用 If-Match header）。

### 5.2 UX 护栏 enforce（4 机制组合）

| 机制 | 强度 |
|---|---|
| Headless flow API + callback contract | **运行时 throw**（最强） |
| Reference UI（Web Components） | 鼓励一致 |
| Contract tests (CI) | 自动化验证 |
| Flow intent doc | 教育 |

详情见 §4.7。

### 5.3 加密

详情见 §4.5。要点：
- 外层 zip cloud-friendly
- 内层 + 文件名 hash 混淆
- thumb 在外层末尾（byte-range fetch 兼容）

### 5.4 分发 / 仓库

- **多 repo**，但放本 monorepo 风格目录：`/mnt/d/JupyterLocal/20260524 WebPaint/MyPWAPatterns/sync-store/`
- **不发 npm**。Sibling vendor 两种方式：
  - **git submodule + tag pin**（推荐；sibling AI 可以读源码）
  - cp -r vendor（更简单但难升级）
- **双 ship**：库同时提供 `src/` 源码 + `dist/sync-store-vX.Y.Z.mjs` 预 bundle
  - sibling 用 esbuild bundle 时 inline 源码（默认）
  - 也可直接 import dist 单文件
- **CHANGELOG.md** 详尽，AI 升级时看

### 5.5 技术栈

- **纯 JS**（no TS；user 决策）
- JSDoc 类型注释（够 IDE 自动 complete + 文档生成）
- vendor `msal-browser` / `zip.js` 等依赖（跟 sibling 习惯一致）
- 测试：自家 contract test runner（不引 jest / vitest）
- bundle：esbuild

---

## 6. Constraints / 红线

1. **永不静默丢数据**
2. **本地永不被云端 list 缺失自动删除**
3. **任何删除等价于"送回收站"**（永久删要 explicit `purge`）
4. **任何覆盖先冲突检测**（默认 `conflictBehavior=fail`）
5. **race serialize**（push 进行中第二次 push 等而不是并发）
6. **离线可读可写本地**，云端 best-effort
7. **app 不直接调** localStorage / sessionStorage / cookie / indexedDB / MSAL / Graph
8. **危险操作必须走 flow API**（强制 confirm + busy callback）
9. **跨设备 reconcile** 不假设两边同步
10. **provider-agnostic**：换云只换 provider，不动 sync 引擎

---

## 7. 已调研的现成方案 + 为什么不能用

| 候选 | 干啥 | gap |
|---|---|---|
| PouchDB / RxDB | local-first + sync | backend 限 CouchDB-compatible，OneDrive 不是 |
| Replicache | local-first sync | 需自家 server，不是消费 dumb cloud storage |
| Yjs / Automerge | CRDT collab | 不是 file sync，是 data 结构 replication |
| isomorphic-git | git-as-sync | OneDrive 不是 git server |
| ZenFS / BrowserFS | FS abstraction | 没 sync / trash / etag / conflict |
| rclone | 多云 sync | Node-only，web 不能用 |
| 各云 SDK（Graph / Drive / aws-sdk） | 单云 | 无统一抽象 |
| Obsidian / Logseq | 笔记同步 | 闭源 / SaaS |

**结论**：基本没轮子覆盖全部需求。值得自己写。

---

## 8. 走过的弯路（避免重蹈）

### 弯路 1：透传 facade（2026-05-31 上午尝试，失败）

在 WebPaint 内建 `src/store.js` 透传 re-export 现有 `cloud.js / storage.js / graph.js / localStorage`。
**为什么失败**：
- 只 wrapper 没解决根本问题（UX 护栏没 enforce / provider 没架空 / 加密没接入）
- callers 还得改 import；改完 import 后 sibling 复用仍然要重做
- 不 reusable across sibling（绑死在 WebPaint 内部模块）

**教训**：库必须从一开始就是独立 module，不能 facade 现有代码。
现有 `cloud.js / storage.js` 应该被库**替代**而不是 wrap。

### 弯路 2：双份 trash（2026-05-30）

JRB 设计是本地+云 trash 都留双份保险。WebPaint v143 试了后发现：
- 同设备两个 tile（本地 + 云端）UX 混乱
- 跨设备 reconcile 难（恢复一边另一边孤儿）
- 同名 originalName 合并 → tile 互相覆盖

**最终方案**（v145）：每条 trash 独立 tile，按 trashKey/itemId 唯一。但库设计直接走 v146 「有云不留本地 trash」更简洁。

### 弯路 3：reset blank doc 占位（v140-v143）

删 active session 后创建 "未命名" 占位 doc。带来：
- IDB 累积空白记录
- `_isLazyBlankSession` flag 复杂
- saveNow blank-skip 逻辑

**最终方案**（v146 gallery-first）：删 active → `_activeSessionName = null` → 自动回 gallery，无占位。
**教训**：占位 doc 是反模式，应该让 `active = null` 是合法状态。

---

## 9. 阶段计划（按 AI 速度）

| Phase | 内容 | 时长估 |
|---|---|---|
| **0. 这份 spec 完善** | 现在 | — |
| **1. Scaffold + 接口** | `/MyPWAPatterns/sync-store/`、provider interface、storage interface、error types、JSDoc | 1-2h |
| **2. MockCloudProvider** | 内存模拟 + race / conflict / 412 / 限流 | 1h |
| **3. Storage layer** | IDB wrapper + atomic rename + meta KV + state（active/dirty/etag） | 1-2h |
| **4. Sync engine core** | push / pull / race serialize / cloud-dirty | 2-3h |
| **5. Trash + folder logic** | 三模式删除 + 恢复防覆盖 + ensureFolder | 2h |
| **6. Flow API + UX 护栏** | confirm/busy callback contract + 强制 enforce | 1-2h |
| **7. Contract tests** | 100+ test cases over MockProvider | 2-3h |
| **8. OneDriveProvider** | port WebPaint cloud.js + graph.js | 2-3h |
| **9. WebPaint 接入** | swap import，跑 contract tests + 真测 | 2-4h |
| **10. Doc** | architecture / API / sync-semantics / migration | 3-4h |
| **11. 加密** | EncryptionProvider + 双层 zip | 4-6h |
| **12. 子文件夹完整 UI** | folder API + breadcrumb reference UI | 3-4h |
| **13. Sibling port** | 每个 sibling 0.5-1 天 | 1 周 |

总：核心库 ~15-25 AI 工时；加密 + folder ~10h；sibling 集成 ~1 周。

---

## 10. 开放问题（TBD）

1. **Reference UI 是 Web Components 还是 framework-free render functions？** —— 倾向 Web Components（封装彻底，sibling 框架无关）
2. **Settings sync 到云端？** —— v1 不做（settings 留本地）；v2 看需求
3. **Multi-account 支持？** —— v1 不做，单 account
4. **Quota / 限流策略统一在哪？** —— 库内 retry-with-backoff + 暴露 stats
5. **观测 / debug dump 是 always-on 还是 opt-in？** —— always-on（性能可忽略），暴露 `store.debug.dump()`
6. **加密 key 怎么 store？** —— 用户密码每次输 vs 派生后 keyring 存 → 安全 vs UX tradeoff
7. **测试覆盖率目标？** —— core sync engine 80%+；provider 接口契约 100%
8. **第一个 sibling port 是 WebPaint 还是较简单的（如 WXHW）先 dogfood？** —— 倾向 WebPaint（已最复杂、踩坑最多、最有发言权）

---

## 11. 附录 A：API surface 草图

```js
import { createStore, OneDriveProvider, MockCloudProvider } from "@local/sync-store";

const store = await createStore({
  appName: "webpaint",                  // 隔离不同 app 在同一 OneDrive AppFolder
  storage: { dbName: "webpaint" },      // IDB 库名
  cloud: new OneDriveProvider({ clientId, scopes }),
  encryption: null,                     // 或 new PasswordEncryption(password)
  structure: "flat",                    // "flat" | "nested"
});

// ---------- Items（CRUD） ----------
const item = await store.items.get(id);
await store.items.put(id, blob, { contentType });
await store.items.list({ folder: "characters", includeFolders: true });
await store.items.exists(id);

// ---------- Flow API（带 UX 护栏；强制 callback） ----------
await store.flow.delete(id, { confirm, busy });
await store.flow.rename(id, newName, { confirm, busy });
await store.flow.openSession(id, { busy });
await store.flow.exitSession({ busy });           // autosave + push + clearActive
await store.flow.push(id, { busy, onConflict });  // 412 → onConflict({pull, keep, branch})
await store.flow.pull(id, { busy });

// ---------- Trash ----------
await store.trash.list();
await store.flow.restore(trashKey, { busy });
await store.flow.purge(trashKey, { confirm, busy });
await store.flow.emptyTrash({ confirm, busy });

// ---------- Folder ----------
await store.folders.list();
await store.folders.create("characters");
await store.flow.renameFolder("old", "new", { confirm, busy });

// ---------- State ----------
await store.session.setActive(id);
const active = await store.session.getActive();
await store.settings.set("theme", "dark");
const all = await store.settings.dump();

// ---------- Cloud state queries ----------
store.cloud.isDirty(id);
store.cloud.isSynced(id);
store.cloud.getStatus(id);   // "local-only" | "synced" | "dirty" | "cloud-only" | "conflict"

// ---------- Thumb ----------
const thumb = await store.thumb.get(id);

// ---------- Events ----------
store.on("changed", (id) => { ... });
store.on("cloud:dirty", (id, dirty) => { ... });
store.on("offline:queue", (size) => { ... });

// ---------- Debug ----------
store.debug.dump();           // 全部状态打印
store.debug.stats();          // cache hit / RTT / queue 等
store.debug.replay(log);      // 重放 op 序列
```

---

## 12. 附录 B：每个 sibling 当前实现 vs 库受益

| App | 当前 sync 实现 | 库替换收益 |
|---|---|---|
| WebPaint | v146（最 robust，本轮 spec 来源） | -50% code，加密 / folder 自动得益 |
| WebXiaoHeiWu | v0.3 早期实现，race / orphan 都不防 | **大跃升**，replace 50%+ |
| AtlasMaker | 有 folder slash-path，无 trash；用 cloud.js 较旧 | 加 trash + race 防御；folder 共用 helper |
| JustReadBooks | .trash 模式 + move-based（最接近库设计） | 改动少，contract test 验证 |
| JustReadPapers | trash 模式（无点前缀） | 加冲突防覆盖 |
| RealHome | worldStore.deletedAt（VR 风格 inline） | 跨设备 sync 加强 |

---

## 13. 附录 C：从对话提炼的口语化原则（user voice）

> 「永不静默丢数据」
> 「本地永不被云端 list 缺失自动删除」
> 「跨设备 reconcile 不能假设两边同步」
> 「app 不直接碰 MSAL / IndexedDB / Cookie / Session」
> 「危险操作必须走 flow API + confirm callback」
> 「加密 thumb blob 放外层末尾，offset last，magic number，1-shot byte-range」
> 「子文件夹有些 app 要有些不要，库支持 flat/nested 都行」
> 「离线第一公民」
> 「provider 抽象，将来可换 GoogleDrive / 自建网盘」
> 「safety machinery 都在 library 层面做好」
> 「spec 对齐是真瓶颈，不是 AI 智商问题」
> 「重写 3-4 次后值得抽象」

---

## 14. 下一步

读完这份 doc 之后，下次进入这件事的开场白可以是：

> "继续 §9 的 phase 1：scaffold MyPWAPatterns/sync-store。
>  按 §4.1 / §5.4 决定的，多 repo + 双 ship + 纯 JS + JSDoc。
>  先写 provider interface（§4.2）+ storage interface（§4.1） + 一个 MockCloudProvider stub。
>  不要先 port WebPaint，先把架子立起来 + MockProvider 跑 contract test。"

不需要回溯多小时对话。spec 已经在这。
