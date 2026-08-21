/** persistent = 浏览器承诺不主动驱逐；best-effort = 可能被整源清掉；unsupported/error = 不可知，按最坏假设。 */
export type PersistenceState = "unknown" | "unsupported" | "persistent" | "best-effort" | "error";
/** 当前已知的存储持久性。boot 的 ensureStoragePersistence() 跑完前是 "unknown"。 */
export declare function getStoragePersistence(): PersistenceState;
/** 本地作品是否可能被浏览器整源驱逐（"unknown" 也算 true —— 未知按最坏假设，不许乐观）。 */
export declare function localStorageIsEvictable(): boolean;
/** boot 时调一次。幂等（已 persistent 直接返回，不重复申请）。fire-and-forget 安全：自己吞异常。 */
export declare function ensureStoragePersistence(): Promise<PersistenceState>;
