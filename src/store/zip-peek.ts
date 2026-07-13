// 库内部深模块：从 zip 容器里按 **文件名** 取一个 entry 的字节。**格式盲、内容盲**——
//   不认 PNG、不认任何 app 内容格式，唯一定位依据 = caller 给的 entry 名（getPeek 的 zipEntry）。
//   2026-07-13(v399) 重写：删掉旧「尾部硬扫 PNG magic」+「不做二次拉」的实现，改标准 zip 解析
//   （EOCD → central directory → 按名找 entry → 按需二次 byte-range 拉），加密/明文/大文件一视同仁。
//
// 取字节 schema（PeekSource 把「本地 Blob.slice」和「云端 byte-range」抽象成同一个「按绝对偏移读」）：
//   1. 先有尾片 tail（约 80KB）：一定含 EOCD（zip 末尾结构），可能含整份 central directory(CD)、可能含目标 entry。
//   2. 解 EOCD 得 CD 偏移/大小；CD 若不全落在尾片 → 一次额外 range 拉 CD。
//   3. CD 里按名找目标 entry；entry 的 local header + 数据若不全落在尾片 → 一次额外 range 拉它。
//   4. 按 zip method 解压（STORE=0 直取 / deflate=8）返回原始字节。
//
// 关于「magic」：这里只保留 zip 格式**结构签名**（EOCD 0x06054b50 / CD 0x02014b50 / local header 0x04034b50）
//   作解析定位与防错位守卫——那是 zip 格式内在的，不是内容/app 知识。定位「哪个 entry 是预览」纯靠文件名。
//
// 只支持 32-bit zip（无 zip64）——WebPaint ora / 加密外壳都在此范围。

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

// local header 之后 extra 字段的余量（自家 STORE zip extra=0；外部 zip 通常也很小）。
// 「一发拉」时多带这些字节，绝大多数情况下一次 range 就够（不必为 local header 单独发一次）。
const LOCAL_HEADER_EXTRA_SLACK = 4096;

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

// central directory 一条 entry（parseCD 输出）。
export interface ZipDirEntry {
  name: string;
  method: number;
  compSize: number;
  nameLen: number;
  localOff: number;
}

// 尾片起始的绝对偏移。
function tailStart(src: PeekSource): number { return src.totalSize - src.tail.length; }

// 按绝对偏移读 len 字节：整段落在尾片 → 切尾片（零请求）；否则走 range 二次拉。len<=0 → 空。
async function readAbs(src: PeekSource, off: number, len: number): Promise<Uint8Array | null> {
  if (len <= 0) return new Uint8Array(0);
  const ts = tailStart(src);
  if (off >= ts && off + len <= src.totalSize) {
    const s = off - ts;
    return src.tail.subarray(s, s + len);
  }
  return await src.range(off, len);
}

// 尾片里找 EOCD（zip 末尾结构，必在尾片，除非 comment 超尾片长——自家/常规 ora 都无 comment）。
//   commentLen sanity（i+22+commentLen == 尾片末）防 false-positive。返回尾片内偏移，-1 未找到。
function findEOCD(tail: Uint8Array): number {
  if (tail.length < 22) return -1;
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) !== SIG_EOCD) continue;
    const commentLen = dv.getUint16(i + 20, true);
    if (i + 22 + commentLen === tail.length) return i;
  }
  return -1;
}

// 解 central directory 字节（从 CD 起始的独立 buffer）→ entries。
function parseCD(cd: Uint8Array): ZipDirEntry[] {
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries: ZipDirEntry[] = [];
  let p = 0;
  while (p + 46 <= cd.length) {
    if (dv.getUint32(p, true) !== SIG_CD) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compSize, nameLen, localOff });
    p += 46 + nameLen + extraLen + commLen;
  }
  return entries;
}

/** 解 central directory → entries（CD 不全在尾片时二次拉）。找不到 EOCD / CD 拉不全 → null。 */
export async function readCentralDirectory(src: PeekSource): Promise<ZipDirEntry[] | null> {
  const eocd = findEOCD(src.tail);
  if (eocd < 0) return null;
  const dv = new DataView(src.tail.buffer, src.tail.byteOffset, src.tail.byteLength);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (cdSize <= 0 || cdOffset + cdSize > src.totalSize) return null;
  const cd = await readAbs(src, cdOffset, cdSize);
  if (!cd || cd.length < cdSize) return null;
  return parseCD(cd);
}

// method=0 STORE / method=8 deflate。其它 → null。
async function inflate(raw: Uint8Array, method: number): Promise<Uint8Array | null> {
  if (method === 0) return raw.slice();
  if (method === 8) {
    if (typeof DecompressionStream === "undefined") return null;
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([raw as BlobPart]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return null;
}

/** 抓一个 entry 的解压后字节。数据不全在尾片时二次拉（常见 1 次）。任何异常 → null。 */
export async function readEntryBytes(src: PeekSource, entry: ZipDirEntry): Promise<Uint8Array | null> {
  // 一发拉 [localOff, +local header + slack + compSize]：整段落尾片则零额外请求；否则一次 range。
  const guess = 30 + entry.nameLen + LOCAL_HEADER_EXTRA_SLACK + entry.compSize;
  const chunk = await readAbs(src, entry.localOff, Math.min(guess, src.totalSize - entry.localOff));
  if (!chunk || chunk.length < 30) return null;
  const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (dv.getUint32(0, true) !== SIG_LOCAL) return null;          // 结构签名（非内容知识）：防错位偏移
  const nameLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const dataStart = 30 + nameLen + extraLen;
  let raw: Uint8Array | null;
  if (dataStart + entry.compSize <= chunk.length) {
    raw = chunk.subarray(dataStart, dataStart + entry.compSize);
  } else {
    // local extra 超出 slack（罕见）→ 精确二次拉数据段。
    raw = await readAbs(src, entry.localOff + dataStart, entry.compSize);
  }
  if (!raw) return null;
  return await inflate(raw, entry.method);
}

/** 便捷：按名取一个 entry 的字节（CD → 按名找 → 读）。找不到 → null。 */
export async function readNamedEntry(src: PeekSource, name: string): Promise<Uint8Array | null> {
  const entries = await readCentralDirectory(src);
  if (!entries) return null;
  const e = entries.find((x) => x.name === name);
  return e ? await readEntryBytes(src, e) : null;
}
