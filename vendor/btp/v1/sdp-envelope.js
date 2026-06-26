// BTP SDP envelope — `BTP1:<gzip+base64url>` single-line format.
//
// Compresses a ~1.3 KB SDP into ~800 chars so a connection code fits in
// one clipboard paste / messenger line. The Blender (aiortc) side has a
// byte-compatible Python implementation in blender_addon/btp/sdp_envelope.py
// — keep the two in sync.
//
// decode() also accepts raw SDP ("v=0…") so hand-typed / legacy codes work.

export const ENVELOPE_PREFIX = "BTP1:";

export async function encodeSDP(sdp) {
  const input = new TextEncoder().encode(sdp);
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(input);
  writer.close();
  const gz = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  let bin = "";
  for (let i = 0; i < gz.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, gz.subarray(i, i + 0x8000));
  }
  let b64 = btoa(bin);
  b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return ENVELOPE_PREFIX + b64;
}

export async function decodeSDP(envelope) {
  const s = envelope.trim();
  if (s.startsWith("v=0")) return s;
  if (!s.startsWith(ENVELOPE_PREFIX)) {
    throw new Error(
      `Not a BTP connection code. Expected '${ENVELOPE_PREFIX}…' or raw SDP ('v=0…').`,
    );
  }
  let b64 = s.slice(ENVELOPE_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const gz = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(gz);
  writer.close();
  return new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
}

export function isEnvelope(s) {
  return typeof s === "string" && s.trim().startsWith(ENVELOPE_PREFIX);
}
