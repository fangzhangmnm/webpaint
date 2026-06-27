// Blender Texture Protocol — v1 vendor entry point.
//
// Vendor this whole directory (protocol/v1/) into your app and import ONLY
// from this file. Everything a sibling needs is re-exported here.
//
//   import { BTPClient, BTPError, BUNDLE_VERSION } from "./vendor/btp/v1/index.js";
//
// One mental model: give BTPClient a baseUrl; the calling code is identical.
//
//   // Same machine — localhost HTTP, zero setup:
//   const client = new BTPClient();                         // http://127.0.0.1:18765
//
//   // Another device (e.g. iPad) — any HTTPS URL that reaches the Blender
//   // server. Easiest: `tailscale serve` exposes the localhost server over
//   // HTTPS on the machine's *.ts.net name (valid cert, tunnelled):
//   const client = new BTPClient({ baseUrl: "https://pc.tailnet.ts.net" });
//
// Same 9 endpoints, same errors, regardless of baseUrl. See README.md.

export { BTPClient, BTPError, PROTOCOL, BUNDLE_VERSION } from "./btp.js";
