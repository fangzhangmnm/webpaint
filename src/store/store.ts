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

import { toU8, bytesEqual, createSubstrate } from "./substrate.ts";
import type { Bytes, BytesSource } from "./substrate.ts";
import type { BusyFn, CloudItem, CloudSync, FetchMetaResult, Kv, LocalAdapter } from "./types.ts";
// 加密容器（ADR-0012）：机制层，格式盲（data.bin / peek 都是不透明字节）。
import {
  looksEncryptedContainer, packContainer, unpackContainer,
  scanEncPeekFromEnd, decryptPeek, PEEK_TAIL_WINDOW,
} from "./crypto-container.ts";

// busy 包装的统一签名（注入的 _uiBusy / 各 flow 的 opts.busy / 默认 passBusy 共用）。
type Busy = BusyFn;
const passBusy: Busy = (label, fn) => fn();   // 默认 busy：直接跑

// createStore 的注入依赖。
interface StoreDeps {
  cloud: CloudSync;
  local?: LocalAdapter;
  kv: Kv;
  maxAttempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  busy?: Busy;
  /** 加密（ADR-0012）的 app 接缝——装配时注入一次，之后 save/load/push/pull 对调用方**完全透明**
   *  （encode 永远出明文、adopt/load 永远收明文，包壳/解壳全在 flow 里）。store 格式盲：
   *  makePeek 进出都是不透明字节（WebPaint 的解释=缩略图 PNG，文本 app 可以是摘要——store 不看）。
   *
   *  **密码彻底非交互（2026-06-12 死锁修复）**：store **永不开 UI、永不弹密码框**。
   *    getPassword(name)  同步只读内存。null/错 → flow 返 `status:"locked"`（不阻塞、不转圈）。
   *  「没密码就弹框、验证、重试」是 **UI 层的事**，且**必须在 withBusy 之外做**（busy 遮罩 z 高于
   *  sheet，会盖住密码框 → 无限转圈死锁）。UI 用 store.verifyPassword(name,pw) 便宜地验（解 peek，
   *  不碰 7z），验过自己 setPassword，再调本 flow（此时 getPassword 命中）。密码记忆/弹窗政策全归 app
   *  （统一 / per-file / 全局+per-name 覆盖，一个 getPassword 形状吃掉）。 */
  crypt?: {
    ext?: string;                                              // 真扩展名，进 meta.bin（"ora"/"txt"/…）
    makePeek?: (data: Blob) => Promise<Uint8Array | null>;     // 明文 → 明文不透明字节；加密深模块做
    getPassword?: (name: string) => string | null;            // 同步、非交互、只读内存（唯一密码来源）
  };
}

// 冲突 / 同步流的状态机返回（status 判别）。app 据此续 UI。
type ConflictChoice = "keep" | "pull" | "branch" | "weak-override" | "rename" | string;
interface FlowResult {
  status?: string;
  source?: string;
  reason?: string;
  resolution?: string;
  where?: string;
  newName?: string;
  branchName?: string;
  backupName?: string;
  dirtyAfter?: boolean;
  choice?: ConflictChoice;
  cloudEtag?: string;
  baseEtag?: string | null;
  backedUp?: string | null;
  cloudDeferred?: boolean;
  queuedCloudDelete?: boolean;
  trashKey?: string | null;
  trashed?: unknown;
  push?: unknown;
  item?: CloudItem | null;
  local?: boolean;
  cloud?: boolean;
  name?: string | null;
  localName?: string;
  purged?: number;
  failed?: unknown[];
  error?: unknown;
}

/**
 * @param {object} deps
 * @param {object} deps.cloud   cloud.js 模块
 * @param {object} [deps.local] store.local adapter（IDB）；不传则本地相关 flow 不可用
 * @param {number} [deps.maxAttempts=4]
 * @param {number} [deps.backoffMs=200]
 * @param {(ms:number)=>Promise} [deps.sleep]
 * @param {(label:string,fn:Function)=>Promise} [deps.busy] 全屏锁包装（app 注入 withBusy）。
 *
 *   ── 给后面复用本库的 agent：你要接什么样一个 UI ──
 *   busy(label, fn) 的契约：
 *     1. 立刻显示一个**全屏 modal 遮罩**（spinner + label 文案），**吃掉所有用户输入**
 *        （点击/触摸/键盘都不漏到底层 UI）——这是「防误点」，不是装饰。
 *     2. `await fn()` 跑真正的活，**原样返回**它的结果 / 透传它的异常。
 *     3. fn 结束（成功或抛）后**收起遮罩**。
 *     4. **必须可重入**：本库内部会在 busy 里再调到别的 busy 流（rename→push），app
 *        调用方往往也已经包了一层 busy。请用 ref-count（进入 +1 / 退出 -1，归零才 hide），
 *        否则内层一结束就把外层的遮罩收了 → 提前解锁。参见 app 侧 fullscreen-busy.ts。
 *     不接（留默认 passBusy）也能跑——只是没有锁屏，靠下面的 serialize2 保数据一致。
 *
 *   ── 「busy 时深模块要不要拒绝其它接口调用？」——不要，而且不靠 busy 防并发 ──
 *   busy 纯是 **UI 层**手段（挡住*用户*在长操作中途再点别的）。它**不是**本库的并发原语：
 *     · 数据竞争的真正护栏是 substrate 的 **serialize2 / push-serialize**（按 name 串行：rename
 *       挡住对 old/new 两名的 in-flight 写；push 各自链尾串行）。这是 per-identity、细粒度、正确的。
 *     · 全局「busy 中拒绝一切调用」太粗：后台流（autosave 的 _doPush、freshness probe）本就该
 *       和某个 trash-empty 并行跑，硬拒会误伤；且 busy=passBusy 时这道全局锁直接消失，不可靠。
 *   所以：UI 并发 → 交给 busy 遮罩；数据并发 → 交给 serialize2。两者分工，深模块不另设全局互斥。
 *
 *   **深模块强制**：用户态写流（rename/saveAs/del/restore/purge/emptyTrash）默认用注入的 busy
 *   锁屏，调用方忘了包也照锁——挡住改名中途点刷新/tile 读到半截态那类竞态（见 0B 三联症）。
 *   后台流（_doPush/autosave/freshness probe）不默认锁（否则自动保存会闪全屏遮罩）。
 */
