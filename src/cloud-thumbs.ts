// v137 云端 ora 缩略图 byte-range 拉取
//
// 思路：.ora 是 zip。把 Thumbnails/thumbnail.png 放 zip 末（ora.js v137+），
// 加上 zip 写入 PNG 用 STORE 不 deflate（zip.js level:0），thumbnail PNG 字节
// 原样落在 last 128KB 里。所以最快路径是硬扫 PNG magic，1 request。
//
// 三级路径（自动 fallback）：
//   1) 1 request：硬扫 PNG sig（89 50 4E 47 0D 0A 1A 0A）从 last 128KB 末尾向前
//      → 验后续 IHDR chunk → 扫 IEND chunk 截出完整 PNG
//      → 自家 ora 100% 命中（thumbnail 在末 + STORE）
//   2) 2 request：硬扫失败 → 走 ZIP 解析；CD 在 last 128KB 里
//      → 单独拉 thumbnail entry
//   3) 3 request：CD 也不在 last 128KB → 先拉 CD，再拉 thumbnail entry
//
// 安全性：
//   - 出口都是 PNG blob → <img> 浏览器原生 decode，没 injection 路径
//   - 硬扫：8 字节 sig + IHDR 验证 + IEND 终止，false-match 概率 ~1/2^96
//   - ZIP 解析：EOCD commentLen sanity 防 false-positive；输出 PNG magic 校验

import { downloadItemRange, downloadItemBlob, downloadRangeFromUrl } from "./app-store.js";
// 加密容器（ADR-0012）：尾部是加密 peek blob（WebPaint 的 peek=缩略图 PNG），
// PNG 硬扫自然落空 → 扫 MAGIC。命中返**密文** Blob（type=ENC_PEEK_MIME），解密归 caller
// （图库经 store.decryptPeekBytes 按锁态解；cache 层原样缓存密文 → 明文 thumb 不落 IDB）。
import { scanEncPeekFromEnd, ENC_PEEK_MIME } from "./crypto-format.ts";

// 投机 suffix：last N 字节一次性拿 EOCD + CD +（自家 ora）thumbnail data
// 80KB budget = thumb 自适应目标 ≤ 70KB + 尾巴 ~10KB（CD + EOCD + sig 扫描余量）
// 扫不到 PNG → 用同一 buffer 走 ZIP 解析
const SUFFIX_BYTES = 81920;
const THUMB_PATH = "Thumbnails/thumbnail.png";
// PNG 完整 sig 8 字节（4 字节短 sig 会有更多 false match）
const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

// telemetry：记录 80KB 一次拉硬扫的命中分布（console: WebPaint.cloudThumbTelemetry()）
export const telemetry: {
  small: number; hardScan: number; encScan: number; zip2: number; zip3: number; errors: number;
} = {
  small: 0,         // 路径 0：< 80KB 整下载
  hardScan: 0,      // 路径 1：1 request hardscan 命中（理想）
  encScan: 0,       // 路径 1e：加密容器 MAGIC 命中（1 request，返密文）
  zip2: 0,          // 路径 2：ZIP 解析 2 request
  zip3: 0,          // 路径 3：ZIP 解析 3 request（CD 也不在 suffix）
  errors: 0,
};
export function resetTelemetry() {
  telemetry.small = telemetry.hardScan = telemetry.encScan = telemetry.zip2 = telemetry.zip3 = telemetry.errors = 0;
}
// IHDR chunk: length(4)=0x0000000D + "IHDR"
const IHDR_HEAD = [0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52];
// IEND chunk: length(4)=0 + "IEND" + crc=AE 42 60 82（IEND 数据为空 → CRC 固定）
const IEND_TAIL = [0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82];

// ============= ZIP 解析 (minimal, 仅支持 32-bit zip，无 zip64) =============

// 找 EOCD signature (0x06054b50) 在 buffer 里的位置；从末尾向前扫
// 带 sanity check：找到 sig 后 verify commentLen 跟剩余字节匹配，防 false-positive
// 返回 -1 没找到
// ZIP central-directory entry（_parseCD 输出）
interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  uncSize: number;
  localOff: number;
}

function _findEOCD(buf: ArrayBuffer): number {
  const view = new DataView(buf);
  const maxScan = Math.min(buf.byteLength, 22 + 65535);
  for (let i = buf.byteLength - 22; i >= buf.byteLength - maxScan; i--) {
    if (i < 0) break;
    if (view.getUint32(i, true) !== 0x06054b50) continue;
    // sanity：commentLen (offset 20) 必须 == buf 剩余字节 - 22
    const commentLen = view.getUint16(i + 20, true);
    if (i + 22 + commentLen === buf.byteLength) return i;
    // 不匹配 → false positive，继续向前
  }
  return -1;
}

// 从 EOCD 拿 central directory location
function _parseEOCD(buf: ArrayBuffer, eocdOffset: number): { cdSize: number; cdOffset: number; entries: number } {
  const v = new DataView(buf, eocdOffset);
  return {
    cdSize:    v.getUint32(12, true),
    cdOffset:  v.getUint32(16, true),
    entries:   v.getUint16(10, true),
  };
}

