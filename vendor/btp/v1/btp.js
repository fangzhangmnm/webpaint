// Blender Texture Protocol — JavaScript client.
// Bundled with: ./README.md  (same dir, same version).
//
// Version policy:
//   BUNDLE_VERSION bumps when the protocol's semantics change or when this
//   client's documented API changes. Non-protocol bug fixes / internal
//   refactors do NOT bump. Major bumps imply a parallel /protocol/vN/ dir.

// 1.1.0: added remote transport (connectRemote / signaling.js / webrtc-fetch.js)
//        — a documented client-API addition. Wire endpoints unchanged (still v1).
export const PROTOCOL = "v1";
export const BUNDLE_VERSION = "1.1.0";

const DEFAULT_BASE_URL = "http://127.0.0.1:18765";


export class BTPError extends Error {
  constructor({ status, code, message, details }) {
    super(`BTP ${code || "error"}: ${message}`);
    this.name = "BTPError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}


export class BTPClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl="http://127.0.0.1:18765"]
   * @param {typeof fetch} [opts.fetch] override (for tests / future transports)
   * @param {number} [opts.timeoutMs] abort each request after N ms (default: no timeout)
   */
  constructor({ baseUrl = DEFAULT_BASE_URL, fetch: fetchImpl, timeoutMs } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this._fetch = fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    if (!this._fetch) {
      throw new Error("No fetch implementation available; pass `fetch` option");
    }
    this.timeoutMs = timeoutMs;
  }

  // ─── Scene ───

  async getScene() {
    return this._send("GET", "/v1/scene");
  }

  // ─── Textures ───

  async listTextures() {
    return this._send("GET", "/v1/textures");
  }

  async getTextureMetadata(name) {
    return this._send("GET", `/v1/textures/${enc(name)}`);
  }

  /** @returns {Promise<Blob>} */
  async getTextureData(name) {
    return this._send("GET", `/v1/textures/${enc(name)}/data`, { responseType: "blob" });
  }

  /**
   * Replace pixels of an existing image with the given PNG.
   * Side effect: image becomes packed (in .blend file).
   * @param {string} name
   * @param {Blob|ArrayBuffer|Uint8Array} png
   */
  async putTextureData(name, png) {
    return this._send("PUT", `/v1/textures/${enc(name)}/data`, {
      body: png,
      contentType: "image/png",
    });
  }

  /**
   * Create a new image with the given PNG bytes.
   * @param {string} name  Image name (must not exist in .blend)
   * @param {Blob|ArrayBuffer|Uint8Array} png
   */
  async createTexture(name, png) {
    return this._send("POST", "/v1/textures", {
      body: png,
      contentType: "image/png",
      headers: { "X-BTP-Name": name },
    });
  }

  async renameTexture(name, newName) {
    return this._send("POST", `/v1/textures/${enc(name)}/rename`, {
      body: JSON.stringify({ new_name: newName }),
      contentType: "application/json",
    });
  }

  // ─── Selection ───

  async getSelection() {
    return this._send("GET", "/v1/selection");
  }

  // ─── Ad-hoc commands ───
  // Server-defined; not version-protected. See README.md > /v1/exec.

  async exec(command, params = {}) {
    return this._send("POST", "/v1/exec", {
      body: JSON.stringify({ command, params }),
      contentType: "application/json",
    });
  }

  // ─── Escape hatch ───

  /**
   * Raw request. Use for endpoints not yet wrapped (e.g. server-defined exec
   * commands you want to call as if REST), or when you need custom headers.
   */
  async fetch(method, path, { body, contentType, headers, responseType } = {}) {
    return this._send(method, path, { body, contentType, headers, responseType });
  }

  // ─── Internal ───

  async _send(method, path, opts = {}) {
    const { body, contentType, headers = {}, responseType } = opts;
    const h = { ...headers };
    if (contentType) h["Content-Type"] = contentType;

    const controller = this.timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;

    let res;
    try {
      res = await this._fetch(`${this.baseUrl}${path}`, {
        method,
        headers: h,
        body: body ?? undefined,
        signal: controller?.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) throw await this._toError(res);
    if (responseType === "blob") return res.blob();

    const ct = res.headers.get("Content-Type") || "";
    if (ct.startsWith("application/json")) return res.json();
    return null;
  }

  async _toError(res) {
    let payload = {};
    try { payload = await res.json(); } catch { /* not JSON */ }
    return new BTPError({
      status: res.status,
      code: payload?.error?.code || `http_${res.status}`,
      message: payload?.error?.message || res.statusText || "Unknown error",
      details: payload?.error?.details,
    });
  }
}


function enc(name) {
  return encodeURIComponent(name);
}
