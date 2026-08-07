export interface CacheRecord {
    blob: Blob;
    updatedAt: number;
}
export type IdbCache = ReturnType<typeof createIdbCache>;
/** 建一个绑定到具体 IDB 库名的字节缓存(store 内部)。dbName 必须已带 app 命名空间(见上)。 */
export declare function createIdbCache(dbName: string): {
    get(name: string): Promise<CacheRecord | undefined>;
    put(name: string, rec: CacheRecord): Promise<void>;
    del(name: string): Promise<void>;
    keys(): Promise<string[]>;
    /** 按 key 前缀汇总占用（单事务 cursor 走一遍；`Blob.size` 是引用属性，**不把字节读进内存**）。
     *  只返两个标量，不返任何名字 —— 拿不到清单，故**不能**当全库列举用（那是被否决的退化设计）。 */
    usage(prefix: string): Promise<{
        bytes: number;
        count: number;
    }>;
    /** 原子改名(同一事务 get→put 新→del 旧):trash/restore/backup 用。源不存在则 noop。 */
    rename(from: string, to: string): Promise<void>;
};
