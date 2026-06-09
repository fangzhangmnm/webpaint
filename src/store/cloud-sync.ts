// cloud-sync —— session 级同步语义 over 低层 CloudProvider。从 WebPaint cloud.js 吸收、去 app 化。
//
// 这是 Store 消费的「cloud 后端」：push/pull/fetchMetadata/trash/restore/purge + etag/dirty 状态。
// app-agnostic：命名（.ora/.md/.glb…）、kv 后端（localStorage/IDB/内存）、时钟 都注入。
// 低层 CloudProvider（list/getItemByPath/download/upload/delete/ensureFolder/move/rename）由各 app 实现：
//   - WebPaint：OneDriveProvider（包 Graph，≈ 原 graph.js）
//   - 测试：MockCloudProvider
//
// 红线（与 potential-bugs 对应）：push 用 If-Match（baseEtag）· 412→CloudConflictError ·
//   分片末响应无 item→拉权威 etag 不崩不缓存 null（H7）· trash=move-aside 加 [ts] 后缀（A8/C2）·
//   restore 撞名 (2)(3) 防覆盖。

import { asideStamp } from "./move-aside.ts";   // 深模块的 move-aside 命名策略（yyyymmddhhmmss-guid 防撞）
import type { Bytes, CloudItem, CloudProvider, CloudSync, FetchMetaResult, Kv, PullResult, PushResult, WeakOverrideResult } from "./types.ts";

export class CloudConflictError extends Error {
  sessionName: string;
  constructor(message: string, sessionName: string) {
    super(message);
    this.name = "CloudConflictError";
    this.sessionName = sessionName;
  }
}
// 新建/无基准的 push 撞上云端**已存在的同名异文件**（两设备各建同名）。
// ≠ CloudConflictError（那是「同一文件版本分叉」走 keep/pull/branch）。这里是「两个不同文件抢同一个名」，
// **绝不覆盖**（否则静默吃掉别人的作品 = 数据丢失）→ caller 留本地 + 提示改名。
export class CloudNameCollisionError extends Error {
  sessionName: string;
  constructor(sessionName: string) {
    super(`云端已有同名「${sessionName}」（不同文件）`);
    this.name = "CloudNameCollisionError";
    this.sessionName = sessionName;
  }
}

/** 内存 kv（测试用；WebPaint 传 localStorage 包装）。 */
export function memKv(): Kv {
  const m = new Map<string, string>();
  return {
    get: (k) => (m.has(k) ? m.get(k)! : null),
    set: (k, v) => { m.set(k, String(v)); },
    remove: (k) => { m.delete(k); },
  };
}

// FetchMetaResult / WeakOverrideResult / PullResult 形状已收进 types.ts 的 CloudSync 契约。

// createCloudSync 的配置。
interface CloudSyncCfg {
  provider: CloudProvider;
  kv: Kv;
  fileName: (name: string) => string;
  contentType?: string;
  trashFolder?: string;
  backupFolder?: string;
  appKey?: string;
  now?: () => number;
  match?: (it: CloudItem) => boolean;
  toName?: (name: string) => string;
}

/**
 * @param {object} cfg
 * @param {object} cfg.provider  低层 CloudProvider
 * @param {object} cfg.kv        { get, set, remove }（etag/dirty 缓存）
 * @param {(name:string)=>string} cfg.fileName  session name → 云端文件名（如 n => n + ".ora"）
 * @param {string} [cfg.contentType]
 * @param {string} [cfg.trashFolder=".trash"]
 * @param {string} [cfg.appKey="sync"]  kv key 前缀
 * @param {()=>number} [cfg.now]  时钟（测试注入；默认 Date.now）
 */
