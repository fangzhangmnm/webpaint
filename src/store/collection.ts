// ⚠ 使用前必读 README.md。app 不直接 import 本文件——经 createStore 的 store.collection 拿。
//
// GENERIC — Collection store facade（README.md §3）。一份同步 JSON 装多个**原子** item。
// 自拥内存 envelope（不像 folder-store 让 app 注入 snapshot()/onResult）；item = 普通 JSON 对象。
// 信封 { id, uat, ...payload } 由本模块强制：id 类型上必填、uat **内部盖戳**（app 既传不进也读不到）、
//   其余字段 = opaque payload。合并复用 folder-merge（per-item uat-LWW，CRDT-lite，零冲突）；
//   同步复用 folder-flow（pull-merge-push）。序列化 = JSON（#68：collection 是结构化可合并 JSON，
//   不要 app 传 encode/decode）。
import { createFolderFlow } from "./folder-flow.ts";
import { emptyFolder, parseFolderBlob, mergeFolders, normalizeFolder } from "./folder-merge.ts";
import type { FolderEnvelope, FolderItem } from "./folder-merge.ts";
import type { CloudSync, LocalCache } from "./types.ts";

// collection 在本地缓存（IDB）里的键名。前缀隔离，绝不与 file 路径（如 "papers/x.pdf"）撞。
export function collectionLocalKey(name: string): string { return `__collection__/${name}`; }

// 对外 item：调用方给的 payload + 必填 id（uat 不在此——库内部的事）。
export type CollectionItem<T extends object> = T & { id: string };

export interface CollectionConfig {
  cloud: CloudSync;
  name: string;                 // 同步键 = 云端文件名（如 "reading-state.json"）
  isOnline?: () => boolean;
  syncDelayMs?: number;         // 编辑后防抖自动同步（collection 无冲突、union 安全，频繁推也行）
  now?: () => number;           // uat 盖戳（默认 Date.now；测试可注入确定时钟）
  manual?: boolean;             // true=upsert/delete 只标脏不自动调度，由 flush 驱动 commit（阅读位置走 valuable-save 节流）
  /** 本地缓存（IDB）：透明缓存内存 env → 离线可读 + 强杀存活 + 旧设备旧缓存靠 uat-LWW 不盖新。不传 = 纯内存+云（旧行为）。 */
  local?: Pick<LocalCache, "save" | "get" | "exists">;
  localWriteDelayMs?: number;   // 本地写防抖（coalesce 高频 setPosition，避免每帧写 IDB）。默认 400。
}

export interface Collection<T extends object> {
  init(): Promise<void>;                              // 首次拉云端 merge 进内存
  upsertItem(item: CollectionItem<T>): void;          // 新增 / 整条原子替换
  deleteItem(id: string): void;                       // 移到 trash（edit-wins 合并）
  getItem(id: string): CollectionItem<T> | undefined;
  items(): CollectionItem<T>[];                       // 全部 item（每条含自己的 id）
  keys(): string[];                                   // 全部 id
  flush(): Promise<void>;                             // 取消防抖、写本地 + 若脏立即云同步
  flushLocal(): Promise<void>;                         // 仅把内存 env 立即写本地缓存（卸载兜底；无网络）
  isDirty(): boolean;
}

const encode = (f: FolderEnvelope): Uint8Array => new TextEncoder().encode(JSON.stringify(f));
const decode = (text: string): FolderEnvelope | null => parseFolderBlob(text);

// FolderItem（内部，带 uat）→ 对外 item（剥掉 uat，留 id + payload）。
function toItem<T extends object>(e: FolderItem): CollectionItem<T> {
  const { uat: _uat, ...rest } = e;
  return rest as CollectionItem<T>;
}

