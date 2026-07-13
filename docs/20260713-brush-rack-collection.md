# 笔架 → store.collection（.webpaint/brush-rack.json）

> as-of v395+ / 2026-07-13 · 深模块 `src/brush-rack-store.ts`

## 变更

笔架从「IDB meta 整包 blob（local-only stub）」搬到 **store.collection**（云端 `.webpaint/brush-rack.json`，逐 brush 一 item，per-item uat-LWW 零冲突）。合并语义**不手搓**——复用 store.collection（红线：碰 store 合并绝不重导）。

- **持久化后端** = `brush-rack-store.ts`（深模块）。`brush-rack.ts` 只认它暴露的面（init/mergeDefaults/reconcile/syncCloud/status…），对 collection 的 upsert/delete/迁移/种子全内化。
- **每 brush 带 `order` 字段**（全局单调排序键）——collection.items() 顺序不保证，靠 order 复原用户排列；filter by tool/folder 保序 = 保夹内顺序。
- app 侧 `_rack.brushes` 仍是内存工作模型；改架后 `reconcile()` 对账进 collection（新增/变更 upsert、消失的 delete=tombstone）。**未变的笔不 re-upsert**（`brushFingerprint` 忽略 uat 比对）→ 不无谓 clobber 别设备的编辑。

## 三件本模块负责的事

1. **一次性 IDB 迁移**：老用户笔架在 `IDB meta["brush-rack"]`。首次上 collection（collection 空 ∧ 无 `__rackmeta__`）时读老 rack、逐笔 `migrateBrush` + 按数组序赋 order、upsert 进 collection。**旧 IDB 不删**（保底），只打 meta 戳防重迁。
2. **默认笔种子 + seedGen**：全新用户种当前 default-brushes。`default-brushes.json` 是 async fetch，init 时可能没回 → 先种 emergency 占位，boot 的 `defaultsPromise` 回来后 `mergeDefaults()`（→`seedDefaults`）补真默认笔并清 emergency。
3. **删除 = tombstone**（collection.deleteItem）→ 删过的笔（含默认笔）不跨设备复活。

## seedGen 的取舍（tombstone 不可见）

collection **不对外暴露 tombstone**。若每次 boot 都「补缺失默认笔」，会把用户删掉的默认笔复活。故用同步的 `__rackmeta__` item 存 `seedGen`：

- `seedDefaults(defaults)` 只在 `meta.seedGen < RACK_SEED_GEN` 时补缺失默认笔，然后升 gen。
- 迁移过来的架直接记 `seedGen=当前` → 不自动补默认（尊重用户的删除）。
- **`RACK_SEED_GEN` 升号 = 主动把新一批默认笔推给老用户**（代价：会复活用户删过的旧默认笔——但这是开发者的显式选择，非日常）。不升 = 老用户笔架只按自己的增删走。

## 收敛模型（网盘模型，对齐 collection 的 grain）

- **跨设备拉取发生在 `init()`（boot）**——collection.init 做 pull-merge-push。
- **`syncCloud()` = collection.flush()**（写本地 + 若脏推云）；**干净设备中途不拉**（flush 只在 dirty 时 sync）。即：别的设备改了笔，本设备下次开 app（init）才见——对低频的笔架足够。

## 云文件命名 / 图库隐藏

- collection 名 `.webpaint/brush-rack.json`；synced settings 也在 `.webpaint/`（见 [20260713-settings-module.md](20260713-settings-module.md)）。
- ⚠ **图库列举隐藏 `.webpaint` 目前由 app 做**（`app-store.ts` 的 `watchFolder` folderNames 里滤掉 `CONFIG_FOLDER`）——库在 depth-0 只硬滤 `.trash`/`.backup`。**待办（用户已知）**：库要把列举 filter 移出去（filter 是 app 的事，非库的事）；届时 `.webpaint` 隐藏改由 app 统一负责，本处 app 滤留着即可。
- ⚠ v395 基座下 `fileName=sessionFileName` 会给 config 文件加 `.ora`（云端实为 `.webpaint/brush-rack.json.ora`）——隐藏夹内不影响功能。v396「薄 store 全名身份」下库默认恒等 fileName，届时文件名即字面（merge 时确认）。

## 测试

`test/brush-rack-store.test.mjs`：真实 `createCollection` + 内存 cloud 往返——迁移 / 种子 / seedGen 幂等 / **跨设备删除不复活** / order 保序 / reconcile 逐 item / 跨设备 per-item 合并。
