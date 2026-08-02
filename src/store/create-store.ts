// ⚠ 这是库的唯一入口。接库必读同目录 README.md + CONTEXT.md。
//
// createStore —— 薄组合根：provider → 库内造 cloud/local/kv/脊椎 → 装配 10 个深模块 →
//   暴露 README.md 的面（file / collection / list）。设置/状态**全走 collection**（synced 或 {local:true} 变体），
//   localSettings/syncedSettings 已删（2026-07-13）——app 每类持久化建一个 collection，直接用其 KV 面。
//   红线全在各深模块内 enforce；这里只接线 + 把 ui bundle 映射到各 flow 的回调。
import { toU8, createSubstrate } from "./substrate.ts";
import type { Bytes } from "./substrate.ts";
import { createLocalHead } from "./local-head.ts";
import { createSeal } from "./seal.ts";
import { looksEncryptedContainer, packContainer, unpackContainer, configureCryptoCodec, scanEncPeekFromEnd, decryptPeek, PEEK_TAIL_WINDOW, ENC_PEEK_MIME, CONTAINER_PEEK_ENTRIES, type CryptoCodec } from "./crypto-container.ts";
import { createSafeResolve, type ResolveChoice } from "./safe-resolve.ts";
import { createPush } from "./push.ts";
import { createFreshness, type RefreshOpts, type FreshResult } from "./freshness.ts";
import { createDelete, type DelResult } from "./delete.ts";
import { createIdentity } from "./identity.ts";
import { createTrash } from "./trash.ts";
import { createOffload } from "./offload.ts";
import { createReconcile } from "./reconcile.ts";
import { createPendingGone } from "./pending-gone.ts";
import { assertValidFileName, assertValidCollectionName } from "./is-hidden.ts";
import { createCollection, emptyCollectionBytes, type Collection, type CollectionConfig } from "./collection.ts";
import { createListing, type ListContext, type FolderSnapshot } from "./listing.ts";
import { createUploadReplay, type UploadReplayPolicy } from "./upload-queue.ts";
import type { CloudProvider, CloudSync, Kv, LocalCache } from "./types.ts";
import { createCloudSync, CloudNameCollisionError } from "./cloud-sync.ts";
import { mergeTrash, type TrashItem } from "./trash-merge.ts";
import { createLocalCache, createCollectionCache } from "./local-cache.ts";
import { runStoreMigrations, storeNamespace } from "./migration.ts";
import { namespacedKv, type KeyedKv } from "./kv-namespace.ts";
import { readCentralDirectory, readEntryBytes, type PeekSource } from "./zip-peek.ts";
import { setStoreErrorReporter, type StoreErrorLevel } from "./error-handling.ts";

// ── ui bundle（Model B，README.md §7）：store 在决策点回调进来 + await ──
export interface StoreUI {
  // **全部必填，禁 placeholder/noop**（offlineEscape 例外：缺它优雅退回 isOnline 守卫，非隐藏失败）。
  busy: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  resolveConflict: (ctx: { name: string; local: Blob | null; cloud: Blob | null }) => Promise<ResolveChoice>;  // 冲突必 surface：consumer 必须给真 sheet，绝不静默 cancel
  reportError: (err: unknown, level?: StoreErrorLevel) => void;                                                 // 错误必 surface：绝不吞 console。level 缺省 "error"（见 error-handling.ts 分级）
  // 加密密码**不走 ui**——非交互 crypt.getPassword（app 持内存密码 + 解锁循环在 busy 外，见 §5/§7）。故无 askPassword。
  // 可选：云端检查（freshness gate）的「跳过到离线」逃生闸（对齐 WebPaint：无硬超时，用户即超时）。
  // store 在 open 的 freshness 检查前调，拿 probe 与 fetchMeta race；用户点「跳过到离线」→ probe resolve → 读本地
  //   （iOS 登录态老 token acquireTokenSilent iframe 永不 resolve→fetchMeta 挂死时的唯一逃生）。
  // 不实现 → 无逃生闸（退回纯 isOnline 守卫 + 裸 await）。settle() 在检查结束后清理 skip UI。
  offlineEscape?: () => { probe: Promise<unknown>; settle: () => void };
  // ── ADR-0018 离线「新上传」回线补推的 UI seam。**policy≠'manual' 时必填**（ctor 强校验，禁 noop/silent）──
  onReplayStatus?: (evt: { phase: "start" | "pushed" | "collision" | "done"; name?: string; done: number; total: number }) => void;   // 进度/冲突 surface（非 busy，走状态行/toast）
  confirmReplay?: (count: number) => Promise<boolean>;   // 'ask' 模式：回线/成功连接问一次「N 篇离线上传现在同步到云端？」
}

export interface StoreConfig {
  provider: CloudProvider;
  ui: StoreUI;
  // ⚠ **必填** app 在本 origin 内的唯一命名空间（如 "webpaint" / "jrp"）。与 databaseId 一起构成命名空间根
  //   `${appId}.${databaseId}`：IndexedDB 库名 + 全部 localStorage 键前缀都据它隔离（namespacedKv 统一加）。
  //   **同 origin 的兄弟 PWA 必须用不同 appId**：IndexedDB/localStorage 按 origin 隔离不按 path，GitHub Pages
  //   的 /webpaint/ 与 /jrp/ 同 origin，共用写死的库名会读写同一份存储 = 灾难。见 idb-store.ts 头注释。
  appId: string;
  // 同一 app 内的 store 实例标识（默认 "defaultStore"）。想在一个 app 里开**多个互不打架的 store**（不同数据集）
  //   → 传不同 databaseId：各自独立 IDB 库 `${appId}.${databaseId}` + 独立 localStorage 前缀。
  databaseId?: string;
  // ── 加密（对齐 WebPaint，见 ai-docs/11；逻辑在库、重型 7z/zip codec 由 app 注入）──
  //   不注入 crypto → 加密 dormant（packContainer 抛「加密未配置」）；JRP 不加密就不注入，省 1.6MB。
  crypto?: CryptoCodec;                            // app 注入的 zip/7z codec（WebPaint 用 sevenzip.ts+zip.ts 包成）
  crypt?: {
    ext?: string;                                  // 真扩展名 → meta.bin（"ora"/"txt"…），还原真名
    makePeek?: (plain: Blob) => Promise<Uint8Array | null>;   // 明文→不透明 peek 字节（app 域；store 不看内容）
    getPassword?: (name: string) => string | null; // 同步、非交互、只读内存（唯一密码源）；app 持密码 + 解锁循环在 busy 外
  };
  encryptionSaltFileName?: string;   // ⚠ 未采用：README §5 的库统一密钥/salt 超集本版不实现（见 ai-docs/11，加密走 crypt.getPassword）
  // ── 内部/测试 seam（prod 默认 idb + localStorage）──
  kv?: Kv;
  local?: LocalCache;
  getPassword?: (name: string) => string | null;   // 旧顶层密码源（向后兼容；优先用 crypt.getPassword）
  // 采纳云端字节前的有效性闸（N2：clean 快进/pull 覆盖本地前调）——**所有 consumer 必传，禁 placeholder/noop**。
  //   store 格式盲、自己验不了内容 → 逻辑 app 给（验是不是真 PDF/.ora/zip）。否则损坏/captive-portal HTML 拿着
  //   合法 etag 能覆盖唯一好的本地副本 = 丢内容（论文/画作都怕；只读消费者不上传不伤云，但机场网毁缓存照样难看）。
  //   **库对加密透明**：验的是**解密后的明文**（你看真 PDF/.ora，不是密文容器）。
  validateAdopt: (plain: Blob) => boolean | Promise<boolean>;
  // ── 云端文件命名（app 域：store name → 云端文件名）。**不给 = 恒等**（JRP 等名字本身含扩展名的 app）。
  //   WebPaint 的 session name 是裸名（"未命名"），云端存 `.ora` → 必须给 `fileName: n => n+".ora"`（+加密 `.zip`）。
  //   ⚠ cutover 一度漏传 → 老云端 `X.ora` 用裸名 `X` 取不到（0B/打开空白）。见 ai-docs/20260712-store-per-app-namespace.md 边角。
  fileName?: (name: string) => string;               // store name → 云端文件名（如 n => n + ".ora"）
  encFileName?: (name: string) => string;            // 加密容器的云端文件名（如 n => n + ".zip"；ADR-0012）
  isOnline?: () => boolean;                          // offload 离线守卫（默认 navigator.onLine）
  signedIn?: () => boolean;                          // **连接态由 store 自持**（网盘模型：app 不再每次列举传 ctx）。ctor 注入一次；不给 → 恒 true（退回 provider 失败即降级）。watchFolder / 云列举据此决定「云轴可不可解析」。
  autoCacheOpenedFile?: boolean;                              // 消费模式：true=开即自动留本地(读者/编辑器)；false=过路/流式(开整份拉云不落本地；range 按需取片是 ⚠TODO 优化)
  offlineUploadReplay?: UploadReplayPolicy;           // ADR-0018：离线「新上传」回线补推策略 auto|ask|manual（默认 manual；WebPaint=manual、JRP=ask）
  // ── 数据迁移框架（ADR-0019，createStore 内部自跑、隐形）──
  //   2026-07-13：无用户/无后向兼容 → 清空 MIGRATIONS（历史 V001/V002 tax 删除），库以最新标准出生。
  //   框架（版本戳 + 有序注册表 + 编排）留着——将来真有用户、真要改 kv/IDB 结构时加第一条迁移。
  skipMigration?: boolean;                            // 测试/无 localStorage 环境跳过（prod 不传）
  cloudGoneGraceMs?: number;                          // 云端防抖窗口覆盖（测试注入小值；prod 缺省 ~24h）
  activeFileName?: () => string | null;                   // 当前打开的 doc（全名身份）：cloud-gone 去抖 trash 绝不碰它（连 watchFolder 自动 reconcileFolder 也跳过）
}

