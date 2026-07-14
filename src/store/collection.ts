// ⚠ 使用前必读 README.md。app 不直接 import 本文件——经 createStore 的 store.collection 拿。
//
// GENERIC — Collection store facade（README.md §3）。一份同步 JSON 装多个**原子** item。
// 自拥内存 envelope（不像 folder-store 让 app 注入 snapshot()/onResult）；item = **裸值 KV**：
//   信封 { id, uat, value } 由本模块强制——id 必填、uat 内部盖戳（app 既传不进也读不到）、
//   value = 任意 JSON（对象或裸值，opaque）。folder-merge 把 value 当普通 opaque payload 字段搬运，
//   per-item uat-LWW（CRDT-lite，零冲突静默 last-win，配置类可接受丢失——见 folder-merge §N11）。
//   同步复用 folder-flow（pull-merge-push，If-Match）。序列化 = JSON（#68：库内部 JSON，app 不传 encode/decode）。
//
// 读写 = **同步内存**（getItem/setItem 不 await）；两侧 value 浅拷贝隔离（app 拿到/传入的对象改动不与信封互相污染）。
//   但内存 env 在 init() 前为空（getItem 返 default，setItem 抛错）。onChange(cb) 整库 / onChange(id,cb) 绑单 key。
//   init()（编排锁库内，照 file.open）：先 await hydrateLocal（本地 IDB，快）→ 再**后台 fire-and-forget**
//   reconcile 云端（不 await）→ resolve。boot await init() 拿本地即够；云端后台对齐、onChange 通知。
//   refresh()：事件驱动（focus/visible/online）重拉+resolve，per-key LWW（同 file.refresh）。
// local-only 变体（cloudless）：只走 IDB 本地缓存、永不碰云（flow.sync）。给设备本地设置用。
import { createFolderFlow } from "./folder-flow.ts";
import { emptyFolder, parseFolderBlob, mergeFolders, normalizeFolder } from "./folder-merge.ts";
import type { FolderEnvelope, FolderItem } from "./folder-merge.ts";
import type { CloudSync, LocalCache } from "./types.ts";

// collection 在本地缓存（IDB `blobs`）里的键名 = collections 分区（`collections/<name>`）。
export function collectionLocalKey(name: string): string { return `collections/${name}`; }

// 对外 entry：id + uat（只读盖戳）+ value（任意 JSON）。
export interface CollectionEntry { id: string; uat: number; value: unknown; }
export type ChangeCb = (changedIds: string[]) => void;

export interface CollectionConfig {
  cloud: CloudSync;
  name: string;                 // 同步键 = 云端文件名（如 "synced-user-preference.json"）
  isOnline?: () => boolean;
  syncDelayMs?: number;         // 编辑后防抖自动同步（collection 无冲突、union 安全，频繁推也行）
  now?: () => number;           // uat 盖戳（默认 Date.now；测试可注入确定时钟）
  manual?: boolean;             // true=setItem/delete 只标脏不自动调度，由 flush 驱动 commit
  /** 本地缓存（IDB）：透明缓存内存 env → 离线可读 + 强杀存活 + 旧设备旧缓存靠 uat-LWW 不盖新。不传 = 纯内存+云。 */
  local?: Pick<LocalCache, "save" | "get" | "exists">;
  localWriteDelayMs?: number;   // 本地写防抖（coalesce 高频 setItem，避免每帧写 IDB）。默认 400。
  cloudless?: boolean;          // local-only 变体：永不碰云（init 只 hydrate、setItem 只写本地、refresh no-op）。
}

export interface Collection {
  init(): Promise<void>;                              // 先 hydrate 本地（快）→ 后台 reconcile 云端（不 await）
  refresh(): Promise<void>;                           // 事件驱动重拉云端 + resolve（per-key LWW）
  setItem(id: string, value: unknown): void;          // 同步写内存 + 防抖持久化（init 前抛错）
  deleteItem(id: string): void;                       // 移到 trash（edit-wins 合并）
  getItem<V = unknown>(id: string, def?: V | (() => V)): V | undefined;   // 同步读 value（无值→default）
  getEntry(id: string): CollectionEntry | undefined;  // 带 uat 的完整 entry
  entries(): CollectionEntry[];                       // 全部 entry
  keys(): string[];                                   // 全部 id
  onChange(cb: ChangeCb): () => void;                 // 整库：云端 reconcile/refresh 带来值变→通知 changedIds（返退订）
  onChange(id: string, cb: () => void): () => void;   // 单 key：绑某个 key，其值变→通知（返退订）
  flush(): Promise<void>;                             // 取消防抖、写本地 + 若脏立即云同步
  flushLocal(): Promise<void>;                        // 仅把内存 env 立即写本地缓存（卸载兜底；无网络）
  isDirty(): boolean;
}

