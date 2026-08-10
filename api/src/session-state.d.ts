import { type DecodedPainting } from "./ora.ts";
import type { EncryptedBlob } from "./store/index.ts";
import type { AppContext } from "./app-context.ts";
import type { GalleryItem } from "./gallery/gallery-model.ts";
type LoadedDoc = DecodedPainting;
/** 外部导入：装入一个解好的 doc，作为**新身份**。首存 mode:"new"（撞名抛，不静默覆盖）。 */
declare function adoptAsNew(loaded: LoadedDoc, name: string): void;
/** revert 回滚：装入一个解好的 doc，身份**不变**（首存 mode:"existing"，就是要写回原文件）。
 *  **不封存 checkpoint** —— 否则刚回滚掉的状态立刻把快照覆盖了，只能 revert 一次。 */
declare function adoptAsExisting(loaded: LoadedDoc, name: string): void;
/** 读回快照。加密的先解壳（内存密码；锁定/错密码 → null 由调用方提示要密码）。 */
declare function _readSessionCheckpoint(name: string): Promise<{
    blob: Blob;
    at: number;
} | null>;
/** 作品被删/改名 → 丢掉它的快照（按 key 精确清，**不做全库扫描**）。 */
declare function _dropCheckpoint(name: string): Promise<void>;
declare function saveNow(opts?: {
    implicit?: boolean;
}): Promise<void>;
declare function saveAndPush(): Promise<void>;
declare function encryptCurrent(): Promise<void>;
declare function decryptCurrent(): Promise<void>;
declare function renameCurrentSession({ suggested, reason }?: {
    suggested?: string;
    reason?: string;
}): Promise<string | null>;
declare function exitCanvasToGallery(): Promise<void>;
declare function newDoc({ name, w, h, layer0Name, fillLayer0 }: {
    name: string;
    w: number;
    h: number;
    layer0Name?: string;
    fillLayer0?: (layer: unknown) => void;
}): Promise<void>;
declare function openItem(item: GalleryItem): Promise<void>;
declare function pushItem(item: GalleryItem): Promise<void>;
declare function unloadItem(item: GalleryItem): Promise<void>;
declare function restoreSession(name: string): Promise<boolean>;
declare function saveAs(newName: string): Promise<void>;
declare function setName(name: string | null, opts?: {
    persist?: boolean;
}): void;
export declare const session: {
    enc: {
        encrypted: boolean;
    };
    encryptCurrent: typeof encryptCurrent;
    decryptCurrent: typeof decryptCurrent;
    readonly name: string | null;
    readonly loadingDoc: boolean;
    readonly loadedDocIsNewer: boolean;
    readonly loadedDocNewerConfirmed: boolean;
    readonly dirty: boolean;
    readonly pushPending: boolean;
    readonly saving: boolean;
    markEdited(): void;
    setName: typeof setName;
    restore: typeof restoreSession;
    saveAs: typeof saveAs;
    save: typeof saveNow;
    saveAndPush: typeof saveAndPush;
    adoptAsNew: typeof adoptAsNew;
    adoptAsExisting: typeof adoptAsExisting;
    rename: typeof renameCurrentSession;
    exit: typeof exitCanvasToGallery;
    newDoc: typeof newDoc;
    open: typeof openItem;
    push: typeof pushItem;
    unload: typeof unloadItem;
    /** 当前作品的 at-rest **密文**字节（原样，不解壳、不要密码）。非加密件 → null。
     *  先 saveNow()：at-rest 字节是「上次保存」的内容，不先落盘就会导出成旧版本。 */
    readEncryptedBytes(): Promise<EncryptedBlob | null>;
    readCheckpoint: typeof _readSessionCheckpoint;
    dropCheckpoint: typeof _dropCheckpoint;
    awaitCloudPushIdle: () => Promise<void>;
};
export declare function initSession(ctx: AppContext): void;
export declare function setSessionGallery(g: AppContext["gallery"]): void;
export {};
