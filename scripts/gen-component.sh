#!/usr/bin/env bash
# 家族组件 vendor 提取（C9 约定，见 ai-docs/20260810-family-web-component-convention.md）：
# 把一个 web component 打成零依赖单文件 .mjs，兄弟项目物理拷走（vendor 一切，家规 #4）。
# 用法：bash scripts/gen-component.sh [src/frontend/reference-window.ts]
# 产物 dist-components/<name>.mjs 不进本仓 git（gitignored）——它是导出件，不是本仓运行时。
set -euo pipefail
cd "$(dirname "$0")/.."

ENTRY="${1:-src/frontend/reference-window.ts}"
NAME="$(basename "${ENTRY%.ts}")"
OUT="dist-components/$NAME.mjs"
mkdir -p dist-components

tools/esbuild/esbuild "$ENTRY" --bundle --format=esm --outfile="$OUT" --log-level=warning

# 自包含验收：bundle 里不许残留裸 import（vendor 的全部意义）
if grep -qE '^\s*import\s' "$OUT"; then
  echo "✗ $OUT 残留外部 import——组件不自包含" >&2
  grep -nE '^\s*import\s' "$OUT" >&2
  exit 1
fi
echo "✓ $OUT（$(wc -c <"$OUT") bytes）自包含，可 vendor"
