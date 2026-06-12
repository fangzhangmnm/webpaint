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
  /** 加密容器的云端命名（ADR-0012：加密文件外部扩展名 = .zip，防软件按 .ora/.txt 误认；
   *  容器本来就是标准 zip，名实相符）。不配置 = 扩展名翻转关（兄弟 app 未接加密时零影响）。 */
  encFileName?: (name: string) => string;
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
  const { provider, kv, fileName, encFileName = null, contentType = "application/octet-stream",
    trashFolder = ".trash", backupFolder = ".backup", appKey = "sync" } = cfg;
  const now = cfg.now || (() => Date.now());

  // name → 云端实际 item（同一 name 在任一时刻只住一个扩展名下；明文路径先试 = 多数命中 1 RTT）。
  // 找不到时返回明文路径（新建落明文名；加密字节的新建在 push 里按字节选 enc 路径）。
  async function _find(name: string): Promise<{ item: CloudItem | null; path: string; enc: boolean }> {
    const p = fileName(name);
    let item = await provider.getItemByPath(p);
    if (item) return { item, path: p, enc: false };
    if (encFileName) {
      const pe = encFileName(name);
      item = await provider.getItemByPath(pe);
      if (item) return { item, path: pe, enc: true };
    }
    return { item: null, path: p, enc: false };
  }
  // match(item)：哪些云端文件算"session"（扩展名 agnostic；默认所有非文件夹）。gallery 列表用。
  const match = cfg.match || ((it: CloudItem) => !it.isFolder);
  // toName(item)：云端文件名 → session name（fileName 的逆；默认去最后一段扩展名）。
  const toName = cfg.toName || ((name: string) => name.replace(/\.[^./]+$/, ""));

  const etagKey = (n: string) => `${appKey}.etag:${n}`;
  const dirtyKey = (n: string) => `${appKey}.dirty:${n}`;
  const baseName = (n: string) => (n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n);
  // move-aside（.trash/.backup）的防撞名：<base> [<yyyymmddhhmmss>-<guid>]（命名策略在深模块 move-aside.js）。
  // guid 防同名多次 move-aside 撞（旧版 [ts] 同 ms → conflictBehavior:"fail" 抛错的真 bug）。trash/backup 共用。
  const stampedName = (n: string, enc = false) =>
    (enc && encFileName ? encFileName : fileName)(`${baseName(n)} [${asideStamp(now())}]`);

  function getETag(name: string): string | null { return kv.get(etagKey(name)) || null; }
  function setETag(name: string, eTag: string | null): void { if (eTag) kv.set(etagKey(name), eTag); else kv.remove(etagKey(name)); }
  // dirty per-tab 化（R2/K11，审计 2026-06-10）：本实例（=本 tab）对 dirty 的观点住内存，kv 只做
  //   持久兜底（reload/强退后重推靠它）。旧版纯共享 kv：tab A push 成功清共享 flag = 把 tab B 的
  //   未推编辑宣布干净 → B 的 refresh 判 clean → 快进无留底覆盖 B 字节。现在 A 清的是自己的内存+kv，
  //   B 内存里的 true 还在 → B 的 gate 仍挡。已知残留（user 2026-06-10 接受）：B 重载后内存丢、
  //   回退到被 A 清过的 kv——多 tab 同画本就不支持（IDB 层互踩），残留窗口需四连巧合。
  const _dirtyMem = new Map<string, boolean>();
  function isDirty(name: string): boolean {
    if (_dirtyMem.has(name)) return _dirtyMem.get(name)!;
    const v = kv.get(dirtyKey(name)); return v === null ? true : v === "1";
  }
  function setDirty(name: string, dirty: boolean): void { _dirtyMem.set(name, dirty); kv.set(dirtyKey(name), dirty ? "1" : "0"); }
  function clearState(name: string): void { _dirtyMem.delete(name); kv.remove(etagKey(name)); kv.remove(dirtyKey(name)); }

  async function push(name: string, bytes: Bytes | Blob, opts: { baseEtag?: string | null; encrypted?: boolean } = {}): Promise<PushResult> {
    // 目标扩展名按**字节内容**走（caller——store——按尾部探测传 encrypted；加密=容器=.zip 名实相符）。
    const enc = !!(encFileName && opts.encrypted);
    const path = enc ? encFileName!(name) : fileName(name);
    let baseEtag = ("baseEtag" in opts) ? opts.baseEtag : getETag(name);
    // 扩展名翻转（encrypt/decrypt 后的首推）：基准版本住在另一个扩展名下 →
    //   先 If-Match **rename** 翻过来（412 守卫不破），再对返回的新 etag 做内容上传。
    //   rename 是 metadata PATCH → etag 必变（S1），所以 If-Match 链要接力到 renamed.eTag。
    if (encFileName && baseEtag) {
      const otherPath = enc ? fileName(name) : encFileName!(name);
      const target = await provider.getItemByPath(path).catch(() => null);
      if (!target) {
        const other = await provider.getItemByPath(otherPath).catch(() => null);
        if (other) {
          if (other.eTag !== baseEtag) throw new CloudConflictError(`云端已有更新版本 "${name}"`, name);
          const newBase = baseName(path);
          const renamed = await provider.rename(other.id, newBase, baseEtag);   // If-Match 守卫的翻转
          baseEtag = renamed.eTag;
        }
      }
    }
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

  // **纯读**（R1 根治，审计 2026-06-10）：pull 只取字节+item，**绝不**写 etag/dirty。
  //   采纳（setETag/setDirty(false)）由 caller 在**字节真正落地成功后**显式提交——旧版 pull 先污染 kv
  //   再交字节，heal 失败/落盘前强退都会留下「kv 指新版、本地是旧字节」→ 下次 push If-Match 通过 =
  //   静默覆盖云端分叉版（R1 两条 trace）；branch/heal 路径还会顺手清掉用户的 dirty（K12 同根因）。
  async function pull(name: string): Promise<PullResult | null> {
    const { item } = await _find(name);
    if (!item) return null;
    const blob = await provider.download(item.id);
    return { blob, item, suggestedName: name };
  }

  async function fetchMeta(name: string): Promise<FetchMetaResult | null> {
    const { item } = await _find(name);
    if (!item) return null;
    return { etag: item.eTag, lastModified: item.lastModifiedDateTime, size: item.size, item };
  }

  // 尾部 byte-range（纯读）：peek 预览纯云端文件用。store.getTailBytes 的云端腿。
  async function pullTail(name: string, n: number): Promise<{ bytes: Uint8Array; item: CloudItem } | null> {
    const { item } = await _find(name);
    if (!item) return null;
    const offset = Math.max(0, (item.size || 0) - n);
    const raw = await provider.downloadRange(item.id, offset, Math.min(n, item.size || n));
    const bytes = raw instanceof Uint8Array ? raw
      : raw instanceof ArrayBuffer ? new Uint8Array(raw)
      : new Uint8Array(await (raw as Blob).arrayBuffer());
    return { bytes, item };
  }

  // move-aside：原文件 → ensureFolder(.trash) → move，**始终加 [ts] 后缀**（多次删同名永不冲突）。
  async function trash(name: string): Promise<CloudItem | null> {
    const { item, enc } = await _find(name);
    if (!item) { clearState(name); return null; }
    const folderId = await provider.ensureFolder(trashFolder);
    const stamped = stampedName(name, enc);   // basename + ts-counter（trash 内丢 folder context；防同名撞）；保留加密扩展名
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
  async function weakOverride(name: string, bytes: Bytes, opts: { encrypted?: boolean } = {}): Promise<WeakOverrideResult> {
    const path = (encFileName && opts.encrypted) ? encFileName(name) : fileName(name);
    const cur = await _find(name);
    let backedUp = null;
    if (cur.item) {
      const folderId = await provider.ensureFolder(backupFolder);
      const stamped = stampedName(name, cur.enc);   // ts-counter 防同名多次备份撞（旧版同 ms 会 fail 抛错）；loser 保留其扩展名
      await provider.move(cur.item.id, folderId, { newName: stamped, conflictBehavior: "fail" });
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
  // status.partial：任一子树 provider.list 抛错被吞 → 这次 walk **不完整**（返回的 files 缺了那棵子树）。
  //   cloud-gone reconciliation 的命门：partial 列表里「缺失」≠「云端真没了」，绝不能据此 drop 本地缓存
  //   （否则一个子文件夹列举失败 = 误删一整棵子树的本地缓存）。listAll 据此返 complete 标志。
  async function _walk(subpath: string, out: CloudItem[], depth: number, folders: string[] | null, status: { partial: boolean }): Promise<void> {
    if (depth > 8) return;
    let items: CloudItem[];
    try { items = await provider.list(subpath); } catch (_) { status.partial = true; return; }
    for (const it of items) {
      // 顶层 .trash / .backup 都是隐藏安全网：整个跳过（不进文件列表、不进文件夹列表、不递归其内容）。
      // 旧版只把 .backup 排出 folders 却仍递归进去 → 备份文件会漏进 gallery 文件列表（与 .trash 不一致的 bug）。
      if (depth === 0 && it.isFolder && (it.name === trashFolder || it.name === backupFolder)) continue;
      const itPath = subpath ? `${subpath}/${it.name}` : it.name;
      if (it.isFolder) {
        if (folders) folders.push(itPath);
        await _walk(itPath, out, depth + 1, folders, status);
      }
      else if (match(it)) out.push({ ...it, path: itPath, name: toName(itPath) });
    }
  }
  async function list(): Promise<CloudItem[]> { const out: CloudItem[] = []; await _walk("", out, 0, null, { partial: false }); return out; }
  // gallery 一次取齐：{ files, folders, complete }（folders 含空文件夹）。文件夹模型单一真相源。
  //   complete=false → 这次列举有子树失败（partial），调用方（reconcile）必须当「列表不权威」处理。
  async function listAll(): Promise<{ files: CloudItem[]; folders: string[]; complete: boolean }> {
    const out: CloudItem[] = [], folders: string[] = [], status = { partial: false };
    await _walk("", out, 0, folders, status);
    return { files: out, folders, complete: !status.partial };
  }
  async function listFolders(): Promise<string[]> { const out: CloudItem[] = [], folders: string[] = []; await _walk("", out, 0, folders, { partial: false }); return folders; }

  async function listTrash(): Promise<CloudItem[]> {
    let items: CloudItem[];
    try { items = await provider.list(trashFolder); } catch (_) { return []; }
    return items.filter(match);
  }

  // 同 folder → rename；跨 folder → ensureFolder + move。caller 保证 newName 不冲突。
  async function rename(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    const found = await _find(oldName);
    const item = found.item;
    if (!item) throw new Error(`云端找不到：${oldName}`);
    const oldFolder = oldName.includes("/") ? oldName.slice(0, oldName.lastIndexOf("/")) : "";
    const newFolder = newName.includes("/") ? newName.slice(0, newName.lastIndexOf("/")) : "";
    // 改名保留当前扩展名（加密文件改名后仍是 .zip——扩展名跟字节内容走，不跟操作走）
    const mkName = found.enc && encFileName ? encFileName : fileName;
    const newBase = mkName(newName.includes("/") ? newName.slice(newName.lastIndexOf("/") + 1) : newName);
    let moved: CloudItem | null;
    if (oldFolder === newFolder) {
      moved = await provider.rename(item.id, newBase);
    } else {
      const targetId = newFolder ? await provider.ensureFolder(newFolder) : await provider.getApprootId();
      moved = await provider.move(item.id, targetId, { newName: newBase, conflictBehavior: "fail" });
    }
    // S1 根因：OneDrive 的 rename/move 是 metadata PATCH → **etag 一定会变**。绝不把新名锚在旧 etag 上
    //   （旧 bug：setETag(new, getETag(old)) → base 永久过期 → 下次 open 必弹假「云端有新版本」）。
    //   采纳服务端返回的新 etag；只有异常 provider 返回缺 etag 才回退旧 etag 兜底。
    const newETag = (moved && moved.eTag) || getETag(oldName);
    setETag(newName, newETag);
    setDirty(newName, false);   // 刚改完名即干净——否则 isDirty 默认 true 把它当 cloud-dirty（叠加假冲突 + bypass 守卫误抛）
    clearState(oldName);
  }

  // 硬删（gallery「彻底删」非 trash 路径用；日常删走 store.flow.delete=trash）。
  async function remove(name: string): Promise<void> {
    const { item } = await _find(name);
    if (item) await provider.delete(item.id);
    clearState(name);
  }

  // ---- 空文件夹（gallery 文件夹模型：OneDrive 真文件夹为单一真相源）----
  // 新建：idempotent（已存在则复用 id，不报错）。
  async function ensureFolder(path: string): Promise<void> {
    await provider.ensureFolder(path);
  }
  // 删除：**深模块内强制「必须空」**——云端侧 list 子项，非空拒删（防级联删整棵子树；
  //   是 UI guard 之上的硬兜底，库被无头复用/UI 绕过时也挡得住）。返回 false=云端已无此夹（noop，不报错）。
  async function removeFolder(path: string): Promise<boolean> {
    const item = await provider.getItemByPath(path);
    if (!item) return false;
    if (!item.isFolder) throw new Error(`不是文件夹，拒绝删除：${path}`);
    let children: CloudItem[] = [];
    try { children = await provider.list(path); } catch (_) { children = []; }
    if (children.length) throw new Error(`文件夹非空，拒绝删除：${path}`);
    await provider.delete(item.id);
    return true;
  }

  // 注：CloudConflictError 仅作为顶层 export class 暴露（无实例消费 cloud.CloudConflictError），
  //   故不挂在返回对象上——保持返回面与 CloudSync 契约一致（annotate :CloudSync 不报 excess）。
  return {
    push, pull, fetchMeta, pullTail, weakOverride,
    trash, restore, purge,
    list, listAll, listFolders, listTrash, rename, remove,
    ensureFolder, removeFolder,
    getETag, setETag, isDirty, setDirty, clearState,
  };
}
