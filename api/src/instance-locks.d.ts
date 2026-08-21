/** 长持 name 的 doc 锁（fire-and-forget；同名重入 no-op=续持）。拿不到（别的窗口持有）就不持。 */
export declare function holdDocLock(name: string): void;
/** 释放当前 doc 锁（退图库/无地接管/换 doc 前）。无锁时 no-op。 */
export declare function releaseDocLock(): void;
/** name 的 doc 锁是否被**别的窗口**持有（本 tab 自己持有 → false）。无 Web Locks → 恒 false。 */
export declare function isDocLockedElsewhere(name: string): Promise<boolean>;
