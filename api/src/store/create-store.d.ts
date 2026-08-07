import type { Bytes } from "./substrate.ts";
import { type CryptoCodec } from "./crypto-container.ts";
import { type ResolveChoice } from "./safe-resolve.ts";
import { type RefreshOpts, type FreshResult } from "./freshness.ts";
import { type DelResult } from "./delete.ts";
import { type Collection, type CollectionConfig } from "./collection.ts";
import { type FolderSnapshot } from "./listing.ts";
import { type UploadReplayPolicy } from "./upload-queue.ts";
import type { CloudProvider, Kv, LocalCache } from "./types.ts";
import { type TrashItem } from "./trash-merge.ts";
import { type StoreErrorLevel } from "./error-handling.ts";
export interface StoreUI {
    busy: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
    resolveConflict: (ctx: {
        name: string;
        local: Blob | null;
        cloud: Blob | null;
    }) => Promise<ResolveChoice>;
    reportError: (err: unknown, level?: StoreErrorLevel) => void;
    offlineEscape?: () => {
        probe: Promise<unknown>;
        settle: () => void;
    };
    onReplayStatus?: (evt: {
        phase: "start" | "pushed" | "collision" | "done";
        name?: string;
        done: number;
        total: number;
    }) => void;
    confirmReplay?: (count: number) => Promise<boolean>;
}
export interface StoreConfig {
    provider: CloudProvider;
    ui: StoreUI;
    appId: string;
    databaseId?: string;
    crypto?: CryptoCodec;
    crypt?: {
        ext?: string;
        makePeek?: (plain: Blob) => Promise<Uint8Array | null>;
        getPassword?: (name: string) => string | null;
    };
    encryptionSaltFileName?: string;
    kv?: Kv;
    local?: LocalCache;
    getPassword?: (name: string) => string | null;
    validateAdopt: (plain: Blob) => boolean | Promise<boolean>;
    fileName?: (name: string) => string;
    encFileName?: (name: string) => string;
    isOnline?: () => boolean;
    signedIn?: () => boolean;
    autoCacheOpenedFile?: boolean;
    offlineUploadReplay?: UploadReplayPolicy;
    skipMigration?: boolean;
    cloudGoneGraceMs?: number;
    activeFileName?: () => string | null;
}
export type TryMoveResult = {
    ok: true;
    where?: string;
    oldName?: string;
    oldKept?: boolean;
    oldUnknown?: boolean;
    oldCloudOrphan?: boolean;
    cloudDeferred?: boolean;
} | {
    ok: false;
    reason: "name-collision";
    where: "local" | "cloud";
};
export type SaveResult = {
    pushed: boolean;
    reason?: string;
};
/** 加密容器的 at-rest 字节（branded）。唯一发牌方 = ZipFile.getEncryptedBlob()。
 *  只收密文的下游（导出 / 拷贝 / checkpoint）用它当形参类型 → 传明文 Blob 编译不过。 */
