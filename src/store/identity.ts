// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// identity（深模块）—— 改身份：rename / acquire。单一职责 = 安全的身份变更：
//   phantom-path 红线：**本地先存新名再删旧名**（绝不先删）。
//   rename：synced/纯云端 → 服务端 move 保 etag 不重传；dirty 有本地字节 → push 当前字节到新名，
//     旧名的去向**看谱系**：完好 → 进 .trash（move 语义）；不明/分叉 → 原地留着（save-as 语义，
//     因为改名是「上传失败后的逃生通道」，此时本地并非旧名的后代）。详见 rename 内的长注释。
//   串行 against 两名 in-flight（serialize2）。编排 push 深模块 + cloud.rename + local-head。
import { toU8 } from "./substrate.ts";
import type { BytesSource } from "./substrate.ts";
import { reportStoreError } from "./error-handling.ts";
import { asideStamp } from "./move-aside.ts";   // 单腿 trash 事件的 deleteEventId 生成器
import { CloudNameCollisionError } from "./cloud-sync.ts";
import type { CloudSync, FetchMetaResult, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
import type { Seal } from "./seal.ts";

type Busy = <T>(label: string, fn: () => Promise<T>) => Promise<T>;
const passBusy: Busy = (_l, fn) => fn();
type Bytes = Uint8Array;
type AdoptFn = (plain: Blob, name: string) => unknown | Promise<unknown>;
type PushFn = (name: string, opts: { encode: () => BytesSource | Promise<BytesSource>; getEditVersion?: () => number }) => Promise<{ status: string }>;

export interface IdentityCfg {
  cloud: Pick<CloudSync, "fetchMeta" | "rename" | "getETag" | "pull" | "trash">;
  local?: Pick<LocalCache, "exists" | "get" | "save" | "hardDelete">;
  head: Pick<LocalHead, "isDirty" | "markSeen" | "markSynced" | "forget" | "recordEdit" | "seenBase">;
  doPush: PushFn;   // 未串行版（identity 已在自己 serialize/serialize2 段内，调串行 push 会同名自锁）
  serialize: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  serialize2: <T>(a: string, b: string, fn: () => Promise<T>) => Promise<T>;
  seal?: Pick<Seal, "unsealForRead">;
  busy?: Busy;
  // ── 离线 move = 删 old + 建 new（决策 1A/2，2026-07-12；在线走服务端原子 move，离线不可原子才降级）──
  isOnline?: () => boolean;
  deleteOffline?: (name: string) => Promise<void>;   // 复用 del.del 的离线删语义（本地 move-aside + base-etag 云删排队 + null 守卫 + forget）
  queueUpload?: (name: string) => void;              // 离线新建 float 的补推入队（uploadReplay.enqueue，ADR-0018）
  nameOccupied?: (name: string) => Promise<"local" | "cloud" | null>;   // 唯一名字占用检查（create-store 注入）；assertNameFree 据此抛
}
export interface RenameOpts { encode?: () => BytesSource | Promise<BytesSource>; getEditVersion?: () => number; cloud?: boolean; busy?: Busy; skipOccupiedCheck?: boolean }
export interface AcquireOpts { localName?: string; adopt?: AdoptFn; busy?: Busy }
export interface IdResult {
  status: string; where?: string; newName?: string; oldName?: string; localName?: string;
  oldCloudOrphan?: boolean;   // 旧名进 .trash 失败 → 云端遗留孤儿
  oldKept?: boolean;          // 谱系不明/分叉 → 改名降级为 save-as，云端旧名**原地留着**（须告知用户）
  oldUnknown?: boolean;       // 云端旧名的状态取不到（离线/错误）→ 没碰它；「取不到」≠「没有」，必须如实说
  cloudDeferred?: boolean;    // 云端推失败 → newName 留本地 dirty 待推
  item?: unknown; error?: unknown;
}

export function createIdentity(cfg: IdentityCfg) {
  const { cloud, local, head, doPush, serialize, serialize2, seal, busy: _busy = passBusy, isOnline, deleteOffline, queueUpload, nameOccupied } = cfg;
  const unseal = (name: string, blob: Blob) => seal ? seal.unsealForRead(name, blob) : Promise.resolve(blob as Blob | null);

  // 目标名占用护栏（**碰撞检查内化**：caller 不必先 list 目标夹——app 原则上不知道别夹内容）。
  //   本地已有 newName ∨ 云端已有 newName（任一）→ 抛 CloudNameCollisionError，**在改任何字节之前**（防 rename 覆盖既有文件 = data-loss）。
  //   离线时 cloud.fetchMeta 抛/失败 → 视作云端无（本地护栏仍挡；后续 push 的 conflictBehavior:fail 兜底云端）。
  async function assertNameFree(newName: string, doCloud: boolean): Promise<void> {
    // doCloud=false（本地-only rename）→ 只查本地；否则走注入的统一 nameOccupied（local+在线 remote）。缺注入（裸测试）→ 退回本地 exists。
    if (doCloud && nameOccupied) { if (await nameOccupied(newName)) throw new CloudNameCollisionError(newName); return; }
    if (local && await local.exists(newName)) throw new CloudNameCollisionError(newName);
  }

  // 云端某名字的探测结果 —— **三态，别塌缩成 null**。
  //   { known:true, meta:非空 } 云端有这个文件
  //   { known:true, meta:null } 云端确实没有
  //   { known:false }           取不到（离线 / 瞬时错误 / 未登录）
  // 旧版把第三种 catch 成 null，于是「云端不可达」和「云端没有」变成同一件事：
  //   rename 会安静地什么都不做，却报 where:"cloud-push"（意思是「旧名本来就没有云端副本」），
  //   app 一路穿到「已重命名（含云端）」—— 而云端旧文件原封不动还在那儿，谱系刚被 forget 掉。
  async function probeOld(name: string): Promise<{ known: true; meta: FetchMetaResult | null } | { known: false }> {
    try { return { known: true, meta: await cloud.fetchMeta(name) }; }
    catch (e) { reportStoreError(e, "log"); return { known: false }; }
  }

  async function rename(oldName: string, newName: string, opts: RenameOpts = {}): Promise<IdResult> {
    const { encode, getEditVersion, cloud: doCloud = true, busy = _busy, skipOccupiedCheck } = opts;
    if (!oldName || !newName || oldName === newName) return { status: "noop" };
    return serialize2(oldName, newName, () => busy("重命名…", async () => {
      if (!skipOccupiedCheck) await assertNameFree(newName, doCloud);   // 目标占用 → 抛 collision（改字节前）。tryMove 已 nameOccupied 预检 → skip，避免重复 fetchMeta

      const hasLocal = local ? await local.exists(oldName) : false;
      let bytes: Bytes | null = null;
      if (encode) bytes = await toU8(await encode());
      else if (hasLocal) bytes = await toU8((await local!.get(oldName))!);

      // ── 离线 move = 删 old + 建 new（决策 1A/2）──────────────────────────────────────────────
      //   服务端原子 move 只在线可做（保 etag、不重传字节、不丢）；离线不可原子 → 降级：建 new(本地 float) + 删 old(vetted 离线删)。
      //   两侧各自排队、重连**独立收敛**（决策 1A）：new 撞名 push fail→surface（字节留本地 dirty）；old 走 base-etag 守卫的云删。
      //   字节永不丢：new 本地 dirty 永不驱逐 + old 进 .trash（可恢复）。cloud-only(无本地字节)离线无法搬 → 落到下方现状分支。
      if (doCloud && isOnline && !isOnline() && deleteOffline && hasLocal) {
        await local!.save(newName, bytes!);         // 建 new（本地字节 = old 的 at-rest 字节；含未推编辑/加密原样搬）
        head.recordEdit(newName);                   // new = never-synced float（_parent=null → 首推 conflictBehavior:fail，撞名 surface）
        queueUpload?.(newName);                     // 重连补推（ADR-0018）
        await deleteOffline(oldName);               // 删 old：本地 move-aside + 云删排队(base-etag 守卫) + head.forget
        return { status: "renamed", where: "offline-move", newName };
      }

      if (local && hasLocal) {
        await local.save(newName, bytes!);          // 先存新名（phantom-path：绝不先删）
        await local.hardDelete(oldName);            // 成功后才删旧名
      }
      if (!doCloud) { head.forget(oldName); return { status: "renamed", where: "local", newName }; }
      try {
        const before = await probeOld(oldName);
        // synced 或没本地字节可推（纯云端）→ 服务端 move，etag 顺延。
        if (before.known && before.meta && (!head.isDirty(oldName) || bytes == null)) {
          await cloud.rename(oldName, newName, { baseEtag: before.meta.etag });   // If-Match：别设备在我们判定「synced」之后推了新版 → 412，不静默改它的名
          head.markSeen(newName, cloud.getETag(newName)); head.forget(oldName);
          return { status: "renamed", where: "cloud-move", newName };
        }
        if (bytes == null) { head.forget(oldName); return { status: "renamed", where: "local", newName }; }
        const baseAtStart = head.seenBase(oldName);   // 「用户按下改名时，本机认为自己派生自哪一版」
        await doPush(newName, { encode: () => bytes!, getEditVersion });   // dirty/无旧云文件 → 推当前字节（含 B5/retry/conflict）
        // ── 旧名怎么办：move（搬走）还是 save-as（留着）───────────────────────────────────────
        //   「推新名 + 旧名进 .trash」是 **move** 语义，它隐含一个前提：
        //        本地这份字节，是旧名云端那份的**后代**。
        //   前提成立时搬走旧的不丢信息（新的就是它的续集）——正常改名走这条，正确。
        //
        //   ⚠ 前提**不成立**时（本机不知道自己派生自云端哪一版，或云端已被别的设备推过新版），
        //   旧名那份含有本地根本没有的内容。此时搬走它 = 把用户没见过的工作挪进 .trash。
        //   而这恰恰是 rename 最常被使用的场景：**改名是上传失败之后的逃生通道**（用户 2026-07-18 拍定），
        //   用户来改名，正是因为原名推不上去 —— 也就是正因为谱系断了。
        //   → 逃生通道与斩杀线本是同一条代码，差别只在这个当时「已知不知道」的变量，旧版默认了「是」。
        //
        //   谱系不明/已分叉 → 降级为 **save-as**：新名照推，旧名一个指头都不碰。
        //   （不在这里弹冲突面：逃生通道必须畅通，不许在用户正要逃的时候再拦一道。保存那条路才是 surface 的地方。）
        //   ★ 判据必须在 doPush **之后**重取（TOCTOU；同 offload.ts 网络往返后 re-check 的纪律）：
        //   doPush 含最多 4 次重试 + 可能的冲突面**用户交互**，可以长达几十秒。push 之前那次读早就陈旧了，
        //   拿它决定「要不要搬走云端旧名」= 用几十秒前的世界观做破坏性动作。
        const after = await probeOld(oldName);
        let oldCloudOrphan = false, oldKept = false, oldUnknown = false;
        if (!after.known) {
          // 云端状态取不到（离线/瞬时错误）。**「取不到」≠「没有」**——绝不能拿未知当空白然后什么都不说。
          oldUnknown = true;                                   // 一个指头都不碰，并让 caller 如实告知
        } else if (after.meta == null) {
          /* 云端确实没有旧名（本来就是纯本地文件）→ 无事可做 */
        } else if (baseAtStart != null && baseAtStart === after.meta.etag) {
          // 谱系完好 → move 语义成立，旧名进 .trash（不 hard-delete，C5）。
          // 单腿事件（只有云端这一条腿，本地旧名没有对应的 trash 项）→ 自己生成 id，无配对需求。
          try { await cloud.trash(oldName, asideStamp(Date.now()), { baseEtag: after.meta.etag }); } catch (e) { reportStoreError(e, "warning"); oldCloudOrphan = true; }   // If-Match 锁住刚重取的那一版   // 旧名进 .trash 失败→云端遗留孤儿：surface
        } else {
          oldKept = true;   // 谱系不明/分叉 → 云端旧名原地留着（caller 须告知用户「旧的还在，叫 X」）
        }
        head.forget(oldName);
        return {
          status: "renamed",
          where: oldUnknown ? "cloud-push+unknown"
            : oldKept ? "cloud-push+kept"
            : oldCloudOrphan || (after.known && after.meta) ? "cloud-push+trash"
            : "cloud-push",
          newName, oldCloudOrphan, oldKept, oldUnknown, oldName,
        };
      } catch (e) {
        reportStoreError(e, "warning");   // 云端推失败、newName 留本地 dirty 待推 → surface
        // 云端推失败（网络）→ 本地已是 newName，标脏让它成待推（下次 push/sync 自动带走 newName，
        //   不必重跑 rename 才收敛）。_parent=null=新身份首推（conflictBehavior:fail，撞名 surface 不盲覆盖）。
        head.recordEdit(newName);
        head.forget(oldName);
        return { status: "renamed", where: "local", newName, cloudDeferred: true, error: e };
      }
    }));
  }

  // saveAs 已删（2026-07）：它只是「写新身份」的一个别名，语义上和 file(name,{mode:"new"}).save(bytes)
  //   完全重合，却多出一条平行的落盘+推云路径要各自维护（撞名护栏、seal、dirty 收尾都得抄一遍）。
  //   零 app 调用者。撞名不覆盖的红线由 mode:"new" 的 nameOccupied 护栏承担（create-store.ts）。

  // 首取：云端 item → 本地（无冲突，本地本来没有）。
  async function acquire(cloudName: string, opts: AcquireOpts = {}): Promise<IdResult> {
    const { localName = cloudName, adopt, busy = passBusy } = opts;
    return busy("拉取中…", () => serialize(localName, async () => {
      const r = await cloud.pull(cloudName);
      if (!r) return { status: "absent" };
      if (local) await local.save(localName, r.blob);
      head.markSynced(localName, r.item?.eTag ?? null);
      if (adopt) { const plain = await unseal(localName, r.blob); if (plain) await adopt(plain, localName); }
      return { status: "acquired", localName, item: r.item };
    }));
  }

  return { rename, acquire };
}
