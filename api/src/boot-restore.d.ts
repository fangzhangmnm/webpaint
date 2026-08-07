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
export declare function restoreLastSession(p: RestorePorts): Promise<RestoreOutcome>;
