// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// identity（深模块）—— 改身份：rename / acquire。单一职责 = 安全的身份变更：
//   phantom-path 红线：**本地先存新名再删旧名**（绝不先删）。
//   rename：synced/纯云端 → 服务端 move 保 etag 不重传；dirty 有本地字节 → push 当前字节到新名 + 旧名进 .trash。
//   串行 against 两名 in-flight（serialize2）。编排 push 深模块 + cloud.rename + local-head。
import { toU8 } from "./substrate.ts";
import type { BytesSource } from "./substrate.ts";
import { reportStoreError } from "./error-handling.ts";
import { asideStamp } from "./move-aside.ts";   // 单腿 trash 事件的 deleteEventId 生成器
import { CloudNameCollisionError } from "./cloud-sync.ts";
import type { CloudSync, LocalCache } from "./types.ts";
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
  head: Pick<LocalHead, "isDirty" | "markSeen" | "markSynced" | "forget" | "recordEdit">;
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
export interface IdResult { status: string; where?: string; newName?: string; localName?: string; oldCloudOrphan?: boolean; cloudDeferred?: boolean; item?: unknown; error?: unknown }

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
        let cloudOld = null;
        try { cloudOld = await cloud.fetchMeta(oldName); } catch (e) { reportStoreError(e, "log"); cloudOld = null; }
        // synced 或没本地字节可推（纯云端）→ 服务端 move，etag 顺延。
        if (cloudOld && (!head.isDirty(oldName) || bytes == null)) {
          await cloud.rename(oldName, newName);
          head.markSeen(newName, cloud.getETag(newName)); head.forget(oldName);
          return { status: "renamed", where: "cloud-move", newName };
        }
        if (bytes == null) { head.forget(oldName); return { status: "renamed", where: "local", newName }; }
        await doPush(newName, { encode: () => bytes!, getEditVersion });   // dirty/无旧云文件 → 推当前字节（含 B5/retry/conflict）
        // 旧名进 .trash（不 hard-delete，C5）。失败 → oldCloudOrphan 让 caller surface（新名已推成功，不回滚）。
        let oldCloudOrphan = false;
        // 单腿事件（只有云端这一条腿，本地旧名没有对应的 trash 项）→ 自己生成 id，无配对需求。
        if (cloudOld) { try { await cloud.trash(oldName, asideStamp(Date.now())); } catch (e) { reportStoreError(e, "warning"); oldCloudOrphan = true; } }   // 旧名进 .trash 失败→云端遗留孤儿：surface
        head.forget(oldName);
        return { status: "renamed", where: cloudOld ? "cloud-push+trash" : "cloud-push", newName, oldCloudOrphan };
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
