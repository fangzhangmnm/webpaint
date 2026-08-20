// 图库密码验证器 sentinel（v0.4.11，真机 2.3 拍板：「sentinel 放 .webpaint / cloud，跟账号走」）。
//
// 病根：加密容器无 salt 文件、密码只活内存（红线设计不动）→ 系统没有任何「图库已有密码」的
//   持久化标记：重装/换设备后必然走「创建新密码」流程且不校验——创建错 = 两套密码并存 = softlock。
// 修法：**app 层**在 synced collection（跟账号走，LWW，离线有本地镜像）落一个微型验证器：
//   { v, salt, iv, ct }，ct = AES-GCM(KDF(pw, salt), 固定明文)。GCM tag 即验证（解得开 = 密码对）。
//   不存明文/密钥/可逆物；KDF 参数对齐 store peek（PBKDF2-SHA256 × 250k）但**完全独立实现**——
//   零 store 契约改动（容器格式/库 API 都不碰），亦不与容器互操作。
// 语义：verifier 只回答「图库密码是不是 X」。忘记密码 = 内容永久找不回（无后门，与容器一致）；
//   重置 verifier（clearVerifier）只解锁「设新密码」流程，旧加密件仍是旧密码。

import { appState } from "./app-state.ts";

export interface VerifierRecord { v: 1; salt: string; iv: string; ct: string }

const PBKDF2_ITERS = 250_000;                       // 对齐 store peek 的强度（独立实现）
const PLAINTEXT = "webpaint-gallery-password-v1";   // 固定明文（验证只看 GCM tag 是否解得开）；v1 格式常量——云端存量 verifier 按它加密，改名（0.10.0 WeebPaint）不追改

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function _deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return await subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PBKDF2_ITERS },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

// ---- 密码学核心（纯，node 可测）----

/** pw → 新 verifier 记录。 */
export async function createVerifierRecord(pw: string): Promise<VerifierRecord> {
  const salt = new Uint8Array(16), iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(salt);
  globalThis.crypto.getRandomValues(iv);
  const key = await _deriveKey(pw, salt);
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(PLAINTEXT)));
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

/** 记录 + pw → 是否匹配（GCM tag 即验证）。 */
export async function verifyRecord(rec: VerifierRecord, pw: string): Promise<boolean> {
  try {
    const key = await _deriveKey(pw, unb64(rec.salt));
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(rec.iv) as BufferSource }, key, unb64(rec.ct) as BufferSource);
    return new TextDecoder().decode(plain) === PLAINTEXT;
  } catch {
    return false;   // GCM tag 不符 = 密码错
  }
}

// ---- appState 门面（跟账号走的存取）----

export function hasVerifier(): boolean { return appState.galleryPasswordVerifier != null; }

/** 记住「图库密码 = pw」（覆盖旧 verifier；创建/首次验证成功时调）。 */
export async function createVerifier(pw: string): Promise<void> {
  appState.galleryPasswordVerifier = await createVerifierRecord(pw);
}

/** 校验：ok=密码对；bad=密码错；none=没有 verifier（老账号未迁 / 已重置）。 */
export async function checkVerifier(pw: string): Promise<"ok" | "bad" | "none"> {
  const rec = appState.galleryPasswordVerifier;
  if (!rec || rec.v !== 1) return "none";
  return (await verifyRecord(rec, pw)) ? "ok" : "bad";
}

/** 重置（用户显式确认后）：只清 verifier——旧加密件仍是旧密码，永不可用新密码解。 */
export function clearVerifier(): void { appState.galleryPasswordVerifier = null; }
