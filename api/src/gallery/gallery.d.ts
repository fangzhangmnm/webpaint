export interface GalleryHost {
    signedIn(): boolean;
    online(): boolean;
    activeName(): string | null;
    confirm(title: string, msg: string): Promise<boolean>;
    input(title: string, def: string, opts?: {
        placeholder?: string;
    }): Promise<string | null>;
    chooseFolder(title: string, msg: string, options: {
        label: string;
        value: string;
    }[]): Promise<string | null>;
    status(msg: string, isError?: boolean): void;
    busy<T>(label: string, fn: () => Promise<T>): Promise<T>;
    /** 本地字节是不是加密容器（纯本地 IDB 读文件头，无网络）。gallery 按夹探测锁态用。 */
    isEncrypted(name: string): Promise<boolean>;
    /** 交互解锁（busy 外弹密码 + verifyPassword）。成功 → true。 */
    unlock(name: string): Promise<boolean>;
}
export interface GalleryHandle {
    refresh(): void;
    setView(v: "files" | "trash"): void;
    getView(): "files" | "trash";
    setFolder(path: string): void;
    hydrateFolder(path: string): void;
    getFolder(): string;
    emptyTrash(scope?: "local" | "cloud" | "both"): void;
    /** 在当前夹找一件本地加密作品并交互解锁；本夹没有 → false。 */
    requestUnlock(): Promise<boolean>;
    /** #11：某项的加密态字节换了体（编辑器侧加密/解除）→ 清该项锁态缓存重探。
     *  没有它 refresh() 不够——probeEncrypted 的 `nm in encByName` 缓存守卫会跳过已探项，小锁图标 stale。 */
    invalidateEncrypted(name: string): void;
    unmount(): void;
}
export declare function mountGallery(el: HTMLElement, host: GalleryHost): GalleryHandle;
