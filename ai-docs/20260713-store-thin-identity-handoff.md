# 薄 store 全名身份重构 — Handoff（2026-07-13）

> ✅ **v397（origin/main=6d8db9e）已做**（无用户/无后向兼容，用户拍板）：**① getPeek 最小做法**（zip 尾片解析下沉进库
>   `src/store/zip-peek.ts`，删公开 `peekTail`，新 `getPeek({bytesLength,zipEntry})`+`decryptPeek(blob)`，加密件明文缩略图仍不落 IDB）
>   · **② 老云端 X.zip = 确认无 legacy fallback**（`_find` 只试 X.ora/X.ora.zip，代码只认最新标准，不加兼容）
>   · **清 migration tax**（删 V001/V002 + 搬迁函数，MIGRATIONS 空、框架留待将来）。559 测绿、tsc=0。**真机仍待验**（下方清单 + getPeek 缩略图一遍）。
>   遗留（本次未做，非阻塞）：极大 CD 文件缩略图仍退占位（不加任意偏移 range 原语）；「缩略图硬扫可能抓到图层」硬扫序未改。
>
> created 20260713 · as-of v396 / 2026-07-13
> 前置：`ai-docs/20260712-store-per-app-namespace.md`（appId 命名空间 + v390 裸名往返）、`src/store/DATA SAFETY GUIDELINE.md` §A、memory `project_webpaint_store_watchfolder`。

## TL;DR

薄 store 重构的**身份核心**已落地 **dev v396**（`origin/main=8ab196b`，local=remote 无错位，tsc=0、node test 573 绿）。身份从**裸名 X** 翻成**全名 X.ora**（明文；加密件云端 = **X.ora.zip**，追加 `.zip` 不换）。**真机未验**——用户自己测（清单见下）。剩两块未做：① `peekTail→getPeek(zip-in-store)`（用户「peekTail 不对外暴露」）；② 老云端加密件 `X.zip`（swap 时代）的云端改名迁移。

## 决策出处（别再 re-litigate）

- **加密命名 = 追加 `.zip`（不换扩展名）**：`X.ora→X.ora.zip`；名字本身是 `Y.zip`→`Y.zip.zip`。用户原话：「还是得 .ora.zip，不然多扩展名会丢信息。或者本身扩展名是 zip 的话就该是 .zip.zip」。→ `toName`/`encFileName` 用 append/strip **单个** `.zip`，无损可逆。**否决了 swap（.ora↔.zip）**（swap 丢原扩展名信息）。
- **边界策略 = option (a)**：app 内部**仍持裸 session 名**，只在跨库/editor-session 的 seam 用 `sessionFileName` 转全名，OUT 侧 `stripSessionExt` 还原。**否决了 option (b)**（app 内部全改全名）——因为 editor-session 是家族共享 app-agnostic 模块，不能把 `.ora` 知识塞进去；option (a) 不动 localStorage/thumb-cache/display，红线不变量最好验（「每个 store/es 调用都 sessionFileName 转、OUT 侧 strip」，grep 可核）。
- **peekTail 不对外暴露**（用户指令）：zip 解析要下沉进库的 `getPeek`。本次**未做**（另开 slice，见下）。

## v396 已落地（8ab196b）

### store 变薄（`src/store/`）
- `create-store.ts`：`createCloudSync` 默认 `fileName` 恒等、`encFileName` 追加 `.zip`（`config.encFileName ?? (n)=>n+".zip"`）。app 不再注入命名。
- `cloud-sync.ts`：默认 `toName` 改成**只去尾部一个 `.zip`**（`n.endsWith(".zip")?n.slice(0,-4):n`）。明文 `X.ora`→`X.ora`、加密 `X.ora.zip`→`X.ora`、`Y.zip.zip`→`Y.zip`。
- `listing.ts`/`reconcile.ts`：**无需改**——v390 起已按 `c.name`/`f.name`（= `toName`）归一 → 自动收敛到全名 `X.ora`。只更新了注释。

