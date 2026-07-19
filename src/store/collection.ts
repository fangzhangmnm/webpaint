// ⚠ 使用前必读 README.md。app 不直接 import 本文件——经 createStore 的 store.collection 拿。
//
// GENERIC — Collection store facade（README.md §3）。一份同步 JSON 装多个**原子** item。
// 自拥内存 envelope（不像 folder-store 让 app 注入 snapshot()/onResult）；item = **裸值 KV**：
//   信封 { id, uat, value } 由本模块强制——id 必填、uat 内部盖戳（app 既传不进也读不到）、
//   value = 任意 JSON（对象或裸值，opaque）。folder-merge 把 value 当普通 opaque payload 字段搬运，
//   per-item uat-LWW（CRDT-lite，零冲突静默 last-win，配置类可接受丢失——见 folder-merge §N11）。
//   同步复用 folder-flow（pull-merge-push，If-Match）。序列化 = JSON（#68：库内部 JSON，app 不传 encode/decode）。
//
// **删除 = 墓碑（value:null）**：deleteItem(id) ≡ setItem(id, null)。null 是**明确删除指令**（非「未知」），
//   带 uat 参与 last-write-wins（删得晚→删掉；编辑得晚→留编辑）。墓碑留在 items[] 里照 LWW 跨设备传播，
//   读面（keys/entries/getItem/getEntry）过滤 value===null。**setItem(id, undefined) 报错**（None 非法；
//   要删传 null 或用 deleteItem）。无独立 trash 集合、无 resetAt 水位线（2026-07 tombstone 化）。
//
// **新库初始化（getInitData，eager）**：**idb 无此 collection**（新库）时 init 立即调 getInitData() 填初始值
//   uat=1（最低戳）。随后后台 reconcile 拉云——云端/别设备真数据（uat>1）经 LWW **必胜过 seed、覆盖**；
//   云端确实空则 seed 推上去。离线新设备立即有内容；在线新设备先显 seed、云端到了再覆盖。见下 init()。
//
// 读写 = **同步内存**（getItem/setItem 不 await）；两侧 value 浅拷贝隔离（app 拿到/传入的对象改动不与信封互相污染）。
//   但内存 env 在 init() 前为空（getItem 返 default，setItem 抛错）。onChange(cb) 整库 / onChange(id,cb) 绑单 key。
//   **onChange 对本地写和云端写一视同仁**：本地 setItem/deleteItem 同步 fire（内存已更新，不等 IDB 防抖、
//   不等云），云端 reconcile 照旧 fire。app 读侧因此完全声明式，且**分不出变更来自本地还是远端**
//   （网盘模型：你只知道"盘更新了"——刻意不给区分度，免得两条路径各写一套逻辑而漂移）。
//   init()（编排锁库内，照 file.open）：先 await hydrateLocal（本地 IDB，快）→ 再**后台 fire-and-forget**
//   reconcile 云端（不 await）→ resolve。boot await init() 拿本地即够；云端后台对齐、onChange 通知。
//   reconcileWithRemote()：事件驱动（focus/visible/online）重拉+resolve，per-key LWW（同 file.refresh）。
//   pull 时若 local 有 uat-newer / pending → 一并 push（故名 reconcileWithRemote，非单向 pull）。
// local-only 变体（cloudless）：只走 IDB 本地缓存、永不碰云（flow.sync）。给设备本地设置用。
import { createFolderFlow, type FolderFlowResult } from "./folder-flow.ts";
import { emptyFolder, parseFolderBlob, mergeFolders, normalizeFolder, FOLDER_ENVELOPE_VERSION } from "./folder-merge.ts";
import type { FolderEnvelope, FolderItem } from "./folder-merge.ts";
import type { CloudSync, LocalCache } from "./types.ts";
import { reportStoreError } from "./error-handling.ts";

// collection 在本地缓存（IDB `blobs`）里的键名 = collections 分区（`collections/<name>`）。
export function collectionLocalKey(name: string): string { return `collections/${name}`; }

// 对外 entry：id + uat（只读盖戳）+ value（任意 JSON）。
export interface CollectionEntry { id: string; uat: number; value: unknown; }
export type ChangeCb = (changedIds: string[]) => void;

