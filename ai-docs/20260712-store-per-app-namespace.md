# store 引擎 per-app 命名空间（同 origin 兄弟 PWA 隔离）——真机事故 + 根治

> created 20260712 · as-of v1 / 2026-07-12
> 决策记录见 `src/store/CONTEXT.md` 的 ADR-0022；红线表见 `src/store/DATA SAFETY GUIDELINE.md` §A。

## 症状（用户真机）

WebPaint dev (v388，store-cutover 合并后) 打开后：**看到 JRP 的文件出现在 WebPaint 图库里，且所有画作显示 0 B。**

## 根因

IndexedDB 和 localStorage 按 **origin**（scheme+host+port）隔离，**不按 path**。GitHub Pages 的 project site 全在同一 origin：

- WebPaint → `fangzhangmnm.github.io/webpaint/`
- JRP → `fangzhangmnm.github.io/justreadpapers/`

→ **同 origin**（只 path 不同）→ 共享同一份 IndexedDB + 同一批 localStorage 键。

store-cutover 把 WebPaint 从 **app 专属**的旧存储（IDB `webpaint`、localStorage `webpaint.*`）换成本引擎**写死的通用名**：

- IDB 库 `sync-store-cache` / store `blobs`（`idb-store.ts`）
- localStorage `sync.etag:` / `sync.dirty:`（cloud-sync 默认 `appKey="sync"`）、`head.dirty:`（local-head 默认 `keyPrefix="head"`）、`store.schema`（migration）、`folders.pending`（create-store）

而 JRP 早已 live、用的是**同一套通用名**（同一份引擎代码拷过去的）。于是同 origin 下两个 app：

1. **共用 `sync-store-cache/blobs`** → JRP 的论文和 WebPaint 的画在同一个 store → JRP 文件漏进 WebPaint 图库。
2. **共用 `store.schema` 迁移戳** → 谁先 boot 谁把戳盖成 `v001`。JRP 先跑过 → WebPaint 启动时 `needsMigration=false` → **跳过迁移** → WebPaint 旧库 `webpaint/sessions` 里的真画作**从没被搬进** `sync-store-cache` → 图库列出的名字本地无 blob → **显 0 B**。
3. 共用 `sync.etag:`/`head.dirty:` → 同步态互相污染。

**数据没丢**：迁移非破坏性（不删旧库）且这次根本没跑 → 真画作原封不动还在旧 IDB `webpaint`。烂的是共享影子缓存。

## 根治：`createStore` 必填 `appId`

所有持久化标识都从 `appId` 派生（`storeNamespace(appId)`，`migration.ts`）：

| 标识 | 旧（写死，撞） | 新（`${appId}.` 命名空间） |
|---|---|---|
| IDB 库名 | `sync-store-cache` | `${appId}.sync-store-cache` |
| etag 键 | `sync.etag:` | `${appId}.sync.etag:` |
| collection dirty | `sync.dirty:` | `${appId}.sync.dirty:` |
| work-file dirty | `head.dirty:` | `${appId}.head.dirty:` |
| schema 戳 | `store.schema` | `${appId}.store.schema` |
| 离线空夹登记 | `folders.pending` | `${appId}.folders.pending` |

WebPaint = `"webpaint"`、JRP = `"jrp"`。不传 `appId` → `createStore` 抛错，绝不静默共用。

### 改动落点

- `idb-store.ts`：模块单例 `idbCache` → 工厂 `createIdbCache(dbName)`（库名不再是常量）。
- `local-cache.ts`：`createLocalCache(dbName)` 建自己的 idb 实例。
- `cloud-sync` / `local-head`：本来就有 `appKey`/`keyPrefix` 参数，create-store 传 `${appId}.sync` / `${appId}.head`。
- `migration.ts`：加 `storeNamespace(appId)`；`migrateKv` 收 `etagPrefix`、`runMigrations` 收 `schemaKey`、`migrateSessionsIdb` 收 `newDbName`；`runStoreMigrations(appId,…)` 统一喂。模块默认常量（`SCHEMA_KEY`/`NEW_ETAG_PREFIX`/`JRP_DIRTY_PREFIXES`）保留，只给测试。
- `create-store.ts`：`StoreConfig.appId` 必填 + 校验；线程化到上面全部。
- `app-store.ts`：`appId: "webpaint"`。

### 自愈 0 B

修后 WebPaint 读 `webpaint.store.schema`（未设）→ 迁移**真跑** → 从旧库 `webpaint/sessions` 把画作搬进 `webpaint.sync-store-cache` → 图库正常显示。

### 边角

