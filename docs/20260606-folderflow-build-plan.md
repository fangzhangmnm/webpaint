# FolderFlow 施工图 —— 笔架同步重构（2026-06-06）

> 下一轮实现的入口文档。读前先读 [[CONTEXT.md]] 的 **Store / Brushrack / 活动笔刷引用** 三词，与 MyPWAPatterns
> **ADR-0011（四 storage shape + 2026-06-06 dial 细化）**、**ADR-0004（Cue · user-action-time merge）**、**ADR-0001（per-Data-class config）**。
> 本文是 WebPaint 专属的**档位选定 + 施工序**；app-agnostic 的模型在 ADR，不在这里重复。

## 0. 一句话

文档已经走深 Store 的 **WorkFileFlow**（opaque blob，整文件 leave/save-as/weak-override）。笔架不是 Work-file，是 **Folder**，
现在却跑着一套绕过 Store 的、会丢数据的手搓平行同步栈（`pushBrushRack(force)` / `pullBrushRack` + app.js 里 `_rackDirty`/`_rackCloudState` 双源 + lossy 冲突对话框）。
本次：**建 FolderFlow（Folder shape 的深模块）把笔架收编**，并把笔架特有的 dial 定下来。

## 1. WebPaint 的 Folder dial 档位（ADR-0011 §Refinement 三个 dial）

| Dial | 笔架选 | 理由 |
|---|---|---|
| **同 GUID 解析** | `last-user-action-time-wins`（不是 duplicate） | 笔刷便宜可重建；重复刷比偶尔丢一次编辑更烦。安全网=手动导入导出。 |
| **Transport** | `单 blob of GUID-keyed entries`（不是 N 个云文件） | 刷小、几十个，per-file 列举/往返成本高；whole-blob `If-Match` 足够（笔架很少被两台同时编辑）。 |
| **Backup-surfacing** | **无 surfaced `.backup`** | 同上；输的那份最多成 OneDrive 里看不见的死文件，无恢复 UI。`.trash`（删除记录）**仍要**——merge 正确性依赖「缺席≠删除」。 |

> Confidentiality（ADR-0001）：笔架非机密，**不走 ADR-0012 三层加密**（明文 zip 即可）。如以后要，单独开 dial。

## 2. 目标架构（底座 + shape flows）

> **shape 实为两个**（ADR-0011 §Refinement 2026-06-06b）：**Work-file**（文档）与 **Folder**（笔架/预设…，**吸收旧 Registry** = Folder-on-Cue）。**Hamster 不是 shape** = Substrate 的 evict dial（如 `cloud-thumb-cache`）。WebPaint 的 `FolderFlow` 即 Folder shape 的实现。

```
            ┌─────────────────── Store ───────────────────┐
  app/UI ── │  flow: WorkFileFlow │ FolderFlow (Folder; 含 Cue) │
            │  ───────────────── Substrate ─────────────── │
            │  provider 抽象 · GUID-via-thumb · etag/If-Match│
            │  · .trash 机制 · 本地 GUID↔path index         │
            │  · push-serialize · eviction guard            │
            └───────────────────────────────────────────────┘
                         │ CloudProvider adapter
                  OneDrive / Mock …
```

- **WorkFileFlow** = 今天 store.js 的 flow（文档）。
- **FolderFlow** = 本次新建，**generic over folder 种类**（笔架=第一个实例；滤镜预设/文档预设/将来 OneDrive 内容树同一份 code，**每种一个 blob**）。merge/validate/encode 全在库内、零 app 回调（item=`{id,name,uat,…opaque}`，库只认 id/uat）。
- **Registry/Cue** = **Folder-on-Cue**（pointer/进度/settings；同 FolderFlow 引擎 + default-LWW merge，transport=localStorage+boot 同步载；笔架**不含**指针，见 §4/§6）。
- **Substrate** = 现在糊在 store.js 里的底座，**先不抽**（见 §6 施工序：FolderFlow 先并排建，底座后抽）。

## 3. FolderFlow —— 笔架 blob 内部 schema

```js
// 单 blob transport，内部是 GUID-keyed 条目。全部带 uat = last user-action-time。
{
  version,
  brushes: [ { id /*GUID*/, uat, name, folder, ...params } ],  // 活动项
  trash:   [ { id /*GUID*/, uat /*=deletedAt*/ } ],            // 删除记录；缺席≠删除
  resetAt: 0 | uat,                                            // 恢复出厂 watermark，max-wins
}
// ⚠ 不含 activeByTool —— 那是旧幻觉，删（见 §4）
```

**`uat`（user-action-time）语义** —— ADR-0004 红线：**只在显式用户动作时打戳**，绝不用 save/sync/上传时间：
保存/更新预设 · 创建刷 · 改名 · 移 folder · 删除。`size/color/opacity/flow` 等非冻结字段当场调、不进 preset、**不打戳**。

## 4. merge(local, cloud) —— CRDT-lite，可证明收敛

> 之所以能放心做乐观并发（§5），是因为这个 merge 是 **commutative + idempotent**：per-GUID LWW register +
> trash 集合（edit-wins）+ max-wins watermark。反复 pull-merge-push 在重试下必然收敛到同一结果。

