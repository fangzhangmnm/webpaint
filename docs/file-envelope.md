# File envelope — WebPaint implementation (GUID identity, ADR-0011)

> Canonical cross-app spec: `../../20260601 MyPWAPatterns/docs/file-envelope.md`. This is WebPaint's pilot implementation + slicing. WebPaint is name-identified end-to-end today (no doc GUID); this brings ADR-0011 GUID identity in via a **tail-readable EOCD-comment trailer**, robust to legacy/foreign files.

## Carrier (decided 2026-06-07)

- **EOCD comment** = `MAGIC("WPM1") + minimal-meta-JSON`. Minimal: `{"g":guid,"v":1,"e":editorVersion}`. **No drawing state** (that stays `webpaint/state.json`), **no name** (path is a mutable attribute keyed on `g`).
- **Thumbnail stays a standard zip entry** (`Thumbnails/thumbnail.png`, last) — external ORA tools still see it.
- Encrypted (future, ADR-0012): meta-JSON stays **plaintext** in the outer comment (GUID is non-sensitive, ADR-0011); only payload+thumb encrypted.

## Codec (done — v196)

- [src/file-envelope.js](src/file-envelope.js): `buildMetaComment({g,v,e})` ⇄ `parseMetaComment(bytes)` — pure, robust (bad/absent → `null` → caller falls back to name). node-tested.
- [src/zip.js](src/zip.js): `zipPack(entries, {comment})` writes EOCD comment; `zipUnpack` returns `{files, comment}`.
- [src/ora.js](src/ora.js): `encodeDocToOra(doc, {meta})` writes the comment; `decodeOraToDoc` reads it into `doc._meta` (`{g,v,e}|null`). No `meta` passed → no comment (old behavior). **Nothing generates/uses the GUID yet** — codec only.

## Slicing (remaining)

1. ✅ **Codec** (v196) — envelope read/write, behavior-preserving.
2. **Mint + persist GUID** — generate `crypto.randomUUID()` at new-doc; carry in `doc._meta`/save `opts.meta`; on load, read `doc._meta.g`, **mint if missing** (legacy) and persist to local pkg. Track active doc's guid in app (beside `_activeSessionName`).
3. **Local list + index** — `pkg.guid`; `listSessions` returns `guid`; a local **GUID↔path index** (ADR-0011).
4. **Cloud tail-extract** — extend cloud-thumbs to read the EOCD comment from the tail byte-range it already fetches (cached by item-id, etag-invalidated); cloud list items carry `guid`.
5. **Reconcile by GUID** — `gallery-model.mergeLocalCloud` pairs by `guid` (name fallback) → fixes the multi-device / dedup phantom-tile (report C1). rename/move keyed on GUID.

## Robustness (non-negotiable)

Legacy/foreign file (no comment) → name identity; GUID minted + written on next app-save. Tail too small / parse fail → name fallback. **Never crash.**