- 在 broken v388 窗口里**新建**的画（若有）写进了共享 `sync-store-cache`（无命名空间），修后 WebPaint 看不到——但用户当时在诊断、大概率没新建。旧画作全部安全自愈。
- **JRP 侧同一引擎也需接 `appId="jrp"`**（当前仍用裸 `sync.*`；WebPaint 命名空间成 `webpaint.*` 后已不再和它撞，但 JRP 对未来兄弟仍有同样潜在 bug）→ 走 pwa-cloud-store bake 回时补。

## 验证

- `tsc=0`、`node test/run.mjs` 560/0（migration 编排 + 红线 battery 全绿；store-folder-listing 的 3 处 `createStore` 补了 `appId:"test"`）。
- **真机待验**（IDB node 测不到）：WebPaint dev 打开 → 只见自己的画、不见 JRP 文件、旧画作正常显示非 0 B；JRP 打开 → 不受影响。

---

# 第二个 cutover bug（v390，同一真机会话抓到）——裸 session name ↔ 云端 `X.ora` 往返丢了

命名空间修好后，图库开始显示 WebPaint 自己的云端文件，但**全部 cloud-only、0 B、占位缩略图、打开是空白画布**。

## 根因（两处，叠加）

WebPaint 的 session name 是**裸名**（"未命名"、"20260528-01"），云端文件存 `X.ora`（加密 `X.zip`，见 `config.ts sessionFileName`）。裸名 `X` ↔ 云端 `X.ora` 的往返靠两个方向的映射，cutover 都弄丢了：

1. **`create-store` 写死 `fileName: (n) => n` 恒等**（该处 doc 明说应 `n => n + ".ora"`）→ `cloud.pull("X")` 找云端 `X`（无扩展）→ 404 → 取不到 → 0B/空白。加密同理丢了 `.zip`。
2. **`listing.ts` 按 `c.path`（含 `.ora`）归一**（应按 `c.name = toName(path)` 裸名）→ store 身份成 `X.ora`，而本地缓存/迁移/app open 都用裸名 `X` → 云 `X.ora` 与本地 `X` 分裂成两项、open(裸名) 对不上。
3. 连带 **`reconcile.ts` 用 `f.path ?? f.name`**（优先含扩展路径）建 cloud-gone 判定集 → 本地裸名 `X` 在 `{X.ora}` 里找不到 → **误判 cloud-gone → demote**（非破坏但错误断云谱系）。

（此前所有 node 测试都用**裸名 mock provider**（无扩展名）→ `toName`/`fileName` 恒等、往返恰好成立 → 完全没覆盖到带扩展名的真实情况，bug 溜过。）

## 修

- `StoreConfig` 加 `fileName?`/`encFileName?`（默认恒等；名字自带扩展名的 app 如 JRP 不受影响）；`create-store` 透传给 `createCloudSync`。
- `app-store` 传 `fileName: sessionFileName`（`X`→`X.ora`）、`encFileName: encSessionFileName`（`X`→`X.zip`）。
- `listing.ts` 两处 `cloudMap.set(c.name, …)`（裸 session 名归一，不是 `c.path`）。
- `reconcile.ts` 两处 `f.name ?? f.path`（优先裸名，和本地 appKeys 对齐）。
- **回归测试** `test/store-cloud-naming.test.ts`：真 cloud-sync + listing over mock，种子 `X.ora`/`X.zip`/`A/wall.ora` → 断言 listing 身份=裸名 + `pull(裸名)` 经 fileName 命中。这类带扩展名的往返此前零覆盖，正是漏掉的盲区。

## 身份模型（钉死，别再漂）

**store 规范身份 = 裸 session name**（`toName` 去扩展名，保留夹路径：`A/wall.ora`→`A/wall`）。
- 本地缓存 key、迁移 key、app 的 `store.file(name)`、dirty/etag 记账 —— 全用裸名。
- `fileName`/`encFileName`：裸名 → 云端文件名（加 `.ora`/`.zip`）。`toName`：云端文件名 → 裸名（去扩展）。两者互逆。
- listing/reconcile 拿 cloud 列表时按 `c.name`（裸）归一，与本地 appKeys（裸）在同一 key 空间求并。

## 遗留

- **cloud-only 缩略图仍是占位图**（`cloud-thumbs.ts` stub，pre-existing P2）→ 未下载的云画在图库仍显占位 + 0 B，**打开后**缓存本地才有真缩略图/尺寸。本次只修「打开取不到内容」，缩略图 stub 是独立 follow-up。
- JRP 侧同引擎用 `fileName=identity` + 全名身份 + listing 按 path——与 WebPaint 现在的裸名模型**分叉了**。bake 回时要统一（让 listing 一律按 `c.name`，JRP 也改成裸名 + `fileName` 加扩展）。走 pwa-cloud-store。

## 验证（v390）

- `tsc=0`、`node test/run.mjs` **563/0**（新增 3 个 cloud-naming 回归）。
- **真机待验**：图库云端老画能打开出内容（非空白）、尺寸非 0 B；子夹里的画也能开；加密画能开。
