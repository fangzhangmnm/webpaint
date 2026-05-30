// ZIP 读写 = vendored zip.js (gildas-lormeau)。
// UMD bundle 自挂 window.zip，HTML head 里以 classic <script> 加载。
//
// phase 1 只用未加密路径（zipPack / zipUnpack）。phase 3 上加密时把
// AtlasMaker 的 zipPackEncrypted / zipUnpackEncrypted 直接搬过来。

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