// getInitData 的初始项：id + value（value 不可为 undefined）。app 域构造（如笔架把 builtin-brushes.json
//   映射成 [{id, value}]），store 内容无关——不知道装的是笔。
export interface CollectionInitItem { id: string; value: unknown; }

const SEED_UAT = 1;   // 初始值 uat：最低戳，任何真实编辑（Date.now）/ 别设备真数据必胜。

export interface CollectionConfig {
  cloud: CloudSync;
  name: string;                 // 同步键 = 云端文件名（如 "synced-user-preference.json"）
  isOnline?: () => boolean;
  syncDelayMs?: number;         // 编辑后防抖自动同步（collection 无冲突、union 安全，频繁推也行）
  now?: () => number;           // uat 盖戳（默认 Date.now；测试可注入确定时钟）
  manual?: boolean;             // true=setItem/delete 只标脏不自动调度云推，由 reconcileWithRemote 驱动 commit
  /** 本地缓存（IDB）：透明缓存内存 env → 离线可读 + 强杀存活 + 旧设备旧缓存靠 uat-LWW 不盖新。不传 = 纯内存+云。 */
  local?: Pick<LocalCache, "save" | "get" | "exists">;
  localWriteDelayMs?: number;   // 本地写防抖（coalesce 高频 setItem，避免每帧写 IDB）。默认 400。
  cloudless?: boolean;          // local-only 变体：永不碰云（init 只 hydrate、setItem 只写本地、reconcileWithRemote no-op）。
  /** 仅当这份 collection 的 json **不存在**时调（填初始值，uat=1）。store 内容无关：app 域构造 [{id,value}]。 */
  getInitData?: () => CollectionInitItem[] | Promise<CollectionInitItem[]>;
}

// reconcileWithRemote 的终态。status 来自 folder-flow.sync（synced/offline/invalid/dirty），
//   外加 unchanged（云端 etag 没变，压根没拉）和 error（意外抛）。
export interface ReconcileResult { status: string; pushed?: boolean; error?: unknown }

