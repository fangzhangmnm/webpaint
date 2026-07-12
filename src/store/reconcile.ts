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
  cloud: Pick<CloudSync, "listAll" | "listFolder" | "clearState">;
  local: Pick<LocalCache, "appKeys">;
  head: Pick<LocalHead, "seenBase" | "isDirty" | "forget">;
  isOnline?: () => boolean;
}

export function createReconcile(cfg: ReconcileCfg) {
  const { cloud, local, head, isOnline } = cfg;

  // 共用收敛：给一组 localNames + 权威 cloudNameSet → demote clean 孤儿（清两条 etag 轨道；本地 blob 不动）。
  function converge(localNames: string[], cloudNames: Set<string>, authoritative: boolean, activeName?: string): { demoted: string[] } {
    const { demote } = classifyCloudGone(localNames, cloudNames, {
      seenBase: (n) => head.seenBase(n),
      isDirty: (n) => head.isDirty(n),
      authoritative,
      skip: activeName ? (n) => n === activeName : undefined,
    });
    for (const name of demote) { cloud.clearState(name); head.forget(name); }
    return { demoted: demote };
  }

  // **全库** cloud-gone 收敛——**仅用户显式指令**（将来隐藏的「校验完整性」入口），**绝不自动/轮询**。
  //   全树 listAll（每个子夹一次 Graph 往返）是重活；日常开夹惰性收敛走 reconcileFolder。空列表守卫防网抖误删。
  async function reconcile(opts: { activeName?: string } = {}): Promise<{ demoted: string[] }> {
    if (isOnline && !isOnline()) return { demoted: [] };                  // 离线 → 不权威
    const all = await cloud.listAll().catch(() => null);                  // 未登录/网失败 → null
    const authoritative = !!(all && all.complete && all.files.length > 0);  // 失败-fetch + 空列表守卫
    if (!authoritative) return { demoted: [] };
    const cloudNames = new Set(all!.files.map((f) => f.path ?? f.name));
    return converge(await local.appKeys(), cloudNames, authoritative, opts.activeName);
  }

  // **单夹** cloud-gone 收敛——「看到 folder 才 reconcile」（watchFolder 的 remote pass 副作用），非静默、非全扫。
  //   authoritative = 这一夹 list() 没抛错（complete）。空夹合法（per-folder 下「空」≠网抖，与 reconcile 的空列表守卫不同）。
  //   只判**该夹直属**本地文件（startsWith(prefix) ∧ 无更深 slash）——身份=path、不跨夹追踪：别夹的 clean 文件永不被本次降级。
  async function reconcileFolder(folder: string, opts: { activeName?: string } = {}): Promise<{ demoted: string[] }> {
    if (isOnline && !isOnline()) return { demoted: [] };
    const res = await cloud.listFolder(folder).catch(() => null);
    if (!res || !res.complete) return { demoted: [] };                   // 这一夹没列全 → 不权威 → no-op（绝不据此判 gone）
    const cloudNames = new Set(res.files.map((f) => f.path ?? f.name));
    const prefix = folder ? `${folder}/` : "";
    const localNames = (await local.appKeys()).filter((k) => {
      if (folder && !k.startsWith(prefix)) return false;
      const rest = k.slice(prefix.length);
      return rest.length > 0 && !rest.includes("/");                     // 仅本夹直属文件
    });
    return converge(localNames, cloudNames, true, opts.activeName);
  }

  return { reconcile, reconcileFolder };
}
