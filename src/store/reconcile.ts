// ⚠ 使用前必读 README.md + DATA SAFETY GUIDELINE.md。store 内部深模块——app 经 createStore 的 store.reconcile。
//
// reconcile（深模块）—— cloud-gone 收敛（as-of 2026-07-17：**去抖后 send trash**，用户拍板升级；参考 WebPaint v227-228
//   etag-tombstone、GUID-free）：
//     曾 synced 的 clean 本地、云端 path 没了（孤儿）→ **去抖**（pending-gone）：第一次权威见 gone 只标 candidate
//     （照常显示 + pendingGone badge，不删）；连续第二次+且跨 GRACE(~24h) → `local.trash`（move-aside 可恢复）+ 清两条
//     etag 轨道 + 清 candidate。重现（云端权威又有）/被编辑（dirty）→ 自愈清 candidate。activeFileName 跳过当前打开的 doc。
//   dirty 孤儿 → **原样留着（no-op）**：未推字节只此一份，绝不动（ghost）。
//   从没 synced（seenBase==null）→ 真本地文件，永不碰。
//   **不做**：裂卡/ghost UI / split-card（未真机验的大件，CONTEXT.md ⏸ 暂缓）。
//
// 失败-fetch 守卫（命门）：列举不完整(partial) / 空列表 / 离线 → **不权威 → 整个 no-op**。
//   partial 里「某 name 缺失」≠「云端真没了」（可能子树列举失败）；空列表多半是未登录/网抖——
//   据此降级会误把一堆好文件断了云端谱系。所以只在「在线 ∧ listAll.complete ∧ 非空」时才收敛。
import type { CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
import type { PendingGone } from "./pending-gone.ts";
import { isHidden } from "./is-hidden.ts";   // 隐藏项（.trash/.backup/.<appId>/任意 dot）：云端已过滤，本地侧也别据此误判 gone
import { reportStoreError } from "./error-handling.ts";
import { asideStamp } from "./move-aside.ts";   // 单腿 trash 事件的 deleteEventId 生成器

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
  local: Pick<LocalCache, "appKeys" | "trash">;
  head: Pick<LocalHead, "seenBase" | "isDirty" | "forget">;
  pending: PendingGone;                 // 云端防抖（candidate-gone）标记
  now?: () => number;                   // 时钟（测试注入；默认 Date.now）
  isOnline?: () => boolean;
  activeFileName?: () => string | null;     // 当前打开的 doc（全名身份）——**去抖 trash 绝不碰活动 doc**（K1，reconcileFolder 也用，避免 trash 掉开着的 clean 文件本地缓存）
}

