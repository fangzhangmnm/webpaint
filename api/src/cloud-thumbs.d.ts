export declare const SUFFIX_BYTES = 81920;
export declare const THUMB_PATH = "Thumbnails/thumbnail.png";
/**
 * 拉一个 ora 的 thumbnail 字节：明文 → entry 原始字节 Blob（无 type）；加密 → 密文 peek Blob(type=ENC_PEEK_MIME)。
 * 不带 cache / retry / 限流（caller 负责）。取不到 → 抛（caller 显占位图）。
 * @param name 库的裸 session 名（item.name，无 .ora/.zip 后缀）
 */
export declare function fetchOraThumbnail(name: string): Promise<Blob>;
