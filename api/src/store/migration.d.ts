import type { Kv } from "./types.ts";
export type SchemaVersion = `v${string}`;
/** 解析 vNNN-yyyymmdd。合法 → { seq, date }；非法 → null。 */
export declare function parseSchemaVersion(v: string): {
    seq: number;
    date: string;
} | null;
/** current 落后于 target（= 需要跑迁移）？null/损坏戳 → true（保守；迁移幂等无害）；否则按 seq 比。target 非法 → 抛。 */
export declare function needsMigration(current: string | null, target: SchemaVersion): boolean;
export interface StoreNamespace {
    root: string;
    dbName: string;
    schemaKey: string;
}
export declare function storeNamespace(appId: string, databaseId: string): StoreNamespace;
/** 迁移需要枚举键（运行时 Kv 不需要 → 不在 Kv 契约里）。prod 包 localStorage，测试用 mem。 */
export interface MigrationKv extends Kv {
    keys(): string[];
}
/** 一条迁移拿到的上下文：可枚举 kv + 命名空间（dbName/etag/dirty 前缀等，改结构按需取）+ 日志。 */
export interface MigrationCtx {
    kv: MigrationKv;
    ns: StoreNamespace;
    log?: (msg: string) => void;
}
export interface Migration {
    version: SchemaVersion;
    describe: string;
    run(ctx: MigrationCtx): Promise<void>;
}
/**
 * 有序注册表：每次动 kv/IDB 结构加一条，version 单调递增。
 * **现为空**——库以最新标准出生（无用户/无后向兼容，2026-07-13 清 V001/V002 tax）。
 */
export declare const MIGRATIONS: readonly Migration[];
/**
 * 读戳 → 按序跑欠的迁移 → **run 成功后才盖新戳**（崩了不盖→下次重跑）。幂等：戳已到位则整体 no-op。
 * createStore 在 ready-gate 前 await 本函数（迁移未完不提供任何读）。MIGRATIONS 空 → 直接返回、不写戳。
 * migrations 参数默认 = MIGRATIONS（prod）；测试注入合成列表验编排机制（版本戳单调/幂等/崩溃安全）。
 */
export declare function runMigrations(ctx: MigrationCtx, migrations?: readonly Migration[]): Promise<void>;
/** prod：包 localStorage 成 MigrationKv（keys 经 Object.keys）。 */
export declare function localStorageMigrationKv(): MigrationKv;
/** prod 组装 + 跑（createStore 在 ready-gate 前调）。命名空间根 = `${appId}.${databaseId}`。
 *  kv 经 namespacedKv 包过 → migration 内所有键读写自动落 `${root}.` 命名空间（含 keys() 只列本命名空间）。 */
export declare function runStoreMigrations(appId: string, databaseId: string, log?: (m: string) => void): Promise<void>;
