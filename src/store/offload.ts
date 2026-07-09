// ⚠ 使用前必读 README.md + DATA SAFETY GUIDELINE.md。store 内部深模块——app 经 createStore 的 file.offload。
//
// offload（深模块）—— 移除本地副本（offload ≠ delete：只丢本地，云端不动）。语义对齐 WebPaint unload。
//   只在「本地是云端某完整版的可重取 shadow」时合法 → hardDelete（不进 local trash，clean 可重下）。
//   否则本地是**世界唯一副本**（local-only / 未上传 / sync 事故 / dirty / forked / cloud-gone / 离线）→ offload **不适用**
//   → 抛 OffloadIllegalError（内部错误，经 ui.reportError 出 banner；UX 不该暴露非法 offload，#29）。绝不静默丢字节。
//
// 合法判定（用 local-head 已固化的 etag 谱系逻辑，不发明新东西）：
//   exists ∧ !head.isDirty ∧ 在线 ∧ head.seenBase!=null（曾 synced = 有已知云版 = re-fetchable，对齐 WebPaint「有 etag」）
//   ∧ cloud.fetchMeta 存在（未登录会取不到 → cloud-gone）∧ meta.size>0（挡历史 0B 云端幻象）。
//   cloudMoved（云端被别人推新版、etag≠seenBase）仍合法：clean 本地下次 open 会快进，重取拿更新版，不丢。
import type { CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";

export type OffloadIllegalReason = "dirty" | "offline" | "local-only" | "cloud-gone" | "incomplete";

export class OffloadIllegalError extends Error {
  code = "OFFLOAD_ILLEGAL";
  reason: OffloadIllegalReason;
  constructor(name: string, reason: OffloadIllegalReason) {
    super(`offload "${name}" 不适用（${reason}）：本地是世界唯一副本或不可重取，拒绝丢弃。`);
    this.name = "OffloadIllegalError";
    this.reason = reason;
  }
}

export interface OffloadCfg {
  cloud: Pick<CloudSync, "fetchMeta">;
  local: Pick<LocalCache, "exists" | "hardDelete">;
  head: Pick<LocalHead, "isDirty" | "seenBase" | "forget">;
  isOnline?: () => boolean;
  // 同名串行（sub.serialize）：让 offload 的 hardDelete 与 file.save 的 local 写互斥。
  //   缺它（默认直通）= 退回旧 TOCTOU 行为，仅靠下面的 re-check 兜宽窗口。
  serialize?: <T>(name: string, fn: () => T | Promise<T>) => Promise<T>;
}

export function createOffload(cfg: OffloadCfg) {
  const { cloud, local, head, isOnline } = cfg;
  const serialize = cfg.serialize ?? (<T>(_n: string, fn: () => T | Promise<T>) => Promise.resolve().then(fn));
  // offload 永远是用户显式动作（无自动 LRU）。非法态抛错（不软返回 kept），合法态 hardDelete。
  // 红线（DATA SAFETY §A 最毒条）：驱逐绝不吃未推唯一字节。check-then-act 跨 fetchMeta 网络期 →
  //   ① 整体进同名 serialize 链：与 file.save 的 local 写互斥（hardDelete 不和并发写交错）。
  //   ② fetchMeta 后 re-check isDirty（对齐 freshness.ts:87 的 TOCTOU 守卫）：网络期内并发 save 标了脏 → 立即拒。
  async function offload(name: string): Promise<void> {
    return serialize(name, async () => {
      if (!(await local.exists(name))) return;                                      // 本地没副本 → 无事可做（非危险，no-op）
      if (head.isDirty(name)) throw new OffloadIllegalError(name, "dirty");          // 未推唯一字节
      if (isOnline && !isOnline()) throw new OffloadIllegalError(name, "offline");   // 不可重取
      if (head.seenBase(name) == null) throw new OffloadIllegalError(name, "local-only");  // 从没 synced = 无已知云版 = 唯一本地
      const meta = await cloud.fetchMeta(name).catch(() => null);                    // 未登录/取不到 → null
      if (!meta) throw new OffloadIllegalError(name, "cloud-gone");                  // 云端没了 → 唯一好副本，保留
      if (!(meta.size > 0)) throw new OffloadIllegalError(name, "incomplete");       // 0B 云端幻象 → 不可信，绝不据此丢本地
      if (head.isDirty(name)) throw new OffloadIllegalError(name, "dirty");          // ② TOCTOU re-check：fetchMeta 期内被并发 save 写脏 → 拒
      await local.hardDelete(name);   // 合法：clean ∧ 在线 ∧ 曾synced ∧ 云端有完整版 → 安全丢本地副本（可重下）
      head.forget(name);              // 清云端谱系（下次 open 重新 acquire）
    });
  }
  return { offload };
}
