import { type CacheRecord } from "./idb-store.ts";
export type Partition = "files" | "trash" | "backup" | "collections";
export interface PartitionView {
    get(name: string): Promise<CacheRecord | undefined>;
    put(name: string, rec: CacheRecord): Promise<void>;
    del(name: string): Promise<void>;
    exists(name: string): Promise<boolean>;
    keys(): Promise<string[]>;
    usage(): Promise<{
        bytes: number;
        count: number;
    }>;
    moveTo(name: string, to: Partition, toName: string): Promise<void>;
}
export interface PartitionedBlobStore {
    partition(p: Partition): PartitionView;
}
export declare function createPartitionedBlobStore(dbName: string): PartitionedBlobStore;
