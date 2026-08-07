/** 密码输入弹窗的注入形状（由 composition root 提供，无 DOM 依赖）。 */
export interface PromptOpts {
    title?: string;
    message?: string;
}
type PasswordPrompt = (opts: PromptOpts) => Promise<string | null>;
type LockChangeSub = (unlocked: boolean) => void;
export declare function setPasswordPrompt(fn: PasswordPrompt): void;
export declare function isUnlocked(): boolean;
export declare function setPassword(pw: string | null): void;
/** 锁定 = 忘掉一切密码（内存清除）。加密文件回到锁样式；保存路径会明确报 LOCKED 而非静默。 */
export declare function lock(): void;
/** 锁态变化订阅（图库刷新用）。返回退订函数。 */
export declare function onLockChange(cb: LockChangeSub): () => boolean;
/** 弹一次密码输入（不入库、不验证）。app 没注入 prompt → throw（组装错误，早炸）。 */
export declare function promptPassword(opts?: PromptOpts): Promise<string | null>;
export declare function getPassword(name: string | null): string | null;
export declare function onPasswordVerified(name: string, pw: string): void;
export {};
