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

ENTRY="./src/app.ts"
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

# 0. 类型检查门（store 深模块被 Uint8Array/Blob 类型 bug 雷击两次 → 把 tsc --noEmit 设成构建前置）。
#    esbuild 只 strip 类型不检查；这道才是真护栏。tsc 装在 devDependencies（npm i 一次）。
#    没装 tsc（裸 clone 未 npm i）→ 大声警告但不挡构建（保留 node 直跑的简单性）；装了就强制过。
TSC="./node_modules/.bin/tsc"
if [ -x "$TSC" ]; then
  echo "[build] 类型检查 tsc --noEmit…"
  "$TSC" --noEmit -p tsconfig.json || { echo "[build] ✗ 类型检查失败，已挡下构建（修类型或先 git stash）。" >&2; exit 1; }
  echo "[build] ✓ 类型通过"
else
  echo "[build] ⚠ 未装 tsc（node_modules 缺）——跳过类型检查。装一下：npm install" >&2
fi

# 0.5 deep-import lint（红线封口的**真**守卫）。
#     src/store/ 是深模块，唯一公开入口 = src/store/index.ts。app 层绕过 index 直接 import 内部文件
#     = 绕过红线 guts（cloud-sync / local-head / push / seal / safe-resolve / …）。
#     ⚠ 这道 lint 以前**不存在**，而 index.ts 和 README.md 都白纸黑字声称「build.sh 的 lint 会挡」——
#       封口只是口头约定、无守卫。v415 补上，谎注释同步改掉。
#     零依赖实现（仓库无 eslint/dep-cruiser，也不该为这一条引；MASTER §B: vendor every dependency）。
echo "[build] deep-import lint（app 层不得绕过 src/store/index.ts）…"
# 覆盖面（v415 防退化时补齐——初版四个口子全堵上）：
#   · 单引号和双引号都认（初版只认双引号）
#   · static import / export-from / 动态 import() / 裸副作用 import 都认（初版只认 `from "..."`）
#   · 子目录也认，如 store/providers/xxx.ts（初版的字符类不含 `/`，钻子目录就绕过去了）
#   · src/ 和 test/ 都扫（测试直接 import 库内部是**允许**的——红线测试就得钻进去——故 test/ 只在
#     app 源码那条规则里排除；这里保持只扫 src/，并把这个取舍写明，免得下个人以为是漏的）
DEEP_HITS=$(grep -rnE "(from|import)[[:space:]]*\(?[[:space:]]*['\"](\.{1,2}/)+store/[^'\"]*['\"]" src --include='*.ts' \
            | grep -v '^src/store/' \
            | grep -vE "store/index\.ts['\"]" || true)
if [ -n "$DEEP_HITS" ]; then
  echo "[build] ✗ 发现 deep import（app 层直接钻进 src/store/ 内部文件）：" >&2
  echo "$DEEP_HITS" >&2
  echo "[build]   → 改成从 './store/index.ts' 拿；index 没导出就说明公开面缺东西，" >&2
  echo "[build]     补 index 的 export（并想清楚这是不是该暴露），别绕过封口。" >&2
  exit 1
fi
echo "[build] ✓ 无 deep import"

# v0.8.7 B 骑士分层 lint：app 层对 store 的**值级** import 只许接缝（app-store.ts；store-absent.ts
#   是缺席变体接缝、只准 type-only）。其余 app 文件要么不 import store、要么 `import type`（窄接口镜像）。
#   防的是绕接缝直拿 store 内部对象——store = 插件不是地基（缺席模式 ?nostore 必须继续成立）。
echo "[build] B 分层 lint（app 层 store 值级 import 只许接缝）…"
APPSTORE_HITS=$(grep -rnE "(from|import)[[:space:]]*\(?[[:space:]]*['\"][^'\"]*/store/" src --include='*.ts' 2>/dev/null \
  | grep -v "^src/store/" | grep -v "^src/app-store.ts" | grep -v "import type" || true)
if [ -n "$APPSTORE_HITS" ]; then
  echo "[build] ✗ app 层出现 store 值级 import（只准接缝 app-store.ts；其余用 import type 或走 ctx.store）：" >&2
  echo "$APPSTORE_HITS" >&2
  exit 1
fi
echo "[build] ✓ B 分层 lint 过"

# 0.6 v0.4 分层 lint（workpiece/tiles 红线 + 已死模块防复活）。
#   · workpiece/** 不碰 store（持久化归 importer/exporter/persistency；spec journal/20260721 §workpiece）
#   · tiles/** 不碰 gl/**（CPU tile 池是纯底座；GPU 侧经 bridge 反向依赖它）
#   · selection.ts / marching-ants.ts 不碰 gl/**、store（S5：选区是纯 CPU tile 值对象；GL 上传走 board 接缝）
#   · history.ts(根目录旧栈) / pixel-edit.ts / layer-undo.ts / gl/tile-residency.ts 已日落（v0.4.3-0.4.5），
#     不得复活 import（workpiece/history.ts 是 T5 的 v2 编排器、undo-history 曾是合法名——都排除在外）
#   · S7：gl/tile-backend-gl.ts / gl/tile-store.ts / gl/tile-index.ts / gl/gl-doc-renderer.ts 已死
#     （gpu-tile-pool + tile-bridge + render-tree 取代），不得复活 import
#   · render/** 是纯规划（node 全测），不 import gl/**、store
echo "[build] v0.4 分层 lint…"
LAYER_HITS=$(grep -rnE "(from|import)[[:space:]]*\(?[[:space:]]*['\"][^'\"]*(/store/|app-store)" src/workpiece --include='*.ts' 2>/dev/null || true)
TILES_HITS=$(grep -rnE "(from|import)[[:space:]]*\(?[[:space:]]*['\"][^'\"]*/gl/" src/tiles --include='*.ts' 2>/dev/null || true)
SEL_HITS=$(grep -nE "(from|import)[[:space:]]*\(?[[:space:]]*['\"][^'\"]*(/gl/|/store/|app-store)" src/selection.ts src/marching-ants.ts 2>/dev/null || true)
DEAD_HITS=$(grep -rnE "(from|import)[[:space:]]*\(?[[:space:]]*['\"][^'\"]*(/history\.ts|/pixel-edit\.ts|/layer-undo\.ts|/tile-residency\.ts|/tile-backend-gl\.ts|/tile-store\.ts|/tile-index\.ts|/gl-doc-renderer\.ts)" src test --include='*.ts' --include='*.mjs' 2>/dev/null | grep -v "undo-history\|workpiece/history" || true)
# S9 归档模块防复活（src 禁 import；test/gl-smoke 的 reference-*.ts 是合法归档地）：
S9DEAD_HITS=$(grep -rnE "(from|import)[[:space:]]*\(?[[:space:]]*['\"][^'\"]*(/layer-composite\.ts|/gl-compose-plan\.ts)" src --include='*.ts' 2>/dev/null || true)

