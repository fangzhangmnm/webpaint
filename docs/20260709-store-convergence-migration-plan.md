# WebPaint ⇄ JRP store byte-identical 收敛 + 迁移模块草图

> created 20260709 · as-of v1 / 2026-07-09
> 决定见 ADR-0019(锚 JRP + 显式版本迁移)/ ADR-0020(dirty 默认 clean 双轨)/ ADR-0021(app 四面不碰 kv)。
> 背景报告:docs/reports/20260708-store-byte-identical-convergence-and-degenerate-restore.html

目标:WebPaint `src/store/` 与 JRP `src/store/` **byte-identical**,JRP 深模块结构为基。本 doc = 落地顺序 + `migration` 深模块接口草图。**这是红线区,动手前 escalate + 真机验;cutover 前先把所有画 push 上 OneDrive(本地即纯可重下影子,风险归零)。**

---

## 1. 落地顺序(依赖序)

0. **数据闸门(ADR-0019 migration)** — 先把 `migration` 深模块写好、node 能测的纯逻辑(dirty-split 分类器、版本戳解析)先测。
1. **恢复误删超集(报告候选 B/C)** — editor-cadence facade(autosave/busy-可查/edit·edits·adoptBase 公开面)+ 加密裸字节公开面(seal/loadRaw/decryptPeekBytes/readPeek/unseal-by-name),做成 dormant-when-unused。**先补超集再换引擎**,WebPaint 切过去公开面才是全的。
2. **采纳 JRP 深模块基座 + content-blind 本地层** — 引擎变 JRP 结构 + 恢复的编辑器超集。缩略图渲染搬 app(经 `hint.thumb`)。
3. **app 四面断奶(ADR-0021)** — 散落 ~23 设置 → localSettings/syncedSettings;runtime 指针(currentSessionName 保 phantom-path 红线)→ localSettings;停止注入 lsKv;退休 safe-ls/syncable-prefs。
4. **brush-rack:folder-store → collection**;reconcile:先 JRP 安全子集,ghost 后补真机验(报告候选 D/E)。
5. **判据:两边 `src/store/` diff 为空。**

---

## 2. `migration` 深模块接口草图

```ts
// src/store/migration.ts —— 引擎内部深模块,随引擎拷。app 碰不到(ADR-0021)。
// 职责:读 kv schema 版本戳 → 按序跑欠的迁移 → 盖新戳。显式,非愈合(ADR-0019)。

export type SchemaVersion = `v${string}`;   // "v001-20260709"

interface Migration {
  version: SchemaVersion;                    // 目标戳(单调递增,按 NNN 排序)
  describe: string;                          // 一句人类可读
  run(ctx: MigrateCtx): Promise<void>;       // 幂等:重跑安全(put-by-key 覆盖)
}

interface MigrateCtx {
  kv: Kv;                                    // 引擎内部 kv(app 拿不到)
  // 低层 IDB 直通(仅迁移用,读旧库/写新库);不经 LocalCache 契约(要跨库搬)
  openRawDb(name: string): Promise<IDBDatabase>;
  collectionNames: string[];                 // ADR-0020 dirty-split 需要(reading-state/rack/settings…)
  log(msg: string): void;
}

const VERSION_KEY = "store.schema";          // kv 里存当前戳

// 有序注册表(每次动 kv/IDB 结构加一条)
const MIGRATIONS: Migration[] = [ V001_WEBPAINT_ANCHOR /* , V002… */ ];

// 引擎 boot 时 createStore 内调,ready-gate 之前 await
export async function runMigrations(ctx: MigrateCtx): Promise<void> {
  const cur = ctx.kv.get(VERSION_KEY) as SchemaVersion | null;
  for (const m of MIGRATIONS) {
    if (cur == null || cur < m.version) {    // 字符串序即版本序(vNNN 零填充)
      ctx.log(`migrate → ${m.version}: ${m.describe}`);
      await m.run(ctx);                      // 崩了不盖戳 → 下次重跑
      ctx.kv.set(VERSION_KEY, m.version);    // 盖戳在 run 成功之后
    }
  }
}
```