// parse central directory，返回 entries 数组
function _parseCD(buf: ArrayBuffer, cdStartInBuf: number, cdSize: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let p = cdStartInBuf;
  const end = cdStartInBuf + cdSize;
  while (p < end) {
    const v = new DataView(buf, p);
    if (v.getUint32(0, true) !== 0x02014b50) break;
    const method   = v.getUint16(10, true);
    const compSize = v.getUint32(20, true);
    const uncSize  = v.getUint32(24, true);
    const nameLen  = v.getUint16(28, true);
    const extraLen = v.getUint16(30, true);
    const commLen  = v.getUint16(32, true);
    const localOff = v.getUint32(42, true);
    const nameBytes = new Uint8Array(buf, p + 46, nameLen);
    const name = new TextDecoder().decode(nameBytes);
    entries.push({ name, method, compSize, uncSize, localOff });
    p += 46 + nameLen + extraLen + commLen;
  }
  return entries;
}

// 算 local file header 数据偏移：header 30 字节 + filename + extra
function _localHeaderDataOffset(buf: ArrayBuffer, headerOffsetInBuf: number): number {
  const v = new DataView(buf, headerOffsetInBuf);
  if (v.getUint32(0, true) !== 0x04034b50) throw new Error("非法 local file header");
  const nameLen  = v.getUint16(26, true);
  const extraLen = v.getUint16(28, true);
  return 30 + nameLen + extraLen;
}

// ============= 解压 =============

// method=0 stored, method=8 deflate
// 返回 Uint8Array（caller 校 magic 再包 Blob）
async function _decompress(rawData: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return rawData.slice();
  if (method === 8) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("DecompressionStream 不支持");
    }
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([rawData]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  throw new Error(`不支持的 zip method ${method}`);
}

// PNG magic 校验（防错位 byte-range 取到非 PNG 数据）
function _isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
  return true;
}

// 从 buf 末尾向前扫一个完整 PNG：sig + IHDR + ... + IEND
// 找不到返 null；找到返 Uint8Array slice
// 自家 ora 的 thumbnail 100% 命中（thumbnail 放 zip 末 + STORE 不压）
function _scanPngFromEnd(buf: ArrayBuffer): Uint8Array | null {
  const u8 = new Uint8Array(buf);
  const n = u8.length;
  // 从末尾向前扫 PNG sig（8 字节）
  outer: for (let i = n - 8; i >= 0; i--) {
    for (let k = 0; k < 8; k++) if (u8[i + k] !== PNG_SIG[k]) continue outer;
    // 验后续 IHDR chunk（防 false-positive）
    if (i + 16 > n) continue;
    let ok = true;
    for (let k = 0; k < 8; k++) if (u8[i + 8 + k] !== IHDR_HEAD[k]) { ok = false; break; }
    if (!ok) continue;
    // 从 i 向后扫 IEND 终止
    for (let j = i + 16; j + 8 <= n; j++) {
      let match = true;
      for (let k = 0; k < 8; k++) if (u8[j + k] !== IEND_TAIL[k]) { match = false; break; }
      if (match) return u8.slice(i, j + 8);
    }
    // 找到 sig + IHDR 但没 IEND（PNG 不完整 / 跨 suffix 边界）→ 放弃，让 fallback 接手
    return null;
  }
  return null;
}

// ============= 主入口 =============

/**
 * 拉一个云端 ora 的 thumbnail，返回 PNG Blob
 * 不带 cache 逻辑（caller 负责）；不带 retry / 限流（caller 负责）
 *
 * @param {string} itemId  OneDrive item id
 * @param {number} fileSize 文件总大小（来自 listChildren 的 item.size）
 * @returns {Promise<Blob>} PNG blob
 */
/**
 * @param {string} itemId
 * @param {number} fileSize
 * @param {object} [opts]
 * @param {string} [opts.downloadUrl] — listChildren 带回的 1h 短效 CDN URL，
 *                                       直接打省一次 metadata RTT；过期抛 401/403
 */