export function createCollection<T extends object>(cfg: CollectionConfig): Collection<T> {
  const { cloud, name, isOnline, syncDelayMs = 1500, now = () => Date.now(), manual = false,
    local, localWriteDelayMs = 400 } = cfg;
  const flow = createFolderFlow({ cloud, name, encode, decode, isOnline });
  let env: FolderEnvelope = emptyFolder();
  let timer: ReturnType<typeof setTimeout> | null = null;

  // ── 本地缓存（IDB）：透明镜像内存 env（含 uat 的完整 envelope）。──────────────────────
  // hydrate：合并不替换（坏字节 parseFolderBlob 返 null 即忽略，绝不 wipe）；uat 保留（守 A5/B6）。
  // 写：coalesce 防抖（高频 setPosition 不每帧写 IDB），串行链避免重叠；卸载用 flushLocal 即时落。
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
    cloud.setDirty(name, true);
    scheduleLocalWrite();        // 本地缓存与云无关：manual/auto 都写本地（强杀/离线靠它）
    if (manual) return;          // 手动模式：只标脏，云 commit 由调用方 flush() 驱动（valuable-save 节流）
    clearTimer();
    timer = setTimeout(() => { timer = null; void sync(); }, syncDelayMs);
  }

  // sync：snapshot 内存 env → folder-flow（pull-merge-push）→ 把合并结果**并回**当前 env。
  // ★关键：用 mergeFolders 并回、不整体替换——sync 是 async，期间 env 可能又被编辑（如 fire-and-forget
  //   flush 与后续 upsert 撞车）；per-item LWW 保那些新编辑（更高 uat）不被旧快照的合并结果覆盖。
  // dirty 收尾（K12）：只有"synced 且并回后没新编辑（== 已推的 res.folder）"才清脏；否则留脏，下次 flush 推新编辑。
  async function sync(): Promise<void> {
    const res = await flow.sync(env);
    env = mergeFolders(env, res.folder);
    scheduleLocalWrite();   // 把合并后的（含云端）状态也写回本地缓存
    if (res.status === "synced") {
      if (res.etag) cloud.setETag(name, res.etag);
      if (normalizeFolder(env) === normalizeFolder(res.folder)) cloud.setDirty(name, false);
    }
  }

  async function init(): Promise<void> {
    await hydrateLocal();               // 先从本地缓存 hydrate（秒开 / 离线可读 / 强杀存活）
    // 快路径（freshness etag-skip）：clean ∧ 在线 ∧ 有已知 etag ∧ 云端 etag 没变 → 本地 hydrate 即最新，
    //   **跳过整份 pull-merge-push**（只一次轻量 fetchMeta，秒开）。否则落到下面的完整 sync。
    //   安全：getETag(name)=本地缓存对应的云版（init/sync 时与 IDB env 一起更新）；dirty 时不走（要推未推编辑）；
    //   etag 变=云端真动过→必须 pull；离线/fetchMeta 失败→也落完整 sync（其内部离线优雅、绝不 wipe 本地）。
    if (!cloud.isDirty(name) && (!isOnline || isOnline()) && cloud.getETag(name)) {
      const meta = await cloud.fetchMeta(name).catch(() => null);
      if (meta && meta.etag === cloud.getETag(name)) return;   // 云端没变 → 不重 pull
    }
    const res = await flow.sync(env);    // pull-merge-push；离线/坏字节则 env 保持本地 hydrate 值，绝不 wipe
    env = mergeFolders(env, res.folder);
    if (res.status === "synced" && res.etag) cloud.setETag(name, res.etag);
    await writeLocalNow();              // 持久合并结果
  }

  function upsertItem(item: CollectionItem<T>): void {
    if (item == null || item.id == null) throw new Error("collection.upsertItem: item.id 必填");
    const fi: FolderItem = { ...item, id: item.id, uat: now() };   // uat 内部盖戳
    env = { ...env, items: [...env.items.filter((e) => e.id !== item.id), fi] };
    scheduleSync();
  }

  function deleteItem(id: string): void {
    if (!env.items.some((e) => e.id === id)) return;
    env = {
      ...env,
      items: env.items.filter((e) => e.id !== id),
      trash: [...env.trash.filter((t) => t.id !== id), { id, uat: now() }],
    };
    scheduleSync();
  }

  function getItem(id: string): CollectionItem<T> | undefined {
    const e = env.items.find((x) => x.id === id);
    return e ? toItem<T>(e) : undefined;
  }
  function items(): CollectionItem<T>[] { return env.items.map((e) => toItem<T>(e)); }
  function keys(): string[] { return env.items.map((e) => String(e.id)); }
  async function flush(): Promise<void> {
    clearTimer();
    await writeLocalNow();                          // 先确保本地落（卸载/手动保存兜底）
    if (cloud.isDirty(name)) await sync();
  }
  function flushLocal(): Promise<void> { return writeLocalNow(); }
  function isDirty(): boolean { return cloud.isDirty(name); }

  return { init, upsertItem, deleteItem, getItem, items, keys, flush, flushLocal, isDirty };
}