**ready-gate**:`createStore` 在 return 前 `await runMigrations(...)`;迁移未完,store 不提供任何读(沿用 ADR-0010 re-entry ready-gate 机制)。

---

## 3. v001-20260709 webpaint-anchor 具体步骤

```
run(ctx):
  # ── A. IDB 搬字节(webpaint/sessions → sync-store-cache/blobs)──
  old = openRawDb("webpaint")                       # 不存在(JRP/新装)→ 整条 no-op
  if !old.hasStore("sessions"): return              # JRP:无此库/store → 跳过,盖戳
  new = openRawDb("sync-store-cache")               # createObjectStore("blobs")
  for key in old.sessions.keys():
    rec = old.sessions.get(key)                     # {name,updatedAt,ora,thumb}
    outKey = remapPrefix(key)                        # trash:→local-trash: ; .backup-local/ 不变(两边同);见 §4
    new.blobs.put(outKey, { blob: rec.ora, thumb: rec.thumb ?? null, updatedAt: rec.updatedAt })
    # 红线:先确认 new put 成功,才允许后续删 old(本步不删 old,留到全量确认后)

  # ── B. kv etag(webpaint.etag: → sync.etag:)──
  for k in kv.keys("webpaint.etag:*"):
    kv.set("sync.etag:" + name(k), kv.get(k)); kv.remove(k)

  # ── C. kv dirty 拆轨(ADR-0020)──
  for k in kv.keys("webpaint.dirty:*"):
    n = name(k); v = kv.get(k)
    if n in ctx.collectionNames:                     # collection → cloud-sync 轨(默认脏)
        kv.set("sync.dirty:" + n, v)                 # 值保留("1"/"0")
    else:                                            # 工作文件 → local-head 轨(默认 clean)
        if v == "1": kv.set("head.dirty:" + n, "1")  # 脏
        # v=="0" 或缺 → clean = 不写键(JRP 语义)
        # ★保守:n 不认识时走这条 else,且 v!="0" 一律当脏(宁留勿丢)
    kv.remove(k)

  # ── D. 收尾 ──
  # 全量 A/B/C 确认后再删 old 库(可选;留着不碍事,新代码不读)
  # 盖戳由 runMigrations 负责(run 返回后)
```

**幂等**:重跑时 `webpaint.*` 键可能已被上次跑掉一半 → 剩下的继续搬;已搬的 put 覆盖,无害。**崩溃安全**:old 不在 run 内删 → 任何中断,old 数据都在,重跑补齐。

---

## 4. trash / backup 前缀统一(ADR-0019 §4;两 app 都改)

本地前缀对应云端文件夹,统一:

| | 本地 IDB 前缀 | 云端文件夹 |
|---|---|---|
| trash | `local-trash:` | `.trash` |
| backup | `local-backup:` | `.backup` |

- WebPaint 现 `trash:` → `local-trash:`(v001 §A remapPrefix)。
- backup 前缀现两边都是 `.backup-local/`(move-aside.ts,字节一致)→ 改成 `local-backup:`。**这是 move-aside 改动,JRP 也受影响** → JRP 也要一条迁移把 `.backup-local/*` → `local-backup:*`(或它自己的基线戳内做)。
- `stripTrashPrefix` 正则、`LOCAL_BACKUP_PREFIX` 常量同步改。

---

## 5. 代价小结(详见 ADR-0019/0020/0021)

- **贵+危险**:dirty 拆轨路由(唯一烧脑红线)、IDB 搬字节崩溃安全、IDB 不能 node 测→真机验。
- **便宜**:字段/前缀/appKey 改名(纯映射)、JRP 侧(v001 全程 no-op)。
- **强制连带**:app-kv 断奶 = 散落设置重构一次做完(ADR-0021)。
- **长期税**:版本戳+迁移注册表两 app 都背,但**一个有界模块的显式税**,不是散在热路径的 `?? ora` 愈合。
