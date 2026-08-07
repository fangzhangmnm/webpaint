/** 何时封存 checkpoint。**显式枚举**而不是在 adopt 里埋钩子——因为 revert 也走 adopt，
 *  埋在里面就会「回滚完顺手把快照覆盖掉」。加新入口时来这里加一条，别在深处埋。 */
export type CheckpointTrigger = "gallery-open" | "new-doc" | "save-as" | "boot-restore" | "revert";
export declare function shouldCapture(trigger: CheckpointTrigger): boolean;
/** checkpoint 的 IDB key。fullName = 库身份全名（X.ora），slot 恒 0（结构留多档余地）。
 *  `:` 安全：文件名里的 `:` 被 config.sessionFileName 剥掉了，不会和分隔符打架。 */
export declare function checkpointKey(fullName: string, slot?: number): string;
/** 一条 checkpoint 记录。bytes = **at-rest 字节**：加密件是密文容器，明文件是明文 ora。 */
export interface CheckpointRecord {
    name: string;
    slot: number;
    at: number;
    bytes: Blob;
    encrypted: boolean;
}
/** 显示用：距今多少分钟（至少 1，避免「回到 0 分钟前」这种废话）。 */
export declare function checkpointAgeMinutes(at: number, now: number): number;
