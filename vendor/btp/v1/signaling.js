// BTP signaling strategies — how the offer/answer codes cross between the
// two devices during pairing. This is the seam that keeps anti-abandonware
// open: v1 ships ManualSignaling (copy/paste, zero infra); a future
// ServerSignaling can drop into the same interface without touching the
// transport (webrtc-fetch.js) or the client (btp.js).
//
// Roles in BTP: **Blender is the offerer**, the app (WebPaint) is the
// answerer. So a signaling strategy must:
//   - receiveOffer(): Promise<string>   get Blender's connection code
//   - sendAnswer(code): Promise<void>   deliver our response code back
//
// Why the wall forces manual exchange on a pure LAN: an HTTPS PWA cannot
// fetch http://<lan-ip> (mixed content), and that same wall blocks it from
// fetching the offer from Blender. With no HTTPS-reachable relay, the codes
// can only travel by a channel the page can reach — a human (paste/QR).
// A signaling server collapses the two pastes into "type the same PIN";
// that is the upgrade ServerSignaling is reserved for. (⚠TODO)

/**
 * Manual copy/paste signaling.
 *
 * @param {object} opts
 * @param {string | (() => string | Promise<string>)} opts.offer
 *        Blender's connection code (the offer), or a function returning it
 *        (e.g. read a textarea the user pasted into).
 * @param {(code: string) => void | Promise<void>} [opts.onAnswer]
 *        Called with our response code so the UI can show it for the user
 *        to copy back into Blender's "Paste Response from Device".
 */
export function ManualSignaling({ offer, onAnswer } = {}) {
  return {
    async receiveOffer() {
      const code = typeof offer === "function" ? await offer() : offer;
      if (!code) throw new Error("ManualSignaling: no offer code provided");
      return code;
    },
    async sendAnswer(code) {
      if (onAnswer) await onAnswer(code);
    },
  };
}

/**
 * ⚠TODO (not implemented) — server-relayed signaling so pairing is a single
 * shared PIN instead of two pastes. Reserved interface; same shape as
 * ManualSignaling. Build target: a small HTTPS/WSS relay both devices reach,
 * keyed by a short PIN, carrying the offer one way and the answer back.
 */
export function ServerSignaling() {
  throw new Error("ServerSignaling is not implemented yet (anti-abandonware seam)");
}
