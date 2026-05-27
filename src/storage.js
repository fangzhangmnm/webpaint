// IndexedDB 持久化 —— **一个 session = 一个 atomic 包**。
//
// 抄 AtlasMaker v0.7 的设计（docs/persistence-and-encryption-shareback.md
// TL;DR 第 1 条）：**不要**拆 layer-blobs 多 store 多 tx。refresh 在中间
// 截断会丢半边。
//
// 一条记录 = { name, updatedAt, ora: Blob, thumb: Blob }
// 一次 put 一次 tx。要么全有要么全无。
//
// 代价：每次保存重序列化整个 .ora。所以保存频率必须低（Ctrl+S 主导 +
// 3-min 兜底 + visibility/pagehide 抢救）。不要走 debounce 路径。

const DB_NAME = "webpaint";
const DB_VERSION = 2;
const STORE_SESSIONS = "sessions";
const STORE_META = "meta";       // 保留给 settings / theme / etc.

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) db.createObjectStore(STORE_SESSIONS);
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      // 旧的 docs/layers stores 不主动删（如果存在），让 DevTools 翻历史；
      // 新代码不读不写它们。
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

/**
 * 取一个 session 包。返回 { name, updatedAt, ora: Blob, thumb: Blob? } 或 null。
 */
export async function getSession(id = "current") {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readonly");
    const req = tx.objectStore(STORE_SESSIONS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 原子写一个 session 包。pkg 整个作为一个 value 写入，IDB 保证 tx 内全有全无。
 */
export async function putSession(id, pkg) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readwrite");
    tx.objectStore(STORE_SESSIONS).put(pkg, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteSession(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readwrite");
    tx.objectStore(STORE_SESSIONS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listSessionIds() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readonly");
    const req = tx.objectStore(STORE_SESSIONS).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// meta：单条配置（settings 之类）。app.js 现在用 localStorage；这里留给将来用。
export async function getMeta(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, "readonly");
    const req = tx.objectStore(STORE_META).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, "readwrite");
    tx.objectStore(STORE_META).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
