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
import { isHidden } from "./is-hidden.ts";       // 列举隐藏判定（.trash/.backup/.<appId> + 任意 dot 项）
import { reportStoreError } from "./error-handling.ts";   // 全接但分级：静默 swallow 也 funnel（不改控制流）
import type { Bytes, CloudItem, CloudProvider, CloudSync, FetchMetaResult, FolderDeleteResult, Kv, PullResult, PushResult, WeakOverrideResult } from "./types.ts";

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
// `where` = 占用是在哪一侧发现的（v417）。旧版文案硬编码"云端已有同名"，但 mode:"new" 的首存护栏
//   走的是 nameOccupied()，它**先查本地**——本地撞名照样报"云端同名"，而云端可能根本没这个文件。
//   这条假线索直接把 v417 那次排查引向了错误的方向（人去翻 OneDrive，那里干干净净）。诊断要说实话。
export type NameCollisionWhere = "local" | "cloud";
export class CloudNameCollisionError extends Error {
  sessionName: string;
  where: NameCollisionWhere;
  constructor(sessionName: string, where: NameCollisionWhere = "cloud") {
    super(where === "local"
      ? `本地已有同名「${sessionName}」（不同文件）`
      : `云端已有同名「${sessionName}」（不同文件）`);
    this.name = "CloudNameCollisionError";
    this.sessionName = sessionName;
    this.where = where;
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
  /** false = 本实例不 track dirty（setDirty/isDirty/clearState 对 dirty 键全 no-op）。
   *  files 实例用 false：文件 dirty 权威在 local-head 的 `${ns}.files.dirty:`；若 cloud-sync 也写同键，
   *  push 成功后写 "0" 会与「push 期间用户新编辑写 '1'」竞态、把未推编辑误判 clean → 被驱逐（§A 最狠红线）。
   *  collections 实例用默认 true（collection 的 dirty 权威就在 cloud-sync）。 */
  manageDirty?: boolean;
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
    trashFolder = ".trash", backupFolder = ".backup", appKey = "sync", manageDirty = true } = cfg;
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
  // toName(item)：云端文件名 → **身份**（fileName 的逆）。薄默认（身份=全名）：只去尾部一个 .zip（加密容器外扩展名，ADR-0012）。
  //   X.ora→X.ora、X.ora.zip→X.ora（新加密件）、Y.zip→Y、Y.zip.zip→Y.zip。与 encFileName「追加 .zip」互逆、无损（多扩展名不丢信息）。
  const toName = cfg.toName || ((name: string) => (name.endsWith(".zip") ? name.slice(0, -4) : name));

  const etagKey = (n: string) => `${appKey}.etag:${n}`;
  const dirtyKey = (n: string) => `${appKey}.dirty:${n}`;
  const baseName = (n: string) => (n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n);
  // move-aside（.trash/.backup）的防撞名：<base> [<yyyymmddhhmmss>-<guid>]（命名策略在深模块 move-aside.js）。
  // guid 防同名多次 move-aside 撞（旧版 [ts] 同 ms → conflictBehavior:"fail" 抛错的真 bug）。trash/backup 共用。
  // stamp 可由调用方传入：trash 走 delete.ts 给的 **deleteEventId**（两条腿共用同一个 → trash-merge 精确配对）；
  //   backup/weakOverride 没有配对需求，现生成。
  const stampedName = (n: string, enc = false, stamp = asideStamp(now())) =>
    (enc && encFileName ? encFileName : fileName)(`${baseName(n)} [${stamp}]`);

