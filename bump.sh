#!/usr/bin/env bash
# 一次性 bump src/version.js 和所有 module 的 MODULE_VERSION + app.js 的 APP_V，
# 避免 WebXiaoHeiWu 那种 "I forgot it across three bumps in a row" 翻车。
#
# 用法: ./bump.sh v18-2026-05-26
set -e
NEW="${1:?usage: ./bump.sh vN-YYYY-MM-DD}"
cd "$(dirname "$0")"
sed -i "s/WEBPAINT_VERSION = \"[^\"]*\"/WEBPAINT_VERSION = \"$NEW\"/" src/version.js
sed -i "s/MODULE_VERSION = \"[^\"]*\"/MODULE_VERSION = \"$NEW\"/" src/app.js src/board.js src/brush.js src/db.js src/doc.js src/input.js
sed -i "s/APP_V = \"[^\"]*\"/APP_V = \"$NEW\"/" src/app.js
echo "bumped to $NEW:"
grep -H "WEBPAINT_VERSION\|MODULE_VERSION\|APP_V = " src/version.js src/app.js src/board.js src/brush.js src/db.js src/doc.js src/input.js | head
