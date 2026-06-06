// Store —— 持久化 + 同步的深模块（施工中）。把原本散在 app.js 的同步**编排**收拢到这里，
// 对 UI 只暴露 flow 接口。红线在库内 enforce，不在 UI。见 docs/sync-store-extraction.md。
//
// Store 自己管两件 adapter：cloud（CloudProvider，经 cloud.js）+ local（IDB，store.local）。
// 仍由调用方提供的回调只剩真·doc/UI/env：
//   encode()            doc → bytes（应用领域）
//   adopt(bytes, name)  bytes → 活编辑器（应用领域）
//   getEditVersion()    应用的编辑游标（B2 用）
//   isOnline()          环境
//   UI: confirm / busy / onConflict / onNewer / onDirtyWarn
//
// 红线：B1 串行 · B2 不丢编辑 · B5 lost-response 自愈 · retry 退避 · A4/A10 备份先于覆盖 ·
//       E8 跳过离线 · H3 先存后清 · E4 离线 deferred · 三态删除不留双份 · C7 重连收敛 · H2 confirm 强制。

async function toU8(x) {
  if (x == null) return new Uint8Array(0);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (typeof x === "string") return new TextEncoder().encode(x);
  if (typeof x.arrayBuffer === "function") return new Uint8Array(await x.arrayBuffer());
  throw new Error("Store: 无法识别的 bytes 类型");
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
const passBusy = (label, fn) => fn();   // 默认 busy：直接跑

/**
 * @param {object} deps
 * @param {object} deps.cloud   cloud.js 模块
 * @param {object} [deps.local] store.local adapter（IDB）；不传则本地相关 flow 不可用
 * @param {number} [deps.maxAttempts=4]
 * @param {number} [deps.backoffMs=200]
 * @param {(ms:number)=>Promise} [deps.sleep]
 */
export function createStore({ cloud, local, kv, maxAttempts = 4, backoffMs = 200, sleep } = {}) {
  const _chain = new Map();
  const _sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  // 编辑游标（B2 + 本机合流共用的单一 SSoT）。app histchange → edits.mark()；不再各持一份 _editVersion。
  let _editVersion = 0;

  // C4：base-etag 归这个 Store 实例（= 这个 tab）的内存，open/adopt 时捕获一次。
  // push 用它当 If-Match、成功只推进**自己的**——绝不每次去读跨 tab 共享的 localStorage etag，
  // 否则别的 tab 推成功后改了共享 etag，本 tab 的陈旧推会被误判成"无冲突"→ 静默覆盖（W2 红线）。
  const _base = new Map();   // name → etag|null（null = 无基准，首推不带 If-Match）
  function adoptBase(name, etag) { _base.set(name, etag ?? null); }
  function baseFor(name) { return _base.has(name) ? _base.get(name) : cloud.getETag(name); }

  function _retriable(e) {
    return !!e && (e.status == null || e.status === 429 || (e.status >= 500 && e.status <= 599))
      && e.name !== "CloudConflictError";
  }

  // 412：可能是自己 lost-response 已落盘的写。拉云比对，相等即自愈（B5/W1）。
  async function _tryHeal(name, bytes) {
    let pulled;
    try { pulled = await cloud.pull(name); } catch (_) { return false; }
    if (!pulled) return false;
    if (bytesEqual(await toU8(pulled.blob), bytes)) {
      cloud.setDirty(name, false);
      if (pulled.item && pulled.item.eTag) _base.set(name, pulled.item.eTag);  // 自愈后 base 推进到云端版本
      return true;
    }
    return false;
  }

  function _finish(name, v0, getEditVersion, status) {
    const dirtyAfter = getEditVersion() !== v0;   // B2：PUT 期间又改过 → 仍 unpushed
    if (dirtyAfter) cloud.setDirty(name, true);
    return { status, dirtyAfter };
  }

  async function _doPush(name, { encode, getEditVersion = () => _editVersion, onConflict, adopt, saveBranch, now, busy = passBusy } = {}) {
    const v0 = getEditVersion();
    const bytes = await toU8(await encode());      // 只编码一次，重试复用（B5 逐字节比对要相等）
    return busy("正在同步…", async () => {
      let attempt = 0, lastErr;
      while (attempt < maxAttempts) {
        attempt++;
        try {
          const { item } = await cloud.push(name, bytes, { baseEtag: baseFor(name) });
          if (item && item.eTag) _base.set(name, item.eTag);   // 只推进自己的 base
          return _finish(name, v0, getEditVersion, "pushed");
        } catch (e) {
          if (e && e.name === "CloudConflictError") {
            if (await _tryHeal(name, bytes)) return _finish(name, v0, getEditVersion, "healed");
            const choice = onConflict ? await onConflict({ name }) : "keep";
            return await _resolveConflict(name, choice, { bytes, adopt, saveBranch, now });   // pull/branch/weak-override 在 Store 内执行
          }
          if (_retriable(e) && attempt < maxAttempts) { lastErr = e; await _sleep(backoffMs * attempt); continue; }
          throw e;
        }
      }
      throw lastErr;
    });
  }

  // 同一 name 串行（B1）：每次 push 等前一次跑完才启动。
  function push(name, opts) {
    const run = () => _doPush(name, opts);
    const prev = _chain.get(name) || Promise.resolve();
    const next = prev.then(run, run);
    _chain.set(name, next.then(() => {}, () => {}));
    return next;
  }

  // 安全拉取覆盖（A4/A10）：先 local.backup（失败即 abort，绝不 pull/覆盖）→ 拉云 → 覆盖本地 → adopt。
  // 持久状态只在原子点改：备份是复制（原件留着）；覆盖是一次 local.save。强退任一 await 点都可重入。
  async function _safePull(name, adopt) {
    let backupName;
    try { backupName = await local.backup(name); }
    catch (e) { return { ok: false, reason: "backup-failed", error: e }; }
    const r = await cloud.pull(name);
    if (!r) return { ok: false, reason: "cloud-vanished", backupName };
    await local.save(name, r.blob);                // 覆盖本地为云端版（原件已备份）
    if (r.item && r.item.eTag) _base.set(name, r.item.eTag);  // base 推进到云端版本（多tab/冲突后一致）
    cloud.setDirty(name, false);              // 已采纳云端 → 不再 unpushed
    if (adopt) await adopt(r.blob, name);          // 反映到活编辑器
    return { ok: true, backupName };
  }

  // 真冲突的执行（pull/branch 在 Store 内做；keep/rename 交回 app 处理身份变更）。
  // push 和 open 共用，绝不静默覆盖。
  // 给了执行回调（adopt for pull / saveBranch for branch）→ Store 内执行，返 "resolved"。
  // 没给（或 keep/rename 这类身份变更）→ 返 "conflict"+choice，交 app 处理（向后兼容旧消费代码）。
  async function _resolveConflict(name, choice, { bytes, adopt, saveBranch, now = () => 0 } = {}) {
    if (choice === "pull" && adopt) {
      const r = await _safePull(name, adopt);
      return r.ok
        ? { status: "resolved", resolution: "pull", backupName: r.backupName }
        : { status: "conflict", choice, resolution: "pull-failed", reason: r.reason, backupName: r.backupName, dirtyAfter: true };
    }
    // weak-override（Work 的 never-lose 覆盖）：云端→.backup，再 force-push 本地。需 bytes（仅 push 上下文有）。
    if (choice === "weak-override" && bytes != null && cloud.weakOverride) {
      const r = await cloud.weakOverride(name, bytes);
      if (r.item && r.item.eTag) _base.set(name, r.item.eTag);
      return { status: "resolved", resolution: "weak-override", backedUp: r.backedUp };
    }
    if (choice === "branch" && saveBranch) {
      const r = await cloud.pull(name);
      if (!r) return { status: "conflict", choice, resolution: "cloud-vanished", dirtyAfter: true };
      const branchName = `${name}-cloud-${now()}`;
      await saveBranch(r.blob, branchName);
      return { status: "resolved", resolution: "branch", branchName };
    }
    return { status: "conflict", choice, dirtyAfter: true };  // 交回 app（旧 saveAndPushViaStore 自己执行）
  }

  // C2：开 session 的云端 gate。绝不静默覆盖。E8：probe（跳过到离线）与 metadata race，无硬超时。
  async function open(name, opts = {}) {
    const { isOnline = () => true, probe, onNewer, adopt, busy = passBusy, now = () => 0 } = opts;
    if (!isOnline()) return { source: "local", reason: "offline" };
    return busy("检查云端…", async () => {
      let meta;
      if (probe) {
        const raced = await Promise.race([
          cloud.fetchMeta(name).then((m) => ({ k: "meta", m }), (e) => ({ k: "err", e })),
          Promise.resolve(probe).then(() => ({ k: "skip" })),
        ]);
        if (raced.k === "skip") return { source: "local", reason: "skipped" };
        if (raced.k === "err") return { source: "local", reason: "cloud-error" };
        meta = raced.m;
      } else {
        try { meta = await cloud.fetchMeta(name); }
        catch (_) { return { source: "local", reason: "cloud-error" }; }
      }
      if (!meta) return { source: "local", reason: "cloud-absent" };
      const base = cloud.getETag(name);
      if (!base || meta.etag === base) return { source: "local", reason: "in-sync" };
      // 云端自 base 后动过 → 弹「拉 / 留 / 分支」（onNewer 是 UI 回调；强退在此安全：尚无持久副作用）
      const choice = onNewer
        ? await onNewer({ name, cloudEtag: meta.etag, baseEtag: base, cloudTime: meta.lastModified })
        : "keep";
      if (choice === "pull") {
        const r = await _safePull(name, adopt);
        return r.ok
          ? { source: "pulled", backupName: r.backupName }
          : { source: "local", reason: r.reason, backupName: r.backupName, error: r.error };
      }
      if (choice === "branch") {
        const r = await cloud.pull(name);
        if (!r) return { source: "local", reason: "cloud-vanished" };
        const branchName = `${name}-cloud-${now()}`;
        await local.save(branchName, r.blob);
        return { source: "branched", branchName };
      }
      return { source: "local", reason: "kept" };
    });
  }

  // C3/H3（退出 = consent push、先 flush 后清）由 app 的 saveAndPush + _exitCanvasToGallery 承担：
  // 那条路有完整的冲突 UI（no-op / save-as / weak-override）+ checkpoint + 离线提示，是 flush+push 的富版本。
  // 曾有过一个 flow.close（薄 flush+push）但被 saveAndPush 取代、从无调用 → 已删（别再加回来）。

  // C5：删除 = move-aside。三态（仅本地 / 仅云端 / 两者）。两者 → 云端进 .trash + 本地直接删（不留双份）。
  async function del(name, opts = {}) {
    const { isOnline = () => true, confirm, onDirtyWarn, busy = passBusy } = opts;
    if (confirm && !(await confirm({ title: "删除", body: name, danger: true }))) return { status: "cancelled" };
    if (cloud.isDirty(name) && onDirtyWarn && !(await onDirtyWarn({ name }))) return { status: "cancelled" };

    const localPresent = local ? await local.exists(name) : false;
    if (!isOnline()) {
      // 离线：本地 move-aside + 排队云删（带 base-etag 供重连重放）。队列须持久化（C1b 接 IDB）。
      let trashKey = null;
      if (localPresent) trashKey = await local.trash(name);
      return { status: "trashed", where: "local", queuedCloudDelete: true, baseEtag: cloud.getETag(name), trashKey };
    }
    return busy("删除中…", async () => {
      let cloudPresent = false;
      try { cloudPresent = !!(await cloud.fetchMeta(name)); } catch (_) { cloudPresent = false; }
      if (cloudPresent) {
        const trashed = await cloud.trash(name);       // 先云端进 .trash（失败抛 → 本地不动）
        if (localPresent) await local.hardDelete(name);            // 再本地直接删（不留双份）
        return { status: "trashed", where: "cloud", trashed };
      }
      if (localPresent) { const trashKey = await local.trash(name); return { status: "trashed", where: "local", trashKey }; }
      return { status: "noop" };
    });
  }

  // C7：离线删除重连重放。按 base-etag 收敛；被别处改过 → delete-vs-edit 默认 edit-wins（不删）。
  // NOT-WIRED（aspirational）：flow.delete 离线时返 queuedCloudDelete，但队列尚未持久化（C1b 接 IDB），
  //   故此函数目前无调用方。保留为 C7 的唯一实现；接队列那轮再启用，别误当死码删掉。
  async function replayDelete(name, opts = {}) {
    const { baseEtag } = opts;
    let meta;
    try { meta = await cloud.fetchMeta(name); }
    catch (_) { return { status: "deferred-offline" }; }
    if (!meta) return { status: "converged", reason: "already-gone" };
    if (baseEtag && meta.etag !== baseEtag) return { status: "conflict-edit-wins" };
    return { status: "trashed", trashed: await cloud.trash(name) };
  }

  // 从 trash 恢复：本地先恢复（撞名自动 (2)，拿到实际落名）→ 云端按同一名恢复（撞名自动 (2)，cloud.js 已实现）。
  // 两端都可有可无（local-only / cloud-only / both 一条路）。返回实际恢复的 name。
  async function restore(opts = {}) {
    const { fromCloud, cloudItemId, targetName, trashKey, busy = passBusy } = opts;
    return busy("恢复中…", async () => {
      let name = targetName || null, restoredLocal = false, restoredCloud = false;
      if (trashKey && local) { const n = await local.restore(trashKey); if (n) { name = n; restoredLocal = true; } }
      if (fromCloud && cloudItemId != null) { await cloud.restore(cloudItemId, name || targetName); restoredCloud = true; }
      if (!restoredLocal && !restoredCloud) return { status: "noop" };
      return { status: "restored", name, local: restoredLocal, cloud: restoredCloud };
    });
  }

  // 永久删（不可恢复）→ 强制 danger confirm（H2）。两端都可有可无（trashKey 本地 / cloudItemId 云端）。
  async function purge(opts = {}) {
    const { trashKey, cloudItemId, confirm, busy = passBusy } = opts;
    if (confirm && !(await confirm({ title: "彻底删除", body: "不可恢复", danger: true }))) return { status: "cancelled" };
    return busy("彻底删除…", async () => {
      if (trashKey && local && local.purgeTrash) await local.purgeTrash(trashKey);
      if (cloudItemId != null) await cloud.purge(cloudItemId);
      return { status: "purged" };
    });
  }

  // 清空回收站（批量彻底删）：本地 + 云端两端在库内一处清，逐项独立 try、失败汇总不静默。
  // 不按 GUID 配对 local↔cloud——两端都要清空，配对无意义（≠ restore）。
  // 离线（isOnline()=false）→ 这次只清本地、云端清不了；要清云端得回线后用户**再点一次**清空。
  // **强退 = cancel（一次性操作，绝不持久化 / 不自动续）**：中途强退 = 已删的永久没了（彻底删本不可逆）、
  //   没删的留在 trash；要清剩的得用户**手动再点**清空（针对那时 trash 的现状）。
  //   ⚠ 别做成「自动续上次未完成的清空」——下次 trash 可能已有新 item，自动续会连新 item 一起删 = 灾难。
  // 云端 bounded 并发（默 5，每项仍独立原子），避免大量文件串行太慢。
  async function emptyTrash(opts = {}) {
    const { isOnline, busy = passBusy, concurrency = 5 } = opts;
    return busy("清空回收站…", async () => {
      let purged = 0; const failed = [];
      if (local && local.listTrash && local.purgeTrash) {
        for (const t of await local.listTrash()) {            // 本地 IDB 删很快，串行即可
          try { await local.purgeTrash(t.trashKey); purged++; }
          catch (e) { failed.push({ name: t.name, where: "local", error: String(e && e.message || e) }); }
        }
      }
      if (!isOnline || isOnline()) {
        let items = null;
        try { items = await cloud.listTrash(); }
        catch (e) { failed.push({ where: "cloud-list", error: String(e && e.message || e) }); }
        items = items || [];
        for (let i = 0; i < items.length; i += concurrency) {  // bounded 并发（~5），快约 N×
          await Promise.all(items.slice(i, i + concurrency).map(async (it) => {
            try { await cloud.purge(it.id); purged++; }
            catch (e) { failed.push({ name: it.name, where: "cloud", error: String(e && e.message || e) }); }
          }));
        }
      }
      return { status: "emptied", purged, failed };
    });
  }

  // 在 oldName + newName 两条链尾串行跑 fn（重命名牵动两个身份，须挡住对任一名的 in-flight push）。
  function _serialize2(oldName, newName, fn) {
    const prev = Promise.all([_chain.get(oldName) || Promise.resolve(), _chain.get(newName) || Promise.resolve()]);
    const next = prev.then(fn, fn);
    const tail = next.then(() => {}, () => {});
    _chain.set(oldName, tail); _chain.set(newName, tail);
    return next;
  }

  // 身份变更：重命名一个**具名文件**（active Work 或图库里没打开的 item，统一一条路）。
  // 字节来源：active 传 encode（活 doc）；图库非活动不传 encode → 库内从 local.get(old) 取既存字节，不重编码。
  // 本地先存新名再删旧名（phantom-path 红线：绝不先删）。
  // 云端：synced（无未推编辑）或纯云端无本地字节 → 服务端 move 保 etag、不重传字节；
  //       dirty 且有本地字节 → push 当前字节到新名 + 旧名进 .trash（非 hard-delete）。
  // 串行 against 两个 name 的 in-flight push。app 只负责取名 + UI；机制全在库内。
  async function rename(oldName, newName, opts = {}) {
    const { encode, getEditVersion, cloud: doCloud = true, busy = passBusy } = opts;
    if (!oldName || !newName || oldName === newName) return { status: "noop" };
    // 非 active 改名（无 encode）不该被活 doc 的编辑游标污染 dirtyAfter → 用冻结游标。
    const gev = encode ? (getEditVersion || (() => _editVersion)) : () => 0;
    return _serialize2(oldName, newName, () => busy("重命名…", async () => {
      const hasLocal = local ? await local.exists(oldName) : false;
      let bytes = null;
      if (encode) bytes = await toU8(await encode());
      else if (hasLocal) bytes = await toU8(await local.get(oldName));

      if (local && hasLocal) {
        await local.save(newName, bytes);                              // 先存新名（含当前字节）
        await local.hardDelete(oldName);                              // 成功后才删旧名
      }
      if (!doCloud) { _base.delete(oldName); return { status: "renamed", where: "local", newName }; }
      // 云端 best-effort：本地改名已落地，绝不因云端失败回滚。失败 → 标新名脏，下次 push 续（与旧 app 行为一致）。
      try {
        let cloudOld = null;
        try { cloudOld = await cloud.fetchMeta(oldName); } catch (_) { cloudOld = null; }
        // synced，或没有本地字节可推（纯云端 item）→ 服务端 move，etag 顺延（cloud.rename 内 setETag(new)+clearState(old)）。
        if (cloudOld && (!cloud.isDirty(oldName) || bytes == null)) {
          await cloud.rename(oldName, newName);
          _base.set(newName, cloud.getETag(newName)); _base.delete(oldName);
          return { status: "renamed", where: "cloud-move", newName };
        }
        if (bytes == null) { _base.delete(oldName); return { status: "renamed", where: "local", newName }; }
        const res = await _doPush(newName, { encode: () => bytes, getEditVersion: gev, busy });  // dirty / 无旧云文件 → 推当前字节（含 B5/retry/conflict）
        if (cloudOld) { try { await cloud.trash(oldName); } catch (_) {} }  // 旧名进 .trash，不 hard-delete（C5）
        _base.delete(oldName);
        return { status: "renamed", where: cloudOld ? "cloud-push+trash" : "cloud-push", newName, push: res };
      } catch (e) {
        cloud.setDirty(newName, true); _base.delete(oldName);
        return { status: "renamed", where: "local", newName, cloudDeferred: true, error: e };
      }
    }));
  }

  // 另存为：写新身份，旧的不动（Photoshop 语义，调用方完成后切到新名）。
  async function saveAs(newName, opts = {}) {
    const { encode, getEditVersion = () => _editVersion, cloud: doCloud = true, busy = passBusy } = opts;
    const run = async () => {
      const bytes = await toU8(await encode());
      if (local) await local.save(newName, bytes);
      if (!doCloud) return { status: "saved", where: "local", newName };
      try {
        const res = await _doPush(newName, { encode: () => bytes, getEditVersion, busy });
        return { status: "saved", where: "cloud", newName, push: res };
      } catch (e) {
        cloud.setDirty(newName, true);                                 // 云端没成 → 标脏，下次 Ctrl+S 续；本地已存
        return { status: "saved", where: "local", newName, cloudDeferred: true, error: e };
      }
    };
    const prev = _chain.get(newName) || Promise.resolve();
    const next = prev.then(run, run);
    _chain.set(newName, next.then(() => {}, () => {}));
    return next;
  }

  // 首取：云端 item → 本地（gallery「拉取到本地」，无冲突——本地本来没有）。localName 由 app 去重后传入。
  async function acquire(cloudName, opts = {}) {
    const { localName = cloudName, adopt, busy = passBusy } = opts;
    return busy("拉取中…", async () => {
      const r = await cloud.pull(cloudName);
      if (!r) return { status: "absent" };
      if (local) await local.save(localName, r.blob);
      if (r.item && r.item.eTag) {
        _base.set(localName, r.item.eTag);
        if (localName !== cloudName) { cloud.setETag(localName, r.item.eTag); cloud.setDirty(localName, false); }
      }
      if (adopt) await adopt(r.blob, localName);
      return { status: "acquired", localName, item: r.item };
    });
  }

  // ---- state-as-store（①）：app 不再直碰 localStorage，全走这些 typed 接口 ----
  // 云端同步态（dirty/etag/status）。status 直接喂 save 按钮 icon（local-only vs synced vs dirty）。
  const cloudState = {
    isDirty: (name) => cloud.isDirty(name),
    getETag: (name) => cloud.getETag(name),
    setDirty: (name, d) => cloud.setDirty(name, d),
    // signedIn/hasLocal 是 app context（auth/本地存在），调用方传入；同步返回，给 UI 高频查。
    status: (name, { signedIn = true, hasLocal = true } = {}) => {
      if (!hasLocal) return cloud.getETag(name) ? "cloud-only" : "absent";
      if (!signedIn) return "local-only";
      return cloud.isDirty(name) ? "dirty" : "synced";
    },
  };
  // 通用 app 设置（主题/笔刷尺寸/面板位置…）。app 丢掉自己的 localStorage 调用。
  const settings = {
    get: (k) => (kv ? kv.get(`settings:${k}`) : null),
    set: (k, v) => { if (kv) kv.set(`settings:${k}`, v); },
    remove: (k) => { if (kv) kv.remove(`settings:${k}`); },
  };
  // 活动 item 指针：WebPaint 用 session.js 的 webpaint.currentSessionName（含 boot-load 失败时的
  // phantom-path 保护）。曾在此放过一个 store.active（kv "active:pointer"），与之并存只会双源失同步、
  // 从无调用 → 已删。将来真要 app-agnostic 化，应迁到 session.js 那个键、而非另起炉灶。

  // ---- 编辑游标（④）：单一 SSoT。B2（_doPush）、本机合流（session）、本地落盘 dirty 共用同一游标。
  //   mark()        内容变了（任何 wp:histchange 或会进 .ora 的状态变更）→ 推进游标。
  //   markSaved()   本地落盘点：记下「已存进 IDB 的游标」。
  //   localDirty()  本地未落盘？= 游标自上次 markSaved 后又动过（取代 app 散落的 _docDirty 标志）。
  // cloud 未推是另一正交事实，走 cloud.isDirty（per-file、跨 reload 持久）；二者别混。
  let _savedVersion = 0;
  const edits = {
    mark: () => { _editVersion++; },
    version: () => _editVersion,
    markSaved: (v) => { _savedVersion = (v == null) ? _editVersion : v; },
    localDirty: () => _editVersion !== _savedVersion,
  };

  // ---- save 合流（④ coalescer）：连按 Ctrl+S/点保存不串 N 次。app 注入真·保存动作（configure）。
  //   - 没在跑 → 立刻跑
  //   - 在跑 + 期间没新编辑 + 同类型 → no-op（state 没变，省一次空转）
  //   - 在跑 + 期间有新编辑 → queue 尾巴，in-flight 完成后跑
  //   - 在跑 local-only + 用户改主意 push → queue push（云端还没覆盖）
  //   - pending 升级：push 盖过 local（再多按也只一个尾巴）
  // editVersion 取 edits 的 SSoT（与 B2 同一个游标）。纯逻辑、无 I/O——可 node 单测（注入 fake doLocal/doPush）。
  function createCoalescer() {
    let pending = null;          // null | "local" | "push"
    let inFlight = null;         // null | "local" | "push"
    let startVer = 0;
    let doLocal = async () => {}, doPush = async () => {};
    function configure(fns = {}) { if (fns.doLocal) doLocal = fns.doLocal; if (fns.doPush) doPush = fns.doPush; }
    async function _run(type) {
      inFlight = type; startVer = _editVersion;
      try { if (type === "push") await doPush(); else await doLocal(); }
      finally {
        inFlight = null;
        if (pending) { const next = pending; pending = null; _run(next); }   // 不 await，避免递归栈
      }
    }
    function request(type) {
      if (!inFlight) { _run(type); return; }
      const hasNewEdits = _editVersion !== startVer;
      const shouldQueue = (inFlight === "local" && type === "push") ? true : hasNewEdits;
      if (!shouldQueue) return;
      if (type === "push" || pending !== "push") pending = type;
    }
    return { configure, request, state: () => ({ pending, inFlight, startVer }) };
  }
  const session = createCoalescer();

  return {
    flow: { push, open, delete: del, rename, saveAs, acquire, replayDelete, restore, purge, emptyTrash },
    cloud: cloudState,         // dirty/etag/status 查询（state-as-store）
    settings,                  // 通用 KV（app 丢 localStorage）
    edits,                     // 编辑游标 SSoT（mark/version）—— B2 + 合流共用（④）
    session,                   // save 合流 coalescer（configure/request）（④）
    adoptBase,                 // app 打开/采纳 item 时调，捕获本 tab 的 base-etag（C4）
    _internal: { toU8, bytesEqual, baseFor },
  };
}
