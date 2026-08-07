/**
 * 字节源抽象：库内部编排「先尾片、不够再二次拉」。
 *   - totalSize：文件总字节（判绝对偏移是否落在尾片）。
 *   - tail：末 N 字节（N = min(bytesLength, totalSize)）。
 *   - range(offset,length)：按**绝对**偏移读（本地 Blob.slice / 云端 downloadRange）；不可达 → null。
 */
export interface PeekSource {
    totalSize: number;
    tail: Uint8Array;
    range(offset: number, length: number): Promise<Uint8Array | null>;
}
export interface ZipDirEntry {
    name: string;
    method: number;
    compSize: number;
    nameLen: number;
    localOff: number;
}
/** 解 central directory → entries（CD 不全在尾片时二次拉）。找不到 EOCD / CD 拉不全 → null。 */
export declare function readCentralDirectory(src: PeekSource): Promise<ZipDirEntry[] | null>;
/** 抓一个 entry 的解压后字节。数据不全在尾片时二次拉（常见 1 次）。任何异常 → null。 */
export declare function readEntryBytes(src: PeekSource, entry: ZipDirEntry): Promise<Uint8Array | null>;
/** 便捷：按名取一个 entry 的字节（CD → 按名找 → 读）。找不到 → null。 */
export declare function readNamedEntry(src: PeekSource, name: string): Promise<Uint8Array | null>;
