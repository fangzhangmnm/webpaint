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
