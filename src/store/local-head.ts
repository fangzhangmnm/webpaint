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
  keyPrefix?: string;
}

export interface LocalHead {
  // ── 读 ──
  ifMatchFor(name: string): string | null;     // push 的 If-Match（封装 bypass 守卫）
  seenBase(name: string): string | null;       // open/refresh「云端动没动」比对
  isDirty(name: string): boolean;
  // ── 写（状态迁移）──
  recordEdit(name: string): void;              // 唯一标脏：原子 dirty + 头一次捕获 _parent←_base
  markSeen(name: string, etag: string | null): void;     // 看到云版(open/refresh meta)：set _base；dirty 缺 parent(reload)→re-capture
  markSynced(name: string, etag: string | null): void;   // 采纳云版(pull/快进/acquire)：set _base + 清 dirty/parent（本地=云端）
  onPushed(name: string, newEtag: string | null, dirtyAfter: boolean): void;  // push 落地
  forget(name: string): void;                            // 清掉该 name 的全部云端谱系（删除/降级 local-only）
}

export function createLocalHead({ kv, getCloudEtag, keyPrefix = "head" }: LocalHeadCfg): LocalHead {
  const _base = new Map<string, string | null>();     // 本 tab 已见云 tip（内存，per-tab）
  const _parent = new Map<string, string | null>();   // 未推枝分叉自哪（内存，per-tab）
  const _dirtyMem = new Map<string, boolean>();       // per-tab 活 dirty 视图（覆盖 kv durable）
  const dirtyKey = (n: string) => `${keyPrefix}.dirty:${n}`;

  function isDirty(name: string): boolean {
    if (_dirtyMem.has(name)) return _dirtyMem.get(name)!;   // per-tab 活视图优先
    return kv.get(dirtyKey(name)) === "1";                  // durable 兜底（reload 后）
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
  }

  function onPushed(name: string, newEtag: string | null, dirtyAfter: boolean): void {
    if (newEtag != null) _base.set(name, newEtag);        // 只推进自己的 base
    if (dirtyAfter) {
      _setDirty(name, true);                              // 幂等：显式标脏（不依赖入场态，兼 heal 后路径）
      _parent.set(name, newEtag ?? null);                 // 剩余编辑派生自刚推上去的版本（B2 不丢编辑）
    } else {
      _setDirty(name, false);
      _parent.delete(name);                               // 干净落地：episode 结束
    }
  }

  function forget(name: string): void {
    _base.delete(name);
    _parent.delete(name);
    _dirtyMem.delete(name);
    kv.remove(dirtyKey(name));
  }

  return { ifMatchFor, seenBase, isDirty, recordEdit, markSeen, markSynced, onPushed, forget };
}