export async function fetchOraThumbnail(itemId: string, fileSize: number, opts: { downloadUrl?: string } = {}): Promise<Blob> {
  const dl = opts.downloadUrl || null;
  // 抽象：有 downloadUrl 走 CDN（省 metadata RTT）；没有走老路（自己拿 url）
  const rangeFetch: (offset: number | null, length: number) => Promise<ArrayBuffer> = dl
    ? (offset, length) => downloadRangeFromUrl(dl, offset, length)
    : (offset, length) => downloadItemRange(itemId, offset, length);

  // 路径 0：小文件整下载（< 80KB 没必要 byte-range）
  if (fileSize <= SUFFIX_BYTES) {
    const blob = await downloadItemBlob(itemId);
    const buf = await blob.arrayBuffer();
    const scanned = _scanPngFromEnd(buf);
    if (scanned && _isPng(scanned)) { telemetry.small++; return new Blob([scanned], { type: "image/png" }); }
    const encSmall = _scanEncThumb(buf);
    if (encSmall) { telemetry.small++; return encSmall; }
    telemetry.small++;
    return _extractFromBuffer(buf, 0);
  }

  // 路径 1：紧凑 suffix + 硬扫 PNG sig
  // 自家 v137+ ora（thumb 放末 + STORE）几乎 100% 命中 → 1 request 完事
  const tailBuf = await rangeFetch(null, SUFFIX_BYTES);
  const tailStartOffset = fileSize - tailBuf.byteLength;
  const fastScan = _scanPngFromEnd(tailBuf);
  if (fastScan && _isPng(fastScan)) { telemetry.hardScan++; return new Blob([fastScan], { type: "image/png" }); }

  // 路径 1e：加密容器（thumb blob 在外层 zip 末 + STORE，与明文 thumb 同一 80KB 预算内命中）
  const encHit = _scanEncThumb(tailBuf);
  if (encHit) { telemetry.encScan++; return encHit; }

  // 路径 2+3：ZIP 解析 fallback（外部 ora / 老 ora / deflate 压 thumbnail）
  // 复用同一个 tailBuf 找 EOCD
  const eocdInTail = _findEOCD(tailBuf);
  if (eocdInTail < 0) throw new Error("EOCD 没找到（文件不是 zip？）");
  const { cdSize, cdOffset } = _parseEOCD(tailBuf, eocdInTail);

  // central directory 在 buf 里的位置？
  let cdBuf, cdStartInCdBuf;
  let extraRequests = 0;
  if (cdOffset >= tailStartOffset) {
    cdBuf = tailBuf;
    cdStartInCdBuf = cdOffset - tailStartOffset;
  } else {
    cdBuf = await rangeFetch(cdOffset, cdSize);
    cdStartInCdBuf = 0;
    extraRequests++;
  }
  const entries = _parseCD(cdBuf, cdStartInCdBuf, cdSize);
  const thumbEntry = entries.find((e) => e.name === THUMB_PATH);
  if (!thumbEntry) throw new Error("ora 内没找到 Thumbnails/thumbnail.png");

  // thumbnail 数据需要的字节范围：[localOff, localOff + (header + compSize)]
  // header 大小未知，预留 256 字节足够（30 + name + extra 一般 << 256）
  const thumbStart = thumbEntry.localOff;
  const thumbEnd = thumbStart + 256 + thumbEntry.compSize;

  // 在 tail 里？
  let entryBuf, entryStartInBuf;
  if (thumbStart >= tailStartOffset && thumbEnd <= fileSize) {
    entryBuf = tailBuf;
    entryStartInBuf = thumbStart - tailStartOffset;
  } else {
    entryBuf = await rangeFetch(thumbStart, Math.min(256 + thumbEntry.compSize, fileSize - thumbStart));
    entryStartInBuf = 0;
    extraRequests++;
  }
  const dataOffsetInEntry = _localHeaderDataOffset(entryBuf, entryStartInBuf);
  const rawData = new Uint8Array(entryBuf, entryStartInBuf + dataOffsetInEntry, thumbEntry.compSize);
  const pngBytes = await _decompress(rawData, thumbEntry.method);
  if (!_isPng(pngBytes)) throw new Error("解出的不是 PNG（byte-range 错位？）");
  if (extraRequests >= 2) telemetry.zip3++;
  else telemetry.zip2++;
  return new Blob([pngBytes], { type: "image/png" });
}

// 加密 thumb：buf 尾扫 MAGIC，命中切出完整密文段（含头），打 ENC_PEEK_MIME 标记。
function _scanEncThumb(buf: ArrayBuffer): Blob | null {
  const parsed = scanEncPeekFromEnd(new Uint8Array(buf));
  if (!parsed) return null;
  return new Blob([new Uint8Array(buf).slice(parsed.start, parsed.end)], { type: ENC_PEEK_MIME });
}

// ============= 提取 helper（小文件路径用）=============
async function _extractFromBuffer(buf: ArrayBuffer, fileStart: number): Promise<Blob> {
  const eocdInBuf = _findEOCD(buf);
  if (eocdInBuf < 0) throw new Error("EOCD 没找到");
  const { cdSize, cdOffset } = _parseEOCD(buf, eocdInBuf);
  const entries = _parseCD(buf, cdOffset - fileStart, cdSize);
  const thumb = entries.find((e) => e.name === THUMB_PATH);
  if (!thumb) throw new Error("ora 内没 thumbnail");
  const dataOff = _localHeaderDataOffset(buf, thumb.localOff - fileStart);
  const rawData = new Uint8Array(buf, thumb.localOff - fileStart + dataOff, thumb.compSize);
  const pngBytes = await _decompress(rawData, thumb.method);
  if (!_isPng(pngBytes)) throw new Error("解出的不是 PNG");
  return new Blob([pngBytes], { type: "image/png" });
}
