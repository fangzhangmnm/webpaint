// app 自己的 IndexedDB（库名 `weebpaint`）。**注意和 store 的库分开**：
//   作品字节在 store 的 `weebpaint.defaultStore` 库（分区 files/trash/backup/collections）；
//   这里只放 app 专属、store 管不着的东西。
//
// 现存 object store（v5 终态）：
//   · gallery-thumbs —— 图库缩略图缓存（加密件存**密文** peek，明文永不落盘）
//   · image-thumbs   —— 云盘图片 picker 缩略图缓存（自压 jpeg 派生物；与 gallery-thumbs 分开存 = user 2026-08-20 拍板）
//   · checkpoints    —— 撤销更改（revert）的打开态快照，key `<X.ora>:<slot>`，加密件存密文容器
//   （sessions —— v415 删；meta —— 2026-07 已删。都别加回来。）

import type { CheckpointRecord } from "./checkpoint-policy.ts";

const DB_NAME = "weebpaint";
// 版本史：v4（2026-07-18）建 checkpoints + 删 sessions；v5（2026-08-20，cloud-image-picker spec §6）建 image-thumbs。
// ⚠ v0.9.31（QA ②）起**不再硬编码 DB 版本**：prod（/）和 dev（/dev/）同源共享这个库，
//   硬编码版本 = dev 升库后旧渠道 open(旧版本号) 直接 VersionError，缩略图/revert 整库打不开。
//   自适应打开：先无版本号 open（任何现有版本都成功）→ 缺 store 才 close 并按 当前版本+1 升级补建。
//   本文件从此对版本号不敏感；旧渠道仍硬编码的历史版本追不回来（那是旧 bundle 的代码），
//   但从本版起两渠道再也不会互相打断。
const STORE_SESSIONS = "sessions";        // 仅 upgrade 里用来 deleteObjectStore，别再读写
const STORE_THUMBS = "gallery-thumbs";    // 图库缩略图缓存专用 store，key = store 文件身份 X.ora（cloud-thumb-cache.ts）
const STORE_IMAGE_THUMBS = "image-thumbs"; // 云盘图片缩略图缓存，key = 全名 path 含扩展名（gallery/image-thumbs.ts）
const STORE_CHECKPOINTS = "checkpoints";  // revert 快照，key = checkpointKey(fullName, slot)
const REQUIRED_STORES = [STORE_THUMBS, STORE_IMAGE_THUMBS, STORE_CHECKPOINTS];

let _dbPromise: Promise<IDBDatabase> | null = null;

function _openRaw(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version == null ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = (ev) => {
      const db = (ev.target as IDBOpenDBRequest).result;
      for (const s of REQUIRED_STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      // sessions 死 store（v415 断供）：撞见就删。deleteObjectStore 只能在 upgrade 事务里调。
      if (db.objectStoreNames.contains(STORE_SESSIONS)) db.deleteObjectStore(STORE_SESSIONS);
      // 更旧的 ai-docs/layers stores 不主动删（如果存在），让 DevTools 翻历史；新代码不读不写它们。
    };
    // 升级被别的连接挡住（旧 bundle 的 tab 不听 versionchange、永不让路）→ 响亮 reject，
    //   别静默 pending 到天荒地老（长跑纪律：挂死→响亮红）。缩略图/revert 各自 catch，开画不受影响。
    req.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another WeebPaint tab (old bundle holding the DB) — close other WeebPaint tabs"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _openAdaptive(): Promise<IDBDatabase> {
  let db = await _openRaw();                                    // 无版本号：现有库什么版本都打得开
  if (!REQUIRED_STORES.every((s) => db.objectStoreNames.contains(s))) {
    const next = db.version + 1;                                // 缺 store（新装/新增 store 的版本）→ 最小步升级补建
    db.close();
    db = await _openRaw(next);
  }
  // 别的 tab 要升级时主动让路（旧代码不让路是 onblocked 挂死的根源，新代码别再当拦路者）；
  //   让路后清缓存，下次调用按新版本重开。
  db.onversionchange = () => { db.close(); if (_dbPromise) _dbPromise = null; };
  return db;
}

function openDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  // 失败（VersionError 并发竞升 / blocked 瞬态）重试一次；仍失败则**不缓存 rejected promise**——
  //   否则一次瞬时失败会让本 session 的缩略图/revert 永久死透，连恢复机会都没有。
  _dbPromise = _openAdaptive().catch(async (e1) => {
    try { return await _openAdaptive(); }
    catch { _dbPromise = null; throw e1; }
  });
  return _dbPromise;
}

// sessions object store 的整套读写（getSession / putSession / deleteSession / listSessionIds /
//   renameSessionKey + SessionPkg）已于 v415 删除。
//   它是 store cutover 之前的本地 autosave 层。cutover 后写入侧（putSession）零调用者，
//   于是这个 store **只出不进、恒空**，而读侧 session.listSessions 还在读它 → 四个消费方静默失效
//   （详见 session.ts 里那段说明）。落盘真相现在唯一走 store.file + editor-session。
//   object store 本身已在 v4 的 upgrade 里 deleteObjectStore（见 openDB）。

// meta store（getMeta/setMeta + STORE_META object store）已于 2026-07 删除：笔架本地持久化迁到
//   store.collection("brush-rack")；设置/状态早已走 collection（app-prefs.ts / app-state.ts）。别再加回。

