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
    /** 上次 boot 留下的 attempt 标记（优雅收场会清 null；非 null = 上次死在开它的半路）。 */
    getRestoreAttempt(): string | null;
    setRestoreAttempt(name: string | null): void;
    /** 标记必须在 restore 之前**落盘**——collection 冷写是 400ms 防抖，OOM 崩溃可比它快。 */
    flushMarker(): Promise<void>;
    onCrashLoopSkipped(name: string): void;
    /** 无 Web Locks 支持时恒 false（整套降级为现状，行为不变）。 */
    isDocLockedElsewhere(name: string): Promise<boolean>;
    onLockedElsewhere(name: string): void;
}
export type RestoreOutcome = "restored" | "gallery-no-name" | "gallery-failed" | "gallery-crash-loop" | "gallery-locked-elsewhere";
export declare function restoreLastSession(p: RestorePorts): Promise<RestoreOutcome>;
