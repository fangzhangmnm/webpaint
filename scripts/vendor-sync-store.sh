#!/usr/bin/env bash
# 从 canonical lib（../20260601 MyPWAPatterns/sync-store）单向 vendor 同步引擎进 WebPaint。
# 纪律：**只编辑 lib（canonical）**；跑这个把 vendored 副本刷成与 lib byte-identical。
# 绝不手改 src/store/ 里的 vendored 文件。local-adapter.js 是 WebPaint 自己的（不 vendor）。
set -euo pipefail
cd "$(dirname "$0")/.."
LIB="../20260601 MyPWAPatterns/sync-store/src"
DST="src/store"
# WebPaint 当前用到的子集（cut-over 后再加 cloud-sync.js / index.js / providers/）
for f in store.js mock-provider.js mock-local.js onedrive-provider.js; do
  cp "$LIB/$f" "$DST/$f"
done
echo "[vendor] sync-store 子集 → $DST 已刷新（与 lib byte-identical）"
echo "[vendor] WebPaint 专属（不 vendor）：local-adapter.js"