// tryMove 结果式返回（不抛，UI 渲染 where 标签）。移动/改身份的唯一入口 = file.tryMove(to)。
// ok:true 时**仍可能有话要说**（别只看 ok 就报「已重命名（含云端）」）：
//   oldKept       谱系不明 → 降级为 save-as，云端旧名原地留着 → 必须告诉用户「旧的还在，叫 <oldName>」
//   oldUnknown    云端旧名状态取不到（离线/错误）→ 没碰它；「取不到」≠「没有」，别报「已含云端」
//   oldCloudOrphan 旧名进 .trash 失败 → 云端遗留孤儿
//   cloudDeferred  云端推失败 → 新名只在本地，待推
export type TryMoveResult =
  | { ok: true; where?: string; oldName?: string; oldKept?: boolean; oldUnknown?: boolean; oldCloudOrphan?: boolean; cloudDeferred?: boolean }
  | { ok: false; reason: "name-collision"; where: "local" | "cloud" };

// save 的结果：本地一定落了（没落会抛），云端**不一定**上去了。
//   pushed:true  = 云端已确认落地（拿到新 etag）
//   pushed:false = 只落了本地。reason：not-attempted(tryPush:false) / offline-or-error / deferred(落地未确认)
//                  / unresolved|cancelled(冲突面用户没解决) —— 文件仍 dirty，等下次推。
export type SaveResult = { pushed: boolean; reason?: string };

/** 加密容器的 at-rest 字节（branded）。唯一发牌方 = ZipFile.getEncryptedBlob()。
 *  只收密文的下游（导出 / 拷贝 / checkpoint）用它当形参类型 → 传明文 Blob 编译不过。 */
export type EncryptedBlob = Blob & { readonly __encryptedAtRest: unique symbol };

// ── 文件对象（README.md §2）。isZip 在编译期分出两种：RawFile 无 getPeek/setPeek ──
export interface RawFile {
  //  save(bytes)               = 本地落盘 + best-effort 推云（默认 tryPush:true）
  //  save(bytes,{tryPush:false})= 只落本地不推（autosave/频繁保存；opaque Work 的 push 必须 consent-gated，ADR-0016/0018）
  //  tryPush 是 **best-effort**：离线/冲突/失败 → 文件留 dirty、下次补推（不保证同步到云）。hint 透传缩略图（store content-blind）。
  //  返回值：**别忽略 pushed**。以前这里是 Promise<void>，push 失败被 catch 成 banner 后 save() 照常 resolve，
  //  调用方无从分辨「已上云」和「只落了本地」→ 乐观清掉 push-pending → badge 画干净、退出不再重推
  //  （= 用户报的「远端文件不一样」而 UI 从没说过失败）。pushed:false 不是错误，是**事实**：离线/冲突/
  //  用户在冲突面选了 cancel 都会走到这里，调用方据此保住 push-pending 即可。
  save(bytes: Bytes | Blob, opts?: { tryPush?: boolean; hint?: unknown }): Promise<SaveResult>;
  open(): Promise<Blob | null>;
  // 事件驱动「干净快进」：本地 clean ∧ 云端有更新 → 拉新版覆盖本地缓存；本地 dirty → no-op（绝不在事件里弹 sheet，
  //   后续 push 的 412 会 surface 真分叉）。app 在 focus/visibility/online 调。（原 store.refresh(name)，2026-07 收上 file。）
  pullIfClean(opts?: RefreshOpts): Promise<FreshResult>;
  // 改身份/移动**唯一入口 = file.tryMove(to)**（含 nameOccupied 占用检查，结果式不抛；ok:false→UI surface where）。无独立 rename。
  tryMove(to: string): Promise<TryMoveResult>;
  //  返 DelResult：**别只 await 就报「已删除」**（v436）。status 至少有三种不是成功：
  //    cancelled（用户在脏文件警告里选了取消）· noop（本地云端都没有这个文件）
  //    · queuedCloudDelete:false（离线且谱系不明 → 本地 move-aside 了，但云端那份还在）
  delete(): Promise<DelResult>;
  // 重新上传（candidate-gone 的「保留重传」动作）：本地 clean 字节推云到空 path。撞名(乌龙云端已有)→抛 CloudNameCollisionError
  //   （app surface conflict）；成功→采纳新 etag 变 synced + 清 candidate。gallery 层没开文件 → 必须 store 内解决，不靠编辑器 save。
  reupload(): Promise<{ status: string }>;
  // 注：无 isDirty —— 「有没未推的改动」是 **sync 状态**，经 store.listAllItems 的 syncState 读（unpushed/conflict）。
  //   「是否 dirty 该推」= app 编辑逻辑（编辑器生命周期模块）的判断，不是库的事。
  // ── 离线副本（keepOffline/offload；无 LRU、无 pin flag：有本地副本 = kept offline）──
  isKeptOffline(): Promise<boolean>;            // 本地有副本？（= 已留作离线）
  keepOffline(): Promise<void>;                 // 留一份离线副本（未缓存则 acquire）。注：open 已含下载子过程，故名 keepOffline 非 download
  offload(): Promise<void>;                     // 合法(clean∧在线∧曾synced∧云端有完整)→hardDelete；非法(唯一副本/不可重取)→抛 OffloadIllegalError（banner）
  // ── 加密（at-rest 透明；对齐 WebPaint，见 ai-docs/11。JRP 不注入 codec → dormant）──
  isEncrypted(): Promise<boolean>;                                       // 本地字节是否加密容器
  encrypt(opts?: { isOnline?: () => boolean }): Promise<{ status: string }>;   // 明文→密文（先本地后云 If-Match；离线 defer；错密码前置出局）
  decrypt(opts?: { isOnline?: () => boolean }): Promise<{ status: string }>;   // 密文→明文（同上红线）
  verifyPassword(pw: string): Promise<boolean>;                         // app 解锁循环（busy 外）便宜验：解 peek，不碰 7z
}
export interface ZipFile extends RawFile {
  // getPeek：从 zip 容器里**按文件名**抓 zipEntry 的字节（zip 解析在库内部，app 不碰 zip 布局）。
  //   取字节 schema：先拉尾片(bytesLength)→解 EOCD/CD→按名找 entry；CD/entry 溢出尾片则各一次额外 byte-range。
  //   返回：**明文** zip → entry 原始字节 Blob(**无 type**，格式盲，app 自解释)；**加密**容器 → **密文** peek
  //   Blob(type=ENC_PEEK_MIME，未解密)；找不到/不可达→null。
  //   加密件只返密文（**绝不在这解密**）——让 app 的缓存层原样存密文，明文缩略图永不落 IDB（安全红线）。解密走 decryptPeek。
  //   ⚠库不认内容格式——就是「按名取到的 entry 字节」；WebPaint 拿去当缩略图（内容知识全在 app）。
  getPeek(opts: { bytesLength: number; zipEntry: string }): Promise<Blob | null>;
  // 把 getPeek 返回的密文 peek blob 非交互解密成明文（内存密码；锁定/错密码→null）。已是明文(非 ENC_PEEK_MIME)→原样返。
  decryptPeek(encPeek: Blob): Promise<Blob | null>;
  /** 本地 at-rest 字节**原样**（内容盲，不解壳）——仅当这份是加密容器时给，否则 null。
   *
   *  为什么需要：`open()` 是**透明解壳**的（拿到的是明文），所以「原样搬密文」的场景——
   *  导出加密作品、拷贝加密作品、给加密作品存 checkpoint——以前根本没有接口，
   *  只能退化成「解密再存/再导出」，那就是明文落盘/明文外流（红线）。
   *
   *  返回 EncryptedBlob（branded）：下游只收密文的 sink 用这个类型签名，
   *  传普通 Blob 直接编译错 —— 把「别把明文当密文传」从人的自觉变成编译期约束。
   *  ⚠ 诚实的边界：TS 证明不了「这坨字节运行时真是密文」；brand 挡的是编码错误，
   *    运行时真相由本方法保证（它是唯一发牌方，非加密件一律返 null）。 */
  getEncryptedBlob(): Promise<EncryptedBlob | null>;
}

