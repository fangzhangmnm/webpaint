// store-absent —— sync-store 的**缺席变体**（v0.8.7 · B 骑士：store = 插件不是地基）。
//
// 胜利条件（user 蓝图 2026-08-02）：store 缺席时 app 仍可 boot、画画、导入导出 ora、编辑笔刷——
// 只是不落盘。本文件是 app-store 接缝的另一半：assembleStore() 按开关选真 store 或这里的 null-store。
// null-object 纪律：app 面对的接口**永远非 null**（样板 = app-prefs 的 face()）——没有持久层而已：
//   - collection → 内存 Map（session 内可编辑，reload 即失；getInitData 照 seed → 内置笔刷可用）
//   - files.watchFolder → 立即空帧（gallery 空态，不是 boot 卡死——「gallery 要列表所以必须有 store」是幻觉）
//   - file().open → null、save → {pushed:false}（editor-session 的 push-pending 语义自然成立）
//   - 加密 dormant（不注入即静默，与 JRP 同构）；auth isAuthConfigured=false → initAuth 整段跳过
// 开关：URL ?nostore 或 localStorage "weebpaint.nostore"="1"（体检/mhtml 排练用；正常用户永远走真 store）。
// ⚠ 本文件是接缝（与 app-store.ts 同级），只准 import store 的**类型**——零 store 运行时代码、零 IDB。

import type { Collection, CollectionEntry, ReconcileResult, Store } from "@internal/store";

export function detectStoreAbsent(): boolean {
  try {
    // node 子进程 boot smoke（test/nostore-boot-child.mjs）经 env 开缺席模式（浏览器不认 env）。
    const env = (globalThis as { process?: { env?: Record<string, string> } }).process?.env;
    if (env?.WEEBPAINT_NOSTORE === "1") return true;
    if (typeof location !== "undefined" && new URLSearchParams(location.search).has("nostore")) return true;
    if (typeof localStorage !== "undefined" && localStorage.getItem("weebpaint.nostore") === "1") return true;
  } catch { /* 环境无 location/localStorage（node）→ 视为在场（测试显式建 null store） */ }
  return false;
}

// ---- 内存 Collection（满足 store/collection.ts 的 Collection 契约；无持久层）----
type InitItem = { id: string; value: unknown };
export function createMemoryCollection(opts: { getInitData?: () => InitItem[] | Promise<InitItem[]> } = {}): Collection {
  const map = new Map<string, CollectionEntry>();
  const subsAll = new Set<(changedIds: string[]) => void>();
  const subsKey = new Map<string, Set<() => void>>();
  let inited = false;
  const fire = (ids: string[]) => {
    for (const cb of subsAll) cb(ids);
    for (const id of ids) for (const cb of subsKey.get(id) ?? []) cb();
  };
  const col: Collection = {
    async init() {
      if (inited) return;
      inited = true;
      if (opts.getInitData) {
        try {
          const items = await opts.getInitData();
          for (const it of items) map.set(it.id, { id: it.id, uat: 1, value: it.value } as CollectionEntry);
          if (items.length) fire(items.map((i) => i.id));
        } catch { /* seed 失败 = 空库（与真 collection 新库无网同形） */ }
      }
    },
    async reconcileWithRemote(): Promise<ReconcileResult> { return { status: "offline" }; },
    setItem(id, value) {
      if (value === undefined) throw new Error("Collection.setItem: value must not be undefined");
      map.set(id, { id, uat: (map.get(id)?.uat ?? 0) + 1, value } as CollectionEntry);
      fire([id]);
    },
    deleteItem(id) { map.set(id, { id, uat: (map.get(id)?.uat ?? 0) + 1, value: null } as CollectionEntry); fire([id]); },
    getItem<V = unknown>(id: string, def?: V | (() => V)): V | undefined {
      const e = map.get(id);
      if (!e || e.value === null || e.value === undefined) return typeof def === "function" ? (def as () => V)() : def;
      return e.value as V;
    },
    getEntry(id) { const e = map.get(id); return e && e.value != null ? e : undefined; },
    entries() { return [...map.values()].filter((e) => e.value != null); },
    keys() { return [...map.values()].filter((e) => e.value != null).map((e) => e.id); },
    onChange(a: unknown, b?: unknown): () => void {
      if (typeof a === "string") {
        const set = subsKey.get(a) ?? new Set();
        subsKey.set(a, set);
        set.add(b as () => void);
        return () => set.delete(b as () => void);
      }
      subsAll.add(a as (ids: string[]) => void);
      return () => subsAll.delete(a as (ids: string[]) => void);
    },
    async flushLocal() { return { ok: true }; },
    isDirty() { return false; },
  };
  return col;
}

