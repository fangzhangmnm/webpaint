// ⚠ 使用前必读 README.md + CONTEXT.md + DATA SAFETY GUIDELINE.md。store 内部深模块——app 不 import。
//
// pending-gone（深模块）—— 云端防抖标记（cloud-gone 收敛从「demote local-only」升级为「去抖后 send trash」的守卫）。
//   语义（用户拍板 2026-07-17）：本地 clean = 云端曾有备份；之后云端持续缺失（权威见 gone）= 用户同意的删除。
//   但绝不一次网抖就删——**第一次见 gone 只标记（@ firstSeenGoneAt），连续第二次+权威见 gone 且跨过 GRACE 才动手**。
//   动手 = 本地 send trash（可恢复）；重现即自愈（清标记）；grace 内被编辑 → 立即清标记（当正常 dirty）。
//
// 持久：kv 相对键 `internal.pending_gone`（namespacedKv 补 `${appId}.${databaseId}.` 根前缀，与 pending_deletions/_uploads 同族）。
//   **不新增 IDB object store**；pendingGone badge 是 listing 时从本模块派生的 syncState，不单独落库。

import { reportStoreError } from "./error-handling.ts";   // 全接但分级：静默 swallow 也 funnel（不改控制流）
import type { Kv } from "./types.ts";

const KEY = "internal.pending_gone";   // 相对键 → `${ns}.internal.pending_gone`

export interface PendingGone {
  /** 该 name 当前是 candidate-gone（grace 期内、显 pendingGone badge）。 */
  isPending(name: string): boolean;
  /** 记一次**权威**「见 gone」。返回是否**该动手**（send trash）：首次只标记返 false；已标记且 `now-first ≥ grace` → true。 */
  seenGone(name: string, now: number): boolean;
  /** 清标记（重现自愈 / 被编辑取消 / 动手后收尾）。 */
  clear(name: string): void;
  /** 当前所有 candidate 名（调试/审计）。 */
  names(): string[];
}

export function createPendingGone(kv: Kv, graceMs: number): PendingGone {
  function read(): Record<string, number> {
    try { const raw = kv.get(KEY); return raw ? JSON.parse(raw) : {}; } catch (e) { reportStoreError(e, "log"); return {}; }
  }
  function write(m: Record<string, number>): void {
    if (Object.keys(m).length) kv.set(KEY, JSON.stringify(m)); else kv.remove(KEY);
  }
  return {
    isPending(name) { return read()[name] != null; },
    seenGone(name, now) {
      const m = read();
      const first = m[name];
      if (first == null) { m[name] = now; write(m); return false; }   // 第一次权威见 gone：标记 @ now，**不动手**（防单次网抖误删）
      if (now - first >= graceMs) return true;                         // 已标记 + 跨过 GRACE（第二次+权威见 gone）→ 动手
      return false;                                                    // 仍在 grace 内 → 继续等（照常显示 + badge）
    },
    clear(name) { const m = read(); if (m[name] != null) { delete m[name]; write(m); } },
    names() { return Object.keys(read()); },
  };
}
