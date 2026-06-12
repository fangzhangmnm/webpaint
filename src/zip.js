// ZIP 读写 = vendored zip.js (gildas-lormeau)。
// UMD bundle 自挂 window.zip，HTML head 里以 classic <script> 加载。
//
// 只管明文 zip（外层加密容器 + .ora 本体）。payload 的加密走 .7z（src/sevenzip.js）。

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

// payload 加密已从 WinZip-AES（弱 KDF）迁到 .7z 强 KDF（见 src/sevenzip.js + crypto-container）。
// zip.js 现在只管**明文** zip（外层容器 + ora 本体）；zipPackEncrypted/zipUnpackEncrypted 已删。

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