// ---- null-store（Store 表面的缺席实现；成员集以 create-store.ts 返回块为准，drift 由 boot smoke 点名）----
export function createNullStore(): Store {
  const nullFile = (_name: string, _opts: { isZip: boolean; mode: "new" | "existing" }) => ({
    async open() { return null; },
    async save(_bytes: Blob, _o?: unknown) { return { pushed: false, reason: "store-absent" }; },
    async getPeek() { return null; },
    async decryptPeek() { return null; },
    async getEncryptedBlob() { return null; },
    async pullIfClean() { return { status: "offline" }; },
    async tryMove(_to: string) { return { ok: false as const, reason: "offline" }; },
    async delete() { return { status: "noop" }; },
    async reupload() { return { status: "no-local" }; },
    isKeptOffline() { return false; },
    async keepOffline() { /* no-op */ },
    async offload() { return { ok: false }; },
    async isEncrypted() { return false; },
    async encrypt() { return { ok: false, reason: "store-absent" }; },
    async decrypt() { return { ok: false, reason: "store-absent" }; },
    async verifyPassword() { return false; },
  });
  const collections = new Map<string, Collection>();
  const s = {
    file: nullFile,
    collection(name: string, opts: { getInitData?: () => InitItem[] | Promise<InitItem[]> } = {}) {
      let c = collections.get(name);
      if (!c) { c = createMemoryCollection(opts); collections.set(name, c); }
      return c;
    },
    files: {
      async nameOccupied(_n: string) { return false; },
      watchFolder(folder: string, cb: (snap: { path: string; items: never[]; folders: string[] }) => void) {
        queueMicrotask(() => cb({ path: folder, items: [], folders: [] }));   // 立即空帧：gallery 空态而非挂起
        return () => {};
      },
      async usage() { return { bytes: 0, count: 0 }; },
      async ensureFolder(_p: string) { /* no-op */ },
      async newFolder(_p: string) { /* no-op */ },
      async deleteFolder(_p: string) { /* no-op */ },
      async drainOfflineQueue() { /* no-op */ },
      async listTrash() { return []; },
      async listBackup() { return []; },
      async restoreTrash(_n: string) { return { status: "noop" }; },
      async purgeTrash(_n: string) { return { status: "noop" }; },
      async emptyTrash() { return { status: "noop" }; },
      async emptyBackup() { return { status: "noop" }; },
      async reconcileAll() { return { status: "offline" }; },
    },
    encryption: {
      async isEncryptedBlob(_b: Blob | Uint8Array) { return false; },
      async tryDecryptEncryptedBlob(_b: Blob, _pw: string) { return null; },
      isEncryptedPeekBlob(_b: Blob | null | undefined) { return false; },
    },
  };
  // 结构镜像 cast（B 骑士的已知代价）：完备性不是编译期保证——由 test/store-absent.test.mjs
  // 对照消费面逐成员点名；真 store 长新面时 smoke 会红。物理删除仍编译的「极端目标」不在本版。
  return s as unknown as Store;
}

// ---- dormant auth（isAuthConfigured=false → app.ts 整段跳过 initAuth；signIn 走 reportError 由调用方处理）----
export function createDormantAuth() {
  return {
    isAuthConfigured: () => false,
    initAuth: async () => {},
    signIn: async () => { throw new Error("store-absent mode: no cloud sign-in"); },
    signOut: async () => {},
    isSignedIn: () => false,
    getActiveAccount: () => null,
    retrySilentSignIn: async () => false,
    getToken: async () => null,
    onAuthChanged: (_cb: unknown) => () => {},
    getAuthState: () => ({ signedIn: false }),
  };
}
