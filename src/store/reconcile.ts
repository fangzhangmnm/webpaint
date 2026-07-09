// ⚠ 使用前必读 README.md + DATA SAFETY GUIDELINE.md。store 内部深模块——app 经 createStore 的 store.reconcile。
//
// reconcile（深模块）—— cloud-gone 收敛的**安全子集**（#43 用户 pin 的 fallback；参考 WebPaint v227-228
//   etag-tombstone、GUID-free 实现，对齐移植不发明）。只做一件事，且**绝不丢字节**：
//     曾 synced 的 clean 本地、云端 path 没了（孤儿）→ demote 成 local-only（清两条 etag 轨道，
//     本地 blob **原地留着，不 trash、不 hardDelete**）→ 下次 open 当真本地文件，不再误判「云端有新版」。
//   dirty 孤儿 → **原样留着（no-op）**：未推字节只此一份，绝不动。
//   从没 synced（seenBase==null）→ 真本地文件，永不碰。
//   **不做**：裂卡/ghost UI / split-card（未真机验的大件，CONTEXT.md ⏸ 暂缓）。
//
// 失败-fetch 守卫（命门）：列举不完整(partial) / 空列表 / 离线 → **不权威 → 整个 no-op**。
//   partial 里「某 name 缺失」≠「云端真没了」（可能子树列举失败）；空列表多半是未登录/网抖——
//   据此降级会误把一堆好文件断了云端谱系。所以只在「在线 ∧ listAll.complete ∧ 非空」时才收敛。
import type { CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";

// 纯分类器（零 IO、可穷举单测）：返回该 demote 的 clean 孤儿名。
//   规则（对齐 WebPaint gallery-model.classifyCloudGone，去掉 ghost/pin 轴——JRP 无 pin，dirty 孤儿一律留）：
//   not authoritative → 空 ｜ 云端还在 → skip ｜ seenBase==null(从没synced) → skip ｜ dirty → skip ｜ 余 = clean 孤儿 → demote
export function classifyCloudGone(
  localNames: string[],
  cloudNameSet: Set<string>,
  opts: {
    seenBase: (name: string) => string | null;
    isDirty: (name: string) => boolean;
    authoritative: boolean;
    skip?: (name: string) => boolean;   // K1：跳过当前打开的 doc，别在 session 中途断它谱系
  },
): { demote: string[] } {
  const demote: string[] = [];
  if (!opts.authoritative) return { demote };
  for (const name of localNames) {
    if (opts.skip?.(name)) continue;
    if (cloudNameSet.has(name)) continue;        // 云端还在 → 不是孤儿
    if (opts.seenBase(name) == null) continue;   // 从没 synced = 真本地文件 → 永不碰
    if (opts.isDirty(name)) continue;            // dirty 孤儿 → 留着（安全 fallback，不降级、不 surface）
    demote.push(name);                           // clean 孤儿 → 降级 local-only
  }
  return { demote };
}

export interface ReconcileCfg {
  cloud: Pick<CloudSync, "listAll" | "clearState">;
  local: Pick<LocalCache, "appKeys">;
  head: Pick<LocalHead, "seenBase" | "isDirty" | "forget">;
  isOnline?: () => boolean;
}

export function createReconcile(cfg: ReconcileCfg) {
  const { cloud, local, head, isOnline } = cfg;
  // gallery list-fetch 时调。activeName = 当前打开的 doc（K1 跳过，可选）。
  async function reconcile(opts: { activeName?: string } = {}): Promise<{ demoted: string[] }> {
    if (isOnline && !isOnline()) return { demoted: [] };                  // 离线 → 不权威
    const all = await cloud.listAll().catch(() => null);                  // 未登录/网失败 → null
    const authoritative = !!(all && all.complete && all.files.length > 0);  // 失败-fetch + 空列表守卫
    if (!authoritative) return { demoted: [] };
    const cloudNames = new Set(all!.files.map((f) => f.path ?? f.name));
    const localNames = await local.appKeys();
    const { demote } = classifyCloudGone(localNames, cloudNames, {
      seenBase: (n) => head.seenBase(n),
      isDirty: (n) => head.isDirty(n),
      authoritative,
      skip: opts.activeName ? (n) => n === opts.activeName : undefined,
    });
    for (const name of demote) { cloud.clearState(name); head.forget(name); }   // 清两条 etag 轨道；本地 blob 不动
    return { demoted: demote };
  }
  return { reconcile };
}
