// IndexedDB stub。一期手感期没启用持久化（proposal："甚至没保存的情况下"）。
// 这里先把 store schema 占好位，避免后期换 schema 时还要 bump version。
//
// 计划的 stores（一期后半段会启用）：
//   docs:    { id, name, width, height, createdAt, modifiedAt, ... }
//   layers:  { id, docId, index, name, visible, opacity, mode, blob }    blob = PNG bytes
//   meta:    单条配置（theme / 上次打开的 doc / picker state / 视口 / ...）

const DB_NAME = "webpaint";
const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("docs")) {
        db.createObjectStore("docs", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("layers")) {
        const s = db.createObjectStore("layers", { keyPath: "id", autoIncrement: true });
        s.createIndex("docId", "docId", { unique: false });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(stores, mode = "readonly") {
  return openDb().then((db) => db.transaction(stores, mode));
}

export async function getMeta(key) {
  const t = await tx("meta", "readonly");
  return new Promise((resolve, reject) => {
    const req = t.objectStore("meta").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta(key, value) {
  const t = await tx("meta", "readwrite");
  return new Promise((resolve, reject) => {
    const req = t.objectStore("meta").put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}
