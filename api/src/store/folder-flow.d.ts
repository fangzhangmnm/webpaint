import type { FolderConflictPolicy } from "./folder-merge.ts";
import type { FolderEnvelope, ResolveFn } from "./folder-merge.ts";
import type { Bytes, CloudSync } from "./types.ts";
export interface FolderFlowResult {
    status: "synced" | "offline" | "invalid" | "dirty";
    folder: FolderEnvelope;
    etag?: string | null;
    pushed?: boolean;
    error?: unknown;
}
export interface FolderFlowConfig {
    cloud: CloudSync;
    name: string;
    encode: (folder: FolderEnvelope) => Bytes | Blob;
    decode: (text: string) => FolderEnvelope | null;
    resolve?: ResolveFn;
    conflictPolicy?: FolderConflictPolicy;
    isOnline?: () => boolean;
    timeoutMs?: number;
}
export interface FolderFlow {
    sync(localFolder: FolderEnvelope): Promise<FolderFlowResult>;
}
/**
 * @param {object} cfg
 * @param {object} cfg.cloud      一个 CloudSync 实例（pull/push/getETag…）
 * @param {string} cfg.name       同步键（如 "rack"）
 * @param {(folder)=>Blob} cfg.encode   folder → 上传字节（app 决 envelope 格式）
 * @param {(text:string)=>object|null} cfg.decode  云端字节 → folder（含旧格式迁移；非法/脏字节返 null=伪在线防线）
 * @param {(x,y)=>object} [cfg.resolve]  字段级合并 override（罕见；默认整 entry LWW）
 * @param {()=>boolean} [cfg.isOnline]
 * @param {number} [cfg.timeoutMs=15000]
 */
export declare function createFolderFlow(cfg: FolderFlowConfig): FolderFlow;
