import type { CloudItem, CloudProvider, CloudSync, Kv } from "./types.ts";
export declare class CloudConflictError extends Error {
    sessionName: string;
    constructor(message: string, sessionName: string);
}
export type NameCollisionWhere = "local" | "cloud";
export declare class CloudNameCollisionError extends Error {
    sessionName: string;
    where: NameCollisionWhere;
    constructor(sessionName: string, where?: NameCollisionWhere);
}
/** 内存 kv（测试用；WebPaint 传 localStorage 包装）。 */
export declare function memKv(): Kv;
interface CloudSyncCfg {
    provider: CloudProvider;
    kv: Kv;
    fileName: (name: string) => string;
    /** 加密容器的云端命名（ADR-0012：加密文件外部扩展名 = .zip，防软件按 .ora/.txt 误认；
     *  容器本来就是标准 zip，名实相符）。不配置 = 扩展名翻转关（兄弟 app 未接加密时零影响）。 */
    encFileName?: (name: string) => string;
    contentType?: string;
    trashFolder?: string;
    backupFolder?: string;
    appKey?: string;
    /** false = 本实例不 track dirty（setDirty/isDirty/clearState 对 dirty 键全 no-op）。
     *  files 实例用 false：文件 dirty 权威在 local-head 的 `${ns}.files.dirty:`；若 cloud-sync 也写同键，
     *  push 成功后写 "0" 会与「push 期间用户新编辑写 '1'」竞态、把未推编辑误判 clean → 被驱逐（§A 最狠红线）。
     *  collections 实例用默认 true（collection 的 dirty 权威就在 cloud-sync）。 */
    manageDirty?: boolean;
    now?: () => number;
    match?: (it: CloudItem) => boolean;
    toName?: (name: string) => string;
}
/**
 * @param {object} cfg
 * @param {object} cfg.provider  低层 CloudProvider
 * @param {object} cfg.kv        { get, set, remove }（etag/dirty 缓存）
 * @param {(name:string)=>string} cfg.fileName  session name → 云端文件名（如 n => n + ".ora"）
 * @param {string} [cfg.contentType]
 * @param {string} [cfg.trashFolder=".trash"]
 * @param {string} [cfg.appKey="sync"]  kv key 前缀
 * @param {()=>number} [cfg.now]  时钟（测试注入；默认 Date.now）
 */
export declare function createCloudSync(cfg: CloudSyncCfg): CloudSync;
export {};
