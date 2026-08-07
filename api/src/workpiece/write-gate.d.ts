/** 开写窗口（可重入）。务必 try/finally 配对 exitDocWrite。 */
export declare function enterDocWrite(): void;
export declare function exitDocWrite(): void;
/** 便捷包裹：fn 在写窗口内执行。 */
export declare function docWriteWindow<T>(fn: () => T): T;
/** 组合根武装 violation handler（dev throw / prod 上报）。传 null 解除（测试用）。 */
export declare function armDocWriteGate(onViolation: ((what: string) => void) | null): void;
/** PaintDoc mutator 入口调（doc.ts）。窗口外且已武装 → violation。 */
export declare function assertDocWrite(what: string): void;
