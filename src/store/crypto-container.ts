// 加密容器（ADR-0012：三层双 zip + 尾部加密 peek）。**sync-store 底座的一部分，格式盲**：
// data.bin 是不透明字节（ora / atlas.zip / txt 都行）；peek 也是**不透明字节**——
// 一段可 byte-range 的加密旁路小块，app 自己决定语义（WebPaint 放缩略图 PNG，文本类 app
// 可放正文摘要），store/容器层从不解释它。peek blob 同时兼任「这是加密容器」的尾部探测标记，
// 所以**永远写**（app 没给 peek 就加密空串——GCM of "" = 16 字节 tag，探测不变量照样成立）。
//
// HOST-SEAM：依赖宿主提供 `../zip.js`（外层明文 zip：zipPack/zipUnpack）+ `../sevenzip.js`
//   （payload 加密：pack7z/unpack7z = vendored 7z-wasm）。家族各兄弟同样方式 vendor。
//
// 加密文件的字节布局（路径身份明文；**云端文件名 = <name>.zip**——外层容器是标准 zip，
// 名实相符、防软件按 .ora/.txt 误认；命名翻转在 cloud-sync 的 encFileName）：
//
//   <name>.zip           ← 外层：明文 STORE zip。central directory 100% 干净
//     ├── <GUID>            （加密在下一层；扫描器只看到 "zip 里有一坨不透明字节"）
//     │     payload = 加密 .7z（AES-256 + 强 KDF + 加密头 -mhe）：
//     │       ├── data.bin     原始文件字节，扩展名混淆
//     │       └── meta.bin     "WPMETA1\n" + JSON {v,name,ext}（恢复时改回真名用）
//     └── peek              ← 加密旁路小块，**最后一个 entry**：
//           [MAGIC 8][ver 1][salt 16][iv 12][len 4LE][AES-GCM(不透明字节)]
//           一次 byte-range 拉尾部 → 扫 MAGIC → 解密，无需全量下载。
//
// 为什么 .7z 不直接当文件：① 整文件得是 zip 才能塞尾部 byte-range peek（云端缩略图）；
//   ② 外层明文 zip 让 central directory 100% 干净（加密结构藏在 <GUID> 不透明字节里）。
//   恢复：7-Zip 开 <name>.zip → 取 <GUID> → 改名 .7z → 输密码 → data.bin（按 meta 改回真名）。
// GUID 只是混淆名/不透明 token，**不是**身份（GUID 身份方案已否决 2026-06-07）——每次重打包重生成。
// KDF（ADR-0012 2026-06-12「用强的，vendor 7z」）：
//   - payload = .7z AES-256，**强 KDF**（7-Zip 默认 SHA-256 多轮）+ 加密头 → 7-Zip 输密码直开。
//   - peek = app 专属强 KDF（PBKDF2-SHA256 × 250k）+ AES-GCM（GCM tag 兼任密码验证器，
//     碰不到用户文件就能拒错密码 → throw code=WRONG_PASSWORD）。
// 无密钥托管、无 salt 文件：salt 在各自 header（.7z header / peek header），换/丢设备零迁移。

import { zipPack, zipUnpack } from "../zip.js";
import { pack7z, unpack7z } from "../sevenzip.js";

// payload 永远走 unpack7z（7z-wasm = 真 7-Zip）——它**既认 .7z 也认老 WinZip-AES zip**（实测逐位还原），
// 所以加解密一概不碰 zip.js，向后兼容 v233-235 老容器零特例。下面 magic 仅用于「识别这块是不是加密 payload」。
const SEVENZ_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];   // .7z（v236+ payload / 裸 7z mock）
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];                  // PK（外层壳 / 老 WinZip-AES payload）
function _startsWith(u8: Uint8Array, sig: number[]): boolean {
  if (u8.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (u8[i] !== sig[i]) return false;
  return true;
}

// 尾部 peek blob 的 MAGIC（8 字节；首字节非文本防 false-match，"WPTH" 可读性——格式 v1 沿用）
export const PEEK_MAGIC = [0x9e, 0x57, 0x50, 0x54, 0x48, 0x0d, 0x0a, 0x1a];
const PEEK_VER = 1;
const PEEK_HEADER_LEN = 8 + 1 + 16 + 12 + 4;   // MAGIC + ver + salt + iv + len
const PEEK_MAX_LEN = 8 * 1024 * 1024;          // len sanity（防 MAGIC false-positive 当头解析）
const PBKDF2_ITERS = 250_000;                  // peek 强 KDF（app 专属，不影响 7z 恢复）

// 尾部扫描窗口：peek（WebPaint 缩略图自适应 ≤70KB）+ 外层 CD/EOCD 余量。与 80KB byte-range 预算兼容。
export const PEEK_TAIL_WINDOW = 98304;

// 加密 peek blob 的 Blob.type 标记 —— byte-range 管线/缓存层靠它区分明文与密文（不解释内容）
export const ENC_PEEK_MIME = "application/x-sync-store-enc-peek";

const META_MAGIC = "WPMETA1\n";

export interface EncPeekParsed {
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

// ---- peek blob：强 KDF + AES-GCM（进出都是不透明字节）----

const _keyCache = new Map<string, CryptoKey>();   // `${password}\x00${saltHex}` → CryptoKey（N 个 peek 不重复跑 250k 轮）
function _hex(u8: Uint8Array): string { return [...u8].map((b) => b.toString(16).padStart(2, "0")).join(""); }

async function _deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
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

/** 不透明字节（可空）→ 完整加密 peek blob 字节（含 MAGIC 头）。空也加密（探测标记必须在）。 */
export async function encryptPeek(bytes: Uint8Array | null, password: string): Promise<Uint8Array> {
  const plain = bytes && bytes.length ? bytes : new Uint8Array(0);
  const salt = new Uint8Array(16), iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(salt);
  globalThis.crypto.getRandomValues(iv);
  const key = await _deriveKey(password, salt);
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plain as BufferSource));
  const out = new Uint8Array(PEEK_HEADER_LEN + ct.length);
  out.set(PEEK_MAGIC, 0);
  out[8] = PEEK_VER;
  out.set(salt, 9);
  out.set(iv, 25);
  new DataView(out.buffer).setUint32(37, ct.length, true);
  out.set(ct, PEEK_HEADER_LEN);
  return out;
}