RENDER_HITS=$(grep -rnE "(from|import)[[:space:]]*\(?[[:space:]]*['\"][^'\"]*(/gl/|/store/|app-store)" src/render --include='*.ts' 2>/dev/null || true)
if [ -n "$LAYER_HITS$TILES_HITS$SEL_HITS$DEAD_HITS$RENDER_HITS$S9DEAD_HITS" ]; then
  echo "[build] ✗ v0.4 分层违规：" >&2
  echo "$LAYER_HITS$TILES_HITS$SEL_HITS$DEAD_HITS$RENDER_HITS" >&2
  exit 1
fi
echo "[build] ✓ v0.4 分层干净"

# 0.7 C2 目录格律 lint（C 骑士提案 §1 五目录单向依赖 + 禁浏览器词；ADR-0009）。规则**只增不减**：
#   · common/**  纯类型+纯数学：不得 import src 其他目录（禁一切 ../ 相对引用，vendor 也不许）。
#   · backend/** 只准 import common/（+ backend 内部相对引用 + vendor 纯计算库）。
#   · frontend/** 只准 import common/ + backend/（+ frontend 内部 + vendor）——不碰 shell/、gallery/、store。
#   · shell/**   platform 胶水，可 import 全部（无约束）。
#   · gallery/** 检疫堆场（提案 §1：只搬不斩）：暂无依赖约束；双向依赖记账在 src/gallery/gallery.ts 头。
#   · 禁浏览器词（backend 域 DOM 零依赖）：common/** + backend/** 代码行不得出现
#     document/window/navigator/localStorage/sessionStorage/getContext/createElement/addEventListener。
#     注释行豁免；WebGL 句柄类型（WebGLTexture 等）= Gl2Port 契约 opaque 类型，不在禁词内。
#   （C2 时 backend/、frontend/ 尚未有住户——存量随 C3/C5 切片搬入，规则先立防退化。）
echo "[build] C2 目录格律 lint…"
COMMON_DEP_HITS=$(grep -rnE "(from|import)[[:space:]]*\(?[[:space:]]*['\"]\.\./" src/common --include='*.ts' 2>/dev/null || true)
BACKEND_DEP_HITS=$(grep -rnE "(from|import)[[:space:]]*\(?[[:space:]]*['\"](\.\./)" src/backend --include='*.ts' 2>/dev/null | grep -vE "['\"](\.\./)+(common|vendor)/" || true)
FRONTEND_DEP_HITS=$(grep -rnE "(from|import)[[:space:]]*\(?[[:space:]]*['\"](\.\./)" src/frontend --include='*.ts' 2>/dev/null | grep -vE "['\"](\.\./)+(common|backend|vendor)/" || true)
BROWSERWORD_HITS=$(grep -rnE "\b(document|window|navigator|localStorage|sessionStorage)\b|getContext\(|createElement\(|addEventListener\(" src/common src/backend --include='*.ts' 2>/dev/null | grep -vE ":[0-9]+:[[:space:]]*(//|\*|/\*)" || true)
if [ -n "$COMMON_DEP_HITS$BACKEND_DEP_HITS$FRONTEND_DEP_HITS$BROWSERWORD_HITS" ]; then
  echo "[build] ✗ C2 目录格律违规：" >&2
  echo "$COMMON_DEP_HITS$BACKEND_DEP_HITS$FRONTEND_DEP_HITS$BROWSERWORD_HITS" >&2
  exit 1
fi
echo "[build] ✓ C2 目录格律干净"

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

# 4b. styles.css 版本 buster（v0.5.18：新 HTML+HTTP缓存旧 CSS 曾出真机 UI 崩——bundle 有 hash CSS 没有）。
#   buster = styles.css 自身内容 hash（CSS-only 改动也会 bust；SW 端 cache.match 均已 ignoreSearch）。
CSSHASH=$(sha256sum styles.css | awk '{print substr($1, 1, 12)}')
if grep -q 'href="./styles.css' index.html; then
  sed -i "s|href=\"./styles.css?v=[A-Za-z0-9-]*\"|href=\"./styles.css?v=$CSSHASH\"|" index.html
else
  echo "[build] 警告：index.html 里没找到 styles.css link" >&2
fi

size=$(stat -c%s "$OUT" 2>/dev/null || wc -c < "$OUT")
echo "[build] $OUT ($size bytes, hash=$HASH)"
echo "[build] 完成。提交：git add . && git commit && git push origin main"
