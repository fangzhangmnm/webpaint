export interface VerifierRecord {
    v: 1;
    salt: string;
    iv: string;
    ct: string;
}
/** pw → 新 verifier 记录。 */
export declare function createVerifierRecord(pw: string): Promise<VerifierRecord>;
/** 记录 + pw → 是否匹配（GCM tag 即验证）。 */
export declare function verifyRecord(rec: VerifierRecord, pw: string): Promise<boolean>;
export declare function hasVerifier(): boolean;
/** 记住「图库密码 = pw」（覆盖旧 verifier；创建/首次验证成功时调）。 */
export declare function createVerifier(pw: string): Promise<void>;
/** 校验：ok=密码对；bad=密码错；none=没有 verifier（老账号未迁 / 已重置）。 */
export declare function checkVerifier(pw: string): Promise<"ok" | "bad" | "none">;
/** 重置（用户显式确认后）：只清 verifier——旧加密件仍是旧密码，永不可用新密码解。 */
export declare function clearVerifier(): void;
