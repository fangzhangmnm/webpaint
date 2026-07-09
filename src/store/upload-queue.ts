// ⚠ 使用前必读 README.md + CONTEXT.md + docs/adr/0018。app 不直接 import——经 createStore。
//
// upload-queue（深模块，ADR-0018）—— 离线「新上传」回线补推。对称 delete.ts 的 drainDeleteQueue，
//   补上 state-machine §4 一直只在 spec 的「consented pushes」那半边（从没实现）。
//
// **只处理 never-synced（float）上传**：无云端版本 → 不可能分叉 → 只 CloudNameCollision 会 surface（两份都留）。
//   对**已同步文件的编辑**不在此——那是 consent-surface（ADR-0016/0017：不透明 Work 的 412 没法自动合并 → 丢更新）。
// **非 busy 后台 drain**（不锁屏，用户继续读）：代价是与用户操作 race → 靠 ① per-name serialize ② 锁内 supersede 复检。
// **中途关 app / 大文件慢网**：靠持久队列（没确认成功绝不出队）+ push 的 W1 幂等（真上去了但丢响应 → 下次重试 adopt 不重复）。
// **per-app policy**（ctor）：auto=静默补推 · ask=每次 reconnect/成功连接问一次整批 · manual=不做（等显式再存）。
import type { Kv, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";

export type UploadReplayPolicy = "auto" | "ask" | "manual";

export interface ReplayStatus { phase: "start" | "pushed" | "collision" | "done"; name?: string; done: number; total: number; }

export interface UploadReplayCfg {
  kv: Kv;
  local: Pick<LocalCache, "exists">;
  head: Pick<LocalHead, "isDirty" | "seenBase">;
  isOnline: () => boolean;
  serialize: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  // 读本地字节 → 解壳 → doPush（**非 busy、未串行**；本模块负责 per-name serialize）。CloudNameCollisionError 直接抛出。
  pushLocal: (name: string) => Promise<{ status: string }>;
  policy: UploadReplayPolicy;
  confirm?: (count: number) => Promise<boolean>;   // ask 模式：回线问一次整批（强制 UI，ctor 已校验存在）
  onStatus?: (evt: ReplayStatus) => void;          // 进度/冲突 surface（强制 UI，ctor 已校验存在）
}

export interface DrainResult { status: string; pushed: number; remain?: number; }

const UPQ_KEY = "uploadqueue:v1";

export function createUploadReplay(cfg: UploadReplayCfg) {
  const { kv, local, head, isOnline, serialize, pushLocal, policy, confirm, onStatus } = cfg;

  function readQueue(): string[] {
    try { const v = JSON.parse(kv.get(UPQ_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  function writeQueue(q: string[]): void { if (q.length) kv.set(UPQ_KEY, JSON.stringify([...new Set(q)])); else kv.remove(UPQ_KEY); }
  function enqueue(name: string): void { if (policy === "manual") return; writeQueue([...readQueue(), name]); }
  function remove(name: string): void { const q = readQueue(); if (q.includes(name)) writeQueue(q.filter((n) => n !== name)); }

  async function drain(): Promise<DrainResult> {
    if (policy === "manual") return { status: "manual", pushed: 0 };
    const q = readQueue();
    if (!q.length) return { status: "empty", pushed: 0 };
    if (!isOnline()) return { status: "offline", pushed: 0 };
    if (policy === "ask") {
      const ok = confirm ? await confirm(q.length) : false;   // 回线/成功连接问一次整批
      if (!ok) return { status: "declined", pushed: 0 };
    }
    onStatus?.({ phase: "start", done: 0, total: q.length });
    const remain: string[] = [];
    let pushed = 0;
    for (const name of q) {
      // per-name serialize：与用户 save/delete/rename 同名互斥，绝不重叠（非 busy 后台的 race 防线）。
      const r = await serialize(name, async (): Promise<string> => {
        if (!(await local.exists(name))) return "gone";                        // 被删/superseded → 出队
        if (!head.isDirty(name) || head.seenBase(name) != null) return "synced"; // 已推/已同步 → 出队
        try { await pushLocal(name); return "pushed"; }
        catch (e) {
          if ((e as { name?: string } | null)?.name === "CloudNameCollisionError") return "collision";  // 同名异文件：surface + 出队（重试无用，等改名）
          return "keep";   // 离线/transient → 留队，下次 reconnect 重试
        }
      });
      if (r === "pushed") { pushed++; onStatus?.({ phase: "pushed", name, done: pushed, total: q.length }); }
      else if (r === "collision") onStatus?.({ phase: "collision", name, done: pushed, total: q.length });
      else if (r === "keep") remain.push(name);
      // gone / synced → 出队（不 push、不留）
    }
    writeQueue(remain);
    onStatus?.({ phase: "done", done: pushed, total: q.length });
    return { status: "drained", pushed, remain: remain.length };
  }

  return { enqueue, remove, drain, pending: readQueue };
}
