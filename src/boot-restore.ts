// boot-restore —— 「冷启动要不要自动打开上次那张画」的**纯编排**（v438）。
//
// 为什么单独一个文件：boot.ts 静态 import 了 session-state → app-store（模块求值就建 store）→ vue …
//   所以 boot.ts **在 node 测试里 import 不动**，这段逻辑一直零覆盖。而它守着两条真纪律：
//     ① 幽灵路径（feedback-phantom-current-path）：加载失败时内存名必须降回 safe default，
//        否则后续 save/rename 会把「加载失败的那个 path」当 oldName 去动（AtlasMaker 0.7.2 吃过一个加密文件）。
//     ② 失败**不清**持久的 currentFile：失败常是瞬态的（取消密码框 / 离线只有云端副本 / 文件锁定），
//        清了用户下次冷启动就再也不会自动开这张画。v406-v408 这里无条件 setName(null) 把两者一起清了，v409 修。
//   两条都是「失败路径上的事」，恰恰是最不容易被真机测到、也最容易被下一次重构悄悄改掉的部分。
//
// 端口全注入 → 这个模块对 app 一无所知，测试可以直接驱动它。

export interface RestorePorts {
  /** 持久层记的「上次打开的是谁」。空 → 停在图库。 */
  getWantedName(): string | null;
  /** 真正去开（store.file.open + adopt）。返回是否装入了字节。 */
  restore(name: string): Promise<boolean>;
  /** 只改内存里的活动名，**不动持久的 currentFile**（= session.setName(x, {persist:false})）。 */
  setNameMemoryOnly(name: string | null): void;
  openGallery(): Promise<void>;
  updateSaveStatus(): void;
  onOpened(name: string): void;
  onNotFound(name: string): void;
  // ── 崩溃环断路器（v0.10.9，纪律③）：跨崩溃记「正在开谁」的持久标记（appState.restoreAttempt）──
  /** 上次 boot 留下的 attempt 标记（优雅收场会清 null；非 null = 上次死在开它的半路）。 */
  getRestoreAttempt(): string | null;
  setRestoreAttempt(name: string | null): void;
  /** 标记必须在 restore 之前**落盘**——collection 冷写是 400ms 防抖，OOM 崩溃可比它快。 */
  flushMarker(): Promise<void>;
  onCrashLoopSkipped(name: string): void;
  // ── 双实例互认（Web Locks，2026-08-21 双实例案）：wanted 是否被**别的窗口**持有 ──
  /** 无 Web Locks 支持时恒 false（整套降级为现状，行为不变）。 */
  isDocLockedElsewhere(name: string): Promise<boolean>;
  onLockedElsewhere(name: string): void;
}

export type RestoreOutcome = "restored" | "gallery-no-name" | "gallery-failed" | "gallery-crash-loop" | "gallery-locked-elsewhere";

export async function restoreLastSession(p: RestorePorts): Promise<RestoreOutcome> {
  const wanted = p.getWantedName();
  if (!wanted) {
    p.setNameMemoryOnly(null);          // 没有上次的画 → 内存名也得是 safe default
    p.updateSaveStatus();
    await p.openGallery();
    return "gallery-no-name";
  }
  // ★ 纪律④（双实例互认，2026-08-21）：wanted 正被**另一个活窗口**持有 ⇒ ① 不自动开
  //   （双 tab 同画编辑 = 本地字节互覆，入口拦住）；② 这也**不是崩溃**——上一实例还活着，
  //   restoreAttempt 标记只是还没到清点（慢加载/正编辑中）。所以本检查必须排在断路器判定
  //   **之前**：否则「A 冷启动写了标记、慢加载中用户开 B」会让 B 读到 A 的在途标记误判崩溃环。
  //   标记**原样不动**（不写不清）——断路器语义不被消耗：A 若真死在半路，锁被浏览器自动释放
  //   （Web Locks 语义），下次 boot 无锁 + 标记在场 → 照常断路。
  if (await p.isDocLockedElsewhere(wanted)) {
    p.setNameMemoryOnly(null);
    p.updateSaveStatus();
    await p.openGallery();
    p.onLockedElsewhere(wanted);
    return "gallery-locked-elsewhere";
  }
  // ★ 纪律③（崩溃环断路，v0.10.9）：标记 == 想开的画 ⇒ 上次 boot 死在开它的半路（小内存设备
  //   开超大文件 OOM 被杀等——tab 直接死，永远走不到下面的「优雅失败」分支）。若无此闸，
  //   currentFile 有意不清（纪律②）+ 无条件自动开 = 每次冷启动重开必死的画，用户连图库都进不去。
  //   跳过自动开、停图库；标记**保留**（之后每次 boot 都跳），直到任意画成功打开
  //   （setCurrentSessionName 清标记）或下次自动开换了目标（下面 setRestoreAttempt 覆写）。
  if (p.getRestoreAttempt() === wanted) {
    p.setNameMemoryOnly(null);
    p.updateSaveStatus();
    await p.openGallery();
    p.onCrashLoopSkipped(wanted);
    return "gallery-crash-loop";
  }
  p.setRestoreAttempt(wanted);
  await p.flushMarker();
  if (await p.restore(wanted)) {
    p.setRestoreAttempt(null);          // 优雅收场①：成功（setCurrentSessionName 也会清——幂等）
    p.onOpened(wanted);
    return "restored";
  }
  // ★ 失败：内存名降回 null（纪律①），持久 currentFile **一个指头都不碰**（纪律②）。
  //   标记也清——优雅失败=瞬态（取消密码框/离线只有云端副本/文件锁定），下次冷启动照常 retry，
  //   纪律②的语义不被断路器毒化。
  p.setRestoreAttempt(null);
  p.setNameMemoryOnly(null);
  p.updateSaveStatus();
  await p.openGallery();
  p.onNotFound(wanted);
  return "gallery-failed";
}
