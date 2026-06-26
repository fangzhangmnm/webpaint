// BTP DataChannel framing — chunk a logical envelope across multiple
// DataChannel messages and reassemble on the other end.
//
// Why this exists: a WebRTC DataChannel message has a max size (SCTP +
// per-browser limits, often ~64 KB–256 KB). A single GET of a 2048² PNG
// or a PUT from WebPaint is several MB — it does NOT fit in one send().
// So every logical envelope (request OR response) is split into frames
// here and reassembled by the receiver. Small messages = one frame.
//
// The transport is reliable + ordered (default DataChannel), but the
// reassembler indexes by frame position anyway, so reordering is harmless.
//
// Wire frame (JSON text): { id, i, n, p }
//   id  logical message id (same id the inner envelope carries)
//   i   chunk index (0-based)
//   n   total chunk count
//   p   this chunk of the inner envelope's JSON string
//
// Backward-compat: the reassembler also accepts a *raw* envelope object
// (no i/n/p) and returns it as-is, so older un-framed senders still work.

// 16 KB per chunk: comfortably under aiortc's default and every browser's
// DataChannel max-message-size, with low per-frame overhead.
export const CHUNK_SIZE = 16384;

/** Split `str` (a serialized envelope) into wire frames for `id`. */
export function frame(id, str) {
  const n = Math.max(1, Math.ceil(str.length / CHUNK_SIZE));
  const frames = new Array(n);
  for (let i = 0; i < n; i++) {
    frames[i] = JSON.stringify({
      id,
      i,
      n,
      p: str.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
    });
  }
  return frames;
}

/** Reassembles frames into envelopes. One instance per inbound channel. */
export class Reassembler {
  constructor() {
    this._partial = new Map(); // id -> { parts, got, n }
  }

  /**
   * Feed one DataChannel message. Returns the fully-reassembled envelope
   * object when the last frame of a message arrives, otherwise null.
   */
  accept(raw) {
    const text = typeof raw === "string"
      ? raw
      : new TextDecoder().decode(raw);
    const f = JSON.parse(text);

    // Raw (un-framed) envelope — accept for backward compat.
    if (f.n === undefined || f.p === undefined) return f;

    if (f.n === 1) return JSON.parse(f.p);

    let entry = this._partial.get(f.id);
    if (!entry) {
      entry = { parts: new Array(f.n), got: 0, n: f.n };
      this._partial.set(f.id, entry);
    }
    if (entry.parts[f.i] === undefined) {
      entry.parts[f.i] = f.p;
      entry.got++;
    }
    if (entry.got === entry.n) {
      this._partial.delete(f.id);
      return JSON.parse(entry.parts.join(""));
    }
    return null;
  }
}