  function getETag(name: string): string | null { return kv.get(etagKey(name)) || null; }
  function setETag(name: string, eTag: string | null): void { if (eTag) kv.set(etagKey(name), eTag); else kv.remove(etagKey(name)); }
  // dirty per-tab 化（R2/K11，审计 2026-06-10）：本实例（=本 tab）对 dirty 的观点住内存，kv 只做
  //   持久兜底（reload/强退后重推靠它）。旧版纯共享 kv：tab A push 成功清共享 flag = 把 tab B 的
  //   未推编辑宣布干净 → B 的 refresh 判 clean → 快进无留底覆盖 B 字节。现在 A 清的是自己的内存+kv，
  //   B 内存里的 true 还在 → B 的 gate 仍挡。已知残留（user 2026-06-10 接受）：B 重载后内存丢、
  //   回退到被 A 清过的 kv——多 tab 同画本就不支持（IDB 层互踩），残留窗口需四连巧合。
  const _dirtyMem = new Map<string, boolean>();
  function isDirty(name: string): boolean {
    if (!manageDirty) return false;                          // files 实例：dirty 权威在 local-head，本实例不表态
    if (_dirtyMem.has(name)) return _dirtyMem.get(name)!;
    const v = kv.get(dirtyKey(name)); return v === null ? true : v === "1";
  }
  function setDirty(name: string, dirty: boolean): void { if (!manageDirty) return; _dirtyMem.set(name, dirty); kv.set(dirtyKey(name), dirty ? "1" : "0"); }
  function clearState(name: string): void { _dirtyMem.delete(name); kv.remove(etagKey(name)); if (manageDirty) kv.remove(dirtyKey(name)); }