export type EncryptedBlob = Blob & {
    readonly __encryptedAtRest: unique symbol;
};
export interface RawFile {
    save(bytes: Bytes | Blob, opts?: {
        tryPush?: boolean;
        hint?: unknown;
    }): Promise<SaveResult>;
    open(): Promise<Blob | null>;
    pullIfClean(opts?: RefreshOpts): Promise<FreshResult>;
    tryMove(to: string): Promise<TryMoveResult>;
    delete(): Promise<DelResult>;
    reupload(): Promise<{
        status: string;
    }>;
    isKeptOffline(): Promise<boolean>;
    keepOffline(): Promise<void>;
    offload(): Promise<void>;
    isEncrypted(): Promise<boolean>;
    encrypt(opts?: {
        isOnline?: () => boolean;
    }): Promise<{
        status: string;
    }>;
    decrypt(opts?: {
        isOnline?: () => boolean;
    }): Promise<{
        status: string;
    }>;
    verifyPassword(pw: string): Promise<boolean>;
}
export interface ZipFile extends RawFile {
    getPeek(opts: {
        bytesLength: number;
        zipEntry: string;
    }): Promise<Blob | null>;
    decryptPeek(encPeek: Blob): Promise<Blob | null>;
    /** 本地 at-rest 字节**原样**（内容盲，不解壳）——仅当这份是加密容器时给，否则 null。
     *
     *  为什么需要：`open()` 是**透明解壳**的（拿到的是明文），所以「原样搬密文」的场景——
     *  导出加密作品、拷贝加密作品、给加密作品存 checkpoint——以前根本没有接口，
     *  只能退化成「解密再存/再导出」，那就是明文落盘/明文外流（红线）。
     *
     *  返回 EncryptedBlob（branded）：下游只收密文的 sink 用这个类型签名，
     *  传普通 Blob 直接编译错 —— 把「别把明文当密文传」从人的自觉变成编译期约束。
     *  ⚠ 诚实的边界：TS 证明不了「这坨字节运行时真是密文」；brand 挡的是编码错误，
     *    运行时真相由本方法保证（它是唯一发牌方，非加密件一律返 null）。 */
    getEncryptedBlob(): Promise<EncryptedBlob | null>;
}
export declare function createStore(config: StoreConfig): {
    file: {
        (name: string, opts: {
            isZip: true;
            mode: "new" | "existing";
        }): ZipFile;
        (name: string, opts: {
            isZip: false;
            mode: "new" | "existing";
        }): RawFile;
        (name: string, opts: {
            isZip: boolean;
            mode: "new" | "existing";
        }): RawFile | ZipFile;
    };
    collection: (name: string, opts?: {
        manual?: boolean;
        local?: boolean;
        getInitData?: CollectionConfig["getInitData"];
    }) => Collection;
    files: {
        nameOccupied: (name: string) => Promise<boolean>;
        watchFolder: (folder: string, cb: (s: FolderSnapshot) => void) => () => void;
        usage: () => Promise<{
            bytes: number;
            count: number;
        }>;
        ensureFolder: (path: string) => Promise<void>;
        newFolder: (path: string) => Promise<void>;
        deleteFolder: (path: string) => Promise<void>;
        drainOfflineQueue: () => Promise<void>;
        listTrash: () => Promise<TrashItem[]>;
        listBackup: () => Promise<TrashItem[]>;
        restoreTrash: (opts?: import("./trash.ts").RestoreOpts | undefined) => Promise<import("./trash.ts").TrashResult>;
        purgeTrash: (opts?: import("./trash.ts").PurgeOpts | undefined) => Promise<import("./trash.ts").TrashResult>;
        emptyTrash: (opts?: import("./trash.ts").EmptyTrashOpts | undefined) => Promise<import("./trash.ts").TrashResult>;
        emptyBackup: (opts?: import("./trash.ts").EmptyTrashOpts | undefined) => Promise<import("./trash.ts").TrashResult>;
        reconcileAll: (opts?: {
            activeFileName?: string;
        }) => Promise<{
            demoted: string[];
        }>;
    };
    encryption: {
        /** 是不是加密容器。**只嗅魔数/尾窗**，不派生密钥、不解密（便宜，可用于分流）。 */
        isEncryptedBlob: (blob: Blob | Uint8Array) => Promise<boolean>;
        /** 验密码 + 解出明文，**合一**。null = 错密码（或不是容器）。
         *
         *  为什么合一（这就是「不做重复的计算」）：旧面把它拆成 verifyContainer(验) + unsealWith(解)，
         *  而两者内部都是完整的 unpackContainer —— 导入一个加密文件要把整幅作品**解密两遍**
         *  （密码试错时更多）。7z-wasm 全量解一幅画不是小钱。合一后一次尝试 = 一次解密，
         *  且成功那次的明文直接给调用方复用。
         *  明文只在返回的 Blob 里（内存），库不缓存、不落盘。 */
        tryDecryptEncryptedBlob: (blob: Blob, pw: string) => Promise<Blob | null>;
        /** 这块 blob 是不是**密文 peek**（getPeek 对加密件返回的那种）。纯类型判定，零计算。
         *  取代把 ENC_PEEK_MIME 这个魔法常量导出给 app —— app 要问的是语义，不是常量值。 */
        isEncryptedPeekBlob: (blob: Blob | null | undefined) => boolean;
    };
};
export type Store = ReturnType<typeof createStore>;
