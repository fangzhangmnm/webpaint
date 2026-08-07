import type { Bytes } from "./substrate.ts";
import type { CloudProvider, CloudItem } from "./types.ts";
interface Fault {
    op?: string;
    kind: "error" | "lostResponse";
    status?: number;
    message?: string;
    times?: number;
}
interface MockProviderOpts {
    now?: number;
    hook?: (op: string, args: object) => Promise<void> | void;
}
/**
 * @param {object} [opts]
 * @param {number} [opts.now] 固定时间戳（lastModifiedDateTime 用；测试可注入避免 Date.now()）
 * @param {(op:string, args:object)=>Promise<void>|void} [opts.hook] 每个 mutating 操作开头调用，
 *        可在测试里挂起以模拟并发 / race（slice C 的 race-serialize 测试用）。
 */
export interface MockProvider extends CloudProvider {
    injectFault(spec: Fault): MockProvider;
    _dump(): CloudItem[];
    _seed(path: string, bytes: Bytes | string): CloudItem;
}
export declare function createMockProvider(opts?: MockProviderOpts): MockProvider;
export {};
