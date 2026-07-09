// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// delete（深模块）—— 删除 = move-aside（绝不硬删脏字节）。单一职责 = 三态删除 + 离线删队列：
//   三态：仅本地 / 仅云端 / 两者（两者→云端进 .trash + 本地干净副本直删，不留双份；本地脏→降级 local-only）。
//   离线：本地 move-aside + 持久化排队（base-etag 守卫），重连 drainDeleteQueue 重放——
//   被别处改过（含同名新文件）→ conflict-edit-wins → **不删**（防"旧设备攒删除很久后上线删掉别人的新文件"）。
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

const DELQ_KEY = "delqueue:v1";

export function createDelete(cfg: DeleteCfg) {
  const { cloud, local, head, kv, busy: _busy = passBusy } = cfg;

  function readQueue(): Array<{ name: string; baseEtag: string | null }> {
    try { const raw = kv.get(DELQ_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
  }
  function writeQueue(q: Array<{ name: string; baseEtag: string | null }>): void {
    if (q.length) kv.set(DELQ_KEY, JSON.stringify(q)); else kv.remove(DELQ_KEY);
  }
  function enqueue(name: string, baseEtag: string | null): void {
    const q = readQueue().filter((e) => e.name !== name);   // 同名去重，最新覆盖
    q.push({ name, baseEtag });
    writeQueue(q);
  }

  async function del(name: string, opts: DelOpts = {}): Promise<DelResult> {
    const { isOnline = () => true, confirm, onDirtyWarn, busy = _busy } = opts;
    if (confirm && !(await confirm({ title: "删除", body: name, danger: true }))) return { status: "cancelled" };
    if (head.isDirty(name) && onDirtyWarn && !(await onDirtyWarn({ name }))) return { status: "cancelled" };

    const localPresent = local ? await local.exists(name) : false;
    if (!isOnline()) {
      const baseEtag = cloud.getETag(name);                 // 供重放时 If-Match 式守卫
      let trashKey: string | null = null;
      if (localPresent) trashKey = await local!.trash(name);
      // Finding 1（port 自 WebPaint store.ts，2026-06-21 静态论证）：仅当有已知云端 base(etag) 才排云删。
      //   null base = 本地 only / 从未同步——云端没有可证明属己的版本；若仍排队，重连时 base-etag 守卫因 null
      //   短路，会盲删**同名的别设备新文件**（红线：不得静默删未证实属己的内容）。故 null base 不排队。
      const queuedCloudDelete = baseEtag != null;
      if (queuedCloudDelete) enqueue(name, baseEtag);
      head.forget(name);
      return { status: "trashed", where: "local", queuedCloudDelete, baseEtag, trashKey };
    }
    return busy("删除中…", async () => {
      let cloudPresent = false;
      try { cloudPresent = !!(await cloud.fetchMeta(name)); } catch { cloudPresent = false; }
      if (cloudPresent) {
        const wasDirty = head.isDirty(name);                // ★trash 前取（trash 后谱系会被 forget）
        const trashed = await cloud.trash(name);            // 先云端进 .trash（失败抛 → 本地不动）
        if (localPresent) {
          if (wasDirty) {
            // #42：本地有未推改动（这份字节世界唯一）→ 先解绑云端谱系变 local-only，再移进**本地** .trash
            //   （可恢复，绝不 hardDelete 未推字节）。云端版已进云端 .trash。
            head.forget(name);
            const trashKey = await local!.trash(name);
            return { status: "trashed", where: "both", trashed, trashKey };
          }
          await local!.hardDelete(name);                    // #34 offloadable 干净副本=云端 .trash 已救着 → 硬删不留双份
        }
        head.forget(name);
        return { status: "trashed", where: "cloud", trashed };
      }
      if (localPresent) { const trashKey = await local!.trash(name); head.forget(name); return { status: "trashed", where: "local", trashKey }; }
      return { status: "noop" };
    });
  }

  // 离线删除重放：按 base-etag 收敛；被别处改过 → delete-vs-edit 默认 edit-wins（不删）。
  async function replayDelete(name: string, opts: { baseEtag?: string | null } = {}): Promise<DelResult> {
    const { baseEtag } = opts;
    let meta;
    try { meta = await cloud.fetchMeta(name); } catch { return { status: "deferred-offline" }; }
    if (!meta) return { status: "converged", reason: "already-gone" };
    // Finding 1 防御纵深（port 自 WebPaint）：无 base 不得 trash——无法证明云端这份就是我们删的那份
    //   （可能是别设备同名新文件）。正常路径 del() 已不再为 null base 排队；这里再兜一层，保护 drainDeleteQueue 直调。终态。
    if (!baseEtag) return { status: "skipped-no-base" };
    if (meta.etag !== baseEtag) return { status: "conflict-edit-wins" };
    return { status: "trashed", trashed: await cloud.trash(name) };
  }

  async function drainDeleteQueue(): Promise<DelResult> {
    const q = readQueue();
    if (!q.length) return { status: "drained", drained: 0, deferred: 0 };
    const remain: typeof q = [];
    let drained = 0;
    for (const e of q) {
      let r: DelResult;
      try { r = await replayDelete(e.name, { baseEtag: e.baseEtag }); } catch { remain.push(e); continue; }
      if (r.status === "deferred-offline") remain.push(e); else drained++;   // 终态出队
    }
    writeQueue(remain);
    return { status: "drained", drained, deferred: remain.length };
  }

  return { del, replayDelete, drainDeleteQueue };
}