const encode = (f: FolderEnvelope): Uint8Array => new TextEncoder().encode(JSON.stringify(f));
const decode = (text: string): FolderEnvelope | null => parseFolderBlob(text);

// store scaffold 用：一份**空** collection 的字节（与 encode 同格式 → decode 可读回）。开库时 store 拿它 idempotent 建空云文件。
export function emptyCollectionBytes(): Uint8Array { return encode(emptyFolder()); }

// getItem 缺省：def 可为裸值或**共享**工厂函数（缺项时才调）。⚠工厂 lambda **别 inline**——
//   getItem 常在热路径被调，inline `() => ({...})` 每次分配闭包+默认对象；写成模块级共享 const 函数复用。
const resolveDef = <V>(def?: V | (() => V)): V | undefined =>
  typeof def === "function" ? (def as () => V)() : def;

// getItem/setItem 两侧 shallow copy：value 是对象/数组时拷一层，隔离库内信封与 app 的可变引用
//   （getItem 拿到的对象原地改不污染存档信封；setItem 传入的对象之后被 app 改也不反污染信封）。标量原样。
//   浅拷贝语义：深层嵌套子对象不拷——app 别原地改嵌套后指望隔离，要改整枝替换再 setItem。
const shallowCopy = <V>(v: V): V =>
  Array.isArray(v) ? ([...v] as unknown as V)
  : (v && typeof v === "object") ? ({ ...(v as object) } as V)
  : v;

