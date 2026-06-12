// ZIP 读写 = vendored zip.js (gildas-lormeau)。
// UMD bundle 自挂 window.zip，HTML head 里以 classic <script> 加载。
//
// 加密路径（zipPackEncrypted / zipUnpackEncrypted）= WinZip-AES-256
// （encryptionStrength: 3），标准格式 —— 7-zip / WinRAR 输密码即可打开
// （anti-abandonware，ADR-0012）。容器编排在 crypto-container.js。

function Z() {
  if (typeof window === "undefined" || !window.zip) {
    throw new Error("zip.js 未加载（应在 app.js 之前以 classic <script> 引入 ./vendor/zip-js/zip-full.min.js）");
  }
  return window.zip;
}

// 首次访问时关掉 web workers —— inline worker 在某些场景被 CSP 拒；不开省心。
let _configured = false;
function ensureConfigured() {
  if (_configured) return;
  try { Z().configure({ useWebWorkers: false }); } catch (_) {}
  _configured = true;
}

function toZipReader(data) {
  const z = Z();
  if (data instanceof Blob) return new z.BlobReader(data);
  if (data instanceof Uint8Array) return new z.Uint8ArrayReader(data);
  if (data instanceof ArrayBuffer) return new z.Uint8ArrayReader(new Uint8Array(data));
  if (typeof data === "string") return new z.TextReader(data);
  throw new TypeError("zip: 不支持的数据类型");
}

/** entries: [{ path, data: Blob|Uint8Array|ArrayBuffer|string }, ...]; return Blob */
export async function zipPack(entries) {
  ensureConfigured();
  const z = Z();
  const writer = new z.ZipWriter(new z.BlobWriter("application/zip"));
  for (const { path, data } of entries) {
    // level: 0 = STORE。PNG 已是压缩流，再 deflate 没意义还更慢。
    await writer.add(path, toZipReader(data), { level: 0 });
  }
  return await writer.close();
}

/** WinZip-AES-256 加密打包（ADR-0012 payload 层）。entries 同 zipPack；return Blob。
 *  level:0 STORE —— 内容物（.ora=zip）已压缩，AES 流上再 deflate 没收益还更慢。 */
export async function zipPackEncrypted(entries, password) {
  ensureConfigured();
  const z = Z();
  const writer = new z.ZipWriter(new z.BlobWriter("application/zip"), {
    password,
    encryptionStrength: 3,   // 3 = AES-256（WinZip 规范；1=128 2=192）
  });
  for (const { path, data } of entries) {
    await writer.add(path, toZipReader(data), { level: 0 });
  }
  return await writer.close();
}

/** 解 WinZip-AES zip。返回 { path: Uint8Array }；密码错 / 文件坏 → throw。
 *  zip.js 用 WinZip header 里的 2 字节 password-verifier 先验，错密码快速失败。 */
export async function zipUnpackEncrypted(blob, password) {
  ensureConfigured();
  const z = Z();
  const reader = new z.ZipReader(new z.BlobReader(blob), { password });
  try {
    const entries = await reader.getEntries();
    const out = {};
    for (const e of entries) {
      if (e.directory) continue;
      out[e.filename] = await e.getData(new z.Uint8ArrayWriter(), { password });
    }
    return out;
  } catch (e) {
    // zip.js 错密码/坏文件都走这里，区分不了 → 统一 code（caller 据此循环重问而非崩流程）
    const err = new Error("密码不对或文件已损坏");
    err.code = "WRONG_PASSWORD";
    throw err;
  } finally { await reader.close(); }
}

/** 只读 zip 里**一个** entry（不解其余大块；CD 读目录 + 单 entry getData）。
 *  没有该 entry → null。makePeek（从 ora 抽缩略图）这类「大 zip 取小件」用。 */
export async function zipReadEntry(blob, path) {
  ensureConfigured();
  const z = Z();
  const reader = new z.ZipReader(new z.BlobReader(blob));
  try {
    const entries = await reader.getEntries();
    const e = entries.find((x) => !x.directory && x.filename === path);
    if (!e) return null;
    return await e.getData(new z.Uint8ArrayWriter());
  } finally { await reader.close(); }
}

/** 返回 { path: Uint8Array } */
export async function zipUnpack(blob) {
  ensureConfigured();
  const z = Z();
  const reader = new z.ZipReader(new z.BlobReader(blob));
  try {
    const entries = await reader.getEntries();
    const out = {};
    for (const e of entries) {
      if (e.directory) continue;
      out[e.filename] = await e.getData(new z.Uint8ArrayWriter());
    }
    return out;
  } finally { await reader.close(); }
}
