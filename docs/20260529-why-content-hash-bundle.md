# 为啥用 esbuild bundle + content-hash 文件名（v121 起）

> **sibling family 抄这个**：每个 PWA 项目都跑同样模式。改 `scripts/build.sh` 里
> 几个变量、跟 `service-worker.js` 里的 `STATIC_PRECACHE` 列表即可。

## 一句话总结

不再让人类（也不让 AI）手维护"30 个 JS 文件谁是哪个版本"。esbuild 把 src/ 打成
**1 个文件**，文件名带 content-hash（如 `main-a3b9c0d12345.mjs`）。
**文件名就是版本号**。新版 = 新文件名 = 新 URL = 浏览器不可能拿到旧的当新的。

## 解决了什么

老方案（v15 ~ v120）想做的事：
- 30+ 个 ES module，每个 `import "./x.js?v=${VERSION}"` 加 query 防 WKWebView bytecode cache
- SW install 把 30+ 个文件一锅 `cache.add` 全部缓存
- bump 版本号 → SW 升级 → 重 precache 30+ 个文件
- SW 在响应 .js 时 rewrite import URL 加 `?v=`
- `src/version.js` 是字符串 SSoT，HTML / SW / page 多处读

每个机制都有道理。**问题**：30 个文件部署到 GitHub Pages CDN 时，多 PoP 传播
**不同步**。SW install 那一刻：
- `version.js` 已经是 v120
- `index.html` 已经是 v120
- `lasso.js`、`app.js` 可能还是 v119（命中的 PoP 没传完）

SW 把"v120 的 version.js + v119 的 lasso.js"一锅塞 `webpaint-v120` cache 里。后续
请求 cache-first 服务这个**版本混搭的 cache**。页面顶栏写 v120（version.js 已是新的），
但行为是 v119 的 lasso（lasso.js 是旧的）。**令人发狂**。

v119 ~ v120 的时候我尝试加 `manifest.json` + 文件级 sha256 校验绕过去。能修，但
工程量大、心智负担重，跟根因斗智斗勇。

## 新方案：把"版本对齐"问题在更上游消掉

esbuild build → 1 个 bundle `dist/main-<contenthash>.mjs`。content-hash =
该 bundle 的 sha256 截 12 位。

- 文件改了 → hash 改 → 文件名改
- `index.html` 引用：`<script src="./dist/main-a3b9c0d12345.mjs">`
- 浏览器要 `main-a3b9c0d12345.mjs` 这个 URL 时，**这个 URL 在 GitHub Pages 上
  只有一个内容版本**（要么 200 + 正确内容，要么 404）。**版本混搭根本不可能发生**。
- 老版 `main-XXX.mjs` 还在 cache 里也无所谓 —— 新 URL 没引它，永不被请求；
  cache 自然淘汰

SW 现在只做两件事：
1. precache 当前 bundle + 几个 static（icons / styles / vendor）
2. 离线时 cache-first 兜底

manifest hash / URL rewrite / version.js 合成 这些**全删干净**。

## bundle 内部 = es2020 ESM

esbuild flags（见 `scripts/build.sh`）：
- `--bundle --format=esm --target=es2020`：一个 file，现代 module 格式，iPad Safari 14+ 全支持
- `--sourcemap=linked`：debug 完整还原 src/ 行号，浏览器 devtools 自动用
- `--minify` (prod only)：减体积；dev 不 minify 便于看 stack trace
- `--external:./vendor/*`：vendor 大库 (msal / zip-js) **不打进 bundle**，仍走
  classic `<script>` / 动态 script 注入（见 src/auth.js）。冷启动 bundle 才 150KB gz。

## 老问题对照

| 老问题 | 老方案 | 现在 |
|---|---|---|
| 30 个 .js URL 各自缓存失效 | bump version + `?v=` query | 整个 src/ 1 个 bundle，hash URL |
| iPad Safari WKWebView bytecode 黏 cache | SW 改 import URL `?v=` | bundle 内无 import；外层 URL hash 变即重编译 |
| 版本号 SSoT | `src/version.js` + `importScripts` | `src/version.js` ES module，esbuild inline 进 bundle |
| GitHub Pages PoP 不同步导致 cache 混搭 | manifest.json + sha256 校验 | hash URL 撞不上旧内容，问题根本消失 |
| dev / prod 不分家 → 半 dev 状态破坏用户 | 没解决 | dev/index.html 独立入口，见 docs/20260529-dev-prod-split.md |

## 加新依赖时怎么办

写 src/ 内文件 → import 进来 → 跑 build.sh。esbuild 自动 follow import 把它打进 bundle。

如果是大库（>50KB）想 lazy load：用 `await import("./big.js")`。esbuild 自动 split
成单独 chunk，也带 content hash，自治。

vendor UMD 库（zip-js、msal 这种没出 ESM 的）：放 `src/vendor/`，HTML classic
`<script>` 或动态注入，**不进 bundle**。esbuild 通过 `--external` 隔离。

## 别走回头路

不要再回到"src/foo.js 是版本 X，src/bar.js 是版本 Y"那种状态——src/ 整体是
**bundle 的输入**，单个文件没有自己的"已发布版本"。改了 src/，跑 build.sh，**全套
一起 promote**。
