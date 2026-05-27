#!/usr/bin/env bash
# 唯一版本号在 src/version.js（SW 合成、index.html 读取都从这里）。bump 一处生效。
# 用法: ./bump.sh v27-2026-05-26
set -e
NEW="${1:?usage: ./bump.sh vN-YYYY-MM-DD}"
cd "$(dirname "$0")"
sed -i "s/WEBPAINT_VERSION = \"[^\"]*\"/WEBPAINT_VERSION = \"$NEW\"/" src/version.js
echo "bumped to $NEW:"
grep -H "WEBPAINT_VERSION" src/version.js