export function createCloudSync(cfg: CloudSyncCfg): CloudSync {
  const { provider, kv, fileName, contentType = "application/octet-stream",
    trashFolder = ".trash", backupFolder = ".backup", appKey = "sync" } = cfg;
  const now = cfg.now || (() => Date.now());
  // match(item)：哪些云端文件算"session"（扩展名 agnostic；默认所有非文件夹）。gallery 列表用。
  const match = cfg.match || ((it: CloudItem) => !it.isFolder);
  // toName(item)：云端文件名 → session name（fileName 的逆；默认去最后一段扩展名）。
  const toName = cfg.toName || ((name: string) => name.replace(/\.[^./]+$/, ""));

  const etagKey = (n: string) => `${appKey}.etag:${n}`;
  const dirtyKey = (n: string) => `${appKey}.dirty:${n}`;
  const baseName = (n: string) => (n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n);
  // move-aside（.trash/.backup）的防撞名：<base> [<yyyymmddhhmmss>-<guid>]（命名策略在深模块 move-aside.js）。
  // guid 防同名多次 move-aside 撞（旧版 [ts] 同 ms → conflictBehavior:"fail" 抛错的真 bug）。trash/backup 共用。
  const stampedName = (n: string) => fileName(`${baseName(n)} [${asideStamp(now())}]`);

  function getETag(name: string): string | null { return kv.get(etagKey(name)) || null; }
  function setETag(name: string, eTag: string | null): void { if (eTag) kv.set(etagKey(name), eTag); else kv.remove(etagKey(name)); }
  function isDirty(name: string): boolean { const v = kv.get(dirtyKey(name)); return v === null ? true : v === "1"; }
  function setDirty(name: string, dirty: boolean): void { kv.set(dirtyKey(name), dirty ? "1" : "0"); }
  function clearState(name: string): void { kv.remove(etagKey(name)); kv.remove(dirtyKey(name)); }

  async function push(name: string, bytes: Bytes | Blob, opts: { baseEtag?: string | null } = {}): Promise<PushResult> {
    const path = fileName(name);
    const baseEtag = ("baseEtag" in opts) ? opts.baseEtag : getETag(name);
    // bytes 是 Uint8Array（Bytes），byteLength 即字节数；?? size/length 是历史兼容兜底（任意来源），故收窄成 any 读。
    const wrote = (bytes && ((bytes as any).byteLength ?? (bytes as any).size ?? (bytes as any).length)) || 0;
    // conflictBehavior：有 baseEtag → "replace"（If-Match 守，412 才冲突）；**无 baseEtag（新建/未基于云版）→ "fail"**
    //   → 绝不无条件覆盖云端已存在的同名文件（否则静默吃掉别人/旧版的同名作品 = 数据丢失，path-身份红线）。
    let item: CloudItem | null = null;
    try {
      item = await provider.upload(path, bytes, { contentType, eTag: baseEtag, conflictBehavior: baseEtag ? "replace" : "fail" });
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status === 412) throw new CloudConflictError(`云端已有更新版本 "${name}"`, name);
      if (!(status === 409 && !baseEtag)) throw e;
      // 409 = conflictBehavior:fail 撞上云端已存在同名 → 落下面核验（大小匹配=我方上次成功上传/同内容→认；否则不覆盖）。
    }
    // H7 / 409 兜底：末响应无 item（分片丢响应）或 fail-409 → 拉权威 meta；**仅大小匹配才认**（防把
    //   0 字节占位 / 别人的异文件 骗成 synced——postmortem 2026-06-05 第④级 + path-身份同名碰撞）。
    if (!item || !item.eTag) {
      const fresh = await provider.getItemByPath(path).catch(() => null);
      if (fresh && fresh.eTag && fresh.size === wrote) item = fresh;   // 大小匹配 → 认（我方成功上传/同内容）
      else if (!baseEtag && fresh && fresh.size > 0) {
        // 云端已有同名、**非空且大小不符** = 别人的同名异文件 → 绝不覆盖。保持 dirty，抛 collision 让 caller 提示改名。
        throw new CloudNameCollisionError(name);
      } else { item = null; }   // 0 字节占位（我方失败上传）/ 其他 → 保持 dirty，下次重试
    }
    if (item && item.eTag) { setETag(name, item.eTag); setDirty(name, false); }
    return { item };
  }

  // 永远 duplicate 进本地（caller 决定落地名），不覆盖既存。
  async function pull(name: string): Promise<PullResult | null> {
    const item = await provider.getItemByPath(fileName(name));
    if (!item) return null;
    const blob = await provider.download(item.id);
    setETag(name, item.eTag);
    setDirty(name, false);
    return { blob, item, suggestedName: name };
  }

  async function fetchMeta(name: string): Promise<FetchMetaResult | null> {
    const item = await provider.getItemByPath(fileName(name));
    if (!item) return null;
    return { etag: item.eTag, lastModified: item.lastModifiedDateTime, size: item.size, item };
  }

  // move-aside：原文件 → ensureFolder(.trash) → move，**始终加 [ts] 后缀**（多次删同名永不冲突）。
  async function trash(name: string): Promise<CloudItem | null> {
    const item = await provider.getItemByPath(fileName(name));
    if (!item) { clearState(name); return null; }
    const folderId = await provider.ensureFolder(trashFolder);
    const stamped = stampedName(name);   // basename + ts-counter（trash 内丢 folder context；防同名撞）
    const moved = await provider.move(item.id, folderId, { newName: stamped, conflictBehavior: "fail" });
    clearState(name);
    return moved;
  }

  // 从 trash 移回；conflictBehavior=fail 防覆盖目标位置同名（关键 data-loss 点）；撞名 (2)(3) 重试。
  async function restore(itemId: string, targetName: string): Promise<CloudItem> {
    const clean = targetName;
    const folder = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
    const base = baseName(clean);
    const folderId = await provider.ensureFolder(folder);
    for (let attempt = 1; attempt < 100; attempt++) {
      const candidate = attempt === 1 ? base : `${base} (${attempt})`;
      try {
        return await provider.move(itemId, folderId, { newName: fileName(candidate), conflictBehavior: "fail" });
      } catch (e) {
        const status = (e as { status?: number })?.status;
        if (status === 409 || status === 412) continue;
        throw e;
      }
    }
    return await provider.move(itemId, folderId, { newName: fileName(`${base} [${now()}]`), conflictBehavior: "fail" });
  }

  async function purge(itemId: string): Promise<void> {
    await provider.delete(itemId);
  }

  // weak-override（ADR-0009 / share-file-model）：用本地覆盖云端，但**云端 loser 先 stash 进 .backup 不丢**。
  // 永不 lossy（Work 禁 hard-override / destructive pull；这是 never-lose 的覆盖）。返 { item, backedUp }。
  async function weakOverride(name: string, bytes: Bytes): Promise<WeakOverrideResult> {
    const path = fileName(name);
    const cur = await provider.getItemByPath(path);
    let backedUp = null;
    if (cur) {
      const folderId = await provider.ensureFolder(backupFolder);
      const stamped = stampedName(name);   // ts-counter 防同名多次备份撞（旧版同 ms 会 fail 抛错）
      await provider.move(cur.id, folderId, { newName: stamped, conflictBehavior: "fail" });
      backedUp = `${backupFolder}/${stamped}`;
    }
    // 原 path 现已空 → force-push 本地（无 If-Match）。
    let item: CloudItem | null = await provider.upload(path, bytes, { contentType, conflictBehavior: "replace" });
    if (!item || !item.eTag) { const f = await provider.getItemByPath(path).catch(() => null); if (f && f.eTag) item = f; }
    if (item && item.eTag) { setETag(name, item.eTag); setDirty(name, false); }
    return { item, backedUp };
  }

  // ---- gallery 列表 / rename / 硬删（扩展名 agnostic：match/toName 注入）----
  // folders 非 null 时顺带收集子文件夹路径（含空文件夹）——gallery 文件夹模型「云端真文件夹为准」用。
  // 一次 walk 同时拿文件+文件夹（listAll），省一半 Graph 往返。list() 传 folders=null，语义不变。
  async function _walk(subpath: string, out: CloudItem[], depth: number, folders: string[] | null): Promise<void> {
    if (depth > 8) return;
    let items: CloudItem[];
    try { items = await provider.list(subpath); } catch (_) { return; }
    for (const it of items) {
      // 顶层 .trash / .backup 都是隐藏安全网：整个跳过（不进文件列表、不进文件夹列表、不递归其内容）。
      // 旧版只把 .backup 排出 folders 却仍递归进去 → 备份文件会漏进 gallery 文件列表（与 .trash 不一致的 bug）。
      if (depth === 0 && it.isFolder && (it.name === trashFolder || it.name === backupFolder)) continue;
      const itPath = subpath ? `${subpath}/${it.name}` : it.name;
      if (it.isFolder) {
        if (folders) folders.push(itPath);
        await _walk(itPath, out, depth + 1, folders);
      }
      else if (match(it)) out.push({ ...it, path: itPath, name: toName(itPath) });
    }
  }
  async function list(): Promise<CloudItem[]> { const out: CloudItem[] = []; await _walk("", out, 0, null); return out; }
  // gallery 一次取齐：{ files, folders }（folders 含空文件夹）。文件夹模型单一真相源。
  async function listAll(): Promise<{ files: CloudItem[]; folders: string[] }> { const out: CloudItem[] = [], folders: string[] = []; await _walk("", out, 0, folders); return { files: out, folders }; }
  async function listFolders(): Promise<string[]> { const out: CloudItem[] = [], folders: string[] = []; await _walk("", out, 0, folders); return folders; }

  async function listTrash(): Promise<CloudItem[]> {
    let items: CloudItem[];
    try { items = await provider.list(trashFolder); } catch (_) { return []; }
    return items.filter(match);
  }

  // 同 folder → rename；跨 folder → ensureFolder + move。caller 保证 newName 不冲突。
  async function rename(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    const item = await provider.getItemByPath(fileName(oldName));
    if (!item) throw new Error(`云端找不到：${oldName}`);
    const oldFolder = oldName.includes("/") ? oldName.slice(0, oldName.lastIndexOf("/")) : "";
    const newFolder = newName.includes("/") ? newName.slice(0, newName.lastIndexOf("/")) : "";
    const newBase = fileName(newName.includes("/") ? newName.slice(newName.lastIndexOf("/") + 1) : newName);
    if (oldFolder === newFolder) {
      await provider.rename(item.id, newBase);
    } else {
      const targetId = newFolder ? await provider.ensureFolder(newFolder) : await provider.getApprootId();
      await provider.move(item.id, targetId, { newName: newBase, conflictBehavior: "fail" });
    }
    const e = getETag(oldName); if (e) setETag(newName, e);
    clearState(oldName);
  }

  // 硬删（gallery「彻底删」非 trash 路径用；日常删走 store.flow.delete=trash）。
  async function remove(name: string): Promise<void> {
    const item = await provider.getItemByPath(fileName(name));
    if (item) await provider.delete(item.id);
    clearState(name);
  }

  // 注：CloudConflictError 仅作为顶层 export class 暴露（无实例消费 cloud.CloudConflictError），
  //   故不挂在返回对象上——保持返回面与 CloudSync 契约一致（annotate :CloudSync 不报 excess）。
  return {
    push, pull, fetchMeta, weakOverride,
    trash, restore, purge,
    list, listAll, listFolders, listTrash, rename, remove,
    getETag, setETag, isDirty, setDirty, clearState,
  };
}
