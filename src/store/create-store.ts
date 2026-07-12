// ⚠ 这是库的唯一入口。接库必读同目录 README.md + CONTEXT.md。
//
// createStore —— 薄组合根：provider → 库内造 cloud/local/kv/脊椎 → 装配 10 个深模块 →
//   暴露 README.md 的面（file / collection / localSettings / syncedSettings / list）。
//   红线全在各深模块内 enforce；这里只接线 + 把 ui bundle 映射到各 flow 的回调。
import { toU8, createSubstrate } from "./substrate.ts";
import type { Bytes } from "./substrate.ts";
import { createLocalHead } from "./local-head.ts";
import { createSeal } from "./seal.ts";
import { looksEncryptedContainer, packContainer, unpackContainer, configureCryptoCodec, scanEncPeekFromEnd, decryptPeek, PEEK_TAIL_WINDOW, ENC_PEEK_MIME, type CryptoCodec } from "./crypto-container.ts";
import { createSafeResolve, type ResolveChoice } from "./safe-resolve.ts";
import { createPush } from "./push.ts";
import { createFreshness } from "./freshness.ts";
import { createDelete } from "./delete.ts";
import { createIdentity } from "./identity.ts";
import { createTrash } from "./trash.ts";
import { createOffload } from "./offload.ts";
import { createReconcile } from "./reconcile.ts";
import { createCollection, type Collection } from "./collection.ts";
import { createListing, type ListContext, type FolderSnapshot } from "./listing.ts";
import { createUploadReplay, type UploadReplayPolicy } from "./upload-queue.ts";
import { createLocalSettings, createSyncedSettings, type LocalSettings, type SyncedSettings, type SettingItem } from "./settings.ts";
import type { CloudProvider, CloudSync, Kv, LocalCache } from "./types.ts";
import { createCloudSync } from "./cloud-sync.ts";
import { createLocalCache } from "./local-cache.ts";
import { runStoreMigrations } from "./migration.ts";

// ── ui bundle（Model B，README.md §7）：store 在决策点回调进来 + await ──
export interface StoreUI {
  // **全部必填，禁 placeholder/noop**（offlineEscape 例外：缺它优雅退回 isOnline 守卫，非隐藏失败）。
  busy: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  resolveConflict: (ctx: { name: string; local: Blob | null; cloud: Blob | null }) => Promise<ResolveChoice>;  // 冲突必 surface：consumer 必须给真 sheet，绝不静默 cancel
  reportError: (err: unknown) => void;                                                                          // 错误必 surface：绝不吞 console
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
  syncedSettingsFileName?: string;
  // ── 加密（对齐 WebPaint，见 docs/11；逻辑在库、重型 7z/zip codec 由 app 注入）──
  //   不注入 crypto → 加密 dormant（packContainer 抛「加密未配置」）；JRP 不加密就不注入，省 1.6MB。
  crypto?: CryptoCodec;                            // app 注入的 zip/7z codec（WebPaint 用 sevenzip.ts+zip.ts 包成）
  crypt?: {
    ext?: string;                                  // 真扩展名 → meta.bin（"ora"/"txt"…），还原真名
    makePeek?: (plain: Blob) => Promise<Uint8Array | null>;   // 明文→不透明 peek 字节（app 域；store 不看内容）
    getPassword?: (name: string) => string | null; // 同步、非交互、只读内存（唯一密码源）；app 持密码 + 解锁循环在 busy 外
  };
  encryptionSaltFileName?: string;   // ⚠ 未采用：README §5 的库统一密钥/salt 超集本版不实现（见 docs/11，加密走 crypt.getPassword）
  // ── 内部/测试 seam（prod 默认 idb + localStorage）──
  kv?: Kv;
  local?: LocalCache;
  getPassword?: (name: string) => string | null;   // 旧顶层密码源（向后兼容；优先用 crypt.getPassword）
  // 采纳云端字节前的有效性闸（N2：clean 快进/pull 覆盖本地前调）——**所有 consumer 必传，禁 placeholder/noop**。
  //   store 格式盲、自己验不了内容 → 逻辑 app 给（验是不是真 PDF/.ora/zip）。否则损坏/captive-portal HTML 拿着
  //   合法 etag 能覆盖唯一好的本地副本 = 丢内容（论文/画作都怕；只读消费者不上传不伤云，但机场网毁缓存照样难看）。
  //   **库对加密透明**：验的是**解密后的明文**（你看真 PDF/.ora，不是密文容器）。
  validateAdopt: (plain: Blob) => boolean | Promise<boolean>;
  isOnline?: () => boolean;                          // offload 离线守卫（默认 navigator.onLine）
  signedIn?: () => boolean;                          // **连接态由 store 自持**（网盘模型：app 不再每次列举传 ctx）。ctor 注入一次；不给 → 恒 true（退回 provider 失败即降级）。watchFolder / 云列举据此决定「云轴可不可解析」。
  keepOnOpen?: boolean;                              // 消费模式：true=开即自动留本地(读者/编辑器)；false=过路/流式(开整份拉云不落本地；range 按需取片是 ⚠TODO 优化)
  offlineUploadReplay?: UploadReplayPolicy;           // ADR-0018：离线「新上传」回线补推策略 auto|ask|manual（默认 manual；WebPaint=manual、JRP=ask）
  // ── 数据迁移（ADR-0019，createStore 内部自跑、隐形）──
  skipMigration?: boolean;                            // 测试/无 localStorage 环境跳过（prod 不传）
  migrationCollections?: ReadonlySet<string>;         // dirty 拆轨用的已知 collection 名（WebPaint=∅：webpaint.dirty: 全是工作文件）
}

