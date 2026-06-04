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

export class CloudConflictError extends Error {
  constructor(message, sessionName) {
    super(message);
    this.name = "CloudConflictError";
    this.sessionName = sessionName;
  }
}

/** 内存 kv（测试用；WebPaint 传 localStorage 包装）。 */
export function memKv() {
  const m = new Map();
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => m.set(k, String(v)),
    remove: (k) => m.delete(k),
  };
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
export function createCloudSync(cfg) {
  const { provider, kv, fileName, contentType = "application/octet-stream",
    trashFolder = ".trash", backupFolder = ".backup", appKey = "sync" } = cfg;
  const now = cfg.now || (() => Date.now());
  // match(item)：哪些云端文件算"session"（扩展名 agnostic；默认所有非文件夹）。gallery 列表用。
  const match = cfg.match || ((it) => !it.isFolder);
  // toName(item)：云端文件名 → session name（fileName 的逆；默认去最后一段扩展名）。
  const toName = cfg.toName || ((name) => name.replace(/\.[^./]+$/, ""));

  const etagKey = (n) => `${appKey}.etag:${n}`;
  const dirtyKey = (n) => `${appKey}.dirty:${n}`;
  const baseName = (n) => (n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n);

  function getETag(name) { return kv.get(etagKey(name)) || null; }
  function setETag(name, eTag) { if (eTag) kv.set(etagKey(name), eTag); else kv.remove(etagKey(name)); }
  function isDirty(name) { const v = kv.get(dirtyKey(name)); return v === null ? true : v === "1"; }
  function setDirty(name, dirty) { kv.set(dirtyKey(name), dirty ? "1" : "0"); }
  function clearState(name) { kv.remove(etagKey(name)); kv.remove(dirtyKey(name)); }

  async function push(name, bytes, opts = {}) {
    const path = fileName(name);
    const baseEtag = ("baseEtag" in opts) ? opts.baseEtag : getETag(name);
    try {
      let item = await provider.upload(path, bytes, { contentType, eTag: baseEtag, conflictBehavior: "replace" });
      // H7：分片末响应可能不带 item/eTag → 拉权威 etag，绝不在 null.eTag 崩、不缓存 null。
      if (!item || !item.eTag) {
        const fresh = await provider.getItemByPath(path).catch(() => null);
        if (fresh && fresh.eTag) item = fresh;
      }
      if (item && item.eTag) { setETag(name, item.eTag); setDirty(name, false); }
      return { item };
    } catch (e) {
      if (e.status === 412) throw new CloudConflictError(`云端已有更新版本 "${name}"`, name);
      throw e;
    }
  }

  // 永远 duplicate 进本地（caller 决定落地名），不覆盖既存。
  async function pull(name) {
    const item = await provider.getItemByPath(fileName(name));
    if (!item) return null;
    const blob = await provider.download(item.id);
    setETag(name, item.eTag);
    setDirty(name, false);
    return { blob, item, suggestedName: name };
  }

  async function fetchMeta(name) {
    const item = await provider.getItemByPath(fileName(name));
    if (!item) return null;
    return { etag: item.eTag, lastModified: item.lastModifiedDateTime, size: item.size, item };
  }

  // move-aside：原文件 → ensureFolder(.trash) → move，**始终加 [ts] 后缀**（多次删同名永不冲突）。
  async function trash(name) {
    const item = await provider.getItemByPath(fileName(name));
    if (!item) { clearState(name); return null; }
    const folderId = await provider.ensureFolder(trashFolder);
    const stamped = fileName(`${baseName(name)} [${now()}]`);   // basename（trash 内丢 folder context）
    const moved = await provider.move(item.id, folderId, { newName: stamped, conflictBehavior: "fail" });
    clearState(name);
    return moved;
  }

  // 从 trash 移回；conflictBehavior=fail 防覆盖目标位置同名（关键 data-loss 点）；撞名 (2)(3) 重试。
  async function restore(itemId, targetName) {
    const clean = targetName;
    const folder = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
    const base = baseName(clean);
    const folderId = await provider.ensureFolder(folder);
    for (let attempt = 1; attempt < 100; attempt++) {
      const candidate = attempt === 1 ? base : `${base} (${attempt})`;
      try {
        return await provider.move(itemId, folderId, { newName: fileName(candidate), conflictBehavior: "fail" });
      } catch (e) {
        if (e.status === 409 || e.status === 412) continue;
        throw e;
      }
    }
    return await provider.move(itemId, folderId, { newName: fileName(`${base} [${now()}]`), conflictBehavior: "fail" });
  }

  async function purge(itemId) {
    await provider.delete(itemId);
  }

  // weak-override（ADR-0009 / share-file-model）：用本地覆盖云端，但**云端 loser 先 stash 进 .backup 不丢**。
  // 永不 lossy（Work 禁 hard-override / destructive pull；这是 never-lose 的覆盖）。返 { item, backedUp }。
  async function weakOverride(name, bytes) {
    const path = fileName(name);
    const cur = await provider.getItemByPath(path);
    let backedUp = null;
    if (cur) {
      const folderId = await provider.ensureFolder(backupFolder);
      const stamped = fileName(`${baseName(name)} [${now()}]`);
      await provider.move(cur.id, folderId, { newName: stamped, conflictBehavior: "fail" });
      backedUp = `${backupFolder}/${stamped}`;
    }
    // 原 path 现已空 → force-push 本地（无 If-Match）。
    let item = await provider.upload(path, bytes, { contentType, conflictBehavior: "replace" });
    if (!item || !item.eTag) { const f = await provider.getItemByPath(path).catch(() => null); if (f && f.eTag) item = f; }
    if (item && item.eTag) { setETag(name, item.eTag); setDirty(name, false); }
    return { item, backedUp };
  }

  // ---- gallery 列表 / rename / 硬删（扩展名 agnostic：match/toName 注入）----
  async function _walk(subpath, out, depth) {
    if (depth > 8) return;
    let items;
    try { items = await provider.list(subpath); } catch (_) { return; }
    for (const it of items) {
      if (depth === 0 && it.isFolder && it.name === trashFolder) continue;  // 顶层 .trash 不进
      const itPath = subpath ? `${subpath}/${it.name}` : it.name;
      if (it.isFolder) await _walk(itPath, out, depth + 1);
      else if (match(it)) out.push({ ...it, path: itPath, name: toName(itPath) });
    }
  }
  async function list() { const out = []; await _walk("", out, 0); return out; }

  async function listTrash() {
    let items;
    try { items = await provider.list(trashFolder); } catch (_) { return []; }
    return items.filter(match);
  }

  // 同 folder → rename；跨 folder → ensureFolder + move。caller 保证 newName 不冲突。
  async function rename(oldName, newName) {
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
  async function remove(name) {
    const item = await provider.getItemByPath(fileName(name));
    if (item) await provider.delete(item.id);
    clearState(name);
  }

  return {
    push, pull, fetchMeta, weakOverride,
    trash, restore, purge,
    list, listTrash, rename, remove,
    getETag, setETag, isDirty, setDirty, clearState,
    CloudConflictError,
  };
}
