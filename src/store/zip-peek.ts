// 库内部深模块：从 zip(.ora) 尾片抓一个 entry 的 PNG（缩略图）。**纯逻辑**——无 store/crypto 依赖。
//   2026-07-13 从 app 层 cloud-thumbs.ts 下沉进库（getPeek slice）：app 不再自己解 zip，
//   只调 ZipFile.getPeek({bytesLength, zipEntry})，库内部（create-store）编排 硬扫→加密扫→CD fallback。
//
// .ora 是 zip。WebPaint 的 ora.ts 把 Thumbnails/thumbnail.png 放 zip **末** + STORE（不 deflate），
// 故最快路径是从尾片末尾硬扫 PNG magic（自家 ora 100% 命中）。外部/老 deflate ora 退回尾内 CD 解析。
//
// 安全：出口都是 PNG blob → <img> 浏览器原生 decode，无 injection 路径。
//   硬扫：8 字节 sig + IHDR 验证 + IEND 终止，false-match ~1/2^96。CD 解析：EOCD commentLen sanity + 输出 PNG magic 校验。
//
// 只支持 32-bit zip（无 zip64）——WebPaint ora / 加密外壳都在此范围。

// PNG 完整 sig 8 字节（4 字节短 sig false match 多）
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// IHDR chunk: length(4)=0x0000000D + "IHDR"
const IHDR_HEAD = [0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52];
// IEND chunk: length(4)=0 + "IEND" + crc=AE 42 60 82（IEND 数据为空 → CRC 固定）
const IEND_TAIL = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

// ZIP central-directory entry（_parseCD 输出）
interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  uncSize: number;
  localOff: number;
}

// PNG magic 校验（防错位 byte-range 取到非 PNG 数据）
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
  return true;
}

/**
 * 从 buf 末尾向前扫一个完整 PNG：sig + IHDR + … + IEND。找不到返 null。
 * 自家 ora 的 thumbnail 100% 命中（thumbnail 放 zip 末 + STORE 不压）。
 */
export function scanPngFromEnd(buf: ArrayBuffer): Uint8Array | null {
  const u8 = new Uint8Array(buf);
  const n = u8.length;
  outer: for (let i = n - 8; i >= 0; i--) {
    for (let k = 0; k < 8; k++) if (u8[i + k] !== PNG_SIG[k]) continue outer;
    if (i + 16 > n) continue;                                    // 验后续 IHDR chunk（防 false-positive）
    let ok = true;
    for (let k = 0; k < 8; k++) if (u8[i + 8 + k] !== IHDR_HEAD[k]) { ok = false; break; }
    if (!ok) continue;
    for (let j = i + 16; j + 8 <= n; j++) {                      // 从 i 向后扫 IEND 终止
      let match = true;
      for (let k = 0; k < 8; k++) if (u8[j + k] !== IEND_TAIL[k]) { match = false; break; }
      if (match) return u8.slice(i, j + 8);
    }
    return null;   // 找到 sig + IHDR 但没 IEND（PNG 不完整/跨尾片边界）→ 放弃，让 fallback 接手
  }
  return null;
}

// 找 EOCD signature(0x06054b50)，从末尾向前扫；带 commentLen sanity 防 false-positive。返回 -1 没找到。
function _findEOCD(buf: ArrayBuffer): number {
  const view = new DataView(buf);
  const maxScan = Math.min(buf.byteLength, 22 + 65535);
  for (let i = buf.byteLength - 22; i >= buf.byteLength - maxScan; i--) {
    if (i < 0) break;
    if (view.getUint32(i, true) !== 0x06054b50) continue;
    const commentLen = view.getUint16(i + 20, true);
    if (i + 22 + commentLen === buf.byteLength) return i;        // commentLen 必须 == buf 剩余字节 - 22
  }
  return -1;
}

