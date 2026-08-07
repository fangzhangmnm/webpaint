export type ErrorLevel = "error" | "warning" | "info" | "log";
/** app 在 boot 时注入状态栏 sink（info 级走这里）+ 接管全局 fatal handler。 */
export declare function initErrorBadge(deps: {
    status: (text: string, persist?: boolean) => void;
}): void;
/**
 * 唯一 error 上报入口。app 各处 catch / store 的 ui.reportError 都汇到这里。
 * @param err   任意错误（Error / string / 对象）
 * @param level 默认 "error"。见文件头分流表。
 */
export declare function reportError(err: unknown, level?: ErrorLevel): void;
