// 加密容器（ADR-0012：三层双 zip + 尾部加密缩略图）。**sync-store 底座的一部分，app-agnostic**：
// data.bin 是不透明字节（ora / atlas.zip / txt 都行，ext 参数化），thumb 是不透明 PNG 字节。
// 纯机制，无状态、无 DOM —— node 可测。store.flow.encrypt/decrypt 消费 pack/unpack/探测；
// 缩略图导航（scan/decrypt tail blob）由 app 自己消费（store 只暴露 getTailBytes 原语，不懂 thumb）。
// 密码策略（统一 vs per-file）是 per-app choice，留在 app 层（如 WebPaint 的 crypto-state.js）。
//
// HOST-SEAM：依赖宿主提供 `../zip.js`（vendored zip.js 的包装：zipPack / zipUnpack /
//   zipPackEncrypted / zipUnpackEncrypted）。家族各兄弟都以同样方式 vendor zip.js。
//
// 加密文件的字节布局（文件名/路径保持明文 —— 身份=path/name 决策不动，只藏内容）：
//
//   outer.zip            ← 外层：明文 STORE zip。central directory 100% 干净
//     ├── <GUID>            （加密 flag 藏在下一层里，扫描器只看到 "zip 里有个 zip"）
//     │     payload = WinZip-AES-256 zip（标准格式，7-zip/WinRAR 输密码可开）：
//     │       ├── data.bin     原始文件字节，扩展名混淆
//     │       └── meta.bin     "WPMETA1\n" + JSON {v,name,ext}（恢复时改回真名用）
//     └── thumb             ← 加密缩略图 blob，**最后一个 entry**：
//           [MAGIC 8][ver 1][salt 16][iv 12][len 4LE][AES-GCM(png)]
//           一次 byte-range 拉尾部 → 扫 MAGIC → 解密 → 预览，无需全量下载。
//
// 为什么三层不是两层：标准 zip 的加密 flag 写在 central directory（明文可扫），
//   外层多包一层明文 STORE 就把 flag 藏进了 payload 内部。AtlasMaker 同款。
// 为什么 GUID 不是 content-hash：复用既有防撞语义（check-on-create），hash 撞了会互相抹。
//   GUID 只是混淆名/不透明 token，**不是**身份（GUID 身份方案已否决 2026-06-07）。
// KDF 双轨（ADR-0012 的核心取舍）：
//   - payload 用 WinZip-AES 标准 KDF（PBKDF2-SHA1×1000，弱）—— 换 7-zip 可打开性，不预拉伸
//     （拉伸了密码就没法在 7-zip 里敲了，恢复路径断掉）。强密码自己防暴力破解。
//   - thumb blob 是 app 专属 → 用强 KDF（PBKDF2-SHA256 × 250k）+ AES-GCM（自带完整性校验，
//     顺带当密码验证器用：GCM tag 不对 = 密码错，碰不到用户文件就能拒绝）。
// 无密钥托管、无 salt 文件：salt per-file 在各自 header 里，换设备/丢设备零迁移成本。

import { zipPack, zipUnpack, zipPackEncrypted, zipUnpackEncrypted } from "../zip.js";

// 尾部缩略图 blob 的 MAGIC（8 字节；首字节非文本防 false-match，"WPTH" 可读性）
export const THUMB_MAGIC = [0x9e, 0x57, 0x50, 0x54, 0x48, 0x0d, 0x0a, 0x1a];
const THUMB_VER = 1;
const THUMB_HEADER_LEN = 8 + 1 + 16 + 12 + 4;   // MAGIC + ver + salt + iv + len
const THUMB_MAX_LEN = 8 * 1024 * 1024;          // len sanity（防 MAGIC false-positive 当头解析）
const PBKDF2_ITERS = 250_000;                   // thumb 强 KDF（app 专属，不影响 7z 恢复）

// 尾部扫描窗口：thumb 自适应 ≤70KB + 外层 CD/EOCD 余量。与 cloud-thumbs 的 80KB suffix 兼容。
export const THUMB_TAIL_WINDOW = 98304;

