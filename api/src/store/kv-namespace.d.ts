import type { Kv } from "./types.ts";
export interface KeyedKv extends Kv {
    keys?(): string[];
}
export interface NamespacedKv extends Kv {
    keys(): string[];
}
export declare function namespacedKv(kv: KeyedKv, ns: string): NamespacedKv;