export function createReconcile(cfg: ReconcileCfg) {
  const { cloud, local, head, pending, isOnline, activeFileName: activeFileNameFn } = cfg;
  const now = cfg.now || (() => Date.now());
  const skipName = (opt?: string): string | undefined => opt ?? activeFileNameFn?.() ?? undefined;   // 显式 opts 优先，否则用 store 自持的活动 doc

  // 共用收敛（SSOT，reconcileAll + reconcileFolder + 各云端帧都经此）：给一组 localNames + **权威** cloudNameSet →
  //   clean 孤儿走**去抖**：第一次权威见 gone → 标 candidate（照常显示 + pendingGone badge，不删）；连续第二次+且跨 GRACE
  //   → 本地 send trash（云端已 gone，可恢复）+ 清两条 etag 轨道 + 清 candidate。重现/被编辑 dirty → 自愈清 candidate。
  //   **非权威（partial/空/离线）→ 整个 no-op**：既不推进防抖、也不清 candidate（网抖不该动它）。dirty 孤儿 → ghost，永不碰。
  async function converge(localNames: string[], cloudNames: Set<string>, authoritative: boolean, activeFileName?: string): Promise<{ demoted: string[] }> {
    if (!authoritative) return { demoted: [] };
    localNames = localNames.filter((n) => !isHidden(n));   // 隐藏项云端本就不列 → 别据「云端没有」误判 gone
    // 自愈/取消：candidate 重现（云端权威有）或已变 dirty（被编辑）→ 清标记。
    for (const name of localNames) {
      if (pending.isPending(name) && (cloudNames.has(name) || head.isDirty(name))) pending.clear(name);
    }
    const { demote } = classifyCloudGone(localNames, cloudNames, {
      seenBase: (n) => head.seenBase(n),
      isDirty: (n) => head.isDirty(n),
      authoritative,
      skip: activeFileName ? (n) => n === activeFileName : undefined,
    });
    const demoted: string[] = [];
    for (const name of demote) {
      if (!pending.seenGone(name, now())) continue;   // 首次见 gone / grace 内 → 标记+留着（badge），不删
      // 单腿事件（云端已经没了，只有本地这一条腿）→ 自己生成 id，无配对需求。
      await local.trash(name, asideStamp(now()));     // 跨 GRACE 第二次+ → 本地 send trash（move-aside，可恢复）
      cloud.clearState(name); head.forget(name); pending.clear(name);   // 清两条 etag 轨道 + candidate
      demoted.push(name);
    }
    return { demoted };
  }

  // **全库** cloud-gone 收敛——**仅用户显式指令**（将来隐藏的「校验完整性」入口），**绝不自动/轮询**。
  //   全树 listAll（每个子夹一次 Graph 往返）是重活；日常开夹惰性收敛走 reconcileFolder。空列表守卫防网抖误删。
  async function reconcile(opts: { activeFileName?: string } = {}): Promise<{ demoted: string[] }> {
    if (isOnline && !isOnline()) return { demoted: [] };                  // 离线 → 不权威
    const all = await cloud.listAll().catch((e) => { reportStoreError(e, "log"); return null; });   // 未登录/网失败 → null
    const authoritative = !!(all && all.complete && all.files.length > 0);  // 失败-fetch + 空列表守卫
    if (!authoritative) return { demoted: [] };
    const cloudNames = new Set(all!.files.map((f) => f.name ?? f.path));
    return converge(await local.appKeys(), cloudNames, authoritative, skipName(opts.activeFileName));
  }

  // **单夹** cloud-gone 收敛——「看到 folder 才 reconcile」（watchFolder 的 remote pass 副作用），非静默、非全扫。
  //   authoritative = 这一夹 list() 没抛错（complete）。空夹合法（per-folder 下「空」≠网抖，与 reconcile 的空列表守卫不同）。
  //
  // ⚠ **已知且已接受的风险，别再来"修"**（human 2026-07-18 明确拍板承担）：
  //   provider 若**撒谎**——把 404 当空夹返回，或分页没列全却报 complete:true——本夹「本地 clean、
  //   云端消失」的文件会被标 candidate-gone、进 24h grace、跨 grace 后 send trash（可恢复，非硬删）。
  //   为什么不修：站在这一层**分辨不出**「真的空」和「provider 谎报空」——两者返回的字节一模一样。
  //   现有缓解已是能做的全部：complete 守卫 + 去抖 grace + 重现自愈 + 被编辑即取消 + 终点是 .trash 不是硬删。
  //   → 有界、可恢复、单用户下极难触发。与其加测试假装防住了，不如等真复现（或查 Graph 已知 bug）。
  //   （同理 removeFolder 的分页 TOCTOU：判空与删除之间的窗口无法在客户端消除，同样承担。）
  //   只判**该夹直属**本地文件（startsWith(prefix) ∧ 无更深 slash）——身份=path、不跨夹追踪：别夹的 clean 文件永不被本次降级。
  async function reconcileFolder(folder: string, opts: { activeFileName?: string } = {}): Promise<{ demoted: string[] }> {
    if (isOnline && !isOnline()) return { demoted: [] };
    const res = await cloud.listFolder(folder).catch((e) => { reportStoreError(e, "log"); return null; });
    if (!res || !res.complete) return { demoted: [] };                   // 这一夹没列全 → 不权威 → no-op（绝不据此判 gone）
    const cloudNames = new Set(res.files.map((f) => f.name ?? f.path));
    const prefix = folder ? `${folder}/` : "";
    const localNames = (await local.appKeys()).filter((k) => {
      if (folder && !k.startsWith(prefix)) return false;
      const rest = k.slice(prefix.length);
      return rest.length > 0 && !rest.includes("/");                     // 仅本夹直属文件
    });
    return converge(localNames, cloudNames, true, skipName(opts.activeFileName));
  }

  return { reconcile, reconcileFolder };
}
