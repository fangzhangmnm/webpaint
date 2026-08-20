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
 * 失败抛错（caller 显示 placeholder）。
 *
 * @param {string} name       库的裸 session 名（item.name，无后缀 = store.file 的 key）
 * @param {string} token      新鲜度戳（cloud.lastModifiedDateTime 优先，退 size）；变 = 重拉
 * @returns {Promise<{ blob: Blob, fromCache: boolean }>}
 */
export declare function getOrFetchCloudThumb(name: string, token: string): Promise<{
    blob: Blob;
    fromCache: boolean;
}>;
/** 调试：清空全部缩略图 cache（清空 gallery-thumbs store，返删除数） */
export declare function clearCloudThumbCache(): Promise<number>;
export {};
