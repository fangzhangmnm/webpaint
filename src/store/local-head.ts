// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// local-head（深模块）—— 追踪「**本 tab 对每个文件，相对云端站在哪**」。
//   = git 的 HEAD(_base 看到的云 tip) + merge-base(_parent 未推枝分叉自哪) + working-tree-dirty 三合一。
//
// 红线（CONTEXT.md）：
//   · per-tab：_base/_parent 内存 Map（每 tab 独立 JS 堆）——**绝不**放共享 kv（W2：别 tab 改了
//     共享 etag，本 tab 陈旧推被误判无冲突 → 静默覆盖）。
//   · dirty 双机制：per-tab 内存活视图(_dirtyMem) + kv shared-durable（跨 reload/tab-close 兜底，
//     寿命对齐 IDB 里的未推字节）。
//   · recordEdit 是**唯一**标脏入口：原子 set dirty + _parent←_base → **dirty-without-parent 不可表示**。
//   · seenBase 缺 _base 时回退 cloud etag——**仅**用于 open/refresh 比对（非破坏性），永不作 dirty 的 If-Match。
//     local-head 是唯一碰这个回退的地方（两条 etag 轨道唯一接触点）。
//   · markSynced（且**只有** markSynced）把 etag 提交进 durable 轨：它是唯一一个断言「盘上字节 == 云端某版」
//     的迁移，而那是跨 reload 的事实。markSeen 不写（只是"看到云端 meta"，盘上字节没动）。详见 markSynced 内注释。
import type { Kv } from "./types.ts";

export class BypassError extends Error {
  code = "BYPASS";
  constructor(name: string) {
    super(`local-head: "${name}" dirty 但缺 parentBase（编辑没走 recordEdit 正门，拒绝可能静默覆盖的推送）`);
    this.name = "BypassError";
  }
}

export interface LocalHeadCfg {
  kv: Kv;                                       // dirty 的 durable 持久（跨 reload）
  getCloudEtag: (name: string) => string | null;   // seenBase 回退（cloud-sync 的共享 etag）；唯一接触点
  // 采纳云版时把 etag 提交到 durable 轨（cloud-sync.setETag）。见 markSynced 里的长注释。
  setCloudEtag?: (name: string, etag: string | null) => void;
  keyPrefix?: string;
}

export interface LocalHead {
  // ── 读 ──
  ifMatchFor(name: string): string | null;     // push 的 If-Match（封装 bypass 守卫）
  seenBase(name: string): string | null;       // open/refresh「云端动没动」比对
  isDirty(name: string): boolean;               // **本 tab** 视角（驱动 If-Match/episode；W2 要求它 per-tab）
  isDirtyAnywhere(name: string): boolean;      // 任何 tab 有未推字节吗（durable ∨ 内存）——**驱逐守卫专用**
  // ── 写（状态迁移）──
  recordEdit(name: string): void;              // 唯一标脏：原子 dirty + 头一次捕获 _parent←_base
  markSeen(name: string, etag: string | null): void;     // 看到云版(open/refresh meta)：set _base；dirty 缺 parent(reload)→re-capture
  markSynced(name: string, etag: string | null): void;   // 采纳云版(pull/快进/acquire)：set _base + 清 dirty/parent（本地=云端）
  onPushed(name: string, newEtag: string | null, dirtyAfter: boolean): void;  // push 落地
  forget(name: string): void;                            // 清掉该 name 的全部云端谱系（删除/降级 local-only）
}

