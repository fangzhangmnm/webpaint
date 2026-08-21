// instance-locks —— 双实例互认（Web Locks；2026-08-21 双实例侦查案）。
//
// 背景：全仓此前零跨 tab 协调。双 tab 同画编辑 = 本地字节互覆；并发实例还会误触 boot 崩溃环
//   断路器（实例 A 冷启动写了 restoreAttempt 标记、慢加载中用户开实例 B → B 读到标记误判崩溃）。
//
// 职责单一（两个原语，编排在 session-state / boot-restore）：
//   · holdDocLock(name)  —— 为「本 tab 正持有/正尝试打开」的 doc **长持**一把命名排它锁。
//       ifAvailable:true 拿不到**不等待**（别的窗口在编辑 → 我们就不持；入口警告由调用方负责）。
//       锁生命周期 = 本 tab 持有该 doc 期间；换 doc 自动换锁、退图库/无地接管 release。
//       tab 崩溃/关闭 → 浏览器自动释放（Web Locks 语义）——这正是「活实例 vs 真崩溃」的判据。
//   · isDocLockedElsewhere(name) —— query() 查该 doc 的锁是否被**别的** browsing context 持有。
//
// 命名契约：调用方统一传 **app 层裸 session 名**（sessionBareName 归一化后的 _activeSessionName
//   同款；裸名↔全名一一对应，锁身份等价）。锁名 = "weebpaint-doc:<裸名>"。
//
// feature-detect：navigator.locks 不存在（旧浏览器/非安全上下文）→ 整套降级 no-op，行为=现状。
// 失败策略：锁是**建议性护栏**不是数据红线（字节安全由 store 层另修），任何异常都软着陆
//   （reportError "log" + 当作没锁），绝不让锁故障挡住开画。

import { reportError } from "./error-badge.ts";

const LOCK_PREFIX = "weebpaint-doc:";

// 当前长持的锁：release() = resolve 掉喂给 lock manager 的 pending promise → 浏览器收回锁。
let _current: { name: string; release: () => void } | null = null;
// 在途请求失效序号：release/换锁后 grant 才到 → 立即放掉（防「换 doc 比 acquire 回调快」的错持）。
let _seq = 0;

function _locks(): LockManager | null {
  try { return typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null; }
  catch { return null; }
}

/** 长持 name 的 doc 锁（fire-and-forget；同名重入 no-op=续持）。拿不到（别的窗口持有）就不持。 */
export function holdDocLock(name: string): void {
  const locks = _locks();
  if (!locks) return;
  if (_current?.name === name) return;   // 续持（openItem 成功后 _setActive 同名重入）
  releaseDocLock();
  const my = ++_seq;
  locks.request(LOCK_PREFIX + name, { mode: "exclusive", ifAvailable: true }, (lock) => {
    if (!lock) return;         // 别的窗口持有 → 不持（用户在入口已被警告过才走到这）
    if (my !== _seq) return;   // 在途期间已换 doc/释放 → 立即放掉这把过时的锁
    return new Promise<void>((resolve) => { _current = { name, release: resolve }; });
  }).catch((e) => reportError(new Error("[instance-locks] hold failed (soft, lock skipped): " + String(e)), "log"));
}

/** 释放当前 doc 锁（退图库/无地接管/换 doc 前）。无锁时 no-op。 */
export function releaseDocLock(): void {
  _seq++;                      // 作废一切在途 acquire
  if (_current) { const c = _current; _current = null; c.release(); }
}

/** name 的 doc 锁是否被**别的窗口**持有（本 tab 自己持有 → false）。无 Web Locks → 恒 false。 */
export async function isDocLockedElsewhere(name: string): Promise<boolean> {
  const locks = _locks();
  if (!locks || typeof locks.query !== "function") return false;
  if (_current?.name === name) return false;   // 本模块是本 tab 唯一的持锁人 → 本地在册即是自己
  try {
    const snapshot = await locks.query();
    const key = LOCK_PREFIX + name;
    return (snapshot.held ?? []).some((l) => l.name === key);
  } catch (e) {
    reportError(new Error("[instance-locks] query failed (soft, treated as unlocked): " + String(e)), "log");
    return false;
  }
}
