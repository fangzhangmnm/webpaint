interface CachedThumb {
    token: string;
    blob: Blob;
    at: number;
}
export declare const stats: {
    hits: number;
    misses: number;
    errors: number;
};
export declare function resetStats(): void;
export declare const config: {
    skipCache: boolean;
};
/** 读 cache。返回 { token, blob, at } 或 null */
export declare function readCachedThumb(name: string): Promise<CachedThumb | null>;
/** 写 cache（fire-and-forget；失败不影响主流程） */
export declare function writeCachedThumb(name: string, token: string, blob: Blob): Promise<void>;
type ThumbInvalidatedListener = (key: string) => void;
export declare function onThumbInvalidated(fn: ThumbInvalidatedListener): void;
/** 让一件作品的缩略图缓存立即作废（bytes 变了：保存/加密/解密/revert 后）。删同 key + 广播，在世 tile 重取。 */
export declare function invalidateCachedThumb(name: string): Promise<void>;
/**
 * 拿 thumbnail。优先 cache（token 匹配）；miss 走网络（peekTail）+ 回写 cache。
 * 失败：有旧缓存（token 已过期）→ 退旧图（诚实：token 不动，下次仍会重试）；没有 → 抛（caller 显 placeholder）。
 *
 * ⚠ 缓存诚实不变量（QA 2026-08-21「新 token 配旧字节」根修）：**写进缓存的字节必须与 token 同源**。
 *   - token 走云端戳（cloudNewer）时 source 必须 "cloud"：取到云字节才配得上云 token；
 *     取不到（离线/云端无）→ **绝不写缓存**（fetch 抛 → 只走上面的退旧图/抛错路径，writeCachedThumb 不可达）。
 *     若此时拿本地字节回写，缓存就被盖成「云 token + 旧本地字节」= 永不自愈的陈图（token 已最新，再也不重拉）。
 *   - source="local" 时 token 必须是本地态的戳（拼法自洽性见 gallery.ts ThumbCell thumbToken 注释）。
 *
 * @param {string} name       库的裸 session 名（item.name，无后缀 = store.file 的 key）
 * @param {string} token      新鲜度戳（与 source 同源：cloud → 云 lastModified；local → 本地态戳）；变 = 重拉
 * @param {"local"|"cloud"} source  透传库 getPeek（0.3.0 必填）：cloud = 只看云端绝不落回本地
 * @returns {Promise<{ blob: Blob, fromCache: boolean }>}
 */
export declare function getOrFetchCloudThumb(name: string, token: string, source: "local" | "cloud"): Promise<{
    blob: Blob;
    fromCache: boolean;
}>;
/** 调试：清空全部缩略图 cache（清空 gallery-thumbs store，返删除数） */
export declare function clearCloudThumbCache(): Promise<number>;
export {};
