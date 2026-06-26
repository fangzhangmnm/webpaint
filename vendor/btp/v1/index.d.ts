// Blender Texture Protocol — v1 client, typed API surface.
//
// This .d.ts IS the machine-readable contract: a TypeScript consumer (or an
// agent) reads it to learn the full API without reading implementation. The
// runtime is plain ESM `.js` (zero-build, loads directly in browser/node);
// these types describe it. Human contract: ./README.md. History: ./CHANGELOG.md.

export const PROTOCOL: "v1";
export const BUNDLE_VERSION: string;

// ─── Wire types ───

export interface SceneInfo {
  /** Empty string when the .blend has never been saved. */
  blend_filepath: string;
  unit: string | null;
  active_object_name: string | null;
}

export interface TextureMetadata {
  /** Unique id (Blender enforces uniqueness). */
  name: string;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  /** Treat as opaque; do not hard-code an enum comparison. */
  color_space: string;
  is_float: boolean;
  alpha_mode: "STRAIGHT" | "PREMUL" | "CHANNEL_PACKED" | "NONE" | string;
  source: "FILE" | "GENERATED" | "MOVIE" | "VIEWER" | string;
  file_format: "PNG" | "JPEG" | "OPEN_EXR" | string;
  is_dirty: boolean;
  packed: boolean;
}

export interface Selection {
  texture: string | null;
  /** Reserved for a later version; always null in v1. */
  object: null;
  mesh: null;
}

/** Accepted request body for binary uploads. */
export type PngBody = Blob | ArrayBuffer | Uint8Array;

// ─── Errors ───

export class BTPError extends Error {
  /** HTTP-equivalent status (404, 409, 415, 500, …). */
  status: number;
  /** Stable machine-readable code, e.g. "texture_not_found". */
  code: string;
  details?: unknown;
}

// ─── Client ───

export interface BTPClientOptions {
  /** Default "http://127.0.0.1:18765" (localhost HTTP). Pass "" for WebRTC. */
  baseUrl?: string;
  /** Inject a transport. Omit = native fetch; pass conn.fetch for WebRTC. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default: none). */
  timeoutMs?: number;
}

export class BTPClient {
  constructor(options?: BTPClientOptions);
  baseUrl: string;

  getScene(): Promise<SceneInfo>;
  listTextures(): Promise<TextureMetadata[]>;
  getTextureMetadata(name: string): Promise<TextureMetadata>;
  /** Raw pixel bytes (image/png or source format). */
  getTextureData(name: string): Promise<Blob>;
  /** Replace pixels of an existing image; auto-packs into the .blend. */
  putTextureData(name: string, png: PngBody): Promise<TextureMetadata>;
  /** Create a new image (name must not already exist). */
  createTexture(name: string, png: PngBody): Promise<TextureMetadata>;
  renameTexture(name: string, newName: string): Promise<TextureMetadata>;
  getSelection(): Promise<Selection>;
  /** Server-defined ad-hoc command; NOT covered by version guarantees. */
  exec(command: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Escape hatch for endpoints not wrapped above. */
  fetch(
    method: string,
    path: string,
    opts?: {
      body?: BodyInit;
      contentType?: string;
      headers?: Record<string, string>;
      responseType?: "blob";
    },
  ): Promise<unknown>;
}

// ─── Remote transport (cross-device, WebRTC) ───

/** Strategy that moves the offer/answer codes between the two devices. */
export interface Signaling {
  /** Resolve the offer (connection) code produced by Blender. */
  receiveOffer(): Promise<string>;
  /** Deliver our answer (response) code back to Blender. */
  sendAnswer(code: string): Promise<void>;
}

/** Copy/paste signaling. */
export function ManualSignaling(opts: {
  /** Blender's connection code, or a function returning it. */
  offer: string | (() => string | Promise<string>);
  /** Called with our response code so the UI can present it for paste-back. */
  onAnswer?: (code: string) => void | Promise<void>;
}): Signaling;

/** Reserved (PIN/relay pairing). Not implemented — throws when called. */
export function ServerSignaling(): never;

export interface ConnectRemoteOptions {
  signaling: Signaling;
  /** Default { iceServers: [] } — pure LAN, no STUN/TURN. */
  rtcConfig?: RTCConfiguration;
  /** Abort if the channel doesn't open in time (default 30000). */
  handshakeTimeoutMs?: number;
  /** Per-request timeout in ms (default: none). */
  requestTimeoutMs?: number;
  onStateChange?: (state: RTCPeerConnectionState) => void;
}

export interface RemoteConnection {
  /** A fetch-shaped transport; hand to new BTPClient({ baseUrl:"", fetch }). */
  fetch: typeof fetch;
  close(): void;
  peerConnection: RTCPeerConnection;
  /** Peer DTLS fingerprint ("sha-256 AB:CD:…") parsed from the offer, or null. */
  remoteFingerprint: string | null;
  readonly connectionState: RTCPeerConnectionState;
}

/** Pair with Blender (Blender-as-offerer) and return a fetch-shaped transport. */
export function connectRemote(opts: ConnectRemoteOptions): Promise<RemoteConnection>;

/** Wrap an already-open DataChannel-like object as a fetch function. */
export function channelFetch(
  channel: RTCDataChannel,
  opts?: { requestTimeoutMs?: number },
): typeof fetch;