// ── 文件对象（README.md §2）。isZip 在编译期分出两种：RawFile 无 getPeek/setPeek ──
export interface RawFile {
  //  save(bytes)               = 本地落盘 + best-effort 推云（默认 tryPush:true）
  //  save(bytes,{tryPush:false})= 只落本地不推（autosave/频繁保存；opaque Work 的 push 必须 consent-gated，ADR-0016/0018）
  //  tryPush 是 **best-effort**：离线/冲突/失败 → 文件留 dirty、下次补推（不保证同步到云）。hint 透传缩略图（store content-blind）。
  save(bytes: Bytes | Blob, opts?: { tryPush?: boolean; hint?: unknown }): Promise<void>;
  open(): Promise<Blob | null>;
  rename(newName: string): Promise<void>;
  delete(): Promise<void>;
  // 注：无 isDirty —— 「有没未推的改动」是 **sync 状态**，经 store.listAllItems 的 syncState 读（unpushed/conflict）。
  //   「是否 dirty 该推」= app 编辑逻辑（编辑器生命周期模块）的判断，不是库的事。
  // ── 离线副本（keepOffline/offload；无 LRU、无 pin flag：有本地副本 = kept offline）──
  isKeptOffline(): Promise<boolean>;            // 本地有副本？（= 已留作离线）
  keepOffline(): Promise<void>;                 // 留一份离线副本（未缓存则 acquire）。注：open 已含下载子过程，故名 keepOffline 非 download
  offload(): Promise<void>;                     // 合法(clean∧在线∧曾synced∧云端有完整)→hardDelete；非法(唯一副本/不可重取)→抛 OffloadIllegalError（banner）
  // ── 加密（at-rest 透明；对齐 WebPaint，见 docs/11。JRP 不注入 codec → dormant）──
  isEncrypted(): Promise<boolean>;                                       // 本地字节是否加密容器
  encrypt(opts?: { isOnline?: () => boolean }): Promise<{ status: string }>;   // 明文→密文（先本地后云 If-Match；离线 defer；错密码前置出局）
  decrypt(opts?: { isOnline?: () => boolean }): Promise<{ status: string }>;   // 密文→明文（同上红线）
  verifyPassword(pw: string): Promise<boolean>;                         // app 解锁循环（busy 外）便宜验：解 peek，不碰 7z
}
export interface ZipFile extends RawFile {
  // peek = 加密容器最外层可 byte-range 单独取的 **不透明尾块字节**（≤64KiB，独立 AES-GCM）。
  //   库只加密/解密/尾取，**绝不假设它是图**——app 拿 Blob 自己 cast 成缩略图（内容知识全在 app）。
  getPeek(): Promise<Blob | null>;
  setPeek(peekBytes: Blob): Promise<void>;   // ⚠未采用：peek 经 crypt.makePeek 自动派生
}