```
merge(L, R):                                   # L=local, R=cloud(pulled)
  resetAt = max(L.resetAt, R.resetAt)
  # 1. 每个 GUID 取 uat 新的一份（同 GUID 撞 = LWW；不同 GUID = union，无损）
  byId = {}
  for b in L.brushes + R.brushes:
      if b.uat <= resetAt: continue            # 恢复出厂水位线以下，丢
      if b.id not in byId or b.uat > byId[b.id].uat: byId[b.id] = b
  # 2. trash union；删除 vs 编辑 = edit-wins（ADR-0015 / MASTER 红线）
  trash = {}
  for t in L.trash + R.trash:
      if t.uat <= resetAt: continue
      if t.id not in trash or t.uat > trash[t.id].uat: trash[t.id] = t
  for id, t in trash:
      if id in byId and byId[id].uat > t.uat:   # 删后又编辑 → 复活，trash 记录作废
          del trash[id]
      else:                                      # 删 >= 编辑 → 真删
          byId.pop(id, None)
  return { version, brushes: values(byId), trash: values(trash), resetAt }
```

- 改**不同**刷 → 全自动无损，**零冲突 UI**。
- 改**同**刷 → 新 uat 上位，旧的丢（无 surfaced backup，见 §1 dial）。
- **删除的 lossy「拉云端丢本地 / 覆盖云端丢云端」对话框整个删掉** —— 正确的 shape 让冲突消失。

## 5. 同步循环 —— offline-first / 慢网 / 伪在线 全过

**铁律（MASTER §A / ADR-0010）：编辑笔架永远本地即时，绝不 block 网络。** pull-before-edit 是**优化不是闸门**
——正确性来自 §4 merge，不来自 gate。所以即便离线/慢网/伪在线，编辑照常，同步事后 reconcile。

### 5a. 编辑路径（永远不碰网）
```
用户改刷 → 写本地 rack（含 uat 戳） → markDirty → session.request("push")  # 走已有 coalescer
```

### 5b. pull-before-edit（best-effort 优化，**保留**）
打开笔架 sheet / 聚焦时，**后台**发一次 pull；**到了就 merge 进本地（撞概率降低），没到/失败就算了**，绝不等。merge 结果刷新列表/tabs **随便跳**，但**别替换正在打开编辑的那把刷**——挂起到 commit，它按 `uat` 自己合（你赢）。

### 5c. push（pull-merge-push 乐观并发，FolderFlow 正常路径）
```
push(rack):
  base = lastKnownEtag(rack)
  cloudBytes = await provider.get(rack, {ifNoneMatch?, timeout})   # 5d 超时
  if 失败/超时/离线:        return KEEP_DIRTY            # 留 dirty，下次重试；不丢本地
  if not isValidRackBlob(cloudBytes):  return KEEP_DIRTY # 5e 伪在线防线
  merged = merge(local, parse(cloudBytes))
  writeLocal(merged)
  res = await provider.push(rack, encode(merged), { baseEtag: base, timeout })
  if 412:                  return push(rack)             # 有人插队 → 重拉重 merge 重推（bounded retry）
  if 失败/超时:            return KEEP_DIRTY
  adoptEtag(res.etag); clearDirty()                      # 仅在 provider 返回真 etag 才算 done
```

### 5d. 慢网
- pull/push 都带 **timeout** → 超时按离线处理（KEEP_DIRTY，事后重试）。
- 编辑不被在飞的 push 挡：新编辑继续写本地+markDirty，下次 push 的 pull-merge 自然带上（B2「不丢编辑」，复用 WorkFileFlow 同款游标）。
- push 经 **session coalescer**（已有）：连改多刷不串 N 次推。

### 5e. 伪在线（captive portal / `navigator.onLine===true` 但请求挂起或返回登录页）—— **最重要的防线**
- **不信 `navigator.onLine`**：它只是 hint，真信号是「探测请求是否在 timeout 内成功」。
- **merge 前强制 `isValidRackBlob(bytes)`**：
  - zip 能解（central directory 完整 → 截断的慢网响应失败）；
  - 外层 STORE payload entry 名 = GUID（ADR-0012/0011 身份）存在；
  - payload JSON 解析成功且有 `brushes` 数组、`version` 合法。
  - captive-portal 的 HTML 登录页 / 任意非 rack 字节 → 全部 fail → **拒绝 merge**，按失败处理（KEEP_DIRTY）。**绝不让脏字节进 merge。**
- push 的「成功」**只认 provider 返回的新 etag**（ADR-0009 W1 幂等）；伪在线对 captive portal 的「成功」拿不到真 etag → 不 clearDirty。

> 冷启动读到半写 rack：本地 rack 写入须 **atomic/idempotent**（Substrate 的 local 端职责，复用文档同款）；boot 永远先从 IDB 即时拿本地 rack，cloud pull 全后台。

## 6. Brush ref（per-ORA）—— activeByTool 退场

**活动笔刷归画作，不归笔架**（[[活动笔刷引用]]）。今天 app.js 真正读的就是 per-doc `toolStates[tool].activeBrushId`
（ora `webpaintState`），`rack.activeByTool` 是没人读的死字段。

