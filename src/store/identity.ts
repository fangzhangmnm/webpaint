// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// identity（深模块）—— 改身份：rename / saveAs / acquire。单一职责 = 安全的身份变更：
//   phantom-path 红线：**本地先存新名再删旧名**（绝不先删）。
//   rename：synced/纯云端 → 服务端 move 保 etag 不重传；dirty 有本地字节 → push 当前字节到新名 + 旧名进 .trash。
//   串行 against 两名 in-flight（serialize2）。编排 push 深模块 + cloud.rename + local-head。
import { toU8 } from "./substrate.ts";
import type { BytesSource } from "./substrate.ts";
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
}
export interface RenameOpts { encode?: () => BytesSource | Promise<BytesSource>; getEditVersion?: () => number; cloud?: boolean; busy?: Busy }
export interface SaveAsOpts { encode: () => BytesSource | Promise<BytesSource>; getEditVersion?: () => number; cloud?: boolean; busy?: Busy }
export interface AcquireOpts { localName?: string; adopt?: AdoptFn; busy?: Busy }
export interface IdResult { status: string; where?: string; newName?: string; localName?: string; oldCloudOrphan?: boolean; cloudDeferred?: boolean; item?: unknown; error?: unknown }

export function createIdentity(cfg: IdentityCfg) {
  const { cloud, local, head, doPush, serialize, serialize2, seal, busy: _busy = passBusy } = cfg;
  const unseal = (name: string, blob: Blob) => seal ? seal.unsealForRead(name, blob) : Promise.resolve(blob as Blob | null);

  async function rename(oldName: string, newName: string, opts: RenameOpts = {}): Promise<IdResult> {
    const { encode, getEditVersion, cloud: doCloud = true, busy = _busy } = opts;
    if (!oldName || !newName || oldName === newName) return { status: "noop" };
    return serialize2(oldName, newName, () => busy("重命名…", async () => {
      const hasLocal = local ? await local.exists(oldName) : false;
      let bytes: Bytes | null = null;
      if (encode) bytes = await toU8(await encode());
      else if (hasLocal) bytes = await toU8((await local!.get(oldName))!);

      if (local && hasLocal) {
        await local.save(newName, bytes!);          // 先存新名（phantom-path：绝不先删）
        await local.hardDelete(oldName);            // 成功后才删旧名
      }
      if (!doCloud) { head.forget(oldName); return { status: "renamed", where: "local", newName }; }
      try {
        let cloudOld = null;
        try { cloudOld = await cloud.fetchMeta(oldName); } catch { cloudOld = null; }
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
        if (cloudOld) { try { await cloud.trash(oldName); } catch { oldCloudOrphan = true; } }
        head.forget(oldName);
        return { status: "renamed", where: cloudOld ? "cloud-push+trash" : "cloud-push", newName, oldCloudOrphan };
      } catch (e) {
        // 云端推失败（网络）→ 本地已是 newName，标脏让它成待推（下次 push/sync 自动带走 newName，
        //   不必重跑 rename 才收敛）。_parent=null=新身份首推（conflictBehavior:fail，撞名 surface 不盲覆盖）。
        head.recordEdit(newName);
        head.forget(oldName);
        return { status: "renamed", where: "local", newName, cloudDeferred: true, error: e };
      }
    }));
  }

  // 另存为：写新身份，旧的不动（Photoshop 语义）。
  async function saveAs(newName: string, opts: SaveAsOpts): Promise<IdResult> {
    const { encode, getEditVersion, cloud: doCloud = true, busy = _busy } = opts;
    return serialize(newName, async () => {
      const bytes = await toU8(await encode());
      if (local) await local.save(newName, bytes);
      if (!doCloud) return { status: "saved", where: "local", newName };
      try {
        await doPush(newName, { encode: () => bytes, getEditVersion });
        return { status: "saved", where: "cloud", newName };
      } catch (e) {
        return { status: "saved", where: "local", newName, cloudDeferred: true, error: e };
      }
    });
  }

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

  return { rename, saveAs, acquire };
}