export function createCollection(cfg: CollectionConfig): Collection {
  const { cloud, name, isOnline, syncDelayMs = 1500, now = () => Date.now(), manual = false,
    local, localWriteDelayMs = 400, cloudless = false } = cfg;
  const flow = createFolderFlow({ cloud, name, encode, decode, isOnline });
  let env: FolderEnvelope = emptyFolder();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ready = false;                              // init 后置 true：pre-init 守卫（setItem 抛、getItem 返 default）
  const listeners = new Set<ChangeCb>();

  // ── onChange：云端 reconcile/refresh 带来值变 → 通知订阅者（如 theme 云变热重贴）。──────────
  const snapshotValues = (): Map<string, string> => {
    const m = new Map<string, string>();
    for (const e of env.items) if (e.id != null) m.set(String(e.id), JSON.stringify((e as { value?: unknown }).value));
    return m;
  };
  const fireChanged = (before: Map<string, string>): void => {
    if (!listeners.size) return;
    const after = snapshotValues();
    const changed: string[] = [];
    for (const [id, v] of after) if (before.get(id) !== v) changed.push(id);
    for (const [id] of before) if (!after.has(id)) changed.push(id);
    if (changed.length) for (const cb of listeners) { try { cb(changed); } catch { /* 单个监听崩不连累 */ } }
  };

  // ── 本地缓存（IDB）：透明镜像内存 env（含 uat 的完整 envelope）。──────────────────────
  const localKey = collectionLocalKey(name);
  let hydrated = false;
  let localTimer: ReturnType<typeof setTimeout> | null = null;
  let localChain: Promise<void> = Promise.resolve();

  async function bytesOf(b: Blob | Uint8Array | null): Promise<Uint8Array | null> {
    if (!b) return null;
    if (b instanceof Uint8Array) return b;
    if (typeof (b as Blob).arrayBuffer === "function") return new Uint8Array(await (b as Blob).arrayBuffer());
    return null;
  }
  async function hydrateLocal(): Promise<void> {
    if (!local || hydrated) return;
    hydrated = true;
    try {
      const cached = parseFolderBlob((await bytesOf(await local.get(localKey))) ?? new Uint8Array(0));
      if (cached) env = mergeFolders(env, cached);   // 合并进当前 env（保留各 item uat）
    } catch { /* 坏本地缓存 → 忽略，回退云端 */ }
  }
  function clearLocalTimer(): void { if (localTimer != null) { clearTimeout(localTimer); localTimer = null; } }
  function scheduleLocalWrite(): void {
    if (!local || localTimer != null) return;
    localTimer = setTimeout(() => { localTimer = null; void writeLocalNow(); }, localWriteDelayMs);
  }
  function writeLocalNow(): Promise<void> {
    if (!local) return Promise.resolve();
    clearLocalTimer();
    const snap = encode(env);                         // 抓当前 env 快照（含 uat）
    localChain = localChain.then(() => local.save(localKey, snap).then(() => undefined)).catch(() => undefined);
    return localChain;
  }

  function clearTimer() { if (timer != null) { clearTimeout(timer); timer = null; } }
  function scheduleSync() {
    scheduleLocalWrite();        // 本地缓存与云无关：cloudless/manual/auto 都写本地（强杀/离线靠它）
    if (cloudless) return;       // local-only：永不碰云
    cloud.setDirty(name, true);
    if (manual) return;          // 手动模式：只标脏，云 commit 由调用方 flush() 驱动
    clearTimer();
    timer = setTimeout(() => { timer = null; void sync(); }, syncDelayMs);
  }

  // sync：snapshot 内存 env → folder-flow（pull-merge-push）→ 把合并结果**并回**当前 env（per-item LWW 保新编辑不被旧快照盖）。
  //   带来云端值变 → fireChanged。dirty 收尾（K12）：synced 且并回后 == 已推的 res.folder 才清脏。
  async function sync(): Promise<void> {
    if (cloudless) return;
    const before = snapshotValues();
    const res = await flow.sync(env);
    env = mergeFolders(env, res.folder);
    scheduleLocalWrite();   // 把合并后的（含云端）状态也写回本地缓存
    if (res.status === "synced") {
      if (res.etag) cloud.setETag(name, res.etag);
      if (normalizeFolder(env) === normalizeFolder(res.folder)) cloud.setDirty(name, false);
    }
    fireChanged(before);
  }

  async function init(): Promise<void> {
    await hydrateLocal();               // 先从本地缓存 hydrate（秒开 / 离线可读 / 强杀存活）
    ready = true;                       // 本地就绪：getItem 有值、setItem 放行。云端后台对齐（不 block boot）。
    if (cloudless) return;
    void backgroundReconcile();         // fire-and-forget：编排锁库内，app 只 await 到本地就绪
  }

  // 后台/事件驱动云端对齐：freshness 快路径（etag-skip）+ 完整 pull-merge-push；离线/坏字节绝不 wipe。
  async function reconcile(): Promise<void> {
    if (cloudless) return;
    // 快路径（freshness etag-skip）：clean ∧ 在线 ∧ 有已知 etag ∧ 云端 etag 没变 → 本地即最新，跳整份 pull-merge-push。
    if (!cloud.isDirty(name) && (!isOnline || isOnline()) && cloud.getETag(name)) {
      const meta = await cloud.fetchMeta(name).catch(() => null);
      if (meta && meta.etag === cloud.getETag(name)) return;   // 云端没变 → 不重 pull
    }
    await sync();                       // pull-merge-push（其内部离线优雅、绝不 wipe；带 fireChanged）
  }
  function backgroundReconcile(): Promise<void> { return reconcile().catch(() => undefined); }

  async function refresh(): Promise<void> { await backgroundReconcile(); }   // 事件驱动重拉（focus/visible/online）

  function setItem(id: string, value: unknown): void {
    if (!ready) throw new Error(`collection(${name}).setItem 在 init() 前调用——设置未就绪`);
    if (id == null) throw new Error("collection.setItem: id 必填");
    const fi: FolderItem = { id, uat: now(), value: shallowCopy(value) };   // 信封 {id, uat, value}；uat 内部盖戳；value 浅拷贝隔离
    env = { ...env, items: [...env.items.filter((e) => e.id !== id), fi] };
    scheduleSync();
  }

  function deleteItem(id: string): void {
    if (!ready) throw new Error(`collection(${name}).deleteItem 在 init() 前调用`);
    if (!env.items.some((e) => e.id === id)) return;
    env = {
      ...env,
      items: env.items.filter((e) => e.id !== id),
      trash: [...env.trash.filter((t) => t.id !== id), { id, uat: now() }],
    };
    scheduleSync();
  }

  const entryOf = (e: FolderItem): CollectionEntry => ({ id: String(e.id), uat: e.uat || 0, value: (e as { value?: unknown }).value });
  function getEntry(id: string): CollectionEntry | undefined {
    const e = env.items.find((x) => x.id === id);
    return e ? entryOf(e) : undefined;
  }
  function getItem<V = unknown>(id: string, def?: V | (() => V)): V | undefined {
    const e = env.items.find((x) => x.id === id);
    return e ? shallowCopy((e as { value?: unknown }).value as V) : resolveDef(def);   // 浅拷贝隔离，防调用方原地改污染信封
  }
  function entries(): CollectionEntry[] { return env.items.map(entryOf); }
  function keys(): string[] { return env.items.map((e) => String(e.id)); }

  // 整库 onChange(cb) 或单 key onChange(id, cb)。单 key = 内部包一层 ChangeCb 过滤 changedIds。
  function onChange(a: ChangeCb | string, b?: () => void): () => void {
    const cb: ChangeCb = typeof a === "string"
      ? (ids) => { if (ids.includes(a)) b!(); }
      : a;
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }

  async function flush(): Promise<void> {
    clearTimer();
    await writeLocalNow();                          // 先确保本地落（卸载/手动保存兜底）
    if (!cloudless && cloud.isDirty(name)) await sync();
  }
  function flushLocal(): Promise<void> { return writeLocalNow(); }
  function isDirty(): boolean { return cloudless ? false : cloud.isDirty(name); }

  return { init, refresh, setItem, deleteItem, getItem, getEntry, entries, keys, onChange, flush, flushLocal, isDirty };
}
