// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// push（深模块）—— 串行 + If-Match + 重试 + 冲突 surface 的推。单一职责 = 同步**编排**：
//   它自己不持谱系/不解加密/不化解冲突，而是**编排**三个深模块：
//     local-head.ifMatchFor（If-Match + bypass 守卫）· seal.sealForWrite（明文→at-rest 包壳）·
//     safe-resolve.tryHeal/resolveConflict（自愈/永不丢字节化解）· local-head.onPushed（落地谱系）。
//   串行 = substrate.serialize（同 name 串行，B1）。
import { toU8 } from "./substrate.ts";
import type { BytesSource } from "./substrate.ts";
import type { CloudSync } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
import type { Seal } from "./seal.ts";
import type { SafeResolve, ResolveChoice } from "./safe-resolve.ts";

type Busy = <T>(label: string, fn: () => Promise<T>) => Promise<T>;
const passBusy: Busy = (_l, fn) => fn();
const isConflict = (e: unknown) => !!e && ((e as { name?: string }).name === "CloudConflictError" || (e as { status?: number }).status === 412);
function retriable(e: unknown): boolean {
  const x = e as { status?: number; name?: string } | null;
  const s = x?.status;
  return (s == null || s === 429 || (s >= 500 && s <= 599)) && x?.name !== "CloudConflictError" && x?.name !== "CloudNameCollisionError";
}

type AdoptFn = (plain: Blob, name: string) => unknown | Promise<unknown>;

export interface PushCfg {
  cloud: Pick<CloudSync, "push">;
  head: Pick<LocalHead, "ifMatchFor" | "onPushed" | "recordEdit">;
  seal: Pick<Seal, "sealForWrite" | "isContainer">;
  safeResolve: Pick<SafeResolve, "tryHeal" | "resolveConflict">;
  serialize: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  editVersion: () => number;                  // 编辑游标（B2）；opts 可冻结覆盖
  busy?: Busy;
  maxAttempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PushOpts {
  encode: () => BytesSource | Promise<BytesSource>;
  getEditVersion?: () => number;
  onConflict?: (ctx: { name: string }) => ResolveChoice | Promise<ResolveChoice>;
  adopt?: AdoptFn;
  // 谱系断裂（无 base 推撞上云端同名）时的去向。见 doPush 的 isCollision 分支。
  //   false（默认）= 抛 CloudNameCollisionError（**真·新建**该走这条：两设备各建同名不同物，护栏正确）
  //   true          = 走 onConflict 冲突面（**编辑既有文件**该走这条：本地云端都有、只是谱系断了）
  surfaceCollision?: boolean;
}

// push 的终态全集（收成联合类型，别再用裸 string —— "deferred" 拼错要在编译期就炸）：
//   pushed     落地已确认（拿到新 etag）· deferred 落地**未**确认（provider 没回 item/eTag）→ 仍算未推
//   healed     lost-response 自愈 · resolved/unresolved/cancelled 由 safeResolve.resolveConflict 产出
export type PushStatus = "pushed" | "deferred" | "healed" | "resolved" | "unresolved" | "cancelled";

export interface PushResult { status: PushStatus; dirtyAfter?: boolean; resolution?: string; reason?: string; backupName?: string; backedUp?: string | null }

export function createPush(cfg: PushCfg) {
  const { cloud, head, seal, safeResolve, serialize, editVersion,
    busy = passBusy, maxAttempts = 4, backoffMs = 200, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)) } = cfg;

  async function doPush(name: string, { encode, getEditVersion = editVersion, onConflict, adopt, surfaceCollision = false }: PushOpts): Promise<PushResult> {
    const ifMatch = head.ifMatchFor(name);              // 封装 bypass：dirty 缺 parent 且 base 已知 → throw BypassError
    const v0 = getEditVersion();
    // encode 出明文 → seal 按 at-rest 态包壳（调用方对加密零感知）。只编码+包壳一次，重试复用（B5 逐字节比对要相等）。
    const bytes = await seal.sealForWrite(name, await toU8(await encode()));
    const isEnc = await seal.isContainer(bytes);
    return busy("正在同步…", async () => {
      let attempt = 0, lastErr: unknown;
      while (attempt < maxAttempts) {
        attempt++;
        try {
          const { item } = await cloud.push(name, bytes, { baseEtag: ifMatch, encrypted: isEnc });
          // F0 红线：provider 没回 item/eTag = **落地未确认**（分块响应 / 代理吞 body / provider 违约）。
          //   绝不能当成功——onPushed(null,false) 会清 dirty 且 base 停在旧值，未推字节随后被 offload
          //   合法驱逐（MASTER §A「dirty 永不驱逐」直接失守），UI 还显示「已同步」。
          //   → 不调 onPushed（dirty/parent 原样保住），报 deferred，让上层重推。
          if (!(item && item.eTag)) return { status: "deferred", dirtyAfter: true };
          const dirtyAfter = getEditVersion() !== v0;   // PUT 期间又改过 → 仍 unpushed
          head.onPushed(name, item.eTag, dirtyAfter);
          return { status: "pushed", dirtyAfter };
        } catch (e: unknown) {
          if (isConflict(e)) {
            if (await safeResolve.tryHeal(name, bytes)) {   // lost-response 自愈
              const dirtyAfter = getEditVersion() !== v0;
              if (dirtyAfter) head.recordEdit(name);        // 编辑发生在推期间 → 基于刚自愈的版本重标脏（B2）
              return { status: "healed", dirtyAfter };
            }
            const choice = onConflict ? await onConflict({ name }) : "cancel";   // 真分叉 → 交 ui 选（默认 cancel=留 dirty）
            return await safeResolve.resolveConflict(name, choice, { bytes, adopt });
          }
          // 谱系断裂：无 base 推撞上云端同名（cloud-sync 的 409 + 尾字节 differ → CloudNameCollisionError）。
          //   两种情形共用这一个错误，但该走的路完全相反：
          //     ① **真·新建**（surfaceCollision=false）→ 云端那个是「别的设备建的同名不同物」。
          //        抛错、两份都留着，是 MASTER §A 身份行明写的保证（both kept）。不动。
          //     ② **编辑既有文件**（surfaceCollision=true）→ 本地有、云端有，只是本机不知道自己派生自哪一版
          //        （reload 冲掉内存谱系、durable etag 又从没写过）。抛 collision 在这里是**假原因 + 死路**：
          //        用户的保存一个字节都上不去，且自我延续（永远推不成功 = 永远不写 etag = 每次版本更新必复发）。
          //        → 交给和 412 同一个冲突面：拉云端 / 留本地 / 以我的覆盖（云端 loser 进 .backup，never-lose）。
          //   两条路都不盲目覆盖、都不丢字节；差别只是 ② 给了用户一条出路。
          if (surfaceCollision && (e as { name?: string })?.name === "CloudNameCollisionError") {
            const choice = onConflict ? await onConflict({ name }) : "cancel";
            return await safeResolve.resolveConflict(name, choice, { bytes, adopt });
          }
          if (retriable(e) && attempt < maxAttempts) { lastErr = e; await sleep(backoffMs * attempt); continue; }
          throw e;
        }
      }
      throw lastErr;
    });
  }

  // 同 name 串行（B1）：每次 push 等前一次跑完才启动。
  function push(name: string, opts: PushOpts): Promise<PushResult> {
    return serialize(name, () => doPush(name, opts));
  }
  // doPush = 未串行版：给已在自己 serialize/serialize2 段内的调用方（identity 的 rename/saveAs），
  //   避免同名嵌套 serialize 自锁。
  return { push, doPush };
}
