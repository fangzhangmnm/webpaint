#!/usr/bin/env bash
# scripts/build.sh —— src/ → dist/webpaint-<hash>.mjs；in-place 改 index.html 引新 hash
# （注：bundle 名是 webpaint-；service-worker.js install regex 必须跟这个名一致）
#
# 用法：编辑 src/ → 跑这个 → git commit && git push origin main
# (push 后 GH Actions 把 main 分支的 dist + 源原样部署到 /dev/ 路径)
#
# 抄给 sibling family：基本可拷，改 ENTRY 即可。

set -euo pipefail
cd "$(dirname "$0")/.."

ENTRY="./src/app.js"
OUT_DIR="./dist"
ESBUILD_VER="0.24.0"
ESBUILD="./tools/esbuild/esbuild"

# 没 esbuild 自动 curl 一份（tools/esbuild/ gitignored）
# 注：tools/ = 构建工具；vendor/ = 运行时 lib（zip-js, msal 等）。两个目录不混。
if [ ! -x "$ESBUILD" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)   plat="linux-x64" ;;
    Linux-aarch64)  plat="linux-arm64" ;;
    Darwin-arm64)   plat="darwin-arm64" ;;
    Darwin-x86_64)  plat="darwin-x64" ;;
    *) echo "[build] 未知平台 $(uname -s)-$(uname -m)，手 vendor esbuild 进 $ESBUILD" >&2; exit 1 ;;
  esac
  echo "[build] 拉 esbuild $plat-$ESBUILD_VER..."
  mkdir -p tools/esbuild
  TMP=$(mktemp -d)
  curl -sL "https://registry.npmjs.org/@esbuild/${plat}/-/${plat}-${ESBUILD_VER}.tgz" | tar -xz -C "$TMP"
  mv "$TMP/package/bin/esbuild" "$ESBUILD"
  chmod +x "$ESBUILD"
  rm -rf "$TMP"
fi

mkdir -p "$OUT_DIR"
TMP_OUT="$OUT_DIR/webpaint-tmp.mjs"

# 1. esbuild bundle 到临时名
"$ESBUILD" "$ENTRY" \
  --bundle --format=esm --target=es2020 \
  --minify --sourcemap=linked \
  --tree-shaking=true \
  --outfile="$TMP_OUT"

# 2. content hash 截 12 位作文件名
HASH=$(sha256sum "$TMP_OUT" | awk '{print substr($1, 1, 12)}')
OUT="$OUT_DIR/webpaint-$HASH.mjs"

# 3. mv 到最终名（先 mv 后清，否则 find 误删 main-tmp）
mv "$TMP_OUT"     "$OUT"
mv "$TMP_OUT.map" "$OUT.map"

# 老 hashed bundle 清掉，不堆积
find "$OUT_DIR" -maxdepth 1 -name 'webpaint-*.mjs' -not -name "webpaint-$HASH.mjs" -delete
find "$OUT_DIR" -maxdepth 1 -name 'webpaint-*.mjs.map' -not -name "webpaint-$HASH.mjs.map" -delete

# 4. sed 改 index.html 里引用，指向新 hash
if grep -q 'src="./dist/webpaint-' index.html; then
  # 兼容 PLACEHOLDER (大写) 和 hash (小写 hex)
  sed -i "s|src=\"./dist/webpaint-[A-Za-z0-9-]*\\.mjs\"|src=\"./dist/webpaint-$HASH.mjs\"|" index.html
else
  echo "[build] 警告：index.html 里没找到 ./dist/webpaint-*.mjs script tag" >&2
fi

size=$(stat -c%s "$OUT" 2>/dev/null || wc -c < "$OUT")
echo "[build] $OUT ($size bytes, hash=$HASH)"
echo "[build] 完成。提交：git add . && git commit && git push origin main"