export function createStore({ cloud, local, kv, maxAttempts = 4, backoffMs = 200, sleep, busy: _uiBusy = passBusy, crypt = {} }: StoreDeps = {} as StoreDeps) {
  const sub = createSubstrate();    // shape-agnostic 底座：编辑游标 + push-serialize + save 合流
  const _sleep = sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // C4：base-etag 归这个 Store 实例（= 这个 tab）的内存，open/adopt 时捕获一次。
  // push 用它当 If-Match、成功只推进**自己的**——绝不每次去读跨 tab 共享的 localStorage etag，
  // 否则别的 tab 推成功后改了共享 etag，本 tab 的陈旧推会被误判成"无冲突"→ 静默覆盖（W2 红线）。
  const _base = new Map<string, string | null>();   // name → etag|null：这个 tab「已见/已采纳」的云版（open/refresh/pull/heal/push 推进）。
  // 采纳一个 item 的云版基准（open/load 时）。若该 item 已是 dirty（未推编辑跨 reload 持久），
  // parentBase 是内存态、reload 后丢了 → 这里补捕：未推编辑派生自这个刚载入的云版，免得下次 push 撞 bypass 守卫。
  function adoptBase(name: string, etag: string | null) { _base.set(name, etag ?? null); if (cloud.isDirty(name)) captureParent(name); }
  // 这个 tab 见过的云版。仅在 _base 缺失（刚从图库列出、尚未 adopt）才回退到 kv 里的 etag——
  // **只用于 open/refresh 的「云端动没动」比较**（漏判=少快进一次，非数据丢失），绝不用于 push 的 If-Match。
  function seenBase(name: string): string | null { return _base.has(name) ? _base.get(name)! : cloud.getETag(name); }

  // parentBase 权威（ADR-0016 §4）：每条 name「当前未推编辑派生自哪个云版」。
  //   捕获 = clean→dirty 边沿（cloudState.setDirty(name,true)）时取当时的 _base（本 tab 已见版）。
  //   用途 = push 的 If-Match **唯一**来源——绝不回退跨 tab 共享 etag（W2 红线：陈旧推被误判无冲突→静默覆盖）。
  //   清除 = push/pull/heal/refresh 采纳云版后（不再 dirty）。
  const _parent = new Map<string, string | null>();   // name → etag|null（null=新文件/无基准，首推不带 If-Match）
  function captureParent(name: string) { if (!_parent.has(name)) _parent.set(name, _base.has(name) ? _base.get(name)! : null); }   // episode 内幂等：只在头一次变脏捕获
  function reparent(name: string) { _parent.set(name, _base.has(name) ? _base.get(name)! : null); }   // 强制重锚到当前 _base（B2：剩余编辑派生自刚推上去的版本）
  function clearParent(name: string) { _parent.delete(name); }
  function hasParent(name: string) { return _parent.has(name); }
  function parentFor(name: string): string | null { return _parent.has(name) ? _parent.get(name)! : null; }

  function _retriable(e: any): boolean {
    return !!e && (e.status == null || e.status === 429 || (e.status >= 500 && e.status <= 599))
      && e.name !== "CloudConflictError" && e.name !== "CloudNameCollisionError";   // 撞名异文件不重试（重试只会再撞）
  }

  // 412：可能是自己 lost-response 已落盘的写。拉云比对，相等即自愈（B5/W1）。
  // cloud.pull 已纯读（R1 根治）：失败/真分叉路径**零持久副作用**——kv etag/dirty 原样，
  //   用户选「留」后重启也不会拿污染 etag 当 If-Match 静默覆盖分叉版。只有字节级相等才采纳。
  async function _tryHeal(name: string, bytes: Bytes): Promise<boolean> {
    let pulled;
    try { pulled = await cloud.pull(name); } catch (_) { return false; }
    if (!pulled) return false;
    if (bytesEqual(await toU8(pulled.blob), bytes)) {
      if (pulled.item && pulled.item.eTag) { cloud.setETag(name, pulled.item.eTag); _base.set(name, pulled.item.eTag); }  // 自愈 → 显式采纳
      cloud.setDirty(name, false);
      clearParent(name);                                                       // episode 落地（这次推等价于已在云端）
      return true;
    }
    return false;
  }

  function _finish(name: string, v0: number, getEditVersion: () => number, status: string): FlowResult {
    const dirtyAfter = getEditVersion() !== v0;   // B2：PUT 期间又改过 → 仍 unpushed
    if (dirtyAfter) { cloud.setDirty(name, true); reparent(name); }   // 剩余编辑派生自刚推上去的版本（_base 已在 push 成功时推进）
    else clearParent(name);                                            // 干净落地：episode 结束
    return { status, dirtyAfter };
  }

  // _doPush / push / saveAs 等的编排回调集（doc/UI 注入）。
  interface PushOpts {
    encode: () => BytesSource | Promise<BytesSource>;
    getEditVersion?: () => number;
    onConflict?: (ctx: { name: string }) => ConflictChoice | Promise<ConflictChoice>;
    adopt?: (blob: Blob, name: string) => unknown | Promise<unknown>;
    saveBranch?: (blob: Blob, name: string) => unknown | Promise<unknown>;
    now?: () => number;
    busy?: Busy;
  }

  async function _doPush(name: string, { encode, getEditVersion = () => sub.edits.version(), onConflict, adopt, saveBranch, now, busy = passBusy }: PushOpts = {} as PushOpts): Promise<FlowResult> {
    // bypass 守卫（ADR-0016 §4）：已知云版基准 + 内容 dirty + 却没经过 clean→dirty 门捕获 parentBase
    //   → 有编辑路径绕过了门，再推会拿陈旧/跨tab base 静默覆盖。宁可响亮抛错（=失败的测试）也不静默丢更新。
    if (cloud.isDirty(name) && !hasParent(name) && _base.has(name) && _base.get(name) != null) {
      throw new Error(`Store: "${name}" 有未推编辑但缺 parentBase（编辑未走 clean→dirty 门，拒绝可能静默覆盖的推送）`);
    }
    // If-Match 唯一来源：parentBase。无 parent 时——dirty=新文件(首推不带 If-Match)；非 dirty=强推用本 tab 已见版。
    const baseEtag = hasParent(name) ? parentFor(name) : (cloud.isDirty(name) ? null : seenBase(name));
    const v0 = getEditVersion();
    // encode 出**明文**；按 name 的 at-rest 加密态在这里统一包壳（调用方对加密零感知）。
    // 只编码+包壳一次，重试复用（B5 逐字节比对要相等）。
    const bytes = await _seal(name, await toU8(await encode()));
    // 扩展名跟字节内容走（ADR-0012：加密容器在云端叫 .zip）——cloud-sync 据此选路径。
    const isEnc = await looksEncryptedContainer(bytes);
    return busy("正在同步…", async () => {
      let attempt = 0, lastErr: unknown;
      while (attempt < maxAttempts) {
        attempt++;
        try {
          const { item } = await cloud.push(name, bytes, { baseEtag, encrypted: isEnc });
          if (item && item.eTag) _base.set(name, item.eTag);   // 只推进自己的 base
          return _finish(name, v0, getEditVersion, "pushed");
        } catch (e: any) {
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
  function push(name: string, opts?: PushOpts): Promise<FlowResult> {
    return sub.serialize(name, () => _doPush(name, opts));
  }

  // _safePull 的结果（ok 判别）。
  type SafePullResult =
    | { ok: true; backupName?: string }
    | { ok: false; reason: string; backupName?: string; error?: unknown };

  // 安全拉取覆盖（A4/A10）：先 local.backup（失败即 abort，绝不 pull/覆盖）→ 拉云 → 覆盖本地 → adopt。
  // 持久状态只在原子点改：备份是复制（原件留着）；覆盖是一次 local.save。强退任一 await 点都可重入。
  // 仅在 local 注入时调用（caller 保证）；故内部用 local! 断言非空。
  async function _safePull(name: string, adopt?: (blob: Blob, name: string) => unknown | Promise<unknown>): Promise<SafePullResult> {
    let backupName: string | undefined;
    // ADR-0016 §consequences：clean 本地是可从云端重取的已知版本，无未见内容可丢 → 跳过 backup（不再 spam .backup-local）。
    //   仅 dirty——未推（cloud.isDirty）或未落盘（edits.localDirty）——才在覆盖前留底。匹配 ADR-0009「clean switch never spams a backup」。
    if (cloud.isDirty(name) || sub.edits.localDirty()) {
      try { backupName = await local!.backup(name); }
      catch (e) { return { ok: false, reason: "backup-failed", error: e }; }
    }
    const r = await cloud.pull(name);
    if (!r) return { ok: false, reason: "cloud-vanished", backupName };
    await local!.save(name, r.blob);                // 覆盖本地为云端版（dirty 时原件已备份）
    // 采纳后置（R1 根治）：etag/dirty 只在 local.save **成功之后**推进——落盘前强退不再留下
    //   「kv 指新版、本地是旧字节」的静默覆盖窗口（重启后 open 会正确判定云端更新、重新 FF）。
    if (r.item && r.item.eTag) { cloud.setETag(name, r.item.eTag); _base.set(name, r.item.eTag); }
    cloud.setDirty(name, false);              // 已采纳云端 → 不再 unpushed
    clearParent(name);                        // episode 结束（已采纳云版）
    if (adopt) await adopt(await _unsealOrThrow(name, r.blob), name);   // 反映到活编辑器（已解壳为明文）
    return { ok: true, backupName };
  }

  // 真冲突的执行（pull/branch 在 Store 内做；keep/rename 交回 app 处理身份变更）。
  // push 和 open 共用，绝不静默覆盖。
  // 给了执行回调（adopt for pull / saveBranch for branch）→ Store 内执行，返 "resolved"。
  // 没给（或 keep/rename 这类身份变更）→ 返 "conflict"+choice，交 app 处理（向后兼容旧消费代码）。
  // _resolveConflict 的执行回调集（push 上下文给 bytes / open 上下文不给）。
  interface ResolveOpts {
    bytes?: Bytes | null;
    adopt?: (blob: Blob, name: string) => unknown | Promise<unknown>;
    saveBranch?: (blob: Blob, name: string) => unknown | Promise<unknown>;
    now?: () => number;
  }
  async function _resolveConflict(name: string, choice: ConflictChoice, { bytes, adopt, saveBranch, now = () => 0 }: ResolveOpts = {}): Promise<FlowResult> {
    if (choice === "pull" && adopt) {
      const r = await _safePull(name, adopt);
      return r.ok
        ? { status: "resolved", resolution: "pull", backupName: r.backupName }
        : { status: "conflict", choice, resolution: "pull-failed", reason: r.reason, backupName: r.backupName, dirtyAfter: true };
    }
    // weak-override（Work 的 never-lose 覆盖）：云端→.backup，再 force-push 本地。需 bytes（仅 push 上下文有）。
    if (choice === "weak-override" && bytes != null) {
      const r = await cloud.weakOverride(name, bytes, { encrypted: await looksEncryptedContainer(bytes) });
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
  // open 的 UI/env 注入回调。
  interface OpenOpts {
    isOnline?: () => boolean;
    probe?: Promise<unknown> | unknown;
    onNewer?: (ctx: { name: string; cloudEtag: string; baseEtag: string | null; cloudTime: string | number }) => ConflictChoice | Promise<ConflictChoice>;
    adopt?: (blob: Blob, name: string) => unknown | Promise<unknown>;
    busy?: Busy;
    now?: () => number;
    localDirty?: () => boolean;
  }
  async function open(name: string, opts: OpenOpts = {}): Promise<FlowResult> {
    const { isOnline = () => true, probe, onNewer, adopt, busy = passBusy, now = () => 0, localDirty } = opts;
    if (!isOnline()) return { source: "local", reason: "offline" };
    return busy("检查云端…", async () => {
      let meta: FetchMetaResult | null;
      if (probe) {
        const raced = await Promise.race([
          cloud.fetchMeta(name).then((m) => ({ k: "meta" as const, m }), (e) => ({ k: "err" as const, e })),
          Promise.resolve(probe).then(() => ({ k: "skip" as const })),
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
        await local!.save(branchName, r.blob);
        return { source: "branched", branchName };
      }
      return { source: "local", reason: "kept" };
    });
  }

  // refresh（ADR-0016 §2）：事件驱动的「干净 Work 无损快进」。app 在 focus / visibilitychange / online 且当前干净时调。
  //   只 metadata（fetchMeta/etag）；etag 真动了且仍 clean 才 _safePull 拉内容（内部因 clean 跳 backup）。
  //   dirty（未推/未落盘）→ no-op（绝不在事件里弹 sheet；后续 push 的 412 会正常 surface 真分叉）。
  //   **硬约束**：绝不每笔/每编辑触发——只由人速的 focus/visibility/online 事件驱动（ADR-0016 §7）。
  interface RefreshOpts {
    isOnline?: () => boolean;
    adopt?: (blob: Blob, name: string) => unknown | Promise<unknown>;
    localDirty?: () => boolean;
    busy?: Busy;
  }
  async function refresh(name: string, opts: RefreshOpts = {}): Promise<FlowResult> {
    const { isOnline = () => true, adopt, localDirty, busy = passBusy } = opts;
    if (!isOnline()) return { status: "offline" };
    if (cloud.isDirty(name) || (localDirty && localDirty())) return { status: "dirty-skip" };
    return busy("检查云端…", async () => {
      let meta: FetchMetaResult | null;
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
  interface DelOpts {
    isOnline?: () => boolean;
    confirm?: (ctx: { title: string; body: string; danger?: boolean }) => boolean | Promise<boolean>;
    onDirtyWarn?: (ctx: { name: string }) => boolean | Promise<boolean>;
    busy?: Busy;
  }
  async function del(name: string, opts: DelOpts = {}): Promise<FlowResult> {
    const { isOnline = () => true, confirm, onDirtyWarn, busy = _uiBusy } = opts;
    if (confirm && !(await confirm({ title: "删除", body: name, danger: true }))) return { status: "cancelled" };
    if (cloud.isDirty(name) && onDirtyWarn && !(await onDirtyWarn({ name }))) return { status: "cancelled" };

    const localPresent = local ? await local.exists(name) : false;
    if (!isOnline()) {
      // 离线：本地 move-aside + 排队云删（带 base-etag 供重连重放）。队列须持久化（C1b 接 IDB）。
      let trashKey: string | null = null;
      if (localPresent) trashKey = await local!.trash(name);
      return { status: "trashed", where: "local", queuedCloudDelete: true, baseEtag: cloud.getETag(name), trashKey };
    }
    return busy("删除中…", async () => {
      let cloudPresent = false;
      try { cloudPresent = !!(await cloud.fetchMeta(name)); } catch (_) { cloudPresent = false; }
      if (cloudPresent) {
        const trashed = await cloud.trash(name);       // 先云端进 .trash（失败抛 → 本地不动）
        if (localPresent) await local!.hardDelete(name);            // 再本地直接删（不留双份）
        return { status: "trashed", where: "cloud", trashed };
      }
      if (localPresent) { const trashKey = await local!.trash(name); return { status: "trashed", where: "local", trashKey }; }
      return { status: "noop" };
    });
  }

  // C7：离线删除重连重放。按 base-etag 收敛；被别处改过 → delete-vs-edit 默认 edit-wins（不删）。
  // NOT-WIRED（aspirational）：flow.delete 离线时返 queuedCloudDelete，但队列尚未持久化（C1b 接 IDB），
  //   故此函数目前无调用方。保留为 C7 的唯一实现；接队列那轮再启用，别误当死码删掉。
  async function replayDelete(name: string, opts: { baseEtag?: string | null } = {}): Promise<FlowResult> {
    const { baseEtag } = opts;
    let meta: FetchMetaResult | null;
    try { meta = await cloud.fetchMeta(name); }
    catch (_) { return { status: "deferred-offline" }; }
    if (!meta) return { status: "converged", reason: "already-gone" };
    if (baseEtag && meta.etag !== baseEtag) return { status: "conflict-edit-wins" };
    return { status: "trashed", trashed: await cloud.trash(name) };
  }

  // 从 trash 恢复：本地先恢复（撞名自动 (2)，拿到实际落名）→ 云端按同一名恢复（撞名自动 (2)，cloud.js 已实现）。
  // 两端都可有可无（local-only / cloud-only / both 一条路）。返回实际恢复的 name。
  interface RestoreOpts {
    fromCloud?: boolean;
    cloudItemId?: string | null;
    targetName?: string;
    trashKey?: string | null;
    busy?: Busy;
  }
  async function restore(opts: RestoreOpts = {}): Promise<FlowResult> {
    const { fromCloud, cloudItemId, targetName, trashKey, busy = _uiBusy } = opts;
    return busy("恢复中…", async () => {
      let name: string | null = targetName || null, restoredLocal = false, restoredCloud = false;
      if (trashKey && local) { const n = await local.restore(trashKey); if (n) { name = n; restoredLocal = true; } }
      if (fromCloud && cloudItemId != null) { await cloud.restore(cloudItemId, (name || targetName)!); restoredCloud = true; }
      if (!restoredLocal && !restoredCloud) return { status: "noop" };
      return { status: "restored", name, local: restoredLocal, cloud: restoredCloud };
    });
  }

  // 永久删（不可恢复）→ 强制 danger confirm（H2）。两端都可有可无（trashKey 本地 / cloudItemId 云端）。
  interface PurgeOpts {
    trashKey?: string | null;
    cloudItemId?: string | null;
    confirm?: (ctx: { title: string; body: string; danger?: boolean }) => boolean | Promise<boolean>;
    busy?: Busy;
  }
  async function purge(opts: PurgeOpts = {}): Promise<FlowResult> {
    const { trashKey, cloudItemId, confirm, busy = _uiBusy } = opts;
    if (confirm && !(await confirm({ title: "彻底删除", body: "不可恢复", danger: true }))) return { status: "cancelled" };
    return busy("彻底删除…", async () => {
      if (trashKey && local && local.purgeTrash) await local.purgeTrash(trashKey);
      if (cloudItemId != null) await cloud.purge(cloudItemId);
      return { status: "purged" };
    });
  }

  // 清空回收站（批量彻底删）：本地 / 云端在库内一处清，逐项独立 try、失败汇总不静默。
  //   scope 选清哪端（见下方 EmptyTrashOpts）——UI 拆成「清空本地」「清空云端」两按钮。
  // 不按 GUID 配对 local↔cloud——清空是按端整片清，配对无意义（≠ restore）。
  // 离线（isOnline()=false）→ 这次只清本地、云端清不了；要清云端得回线后用户**再点一次**清空。
  // **强退 = cancel（一次性操作，绝不持久化 / 不自动续）**：中途强退 = 已删的永久没了（彻底删本不可逆）、
  //   没删的留在 trash；要清剩的得用户**手动再点**清空（针对那时 trash 的现状）。
  //   ⚠ 别做成「自动续上次未完成的清空」——下次 trash 可能已有新 item，自动续会连新 item 一起删 = 灾难。
  // 云端 bounded 并发（默 5，每项仍独立原子），避免大量文件串行太慢。
  // scope：清哪一端。"local"=仅本地、"cloud"=仅云端、"both"=两端（默认，保旧调用语义）。
  //   UI 把它拆成「清空本地」「清空云端」两个按钮；"both" 仍保留给 API/将来"全部清空"。
  interface EmptyTrashOpts { isOnline?: () => boolean; busy?: Busy; concurrency?: number; scope?: "local" | "cloud" | "both"; }
  async function emptyTrash(opts: EmptyTrashOpts = {}): Promise<FlowResult> {
    const { isOnline, busy = _uiBusy, concurrency = 5, scope = "both" } = opts;
    return busy("清空回收站…", async () => {
      let purged = 0; const failed: { name?: string; where: string; error: string }[] = [];
      const errMsg = (e: unknown) => String((e as { message?: unknown })?.message || e);
      if (scope !== "cloud" && local && local.listTrash && local.purgeTrash) {
        for (const t of await local.listTrash()) {            // 本地 IDB 删很快，串行即可
          try { await local.purgeTrash(t.trashKey); purged++; }
          catch (e) { failed.push({ name: t.name, where: "local", error: errMsg(e) }); }
        }
      }
      if (scope !== "local" && (!isOnline || isOnline())) {
        let items: CloudItem[] | null = null;
        try { items = await cloud.listTrash(); }
        catch (e) { failed.push({ where: "cloud-list", error: errMsg(e) }); }
        items = items || [];
        for (let i = 0; i < items.length; i += concurrency) {  // bounded 并发（~5），快约 N×
          await Promise.all(items.slice(i, i + concurrency).map(async (it) => {
            try { await cloud.purge(it.id); purged++; }
            catch (e) { failed.push({ name: it.name, where: "cloud", error: errMsg(e) }); }
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
  interface RenameOpts {
    encode?: () => BytesSource | Promise<BytesSource>;
    getEditVersion?: () => number;
    cloud?: boolean;
    busy?: Busy;
  }
  async function rename(oldName: string, newName: string, opts: RenameOpts = {}): Promise<FlowResult> {
    const { encode, getEditVersion, cloud: doCloud = true, busy = _uiBusy } = opts;
    if (!oldName || !newName || oldName === newName) return { status: "noop" };
    // 非 active 改名（无 encode）不该被活 doc 的编辑游标污染 dirtyAfter → 用冻结游标。
    const gev = encode ? (getEditVersion || (() => sub.edits.version())) : () => 0;
    return sub.serialize2(oldName, newName, () => busy("重命名…", async () => {
      const hasLocal = local ? await local.exists(oldName) : false;
      let bytes: Bytes | null = null;
      if (encode) bytes = await toU8(await encode());
      else if (hasLocal) bytes = await toU8(await local!.get(oldName));

      if (local && hasLocal) {
        await local.save(newName, bytes!);                              // 先存新名（含当前字节）
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
  interface SaveAsOpts {
    encode: () => BytesSource | Promise<BytesSource>;
    getEditVersion?: () => number;
    cloud?: boolean;
    busy?: Busy;
  }
  async function saveAs(newName: string, opts: SaveAsOpts = {} as SaveAsOpts): Promise<FlowResult> {
    const { encode, getEditVersion = () => sub.edits.version(), cloud: doCloud = true, busy = _uiBusy } = opts;
    const run = async (): Promise<FlowResult> => {
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
  interface AcquireOpts {
    localName?: string;
    adopt?: (blob: Blob, name: string) => unknown | Promise<unknown>;
    busy?: Busy;
  }
  async function acquire(cloudName: string, opts: AcquireOpts = {}): Promise<FlowResult> {
    const { localName = cloudName, adopt, busy = passBusy } = opts;
    return busy("拉取中…", async () => {
      const r = await cloud.pull(cloudName);
      if (!r) return { status: "absent" };
      if (local) await local.save(localName, r.blob);
      // pull 已纯读 → 这里对**落地名**显式采纳（旧版靠 pull 给 cloudName 写 kv、撞名改名时再补写 localName）。
      if (r.item && r.item.eTag) {
        _base.set(localName, r.item.eTag);
        cloud.setETag(localName, r.item.eTag);
        cloud.setDirty(localName, false);
      }
      if (adopt) await adopt(await _unsealOrThrow(localName, r.blob), localName);
      return { status: "acquired", localName, item: r.item };
    });
  }

  // ---- state-as-store（①）：app 不再直碰 localStorage，全走这些 typed 接口 ----
  // 云端同步态（dirty/etag/status）。status 直接喂 save 按钮 icon（local-only vs synced vs dirty）。
  const cloudState = {
    isDirty: (name: string) => cloud.isDirty(name),
    getETag: (name: string) => cloud.getETag(name),
    // clean→dirty 门（ADR-0016 §4）：app 在编辑落地处标脏时，**唯一**捕获 parentBase 的地方。
    setDirty: (name: string, d: boolean) => {
      if (d && !cloud.isDirty(name)) captureParent(name);   // 头一次变脏 → 锚定「派生自哪个云版」
      cloud.setDirty(name, d);
    },
    // signedIn/hasLocal 是 app context（auth/本地存在），调用方传入；同步返回，给 UI 高频查。
    status: (name: string, { signedIn = true, hasLocal = true }: { signedIn?: boolean; hasLocal?: boolean } = {}) => {
      if (!hasLocal) return cloud.getETag(name) ? "cloud-only" : "absent";
      if (!signedIn) return "local-only";
      return cloud.isDirty(name) ? "dirty" : "synced";
    },
  };
  // 通用 app 设置（主题/笔刷尺寸/面板位置…）。app 丢掉自己的 localStorage 调用。
  const settings = {
    get: (k: string) => (kv ? kv.get(`settings:${k}`) : null),
    set: (k: string, v: string) => { if (kv) kv.set(`settings:${k}`, v); },
    remove: (k: string) => { if (kv) kv.remove(`settings:${k}`); },
  };
  // 活动 item 指针：WebPaint 用 session.js 的 webpaint.currentSessionName（含 boot-load 失败时的
  // phantom-path 保护）。曾在此放过一个 store.active（kv "active:pointer"），与之并存只会双源失同步、
  // 从无调用 → 已删。将来真要 app-agnostic 化，应迁到 session.js 那个键、而非另起炉灶。

  // 编辑游标（④）+ save 合流 coalescer（④）+ push-serialize（B1）下沉 substrate.ts（shape-agnostic，
  // WorkFileStore/FolderStore 共享）。这里经 sub.edits / sub.session 暴露，对外接口不变。

  // store.edit(name)：work-file 的**唯一编辑入口**（L4 ②）。一处吸两事实：
  //   ① 推编辑游标（→ local-dirty，autosave 凭此落盘）；② 经 clean→dirty 门标云脏（→ 捕获 parentBase 唯一点）。
  // name 空（gallery-first 未绑 session）→ 只推游标、不标云脏。门 = cloudState.setDirty，**绝不暴露给 app 直调**
  //   （ADR-0016 §4 footgun：app 绕过门标脏 = 缺 parentBase → 下次 push 撞 bypass 守卫）。云脏**不 gate signedIn**：
  //   登出/SSO 抖动期间的编辑也必标，登回来才认（isCloudDirty getter 未登录返 false，安全）。
  function edit(name?: string | null) {
    sub.edits.mark();
    if (name) cloudState.setDirty(name, true);
  }

  // transient busy（saving=本地 IDB 写盘中 / pushing=云端 push 中）：app 的 save 编排置位，status 只读（L4 ②b）。
  // 取代 app 的 _docSaving/_cloudPushing 全局——computeSaveState 从此只读 store，不再碰 app 态。
  const _busy: { saving: boolean; pushing: boolean } = { saving: false, pushing: false };
  let _pushIdleWaiters: Array<() => void> = [];
  const busy = {
    set: (k: "saving" | "pushing", v: boolean) => {
      _busy[k] = !!v;
      if (k === "pushing" && !_busy.pushing && _pushIdleWaiters.length) {   // push 落地 → 唤醒所有等待者
        const ws = _pushIdleWaiters; _pushIdleWaiters = []; ws.forEach((r) => r());
      }
    },
    saving: () => _busy.saving,
    pushing: () => _busy.pushing,
    // 等当前 push 跑完（L4 ②d）：取代 app 的 80ms 轮询 _awaitCloudPushIdle = 重抄 store serialize。
    // 无 push 在飞 → 立即 resolve；有 → 等 set("pushing",false) 那刻 resolve。
    whenPushIdle: (): Promise<void> => _busy.pushing ? new Promise<void>((r) => _pushIdleWaiters.push(r)) : Promise.resolve(),
  };

  // ---- autosave cadence（L4 ②c）：store 拥「何时写本地」的节律。WebPaint **故意不 debounce-per-edit**
  //   （画图每笔写盘太重）→ cadence = 3min 兜底 timer + 生命周期事件 flush。dirty/busy 判定收这一处，
  //   取代 app 散落的 4 份 `if(localDirty && !saving) saveNow`。app：configure(persist) + start(ms) 各一次，
  //   visibility/pagehide/beforeunload 转 flush()。persist=app 注入的本地存（含 encode + blank/transient/newer
  //   skip 守卫——doc 语义留 app，store 不碰；store 只决定何时调它）。
  let _autosaveTimer: ReturnType<typeof setInterval> | null = null;
  let _persist: () => Promise<void> = async () => {};
  const autosave = {
    configure: ({ persist }: { persist?: () => Promise<void> } = {}) => { if (persist) _persist = persist; },
    start: (intervalMs: number) => {
      if (_autosaveTimer != null) clearInterval(_autosaveTimer);
      _autosaveTimer = setInterval(() => { if (sub.edits.localDirty() && !_busy.saving) _persist(); }, intervalMs);
    },
    stop: () => { if (_autosaveTimer != null) { clearInterval(_autosaveTimer); _autosaveTimer = null; } },
    flush: () => (sub.edits.localDirty() && !_busy.saving) ? _persist() : Promise.resolve(),
  };

  // 空文件夹（gallery 文件夹模型：OneDrive 真文件夹为单一真相源）。新建/删除都走深模块——
  //   ① 强制锁屏（默认 _uiBusy，调用方点了即刻看到遮罩，修「改名/新建延迟锁屏 F」）；
  //   ② 删除的「必须空」在 cloud.removeFolder 内强制（非空抛错，不静默级联删子树）；
  //   ③ 进单飞守卫，与 rename/del 一致。app 不再裸调 graph.ensureSubfolder/deleteItem（绕过 busy/守卫/吞错 = N9 根因）。
  interface FolderOpOpts { isOnline?: () => boolean; busy?: Busy; }
  async function newFolder(path: string, opts: FolderOpOpts = {}): Promise<FlowResult> {
    const { isOnline = () => true, busy = _uiBusy } = opts;
    if (!path) return { status: "noop" };
    if (!isOnline()) return { status: "offline" };
    return busy("新建文件夹…", async () => {
      await cloud.ensureFolder(path);
      return { status: "folder-created", name: path };
    });
  }
  async function deleteFolder(path: string, opts: FolderOpOpts = {}): Promise<FlowResult> {
    const { isOnline = () => true, busy = _uiBusy } = opts;
    if (!path) return { status: "noop" };
    if (!isOnline()) return { status: "offline" };
    return busy("删除文件夹…", async () => {
      const removed = await cloud.removeFolder(path);   // 非空 → 抛错（深模块强制必须空），调用方报状态
      return { status: removed ? "folder-deleted" : "noop", name: path };
    });
  }

  // ==== 加密（ADR-0012）：调用方零感知，store **对密码彻底非交互**、格式盲 ====

  // 用内存密码（getPassword，同步）跑一次 attempt。没密码 / 错密码（code=WRONG_PASSWORD）→ null。
  //   **store 永不弹窗、永不循环**——「弹密码框 + 重试」是 UI 层的事，且必须在 withBusy 之外做
  //   （见 verifyPassword + StoreDeps.crypt 注释）。其它错误原样上抛。
  async function _withPassword<T>(name: string, attempt: (pw: string) => Promise<T>): Promise<T | null> {
    const pw = crypt.getPassword ? crypt.getPassword(name) : null;
    if (!pw) return null;
    try { return await attempt(pw); }
    catch (e: any) { if (e?.code === "WRONG_PASSWORD") return null; throw e; }
  }

  // UI 解锁循环的便宜验证器：解 name 的 peek（AES-GCM，快，不碰 7z、不开 UI、不进 busy）→ 密码对否。
  //   UI 在 withBusy **之外**循环 prompt → verifyPassword → 自己 setPassword，再调 flow（getPassword 命中）。
  //   peek 与 payload 同一密码加密 → peek 验过 = payload 也能开。本地无字节/无 peek → false（调用方另判）。
  async function verifyPassword(name: string, pw: string): Promise<boolean> {
    if (!pw) return false;
    const tail = await getTailBytes(name, PEEK_TAIL_WINDOW, { cloud: true });   // 本地无字节→云端 peek（拉取前解锁用）
    if (tail) {
      const parsed = scanEncPeekFromEnd(new Uint8Array(await tail.arrayBuffer()));
      if (parsed) { try { await decryptPeek(parsed, pw); return true; } catch { return false; } }
    }
    // 无 peek（裸 .7z / 手工 mock）→ 退回整字节解一把验（贵，仅无 peek 时）。本地无字节 → false。
    const full = local ? await local.get(name) : null;
    return full ? await verifyContainer(full as Blob, pw) : false;
  }
  // 验证一段明文容器字节的密码（导入外来加密文件用——文件还没进 store，没 name 可查）。
  async function verifyContainer(blob: Blob, pw: string): Promise<boolean> {
    if (!pw) return false;
    try { await unpackContainer(blob, pw); return true; } catch { return false; }
  }
  // 用**显式密码**解一段字节（导入外来文件用：可能与图库统一密码不同，不走 getPassword/不污染全局）。
  //   明文原样返回；容器+对密码→明文 blob；容器+错密码→null。
  async function unsealWith(blob: Blob, pw: string): Promise<Blob | null> {
    if (!(await looksEncryptedContainer(blob))) return blob;
    try { return (await unpackContainer(blob, pw)).dataBlob; } catch { return null; }
  }
  // blob 是不是加密容器（导入分流用）。
  async function looksEncrypted(blob: Blob | Uint8Array): Promise<boolean> {
    return await looksEncryptedContainer(blob);
  }

  function _lockedErr(name: string): Error & { code?: string } {
    const e = new Error(`「${name}」已加密且未解锁（需要密码）`) as Error & { code?: string };
    e.code = "LOCKED";
    return e;
  }

  // 包壳（encode 边界统一调）：按 name 的 at-rest 字节判断加密态——SSoT 是字节本身，无登记表可漂移。
  //   明文文件 / 输入已是容器（rename 原样搬运路径）→ 原样返回。
  //   加密文件 + 密码不在 → 响亮抛 LOCKED（保存路径绝不弹窗、绝不静默存明文）。
  async function _seal(name: string, plain: Bytes): Promise<Bytes> {
    if (await looksEncryptedContainer(plain)) return plain;          // 已是容器（原样字节搬运路径）→ 不二次包
    if (!local) return plain;
    const prev = await local.get(name);
    if (!prev || !(await looksEncryptedContainer(prev as Blob | Uint8Array))) return plain;   // 明文文件
    const pw = crypt.getPassword ? crypt.getPassword(name) : null;
    if (!pw) throw _lockedErr(name);
    let peek: Uint8Array | null = null;
    if (crypt.makePeek) {
      try { peek = await crypt.makePeek(new Blob([plain as BlobPart])); } catch (_) { peek = null; }
    }
    const container = await packContainer({ dataBytes: plain, fileName: name, ext: crypt.ext, peek, password: pw });
    return await toU8(container);
  }

  // 解壳：明文原样返回；容器 → 用内存密码解包。锁定（无/错密码）→ null。
  //   **非交互**：调用方若想"解不开就弹框"，须先在 withBusy 外 ensureUnlocked 把密码放进内存再调。
  async function _unseal(name: string, blob: Blob): Promise<Blob | null> {
    if (!(await looksEncryptedContainer(blob))) return blob;
    const res = await _withPassword(name, (pw) => unpackContainer(blob, pw));
    return res ? res.dataBlob : null;
  }
  async function _unsealOrThrow(name: string, blob: Blob): Promise<Blob> {
    const plain = await _unseal(name, blob);
    if (!plain) throw _lockedErr(name);   // pull/open 的 adopt 路径：UI 应已 ensureUnlocked，仍锁=异常
    return plain;
  }

  // ---- flow.save / flow.load：本地持久化也走深模块（明文绝不落盘）----
  // save：encode 出明文 → 按加密态包壳 → local.save。hint 是给 LocalAdapter 的 app 旁路
  //   （如 WebPaint 把活 doc 现成的缩略图带过去省一次解码），store 不解释、原样透传。
  interface SaveOpts { encode: () => BytesSource | Promise<BytesSource>; hint?: unknown; }
  async function save(name: string, { encode, hint }: SaveOpts): Promise<FlowResult> {
    if (!local) throw new Error("Store: 未注入 local adapter");
    return sub.serialize(name, async () => {
      const plain = await toU8(await encode());
      const sealed = await _seal(name, plain);
      await (local!.save as any)(name, sealed, hint);
      return { status: "saved", local: true };
    });
  }
  // load：local.get → 自动解壳 → 明文 blob。加密且内存无/错密码 → status:"locked"（**不弹窗**）。
  //   UI 拿到 "locked" → 在 withBusy **之外** ensureUnlocked（prompt+verifyPassword+setPassword）→ 重 load。
  async function load(name: string): Promise<FlowResult & { blob?: Blob; encrypted?: boolean }> {
    if (!local) throw new Error("Store: 未注入 local adapter");
    const raw = await local.get(name);
    if (!raw) return { status: "absent" };
    const encrypted = await looksEncryptedContainer(raw as Blob | Uint8Array);
    if (!encrypted) return { status: "loaded", blob: raw as Blob, encrypted: false };
    const plain = await _unseal(name, raw as Blob);
    if (!plain) return { status: "locked", encrypted: true };
    return { status: "loaded", blob: plain, encrypted: true };
  }

  // ---- 加密 transform（flow.encrypt / flow.decrypt：切换 at-rest 加密态）----
  // 「换文件体」的用户态写流：本地与云端的字节**一起**换成密文/明文。深模块强制的红线：
  //   ① 本地先落盘（字节真相；authority dirty→local）——云端没跟上时本地版本是权威端；
  //   ② 云端跟进失败（412 真分叉 / 网络）→ **标脏 + 锚 parentBase=换前云版**，交给正常 push 流
  //      接力收敛（下次推 If-Match 旧云版：没人动过→换成功；动过→412 surface），绝不静默分叉
  //      （v233 教训：app 层只推云不换本地 → 下次保存把明文又推上去 = 加密被静默撤销）；
  //   ③ 已同步过云端（有 etag）但离线 → 拒绝（status:"offline"），防止"只换了一端"的隐藏分叉；
  //   ④ 错密码在任何持久改动**之前**出局（解包/密码循环先行，零副作用）。
  interface CryptOpOpts { isOnline?: () => boolean; busy?: Busy; }

  // 字节替换共用流。tracked = 曾与云同步（有 etag）。encrypted 显式传（决定云端扩展名）。
  async function _swapBytes(name: string, bytes: Bytes, isOnline: () => boolean, encrypted: boolean): Promise<FlowResult> {
    const prevEtag = cloud.getETag(name);
    const tracked = prevEtag != null;
    if (tracked && !isOnline()) return { status: "offline" };
    await local!.save(name, bytes);                       // ① 字节真相先落地
    if (!tracked) return { status: "swapped", cloud: false };
    try {
      const { item } = await cloud.push(name, bytes, { baseEtag: seenBase(name), encrypted });   // If-Match：本 tab 已见版（kv 兜底）；含扩展名翻转
      if (item && item.eTag) _base.set(name, item.eTag);  // cloud.push 内已 setETag+setDirty(false)；这里推进本 tab base
      clearParent(name);                                  // episode 落地
      return { status: "swapped", cloud: true };
    } catch (e: any) {
      // ② 本地已换、云端没跟上 → 标脏 + 锚 parent=换前云版，正常 push 流接力收敛
      _parent.set(name, prevEtag);
      cloud.setDirty(name, true);
      if (e && e.name === "CloudConflictError") return { status: "conflict", dirtyAfter: true };
      return { status: "cloud-deferred", dirtyAfter: true, error: e };
    }
  }

  async function encryptFile(name: string, opts: CryptOpOpts = {}): Promise<FlowResult> {
    const { isOnline = () => true, busy = _uiBusy } = opts;
    if (!local) throw new Error("Store: 未注入 local adapter，无法加密");
    return busy(`正在加密 ${name}…`, () => sub.serialize(name, async () => {
      const blob = await local!.get(name);
      if (!blob) return { status: "no-local" };
      if (await looksEncryptedContainer(blob as Blob | Uint8Array)) return { status: "already" };
      if (cloud.getETag(name) != null && !isOnline()) return { status: "offline" };   // 早退：还没打包就知道两端换不齐
      // 首次加密的密码 = app 在调用前经自己的设密码 UX 放进 seam（store 这里只取，不问）
      const pw = crypt.getPassword ? crypt.getPassword(name) : null;
      if (!pw) return { status: "locked" };
      let peek: Uint8Array | null = null;
      if (crypt.makePeek) {
        const asBlob = blob instanceof Blob ? blob : new Blob([blob as BlobPart]);
        try { peek = await crypt.makePeek(asBlob); } catch (_) { peek = null; }
      }
      const container = await packContainer({ dataBytes: await toU8(blob), fileName: name, ext: crypt.ext, peek, password: pw });
      return await _swapBytes(name, await toU8(container), isOnline, true);
    }));
  }

  async function decryptFile(name: string, opts: CryptOpOpts = {}): Promise<FlowResult> {
    const { isOnline = () => true, busy = _uiBusy } = opts;
    if (!local) throw new Error("Store: 未注入 local adapter，无法解除加密");
    return busy(`正在解除加密 ${name}…`, () => sub.serialize(name, async () => {
      const blob = await local!.get(name);
      if (!blob) return { status: "no-local" };
      if (!(await looksEncryptedContainer(blob as Blob | Uint8Array))) return { status: "not-encrypted" };
      if (cloud.getETag(name) != null && !isOnline()) return { status: "offline" };
      // ④ 用内存密码解（非交互）；无/错密码 → locked（UI 应已在 busy 外 ensureUnlocked）。任何持久改动之前出局。
      const res = await _withPassword(name, (pw) => unpackContainer(blob as Blob, pw));
      if (!res) return { status: "locked" };
      return await _swapBytes(name, await toU8(res.dataBlob), isOnline, false);
    }));
  }

  // ---- 读侧原语（格式盲；peek 字节的解释归 app）----

  // 尾部字节（file-envelope.md salvage）。自动路由：本地有 → blob 尾切片（IDB Blob.slice 惰性）；
  //   没有且 opts.cloud → 云端 byte-range（peek 预览纯云端文件用）。
  async function getTailBytes(name: string, n: number, { cloud: tryCloud = false } = {}): Promise<Blob | null> {
    if (local) {
      const blob = await local.get(name);
      if (blob) {
        const size = (blob as any).size ?? (blob as any).length ?? 0;
        const sliced = (blob as any).slice(Math.max(0, size - n));
        return sliced instanceof Blob ? sliced : new Blob([sliced]);
      }
    }
    if (tryCloud && (cloud as any).pullTail) {
      const t = await (cloud as any).pullTail(name, n);
      return t ? new Blob([t.bytes as BlobPart]) : null;
    }
    return null;
  }

  // 解一段尾片里的加密 peek → 不透明明文字节。**非交互**（用内存密码；图库批量渲染绝不弹窗伏击）。
  //   锁定/解不开 → null（UI 显示锁样式；要解锁走 ensureUnlocked + verifyPassword 在 busy 外）。
  async function decryptPeekBytes(name: string, tail: Blob | Uint8Array): Promise<Uint8Array | null> {
    const u8 = tail instanceof Uint8Array ? tail : new Uint8Array(await tail.arrayBuffer());
    const parsed = scanEncPeekFromEnd(u8);
    if (!parsed) return null;
    return await _withPassword(name, (pw) => decryptPeek(parsed, pw));
  }

  // 便捷组合：本地（或 cloud:true 时云端）尾片 → peek 明文字节。锁定 → null（app 显示锁样式）。
  async function readPeek(name: string, { cloud: tryCloud = false } = {}): Promise<Uint8Array | null> {
    const tail = await getTailBytes(name, PEEK_TAIL_WINDOW, { cloud: tryCloud });
    if (!tail) return null;
    return await decryptPeekBytes(name, tail);
  }

  // 加密态查询（按本地字节尾扫；SSoT=字节）与原始字节读取（导出密文容器等场景）。
  async function isEncrypted(name: string): Promise<boolean> {
    if (!local) return false;
    const blob = await local.get(name);
    return blob ? await looksEncryptedContainer(blob as Blob | Uint8Array) : false;
  }
  async function loadRaw(name: string): Promise<Blob | null> {
    return local ? await local.get(name) : null;
  }

  // 单飞守卫（single-flight）：用户态写流（rename/saveAs/del/restore/purge/emptyTrash/newFolder/deleteFolder）
  //   同一时刻只允许一个在跑，并发的第二个**直接拒**（throw STORE_BUSY），调用方 catch→报状态。
  // 与 busy 正交、是更硬的护栏：busy 只是 UI 防误点（passBusy / 无 UI 时失效），这道在库内自带、
  //   不依赖 UI——库被无头复用时也挡得住「两个用户态写同时动手」。数据竞争仍由 serialize2 兜底，
  //   这道在其上加「全局同一时刻只一个用户态写」的更强语义（user 明确要）。
  // 安全前提：被守的 8 个流**互不内部调用**（emptyTrash 直接调 adapter，不走 flow.purge；rename 内
  //   部走 _doPush 而非 flow.saveAs；newFolder/deleteFolder 直接调 cloud.*）——否则嵌套会自锁。新增流要进这层守卫前先核这条。
  let _userWriteInFlight: string | null = null;     // 在跑的用户态写 label；null = 空闲
  const _singleFlight = <A extends unknown[], R>(label: string, fn: (...args: A) => Promise<R>) => (...args: A): Promise<R> => {
    if (_userWriteInFlight) {
      const e = new Error(`有另一项操作进行中（${_userWriteInFlight}），请等它完成再试`) as Error & { code?: string };
      e.code = "STORE_BUSY";
      return Promise.reject(e);
    }
    _userWriteInFlight = label;
    return Promise.resolve().then(() => fn(...args)).finally(() => { _userWriteInFlight = null; });
  };

  return {
    flow: {
      push, open, refresh, acquire, replayDelete,         // 后台 / 读流：不进单飞守卫
      delete: _singleFlight("删除", del),
      rename: _singleFlight("重命名", rename),
      saveAs: _singleFlight("另存为", saveAs),
      restore: _singleFlight("恢复", restore),
      purge: _singleFlight("彻底删除", purge),
      emptyTrash: _singleFlight("清空回收站", emptyTrash),
      newFolder: _singleFlight("新建文件夹", newFolder),
      deleteFolder: _singleFlight("删除文件夹", deleteFolder),
      encrypt: _singleFlight("加密", encryptFile),         // 换文件体（ADR-0012）；内部只调 cloud.push/local，不嵌套被守流
      decrypt: _singleFlight("解除加密", decryptFile),
      save,                    // 本地落盘（encode 出明文，加密态自动包壳）——热路径，不进单飞守卫
      load,                    // 本地读取（自动解壳出明文；锁定 → status:"locked"）
    },
    seal: _seal,               // 旁路字节按 name 加密态包壳（app 的 checkpoint/导出等自管存储用；不透明）
    unseal: (name: string, blob: Blob) => _unseal(name, blob),   // 非交互解壳（明文原样 / 内存密码解 / 锁定 null）
    verifyPassword,            // UI 解锁循环用：解 peek 验密码（便宜、不开 UI、不进 busy）
    verifyContainer,           // 同上但验一段明文容器字节（导入外来加密文件用，文件未进 store）
    unsealWith,                // 用显式密码解一段字节（导入：不走 getPassword、不污染全局）
    looksEncrypted,            // blob 是否加密容器（导入分流）
    isEncrypted,               // 加密态查询（SSoT=本地字节尾扫）
    loadRaw,                   // 原始字节不解壳（导出密文容器用）
    getTailBytes,              // 尾部 N 字节原语（本地/云端自动路由；peek 解释归 app）
    decryptPeekBytes,          // 尾片 → peek 明文字节（非交互；锁定 → null）
    readPeek,                  // getTailBytes + decryptPeekBytes 便捷组合（非交互）
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