/** 从字节流**末尾向前**扫加密 peek blob。带 sanity（ver/len/边界），false-positive 继续向前。
 *  找不到返 null。 */
export function scanEncPeekFromEnd(u8: Uint8Array): EncPeekParsed | null {
  const n = u8.length;
  outer: for (let i = n - PEEK_HEADER_LEN; i >= 0; i--) {
    for (let k = 0; k < 8; k++) if (u8[i + k] !== PEEK_MAGIC[k]) continue outer;
    const ver = u8[i + 8];
    if (ver !== PEEK_VER) continue;
    const len = new DataView(u8.buffer, u8.byteOffset + i + 37, 4).getUint32(0, true);
    if (len < 16 || len > PEEK_MAX_LEN || i + PEEK_HEADER_LEN + len > n) continue;   // GCM tag 至少 16B
    return {
      start: i,
      end: i + PEEK_HEADER_LEN + len,
      ver,
      salt: u8.slice(i + 9, i + 25),
      iv: u8.slice(i + 25, i + 37),
      ct: u8.slice(i + PEEK_HEADER_LEN, i + PEEK_HEADER_LEN + len),
    };
  }
  return null;
}

/** 解密 peek → 不透明字节（可能为空）。密码错 → throw code=WRONG_PASSWORD（GCM tag 即验证器）。 */
export async function decryptPeek(parsed: EncPeekParsed, password: string): Promise<Uint8Array> {
  const key = await _deriveKey(password, parsed.salt);
  try {
    return new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: parsed.iv as BufferSource }, key, parsed.ct as BufferSource));
  } catch (e) {
    const err = new Error("密码不对") as Error & { code?: string };
    err.code = "WRONG_PASSWORD";
    throw err;
  }
}

// ---- 容器探测 ----

async function _tailBytes(blobOrBytes: Blob | Uint8Array, window = PEEK_TAIL_WINDOW): Promise<Uint8Array> {
  if (blobOrBytes instanceof Uint8Array) {
    return blobOrBytes.length <= window ? blobOrBytes : blobOrBytes.slice(blobOrBytes.length - window);
  }
  const blob = blobOrBytes.slice(Math.max(0, blobOrBytes.size - window));
  return new Uint8Array(await blob.arrayBuffer());
}

/** 这份字节是不是加密容器？两条便宜判据：
 *   ① 尾部 peek MAGIC——app 自造容器**必带**（所有版本，含 v233-235 老 WinZip-AES 容器）；
 *   ② offset 0 = .7z magic——裸 .7z（用户手工 mock，无外壳无 peek）。
 *  明文 ora 是 PK zip 且尾部无 peek → 两条都 false（首字节 PK≠7z，不必解析，热路径便宜）。
 *  注：裸 WinZip-AES zip mock（PK 开头、无 peek）无法靠 magic 与明文 ora 区分 → 不自动识别
 *  （需 7z mock 即可；用户用 7z 造的天然走 ② 或带 peek 走 ①）。 */
export async function looksEncryptedContainer(blobOrBytes: Blob | Uint8Array): Promise<boolean> {
  try {
    const head = blobOrBytes instanceof Uint8Array ? blobOrBytes.slice(0, 6)
      : new Uint8Array(await blobOrBytes.slice(0, 6).arrayBuffer());
    if (_startsWith(head, SEVENZ_MAGIC)) return true;                  // 裸 .7z
    return scanEncPeekFromEnd(await _tailBytes(blobOrBytes)) != null;  // app 容器（peek MAGIC）
  } catch (_) { return false; }
}

