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
}

export interface PushResult { status: string; dirtyAfter?: boolean; resolution?: string; reason?: string; backupName?: string; backedUp?: string | null }

export function createPush(cfg: PushCfg) {
  const { cloud, head, seal, safeResolve, serialize, editVersion,
    busy = passBusy, maxAttempts = 4, backoffMs = 200, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)) } = cfg;

  async function doPush(name: string, { encode, getEditVersion = editVersion, onConflict, adopt }: PushOpts): Promise<PushResult> {
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
          const dirtyAfter = getEditVersion() !== v0;   // PUT 期间又改过 → 仍 unpushed
          head.onPushed(name, item?.eTag ?? null, dirtyAfter);
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
