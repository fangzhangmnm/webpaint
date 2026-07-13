// ⚠ 使用前必读 README.md。这是 store 内部模块,**不要从 app 直接 import**——app 只走 createStore()。
//
// 通用 IndexedDB 字节存(store 自己的本地持久层)。**内容无关**:存任意 binary blob + 可选 peek(不透明 sidecar),按 name 键。
// 取代旧 local-adapter 反向依赖的 WebPaint storage.ts/session.ts —— store 不懂内容格式(ora/glb/pdf/txt 一律不透明)。
// 浏览器专用(IndexedDB),node 测不到 → 写到一眼能看对,真机验。

export interface CacheRecord { blob: Blob; peek: Blob | null; updatedAt: number; }

const STORE = "blobs";

// ⚠ IDB 库名**必须 per-app 命名空间**（createStore 传 appId 派生 dbName）。IndexedDB 按 origin 隔离、
//   不按 path → 同 origin 的兄弟 PWA（如 GitHub Pages 的 /webpaint/ 与 /jrp/）若共用一个写死的库名，
//   会读写同一个库：别人的文件漏进来、schema 戳互踩、缓存互毁。所以库名不再是模块常量，由 app 命名空间决定。
export type IdbCache = ReturnType<typeof createIdbCache>;

/** 建一个绑定到具体 IDB 库名的字节缓存(store 内部)。dbName 必须已带 app 命名空间(见上)。 */
export function createIdbCache(dbName: string) {
  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(dbName, 1);
      r.onupgradeneeded = (): void => { r.result.createObjectStore(STORE); };
      r.onsuccess = (): void => resolve(r.result);
      r.onerror = (): void => reject(r.error);
    });
  }

  function reqTx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDb().then((db) => new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      req.onsuccess = (): void => resolve(req.result);
      req.onerror = (): void => reject(req.error);
    }));
  }

  return {
    get(name: string): Promise<CacheRecord | undefined> { return reqTx("readonly", (s) => s.get(name) as IDBRequest<CacheRecord | undefined>); },
    put(name: string, rec: CacheRecord): Promise<void> { return reqTx("readwrite", (s) => s.put(rec, name)).then(() => undefined); },
    del(name: string): Promise<void> { return reqTx("readwrite", (s) => s.delete(name)).then(() => undefined); },
    keys(): Promise<string[]> {
      return reqTx<IDBValidKey[]>("readonly", (s) => s.getAllKeys())
        .then((ks) => ks.filter((k): k is string => typeof k === "string"));
    },
    /** 原子改名(同一事务 get→put 新→del 旧):trash/restore/backup 用。源不存在则 noop。 */
    rename(from: string, to: string): Promise<void> {
      return openDb().then((db) => new Promise<void>((resolve, reject) => {
        const t = db.transaction(STORE, "readwrite");
        const s = t.objectStore(STORE);
        const g = s.get(from);
        g.onsuccess = (): void => { const v = g.result as CacheRecord | undefined; if (v !== undefined) { s.put(v, to); s.delete(from); } };
        t.oncomplete = (): void => resolve();
        t.onerror = (): void => reject(t.error);
      }));
    },
  };
}
