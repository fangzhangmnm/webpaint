// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// trash（深模块）—— 回收站生命周期：restore / purge / emptyTrash。单一职责 = .trash 的恢复与彻底删：
//   restore：本地先恢复（撞名自动 (2)）→ 云端按同名恢复；采纳恢复出的云 item etag（move→新 etag）。
//   purge：永久删（不可恢复）→ 强制 danger confirm。
//   emptyTrash：批量彻底删，本地/云端一处清，逐项独立 try、失败汇总不静默；**强退=cancel，绝不自动续**。
import type { CloudItem, CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";

type Busy = <T>(label: string, fn: () => Promise<T>) => Promise<T>;
const passBusy: Busy = (_l, fn) => fn();

export interface TrashCfg {
  cloud: Pick<CloudSync, "restore" | "purge" | "listTrash">;
  local?: Pick<LocalCache, "restore" | "purgeTrash" | "listTrash">;
  head: Pick<LocalHead, "markSeen">;
  busy?: Busy;
}
export interface RestoreOpts { fromCloud?: boolean; cloudItemId?: string | null; targetName?: string; trashKey?: string | null; busy?: Busy }
export interface PurgeOpts { trashKey?: string | null; cloudItemId?: string | null; confirm?: (ctx: { title: string; body: string; danger?: boolean }) => boolean | Promise<boolean>; busy?: Busy }
export interface EmptyTrashOpts { isOnline?: () => boolean; busy?: Busy; concurrency?: number; scope?: "local" | "cloud" | "both" }
export interface TrashResult { status: string; name?: string | null; local?: boolean; cloud?: boolean; purged?: number; failed?: unknown[] }

export function createTrash(cfg: TrashCfg) {
  const { cloud, local, head, busy: _busy = passBusy } = cfg;

  async function restore(opts: RestoreOpts = {}): Promise<TrashResult> {
    const { fromCloud, cloudItemId, targetName, trashKey, busy = _busy } = opts;
    return busy("恢复中…", async () => {
      let name: string | null = targetName || null, restoredLocal = false, restoredCloud = false;
      if (trashKey && local) { const n = await local.restore(trashKey); if (n) { name = n; restoredLocal = true; } }
      if (fromCloud && cloudItemId != null) {
        const ritem = await cloud.restore(cloudItemId, (name || targetName)!) as { eTag?: string | null };
        restoredCloud = true;
        // 采纳恢复出的云 item etag（restore 是 move → 新 etag）→ 之后 push 有 base，不对自己的文件弹假撞名。
        const rname = name || targetName;
        if (rname && ritem && ritem.eTag) head.markSeen(rname, ritem.eTag);
      }
      if (!restoredLocal && !restoredCloud) return { status: "noop" };
      return { status: "restored", name, local: restoredLocal, cloud: restoredCloud };
    });
  }

  async function purge(opts: PurgeOpts = {}): Promise<TrashResult> {
    const { trashKey, cloudItemId, confirm, busy = _busy } = opts;
    if (confirm && !(await confirm({ title: "彻底删除", body: "不可恢复", danger: true }))) return { status: "cancelled" };
    return busy("彻底删除…", async () => {
      if (trashKey && local && local.purgeTrash) await local.purgeTrash(trashKey);
      if (cloudItemId != null) await cloud.purge(cloudItemId);
      return { status: "purged" };
    });
  }

  // 批量彻底删：scope 选端（"local"/"cloud"/"both"）。强退=cancel（绝不自动续：下次 trash 可能已有新 item）。
  async function emptyTrash(opts: EmptyTrashOpts = {}): Promise<TrashResult> {
    const { isOnline, busy = _busy, concurrency = 5, scope = "both" } = opts;
    return busy("清空回收站…", async () => {
      let purged = 0; const failed: { name?: string; where: string; error: string }[] = [];
      const errMsg = (e: unknown) => String((e as { message?: unknown })?.message || e);
      if (scope !== "cloud" && local && local.listTrash && local.purgeTrash) {
        for (const t of await local.listTrash()) {
          try { await local.purgeTrash(t.trashKey); purged++; }
          catch (e) { failed.push({ name: t.name, where: "local", error: errMsg(e) }); }
        }
      }
      if (scope !== "local" && (!isOnline || isOnline())) {
        let items: CloudItem[] | null = null;
        try { items = await cloud.listTrash(); } catch (e) { failed.push({ where: "cloud-list", error: errMsg(e) }); }
        items = items || [];
        for (let i = 0; i < items.length; i += concurrency) {   // bounded 并发，快约 N×
          await Promise.all(items.slice(i, i + concurrency).map(async (it) => {
            try { await cloud.purge(it.id); purged++; }
            catch (e) { failed.push({ name: it.name, where: "cloud", error: errMsg(e) }); }
          }));
        }
      }
      return { status: "emptied", purged, failed };
    });
  }

  return { restore, purge, emptyTrash };
}
