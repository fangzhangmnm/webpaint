// BTP remote transport — a WebRTC DataChannel dressed up as `fetch`.
//
// The narrow interface: WebPaint never touches RTCPeerConnection, SDP, ICE,
// or DataChannel framing. It calls connectRemote() once to pair, gets back a
// fetch-shaped function, and hands that straight to BTPClient:
//
//   import { BTPClient, connectRemote, ManualSignaling } from "./vendor/btp/v1/index.js";
//   const { fetch } = await connectRemote({
//     signaling: ManualSignaling({ offer: pastedCode, onAnswer: showCode }),
//   });
//   const client = new BTPClient({ baseUrl: "", fetch });   // identical API to localhost
//
// Same 9 endpoints, same BTPClient, same errors — only the transport differs.
//
// Role: Blender is the offerer, we are the answerer (we receive the channel
// via pc.ondatachannel). Non-trickle ICE (we wait for gather-complete before
// emitting the answer) so the whole answer fits one paste.

import { decodeSDP, encodeSDP } from "./sdp-envelope.js";
import { frame, Reassembler } from "./frame.js";

const CHANNEL_LABEL = "btp";

/**
 * Pair with Blender and return a fetch-shaped transport.
 *
 * @param {object} opts
 * @param {{ receiveOffer(): Promise<string>, sendAnswer(code: string): Promise<void> }} opts.signaling
 *        How the offer/answer codes cross devices. See signaling.js.
 * @param {RTCConfiguration} [opts.rtcConfig]  Defaults to NO ICE servers
 *        (pure LAN host candidates — no STUN/TURN, no external dependency).
 * @param {number} [opts.handshakeTimeoutMs=30000]  Abort if the channel does
 *        not open within this window.
 * @param {number} [opts.requestTimeoutMs]  Per-request timeout (default none).
 * @param {(state: string) => void} [opts.onStateChange]  RTCPeerConnection
 *        connectionState updates ("connecting" | "connected" | "failed" | …).
 * @returns {Promise<{ fetch: typeof fetch, close(): void, peerConnection: RTCPeerConnection, remoteFingerprint: string|null, connectionState: string }>}
 */
export async function connectRemote({
  signaling,
  rtcConfig,
  handshakeTimeoutMs = 30000,
  requestTimeoutMs,
  onStateChange,
} = {}) {
  if (!signaling || typeof signaling.receiveOffer !== "function") {
    throw new Error("connectRemote requires a `signaling` strategy (see signaling.js)");
  }

  // No iceServers on a pure LAN: host candidates connect directly. Empty
  // config (not undefined) prevents browsers from using their defaults.
  const pc = new RTCPeerConnection(rtcConfig || { iceServers: [] });

  let channel = null;
  let openResolve, openReject;
  const channelOpen = new Promise((res, rej) => { openResolve = res; openReject = rej; });

  pc.addEventListener("connectionstatechange", () => {
    onStateChange?.(pc.connectionState);
    if (pc.connectionState === "failed") {
      openReject?.(new Error("WebRTC connection failed"));
    }
  });

  pc.addEventListener("datachannel", (ev) => {
    channel = ev.channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", () => openResolve(channel));
  });

  // 1. Receive Blender's offer (manual paste / future relay).
  const offerCode = await signaling.receiveOffer();
  const offerSdp = await decodeSDP(offerCode);
  const remoteFingerprint = parseFingerprint(offerSdp);

  // 2. Answer it, wait for ICE gather (non-trickle), hand the code back.
  await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await iceGatherComplete(pc);
  const answerCode = await encodeSDP(pc.localDescription.sdp);
  await signaling.sendAnswer(answerCode);

  // 3. Wait for the channel to open (or time out / fail).
  await withTimeout(channelOpen, handshakeTimeoutMs, "WebRTC handshake timed out");

  const rtcFetch = channelFetch(channel, { requestTimeoutMs });

  return {
    fetch: rtcFetch,
    peerConnection: pc,
    remoteFingerprint,
    get connectionState() { return pc.connectionState; },
    close() {
      try { channel?.close(); } catch { /* noop */ }
      try { pc.close(); } catch { /* noop */ }
    },
  };
}

// ─── fetch-shim over an open DataChannel ───

/**
 * Wrap an already-open DataChannel-like object as a `fetch`-shaped function.
 * connectRemote() uses this internally; exported as an escape hatch for
 * callers who bring their own channel, and to keep the shim unit-testable
 * with a mock channel. The channel needs: send(str), readyState, binaryType,
 * addEventListener("message"|"close").
 */
export function channelFetch(channel, { requestTimeoutMs } = {}) {
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject, timer }
  const reasm = new Reassembler();

  channel.addEventListener("message", (ev) => {
    let env;
    try {
      env = reasm.accept(ev.data);
    } catch (e) {
      console.error("[BTP webrtc] bad frame:", e);
      return;
    }
    if (!env) return; // mid-message; wait for more frames
    const p = pending.get(env.id);
    if (p) {
      pending.delete(env.id);
      if (p.timer) clearTimeout(p.timer);
      p.resolve(env);
    }
  });

  channel.addEventListener("close", () => {
    for (const [, p] of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("DataChannel closed before response"));
    }
    pending.clear();
  });

  return async function rtcFetch(url, opts = {}) {
    if (channel.readyState !== "open") {
      throw new Error(`BTP channel not open (state: ${channel.readyState})`);
    }
    const id = `r${nextId++}`;
    const bytes = await bodyToBytes(opts.body);
    const envelope = {
      id,
      method: opts.method || "GET",
      path: toPath(url),
      headers: opts.headers || {},
      body_b64: bytes ? bytesToB64(bytes) : undefined,
    };

    const respEnv = await new Promise((resolve, reject) => {
      const timer = requestTimeoutMs
        ? setTimeout(() => {
            pending.delete(id);
            reject(new Error(`BTP request timed out after ${requestTimeoutMs}ms`));
          }, requestTimeoutMs)
        : null;
      pending.set(id, { resolve, reject, timer });
      for (const f of frame(id, JSON.stringify(envelope))) channel.send(f);
    });

    const respBody = respEnv.body_b64 ? bytesToB64ToBytes(respEnv.body_b64) : null;
    return new Response(respBody, {
      status: respEnv.status ?? 200,
      headers: respEnv.headers || {},
    });
  };
}

// ─── helpers ───

/** BTPClient calls fetch(`${baseUrl}${path}`); with baseUrl:"" the url IS the
 *  path. Tolerate a full URL too. */
function toPath(url) {
  if (/^https?:/i.test(url)) {
    const u = new URL(url);
    return u.pathname + u.search;
  }
  return url;
}

async function bodyToBytes(body) {
  if (body == null) return null;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (typeof body.arrayBuffer === "function") {
    return new Uint8Array(await body.arrayBuffer());
  }
  throw new Error("Unsupported body type for BTP rtcFetch");
}

// btoa/atob choke on multi-MB strings via spread; chunk through fromCharCode.
function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function bytesToB64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function iceGatherComplete(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
  });
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/** Pull the peer's DTLS fingerprint out of an SDP (for trust display /
 *  future cert-pinned reconnect). Returns "sha-256 AB:CD:…" or null. */
function parseFingerprint(sdp) {
  const m = /^a=fingerprint:(\S+)\s+(\S+)/im.exec(sdp);
  return m ? `${m[1]} ${m[2]}` : null;
}