// gallery 缩略图缓存：weebpaint DB 的 gallery-thumbs store，key = store 文件身份 X.ora。value 见 cloud-thumb-cache。
export async function getThumb(key: string): Promise<unknown> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_THUMBS, "readonly");
    const req = tx.objectStore(STORE_THUMBS).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function setThumb(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_THUMBS, "readwrite");
    tx.objectStore(STORE_THUMBS).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 删单条缩略图缓存（作废：bytes 变了）。
export async function deleteThumb(key: string): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_THUMBS, "readwrite");
    tx.objectStore(STORE_THUMBS).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 清空整个缩略图 store（返清掉的条数）。
export async function clearThumbs(): Promise<number> {
  const db = await openDB();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(STORE_THUMBS, "readwrite");
    const store = tx.objectStore(STORE_THUMBS);
    const countReq = store.count();
    let n = 0;
    countReq.onsuccess = () => { n = countReq.result; store.clear(); };
    tx.oncomplete = () => resolve(n);
    tx.onerror = () => reject(tx.error);
  });
}

// ── image-thumbs（云盘图片 picker 缩略图缓存，key = 全名 path）──────────────────────────────
// 形状同 gallery-thumbs 四件套；value 形态见 gallery/image-thumbs.ts。
export async function getImageThumb(key: string): Promise<unknown> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_IMAGE_THUMBS, "readonly").objectStore(STORE_IMAGE_THUMBS).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function setImageThumb(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGE_THUMBS, "readwrite");
    tx.objectStore(STORE_IMAGE_THUMBS).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function deleteImageThumb(key: string): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGE_THUMBS, "readwrite");
    tx.objectStore(STORE_IMAGE_THUMBS).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function clearImageThumbs(): Promise<number> {
  const db = await openDB();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGE_THUMBS, "readwrite");
    const store = tx.objectStore(STORE_IMAGE_THUMBS);
    const countReq = store.count();
    let n = 0;
    countReq.onsuccess = () => { n = countReq.result; store.clear(); };
    tx.oncomplete = () => resolve(n);
    tx.onerror = () => reject(tx.error);
  });
}

// ── checkpoints（撤销更改 / revert）────────────────────────────────────────────────────────
// 一条 = 一幅画在「本次打开那一刻」的 at-rest 字节快照。加密件存**密文容器**（明文永不落盘）。
// key/何时封存/加密处理的**策略**在纯模块 checkpoint-policy.ts（那边可 node 测）；这里只管落盘。
export async function getCheckpoint(key: string): Promise<CheckpointRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHECKPOINTS, "readonly");
    const req = tx.objectStore(STORE_CHECKPOINTS).get(key);
    req.onsuccess = () => resolve((req.result as CheckpointRecord) || null);
    req.onerror = () => reject(req.error);
  });
}
export async function putCheckpoint(key: string, rec: CheckpointRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHECKPOINTS, "readwrite");
    tx.objectStore(STORE_CHECKPOINTS).put(rec, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function deleteCheckpoint(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHECKPOINTS, "readwrite");
    tx.objectStore(STORE_CHECKPOINTS).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── 占用称重（storage-usage.ts 用；本文件只负责「这个库里有多少字节」，口径与展示归那边）────────
//
// 为什么要有：checkpoints 里每幅打开过的画存着**一份完整 .ora**，缩略图缓存也真占地方，
//   而它们全在这个 app 私有库里 —— store 的 usageBreakdown 看不到。用户问「本机被占了多少」，
//   少算这一半就是谎报（2026-08-21 存储驱逐调查）。
//
// ⚠ 是**估算**不是精确值：IndexedDB 不提供记录大小，只能遍历值把认得的字节加起来
//   （Blob.size / ArrayBuffer.byteLength 是准的；字符串按 UTF-16 2 字节/char 估；
//    结构开销、索引、压缩一律不计）。展示时必须说「约」，别当账本用。

/** 递归估算一个 IDB 值占多少字节。深度设限防自引用/病态结构把 UI 卡死。 */
function estimateBytes(v: unknown, depth = 0): number {
  if (v == null || depth > 6) return 0;
  if (v instanceof Blob) return v.size;                       // 引用属性，不载字节
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  const t = typeof v;
  if (t === "string") return (v as string).length * 2;        // UTF-16 粗估
  if (t === "number" || t === "boolean") return 8;
  if (Array.isArray(v)) { let n = 0; for (const x of v) n += estimateBytes(x, depth + 1); return n; }
  if (t === "object") { let n = 0; for (const k of Object.keys(v as object)) n += k.length * 2 + estimateBytes((v as Record<string, unknown>)[k], depth + 1); return n; }
  return 0;
}

/** 本 app 库（`weebpaint`）各 object store 的**估算**占用。单事务、逐 store 一遍 cursor。
 *  只返标量（字节 + 件数），不返任何 key —— 与 store 侧 usageBreakdown 同一纪律。 */
export async function appDbUsage(): Promise<Record<string, { bytes: number; count: number }>> {
  const db = await openDB();
  const out: Record<string, { bytes: number; count: number }> = {};
  for (const name of REQUIRED_STORES) {
    if (!db.objectStoreNames.contains(name)) { out[name] = { bytes: 0, count: 0 }; continue; }
    out[name] = await new Promise<{ bytes: number; count: number }>((resolve) => {
      let bytes = 0, count = 0;
      const tx = db.transaction(name, "readonly");
      const c = tx.objectStore(name).openCursor();
      c.onsuccess = () => { const cur = c.result; if (!cur) return; bytes += estimateBytes(cur.value); count++; cur.continue(); };
      tx.oncomplete = () => resolve({ bytes, count });
      tx.onabort = tx.onerror = () => resolve({ bytes, count });   // 单个 store 读不了不该让整份报告失败
    });
  }
  return out;
}