  // N6（审计 2026-06-09，全场唯一静默丢失路径）：lost-response/409 认领云端 item 为「我方成功 push」前，
  //   size 相等还要**尾部字节相等**才认。zip/ora 尾 = central directory + 每条 CRC32 + EOCD ≈ 内容指纹；
  //   只在罕见认领窗口对**单个在推文件**拉一次小 byte-range（不是图库遍历）。拉尾失败 = 保守不认（宁可重试，
  //   也绝不把同名同大小异内容文件静默认作我方 push → 本地字节永不丢）。
  const _ADOPT_TAIL_N = 8192;
  function _bytesEq(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  async function _localTail(b: Bytes | Blob, size: number, n: number): Promise<Uint8Array> {
    const start = Math.max(0, size - n);
    if (b instanceof Blob) return new Uint8Array(await b.slice(start, size).arrayBuffer());
    return (b as Uint8Array).slice(start, size);
  }
  //   三态：match=尾符（确认我方）、differ=尾异（确认别人文件）、unknown=拉尾失败（保守：不认也不误判 collision，保持 dirty 重试）。
  async function _confirmOurUpload(fresh: CloudItem, localBytes: Bytes | Blob, size: number): Promise<"match" | "differ" | "unknown"> {
    if (size <= 0) return "differ";                                      // 空字节不认（0 字节占位防线）
    try {
      const n = Math.min(_ADOPT_TAIL_N, size);
      const offset = Math.max(0, (fresh.size || size) - n);
      const raw = await provider.downloadRange(fresh.id, offset, n);
      const cloudTail = raw instanceof Uint8Array ? raw
        : raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer())
        : new Uint8Array(raw);
      return _bytesEq(await _localTail(localBytes, size, n), cloudTail) ? "match" : "differ";
    } catch (e) { reportStoreError(e, "log"); return "unknown"; }        // 拉尾失败 → 未知，保持 dirty 下次重试（不静默认领、也不误报 collision）
  }

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
      const target = await provider.getItemByPath(path).catch((e) => { reportStoreError(e, "log"); return null; });
      if (!target) {
        const other = await provider.getItemByPath(otherPath).catch((e) => { reportStoreError(e, "log"); return null; });
        if (other) {
          if (other.eTag !== baseEtag) throw new CloudConflictError(`云端已有更新版本 "${name}"`, name);
          const newBase = baseName(path);
          const renamed = await provider.rename(other.id, newBase, baseEtag);   // If-Match 守卫的翻转
          baseEtag = renamed.eTag;
        }
      }
    }
    // bytes 是 Uint8Array（Bytes），byteLength 即字节数；?? size/length 是历史兼容兜底（任意来源），故收窄成 any 读。
    const wrote = (bytes && ((bytes as { byteLength?: number; size?: number; length?: number }).byteLength ?? (bytes as { byteLength?: number; size?: number; length?: number }).size ?? (bytes as { byteLength?: number; size?: number; length?: number }).length)) || 0;
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
      const fresh = await provider.getItemByPath(path).catch((e) => { reportStoreError(e, "log"); return null; });
      // N6：size 相等还要**尾部字节相等**才认作我方成功 push（防同名同大小异内容文件被静默认领=丢失）。
      const verdict = fresh && fresh.eTag && fresh.size === wrote ? await _confirmOurUpload(fresh, bytes, wrote) : null;
      if (verdict === "match") item = fresh;                            // size + 尾都符 → 确认我方 push
      else if (!baseEtag && fresh && fresh.size > 0 && verdict !== "unknown") {
        // 云端已有同名、非空，且（大小不符 **或** 大小相同但尾部异内容）= 别人的同名异文件 → 绝不覆盖。
        //   保持 dirty，抛 collision 让 caller 提示改名（本地字节不丢）。unknown（拉尾失败）不在此列——见下。
        throw new CloudNameCollisionError(name);
      } else { item = null; }   // 0 字节占位 / 有 base 未确认 / unknown 拉尾失败 → 保持 dirty，下次重试
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

  // 任意绝对偏移 byte-range（纯读）：getPeek 解 zip 时，CD / 目标 entry 溢出尾片就用它二次拉。
  //   offset/length 对 item.size 钳边；空区间直接返空（不打网络）。
  async function pullRange(name: string, offset: number, length: number): Promise<{ bytes: Uint8Array; item: CloudItem } | null> {
    const { item } = await _find(name);
    if (!item) return null;
    const size = item.size || 0;
    const off = Math.max(0, Math.min(offset, size));
    const len = Math.max(0, Math.min(length, size - off));
    if (len === 0) return { bytes: new Uint8Array(0), item };
    const raw = await provider.downloadRange(item.id, off, len);
    const bytes = raw instanceof Uint8Array ? raw
      : raw instanceof ArrayBuffer ? new Uint8Array(raw)
      : new Uint8Array(await (raw as Blob).arrayBuffer());
    return { bytes, item };
  }

  // move-aside：原文件 → ensureFolder(.trash) → move，**始终加 [ts] 后缀**（多次删同名永不冲突）。
  // deleteEventId：由 delete.ts 生成、**两条腿共用**，嵌进 trash 名里 → trash-merge 据此精确配对。
  //   必填不给默认：可选参数等于给未来留了"两端各生成"的口子，而那正是本次要修掉的 bug。
  //   opts.baseEtag：**delete-vs-edit 的 edit-wins 由这里强制**（v435）。delete.ts 之前只做「读比对」——
  //     fetchMeta 的 etag 对上了就搬，而搬这个动作本身不带 If-Match，中间隔着 _find + ensureFolder 两次往返。
  //     别设备在这个窗口推新版 → 比对已通过 → 新字节被搬进 .trash。现在 412 会把它变成 conflict-edit-wins。
  //     不传时退回 item.eTag（仍闭合 _find→move 的窗口，比裸奔强）。
  async function trash(name: string, deleteEventId: string, opts: { baseEtag?: string | null } = {}): Promise<CloudItem | null> {
    const { item, enc } = await _find(name);
    if (!item) { clearState(name); return null; }
    const folderId = await provider.ensureFolder(trashFolder);
    const stamped = stampedName(name, enc, deleteEventId);   // basename + deleteEventId（trash 内丢 folder context；防同名撞）；保留加密扩展名
    const moved = await provider.move(item.id, folderId, { newName: stamped, conflictBehavior: "fail", eTag: opts.baseEtag ?? item.eTag });
    clearState(name);
    return moved;
  }

  // 从 trash 移回；conflictBehavior=fail 防覆盖目标位置同名（关键 data-loss 点）；撞名 (2)(3) 重试。
  //   opts.encrypted：trash 里是加密容器（.zip 尾）→ 落 encFileName（否则加密字节被恢复到明文路径、双击打不开）。
  //   opts.eTag：源 item 的 If-Match。⚠ 412 和 409 含义不同，**不能都当撞名重试**：
  //     409 = 目标位置已有同名 → 换个候选名重试（下面的循环）。
  //     412 = 回收站里那个源 item 已经变了（别设备恢复/清空了它）→ 换名重试毫无意义，直接抛。
  async function restore(itemId: string, targetName: string, opts: { encrypted?: boolean; eTag?: string | null } = {}): Promise<CloudItem> {
    const clean = targetName;
    const folder = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
    const base = baseName(clean);
    const mkName = opts.encrypted && encFileName ? encFileName : fileName;   // 加密件恢复保留 .zip 容器扩展名
    const folderId = await provider.ensureFolder(folder);
    for (let attempt = 1; attempt < 100; attempt++) {
      const candidate = attempt === 1 ? base : `${base} (${attempt})`;
      try {
        return await provider.move(itemId, folderId, { newName: mkName(candidate), conflictBehavior: "fail", eTag: opts.eTag ?? null });
      } catch (e) {
        const status = (e as { status?: number })?.status;
        if (status === 409) continue;          // 目标撞名 → 换候选名
        throw e;                               // 412（源变了）/ 其它 → 抛，别拿换名去掩盖
      }
    }
    return await provider.move(itemId, folderId, { newName: mkName(`${base} [${now()}]`), conflictBehavior: "fail", eTag: opts.eTag ?? null });
  }

  //   eTag：硬删是不可逆的，必须 If-Match（v435）。窄 TOCTOU 但后果最重：别设备在 list 与 delete 之间
  //   把这项从 .trash 恢复出去 → 我方按 id 硬删掉那个**已经活过来的**文件。调用方手上本来就有 it.eTag。
  async function purge(itemId: string, eTag?: string | null): Promise<void> {
    await provider.delete(itemId, eTag ?? undefined);
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
      // If-Match（v435）：_find 与本次 move 之间别设备可能又推了一版。没有它就会把「用户从没见过的
      //   那一版」当作 loser 搬进 .backup（不丢，但错位）。412 → 抛，让上层重新 surface。
      await provider.move(cur.item.id, folderId, { newName: stamped, conflictBehavior: "fail", eTag: cur.item.eTag });
      backedUp = `${backupFolder}/${stamped}`;
    }
    // 原 path 现已空 → force-push 本地（无 If-Match）。
    let item: CloudItem | null = await provider.upload(path, bytes, { contentType, conflictBehavior: "replace" });
    if (!item || !item.eTag) { const f = await provider.getItemByPath(path).catch((e) => { reportStoreError(e, "log"); return null; }); if (f && f.eTag) item = f; }
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
    try { items = await provider.list(subpath); } catch (e) { reportStoreError(e, "log"); status.partial = true; return; }
    for (const it of items) {
      // 隐藏项（末段以 "." 开头）整个跳过：.trash / .backup / .<appId>(collections/settings) 安全网夹 +
      //   任意 dotfile/dotfolder，都不进文件列表、不进文件夹列表、不递归其内容（isHidden 深模块唯一真相）。
      if (isHidden(it.name)) continue;
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

  // 单夹列举（**非递归**，一次 provider.list）——watchFolder / reconcileFolder 用；替代「listAll 全树 walk 后客户端切一夹」的浪费。
  //   complete=false ⟸ 这一夹 list() 抛错（离线/未登录/子树失败）→ 调用方当「不权威」，绝不据此判 cloud-gone（同 _walk partial 纪律）。
  //   顶层 .trash/.backup 同 _walk 跳过（path==="" 时）。folders = immediate 子夹全路径。
  async function listFolder(path: string): Promise<{ files: CloudItem[]; folders: string[]; complete: boolean }> {
    let items: CloudItem[];
    try { items = await provider.list(path); } catch (e) { reportStoreError(e, "log"); return { files: [], folders: [], complete: false }; }
    const files: CloudItem[] = [], folders: string[] = [];
    for (const it of items) {
      if (isHidden(it.name)) continue;   // 隐藏项（.trash/.backup/.<appId>/任意 dot）不进列举——isHidden 深模块
      const itPath = path ? `${path}/${it.name}` : it.name;
      if (it.isFolder) folders.push(itPath);
      else if (match(it)) files.push({ ...it, path: itPath, name: toName(itPath) });
    }
    return { files, folders, complete: true };
  }

  async function listTrash(): Promise<CloudItem[]> {
    let items: CloudItem[];
    try { items = await provider.list(trashFolder); } catch (e) { reportStoreError(e, "log"); return []; }
    return items.filter(match);
  }
  // 备份箱列表（weakOverride/keepMine 的 loser 字节 stash 处）。恢复/彻底删走通用 restore(itemId)/purge(itemId)。
  async function listBackup(): Promise<CloudItem[]> {
    let items: CloudItem[];
    try { items = await provider.list(backupFolder); } catch (e) { reportStoreError(e, "log"); return []; }
    return items.filter(match);
  }

  // 同 folder → rename；跨 folder → ensureFolder + move。caller 保证 newName 不冲突。
  //   opts.baseEtag：v435 补。**同一个文件里 push 的扩展名翻转（L185 一带）早就传 eTag 了，这里却没传** ——
  //     这条自相矛盾正是「非 upload 的写整片漏掉 If-Match」这个 pattern 最直白的证据。
  //     不传时退回 item.eTag（闭合 _find→rename 的窗口）。
  async function rename(oldName: string, newName: string, opts: { baseEtag?: string | null } = {}): Promise<void> {
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
      moved = await provider.rename(item.id, newBase, opts.baseEtag ?? item.eTag);
    } else {
      const targetId = newFolder ? await provider.ensureFolder(newFolder) : await provider.getApprootId();
      moved = await provider.move(item.id, targetId, { newName: newBase, conflictBehavior: "fail", eTag: opts.baseEtag ?? item.eTag });
    }
    // S1 根因：OneDrive 的 rename/move 是 metadata PATCH → **etag 一定会变**。绝不把新名锚在旧 etag 上
    //   （旧 bug：setETag(new, getETag(old)) → base 永久过期 → 下次 open 必弹假「云端有新版本」）。
    //   采纳服务端返回的新 etag；只有异常 provider 返回缺 etag 才回退旧 etag 兜底。
    const newETag = (moved && moved.eTag) || getETag(oldName);
    setETag(newName, newETag);
    setDirty(newName, false);   // 刚改完名即干净——否则 isDirty 默认 true 把它当 cloud-dirty（叠加假冲突 + bypass 守卫误抛）
    clearState(oldName);
  }

  // remove()（活文件硬删）已删除（v435）：**零调用者**，却在 CloudSync 契约上挂着一条绕过
  //   「删除 = 移到 .trash」红线的现成通道——唯一的作用就是等着某天被人顺手用上。
  //   真要「彻底删」也应当先 trash 再 purge（两步都可审计、都可恢复到中途）。

  // ---- 空文件夹（gallery 文件夹模型：OneDrive 真文件夹为单一真相源）----
  // 新建：idempotent（已存在则复用 id，不报错）。
  async function ensureFolder(path: string): Promise<void> {
    await provider.ensureFolder(path);
  }
  // 删除：**深模块内强制「必须空」**——云端侧 list 子项，非空拒删（防级联删整棵子树；
  //   是 UI guard 之上的硬兜底，库被无头复用/UI 绕过时也挡得住）。返回 false=云端已无此夹（noop，不报错）。
  // 删空夹 = 薄委托 backend（护栏归 provider.deleteEmptyFolder：只删空夹、list 抛错=list-failed 绝不当空放行、If-Match best-effort）。
  //   返判别式 status（deleted/already-gone/non-empty/list-failed）；上层（online deleteFolder / 离线 drain）各自映射，见 create-store。
  function deleteEmptyFolder(path: string): Promise<FolderDeleteResult> {
    return provider.deleteEmptyFolder(path);
  }

  // 注：CloudConflictError 仅作为顶层 export class 暴露（无实例消费 cloud.CloudConflictError），
  //   故不挂在返回对象上——保持返回面与 CloudSync 契约一致（annotate :CloudSync 不报 excess）。
  return {
    push, pull, fetchMeta, pullTail, pullRange, weakOverride,
    trash, restore, purge,
    list, listAll, listFolder, listFolders, listTrash, listBackup, rename,
    ensureFolder, deleteEmptyFolder,
    getETag, setETag, isDirty, setDirty, clearState,
  };
}
