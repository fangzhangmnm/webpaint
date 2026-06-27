# BTP client — CHANGELOG

Version history of the protocol contract + JS client bundle. This is where
"what changed between versions" lives; [`README.md`](./README.md) describes only the
current contract. `BUNDLE_VERSION` (in `btp.js`) tracks this file's latest entry.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).
Wire compatibility: all `/v1/*` endpoints stay forward-compatible within 1.x
(fields may be added, never removed or re-meaning'd).

## 1.2.0

Removed — the **WebRTC remote transport** (`connectRemote`, `channelFetch`,
`ManualSignaling`, `ServerSignaling`, and `webrtc-fetch.js` / `signaling.js` /
`frame.js` / `sdp-envelope.js`). Cross-device access is now plain HTTPS: point
`BTPClient({ baseUrl })` at any URL that reaches the Blender server — easiest is
`tailscale serve` (valid cert, tunnelled, works same-WiFi and remote). No wire
change; `/v1/*` endpoints untouched. The client bundle's API surface shrank to
`BTPClient`, `BTPError`, `PROTOCOL`, `BUNDLE_VERSION`. The removed transport is
preserved at git tag `archive/webrtc-transport`.

Why: WebRTC existed only to punch through the HTTPS → `http://<lan-ip>`
mixed-content wall, but it doesn't work in an iOS home-screen PWA (no host ICE
candidates / local-network permission gate). A direct HTTPS URL (Tailscale) is
simpler and actually works on iPad.

## 1.1.0

Added — **remote transport** (cross-device, WebRTC DataChannel) and a single
vendor entry point. No wire/endpoint changes; existing `/v1/*` HTTP usage is
untouched.

- `index.js` — sole vendor entry; re-exports `BTPClient`, `BTPError`,
  `connectRemote`, `channelFetch`, `ManualSignaling`, `ServerSignaling`,
  `BUNDLE_VERSION`, `PROTOCOL`. Consumers import only from here.
- `connectRemote(opts)` — pairs with Blender (Blender-as-offerer; the app
  answers) and returns a `fetch`-shaped transport over a WebRTC DataChannel.
  `new BTPClient({ baseUrl: "", fetch: conn.fetch })` makes `BTPClient`
  transport-agnostic.
- `ManualSignaling` — copy/paste pairing (implemented). `ServerSignaling` —
  reserved interface for PIN/relay pairing (not implemented; throws).
- `channelFetch(channel)` — wrap an already-open DataChannel as `fetch`.
- Message framing: requests and responses are chunked (16 KB) so multi-MB
  GET/PUT bodies survive the DataChannel max-message-size. Wire-compatible JS
  (`frame.js`) and Python (`frame.py`) implementations.
- LAN default: no STUN/TURN (`iceServers: []`, host candidates only).

Addon (Blender side), shipped together as `btp-0.4.0`:
- Single offerer model (Blender-as-offerer); the browser-as-offerer code path
  was removed.
- `webrtc.py` chunks responses / reassembles requests via the new `frame.py`.

## 1.0.0

Initial release — localhost HTTP transport, PC-side complete.

- 9 endpoints: `scene`, `textures` (list/get/get-data/put-data/create/rename),
  `selection`, `exec`. See `README.md`.
- `BTPClient` over `fetch` to `http://127.0.0.1:18765`; `BTPError` with stable
  machine-readable `.code`.
- Overwrite semantics, no conflict detection; identity = image `name`.
- Mutations run as undo-pushing Blender operators.
- `BTP1:` SDP envelope (gzip+base64url) helper present for the upcoming WebRTC
  transport.

Shipped with addon `btp-0.3.0`.