// 加密缩略图的 Blob.type 标记 —— byte-range / thumb-cache / 图库靠它区分明文 PNG 与密文
export const ENC_THUMB_MIME = "application/x-webpaint-enc-thumb";

const META_MAGIC = "WPMETA1\n";

export interface EncThumbParsed {
  start: number;
  end: number;
  ver: number;
  salt: Uint8Array;
  iv: Uint8Array;
  ct: Uint8Array;
}
export interface ContainerMeta { v: number; name: string | null; ext: string; }

export function makeGuid(): string {
  return (globalThis.crypto && (crypto as any).randomUUID) ? (crypto as any).randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16);
      });
}

// ---- thumb blob：强 KDF + AES-GCM ----

const _keyCache = new Map<string, CryptoKey>();   // `${password}\x00${saltHex}` → CryptoKey（图库 N 张 thumb 不重复跑 250k 轮）
function _hex(u8: Uint8Array): string { return [...u8].map((b) => b.toString(16).padStart(2, "0")).join(""); }

async function _deriveThumbKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const cacheKey = `${password}\x00${_hex(salt)}`;
  const hit = _keyCache.get(cacheKey);
  if (hit) return hit;
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PBKDF2_ITERS },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
  _keyCache.set(cacheKey, key);
  return key;
}

/** PNG 字节 → 完整加密 thumb blob 字节（含 MAGIC 头） */
export async function encryptThumb(pngBytes: Uint8Array, password: string): Promise<Uint8Array> {
  const salt = new Uint8Array(16), iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(salt);
  globalThis.crypto.getRandomValues(iv);
  const key = await _deriveThumbKey(password, salt);
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, pngBytes as BufferSource));
  const out = new Uint8Array(THUMB_HEADER_LEN + ct.length);
  out.set(THUMB_MAGIC, 0);
  out[8] = THUMB_VER;
  out.set(salt, 9);
  out.set(iv, 25);
  new DataView(out.buffer).setUint32(37, ct.length, true);
  out.set(ct, THUMB_HEADER_LEN);
  return out;
}

/** 从字节流**末尾向前**扫加密 thumb blob。带 sanity（ver/len/边界），false-positive 继续向前。
 *  找不到返 null；找到返 { start, end, ver, salt, iv, ct }。 */
export function scanEncThumbFromEnd(u8: Uint8Array): EncThumbParsed | null {
  const n = u8.length;
  outer: for (let i = n - THUMB_HEADER_LEN; i >= 0; i--) {
    for (let k = 0; k < 8; k++) if (u8[i + k] !== THUMB_MAGIC[k]) continue outer;
    const ver = u8[i + 8];
    if (ver !== THUMB_VER) continue;
    const len = new DataView(u8.buffer, u8.byteOffset + i + 37, 4).getUint32(0, true);
    if (len <= 0 || len > THUMB_MAX_LEN || i + THUMB_HEADER_LEN + len > n) continue;
    return {
      start: i,
      end: i + THUMB_HEADER_LEN + len,
      ver,
      salt: u8.slice(i + 9, i + 25),
      iv: u8.slice(i + 25, i + 37),
      ct: u8.slice(i + THUMB_HEADER_LEN, i + THUMB_HEADER_LEN + len),
    };
  }
  return null;
}

/** 解密 scanEncThumbFromEnd 的结果 → PNG 字节。密码错 → throw code=WRONG_PASSWORD（AES-GCM tag 即验证器）。 */
export async function decryptThumbParsed(parsed: EncThumbParsed, password: string): Promise<Uint8Array> {
  const key = await _deriveThumbKey(password, parsed.salt);
  try {
    return new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: parsed.iv as BufferSource }, key, parsed.ct as BufferSource));
  } catch (e) {
    const err = new Error("密码不对（缩略图校验失败）") as Error & { code?: string };
    err.code = "WRONG_PASSWORD";
    throw err;
  }
}