function localStorageKv(): Kv {
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (!ls) throw new Error("createStore: 无 localStorage，请注入 kv");
  return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v), remove: (k) => ls.removeItem(k) };
}

export function createStore(config: StoreConfig) {
  const { provider, ui, syncedSettingsFileName, kv = localStorageKv(), validateAdopt, keepOnOpen = true } = config;
  const local = config.local ?? createLocalCache();   // prod=idb；测试注入 mock-local
  const isOnline = config.isOnline ?? ((): boolean => (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine !== false);
  // 加密密码源（对齐 WebPaint 非交互 getPassword）：优先 crypt.getPassword，兼容旧顶层；不给 → 恒 null（透传明文）。
  const getPassword = config.crypt?.getPassword ?? config.getPassword ?? ((): string | null => null);
  if (config.crypto) configureCryptoCodec(config.crypto);   // app 注入 zip/7z codec 才启用加密；JRP 不注入 → dormant

  // ── 脊椎 + 低层 ──
  const cloud: CloudSync = createCloudSync({ provider, kv, fileName: (n: string) => n });
  const sub = createSubstrate();
  const head = createLocalHead({ kv, getCloudEtag: (n: string) => cloud.getETag(n) });
  // 数据迁移（ADR-0019）：**createStore 内部自跑、隐形**——app 看不见 migration（数据搬迁是同步细节）。
  //   ops 首用前 await migrationReady（open/save/list）。测试/无 localStorage 环境跳过。
  const migrationReady: Promise<void> =
    config.skipMigration || !(globalThis as { localStorage?: unknown }).localStorage
      ? Promise.resolve()
      : runStoreMigrations(config.migrationCollections ?? new Set<string>());
  const offloadMod = createOffload({ cloud, local, head, isOnline, serialize: sub.serialize });   // serialize：offload 的 hardDelete ⟂ save 的 local 写互斥（红线：驱逐不吃未推字节）
  const reconcileMod = createReconcile({ cloud, local, head, isOnline });

  // ── folder 本地登记（离线建空夹）：pending = 建了但还没确认上云的空文件夹。──────────────
  //   离线也能建空夹（用户要求）：先 kv 登记 → 并进 listAllItems.folders（离线可见/持久）→ 回线 drainFolders 补建。
  const FOLDERS_PENDING_KEY = "folders.pending";
  const readPending = (): string[] => { try { const v = JSON.parse(kv.get(FOLDERS_PENDING_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
  const writePending = (a: string[]): void => kv.set(FOLDERS_PENDING_KEY, JSON.stringify([...new Set(a)]));
  const addPendingFolder = (p: string): void => writePending([...readPending(), p]);
  const clearPendingFolder = (p: string): void => writePending(readPending().filter((x) => x !== p));
  // ensureFolder：本地先登记（离线可见/持久），在线则补建云端并清 pending；离线/失败留 pending 等 drainFolders。
  async function ensureFolderLocalFirst(path: string): Promise<void> {
    addPendingFolder(path);
    if (isOnline()) { try { await cloud.ensureFolder(path); clearPendingFolder(path); } catch { /* 留 pending，回线补建 */ } }
  }
  async function drainFolders(): Promise<void> {
    if (!isOnline()) return;
    for (const p of readPending()) { try { await cloud.ensureFolder(p); clearPendingFolder(p); } catch { /* 下次再补 */ } }
  }

  // ── 统一列举（README §2）：整个虚拟 FS 一次列举 = local ∪ cloud，每项带 syncState。mergeLocalCloud 收进库内。──
  const listing = createListing({ cloud, local, head, pendingFolders: readPending });

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
    await reconcileMod.reconcileFolder(folder).catch((e) => ui.reportError(e));   // 「看到夹才 reconcile」：惰性、非静默、仅本夹
    try { emitFolder(folder, await listing.listFolder(folder, ctxNow())); } catch (e) { ui.reportError(e); }
  }
  // 写路径变动 → 通知受影响夹（name 的父夹）的 watcher 即时重画本地帧。
  function notifyFolderOf(name: string): void {
    void pushLocalFrame(name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "");
  }
  function watchFolder(folder: string, cb: (s: FolderSnapshot) => void): () => void {
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
  const identity = createIdentity({ cloud, local, head, doPush: pushMod.doPush, serialize: sub.serialize, serialize2: sub.serialize2, seal, busy: ui.busy });
  const trashMod = createTrash({ cloud, local, head, busy: ui.busy });

  // ── 单飞守卫（port 自 WebPaint store.ts，2026-06-21 起红线）：用户态写流同一时刻只一个，
  //   并发的第二个**直接拒**（throw STORE_BUSY），调用方 catch→报状态。与 ui.busy 正交、更硬
  //   （busy 只是 UI 防误点、无 UI 时失效；这道库内自带，无头复用也挡得住）。同名字节竞争仍由
  //   substrate.serialize2 兜底，这道在其上加「全局同一时刻只一个用户态写」的更强语义（user 明确要）。
  //   安全前提：被守的流互不内部调用——saveAs/rename 内部走 doPush（非被守流）；del/restore/purge/
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
  const renameSF = singleFlight("重命名", (n: string, nn: string) => identity.rename(n, nn));

  // ── ui 映射：冲突回调把 local/cloud 字节取来喂 ui.resolveConflict（必填，绝不静默 cancel）──
  const onConflict = async ({ name }: { name: string }): Promise<ResolveChoice> => {
    const [localBlob, cloudPull] = await Promise.all([local.get(name), cloud.pull(name).catch(() => null)]);
    return ui.resolveConflict({ name, local: localBlob, cloud: cloudPull?.blob ?? null });
  };

  // ── 加密：读侧原语 + at-rest transform（照搬 WebPaint store.ts，见 docs/11；JRP 不注入 codec → dormant）──
  //   非交互：无/错密码 → null / status:"locked"（绝不弹窗）。解锁循环是 app 在 busy 外的事（seal.withPassword 守）。
  async function encTailBytes(name: string, n: number, tryCloud: boolean): Promise<Blob | null> {
    const blob = await local.get(name);                          // 本地有 → 尾切片（IDB Blob.slice 惰性）
    if (blob) { const b = blob instanceof Blob ? blob : new Blob([blob as BlobPart]); return b.slice(Math.max(0, b.size - n)); }
    if (tryCloud && cloud.pullTail) { const t = await cloud.pullTail(name, n); return t ? new Blob([t.bytes as BlobPart]) : null; }  // 纯云端 peek：byte-range
    return null;
  }
  async function encReadPeek(name: string, tryCloud: boolean): Promise<Uint8Array | null> {
    const tail = await encTailBytes(name, PEEK_TAIL_WINDOW, tryCloud);
    if (!tail) return null;
    const parsed = scanEncPeekFromEnd(new Uint8Array(await tail.arrayBuffer()));
    if (!parsed) return null;
    return await seal.withPassword(name, (pw) => decryptPeek(parsed, pw));   // 非交互内存密码；锁定 → null
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
      head.onPushed(name, item?.eTag ?? null, false);            // 落地：base←新 etag、清 dirty/parent
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
  function makeRaw(name: string): RawFile {
    const readLocal = async (): Promise<Blob | null> => {        // 读本地缓存字节 → 解壳出明文
      const blob = await local.get(name);
      if (!blob) return null;
      const asBlob = blob instanceof Blob ? blob : new Blob([blob as BlobPart]);
      return await seal.unsealForRead(name, asBlob);
    };
    return {
      async save(bytes, opts) {
        await migrationReady;
        head.recordEdit(name);                                   // 同步标脏：offload 的 isDirty 守卫立即可见（防驱逐吃未推字节）
        const plain = await toU8(bytes);
        const sealed = await seal.sealForWrite(name, plain);
        await sub.serialize(name, () => local.save(name, sealed, opts?.hint));   // local 写同名串行链：与 offload.hardDelete 互斥（C2 红线）；hint 透传缩略图
        notifyFolderOf(name);                                    // 网盘模型：本夹 watcher 即时反映新增/变脏（无云往返；gallery 没开=cheap no-op）
        if (opts?.tryPush === false) return;                     // 只落本地（autosave/consent-safe，ADR-0016/0018：opaque Work 的 push 必 consent-gated）
        try { await pushMod.push(name, { encode: () => plain, onConflict }); }
        catch (e) { ui.reportError(e); }
        // ADR-0018：离线「新上传」补推——push 没成(仍 dirty) ∧ 从没 synced(seenBase null) → 入队，回线 drainUploadQueue 补推。
        if (head.isDirty(name) && head.seenBase(name) == null) uploadReplay.enqueue(name);
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
        if (keepOnOpen) {                                          // 本地没有、持有模式 → 拉云落本地（无可显示，必须等）
          await identity.acquire(name, { localName: name });
          return readLocal();
        }
        // 本地没有、过路模式（keepOnOpen:false，流式消费）→ 整份拉云、**不落本地**，直接返字节
        const pulled = await cloud.pull(name).catch((e) => { ui.reportError(e); return null; });
        return pulled ? await seal.unsealForRead(name, pulled.blob) : null;   // range/streaming（按需取片）是 ⚠TODO 优化
      },
      async rename(newName) { await renameSF(name, newName); notifyFolderOf(name); notifyFolderOf(newName); },   // 旧夹移出 + 新夹移入，两边都重画
      async delete() { await delSF(name); notifyFolderOf(name); },
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

  function file(name: string, opts: { isZip: true }): ZipFile;
  function file(name: string, opts: { isZip: false }): RawFile;
  function file(name: string, opts: { isZip: boolean }): RawFile | ZipFile;
  function file(name: string, opts: { isZip: boolean }): RawFile | ZipFile {
    const raw = makeRaw(name);
    if (!opts.isZip) return raw;
    // getPeek：读容器尾部加密 peek（本地切片或云端 byte-range）→ **不透明明文字节**包 Blob；锁定/无 peek → null。
    //   peek 经 seal 时 crypt.makePeek 自动派生（无显式 setPeek）；库不假设它是图，app 拿 Blob 自己 cast 缩略图。
    const getPeek = async (): Promise<Blob | null> => { const b = await encReadPeek(name, true); return b ? new Blob([b as BlobPart]) : null; };
    const setPeek = async (_b: Blob): Promise<void> => { throw new Error("ZipFile.setPeek ⚠未采用：peek 经 crypt.makePeek 自动派生"); };
    return Object.assign(raw, { setPeek, getPeek }) as ZipFile;
  }

  // ── collection / settings ──
  function collection<T extends object>(name: string, opts: { manual?: boolean } = {}): Collection<T> {
    return createCollection<T>({ cloud, name, local, manual: opts.manual });   // local=IDB 透明缓存（离线可读/强杀存活）
  }
  const localSettings: LocalSettings = createLocalSettings(kv);
  const syncedSettings: SyncedSettings | undefined = syncedSettingsFileName
    ? createSyncedSettings(createCollection<SettingItem>({ cloud, name: syncedSettingsFileName, local }))
    : undefined;

  return {
    file,
    collection,
    localSettings,
    syncedSettings,
    // ── watchFolder（网盘模型，2026-07-11）：订阅**一个**文件夹 → 立即本地帧、云端到了同一 cb 再闪。app 只知「这一夹更新了」。
    //   替代「全树列举 + 客户端切一夹」的浪费（JRP 开夹慢的根因）。连接态 store 自持（config.signedIn/isOnline），**无 ctx**。──
    watchFolder,
    // 一次性单夹列举（watchFolder 的非订阅兄弟）：定向存在性检查 / app 自己递归全库时用。纯读、无 reconcile 副作用。
    //   **本库不提供「一次列全库」的廉价接口**（那会 walk 整棵树、代价被隐藏）——真要全库，app 自己递归 listFolder，
    //   代价（N 次往返）由调用方显式承担、看得见（用户拍板：全库让 app 自己递归，效率相当但成本可见）。
    listFolder: async (path: string): Promise<FolderSnapshot> => { await migrationReady; return listing.listFolder(path, ctxNow()); },
    // localKeys / listAllItems / listAll 均不暴露：日常浏览 watchFolder（单夹）；定向查 listFolder；全库 app 自递归。
    //   （cloud.listAll 仅库内 reconcile 的 user-instruction「校验完整性」用；identity=path、local/cloud 是 Item 的属性 syncState 不是两来源。）
    // 文件夹操作（gallery folder-tree）：空文件夹增删。**离线也能建**（本地登记 + 回线 drainFolders 补建）。
    ensureFolder: (path: string) => ensureFolderLocalFirst(path),
    newFolder: singleFlight("新建文件夹", (path: string) => ui.busy("新建文件夹…", async () => { await ensureFolderLocalFirst(path); notifyFolderOf(path); })),   // 子夹出现在父夹 → 重画父夹
    deleteFolder: singleFlight("删除文件夹", (path: string) => ui.busy("删除文件夹…", async () => {
      const wasPending = readPending().includes(path);
      clearPendingFolder(path);                                   // 离线建的（从没上云）→ 清登记即删
      if (!isOnline()) { if (wasPending) { notifyFolderOf(path); return true; } throw new Error("离线：无法删除已上云的文件夹"); }
      const r = await cloud.removeFolder(path);
      notifyFolderOf(path);                                       // 子夹从父夹消失 → 重画父夹
      return r;
    })),
    drainFolders,   // 回线补建离线创建的空夹（app 在 online / listGallery 时调，对齐 drainDeleteQueue）
    // 后台 / 事件流（app 在 focus/visibility/online 调）+ 离线删重放 + cloud-gone 收敛（安全子集 #43）。
    refresh: (name: string, opts?: Parameters<typeof fresh.refresh>[1]) => fresh.refresh(name, opts),
    drainDeleteQueue: () => del.drainDeleteQueue(),
    drainUploadQueue: () => uploadReplay.drain(),   // ADR-0018：回线/成功连接补推离线新上传（app 在 online/boot 调；ask 模式内部先问）
    // **全库** cloud-gone 收敛（clean 孤儿→local-only，不删不 trash）。**仅用户显式指令**（将来隐藏的「校验完整性」入口），
    //   **绝不自动/轮询/每次列举调**——全树 listAll 是重活。日常开夹的惰性收敛已在 watchFolder 内走 reconcileFolder（看到夹才收敛）。
    reconcile: (opts?: { activeName?: string }) => reconcileMod.reconcile(opts),

    listTrash: () => cloud.listTrash(),   // 回收站列表（gallery trash 视图）
    listBackup: () => cloud.listBackup(),   // 备份箱列表（恢复箱视图；webxiaoheiwu 用）
    // localKeys 已废（见上）——离线可读性经 store.listAllItems(ctx) 的 item.syncState + isCached() 判定，不再单列本地半截。
    restore: singleFlight("恢复", trashMod.restore),
    purge: singleFlight("彻底删除", trashMod.purge),
    emptyTrash: singleFlight("清空回收站", trashMod.emptyTrash),
    saveAs: singleFlight("另存为", identity.saveAs),
    // ── 加密导入辅助（文件还没进 store、无 name 可查时；对齐 WebPaint）──
    looksEncrypted: (blob: Blob | Uint8Array) => looksEncryptedContainer(blob),   // 是否加密容器（导入分流）
    verifyContainer: async (blob: Blob, pw: string): Promise<boolean> => { if (!pw) return false; try { await unpackContainer(blob, pw); return true; } catch { return false; } },
    unsealWith: async (blob: Blob, pw: string): Promise<Blob | null> => {   // 显式密码解一段字节（导入：不走 getPassword、不污染全局）
      if (!(await looksEncryptedContainer(blob))) return blob;
      try { return (await unpackContainer(blob, pw)).dataBlob; } catch { return null; }
    },
    // 无 _internal —— app 绝不碰 head/cloud/sub（库内测试直接 import 对应模块）。
  };
}

export type Store = ReturnType<typeof createStore>;