// ---- 容器 pack / unpack ----

export interface PackOpts {
  dataBytes: Uint8Array;        // 原始文件字节（进 data.bin；格式不透明）
  fileName?: string | null;     // 真名（进 meta.bin，无 app 恢复时改回真名用）
  ext?: string;                 // 真扩展名（meta.bin；如 "ora" / "atlas.zip" / "txt"）
  guid?: string;                // 混淆名（不透明 token，非身份；缺省现生成）
  peek?: Uint8Array | null;     // 不透明旁路字节（可空；空也写探测标记）
  password: string;
}

/** 打包加密容器。 */
export async function packContainer({ dataBytes, fileName, ext = "bin", guid, peek = null, password }: PackOpts): Promise<Blob> {
  if (!password) throw new Error("没有密码，无法加密");
  const metaJson = JSON.stringify({ v: 1, name: fileName || null, ext });
  const payloadBytes = await pack7z([
    { path: "data.bin", data: dataBytes },
    { path: "meta.bin", data: META_MAGIC + metaJson },
  ], password);
  const peekEnc = await encryptPeek(peek, password);
  // peek 必须最后（byte-range 尾部一发命中 + 容器探测）；外层全 STORE（zipPack level:0）
  return await zipPack([
    { path: guid || makeGuid(), data: payloadBytes },
    { path: "peek", data: peekEnc },
  ]);
}

export interface UnpackResult { dataBlob: Blob; meta: ContainerMeta | null; guid: string; }

// 从解出的 inner entries 里挑「数据本体」：优先 data.bin；否则唯一/首个非 meta entry（容错手工 mock）。
function _pickData(inner: Record<string, Uint8Array>): Uint8Array | null {
  if (inner["data.bin"]) return inner["data.bin"];
  const names = Object.keys(inner).filter((n) => n !== "meta.bin");
  return names.length ? inner[names[0]] : null;
}
function _readMeta(inner: Record<string, Uint8Array>): ContainerMeta | null {
  if (!inner["meta.bin"]) return null;
  try {
    const text = new TextDecoder().decode(inner["meta.bin"]);
    if (text.startsWith(META_MAGIC)) return JSON.parse(text.slice(META_MAGIC.length));
  } catch (_) { /* meta 是恢复辅助件，坏了不阻断 */ }
  return null;
}

/** 解包加密容器 → { dataBlob, meta, guid }。密码错 → throw code=WRONG_PASSWORD。
 *  **加解密一律 unpack7z**（7z-wasm 认 .7z + 老 WinZip-AES zip）。**向后兼容 + 容错**：
 *   - 外壳 = 我们的明文 zip（[<GUID>, peek]）：取 <GUID> payload → unpack7z（.7z 或老 WinZip-AES 都行）。
 *   - 整文件就是裸 .7z / 裸 WinZip-AES zip（用户手工 mock，无外壳无 peek）：整块 → unpack7z。
 *   - 内层 data.bin 缺失（手工 mock）→ 取唯一/首个非 meta entry 当本体；meta.bin 缺失 → name/ext 未知。 */
export async function unpackContainer(blob: Blob | Uint8Array, password: string): Promise<UnpackResult> {
  const whole = blob instanceof Uint8Array ? blob : new Uint8Array(await blob.arrayBuffer());

  // 我们的外壳容器 = 明文 zip（offset0=PK），且解出来有非 peek 的 payload entry（自身是 .7z/PK 加密块）。
  //   注意：裸 WinZip-AES zip 也是 PK，但 zipUnpack 会在 getData 加密 entry 时抛 → 落到下面整块 unpack7z。
  let payload: Uint8Array | null = null, guid = "";
  if (_startsWith(whole, ZIP_MAGIC)) {
    try {
      const outer = await zipUnpack(blob instanceof Blob ? blob : new Blob([whole as BlobPart]));
      const g = Object.keys(outer).find((n) => n !== "peek" && n !== "thumb");   // "thumb"=v233/234 兼容
      if (g && outer[g] && (_startsWith(outer[g], SEVENZ_MAGIC) || _startsWith(outer[g], ZIP_MAGIC))) {
        payload = outer[g]; guid = g;
      }
    } catch (_) { /* 外层 entries 加密（裸 WinZip-AES）→ payload 留 null，整块解 */ }
  }

  // 无外壳（裸 .7z / 裸 WinZip-AES）→ 整块就是加密 payload。两路最终都 7z-wasm 解，零格式特例。
  const inner = await unpack7z(payload ?? whole, password);
  const data = _pickData(inner);
  if (!data) throw new Error("加密文件里没有可读内容");
  return { dataBlob: new Blob([data as BlobPart], { type: "application/zip" }), meta: _readMeta(inner), guid };
}
