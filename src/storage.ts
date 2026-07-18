// app 自己的 IndexedDB（库名 `webpaint`）。**注意和 store 的库分开**：
//   作品字节在 store 的 `webpaint.defaultStore` 库（分区 files/trash/backup/collections）；
//   这里只放 app 专属、store 管不着的东西。
//
// 现存 object store：
//   · gallery-thumbs —— 图库缩略图缓存（加密件存**密文** peek，明文永不落盘）
//   （sessions —— 已死，v415 删掉全部读写；object store 在 v4 upgrade 里 deleteObjectStore）

const DB_NAME = "webpaint";
const DB_VERSION = 3;             // v3：加 gallery-thumbs store（bump 让已存在的库触发 onupgradeneeded 补建；additive、无迁移）
const STORE_SESSIONS = "sessions";
const STORE_THUMBS = "gallery-thumbs";   // 图库缩略图缓存专用 store，key = store 文件身份 X.ora（cloud-thumb-cache.ts）

let _dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = (ev.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) db.createObjectStore(STORE_SESSIONS);
      if (!db.objectStoreNames.contains(STORE_THUMBS)) db.createObjectStore(STORE_THUMBS);
      // 旧的 docs/layers stores 不主动删（如果存在），让 DevTools 翻历史；
      // 新代码不读不写它们。
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

// sessions object store 的整套读写（getSession / putSession / deleteSession / listSessionIds /
//   renameSessionKey + SessionPkg）已于 v415 删除。
//   它是 store cutover 之前的本地 autosave 层。cutover 后写入侧（putSession）零调用者，
//   于是这个 store **只出不进、恒空**，而读侧 session.listSessions 还在读它 → 四个消费方静默失效
//   （详见 session.ts 里那段说明）。落盘真相现在唯一走 store.file + editor-session。
//   object store 本身在 DB_VERSION v4 的 upgrade 里删（本轮末尾统一 bump，见 openDB）。

// meta store（getMeta/setMeta + STORE_META object store）已于 2026-07 删除：笔架本地持久化迁到
//   store.collection("brush-rack")；设置/状态早已走 collection（app-prefs.ts / app-state.ts）。别再加回。

// gallery 缩略图缓存：webpaint DB 的 gallery-thumbs store，key = store 文件身份 X.ora。value 见 cloud-thumb-cache。
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
