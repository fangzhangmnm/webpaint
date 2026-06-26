// Blender Texture Protocol — v1 vendor entry point.
//
// Vendor this whole directory (protocol/v1/) into your app and import ONLY
// from this file. Everything a sibling needs is re-exported here; the other
// modules are implementation detail.
//
//   import {
//     BTPClient, BTPError, BUNDLE_VERSION,
//     connectRemote, ManualSignaling,
//   } from "./vendor/btp/v1/index.js";
//
// Same machine (AtlasMaker on PC) — localhost HTTP, zero setup:
//   const client = new BTPClient();                 // http://127.0.0.1:18765
//
// Cross device (WebPaint on iPad) — WebRTC, paired once via Blender's panel:
//   const { fetch } = await connectRemote({
//     signaling: ManualSignaling({ offer: pastedCode, onAnswer: showResponseCode }),
//   });
//   const client = new BTPClient({ baseUrl: "", fetch });
//
// From here on the two are indistinguishable — same 9 endpoints, same errors.
// See README.md for the wire contract and §"远程 transport" for the handshake.

export { BTPClient, BTPError, PROTOCOL, BUNDLE_VERSION } from "./btp.js";
export { connectRemote, channelFetch } from "./webrtc-fetch.js";
export { ManualSignaling, ServerSignaling } from "./signaling.js";
