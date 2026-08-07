interface ZipEntry {
    path: string;
    data: Blob | Uint8Array | ArrayBuffer | string;
}
/** entries: [{ path, data: Blob|Uint8Array|ArrayBuffer|string }, ...]; return Blob */
export declare function zipPack(entries: ZipEntry[]): Promise<any>;
/** 只读 zip 里**一个** entry（不解其余大块；CD 读目录 + 单 entry getData）。
 *  没有该 entry → null。makePeek（从 ora 抽缩略图）这类「大 zip 取小件」用。 */
export declare function zipReadEntry(blob: Blob, path: string): Promise<any>;
/** @returns {Promise<Record<string, Uint8Array>>} { path: Uint8Array } */
export declare function zipUnpack(blob: Blob): Promise<Record<string, Uint8Array<ArrayBufferLike>>>;
export {};
