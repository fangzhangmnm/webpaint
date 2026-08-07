export interface CryptoCodec {
    zipPack(entries: {
        path: string;
        data: Uint8Array | string;
    }[]): Promise<Blob>;
    zipUnpack(blob: Blob): Promise<Record<string, Uint8Array>>;
    pack7z(entries: {
        path: string;
        data: Uint8Array | string;
    }[], password: string): Promise<Uint8Array>;
    unpack7z(bytes: Uint8Array, password: string): Promise<Record<string, Uint8Array>>;
}
/** createStore config 提供 zip/7z codec 时调用;不调 = 加密不可用。 */
export declare function configureCryptoCodec(c: CryptoCodec | null): void;
export declare const PEEK_MAGIC: number[];
export declare const PEEK_TAIL_WINDOW = 98304;
export declare const ENC_PEEK_MIME = "application/x-sync-store-enc-peek";
export declare const CONTAINER_PEEK_ENTRY = "peek";
export declare const CONTAINER_PEEK_ENTRIES: readonly string[];
export interface EncPeekParsed {
    start: number;
    end: number;
    ver: number;
    salt: Uint8Array;
    iv: Uint8Array;
    ct: Uint8Array;
}
export interface ContainerMeta {
    v: number;
    name: string | null;
    ext: string;
}
export declare function makeGuid(): string;
/** 不透明字节（可空）→ 完整加密 peek blob 字节（含 MAGIC 头）。空也加密（探测标记必须在）。 */
export declare function encryptPeek(bytes: Uint8Array | null, password: string): Promise<Uint8Array>;
/** 从字节流**末尾向前**扫加密 peek blob。带 sanity（ver/len/边界），false-positive 继续向前。
 *  找不到返 null。 */
export declare function scanEncPeekFromEnd(u8: Uint8Array): EncPeekParsed | null;
/** 解密 peek → 不透明字节（可能为空）。密码错 → throw code=WRONG_PASSWORD（GCM tag 即验证器）。 */
export declare function decryptPeek(parsed: EncPeekParsed, password: string): Promise<Uint8Array>;
/** 这份字节是不是加密容器？两条便宜判据：
 *   ① 尾部 peek MAGIC——app 自造容器**必带**（所有版本，含 v233-235 老 WinZip-AES 容器）；
 *   ② offset 0 = .7z magic——裸 .7z（用户手工 mock，无外壳无 peek）。
 *  明文 ora 是 PK zip 且尾部无 peek → 两条都 false（首字节 PK≠7z，不必解析，热路径便宜）。
 *  注：裸 WinZip-AES zip mock（PK 开头、无 peek）无法靠 magic 与明文 ora 区分 → 不自动识别
 *  （需 7z mock 即可；用户用 7z 造的天然走 ② 或带 peek 走 ①）。 */
export declare function looksEncryptedContainer(blobOrBytes: Blob | Uint8Array): Promise<boolean>;
export interface PackOpts {
    dataBytes: Uint8Array;
    fileName?: string | null;
    ext?: string;
    guid?: string;
    peek?: Uint8Array | null;
    password: string;
}
/** 打包加密容器。 */
export declare function packContainer({ dataBytes, fileName, ext, guid, peek, password }: PackOpts): Promise<Blob>;
export interface UnpackResult {
    dataBlob: Blob;
    meta: ContainerMeta | null;
    guid: string;
}
/** 解包加密容器 → { dataBlob, meta, guid }。密码错 → throw code=WRONG_PASSWORD。
 *  **加解密一律 unpack7z**（7z-wasm 认 .7z + 老 WinZip-AES zip）。**向后兼容 + 容错**：
 *   - 外壳 = 我们的明文 zip（[<GUID>, peek]）：取 <GUID> payload → unpack7z（.7z 或老 WinZip-AES 都行）。
 *   - 整文件就是裸 .7z / 裸 WinZip-AES zip（用户手工 mock，无外壳无 peek）：整块 → unpack7z。
 *   - 内层 data.bin 缺失（手工 mock）→ 取唯一/首个非 meta entry 当本体；meta.bin 缺失 → name/ext 未知。 */
export declare function unpackContainer(blob: Blob | Uint8Array, password: string): Promise<UnpackResult>;
