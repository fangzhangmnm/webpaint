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
    /** 关闭态恒 false（含容器未配置 auth）。 */
    isCloudEnabled(): boolean;
    /** 关闭态的落点：**不开图库**（图库入口整体隐藏），停在 boot 的空白画布（app.ts 出生即
     *  backend.blank 2048²、无 session 绑定；gallery overlay 本就默认 hidden，所以多半是 no-op+提示）。
     *  ⚠ 纯 UI 落点，零数据变更：currentFile/标记一个都不碰（开关打回来下次冷启动照常自动恢复）。 */
    openBlankCanvas(): Promise<void>;
}
export type RestoreOutcome = "restored" | "gallery-no-name" | "gallery-failed" | "gallery-crash-loop" | "gallery-locked-elsewhere" | "blank-cloud-off";
export declare function restoreLastSession(p: RestorePorts): Promise<RestoreOutcome>;