// ---- 容器探测 ----

async function _tailBytes(blobOrBytes: Blob | Uint8Array, window = THUMB_TAIL_WINDOW): Promise<Uint8Array> {
  if (blobOrBytes instanceof Uint8Array) {
    return blobOrBytes.length <= window ? blobOrBytes : blobOrBytes.slice(blobOrBytes.length - window);
  }
  const blob = blobOrBytes.slice(Math.max(0, blobOrBytes.size - window));
  return new Uint8Array(await blob.arrayBuffer());
}

/** 这份字节是不是加密容器？靠尾部 MAGIC（容器**必带**尾部 thumb blob）。
 *  明文文件尾部不含 MAGIC；误判概率 ~2^-50 量级（带 sanity）。 */
export async function looksEncryptedContainer(blobOrBytes: Blob | Uint8Array): Promise<boolean> {
  try {
    return scanEncThumbFromEnd(await _tailBytes(blobOrBytes)) != null;
  } catch (_) { return false; }
}

// ---- 容器 pack / unpack ----

export interface PackOpts {
  dataBytes: Uint8Array;        // 原始文件字节（进 data.bin；格式不透明）
  fileName?: string | null;     // 真名（进 meta.bin，无 app 恢复时改回真名用）
  ext?: string;                 // 真扩展名（meta.bin；如 "ora" / "atlas.zip" / "txt"）
  guid: string;                 // 混淆名（不透明 token，非身份）
  thumbPng: Uint8Array;         // 缩略图 PNG 字节（必备 —— 尾部 blob 兼任容器探测标记）
  password: string;
}

/** 打包加密容器。 */
export async function packContainer({ dataBytes, fileName, ext = "bin", guid, thumbPng, password }: PackOpts): Promise<Blob> {
  if (!password) throw new Error("没有密码，无法加密");
  if (!thumbPng || !thumbPng.length) throw new Error("缺缩略图字节（容器尾部 thumb 是必备件）");
  const metaJson = JSON.stringify({ v: 1, name: fileName || null, ext });
  const payload = await zipPackEncrypted([
    { path: "data.bin", data: dataBytes },
    { path: "meta.bin", data: META_MAGIC + metaJson },
  ], password);
  const payloadBytes = new Uint8Array(await payload.arrayBuffer());
  const thumbEnc = await encryptThumb(thumbPng, password);
  // thumb 必须最后（byte-range 尾部一发命中 + 容器探测）；外层全 STORE（zipPack level:0）
  return await zipPack([
    { path: guid, data: payloadBytes },
    { path: "thumb", data: thumbEnc },
  ]);
}

export interface UnpackResult { dataBlob: Blob; meta: ContainerMeta | null; guid: string; }

/** 解包加密容器 → { dataBlob, meta, guid }。密码错 → throw code=WRONG_PASSWORD
 *（WinZip-AES verifier 快速失败）。 */
export async function unpackContainer(blob: Blob | Uint8Array, password: string): Promise<UnpackResult> {
  const outer = await zipUnpack(blob instanceof Blob ? blob : new Blob([blob as BlobPart]));
  const names = Object.keys(outer);
  const guid = names.find((n) => n !== "thumb");
  if (!guid || !outer[guid]) throw new Error("容器结构不对（缺 payload）");
  const inner = await zipUnpackEncrypted(new Blob([outer[guid] as BlobPart], { type: "application/zip" }), password);
  const data = inner["data.bin"];
  if (!data) throw new Error("容器结构不对（缺 data.bin）");
  let meta: ContainerMeta | null = null;
  if (inner["meta.bin"]) {
    try {
      const text = new TextDecoder().decode(inner["meta.bin"]);
      if (text.startsWith(META_MAGIC)) meta = JSON.parse(text.slice(META_MAGIC.length));
    } catch (_) { /* meta 是恢复辅助件，坏了不阻断 */ }
  }
  return { dataBlob: new Blob([data as BlobPart], { type: "application/zip" }), meta, guid };
}