### app 边界（`sessionFileName` 转全名，裸↔全名恰好一次）
- **`app-store.ts`**：删 `fileName`/`encFileName` 注入；加 `migrateToFullIdentity: (n)=>/\.ora$/i.test(n)?null:sessionFileName(n)`（v002 用）。
- **`session-state.ts`**：`_file` 包装器 `_store.file(toFull(name),...)`（`toFull=sessionFileName`）；`es.adopted/open/rename` 全部 `toFull()` 包（editor-session 因此持全名、保持 agnostic）。
- **`ui/gallery.ts`**：`tryMove`/`file(...).open/save/encrypt/decrypt/delete`/`restore.targetName` 全 `sessionFileName(item.name)`；`restore` 回来的 `res.name` 用 `stripSessionExt` 还原比对。**文件夹 ops（deleteFolder）不转**。
- **`app.ts`/`topbar-menu.ts`**：`refresh(sessionFileName(session.name))`。
- **`session-name.ts`**：`nameOccupied(sessionFileName(name))`（**仅 session 名**；gallery-shell 的建夹 `nameOccupied(fullPath)` 是文件夹路径，**不转**）。
- **`enc-thumbs.ts`/`cloud-thumbs.ts`**：缩略图 seam 补 `sessionFileName`（`getPeek`/`peekTail`/`verifyPassword` 调用）。

**不变量（grep 可核）**：app 内部一切名字是**裸名**；只有 `sessionFileName(...)` 出现处跨到库/es；`stripSessionExt(...)` 出现处从库还原。`sessionFileName` 绝不作用于已全名的名字（否则 `X.ora.ora` 双后缀）——因 app 内部严格裸名，恰好一次。

### v002 迁移（`src/store/migration.ts`，叠 v001）
- `CURRENT_SCHEMA = "v002-20260713"`；`MIGRATIONS = [V001, V002]`。
- **kv 半（node 测了）**：`migrateIdentityKv` 把 `${appId}.sync.etag:` + `head.dirty:` + `sync.dirty:` 三前缀的 **name 段** 裸→全名（`toFull`）。
- **IDB 半（真机验）**：`migrateIdentityIdb` 把 `${appId}.sync-store-cache/blobs` 的 session blob key 裸→全名；排除 `local-trash:`/`.backup-local`/`__collection__/`；原子 `rename`。
- **映射注入**：`runStoreMigrations(appId, collections, toFull)`；WebPaint 传 `sessionFileName`（含 sanitize，与 seam 逐字一致 → 迁移后 key == app 新 lookup key）。
- **幂等/崩溃重跑安全**：`toFull` 对**已 `.ora` 结尾**的键返 `null` → 跳（防二次追加）。⚠ 已知极窄边角：doc **字面**名以 `.ora` 结尾（如「backup.ora」）会被跳过 → 其本地 blob 不改名、显 cloud-only（**非丢数据**，云端可重开）。个人画板日期/文本名几乎不触发。
- **红线**：dirty 键必须与 blob key 同 `toFull` 改名——否则未推的世界唯一副本身份错位 → 被当 clean 驱逐 = **丢编辑**（v002 kv 测里锁了）。

### 测试
- `test/store-cloud-naming.test.ts`：改测**全名身份**（明文 `X.ora` 恒等、加密 `X.ora.zip`→`X.ora`、`Y.zip↔Y.zip.zip` 无损、子夹 `A/wall.ora`）。
- `test/migration.test.mjs`：补 v002 kv 半（裸→全名、幂等跳 `.ora`、dirty 跟改、编排只跑 v002 盖戳、无 toFull no-op 仍盖戳）。
- **教训延续**：所有带扩展名的往返必须用**带扩展 mock**（v390 bug 溜过就因全用裸名 mock）。IDB 半 node 测不到 → 真机验。

## 🔴 真机验证清单（用户做；验前先把画都 push OneDrive = 本地成可重下影子，风险归零）

1. **v388–395 设备升级 → v002 迁移**：打开 → 图库列出自己的画、**非 0B、非空白、不重复**；随手开一张能进画；名字/子夹结构不变。
2. **v256 老设备（pre-cutover）→ v001+v002 连迁**：同上（v001 把旧 `webpaint/sessions` 搬进 `webpaint.sync-store-cache` 裸名，v002 再改全名）。
3. **CRUD**：新建 / 改名 / 移动（含移进/移出子夹）/ 另存为 / 删除 → 图库即时正确、云端同步、无孤儿/不重复。
4. **加密**：加密一张 → 云端应是 `X.ora.zip`；解密回明文；加密件缩略图（本地+云端）显示。
5. **缩略图**：本地缩略图、cloud-only 缩略图（大文件可能仍占位=遗留①，非本次退化）。
6. **离线**：离线开已缓存件、离线新建/存、回线补推。
7. **多设备**：A 设备改名/编辑，B 设备刷新——身份 `X.ora` 两端一致、无假冲突/假 cloud-gone。

## 剩余工作（下一个 slice/session）

