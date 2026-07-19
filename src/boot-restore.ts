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
}

export type RestoreOutcome = "restored" | "gallery-no-name" | "gallery-failed";

export async function restoreLastSession(p: RestorePorts): Promise<RestoreOutcome> {
  const wanted = p.getWantedName();
  if (!wanted) {
    p.setNameMemoryOnly(null);          // 没有上次的画 → 内存名也得是 safe default
    p.updateSaveStatus();
    await p.openGallery();
    return "gallery-no-name";
  }
  if (await p.restore(wanted)) {
    p.onOpened(wanted);
    return "restored";
  }
  // ★ 失败：内存名降回 null（纪律①），持久 currentFile **一个指头都不碰**（纪律②）。
  p.setNameMemoryOnly(null);
  p.updateSaveStatus();
  await p.openGallery();
  p.onNotFound(wanted);
  return "gallery-failed";
}
