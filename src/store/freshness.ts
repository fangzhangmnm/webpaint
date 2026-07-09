// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// freshness（深模块）—— 进入/事件时的"云端动没动 → clean 快进 / dirty surface"。单一职责 =
//   freshness gate（ADR-0016）：比 seenBase vs 云端 etag；clean 且动过 → 静默无损快进；
//   dirty 且动过 → 交 ui 选（绝不静默覆盖 dirty）。编排 local-head.seenBase/isDirty + safe-resolve.safePull。
//   open = 开 session 的 gate（probe 可跳到离线）；refresh = 事件驱动(focus/visibility/online)的纯干净快进。
import type { CloudSync, FetchMetaResult } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
import type { SafeResolve, ResolveChoice } from "./safe-resolve.ts";

type Busy = <T>(label: string, fn: () => Promise<T>) => Promise<T>;
const passBusy: Busy = (_l, fn) => fn();
type AdoptFn = (plain: Blob, name: string) => unknown | Promise<unknown>;

export interface FreshnessCfg {
  cloud: Pick<CloudSync, "fetchMeta">;
  head: Pick<LocalHead, "seenBase" | "isDirty" | "markSeen">;
  safeResolve: Pick<SafeResolve, "safePull">;
  busy?: Busy;
}

export interface OpenOpts {
  isOnline?: () => boolean;
  probe?: Promise<unknown> | unknown;            // E8：与 metadata race，先到先得（无硬超时）
  onNewer?: (ctx: { name: string; cloudEtag: string; baseEtag: string | null; cloudTime: string | number }) => ResolveChoice | Promise<ResolveChoice>;
  adopt?: AdoptFn;
  localDirty?: () => boolean;
  busy?: Busy;
}
export interface RefreshOpts {
  isOnline?: () => boolean;
  adopt?: AdoptFn;
  localDirty?: () => boolean;
  onReplaceStart?: () => void;                   // N10：真要拉内容（动过+clean）才触发，app 给非阻塞 status
  busy?: Busy;
}
export interface FreshResult { source?: string; status?: string; reason?: string; backupName?: string; error?: unknown }

export function createFreshness(cfg: FreshnessCfg) {
  const { cloud, head, safeResolve, busy: _busy = passBusy } = cfg;

  async function open(name: string, opts: OpenOpts = {}): Promise<FreshResult> {
    const { isOnline = () => true, probe, onNewer, adopt, localDirty, busy = passBusy } = opts;
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
        try { meta = await cloud.fetchMeta(name); } catch { return { source: "local", reason: "cloud-error" }; }
      }
      if (!meta) return { source: "local", reason: "cloud-absent" };
      const base = head.seenBase(name);
      if (!base || meta.etag === base) {
        // 云端 === 本 tab 已见 base（没动）→ in-sync。reload 后内存 _base 空（seenBase 回退共享 etag），
        //   此时 markSeen 重捕 _base（dirty 还顺带重捕 _parent，local-head.ts:82）→ 闭合「dirty 但 _base 空 →
        //   下次推走 no-base fail → 误报 CloudNameCollisionError」窗口。只在 meta.etag===base（云端没动）调=安全：
        //   云端动过会落到下面 dirty→surface 路径，绝不在这里前推 parent（防 B1 silent-overwrite）。
        if (base != null) head.markSeen(name, meta.etag);
        return { source: "local", reason: "in-sync" };
      }
      const dirty = head.isDirty(name) || (localDirty ? localDirty() : false);
      if (!dirty) {                                       // clean → 静默快进（无 sheet；safePull 因 clean 跳备份）
        const r = await safeResolve.safePull(name, { adopt });
        return r.ok ? { source: "fast-forwarded", backupName: r.backupName } : { source: "local", reason: r.reason, error: r.error };
      }
      // dirty 分叉 → 交 ui（takeCloud=拉 / keepMine|cancel=留本地）
      const choice = onNewer ? await onNewer({ name, cloudEtag: meta.etag, baseEtag: base, cloudTime: meta.lastModified }) : "cancel";
      if (choice === "takeCloud") {
        const r = await safeResolve.safePull(name, { adopt });
        return r.ok ? { source: "pulled", backupName: r.backupName } : { source: "local", reason: r.reason, backupName: r.backupName, error: r.error };
      }
      return { source: "local", reason: "kept" };
    });
  }

  // 事件驱动干净快进：dirty → no-op（绝不在事件里弹 sheet；后续 push 的 412 会 surface 真分叉）。
  async function refresh(name: string, opts: RefreshOpts = {}): Promise<FreshResult> {
    const { isOnline = () => true, adopt, localDirty, onReplaceStart, busy = passBusy } = opts;
    if (!isOnline()) return { status: "offline" };
    if (head.isDirty(name) || (localDirty && localDirty())) return { status: "dirty-skip" };
    return busy("检查云端…", async () => {
      let meta: FetchMetaResult | null;
      try { meta = await cloud.fetchMeta(name); } catch { return { status: "cloud-error" }; }
      if (!meta) return { status: "cloud-absent" };
      const base = head.seenBase(name);
      if (!base || meta.etag === base) return { status: "in-sync" };
      if (head.isDirty(name) || (localDirty && localDirty())) return { status: "dirty-skip" };  // fetchMeta 期间用户动了笔 → 放弃
      if (onReplaceStart) onReplaceStart();
      const r = await safeResolve.safePull(name, { adopt });
      return r.ok ? { status: "fast-forwarded" } : { status: "ff-failed", reason: r.reason };
    });
  }

  return { open, refresh };
}
