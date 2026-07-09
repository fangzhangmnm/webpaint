// ⚠ 使用前必读 README.md + CONTEXT.md。store 内部深模块——app 经 createStore 的 store.listAllItems，**不 deep import**。
//
// listing（深模块）—— 虚拟文件系统的**统一列举**。把 local(IDB) ∪ cloud 收成一份 Item[]，
//   每项带解析好的 syncState（8-badge）。**offline-first 是结构性的**：云那半拿不到（离线/登出/抛错）
//   → items 仍从本地 appKeys 产出，**绝不返空、绝不 throw**。
//
// ★ 旧 app 层的 mergeLocalCloud（本地 ∪ 云端 union）**收进这里**。理由（store/CONTEXT.md §反-duplicate）：
//   「什么在本地」是 store 独占职责，app 拿不到 etag/dirty/online→喂不到 union 的输入。两个 app（WebPaint/JRP）
//   各自在 app 层重推过一次 union = 越狱，JRP 还漏了本地那半 = 登出/离线看不了本地论文的根因。收进库后不可能再漏。
//
// 纯分类器 classifySyncState 可穷举单测（对齐 reconcile.classifyCloudGone 的纪律）。
import type { CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";

// syncState = residency(住哪) ⟂ sync-status(clean/dirty/conflict/gone) 两轴的 derived 投影。
//   （单一 Residency 太薄——这是「sync state 更复杂」的落地。8 值对齐 PWAPatterns state-machine.md 的 badge。）
export type SyncState =
  | "cloud-only"        // 有云 etag、无本地副本（唯一「不在本地」态）
  | "synced"            // bound ∧ clean ∧ 云没动
  | "unpushed"          // bound ∧ dirty ∧ 云没动（↑ 有未推枝）
  | "newer-on-cloud"    // bound ∧ clean ∧ cloudMoved（⟳ 云有新版待 pull）
  | "conflict"          // bound ∧ dirty ∧ cloudMoved（⚠ 两端都动）
  | "ghost"             // dirty ∧ cloudGone（👻 云端没了但有未推字节，绝不删）
  | "float"             // ¬bound ∧ dirty（纯本地、从没 synced、有编辑）
  | "local-only";       // 本地、从没 synced、clean（真本地文件）

export interface Item {
  path: string;         // 身份 = approot 相对路径。格式无关 + provider 无关（唯一跨后端 key；itemId/内容哈希均否决）
  syncState: SyncState; // 按 ListContext 解析好的 badge —— Item 上就这一个状态字段（防下游 AI 重推导越狱）
  size?: number;
  lastModified?: number;// sort-by-date 用（epoch ms）
}

export interface ListContext { signedIn: boolean; online: boolean; }   // syncState 的可解析度由它决定（用户拍板：store 吃 ctx、返解析好的 badge）

// 便利判定：**单一来源=syncState**，纯函数，**别在 Item 上加 cached/dirty 字段**（多一个字段=多一条下游越狱路径）。
export function isCached(s: SyncState): boolean { return s !== "cloud-only"; }   // 有本地副本 → 离线可读
export function isDirty(s: SyncState): boolean {                                 // 有未推本地编辑 → 永不被驱逐
  return s === "unpushed" || s === "conflict" || s === "float" || s === "ghost";
}

// ── 纯分类器（零 IO，可穷举单测）：一个 path 的原始事实 → syncState ──────────────────────
//   authoritative 分两级（对齐 reconcile 的失败-fetch 守卫）：
//     cloudReachable      = 拿到了云列表（在线 ∧ 登录 ∧ listAll 没抛错）——决定「云轴可不可解析」
//     absenceAuthoritative= 且 complete=true——决定「没看到=真没了」是否可信（partial 里缺失≠云端真没了，绝不据此判 gone）
export function classifySyncState(f: {
  hasLocal: boolean;
  hasCloud: boolean;           // 云列表里有（hasCloud=true 永远可信；=false 仅 absenceAuthoritative 时可信）
  everSynced: boolean;         // seenBase != null（有已知云版）
  cloudMoved: boolean;         // hasCloud ∧ cloudEtag ≠ seenBase
  dirty: boolean;              // head.isDirty
  cloudReachable: boolean;
  absenceAuthoritative: boolean;
}): SyncState {
  if (!f.hasLocal) return "cloud-only";                 // union 保证：到这一定 hasCloud
  // ── 本地有副本 ────────────────────────────────────────────────
  if (!f.cloudReachable) {                              // 离线/登出：云轴不可知 → 塌到本地视角（用户在场也别谎报 synced）
    if (f.dirty) return f.everSynced ? "unpushed" : "float";
    return "local-only";
  }
  // ── cloudReachable ───────────────────────────────────────────
  if (f.hasCloud) {                                     // 云端确实有（可信，无关 complete）
    const moved = f.cloudMoved || !f.everSynced;        // 没 baseline(!everSynced 却撞上云端同名) 也当「云端有别的版本」
    if (moved) return f.dirty ? "conflict" : "newer-on-cloud";
    return f.dirty ? "unpushed" : "synced";
  }
  // ── 云列表里没有 ──────────────────────────────────────────────
  if (!f.everSynced) return f.dirty ? "float" : "local-only";   // 从没 synced = 真本地新文件，云端本就没有
  if (!f.absenceAuthoritative) return f.dirty ? "unpushed" : "synced";  // partial：没看到≠没了 → 保守显示「仍在」
  return f.dirty ? "ghost" : "local-only";              // 真 cloud-gone：dirty→👻ghost（绝不删）；clean 孤儿→local-only（reconcile 会清 etag 轨道）
}

// ── 编排：union(cloud.listAll, local.appKeys) ⋈ local-head → Item[] ─────────────────────
export interface ListingCfg {
  cloud: Pick<CloudSync, "listAll" | "getETag">;
  local: Pick<LocalCache, "appKeys">;
  head: Pick<LocalHead, "seenBase" | "isDirty">;
  pendingFolders?: () => string[];   // 离线建、尚未确认上云的空文件夹（folder-registry；并进 folders 让它离线可见）
}

const toMs = (v: string | number | undefined): number | undefined => {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
};

export function createListing(cfg: ListingCfg) {
  const { cloud, local, head, pendingFolders } = cfg;

  async function listAllItems(ctx: ListContext): Promise<{ items: Item[]; folders: string[]; complete: boolean }> {
    // 云那半：仅在线 ∧ 登录才取；抛错 → null（优雅降级，绝不 throw、绝不据此清本地）。
    const cloudRes = (ctx.online && ctx.signedIn) ? await cloud.listAll().catch(() => null) : null;
    const cloudReachable = cloudRes != null;
    const absenceAuthoritative = cloudReachable && cloudRes!.complete === true;

    const cloudMap = new Map<string, { eTag: string; size: number; lastModified?: number }>();
    for (const c of cloudRes?.files ?? []) {
      cloudMap.set(c.path, { eTag: c.eTag, size: c.size, lastModified: toMs(c.lastModifiedDateTime) });
    }
    const localSet = new Set(await local.appKeys());

    const paths = new Set<string>();
    for (const p of cloudMap.keys()) paths.add(p);
    for (const p of localSet) paths.add(p);

    const items: Item[] = [];
    for (const path of paths) {
      const hasCloud = cloudMap.has(path);
      const hasLocal = localSet.has(path);
      const cf = cloudMap.get(path);
      const seen = head.seenBase(path);           // _base 或回退持久 etag = 最后已知云版
      const everSynced = seen != null;
      const cloudMoved = hasCloud && cf!.eTag !== seen;
      const syncState = classifySyncState({
        hasLocal, hasCloud, everSynced, cloudMoved,
        dirty: head.isDirty(path),
        cloudReachable, absenceAuthoritative,
      });
      items.push({ path, syncState, size: cf?.size, lastModified: cf?.lastModified });
    }

    // folders = 云 folders(可达时) ∪ 本地 pending 空夹（离线建的）。去重。
    const folderSet = new Set<string>(cloudRes?.folders ?? []);
    for (const p of pendingFolders?.() ?? []) folderSet.add(p);

    return { items, folders: [...folderSet], complete: cloudReachable ? cloudRes!.complete : false };
  }

  return { listAllItems };
}
