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
  /**
   * Default "http://127.0.0.1:18765" (same machine). For another device, pass
   * an HTTPS URL that reaches the server (e.g. a Tailscale `*.ts.net` URL).
   */
  baseUrl?: string;
  /** Inject a custom fetch (tests / alternate transport). Omit = native fetch. */
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
