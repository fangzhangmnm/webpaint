export type StoreErrorLevel = "error" | "warning" | "info" | "log";
type Reporter = (err: unknown, level: StoreErrorLevel) => void;
/** create-store 装配时注入（把 ui.reportError 接上）。 */
export declare function setStoreErrorReporter(fn: Reporter): void;
/** 深模块上报入口。未装配（如纯 mock 测试未接 ui）→ 静默 no-op（不 throw、不 console）。 */
export declare function reportStoreError(err: unknown, level?: StoreErrorLevel): void;
export {};