// 从 EOCD 拿 central directory location
function _parseEOCD(buf: ArrayBuffer, eocdOffset: number): { cdSize: number; cdOffset: number; entries: number } {
  const v = new DataView(buf, eocdOffset);
  return { cdSize: v.getUint32(12, true), cdOffset: v.getUint32(16, true), entries: v.getUint16(10, true) };
}

// parse central directory，返回 entries 数组
function _parseCD(buf: ArrayBuffer, cdStartInBuf: number, cdSize: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let p = cdStartInBuf;
  const end = cdStartInBuf + cdSize;
  while (p < end) {
    const v = new DataView(buf, p);
    if (v.getUint32(0, true) !== 0x02014b50) break;
    const method = v.getUint16(10, true);
    const compSize = v.getUint32(20, true);
    const uncSize = v.getUint32(24, true);
    const nameLen = v.getUint16(28, true);
    const extraLen = v.getUint16(30, true);
    const commLen = v.getUint16(32, true);
    const localOff = v.getUint32(42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
    entries.push({ name, method, compSize, uncSize, localOff });
    p += 46 + nameLen + extraLen + commLen;
  }
  return entries;
}

// 算 local file header 数据偏移：header 30 字节 + filename + extra
function _localHeaderDataOffset(buf: ArrayBuffer, headerOffsetInBuf: number): number {
  const v = new DataView(buf, headerOffsetInBuf);
  if (v.getUint32(0, true) !== 0x04034b50) throw new Error("非法 local file header");
  return 30 + v.getUint16(26, true) + v.getUint16(28, true);
}

// method=0 stored / method=8 deflate。返回 Uint8Array（caller 校 magic 再包 Blob）。
async function _decompress(rawData: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return rawData.slice();
  if (method === 8) {
    if (typeof DecompressionStream === "undefined") throw new Error("DecompressionStream 不支持");
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([rawData]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error(`不支持的 zip method ${method}`);
}

/**
 * 尾内 CD fallback：从尾片解 zip 中央目录，按名抓 entryName 的 PNG（外部/老 deflate ora）。
 *   只在 CD + 目标 entry 都落在尾片时可行；越界/找不到/不是 PNG → null（放弃任意偏移二次拉，见下）。
 *   ⚠不做任意偏移二次拉取：薄库内容盲、不暴露 provider itemId，无法重建任意 byte-range。极大 CD 文件缩略图退占位。
 * @param buf        尾片字节
 * @param totalSize  文件总字节（本地 blob.size / 云端 item.size）——判 CD/entry 绝对偏移是否落在尾片
 * @param entryName  目标 entry 名（如 "Thumbnails/thumbnail.png"）
 */
export async function zipEntryPngFromTail(buf: ArrayBuffer, totalSize: number, entryName: string): Promise<Uint8Array | null> {
  // 文件比尾片大 → 尾片是 suffix，起始绝对偏移 = totalSize - 尾片长；否则整份即 buffer，偏移 0。
  const tailStart = totalSize > buf.byteLength ? totalSize - buf.byteLength : 0;
  const eocd = _findEOCD(buf);
  if (eocd < 0) return null;
  const { cdSize, cdOffset } = _parseEOCD(buf, eocd);
  if (cdOffset < tailStart || cdOffset - tailStart + cdSize > buf.byteLength) return null;   // CD 不在尾片
  const entry = _parseCD(buf, cdOffset - tailStart, cdSize).find((e) => e.name === entryName);
  if (!entry) return null;
  const start = entry.localOff;
  const end = start + 256 + entry.compSize;   // header 预留 256 足够
  if (start < tailStart || end - tailStart > buf.byteLength) return null;                    // entry 不在尾片
  const entryInBuf = start - tailStart;
  const dataOff = _localHeaderDataOffset(buf, entryInBuf);
  const raw = new Uint8Array(buf, entryInBuf + dataOff, entry.compSize);
  const png = await _decompress(raw, entry.method);
  return isPng(png) ? png : null;
}