function localStorageKv(): KeyedKv {
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (!ls) throw new Error("createStore: 无 localStorage，请注入 kv");
  return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v), remove: (k) => ls.removeItem(k), keys: () => Object.keys(ls) };
}

export function createStore(config: StoreConfig) {
  const { provider, ui, appId, databaseId = "defaultStore", kv: rawKv = localStorageKv(), validateAdopt, autoCacheOpenedFile = true } = config;
  if (!appId) throw new Error("createStore: appId 必填——同 origin 兄弟 PWA 隔离的红线（每个 app 建自己的 IDB 库）");
  // 深模块统一错误上报接上 ui.reportError（深模块 import reportStoreError 直接调，不必线穿 ui）。store 侧不 log。
  setStoreErrorReporter((err, level) => ui.reportError(err, level));
  const ns = storeNamespace(appId, databaseId);   // 命名空间根 `${appId}.${databaseId}`：IDB 库名 + 全部 localStorage 键前缀
  // **窄腰 choke point**：包一层 namespacedKv，所有键自动落 `${ns.root}.`；各深模块只用相对键（files.*/collections.*/settings.*/internal.*）。
  const kv = namespacedKv(rawKv, ns.root);
  const local = config.local ?? createLocalCache(ns.dbName);              // 文件缓存（files/trash/backup 分区）；prod=idb、测试注入 mock
  const collectionLocal = config.local ?? createCollectionCache(ns.dbName);   // collections 分区缓存（collection 自带 `collections/` 前缀）
  const isOnline = config.isOnline ?? ((): boolean => (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine !== false);
  // 加密密码源（对齐 WebPaint 非交互 getPassword）：优先 crypt.getPassword，兼容旧顶层；不给 → 恒 null（透传明文）。
  const getPassword = config.crypt?.getPassword ?? config.getPassword ?? ((): string | null => null);
  if (config.crypto) configureCryptoCodec(config.crypto);   // app 注入 zip/7z codec 才启用加密；JRP 不注入 → dormant

  // ── 脊椎 + 低层 ──
  // 两个 cloud-sync 实例（etag 命名空间按实体分离，见 ai-docs/plan）：
  //   files 实例：身份=全名（fileName 恒等；encFileName 追加 .zip，加密容器外扩展名 ADR-0012 无损可逆）；
  //     appKey="files" → `${ns}.files.etag:`；**manageDirty:false**——文件 dirty 权威在 local-head 的 `${ns}.files.dirty:`，
  //     若 cloud-sync 也写同键，push 成功写 "0" 会与「push 期间用户新编辑写 '1'」竞态、把未推编辑误判 clean 被驱逐（§A 最狠红线）。
  const cloud: CloudSync = createCloudSync({ provider, kv, fileName: config.fileName ?? ((n: string) => n), encFileName: config.encFileName ?? ((n: string) => `${n}.zip`), appKey: "files", manageDirty: false });
  //   collections 实例：云端落 `/.${appId}/<name>.json`（隐藏夹，isHidden 过滤出图库）；appKey="collections" → `${ns}.collections.etag:`/`.dirty:`。
  //     store.collection(name) 走它。name 无后缀，store 追加 `.json`。
  //     （**无保留名**：2026-07-13 起 `settings` 也只是个普通 collection 名，assertValidCollectionName 只校验文件名合法性。）
  const collectionsCloud: CloudSync = createCloudSync({ provider, kv, fileName: (n: string) => `.${appId}/${n}.json`, appKey: "collections" });
  const sub = createSubstrate();
  const head = createLocalHead({
    kv,
    getCloudEtag: (n: string) => cloud.getETag(n),
    setCloudEtag: (n: string, e: string | null) => cloud.setETag(n, e),   // 采纳云版时提交 durable etag（见 local-head.markSynced 注释：合 R1，非违规）
    keyPrefix: "files",
  });   // → `${ns}.files.dirty:`（文件 dirty 权威）
  // 数据迁移框架（ADR-0019）：**createStore 内部自跑、隐形**——app 看不见 migration。
  //   MIGRATIONS 现为空（无用户/无后向兼容，2026-07-13 清 tax）→ 编排跑空、无 op；框架留着待将来第一条真迁移。
  //   ops 首用前 await migrationReady（open/save/list）。测试/无 localStorage 环境跳过。
  const migrationReady: Promise<void> =
    config.skipMigration || !(globalThis as { localStorage?: unknown }).localStorage
      ? Promise.resolve()
      : runStoreMigrations(appId, databaseId);
  const offloadMod = createOffload({ cloud, local, head, isOnline, serialize: sub.serialize });   // serialize：offload 的 hardDelete ⟂ save 的 local 写互斥（红线：驱逐不吃未推字节）
  // 云端防抖标记（candidate-gone）：clean cloud-gone 孤儿第一次权威见 gone 只标记，跨 GRACE 第二次+ 才 send trash（用户拍板 ~24h，2026-07-17）。
  const CLOUD_GONE_GRACE_MS = 24 * 3600 * 1000;
  const pendingGone = createPendingGone(kv, config.cloudGoneGraceMs ?? CLOUD_GONE_GRACE_MS);
  const reconcileMod = createReconcile({ cloud, local, head, pending: pendingGone, isOnline, activeFileName: config.activeFileName });

  // ── folder 本地登记（离线建空夹）：pending = 建了但还没确认上云的空文件夹。──────────────
  //   离线也能建空夹（用户要求）：先 kv 登记 → 并进 listAllItems.folders（离线可见/持久）→ 回线 drainFolders 补建。
  const FOLDERS_PENDING_KEY = "internal.pending_new_folders";   // 相对键 → `${ns}.internal.pending_new_folders`
  const readPending = (): string[] => { try { const v = JSON.parse(kv.get(FOLDERS_PENDING_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
  const writePending = (a: string[]): void => kv.set(FOLDERS_PENDING_KEY, JSON.stringify([...new Set(a)]));
  const addPendingFolder = (p: string): void => writePending([...readPending(), p]);
  const clearPendingFolder = (p: string): void => writePending(readPending().filter((x) => x !== p));
  // ensureFolder：本地先登记（离线可见/持久），在线则补建云端并清 pending；离线/失败留 pending 等 drainFolders。
  async function ensureFolderLocalFirst(path: string): Promise<void> {
    assertValidFileName(path, appId);   // 路径护栏：禁在 .trash/.backup/.<appId> 保留根建夹
    cancelFolderDeletionForDescendant(path);   // 建夹（含重建同名）→ 撤销该夹/祖先的排队删除（eager-cancel）
    addPendingFolder(path);
    if (isOnline()) { try { await cloud.ensureFolder(path); clearPendingFolder(path); } catch { /* 留 pending，回线补建 */ } }
  }
  async function drainFolders(): Promise<void> {
    if (!isOnline()) return;
    for (const p of readPending()) { try { await cloud.ensureFolder(p); clearPendingFolder(p); } catch { /* 下次再补 */ } }
  }

  // ── 离线「删已上云空夹」队列（镜像 delete-file 队列 delete.ts；只排**空**夹——enqueue 前已两端判空）。──────────
  //   重放走 cloud.deleteEmptyFolder（护栏在 backend）：非空(别端加了内容/子夹)→取消(content wins)、list-failed→留队 defer。
  const FOLDER_DEL_KEY = "internal.pending_folder_deletions";   // 相对键 → `${ns}.internal.pending_folder_deletions`
  const readFolderDel = (): string[] => { try { const v = JSON.parse(kv.get(FOLDER_DEL_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
  const writeFolderDel = (a: string[]): void => { const s = [...new Set(a)]; if (s.length) kv.set(FOLDER_DEL_KEY, JSON.stringify(s)); else kv.remove(FOLDER_DEL_KEY); };
  const enqueueFolderDel = (p: string): void => writeFolderDel([...readFolderDel(), p]);
  const dequeueFolderDel = (p: string): void => writeFolderDel(readFolderDel().filter((x) => x !== p));
  // eager-cancel（镜像 pendingGone.clear，Q6 命门）：在 path 下创建后代（存文件/建夹）→ 撤销该祖先的排队删除（un-hide）。
  function cancelFolderDeletionForDescendant(path: string): void {
    const q = readFolderDel();
    const keep = q.filter((f) => !(path === f || path.startsWith(`${f}/`)));
    if (keep.length !== q.length) { writeFolderDel(keep); for (const f of q) if (!keep.includes(f)) notifyFolderOf(f); }
  }
  // 重放删文件夹（drainOfflineQueue 第 4 步）：**深→浅**（父夹见空子夹会误判 non-empty；先删深的）。
  async function drainFolderDeletions(): Promise<void> {
    if (!isOnline()) return;
    const q = readFolderDel().sort((a, b) => b.split("/").length - a.split("/").length);
    for (const p of q) {
      let r; try { r = await cloud.deleteEmptyFolder(p); } catch (e) { ui.reportError(e, "warning"); continue; }   // 非文件夹等异常 → 留队 skip
      if (r.status === "list-failed") continue;                 // 确认不了空 → 留队 defer
      dequeueFolderDel(p); notifyFolderOf(p);                   // deleted/already-gone/non-empty(content wins 取消) 都终态出队
    }
  }

  // 离线队列统一重放（app 在 online/boot/reconnect 调）——**按序**：新文件夹补建 → 新上传补推 → 删文件 → 删文件夹(深→浅)。
  //   删文件夹放最后：queued 文件删完 → 夹才真空 → deleteEmptyFolder 才成。
  async function drainOfflineQueue(): Promise<void> {
    await drainFolders();                 // ① 新建的空夹补建（先建，后面的上传可能落在里头）
    await uploadReplay.drain();           // ② 离线新上传补推（ADR-0018；ask 模式内部先问）
    await del.drainDeleteQueue();         // ③ 离线删文件重放（base-etag 守卫，edit-wins）
    await drainFolderDeletions();         // ④ 离线删文件夹重放（深→浅，non-empty 取消 / list-failed defer）
  }

  // ── 统一列举（README §2）：整个虚拟 FS 一次列举 = local ∪ cloud，每项带 syncState。mergeLocalCloud 收进库内。──
  const listing = createListing({ cloud, local, head, pendingFolders: readPending, isPendingGone: (p) => pendingGone.isPending(p), pendingFolderDeletions: readFolderDel });

  // ── watchFolder（网盘模型）：订阅**一个**文件夹。app 只知「这一夹更新了」，分不出也不需分 local/remote。──────
  //   连接态 store 自持（config.signedIn/isOnline）——app 不再传 ctx。每次回调同 shape（FolderSnapshot，仅该夹直属子项）。
  //   两帧节律：① 立即本地帧（绝不空/throw，offline-first）② 云端帧（拉该夹一次 + 惰性 reconcileFolder，到了用**同一 cb** 再闪）。
  //   之后本夹任何本地写（save/rename/delete/建删夹）→ notifyFolderOf 重推本地帧（即时反映，无云往返；云端刷新只在订阅时/显式）。
  const signedIn = config.signedIn ?? ((): boolean => true);
  const ctxNow = (): ListContext => ({ signedIn: signedIn(), online: isOnline() });
  const LOCAL_CTX: ListContext = { signedIn: false, online: false };   // 强制本地视角（首帧/写后重画：云不可达 → 纯本地 union）
  const folderWatchers = new Map<string, Set<(s: FolderSnapshot) => void>>();

  // 推一帧给某夹的所有 watcher。**sanity-check**：snapshot.path 必须 === 订阅 path——orchestration 错乱把别夹推来就丢弃（红线：绝不把别夹内容塞给这个 watcher）。
  function emitFolder(folder: string, snap: FolderSnapshot): void {
    if (snap.path !== folder) { ui.reportError(new Error(`watchFolder 路径错乱：订阅「${folder}」收到「${snap.path}」，已丢弃`)); return; }
    const set = folderWatchers.get(folder);
    if (!set) return;
    for (const cb of set) { try { cb(snap); } catch (e) { ui.reportError(e); } }
  }
  async function pushLocalFrame(folder: string): Promise<void> {
    if (!folderWatchers.has(folder)) return;
    try { emitFolder(folder, await listing.listFolder(folder, LOCAL_CTX)); } catch (e) { ui.reportError(e); }
  }
  async function pushRemoteFrame(folder: string): Promise<void> {
    if (!folderWatchers.has(folder)) return;
    void ensureScaffold();   // store 自管 scaffold 的首次云成功点：开库时 auth 未就绪跳过的，这里（app 订阅、auth 就绪后）补建
    await reconcileMod.reconcileFolder(folder).catch((e) => ui.reportError(e));   // 「看到夹才 reconcile」：惰性、非静默、仅本夹
    try { emitFolder(folder, await listing.listFolder(folder, ctxNow())); } catch (e) { ui.reportError(e); }
  }
  // 写路径变动 → 通知受影响夹（name 的父夹）的 watcher 即时重画本地帧。
  function notifyFolderOf(name: string): void {
    void pushLocalFrame(name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "");
  }
  function watchFolder(folder: string, cb: (s: FolderSnapshot) => void): () => void {
    if (folder) assertValidFileName(folder, appId);   // 路径护栏（空=根，放行）：禁订阅保留根
    let set = folderWatchers.get(folder);
    if (!set) { set = new Set(); folderWatchers.set(folder, set); }
    set.add(cb);
    void (async () => {
      await migrationReady;
      try { cb(await listing.listFolder(folder, LOCAL_CTX)); } catch (e) { ui.reportError(e); }   // ① 本地帧（该新订阅者）
      await pushRemoteFrame(folder);                                                              // ② 云端帧（全体 watcher）
    })();
    return (): void => { const s = folderWatchers.get(folder); if (s) { s.delete(cb); if (!s.size) folderWatchers.delete(folder); } };
  }

  // ── 名字占用检查（**唯一权威**：local + remote 统一在此）——rename 护栏、tryMove、mode:"new" 首存护栏、app 预检全走它。──
  //   本地已有 → "local"；否则在线且云端已有 → "cloud"；都无（或离线查不了云）→ null。离线只查本地（靠 push conflictBehavior:fail 兜底）。
  async function nameOccupied(name: string): Promise<"local" | "cloud" | null> {
    if (await local.exists(name)) return "local";
    if (isOnline()) { try { if (await cloud.fetchMeta(name)) return "cloud"; } catch { /* 云不可达 → 当未占用，push 时 fail 兜底 */ } }
    return null;
  }

  // ── seal：加密透明（crypto-container 默认；getPassword 非交互）。JRP 不加密 → getPassword 恒 null=透传 ──
  const seal = createSeal({
    looksContainer: (b) => looksEncryptedContainer(b),
    pack: (o) => packContainer({ dataBytes: o.dataBytes, fileName: o.fileName, ext: o.ext, peek: o.peek, password: o.password }),
    unpack: (blob, pw) => unpackContainer(blob, pw),
    getPassword,
    getPrev: (n) => local.get(n),
    makePeek: config.crypt?.makePeek,   // 明文→peek（app 域，如 ora 缩略图）；不给 → 容器无 peek
    ext: config.crypt?.ext,             // 真扩展名 → meta.bin
  });

  // ── flow 深模块 ──
  const safeResolve = createSafeResolve({
    cloud, local, head,
    localDirty: () => sub.edits.localDirty(),
    validateAdopt,
    unseal: (n, blob) => seal.unsealForRead(n, blob),   // 返明文；加密但锁定 → null（safePull 退验封套）
    looksEncrypted: (b) => looksEncryptedContainer(b),
  });
  const pushMod = createPush({ cloud, head, seal, safeResolve, serialize: sub.serialize, editVersion: () => sub.edits.version(), busy: ui.busy });

  // ── ADR-0018 离线「新上传」回线补推（仅 never-synced float；编辑仍 consent-surface）────────────
  const uploadReplayPolicy: UploadReplayPolicy = config.offlineUploadReplay ?? "manual";
  if (uploadReplayPolicy !== "manual") {   // 强制 UI（禁 noop/silent），对齐 busy/resolveConflict/reportError 的必填律
    if (!ui.onReplayStatus) throw new Error("createStore: offlineUploadReplay≠'manual' 需 ui.onReplayStatus（ADR-0018 强制 UI 提示）");
    if (uploadReplayPolicy === "ask" && !ui.confirmReplay) throw new Error("createStore: offlineUploadReplay='ask' 需 ui.confirmReplay（回线询问用户）");
  }
  // 后台 push 实例：与 pushMod 同深模块编排，唯 busy 换透传——drain 不锁屏（ADR-0018 §4：非 busy 后台）。
  const pushBg = createPush({ cloud, head, seal, safeResolve, serialize: sub.serialize, editVersion: () => sub.edits.version(), busy: (_l, fn) => fn() });
  async function pushLocalBytes(name: string): Promise<{ status: string }> {
    const blob = await local.get(name);
    if (!blob) return { status: "no-local" };
    const asBlob = blob instanceof Blob ? blob : new Blob([blob as BlobPart]);
    const plain = await seal.unsealForRead(name, asBlob);   // 得明文（JRP 不加密=原字节）
    if (!plain) return { status: "locked" };
    const plainU8 = await toU8(plain);
    return pushBg.doPush(name, { encode: () => plainU8 });   // 非 busy、未串行（uploadReplay 已 per-name serialize）；CloudNameCollisionError 抛出→出队 surface
  }
  const uploadReplay = createUploadReplay({
    kv, local, head, isOnline, serialize: sub.serialize, pushLocal: pushLocalBytes,
    policy: uploadReplayPolicy, confirm: ui.confirmReplay, onStatus: ui.onReplayStatus,
  });
  const fresh = createFreshness({ cloud, head, safeResolve, busy: ui.busy });
  const del = createDelete({ cloud, local, head, kv, busy: ui.busy });
  const identity = createIdentity({
    cloud, local, head, doPush: pushMod.doPush, serialize: sub.serialize, serialize2: sub.serialize2, seal, busy: ui.busy,
    // 离线 move = 删+建（决策 1A/2）：在线走 identity 内的服务端原子 move；离线降级，复用 del.del 离线删 + uploadReplay 补推。
    isOnline,
    deleteOffline: (name: string) => del.del(name, { isOnline }).then(() => {}),   // 完整离线删语义（move-aside + base-etag 云删排队 + null 守卫 + forget）
    queueUpload: (name: string) => uploadReplay.enqueue(name),                     // never-synced float 重连补推（ADR-0018）
    nameOccupied,                                                                  // 唯一占用检查（assertNameFree 据此抛）
  });
  const trashMod = createTrash({ cloud, local, head, busy: ui.busy });

  // 回收站/备份箱两端聚合（README §2）：cloud + local 一次列举 → mergeTrash 归并成单一 TrashItem[]。
  //   trash 才判 conflictLive（备份箱是冲突 loser、无此语义 → 传空 live set）；且仅当有本地项时才拉 live（省 listAll 全树 walk）。
  async function aggregateBox(box: "trash" | "backup"): Promise<TrashItem[]> {
    const cloudItems = await (box === "trash" ? cloud.listTrash() : cloud.listBackup());   // 内部已 catch → 出错返 []
    const localItems = box === "trash"
      ? (local.listTrash ? await local.listTrash() : [])
      : (local.listBackup ? await local.listBackup() : []);
    let live = new Set<string>();
    if (box === "trash" && localItems.length && isOnline()) {
      const all = await cloud.listAll().catch(() => null);
      if (all && all.complete) live = new Set(all.files.map((f) => f.name ?? f.path));   // 只在权威（complete）时填 → 非权威=空集=conflictLive 不误报
    }
    return mergeTrash(localItems, cloudItems, live);
  }

  // ── 单飞守卫（port 自 WebPaint store.ts，2026-06-21 起红线）：用户态写流同一时刻只一个，
  //   并发的第二个**直接拒**（throw STORE_BUSY），调用方 catch→报状态。与 ui.busy 正交、更硬
  //   （busy 只是 UI 防误点、无 UI 时失效；这道库内自带，无头复用也挡得住）。同名字节竞争仍由
  //   substrate.serialize2 兜底，这道在其上加「全局同一时刻只一个用户态写」的更强语义（user 明确要）。
  //   安全前提：被守的流互不内部调用——rename 内部走 doPush（非被守流）；del/restore/purge/
  //   emptyTrash 直调 adapter；newFolder/deleteFolder 直调 cloud.*。新增被守流前先核这条，否则嵌套自锁。
  let _userWriteInFlight: string | null = null;
  function singleFlight<A extends unknown[], R>(label: string, fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
    return (...a: A): Promise<R> => {
      if (_userWriteInFlight) {
        const e = new Error(`有另一项操作进行中（${_userWriteInFlight}），请等它完成再试`) as Error & { code?: string };
        e.code = "STORE_BUSY";
        return Promise.reject(e);
      }
      _userWriteInFlight = label;
      return Promise.resolve().then(() => fn(...a)).finally(() => { _userWriteInFlight = null; });
    };
  }
  const delSF = singleFlight("删除", (n: string) => { uploadReplay.remove(n); return del.del(n, { isOnline }); });   // 删=supersede：从补推队列摘掉（ADR-0018）   // 接 isOnline：离线删走 move-aside + base-etag 守卫的删队列（重连 drainDeleteQueue 重放）
  // file.tryMove(to)：改身份/移动的**唯一结果式入口**（file() 无 rename，editor-session 也走这里）——**本操作含目标占用检查**（第一行 nameOccupied，占用则不动字节直接返错）。
  //   ok:false 时调用方 surface（UI 拒绝/重问）；不抛 CloudNameCollisionError（内部护栏是兜底，这里预检过即 skip）。
  const tryMoveSF = singleFlight("移动", async (from: string, to: string): Promise<TryMoveResult> => {
    const occ = await nameOccupied(to);
    if (occ) return { ok: false, reason: "name-collision", where: occ };
    const r = await identity.rename(from, to, { skipOccupiedCheck: true });   // 已 nameOccupied 预检，跳过内部重复
    notifyFolderOf(from); notifyFolderOf(to);                                 // 旧夹移出 + 新夹移入，两边重画
    // 结果必须透出去：以前这里整个丢掉 r，于是 app 无条件报「已重命名（含云端）」——
    //   云端推失败(cloudDeferred)、旧名成孤儿(oldCloudOrphan)、旧名被留下(oldKept) 全被吞掉 = UI 谎报成功。
    return { ok: true, where: r.where, oldKept: r.oldKept, oldUnknown: r.oldUnknown, oldCloudOrphan: r.oldCloudOrphan, cloudDeferred: r.cloudDeferred, oldName: from };
  });

  // ── ui 映射：冲突回调把 local/cloud 字节取来喂 ui.resolveConflict（必填，绝不静默 cancel）──
  const onConflict = async ({ name }: { name: string }): Promise<ResolveChoice> => {
    const [localBlob, cloudPull] = await Promise.all([local.get(name), cloud.pull(name).catch(() => null)]);
    return ui.resolveConflict({ name, local: localBlob, cloud: cloudPull?.blob ?? null });
  };

  // ── 加密：读侧原语 + at-rest transform（照搬 WebPaint store.ts，见 ai-docs/11；JRP 不注入 codec → dormant）──
  //   非交互：无/错密码 → null / status:"locked"（绝不弹窗）。解锁循环是 app 在 busy 外的事（seal.withPassword 守）。
  async function encTailBytes(name: string, n: number, tryCloud: boolean): Promise<Blob | null> {
    const blob = await local.get(name);                          // 本地有 → 尾切片（IDB Blob.slice 惰性）
    if (blob) { const b = blob instanceof Blob ? blob : new Blob([blob as BlobPart]); return b.slice(Math.max(0, b.size - n)); }
    if (tryCloud && cloud.pullTail) { const t = await cloud.pullTail(name, n); return t ? new Blob([t.bytes as BlobPart]) : null; }  // 纯云端 peek：byte-range
    return null;
  }
  // getPeek 的字节源：尾片 + 总字节 + 「按绝对偏移二次拉」。本地→Blob.slice（惰性，不碰网）；纯云端→byte-range。
  //   range() 供库内 zip 解析在 CD/entry 溢出尾片时二次拉（本地切片 / 云端 pullRange）。
  async function openPeekSource(name: string, n: number): Promise<PeekSource | null> {
    const blob = await local.get(name);
    if (blob) {
      const b = blob instanceof Blob ? blob : new Blob([blob as BlobPart]);
      const total = b.size;
      const tail = new Uint8Array(await b.slice(Math.max(0, total - n)).arrayBuffer());
      return { totalSize: total, tail, range: async (off, len) => new Uint8Array(await b.slice(off, off + len).arrayBuffer()) };
    }
    if (cloud.pullTail) {
      const t = await cloud.pullTail(name, n);
      if (!t) return null;
      const tail = t.bytes instanceof Uint8Array ? t.bytes : new Uint8Array(t.bytes as ArrayBufferLike);
      const total = t.item.size || tail.length;
      return {
        totalSize: total, tail,
        range: async (off, len) => {
          const r = cloud.pullRange ? await cloud.pullRange(name, off, len) : null;
          return r ? (r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes as ArrayBufferLike)) : null;
        },
      };
    }
    return null;
  }
  // 把一段密文 peek（getPeek 返回的 ENC_PEEK_MIME 段）非交互解密成明文字节。非 ENC_PEEK_MIME（已明文）→ 原样返。锁定/错密码→null。
  async function decryptEncPeek(name: string, encPeek: Blob): Promise<Blob | null> {
    if (encPeek.type !== ENC_PEEK_MIME) return encPeek;   // 明文（如 image/png）直接给
    const parsed = scanEncPeekFromEnd(new Uint8Array(await encPeek.arrayBuffer()));
    if (!parsed) return null;
    const plain = await seal.withPassword(name, (pw) => decryptPeek(parsed, pw));   // 非交互内存密码；锁定 → null
    return plain ? new Blob([plain as BlobPart]) : null;
  }
  async function encVerify(name: string, pw: string): Promise<boolean> {     // app 解锁循环的便宜验证器（解 peek，不碰 7z）
    if (!pw) return false;
    const tail = await encTailBytes(name, PEEK_TAIL_WINDOW, true);
    if (tail) { const p = scanEncPeekFromEnd(new Uint8Array(await tail.arrayBuffer())); if (p) { try { await decryptPeek(p, pw); return true; } catch { return false; } } }
    const full = await local.get(name);                          // 无 peek（裸 .7z）→ 退回整字节解一把（贵）
    if (!full) return false;
    try { await unpackContainer(full instanceof Blob ? full : new Blob([full as BlobPart]), pw); return true; } catch { return false; }
  }
  async function encIsEncrypted(name: string): Promise<boolean> {
    const blob = await local.get(name);
    return blob ? looksEncryptedContainer(blob instanceof Blob ? blob : new Blob([blob as BlobPart])) : false;
  }
  // 字节替换共用流（_swapBytes 红线，照搬 WebPaint）：① 本地先落地 ② 云端 If-Match 跟进，失败→标脏+锚 parent=换前云版
  //   交正常 push 流接力收敛（v233 教训：只换一端 = 加密被静默撤销）③ 曾同步但离线 → 拒（防只换一端）④ 错密码前置出局。
  async function encSwap(name: string, bytes: Bytes, online: () => boolean, encrypted: boolean): Promise<{ status: string }> {
    const prevEtag = cloud.getETag(name);
    const tracked = prevEtag != null;
    if (tracked && !online()) return { status: "offline" };
    await local.save(name, bytes);                               // ① 字节真相先落地（已在 encEncrypt 的 serialize 锁内）
    if (!tracked) return { status: "swapped" };
    try {
      const { item } = await cloud.push(name, bytes, { baseEtag: head.seenBase(name), encrypted });   // If-Match + 扩展名翻转
      // F0 同款：没回 eTag = 云端落地**未确认**。本地字节已经换了（①），所以这和"云没跟上"是同一种局面
      //   → 走下面 catch 分支的等价路径（base/parent←换前云版 + 标脏），交 push 流接力，绝不当 swapped 清脏。
      if (!(item && item.eTag)) {
        head.onPushed(name, prevEtag, true);
        return { status: "cloud-deferred" };
      }
      head.onPushed(name, item.eTag, false);                     // 落地：base←新 etag、清 dirty/parent
      return { status: "swapped" };
    } catch (e: unknown) {
      head.onPushed(name, prevEtag, true);                       // ② 本地已换、云没跟上 → base/parent←换前云版 + dirty，push 流接力（下次 If-Match 旧云版：没人动→换成功；动过→412 surface）
      return { status: (e as { name?: string } | null)?.name === "CloudConflictError" ? "conflict" : "cloud-deferred" };
    }
  }
  async function encEncrypt(name: string, online: () => boolean): Promise<{ status: string }> {
    return ui.busy(`正在加密 ${name}…`, () => sub.serialize(name, async () => {
      const blob = await local.get(name);
      if (!blob) return { status: "no-local" };
      const asBlob = blob instanceof Blob ? blob : new Blob([blob as BlobPart]);
      if (await looksEncryptedContainer(asBlob)) return { status: "already" };
      if (cloud.getETag(name) != null && !online()) return { status: "offline" };   // 早退：还没打包就知两端换不齐
      const pw = getPassword(name);
      if (!pw) return { status: "locked" };                      // 首次加密密码由 app 调用前放进 getPassword seam
      let peek: Uint8Array | null = null;
      if (config.crypt?.makePeek) { try { peek = await config.crypt.makePeek(asBlob); } catch { peek = null; } }
      const container = await packContainer({ dataBytes: await toU8(asBlob), fileName: name, ext: config.crypt?.ext, peek, password: pw });
      return await encSwap(name, await toU8(container), online, true);
    }));
  }
  async function encDecrypt(name: string, online: () => boolean): Promise<{ status: string }> {
    return ui.busy(`正在解除加密 ${name}…`, () => sub.serialize(name, async () => {
      const blob = await local.get(name);
      if (!blob) return { status: "no-local" };
      const asBlob = blob instanceof Blob ? blob : new Blob([blob as BlobPart]);
      if (!(await looksEncryptedContainer(asBlob))) return { status: "not-encrypted" };
      if (cloud.getETag(name) != null && !online()) return { status: "offline" };
      const res = await seal.withPassword(name, (pw) => unpackContainer(asBlob, pw));   // ④ 非交互解；无/错密码→locked，任何持久改动前出局
      if (!res) return { status: "locked" };
      return await encSwap(name, await toU8(res.dataBlob), online, false);
    }));
  }

  // ── file 工厂（重载：isZip 编译期分流）──
  //   mode="new"（新建画布）：首次 save 前查占用，已占用 → 抛 CloudNameCollisionError（**绝不静默覆盖同名**）。
  //     红线归位：不覆盖的保证收进 store（不依赖每个 app 调用方记得先查重名）。"existing"（默认）= 普通 open/编辑，覆盖是正常持久。
  function makeRaw(name: string, mode: "new" | "existing" = "existing"): RawFile {
    let _createChecked = mode !== "new";   // "new" 首次 save 前做一次占用检查；之后（本对象已建）跳过，后续 autosave 是编辑不是新建
    const readLocal = async (): Promise<Blob | null> => {        // 读本地缓存字节 → 解壳出明文
      const blob = await local.get(name);
      if (!blob) return null;
      const asBlob = blob instanceof Blob ? blob : new Blob([blob as BlobPart]);
      return await seal.unsealForRead(name, asBlob);
    };
    return {
      async save(bytes, opts) {
        await migrationReady;
        if (!_createChecked) {                                   // mode="new" 首存护栏：撞名不覆盖（本地/在线云端任一占用即抛）
          _createChecked = true;
          const where = await nameOccupied(name);                // v417：把 where 带进错误——本地占用别谎称"云端同名"
          if (where) throw new CloudNameCollisionError(name, where);
        }
        head.recordEdit(name);                                   // 同步标脏：offload 的 isDirty 守卫立即可见（防驱逐吃未推字节）
        pendingGone.clear(name);                                 // 编辑取消 candidate-gone：grace 内被编辑 → 立即当正常 dirty 文件处理（不等下轮 reconcile）
        cancelFolderDeletionForDescendant(name);                 // 在待删夹下存文件 → 撤销该夹的排队删除（eager-cancel，Q6）
        const plain = await toU8(bytes);
        const sealed = await seal.sealForWrite(name, plain);
        await sub.serialize(name, () => local.save(name, sealed, opts?.hint));   // local 写同名串行链：与 offload.hardDelete 互斥（C2 红线）；hint 透传缩略图
        notifyFolderOf(name);                                    // 网盘模型：本夹 watcher 即时反映新增/变脏（无云往返；gallery 没开=cheap no-op）
        if (opts?.tryPush === false) return { pushed: false, reason: "not-attempted" };   // 只落本地（autosave/consent-safe，ADR-0016/0018：opaque Work 的 push 必 consent-gated）
        // surfaceCollision：**编辑既有文件**时，谱系断裂撞名走冲突面而非抛 collision（push.ts 的长注释解释了为什么两者相反）。
        //   mode:"new" 的首存不给 —— 那里撞名是「别的设备建了同名不同物」，抛错两份都留是 §A 身份行的保证。
        let pushed = false, reason: string | undefined;
        try {
          const r = await pushMod.push(name, { encode: () => plain, onConflict, surfaceCollision: mode !== "new" });
          // 只有拿到新 etag 的落地才算推上去了。deferred(落地未确认)/unresolved/cancelled 一律不算——
          //   把它们当成功正是 F0 红线要拦的那类「落地未确认当落地成功」。
          pushed = r.status === "pushed" || r.status === "healed" || r.status === "resolved";
          if (!pushed) reason = r.status;
        } catch (e) { ui.reportError(e); reason = "error"; }
        // ADR-0018：离线「新上传」补推——push 没成(仍 dirty) ∧ 从没 synced(seenBase null) → 入队，回线 drainUploadQueue 补推。
        if (head.isDirty(name) && head.seenBase(name) == null) uploadReplay.enqueue(name);
        return { pushed, reason };
      },
      async open() {
        await migrationReady;
        if (await local.exists(name)) {                          // 有本地副本 → **先 etag 检查**（fresh.open）：in-sync 读本地、变了才拉云、脏 surface
          // isOnline：离线直接读本地、不碰 fetchMeta（离线模式完美工作，绝不卡 open）。
          // offlineEscape：在线但 fetchMeta 挂死（iOS 老 token iframe）时，用户点「跳过到离线」→ probe 赢 race → 读本地。
          //   对齐 WebPaint cloud-freshness「跳过到离线」（无硬超时，用户即超时）。不立即返缓存=防云端变了再采纳的闪。
          const esc = isOnline() ? ui.offlineEscape?.() : undefined;
          try { await fresh.open(name, { isOnline, probe: esc?.probe }).catch((e) => ui.reportError(e)); }
          finally { esc?.settle(); }
          return readLocal();
        }
        if (autoCacheOpenedFile) {                                          // 本地没有、持有模式 → 拉云落本地（无可显示，必须等）
          // ⚠ 这条分支（打开一个**纯云端、本地从没缓存过**的作品）以前没有任何出口：
          //   「在线但 OneDrive 不可达」（DNS 挂 / 代理 / 企业网限流）时 provider 的 fetch 可能挂很久，
          //   spinner 就一直转，用户连退回离线去读别的本地文件都做不到。
          //   → 和上面 fresh.open 同款处理：给一个「跳到离线」的出口（无硬超时，用户即超时）。
          //   跳出后 acquire 仍在后台跑（成功了就当一次迟到的缓存填充，无害）；本地此刻没有 → 返 null，
          //   由 app 诚实地报「打不开」，**绝不假装成功**。
          const esc = isOnline() ? ui.offlineEscape?.() : undefined;
          const pulling = identity.acquire(name, { localName: name }).catch((e) => { ui.reportError(e); return null; });
          try { await (esc ? Promise.race([pulling, esc.probe]) : pulling); }
          finally { esc?.settle(); }
          return readLocal();
        }
        // 本地没有、过路模式（autoCacheOpenedFile:false，流式消费）→ 整份拉云、**不落本地**，直接返字节
        const pulled = await cloud.pull(name).catch((e) => { ui.reportError(e); return null; });
        return pulled ? await seal.unsealForRead(name, pulled.blob) : null;   // range/streaming（按需取片）是 ⚠TODO 优化
      },
      pullIfClean(opts) { return fresh.refresh(name, { isOnline, ...opts }); },   // 事件驱动干净快进（clean→FF、dirty→no-op）；默认注入 store 的 isOnline（离线早退，不空跑 fetchMeta）
      tryMove(to) { return tryMoveSF(name, to); },
      async delete() { const r = await delSF(name); notifyFolderOf(name); return r; },   // 返 DelResult（v436）：cancelled/noop/queuedCloudDelete 都不是「已删除」
      reupload() {
        return ui.busy("重新上传…", async () => {
          if (!(await local.exists(name))) return { status: "no-local" };
          pendingGone.clear(name);                 // 用户已对 candidate 动手 → 清标记（成功=synced；失败=转 dirty/conflict，都不再是 pendingGone）
          head.forget(name);                       // 断旧云谱系（cloud 已 gone）→ no-base 首推
          head.recordEdit(name);                   // 标未推 → 走首推路径（no-base，conflictBehavior:fail 撞名不覆盖）
          const r = await pushLocalBytes(name);    // 复用 vetted push（seal 正确 + N6 + 撞名抛 CloudNameCollisionError → app surface）
          if (!head.isDirty(name)) { pendingGone.clear(name); notifyFolderOf(name); }   // push 成功 = synced → 清 candidate + 重画
          return r;
        });
      },
      isKeptOffline() { return local.exists(name); },   // 有本地副本 = 已留作离线（无 LRU、无独立 pin flag）
      async keepOffline() {   // 确保本地有副本（未缓存则 acquire；离线/失败 best-effort）
        if (!(await local.exists(name))) { try { await identity.acquire(name, { localName: name }); } catch (e) { ui.reportError(e); } }
      },
      offload() { return offloadMod.offload(name); },
      isEncrypted() { return encIsEncrypted(name); },
      encrypt(opts) { return encEncrypt(name, opts?.isOnline ?? isOnline); },
      decrypt(opts) { return encDecrypt(name, opts?.isOnline ?? isOnline); },
      verifyPassword(pw) { return encVerify(name, pw); },
    };
  }

  // opts.mode（**显式必填**）：new=新建画布（撞名不覆盖，抛 collision）；existing=普通 open/编辑（大多数）。
  //   逼调用方想清「这是新建还是打开已有」——省略/误用是调用方责任（TS 编译期必填）。路径护栏：拒保留根（.trash/.backup/.<appId>）。
  function file(name: string, opts: { isZip: true; mode: "new" | "existing" }): ZipFile;
  function file(name: string, opts: { isZip: false; mode: "new" | "existing" }): RawFile;
  function file(name: string, opts: { isZip: boolean; mode: "new" | "existing" }): RawFile | ZipFile;
  function file(name: string, opts: { isZip: boolean; mode: "new" | "existing" }): RawFile | ZipFile {
    assertValidFileName(name, appId);
    const raw = makeRaw(name, opts.mode);
    if (!opts.isZip) return raw;
    // getPeek：库内部解 zip 的 central directory，**按文件名**抓 entry 字节（格式盲、内容盲）。
    //   加密容器：外层明文 zip 带名为 CONTAINER_PEEK_ENTRIES 的旁路 entry（"peek"/老 "thumb"）——按名命中即
    //     返其**密文**字节(ENC_PEEK_MIME，不解密，供 app 缓存层原样存密文=明文不落 IDB)。明文 ora 无此名 entry 不误命中。
    //   明文容器：按 app 提供的 o.zipEntry 抓 → entry 原始字节 Blob(无 type)。找不到/不可达→null。
    const getPeek = async (o: { bytesLength: number; zipEntry: string }): Promise<Blob | null> => {
      const src = await openPeekSource(name, o.bytesLength);
      if (!src) return null;
      const entries = await readCentralDirectory(src);
      if (!entries) return null;
      const encEntry = entries.find((e) => CONTAINER_PEEK_ENTRIES.includes(e.name));   // 加密容器旁路块（密文）
      if (encEntry) {
        const bytes = await readEntryBytes(src, encEntry);
        return bytes ? new Blob([bytes as BlobPart], { type: ENC_PEEK_MIME }) : null;
      }
      const target = entries.find((e) => e.name === o.zipEntry);                       // 明文：唯一依据 = app 给的文件名
      if (!target) return null;
      const bytes = await readEntryBytes(src, target);
      return bytes ? new Blob([bytes as BlobPart]) : null;                             // 格式盲：不贴 MIME
    };
    const decryptPeekFn = (encPeek: Blob): Promise<Blob | null> => decryptEncPeek(name, encPeek);
    // at-rest 密文字节原样（内容盲、不解壳、不碰密码）。非加密件 / 无本地副本 → null。
    const getEncryptedBlob = async (): Promise<EncryptedBlob | null> => {
      const blob = await local.get(name);
      if (!blob) return null;                                   // 没有本地副本（纯云端未缓存）→ 拿不到 at-rest 字节
      const asBlob = blob instanceof Blob ? blob : new Blob([blob as BlobPart]);
      if (!(await looksEncryptedContainer(asBlob))) return null;   // 明文件 → null（brand 的运行时真相由这一行保证）
      return asBlob as EncryptedBlob;
    };
    return Object.assign(raw, { getPeek, decryptPeek: decryptPeekFn, getEncryptedBlob }) as ZipFile;
  }

  // ── collection / settings ──
  // ── collection scaffold（开库即 idempotent 建云端 `.${appId}/` 夹 + `.${appId}/<name>.json`）───────────────
  //   用户要求：开库时（第一次云成功）就把 collection 的云端文件建出来（哪怕空），离线跳过、回线 drainFolders 补。
  //   app 一旦 store.collection(name)（synced：如 synced-user-preference / brush-rack）→ 那份 idempotent 建出。local-only 不上云、不 scaffold。
  //   **store 自管，非 app 调**（app 不 ensure、不知情）：① 开库（首次创建/访问 store 对象）即 fire 一次——但构造时
  //   auth/online 常还没就绪（signedIn=false）→ 早退；② store 自己的**首次云成功点**（watchFolder 远端帧，app 订阅、
  //   auth 就绪后跑）再补。idempotent：ensureFolder(`.${appId}`) + 每个 collection 名 fetchMeta 无 → push 空信封建出来
  //   （baseEtag:null → conflictBehavior:fail，**绝不覆盖已有**）；每名建好记进 _scaffoldEnsured，全建好即封顶不再打扰。
  const _scaffoldNames = new Set<string>();
  const _scaffoldEnsured = new Set<string>();
  async function ensureScaffold(): Promise<void> {
    if (!isOnline() || !signedIn() || _scaffoldEnsured.size >= _scaffoldNames.size) return;
    await migrationReady;
    try { await collectionsCloud.ensureFolder(`.${appId}`); } catch (e) { ui.reportError(e); return; }   // 夹建不出（离线/失败）→ 整轮下次再试
    for (const name of _scaffoldNames) {
      if (_scaffoldEnsured.has(name)) continue;
      try {
        if (!(await collectionsCloud.fetchMeta(name).catch(() => null)))
          await collectionsCloud.push(name, emptyCollectionBytes(), { baseEtag: null });   // 云端没这文件才建空信封
        _scaffoldEnsured.add(name);
      } catch (e) { ui.reportError(e); }   // 撞名（别端已建）/离线 → 不 mark，下次 fetchMeta 命中即收敛
    }
  }
  function registerScaffold(name: string): void { _scaffoldNames.add(name); void ensureScaffold(); }

  // collection(name, opts)：synced（默认）走 collections 实例 + 云端 scaffold；{local:true} = local-only 变体
  //   （cloudless：只走 IDB 本地缓存、永不碰云、不 scaffold 云文件）——给设备本地设置/状态用。
  //   opts.getInitData：仅当这份 collection 的 json 不存在（新库）时调，填初始值（uat=1）。store 内容无关——
  //     app 域构造 [{id, value}]（如笔架把 builtin-brushes.json 映射进来）。
  //   **单例**：collection 是 app schema 的全局单例命名空间（非用户随建名字）——同名第二次返**同一对象**
  //     （否则两个实例各持内存信封、同步同一云文件 → 写互相看不见、冲突）。opts 以首次为准（后续调忽略 opts 差异）。
  const _collections = new Map<string, Collection>();
  function collection(name: string, opts: { manual?: boolean; local?: boolean; getInitData?: CollectionConfig["getInitData"] } = {}): Collection {
    assertValidCollectionName(name);
    const cached = _collections.get(name);
    if (cached) return cached;
    const coll = createCollection({ cloud: collectionsCloud, name, local: collectionLocal, manual: opts.manual, cloudless: opts.local, getInitData: opts.getInitData });
    if (!opts.local) registerScaffold(name);   // synced：store 自动在云端 idempotent 建出 .${appId}/<name>.json；local-only 不上云、不 scaffold
    _collections.set(name, coll);
    return coll;
  }

  return {
    // ── file（含 tryMove/pullIfClean/save/open/delete/reupload…）+ collection（单例）。改身份走 file.tryMove(to)。──
    file,
    collection,
    // ── files 命名空间：所有「不挂在单个 file 上」的文件域操作（列举订阅 / 文件夹增删 / 离线队列 / 回收站备份箱 / 名字占用 / 全库收敛）。──
    //   **唯一列举面 = files.watchFolder（订阅当前夹）**：立即本地帧、云端到了同一 cb 再闪。不暴露 list/listAll/localKeys
    //   （app 只放当前夹于内存；名字碰撞由 file.tryMove/mode:"new" 内化检测，不靠「先 list 目标夹」；全库 listAll 仅库内 reconcile 用）。
    files: {
      // 名字占用（**boolean**）：在线云端+本地都看，离线只看本地（靠 push conflictBehavior:fail 兜底）。app 新建/另存/改名前预检。
      nameOccupied: (name: string): Promise<boolean> => nameOccupied(name).then((o) => o != null),
      watchFolder,
      // 本地已缓存文件的总占用（字节 + 件数）。给 app 显示「本地存了多少」用。
      //   **口径**：只量本库 files 分区；**不含** trash/backup/collections 分区、不含 app 自己别的 IDB 库
      //   （如缩略图缓存）、不含纯云端未缓存的作品。
      //   ⚠ **只返两个标量、永不返名字** —— 它不是、也不能变成全库列举（列举唯一面 = watchFolder）。
      //   一次本地 IDB cursor（无网络），但仍是全表走一遍 → app 只在图库打开/刷新时调，别挂每帧。
      usage: () => local.usage(),
      // 文件夹增删（gallery folder-tree）：空文件夹增删。**离线也能建**（本地登记 + 回线 drainOfflineQueue 补建）。删除「必须证实为空」库内强制（removeFolder 权威判空）。
      ensureFolder: (path: string) => ensureFolderLocalFirst(path),
      newFolder: singleFlight("新建文件夹", (path: string) => ui.busy("新建文件夹…", async () => { await ensureFolderLocalFirst(path); notifyFolderOf(path); })),   // 子夹出现在父夹 → 重画父夹
      deleteFolder: singleFlight("删除文件夹", (path: string) => ui.busy("删除文件夹…", async (): Promise<void> => {
        assertValidFileName(path, appId);                            // 路径护栏
        // 判空**两端都查**：本地有该夹下的文件（含 local-only/未上云）→ 拒删（否则删掉云端夹、本地文件成孤儿）。
        const prefix = `${path}/`;
        if ((await local.appKeys()).some((k) => k.startsWith(prefix))) throw new Error(`文件夹非空（本地有文件），拒绝删除：${path}`);
        const wasPending = readPending().includes(path);
        clearPendingFolder(path);                                    // **保持在 enqueue 前**（互斥 pending_new_folders：一个夹不能同时在建队列和删队列）
        if (!isOnline()) {
          if (wasPending) { notifyFolderOf(path); return; }          // 从没上云 → 清登记即删
          enqueueFolderDel(path); notifyFolderOf(path);              // 已上云空夹 → 排队 + 隐藏（listing 减去），回线 drainFolderDeletions
          return;
        }
        const r = await cloud.deleteEmptyFolder(path);               // backend 护栏：只删空夹
        if (r.status === "non-empty") throw new Error(`文件夹非空，拒绝删除：${path}`);
        if (r.status === "list-failed") throw new Error(`无法确认文件夹是否为空（列举失败），已拒绝删除：${path}`);
        notifyFolderOf(path);                                        // deleted / already-gone：子夹从父夹消失 → 重画父夹
      })),
      // 离线队列统一重放（app 在 focus/visibility/online/boot 调）：新文件夹补建 → 新上传补推 → 删文件重放（按序）。
      drainOfflineQueue,
      // 回收站/备份箱列表：**本地↔云两端聚合**（mergeTrash）。只返元数据（trashKey/cloudItemId/原名/加密标志/conflictLive），绝不带 blob。
      //   conflictLive（离线删被 edit-wins 撤销→本地 trash 有、云端还活着）：仅当有本地 trash 项且能拿到**权威** live 列表时才判（离线/partial→空集→不误报）。
      listTrash: () => aggregateBox("trash"),
      listBackup: () => aggregateBox("backup"),
      restoreTrash: singleFlight("恢复", trashMod.restore),
      purgeTrash: singleFlight("彻底删除", trashMod.purge),
      emptyTrash: singleFlight("清空回收站", trashMod.emptyTrash),
      emptyBackup: singleFlight("清空备份箱", trashMod.emptyBackup),
      // **全库** cloud-gone 收敛（去抖后 send trash）。**仅用户显式指令**（隐藏的「校验完整性」入口），绝不自动/轮询——全树 listAll 是重活。
      //   日常开夹的惰性收敛已在 watchFolder 内走 reconcileFolder（看到夹才收敛，同一 converge SSOT）。
      reconcileAll: (opts?: { activeFileName?: string }) => reconcileMod.reconcile(opts),
    },
    // ── store.encryption：**裸字节**级的加密面（文件还没进 store、无 name 可查时用）。──────────
    //   有 name 的场景一律走 file.*（isEncrypted / encrypt / decrypt / verifyPassword /
    //   getPeek / decryptPeek / getEncryptedBlob）——那些能用便宜的 peek 路径，别走这里。
    //   设计约束：① 不做重复的计算 ② 不做不必要的计算。
    encryption: {
      /** 是不是加密容器。**只嗅魔数/尾窗**，不派生密钥、不解密（便宜，可用于分流）。 */
      isEncryptedBlob: (blob: Blob | Uint8Array): Promise<boolean> => looksEncryptedContainer(blob),

      /** 验密码 + 解出明文，**合一**。null = 错密码（或不是容器）。
       *
       *  为什么合一（这就是「不做重复的计算」）：旧面把它拆成 verifyContainer(验) + unsealWith(解)，
       *  而两者内部都是完整的 unpackContainer —— 导入一个加密文件要把整幅作品**解密两遍**
       *  （密码试错时更多）。7z-wasm 全量解一幅画不是小钱。合一后一次尝试 = 一次解密，
       *  且成功那次的明文直接给调用方复用。
       *  明文只在返回的 Blob 里（内存），库不缓存、不落盘。 */
      tryDecryptEncryptedBlob: async (blob: Blob, pw: string): Promise<Blob | null> => {
        if (!pw) return null;
        if (!(await looksEncryptedContainer(blob))) return null;   // 不是容器 → null（"明文原样返"是旧 unsealWith 的糊涂语义，已去掉：调用方自己先分流）
        try { return (await unpackContainer(blob, pw)).dataBlob; } catch { return null; }
      },

      /** 这块 blob 是不是**密文 peek**（getPeek 对加密件返回的那种）。纯类型判定，零计算。
       *  取代把 ENC_PEEK_MIME 这个魔法常量导出给 app —— app 要问的是语义，不是常量值。 */
      isEncryptedPeekBlob: (blob: Blob | null | undefined): boolean => !!blob && blob.type === ENC_PEEK_MIME,
    },
    // 无 _internal —— app 绝不碰 head/cloud/sub（库内测试直接 import 对应模块）。
  };
}

export type Store = ReturnType<typeof createStore>;
