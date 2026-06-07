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

import { toU8, bytesEqual, createSubstrate } from "./substrate.js";

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
  const sub = createSubstrate();    // shape-agnostic 底座：编辑游标 + push-serialize + save 合流
  const _sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  // C4：base-etag 归这个 Store 实例（= 这个 tab）的内存，open/adopt 时捕获一次。
  // push 用它当 If-Match、成功只推进**自己的**——绝不每次去读跨 tab 共享的 localStorage etag，
  // 否则别的 tab 推成功后改了共享 etag，本 tab 的陈旧推会被误判成"无冲突"→ 静默覆盖（W2 红线）。
  const _base = new Map();   // name → etag|null：这个 tab「已见/已采纳」的云版（open/refresh/pull/heal/push 推进）。
  // 采纳一个 item 的云版基准（open/load 时）。若该 item 已是 dirty（未推编辑跨 reload 持久），
  // parentBase 是内存态、reload 后丢了 → 这里补捕：未推编辑派生自这个刚载入的云版，免得下次 push 撞 bypass 守卫。
  function adoptBase(name, etag) { _base.set(name, etag ?? null); if (cloud.isDirty(name)) captureParent(name); }
  // 这个 tab 见过的云版。仅在 _base 缺失（刚从图库列出、尚未 adopt）才回退到 kv 里的 etag——
  // **只用于 open/refresh 的「云端动没动」比较**（漏判=少快进一次，非数据丢失），绝不用于 push 的 If-Match。
  function seenBase(name) { return _base.has(name) ? _base.get(name) : cloud.getETag(name); }

  // parentBase 权威（ADR-0016 §4）：每条 name「当前未推编辑派生自哪个云版」。
  //   捕获 = clean→dirty 边沿（cloudState.setDirty(name,true)）时取当时的 _base（本 tab 已见版）。
  //   用途 = push 的 If-Match **唯一**来源——绝不回退跨 tab 共享 etag（W2 红线：陈旧推被误判无冲突→静默覆盖）。
  //   清除 = push/pull/heal/refresh 采纳云版后（不再 dirty）。
  const _parent = new Map();   // name → etag|null（null=新文件/无基准，首推不带 If-Match）
  function captureParent(name) { if (!_parent.has(name)) _parent.set(name, _base.has(name) ? _base.get(name) : null); }   // episode 内幂等：只在头一次变脏捕获
  function reparent(name) { _parent.set(name, _base.has(name) ? _base.get(name) : null); }   // 强制重锚到当前 _base（B2：剩余编辑派生自刚推上去的版本）
  function clearParent(name) { _parent.delete(name); }
  function hasParent(name) { return _parent.has(name); }
  function parentFor(name) { return _parent.has(name) ? _parent.get(name) : null; }

  function _retriable(e) {
    return !!e && (e.status == null || e.status === 429 || (e.status >= 500 && e.status <= 599))
      && e.name !== "CloudConflictError";
  }

  // 412：可能是自己 lost-response 已落盘的写。拉云比对，相等即自愈（B5/W1）。
  async function _tryHeal(name, bytes) {
    // ⚠ cloud.pull 有副作用：会 setDirty(name,false)。没自愈（真分叉）时必须还原 dirty——否则
    //   ① 后续 _safePull 的 dirty-gate 看成 clean → 不备份 → 用户版本被覆盖丢失；
    //   ② onConflict 选 no-op 保留本地后，dirty 假性归零 → 下次 push 判 clean 跳过 → 静默丢更新。
    const wasDirty = cloud.isDirty(name);
    let pulled;
    try { pulled = await cloud.pull(name); } catch (_) { if (wasDirty) cloud.setDirty(name, true); return false; }
    if (!pulled) { if (wasDirty) cloud.setDirty(name, true); return false; }
    if (bytesEqual(await toU8(pulled.blob), bytes)) {
      cloud.setDirty(name, false);
      if (pulled.item && pulled.item.eTag) _base.set(name, pulled.item.eTag);  // 自愈后 base 推进到云端版本
      clearParent(name);                                                       // episode 落地（这次推等价于已在云端）
      return true;
    }
    if (wasDirty) cloud.setDirty(name, true);                                   // 真分叉 → 还原 dirty（撤销 pull 的副作用）
    return false;
  }

  function _finish(name, v0, getEditVersion, status) {
    const dirtyAfter = getEditVersion() !== v0;   // B2：PUT 期间又改过 → 仍 unpushed
    if (dirtyAfter) { cloud.setDirty(name, true); reparent(name); }   // 剩余编辑派生自刚推上去的版本（_base 已在 push 成功时推进）
    else clearParent(name);                                            // 干净落地：episode 结束
    return { status, dirtyAfter };
  }

  async function _doPush(name, { encode, getEditVersion = () => sub.edits.version(), onConflict, adopt, saveBranch, now, busy = passBusy } = {}) {
    // bypass 守卫（ADR-0016 §4）：已知云版基准 + 内容 dirty + 却没经过 clean→dirty 门捕获 parentBase
    //   → 有编辑路径绕过了门，再推会拿陈旧/跨tab base 静默覆盖。宁可响亮抛错（=失败的测试）也不静默丢更新。
    if (cloud.isDirty(name) && !hasParent(name) && _base.has(name) && _base.get(name) != null) {
      throw new Error(`Store: "${name}" 有未推编辑但缺 parentBase（编辑未走 clean→dirty 门，拒绝可能静默覆盖的推送）`);
    }
    // If-Match 唯一来源：parentBase。无 parent 时——dirty=新文件(首推不带 If-Match)；非 dirty=强推用本 tab 已见版。
    const baseEtag = hasParent(name) ? parentFor(name) : (cloud.isDirty(name) ? null : seenBase(name));
    const v0 = getEditVersion();
    const bytes = await toU8(await encode());      // 只编码一次，重试复用（B5 逐字节比对要相等）
    return busy("正在同步…", async () => {
      let attempt = 0, lastErr;
      while (attempt < maxAttempts) {
        attempt++;
        try {
          const { item } = await cloud.push(name, bytes, { baseEtag });
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

  // 同一 name 串行（B1）：每次 push 等前一次跑完才启动（串行机制在 substrate）。
  function push(name, opts) {
    return sub.serialize(name, () => _doPush(name, opts));
  }

  // 安全拉取覆盖（A4/A10）：先 local.backup（失败即 abort，绝不 pull/覆盖）→ 拉云 → 覆盖本地 → adopt。
  // 持久状态只在原子点改：备份是复制（原件留着）；覆盖是一次 local.save。强退任一 await 点都可重入。
  async function _safePull(name, adopt) {
    let backupName;
    // ADR-0016 §consequences：clean 本地是可从云端重取的已知版本，无未见内容可丢 → 跳过 backup（不再 spam .backup-local）。
    //   仅 dirty——未推（cloud.isDirty）或未落盘（edits.localDirty）——才在覆盖前留底。匹配 ADR-0009「clean switch never spams a backup」。
    if (cloud.isDirty(name) || sub.edits.localDirty()) {
      try { backupName = await local.backup(name); }
      catch (e) { return { ok: false, reason: "backup-failed", error: e }; }
    }
    const r = await cloud.pull(name);
    if (!r) return { ok: false, reason: "cloud-vanished", backupName };
    await local.save(name, r.blob);                // 覆盖本地为云端版（dirty 时原件已备份）
    if (r.item && r.item.eTag) _base.set(name, r.item.eTag);  // base 推进到云端版本（多tab/冲突后一致）
    cloud.setDirty(name, false);              // 已采纳云端 → 不再 unpushed
    clearParent(name);                        // episode 结束（已采纳云版）
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
      clearParent(name);                        // 本地已强推上云、loser 进 .backup → episode 结束
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

  // C2：开 session 的云端 gate。E8：probe（跳过到离线）与 metadata race，无硬超时。
  // ADR-0016：云端自「本 tab 已见版」后动过时——clean（无未推/未落盘编辑）→ **静默无损快进**（不弹 sheet、_safePull 内部跳 backup）；
  //           dirty → 才弹「拉/留/分支」sheet（真分叉）。绝不静默覆盖 dirty 内容。
  async function open(name, opts = {}) {
    const { isOnline = () => true, probe, onNewer, adopt, busy = passBusy, now = () => 0, localDirty } = opts;
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
      const base = seenBase(name);
      if (!base || meta.etag === base) return { source: "local", reason: "in-sync" };
      // 云端动过。dirty? = 未推（cloud.isDirty）或活动 doc 未落盘（localDirty）。
      const dirty = cloud.isDirty(name) || (localDirty ? localDirty() : false);
      if (!dirty) {
        // clean → 静默快进（无 onNewer sheet；_safePull 因 clean 跳过 backup）
        const r = await _safePull(name, adopt);
        return r.ok
          ? { source: "fast-forwarded", backupName: r.backupName }
          : { source: "local", reason: r.reason, error: r.error };
      }
      // dirty 分叉 → 弹「拉 / 留 / 分支」（onNewer 是 UI 回调；强退在此安全：尚无持久副作用）
      const choice = onNewer
        ? await onNewer({ name, cloudEtag: meta.etag, baseEtag: base, cloudTime: meta.lastModified })
        : "keep";
      if (choice === "pull") {
        const r = await _safePull(name, adopt);   // dirty → _safePull 内部会备份再覆盖
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

  // refresh（ADR-0016 §2）：事件驱动的「干净 Work 无损快进」。app 在 focus / visibilitychange / online 且当前干净时调。
  //   只 metadata（fetchMeta/etag）；etag 真动了且仍 clean 才 _safePull 拉内容（内部因 clean 跳 backup）。
  //   dirty（未推/未落盘）→ no-op（绝不在事件里弹 sheet；后续 push 的 412 会正常 surface 真分叉）。
  //   **硬约束**：绝不每笔/每编辑触发——只由人速的 focus/visibility/online 事件驱动（ADR-0016 §7）。
  async function refresh(name, opts = {}) {
    const { isOnline = () => true, adopt, localDirty, busy = passBusy } = opts;
    if (!isOnline()) return { status: "offline" };
    if (cloud.isDirty(name) || (localDirty && localDirty())) return { status: "dirty-skip" };
    return busy("检查云端…", async () => {
      let meta;
      try { meta = await cloud.fetchMeta(name); }
      catch (_) { return { status: "cloud-error" }; }
      if (!meta) return { status: "cloud-absent" };
      const base = seenBase(name);
      if (!base || meta.etag === base) return { status: "in-sync" };
      if (cloud.isDirty(name) || (localDirty && localDirty())) return { status: "dirty-skip" };  // fetchMeta 期间用户动了笔 → 放弃
      const r = await _safePull(name, adopt);
      return r.ok ? { status: "fast-forwarded" } : { status: "ff-failed", reason: r.reason };
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
    const gev = encode ? (getEditVersion || (() => sub.edits.version())) : () => 0;
    return sub.serialize2(oldName, newName, () => busy("重命名…", async () => {
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
    const { encode, getEditVersion = () => sub.edits.version(), cloud: doCloud = true, busy = passBusy } = opts;
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
    return sub.serialize(newName, run);
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
    // clean→dirty 门（ADR-0016 §4）：app 在编辑落地处标脏时，**唯一**捕获 parentBase 的地方。
    setDirty: (name, d) => {
      if (d && !cloud.isDirty(name)) captureParent(name);   // 头一次变脏 → 锚定「派生自哪个云版」
      cloud.setDirty(name, d);
    },
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

  // 编辑游标（④）+ save 合流 coalescer（④）+ push-serialize（B1）下沉 substrate.js（shape-agnostic，
  // WorkFileStore/FolderStore 共享）。这里经 sub.edits / sub.session 暴露，对外接口不变。

  // store.edit(name)：work-file 的**唯一编辑入口**（L4 ②）。一处吸两事实：
  //   ① 推编辑游标（→ local-dirty，autosave 凭此落盘）；② 经 clean→dirty 门标云脏（→ 捕获 parentBase 唯一点）。
  // name 空（gallery-first 未绑 session）→ 只推游标、不标云脏。门 = cloudState.setDirty，**绝不暴露给 app 直调**
  //   （ADR-0016 §4 footgun：app 绕过门标脏 = 缺 parentBase → 下次 push 撞 bypass 守卫）。云脏**不 gate signedIn**：
  //   登出/SSO 抖动期间的编辑也必标，登回来才认（isCloudDirty getter 未登录返 false，安全）。
  function edit(name) {
    sub.edits.mark();
    if (name) cloudState.setDirty(name, true);
  }

  // transient busy（saving=本地 IDB 写盘中 / pushing=云端 push 中）：app 的 save 编排置位，status 只读（L4 ②b）。
  // 取代 app 的 _docSaving/_cloudPushing 全局——computeSaveState 从此只读 store，不再碰 app 态。
  const _busy = { saving: false, pushing: false };
  let _pushIdleWaiters = [];
  const busy = {
    set: (k, v) => {
      _busy[k] = !!v;
      if (k === "pushing" && !_busy.pushing && _pushIdleWaiters.length) {   // push 落地 → 唤醒所有等待者
        const ws = _pushIdleWaiters; _pushIdleWaiters = []; ws.forEach((r) => r());
      }
    },
    saving: () => _busy.saving,
    pushing: () => _busy.pushing,
    // 等当前 push 跑完（L4 ②d）：取代 app 的 80ms 轮询 _awaitCloudPushIdle = 重抄 store serialize。
    // 无 push 在飞 → 立即 resolve；有 → 等 set("pushing",false) 那刻 resolve。
    whenPushIdle: () => _busy.pushing ? new Promise((r) => _pushIdleWaiters.push(r)) : Promise.resolve(),
  };

  // ---- autosave cadence（L4 ②c）：store 拥「何时写本地」的节律。WebPaint **故意不 debounce-per-edit**
  //   （画图每笔写盘太重）→ cadence = 3min 兜底 timer + 生命周期事件 flush。dirty/busy 判定收这一处，
  //   取代 app 散落的 4 份 `if(localDirty && !saving) saveNow`。app：configure(persist) + start(ms) 各一次，
  //   visibility/pagehide/beforeunload 转 flush()。persist=app 注入的本地存（含 encode + blank/transient/newer
  //   skip 守卫——doc 语义留 app，store 不碰；store 只决定何时调它）。
  let _autosaveTimer = null;
  let _persist = async () => {};
  const autosave = {
    configure: ({ persist } = {}) => { if (persist) _persist = persist; },
    start: (intervalMs) => {
      if (_autosaveTimer != null) clearInterval(_autosaveTimer);
      _autosaveTimer = setInterval(() => { if (sub.edits.localDirty() && !_busy.saving) _persist(); }, intervalMs);
    },
    stop: () => { if (_autosaveTimer != null) { clearInterval(_autosaveTimer); _autosaveTimer = null; } },
    flush: () => (sub.edits.localDirty() && !_busy.saving) ? _persist() : Promise.resolve(),
  };

  return {
    flow: { push, open, refresh, delete: del, rename, saveAs, acquire, replayDelete, restore, purge, emptyTrash },
    edit,                      // 唯一编辑入口（游标 + 门）（L4 ②）
    busy,                      // transient saving/pushing busy（状态归 store，status 只读）（L4 ②b）
    autosave,                  // 本地落盘节律（configure/start/flush）：cadence 归 store（L4 ②c）
    cloud: cloudState,         // dirty/etag/status 查询（state-as-store）
    settings,                  // 通用 KV（app 丢 localStorage）
    edits: sub.edits,          // 编辑游标 SSoT（mark/version）—— B2 + 合流共用（④，住 substrate）；设置类 local-only 改动仍直用 mark
    session: sub.session,      // save 合流 coalescer（configure/request）（④，住 substrate）
    adoptBase,                 // app 打开/采纳 item 时调，捕获本 tab 的 base-etag（C4）
    _internal: { toU8, bytesEqual, seenBase, parentFor, hasParent },
  };
}
