#!/usr/bin/env bash
# scripts/build.sh —— src/ → bundled mjs。两模式：
#   --dev  ：固定文件名 dist/main-dev.mjs（dev/index.html 引用，?v=epoch 防缓存）
#   --prod ：content-hash 文件名 dist/main-<hash>.mjs；自动改 index.html 的 script 引用
#
# 用法（commit 前跑）：
#   bash scripts/build.sh --dev    # daily dev：iPad 打开 https://.../dev/
#   bash scripts/build.sh --prod   # promote to prod：iPad 打开 https://.../
#
# 为啥这么做：见 docs/why-content-hash-bundle.md + docs/dev-prod-split.md
#
# 抄给 sibling family：本脚本几乎可直接拷，改 ENTRY、KEEP_VENDOR 两处即可。

set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:---dev}"
ESBUILD="./vendor/esbuild/esbuild"
ENTRY="./src/app.js"
OUT_DIR="./dist"

if [ ! -x "$ESBUILD" ]; then
  echo "[build] 找不到 vendored esbuild: $ESBUILD" >&2
  echo "        重新 vendor：cd vendor && curl -sL https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.24.0.tgz | tar -xz && mv package esbuild" >&2
  exit 1
fi
if [ ! -f "$ENTRY" ]; then
  echo "[build] 找不到入口: $ENTRY" >&2; exit 1
fi

mkdir -p "$OUT_DIR"

# 公共 esbuild flags
# - bundle：拼一个文件
# - format=esm：现代 PWA 都支持 module type，没必要 IIFE
# - minify：节省下载（PWA 一次缓存住意义不大，但首装快）
# - sourcemap：debug 必须；浏览器 devtools 自动还原 src/ 行号
# - external：vendor 大库不打进 bundle（msal 80KB / zip-js 30KB，慢路径用）
# - target=es2020：iPad Safari 14+ 全支持
ESBUILD_COMMON=(
  --bundle
  --format=esm
  --target=es2020
  --sourcemap=linked
  "--external:./vendor/*"
  "--external:../vendor/*"
  --tree-shaking=true
)

if [ "$MODE" = "--dev" ]; then
  OUT="$OUT_DIR/main-dev.mjs"
  echo "[build] dev → $OUT"
  "$ESBUILD" "$ENTRY" \
    "${ESBUILD_COMMON[@]}" \
    --outfile="$OUT"
  size=$(stat -c%s "$OUT" 2>/dev/null || wc -c < "$OUT")
  echo "[build] $(printf '%d' $size) bytes (dev 不 minify，留 readable 看 stack trace)"

elif [ "$MODE" = "--prod" ]; then
  # prod：先建到临时位置 → 算 hash → 重命名 → 改 index.html
  TMP="$OUT_DIR/main-tmp.mjs"
  "$ESBUILD" "$ENTRY" \
    "${ESBUILD_COMMON[@]}" \
    --minify \
    --outfile="$TMP"

  HASH=$(sha256sum "$TMP" | awk '{print substr($1, 1, 12)}')
  OUT="$OUT_DIR/main-$HASH.mjs"
  OUT_MAP="$OUT.map"

  # 先 mv 再清老的，否则 find 把 main-tmp.mjs 也当老 bundle 删了
  mv "$TMP" "$OUT"
  mv "$TMP.map" "$OUT_MAP"

  # 老 hashed bundle 清掉（含 sourcemap），不堆积；不动 main-dev.mjs 和刚 mv 出来的新 main-$HASH.mjs
  find "$OUT_DIR" -maxdepth 1 -name 'main-*.mjs' \
    -not -name 'main-dev.mjs' -not -name "main-$HASH.mjs" -delete
  find "$OUT_DIR" -maxdepth 1 -name 'main-*.mjs.map' \
    -not -name 'main-dev.mjs.map' -not -name "main-$HASH.mjs.map" -delete

  # 改 index.html 里那一行：<script type="module" src="./dist/main-XXX.mjs"></script>
  if grep -q 'src="./dist/main-' index.html; then
    sed -i "s|src=\"./dist/main-[a-f0-9]*\\.mjs\"|src=\"./dist/main-$HASH.mjs\"|" index.html
  else
    echo "[build] 警告：index.html 里没找到 ./dist/main-*.mjs script tag —— 第一次跑 prod，请手 patch" >&2
  fi

  size=$(stat -c%s "$OUT")
  echo "[build] prod → $OUT ($size bytes, hash=$HASH)"
  echo "[build] index.html 已指向新 hash"

else
  echo "用法：bash scripts/build.sh [--dev | --prod]" >&2
  exit 1
fi

echo "[build] 完成。提交：git add . && git commit && git push"
