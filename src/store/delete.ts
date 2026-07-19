// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// delete（深模块）—— 删除 = move-aside（绝不硬删脏字节）。单一职责 = 三态删除 + 离线删队列：
//   三态：仅本地 / 仅云端 / 两者（两者→云端进 .trash + 本地干净副本直删，不留双份；本地脏→降级 local-only）。
//   离线：本地 move-aside + 持久化排队（base-etag 守卫），重连 drainDeleteQueue 重放——
//   被别处改过（含同名新文件）→ conflict-edit-wins → **不删**（防"旧设备攒删除很久后上线删掉别人的新文件"）。
import { reportStoreError } from "./error-handling.ts";   // 全接但分级：静默 swallow 也 funnel（不改控制流）
import { asideStamp } from "./move-aside.ts";              // deleteEventId 生成器（时间戳+guid，兼作防撞后缀）
import type { CloudSync, Kv, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";

type Busy = <T>(label: string, fn: () => Promise<T>) => Promise<T>;
const passBusy: Busy = (_l, fn) => fn();

export interface DeleteCfg {
  cloud: Pick<CloudSync, "fetchMeta" | "trash" | "getETag">;
  local?: Pick<LocalCache, "exists" | "trash" | "hardDelete">;
  head: Pick<LocalHead, "isDirty" | "forget">;
  kv: Kv;
  busy?: Busy;
}
export interface DelOpts {
  isOnline?: () => boolean;
  confirm?: (ctx: { title: string; body: string; danger?: boolean }) => boolean | Promise<boolean>;
  onDirtyWarn?: (ctx: { name: string }) => boolean | Promise<boolean>;
  busy?: Busy;
}
export interface DelResult { status: string; where?: string; trashed?: unknown; trashKey?: string | null; baseEtag?: string | null; queuedCloudDelete?: boolean; reason?: string; drained?: number; deferred?: number }

// 相对键（namespacedKv 补 `${appId}.${databaseId}.` 根前缀 → `${ns}.internal.pending_deletions`）。
const DELQ_KEY = "internal.pending_deletions";

export function createDelete(cfg: DeleteCfg) {
  const { cloud, local, head, kv, busy: _busy = passBusy } = cfg;

  // 队列条目。deleteEventId 是**持久化字段**（human consent 2026-07-18）：离线删时本地腿此刻就落地了，
  //   云腿要等回线 drain 才写——不把 id 存下来，两腿就再也配不上对（回收站里一次删除会裂成两行）。
  //   旧条目（升级前入队的）没有这个字段 → drain 时现生成一个，代价仅是那几条配不上对。
  interface DelQueueEntry { name: string; baseEtag: string | null; deleteEventId?: string }
  function readQueue(): DelQueueEntry[] {
    try { const raw = kv.get(DELQ_KEY); return raw ? JSON.parse(raw) : []; } catch (e) { reportStoreError(e, "log"); return []; }
  }
  function writeQueue(q: DelQueueEntry[]): void {
    if (q.length) kv.set(DELQ_KEY, JSON.stringify(q)); else kv.remove(DELQ_KEY);
  }
  function enqueue(name: string, baseEtag: string | null, deleteEventId: string): void {
    const q = readQueue().filter((e) => e.name !== name);   // 同名去重，最新覆盖
    q.push({ name, baseEtag, deleteEventId });
    writeQueue(q);
  }

  async function del(name: string, opts: DelOpts = {}): Promise<DelResult> {
    const { isOnline = () => true, confirm, onDirtyWarn, busy = _busy } = opts;
    if (confirm && !(await confirm({ title: "删除", body: name, danger: true }))) return { status: "cancelled" };
    if (head.isDirty(name) && onDirtyWarn && !(await onDirtyWarn({ name }))) return { status: "cancelled" };

    const localPresent = local ? await local.exists(name) : false;
    // ★一次删除 = 一个 deleteEventId，两条腿（本地 .trash / 云端 .trash）**共用**它。
    //   两端据此精确配对（trash-merge）。以前两边各生成各的 → 只能"按时间戳排序后按下标配对"，
    //   单腿删除交叉时会把两次无关的删除配成一行 → purge 掉两个不相干的文件还只报删了一个。
    const deleteEventId = asideStamp(Date.now());
    if (!isOnline()) {
      const baseEtag = cloud.getETag(name);                 // 供重放时 If-Match 式守卫
      let trashKey: string | null = null;
      if (localPresent) trashKey = await local!.trash(name, deleteEventId);
      // Finding 1（port 自 WebPaint store.ts，2026-06-21 静态论证）：仅当有已知云端 base(etag) 才排云删。
      //   null base = 本地 only / 从未同步——云端没有可证明属己的版本；若仍排队，重连时 base-etag 守卫因 null
      //   短路，会盲删**同名的别设备新文件**（红线：不得静默删未证实属己的内容）。故 null base 不排队。
      const queuedCloudDelete = baseEtag != null;
      if (queuedCloudDelete) enqueue(name, baseEtag, deleteEventId);   // id 随队列持久化，回线 drain 时云腿用同一个
      head.forget(name);
      return { status: "trashed", where: "local", queuedCloudDelete, baseEtag, trashKey };
    }
    return busy("删除中…", async () => {
      let cloudPresent = false;
      try { cloudPresent = !!(await cloud.fetchMeta(name)); } catch (e) { reportStoreError(e, "log"); cloudPresent = false; }
      if (cloudPresent) {
        const wasDirty = head.isDirty(name);                // ★trash 前取（trash 后谱系会被 forget）
        const trashed = await cloud.trash(name, deleteEventId);   // 先云端进 .trash（失败抛 → 本地不动）
        if (localPresent) {
          if (wasDirty) {
            // #42：本地有未推改动（这份字节世界唯一）→ 先解绑云端谱系变 local-only，再移进**本地** .trash
            //   （可恢复，绝不 hardDelete 未推字节）。云端版已进云端 .trash。
            head.forget(name);
            const trashKey = await local!.trash(name, deleteEventId);   // 同一个 id → 两腿配得上对
            return { status: "trashed", where: "both", trashed, trashKey };
          }
          await local!.hardDelete(name);                    // #34 offloadable 干净副本=云端 .trash 已救着 → 硬删不留双份
        }
        head.forget(name);
        return { status: "trashed", where: "cloud", trashed };
      }
      if (localPresent) { const trashKey = await local!.trash(name, deleteEventId); head.forget(name); return { status: "trashed", where: "local", trashKey }; }
      return { status: "noop" };
    });
  }

  // 离线删除重放：按 base-etag 收敛；被别处改过 → delete-vs-edit 默认 edit-wins（不删）。
  async function replayDelete(name: string, opts: { baseEtag?: string | null; deleteEventId?: string } = {}): Promise<DelResult> {
    const { baseEtag } = opts;
    // 旧队列条目没存 id → 现生成（那几条注定和本地腿配不上，裂成两行；不丢数据）。
    const deleteEventId = opts.deleteEventId ?? asideStamp(Date.now());
    let meta;
    try { meta = await cloud.fetchMeta(name); } catch (e) { reportStoreError(e, "log"); return { status: "deferred-offline" }; }
    if (!meta) return { status: "converged", reason: "already-gone" };
    // Finding 1 防御纵深（port 自 WebPaint）：无 base 不得 trash——无法证明云端这份就是我们删的那份
    //   （可能是别设备同名新文件）。正常路径 del() 已不再为 null base 排队；这里再兜一层，保护 drainDeleteQueue 直调。终态。
    if (!baseEtag) return { status: "skipped-no-base" };
    if (meta.etag !== baseEtag) return { status: "conflict-edit-wins" };
    // ★ 读比对只是**第一道**。真正的 edit-wins 由 trash 里的 If-Match 强制（v435）：
    //   上面这次 fetchMeta 与下面那次 move 之间隔着 _find + ensureFolder 两次往返，
    //   别设备在这个窗口推新版 → 比对已放行 → 新字节被搬进 .trash。412 → 同样收敛成 conflict-edit-wins。
    try {
      return { status: "trashed", trashed: await cloud.trash(name, deleteEventId, { baseEtag }) };
    } catch (e) {
      if ((e as { status?: number })?.status === 412) return { status: "conflict-edit-wins" };
      throw e;
    }
  }

  async function drainDeleteQueue(): Promise<DelResult> {
    const q = readQueue();
    if (!q.length) return { status: "drained", drained: 0, deferred: 0 };
    const remain: typeof q = [];
    let drained = 0;
    for (const e of q) {
      let r: DelResult;
      try { r = await replayDelete(e.name, { baseEtag: e.baseEtag, deleteEventId: e.deleteEventId }); } catch (err) { reportStoreError(err, "log"); remain.push(e); continue; }
      if (r.status === "deferred-offline") remain.push(e); else drained++;   // 终态出队
    }
    writeQueue(remain);
    return { status: "drained", drained, deferred: remain.length };
  }

  return { del, replayDelete, drainDeleteQueue };
}
