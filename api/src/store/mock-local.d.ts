import type { Bytes } from "./substrate.ts";
import type { LocalCache } from "./types.ts";
interface TrashItem {
    name: string;
    bytes: Bytes;
}
export interface MockLocal extends LocalCache {
    _items: Map<string, Bytes>;
    _trash: Map<string, TrashItem>;
}
export declare function createMockLocal(): MockLocal;
export {};
