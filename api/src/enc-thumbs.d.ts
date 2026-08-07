/** 本地加密作品的缩略图（内存密码解得开→PNG Blob；锁定/没有→null）。非交互——批量渲染不弹窗。 */
export declare function localPeekThumb(name: string): Promise<Blob | null>;
/** 云端 byte-range 拉回的密文 peek blob（ENC_PEEK_MIME，缓存原样存）→ 明文 PNG Blob | null。非交互，不再重取（直接解传入密文）。 */
export declare function decryptCloudPeekThumb(name: string, encBlob: Blob): Promise<Blob | null>;
/**
 * 确保 name 的密码在内存且验证过。**必须在 withBusy 之外调用**（要弹密码框）。
 * 内存密码先 verify（统一/per-name），不行就 prompt 循环（错→重问，取消→false）。
 * 验证经 store.verifyPassword（解 peek，便宜、不开 UI、不进 busy）。返回 false = 用户取消。
 */
export declare function ensureUnlocked(name: string): Promise<boolean>;
/**
 * 解锁一段**外来的加密容器字节**（导入的文件还没进 store，没 name 可查 peek，只能全量解）。
 * 返回 { pw, plain }：验过的密码 + **解出来的明文**；取消 → null。**busy 外调用。**
 *
 * ⚠ 一次尝试 = 一次解密（v415）。旧版是 verifyContainer(全量解一遍验) + 调用方再 unsealWith(全量解第二遍)，
 *   导入一个加密作品要把整幅画用 7z-wasm 解**两遍**（密码试错时更多）。现在合一，成功那次的明文直接给调用方。
 * 明文只在返回的 Blob 里（内存）；密码不污染全局，记忆由调用方按落库 name 决定。
 */
export declare function unlockImportedContainer(blob: Blob): Promise<{
    pw: string;
    plain: Blob;
} | null>;
/**
 * 首次加密的密码获取：已解锁 → 复用统一密码（不重复问）；锁定 → 设新密码（输两遍 + 一次性风险提示；
 * 不强制强度）。取消 → null。**不**写入 crypto-state（调用方在 flow.encrypt 成功后才 setPassword）。
 */
export declare function ensureNewPassword(): Promise<string | null>;
