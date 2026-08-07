import type { CloudItem, TrashEntry } from "./types.ts";
export interface TrashItem {
    name: string;
    ts: string | null;
    side: "local" | "cloud" | "both";
    encrypted: boolean;
    conflictLive: boolean;
    localKey: string | null;
    cloudItemId: string | null;
}
/**
 * 两端聚合。
 * @param localEntries  local.listTrash()/listBackup() 结果（name = 全路径原名）。
 * @param cloudEntries  cloud.listTrash()/listBackup() 结果（name = stamped 云端文件名）。
 * @param liveCloudNames 权威 live 云端身份集合（listAll.complete 时才传真值；离线/partial 传空 set → conflictLive 恒 false，绝不误报）。
 */
export declare function mergeTrash(localEntries: TrashEntry[], cloudEntries: CloudItem[], liveCloudNames?: Set<string>): TrashItem[];