export function createLocalHead({ kv, getCloudEtag, setCloudEtag, keyPrefix = "head" }: LocalHeadCfg): LocalHead {
  const _base = new Map<string, string | null>();     // 本 tab 已见云 tip（内存，per-tab）
  const _parent = new Map<string, string | null>();   // 未推枝分叉自哪（内存，per-tab）
  const _dirtyMem = new Map<string, boolean>();       // per-tab 活 dirty 视图（覆盖 kv durable）
  const dirtyKey = (n: string) => `${keyPrefix}.dirty:${n}`;

  function isDirty(name: string): boolean {
    if (_dirtyMem.has(name)) return _dirtyMem.get(name)!;   // per-tab 活视图优先
    return kv.get(dirtyKey(name)) === "1";                  // durable 兜底（reload 后）
  }

  // 「**任何** tab 有未推字节吗」——durable ∨ 本 tab 内存。给**驱逐守卫**用，别拿它做 If-Match 判断。
  //
  // 为什么不能把 isDirty 本身改成「durable 的 true 赢」（审计提过，试过，会炸）：
  //   isDirty 驱动 ifMatchFor 的 episode 语义。tab A 推成功后自己 clean（_parent 已删、_base 已知），
  //   此时 tab B 编辑写了 durable dirty=1 —— 若 A 的 isDirty 因此变 true，A 的 ifMatchFor 就会走进
  //   dirty 分支、发现没有 _parent 而 _base 已知 → 抛 BypassError，A 从此推不动。
  //   谱系视角**本来就该是 per-tab 的**（W2 红线），这一点没错。
  //
  // 错的是拿 per-tab 视角去回答一个**全局**问题。驱逐问的是「这份字节别处还有没有」——
  //   tab B 刚写下的未推字节，对 tab A 的内存不可见，但它在 durable 轨上明明白白。
  //   旧版 offload 用 isDirty 守门：B 编辑 → A 的内存仍是 false → 守卫放行 → hardDelete 掉 B 的未推字节。
  //   §A「dirty 永不被驱逐」在这里直接失守。
  function isDirtyAnywhere(name: string): boolean {
    return kv.get(dirtyKey(name)) === "1" || isDirty(name);
  }
  function _setDirty(name: string, d: boolean): void {
    _dirtyMem.set(name, d);
    if (d) kv.set(dirtyKey(name), "1"); else kv.remove(dirtyKey(name));
  }

  function seenBase(name: string): string | null {
    return _base.has(name) ? _base.get(name)! : getCloudEtag(name);   // 缺 _base → 回退共享 etag（非破坏性）
  }

  function ifMatchFor(name: string): string | null {
    if (isDirty(name)) {
      if (_parent.has(name)) return _parent.get(name)!;    // 正常：派生自捕获的 parent（可为 null=新文件）
      // dirty 但没捕获 parent：base 已知 → 谱系断裂（bypass）→ 响亮抛；base 未知 → 真·新文件首推不带 If-Match
      const b = _base.has(name) ? _base.get(name)! : null;
      if (b != null) throw new BypassError(name);
      return null;
    }
    return _parent.has(name) ? _parent.get(name)! : seenBase(name);   // clean：通常走 seenBase（clean 强推=加密 swap）
  }

  function recordEdit(name: string): void {
    if (!isDirty(name)) {                                  // clean→dirty 边沿：头一次捕获（episode 内幂等）
      _parent.set(name, _base.has(name) ? _base.get(name)! : null);
    }
    _setDirty(name, true);
  }

  function markSeen(name: string, etag: string | null): void {
    _base.set(name, etag);
    if (isDirty(name) && !_parent.has(name)) _parent.set(name, etag);   // reload re-capture：闭合唯一缺 parent 窗口
  }

  function markSynced(name: string, etag: string | null): void {
    _base.set(name, etag);
    _setDirty(name, false);
    _parent.delete(name);                                 // 本地已=云端 → episode 结束
    // ★ 采纳云版 = **本地 at-rest 字节此刻等同云端某一版**。这是关于「盘上那份字节是谁」的事实，
    //   不是 per-tab 视角 → 必须落 durable 轨，否则 reload 后无人知道本地这份的出身。
    //
    //   ⚠ 别把这行当 R1 违规删掉（cloud-sync.ts:220 「pull 是纯读，绝不写 etag/dirty」）：
    //   R1 防的是**字节还没落地就先写 etag**（写了就强退 → kv 指新版、盘上是旧字节 → 下次 push
    //   If-Match 通过 = 静默覆盖云端分叉版）。markSynced 的四个调用点全在**字节落地成功之后**：
    //   safe-resolve 的 safePull(local.save 之后) / tryHeal(逐字节确认相等) / weakOverride(推成功后)、
    //   identity.acquire(local.save 之后)。所以这里写 etag 正是 R1 说的「由 caller 在字节真正落地
    //   成功后显式提交」——R1 要求的就是这个时机，不是禁止提交。
    //
    //   ⚠ 也别当 W2 违规（_base/_parent 绝不进共享 kv）：W2 护的是**谱系视角**（别 tab 的 base 污染
    //   本 tab 的 If-Match 判断）。这里写的是 cloud-sync 那条本来就共享的 etag 轨，语义是「盘上字节
    //   对应云端哪一版」——盘本来就是跨 tab 共享的，写它不制造新的共享。
    //
    //   不写会怎样（v418→v431 的真机 bug）：从云端 acquire/pull 来的画只有内存 _base，
    //   reload（**每次版本更新都是一次 reload**）后 seenBase 回退到空的 durable 轨 → null →
    //   freshness.ts 的 `if (base != null)` 重捕守卫进不去 → _parent 永远补不回来 →
    //   ifMatchFor 返 null → conflictBehavior:"fail" → 409 → 保存永远推不上去，且自我延续
    //   （永远不 push 成功 = 永远不写 etag = 每次版本更新必复发）。
    setCloudEtag?.(name, etag);   // etag 为 null（provider 没回）→ 清掉陈旧值，宁可退化成「谱系不明」走冲突面
  }

  function onPushed(name: string, newEtag: string | null, dirtyAfter: boolean): void {
    // 护栏（F0）：「没拿到新 etag」+「当干净落地」= 不可表示的状态——清了 dirty，base 却停在旧值，
    //   未推字节就此可被 offload 合法驱逐（MASTER §A 红线）。这**不应该发生**；发生了就是调用方
    //   把「落地未确认」当成了「落地成功」（push.ts 曾犯，见那里的 deferred 分支）。响亮抛，别自愈——
    //   护栏的意义就是同一个错再犯时能被拦住，而不是悄悄产出错误结果。
    if (newEtag == null && !dirtyAfter) {
      throw new Error(`local-head: "${name}" onPushed(null etag, dirtyAfter=false) —— 落地未确认不得清 dirty`);
    }
    if (newEtag != null) _base.set(name, newEtag);        // 只推进自己的 base
    if (dirtyAfter) {
      _setDirty(name, true);                              // 幂等：显式标脏（不依赖入场态，兼 heal 后路径）
      _parent.set(name, newEtag ?? null);                 // 剩余编辑派生自刚推上去的版本（B2 不丢编辑）
    } else {
      _setDirty(name, false);
      _parent.delete(name);                               // 干净落地：episode 结束
    }
  }

  // 清掉该 name 的全部云端谱系（删除 / 降级 local-only / 改名后的旧名）。
  //   ★ **两条轨道一起清**（v434）。旧版只清内存那条，把 durable 的 files.etag:<name> 留在原地，
  //   于是后来一个**同名新文件**的 seenBase 会回退到那个死 etag（local-head.ts 的 seenBase 回退）→
  //   offload 的 `seenBase(name) == null → local-only 拒绝驱逐` 守卫**从拒绝变成放行**，
  //   而那正是「云端有个同名但不是我的文件」这一情形——守卫存在的理由本身。
  function forget(name: string): void {
    _base.delete(name);
    _parent.delete(name);
    _dirtyMem.delete(name);
    kv.remove(dirtyKey(name));
    setCloudEtag?.(name, null);
  }

  return { ifMatchFor, seenBase, isDirty, isDirtyAnywhere, recordEdit, markSeen, markSynced, onPushed, forget };
}