- **schema 迁移**：`toolStates[tool].activeBrushId: id` → `activeBrush: { id, name }`（兼容读旧：只有旧 `activeBrushId` 时按 id 解析，命中即回填 `name`）。
- **解析**：`resolveBrushRef(rack, {id,name})` = `findBrush(rack,id) ?? findByName(rack,name) ?? null`（GUID→name 双重 match；跨设备/重导入换了 GUID 仍认；最后兜底 default/首把）。
- **删除** `brushes.js` 里 `activeByTool` 相关：`makeDefaultRack` 不再产出该字段、`mergeMissingDefaults` 不再维护、`activeBrush(rack,tool)` 删、app.js:6062 的 spread 随旧冲突路径一起删。

## 7. 语言级强制「raw 不许绕过 flow」

- **收窄 barrel**：`src/store/index.js` 只导出 `createStore` + boot 注入用的 provider 工厂；**不导出** per-call raw 方法。
- **闭包私有**（你们已是 factory-closure 风格）：raw provider/local 实例注入后活在 Store 闭包里，app.js **不留 handle**。（等价方案：Substrate 用 class + `#private`，ES2022 硬私有，无需 TS。）
- **grep-guard 测试**（零依赖 runner 土 lint）：断言 `src/store/` 之外无文件 import `cloud-sync.js`/`local-adapter.js`/`*-provider.js`/`app-store` raw shim。`npm test` 抓回归。
- **指路注释**（封装不了的地方兜底）：
  - raw 层文件头：`⛔ RAW SUBSTRATE — 勿从 app/UI 调；一切持久化走 Store.flow.*。直调绕过 If-Match/.trash/merge 红线。觉得这里需要它 → 你其实需要一个 flow。`
  - WorkFileFlow 头：`服务 Work-file（opaque blob，整文件冲突）。笔架/GUID-keyed Folder 请移步 FolderFlow（union-merge，不是三选一）。`
  - FolderFlow 头：反向指回 WorkFileFlow + 列本 app 的三个 dial 档位。

## 8. 施工序（增量，每步可真机验；遵循 commit/test cadence）

1. **纯函数先行（桌面可单测）**：`folder-merge.js` —— `merge()` + `isValidRackBlob()` + `resolveBrushRef()`。配 `test/folder-merge.test.mjs`（含离线/伪在线/删-vs-编辑/resetAt 用例），store-flow 风格。
2. **rack schema 上 uat/trash/resetAt**：`brushes.js` 加字段 + 打戳点；删 `activeByTool`。迁移老 blob（无 uat → 给个 boot 时的低 uat 或 0）。
3. **FolderFlow 并排建**：`src/store/folder-flow.js`，自带最小底座调用（provider.get/push + If-Match + timeout）。暴露 `store.folder(name)` → `{ get(), edit(mut), sync() }`。**merge/validate/encode 全在库内、generic**（item=`{id,name,uat,…opaque}`，库只认 id/uat；validate=envelope 检查；app 只给 cloud 名 + 可选 version）。**零回调**。笔架=第一个实例；`store.folder("filter-presets.json")` 等以后复用同一份 code。
4. **笔架切过去**：app.js 的 `pushBrushRackIfSignedIn` 改调 FolderFlow；**删** `_resolveRackCloudConflict` + lossy 对话框 + `_rackDirty`/`_rackCloudState` 双源（云状态单源回 `store.cloud.status`）+ `pushBrushRack/pullBrushRack` 两腿 shim。
5. **toolStates `{id,name}` 迁移** + `resolveBrushRef` 接入（§6）。**真机验**：两设备改不同刷→都在；改同刷→新的赢；离线改→回线 merge；删→不复活（除非删后又编辑）。
6. **底座后抽**（可延后）：把 WorkFileFlow 与 FolderFlow 公共部分下沉成 `substrate.js`；收窄 barrel + grep-guard（§7）。

## 9. 删除清单（做完应消失的旧幻觉/双源/绕过）

- `rack.activeByTool`（及 `makeDefaultRack`/`mergeMissingDefaults`/`activeBrush()` 对它的维护）
- `_resolveRackCloudConflict` + 那个 lossy「拉云端丢本地/覆盖云端丢云端/合并」对话框
- app.js 全局 `_rackDirty` / `_rackCloudState`（云状态归 `store.cloud.status` 单源）
- `pushBrushRack` / `pullBrushRack` 两腿（cloud.*+local.*）shim（app-store.js）→ 全走 `flow.syncFolder`
- app.js:6062 的 `activeByTool` spread merge

## 10. 测试计划

- **桌面单测**（step 1）：`merge()` 收敛性、commutativity（merge(L,R)≡merge(R,L) 模顺序）、删-vs-编辑 edit-wins、resetAt 水位、`isValidRackBlob` 拒 HTML/截断、`resolveBrushRef` guid→name 兜底。
- **真机**（step 5）：离线编辑、慢网（节流）、伪在线（captive portal 模拟 / 返回非 zip）、双设备不同刷/同刷、删除不复活、恢复出厂水位。
```