export interface Collection {
  init(): Promise<void>;                              // 先 hydrate 本地（快）→ 后台 reconcile 云端（不 await）+ 新库 seed
  reconcileWithRemote(): Promise<ReconcileResult>;    // 事件驱动重拉 + resolve。**读 status**：unchanged/synced/offline/invalid/dirty/error（别只 await 就报成功）
  setItem(id: string, value: unknown): void;          // 同步写内存 + 防抖持久化（init 前抛错；value===undefined 报错）
  deleteItem(id: string): void;                       // ≡ setItem(id, null)：null 墓碑，LWW
  getItem<V = unknown>(id: string, def?: V | (() => V)): V | undefined;   // 同步读 value（无值 / 墓碑 → default）
  getEntry(id: string): CollectionEntry | undefined;  // 带 uat 的完整 entry（墓碑 → undefined）
  entries(): CollectionEntry[];                       // 全部 entry（过滤墓碑）
  keys(): string[];                                   // 全部 id（过滤墓碑）
  onChange(cb: ChangeCb): () => void;                 // 整库：**任何**值变（本地 setItem 同步 fire / 云端 reconcile）→ 通知 changedIds（返退订）
  onChange(id: string, cb: () => void): () => void;   // 单 key：绑某个 key，其值变→通知（返退订）
  flushLocal(): Promise<{ ok: boolean; error?: unknown }>;   // 立即写本地缓存（卸载兜底）。**ok=false 表示本地都没写进去**（配额/IDB 拒绝）——别忽略
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

// 墓碑判定：value===null = 删除指令。
const valueOf = (e: FolderItem): unknown => (e as { value?: unknown }).value;
const isTombstone = (e: FolderItem): boolean => valueOf(e) === null;

export function createCollection(cfg: CollectionConfig): Collection {
  const { cloud, name, isOnline, syncDelayMs = 1500, now = () => Date.now(), manual = false,
    local, localWriteDelayMs = 400, cloudless = false, getInitData } = cfg;
  const flow = createFolderFlow({ cloud, name, encode, decode, isOnline });
  let env: FolderEnvelope = emptyFolder();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ready = false;                              // init 后置 true：pre-init 守卫（setItem 抛、getItem 返 default）
  const listeners = new Set<ChangeCb>();

  // ── onChange：**任何**值变（本地 setItem / 云端 reconcile）→ 通知订阅者。────────────────────
  //   本地写同步 fire（内存已即时更新，不等 400ms IDB 防抖、不等云）；远端 reconcile 照旧。
  //   读侧因此完全声明式，且**分不出本地还是远端**——那正是设计目标（网盘模型：你只知道"盘更新了"）。
  //   墓碑（value:null）也计入 → 删除同样触发（别台删了本地要跟着移除）。
  let _firing = false;
  const _queued: string[] = [];
  function emit(changed: string[]): void {
    if (!changed.length || !listeners.size) return;
    if (_firing) { _queued.push(...changed); return; }   // 重入（listener 里又 setItem）→ 排队合并，绝不递归
    _firing = true;
    try {
      let batch = changed;
      while (batch.length) {
        for (const cb of listeners) { try { cb(batch); } catch (e) { reportStoreError(e, "log"); } }
        batch = _queued.splice(0, _queued.length);
      }
    } finally { _firing = false; }
  }
  const snapshotValues = (): Map<string, string> => {
    const m = new Map<string, string>();
    for (const e of env.items) if (e.id != null) m.set(String(e.id), JSON.stringify(valueOf(e)));
    return m;
  };
  // 远端路径专用：整表快照 diff（云端合并可能动任意多 key，只能全表比）。
  //   ⚠ 本地 setItem **不**走这条——它只动一个 id，却要 JSON.stringify 全表；resetBuiltin 连写 ~60 项就是 O(N²)。
  const fireChanged = (before: Map<string, string>): void => {
    if (!listeners.size) return;
    const after = snapshotValues();
    const changed: string[] = [];
    for (const [id, v] of after) if (before.get(id) !== v) changed.push(id);
    for (const [id] of before) if (!after.has(id)) changed.push(id);
    emit(changed);
  };

  // ── 本地缓存（IDB）：透明镜像内存 env（含 uat 的完整 envelope）。──────────────────────
  const localKey = collectionLocalKey(name);
  let hydrated = false;
  let idbHad = false;                             // hydrate 时本地是否已有这份 collection（新库判定用）
  let localTimer: ReturnType<typeof setTimeout> | null = null;
  let localChain: Promise<{ ok: boolean; error?: unknown }> = Promise.resolve({ ok: true });

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
      idbHad = await local.exists(localKey);
      if (idbHad) {
        const cached = parseFolderBlob((await bytesOf(await local.get(localKey))) ?? new Uint8Array(0));
        if (cached) env = mergeFolders(env, cached);   // 合并进当前 env（保留各 item uat）
      }
    } catch (e) { reportStoreError(e, "log"); }   // 坏本地缓存 → 忽略，回退云端
  }
  function clearLocalTimer(): void { if (localTimer != null) { clearTimeout(localTimer); localTimer = null; } }
  function scheduleLocalWrite(): void {
    if (!local || localTimer != null) return;
    localTimer = setTimeout(() => { localTimer = null; void writeLocalNow(); }, localWriteDelayMs);
  }
  // ★ v436：本地写**失败也要说出来**。旧版 `.catch(reportStoreError(e,"log"))` 之后返回 localChain，
  //   于是 IDB 写被拒（配额满 / 存储被阻塞 / 隐私模式）时这个 promise 照样 resolve，且只进 console。
  //   三个 unload 屏障（app-prefs / app-state / brush-rack-controller）全靠它当「关机前落盘」的保证——
  //   一旦它说谎，用户的设置和笔架就**静默丢失**。而这是**本地**那条腿，不是云端：
  //   离线是正常坏天气，本地写不进去不是。分级也从 "log" 提到 "warning"（要出 banner）。
  function writeLocalNow(): Promise<{ ok: boolean; error?: unknown }> {
    if (!local) return Promise.resolve({ ok: true as const });
    clearLocalTimer();
    const snap = encode(env);                         // 抓当前 env 快照（含 uat）
    localChain = localChain
      .then(() => local.save(localKey, snap).then(() => ({ ok: true as const })))
      .catch((e) => { reportStoreError(e, "warning"); return { ok: false as const, error: e }; });
    return localChain;
  }

  function clearTimer() { if (timer != null) { clearTimeout(timer); timer = null; } }
  function scheduleSync() {
    scheduleLocalWrite();        // 本地缓存与云无关：cloudless/manual/auto 都写本地（强杀/离线靠它）
    if (cloudless) return;       // local-only：永不碰云
    cloud.setDirty(name, true);
    if (manual) return;          // 手动模式：只标脏，云 commit 由调用方 reconcileWithRemote() 驱动
    clearTimer();
    timer = setTimeout(() => { timer = null; void sync(); }, syncDelayMs);
  }

  // sync：snapshot 内存 env → folder-flow（pull-merge-push）→ 把合并结果**并回**当前 env（per-item LWW 保新编辑不被旧快照盖）。
  //   带来云端值变 → fireChanged。dirty 收尾（K12）：synced 且并回后 == 已推的 res.folder 才清脏。返 flow 结果。
  async function sync(): Promise<FolderFlowResult | null> {
    if (cloudless) return null;
    const before = snapshotValues();
    const res = await flow.sync(env);
    env = mergeFolders(env, res.folder);
    scheduleLocalWrite();   // 把合并后的（含云端）状态也写回本地缓存
    if (res.status === "synced") {
      if (res.etag) cloud.setETag(name, res.etag);
      if (normalizeFolder(env) === normalizeFolder(res.folder)) cloud.setDirty(name, false);
    }
    fireChanged(before);
    return res;
  }

  // 后台/事件驱动云端对齐：freshness 快路径（etag-skip）+ 完整 pull-merge-push；离线/坏字节绝不 wipe。
  //   返 flow 结果或 null（cloudless / etag-skip）。
  async function reconcile(): Promise<FolderFlowResult | null> {
    if (cloudless) return null;
    // 快路径（freshness etag-skip）：clean ∧ 在线 ∧ 有已知 etag ∧ 云端 etag 没变 → 本地即最新，跳整份 pull-merge-push。
    if (!cloud.isDirty(name) && (!isOnline || isOnline()) && cloud.getETag(name)) {
      const meta = await cloud.fetchMeta(name).catch((e) => { reportStoreError(e, "log"); return null; });
      if (meta && meta.etag === cloud.getETag(name)) return null;   // 云端没变 → 不重 pull（有 etag = 云端存在）
    }
    return sync();                       // pull-merge-push（其内部离线优雅、绝不 wipe；带 fireChanged）
  }

  // 事件驱动重拉（focus/visible/online）。错误接 reportError（意外 throw；flow 内部的离线/push 失败已各自 funnel）。
  //   ★ v436：**返回结果，别收窄成 void**。folder-flow.sync 本来就产出
  //   {status:"synced"|"offline"|"invalid"|"dirty", pushed, error}，collection.sync/reconcile 一路带上来，
  //   却在这最后一步被抹平——于是「离线」「云端字节非法被拒」「push 没成、配置仍未上传」
  //   在每个调用点都和成功长得一模一样。笔架点「刷新」永远停在「正在刷新…」就是这么来的。
  async function reconcileWithRemote(): Promise<ReconcileResult> {
    try { return (await reconcile()) ?? { status: "unchanged" }; }
    catch (e) { reportStoreError(e, "warning"); return { status: "error", error: e }; }
  }

  // 新库 seed：getInitData() → uat=1 填入（最低戳，真数据必胜）。**eager**：idb 无就填，不等云端判定。
  async function seedInit(): Promise<void> {
    if (!getInitData) return;
    let initial: CollectionInitItem[];
    try { initial = await getInitData(); }
    catch (e) { reportStoreError(e, "warning"); return; }   // 初始数据源（如 fetch builtin-brushes.json）失败 → surface
    if (!initial || !initial.length) return;
    const seeded: FolderItem[] = initial
      .filter((it) => it && it.id != null && it.value !== undefined)
      .map((it) => ({ id: it.id, uat: SEED_UAT, value: shallowCopy(it.value) }));
    if (!seeded.length) return;
    env = mergeFolders(env, { version: FOLDER_ENVELOPE_VERSION, items: seeded });   // LWW：seed uat=1 遇真数据必让位
    cloud.setDirty(name, true);   // seed 需推云（cloudless 也标脏无害，flushLocal 落本地）
    scheduleLocalWrite();
  }

  async function init(): Promise<void> {
    await hydrateLocal();               // 先从本地缓存 hydrate（秒开 / 离线可读 / 强杀存活）；记 idbHad
    // **eager seed**（idb 无=新库）：立即用 uat=1 填初始值，不等云端判定。随后 reconcile 拉云——
    //   云端/别设备的真数据（uat>1）经 LWW **必胜过 seed、覆盖**；云端确实空则 seed 被推上去。
    //   离线新设备照样立即有内容；在线新设备先显 seed、云端到了再覆盖（用户设计）。
    if (!idbHad) await seedInit();
    ready = true;                       // 本地(含 seed)就绪：getItem 有值、setItem 放行。云端后台对齐（不 block boot）。
    if (cloudless) return;
    void reconcile().catch((e) => reportStoreError(e, "log"));   // 后台 pull-merge-push：真 cloud 覆盖 seed；seed 未被覆盖的推云
  }

  function setItem(id: string, value: unknown): void {
    if (!ready) throw new Error(`collection(${name}).setItem 在 init() 前调用——设置未就绪`);
    if (id == null) throw new Error("collection.setItem: id 必填");
    if (value === undefined) throw new Error(`collection(${name}).setItem: value 不可为 undefined（删除请用 deleteItem 或传 null 墓碑）`);
    const prev = env.items.find((e) => e.id === id);
    const valueChanged = !prev || JSON.stringify(valueOf(prev)) !== JSON.stringify(value);   // 同值重写不惊动订阅者
    const fi: FolderItem = { id, uat: now(), value: shallowCopy(value) };   // 信封 {id, uat, value}；uat 内部盖戳；value 浅拷贝隔离（null=墓碑）
    env = { ...env, items: [...env.items.filter((e) => e.id !== id), fi] };
    scheduleSync();
    // fire 在 scheduleSync **之后**：listener 若同步调 flushLocal()，此时定时器已挂好，语义一致。
    if (valueChanged) emit([id]);
  }

  function deleteItem(id: string): void {
    if (!ready) throw new Error(`collection(${name}).deleteItem 在 init() 前调用`);
    setItem(id, null);   // null 墓碑 = 明确删除指令，LWW（删得晚→删掉；别处编辑得晚→复活）
  }

  const entryOf = (e: FolderItem): CollectionEntry => ({ id: String(e.id), uat: e.uat || 0, value: valueOf(e) });
  function getEntry(id: string): CollectionEntry | undefined {
    const e = env.items.find((x) => x.id === id);
    return e && !isTombstone(e) ? entryOf(e) : undefined;   // 墓碑视为不存在
  }
  function getItem<V = unknown>(id: string, def?: V | (() => V)): V | undefined {
    const e = env.items.find((x) => x.id === id);
    return e && !isTombstone(e) ? shallowCopy(valueOf(e) as V) : resolveDef(def);   // 墓碑→default；浅拷贝隔离防调用方原地改污染信封
  }
  function entries(): CollectionEntry[] { return env.items.filter((e) => !isTombstone(e)).map(entryOf); }
  function keys(): string[] { return env.items.filter((e) => !isTombstone(e)).map((e) => String(e.id)); }

  // 整库 onChange(cb) 或单 key onChange(id, cb)。单 key = 内部包一层 ChangeCb 过滤 changedIds。
  function onChange(a: ChangeCb | string, b?: () => void): () => void {
    const cb: ChangeCb = typeof a === "string"
      ? (ids) => { if (ids.includes(a)) b!(); }
      : a;
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }

  function flushLocal(): Promise<{ ok: boolean; error?: unknown }> { return writeLocalNow(); }
  function isDirty(): boolean { return cloudless ? false : cloud.isDirty(name); }

  return { init, reconcileWithRemote, setItem, deleteItem, getItem, getEntry, entries, keys, onChange, flushLocal, isDirty };
}