### ① peekTail → getPeek（zip-in-store）——用户「peekTail 不对外暴露」
**现状**：`cloud-thumbs.ts`（**非 stub，已实现**）在 **app 层**做 zip 解析（`_findEOCD/_parseEOCD/_parseCD/_localHeaderDataOffset/_decompress` + 硬扫 PNG + 加密 peek 扫描），字节源 = 公开的 `store.file(name,{isZip}).peekTail(n)`。`enc-thumbs.ts` 用 `getPeek()`（现签名无参，只解加密 peek）。
**目标**：`peekTail` 从公开 `RawFile` 面移除（`encTailBytes` 留内部）；新 `ZipFile.getPeek({bytesLength, zipEntry})` 由**库内部**做 zip 解析（按 entry 名抓、明文/加密统一，加密走内部 `ENC_PEEK` 解密）；`cloud-thumbs.ts` 的 zip helper 下沉进库；`ui/gallery.ts` 只调 `getPeek({bytesLength, zipEntry:"Thumbnails/thumbnail.png"})`。顺带修「缩略图抓到图层」。
**两个做法（用户未拍板，留给你）**：
- **最小**：把 `cloud-thumbs.ts` 现有算法（1 请求硬扫 + 尾内 CD + 加密 peek）原样搬进库 `getPeek`，删公开 `peekTail`，重接 gallery/enc-thumbs。**不加新 range 原语、不恢复 2/3 请求**（极大 CD 文件缩略图仍占位，同现状）。快、风险低。**推荐先走这个**。
- **完整**：按 handoff point 5 给库加**任意偏移 byte-range 原语**（`cloud.pullRange(offset,length)`，provider 已有 `downloadRange`），`getPeek` 恢复 1/2/3 请求算法（CD/entry 不在尾片时多拉，恢复自 `git show 794308a:src/cloud-thumbs.ts`）。多图层大文件缩略图也能拉。大一圈 + 新红线原语 + 更多真机验。
- 参考旧算法：`git show 794308a:src/cloud-thumbs.ts`（0/1/2/3 请求 + 纯 helper）。zip 布局 `[entries][CD][EOCD]`，CD 在末尾；只有 byte-range 拉取进库，解析 helper 是纯的。

### ② 老云端加密件 `X.zip`（swap 时代）→ `X.ora.zip`
**问题**：v238 加密上线时云端加密件是 `X.zip`（swap `.ora→.zip`）。薄 store 的 `_find("X.ora")` 只试 `X.ora` / `X.ora.zip`，**找不到老 `X.zip`** → 老加密件**临时分裂显示**（cloud-only「X」+ local「X.ora」，**都能开、非丢数据**：cloud「X」open 经 `encFileName("X")="X.zip"` 命中；local「X.ora」有本地字节）。下次存盘写 `X.ora.zip`、留 `X.zip` 孤儿。
**建议**：加一次**云端改名迁移** `X.zip → X.ora.zip`（联网 + 登录态；provider.move）——或在 `_find` 里加 legacy fallback 试 `X.zip`（但那把 `.ora` 知识塞回库，破坏「薄」——不推荐）。属数据完整性 follow-up，非阻塞。用户有几张云端加密画才知影响面。

### 其他（handoff 老账，未动）
- brush-rack 仍 local-only stub（`app-store.ts` rackStore）→ 以后 `store.collection`。
- ~20 settings 仍裸 localStorage；`cloud-thumb-cache.ts` 自开 IDB `webpaint`（app 侧，非 store 库）。
- JRP 侧同引擎仍**裸名身份 + 裸 `sync.*`**——bake 回 JRP 时（pwa-cloud-store）接 `appId="jrp"` + 薄 store 全名身份；两份已分叉。

## 关键文件
- 红线引擎：`src/store/{create-store,cloud-sync,listing,reconcile,migration,idb-store,local-cache}.ts`
- app 接缝：`src/{app-store,session-state,session-name,enc-thumbs,cloud-thumbs}.ts`、`src/ui/gallery.ts`、`src/{app,topbar-menu}.ts`、`src/editor-session/editor-session.ts`（agnostic，持全名，不碰扩展名）
- 边界转换器：`src/config.ts`（`sessionFileName`/`encSessionFileName`/`stripSessionExt`）
- 测试：`test/{store-cloud-naming.test.ts,migration.test.mjs}`

## 建议 skills
- **pwa-cloud-store**——做 getPeek slice / 改库红线（baked-copy 流 + 数据安全审计清单）。
- **diagnose**——真机若有身份/缩略图 bug（先写输入→输出）。
- **verify**——迁移/缩略图端到端。
