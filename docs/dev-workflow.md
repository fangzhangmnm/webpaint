# 开发节奏（给下一个 AI 看的常识）

兄弟项目都共享这一条：**iPad / Meta Quest / 手机的测试 必须经过 GitHub Pages**，PC 可以本地 http 起服。这决定了 commit 节奏。

## 测试路径

| 设备 | 怎么跑 |
|---|---|
| PC 浏览器 | `cd WebPaint && python -m http.server 8000` → `http://localhost:8000` |
| iPad / Pencil | **必须** push 到 GitHub → GitHub Pages 自动构建（约 30-60 秒）→ PWA 安装后从 home 打开 |
| Meta Quest | 同 iPad，浏览器或 WebXR 走 Pages URL |
| 手机 | 同 iPad |

`file://` 不行：SW 注册、`navigator.clipboard`、`createImageBitmap` 在 file:// 下都受限或不工作。

## 这对 commit 节奏的影响

**不能"等用户测过再 commit"** — 因为非 PC 设备要先有 commit 才能测。

正确流程（v121 起：bundle + dev/prod 分家）：
1. 写完代码（src/ 里）
2. `bash scripts/build.sh --dev` 重 bundle 成 `dist/main-dev.mjs`
3. **commit + push**（即使你觉得逻辑还没复测）
4. 用户 iPad 开 `https://<host>/<project>/dev/`，刷新即见
5. 不对再迭代
6. 用户**显式 consent** 后（比如每晚一次），跑 `bash scripts/build.sh --prod` →
   生成 hashed bundle、sed 改 `index.html`、commit + push → prod 入口 `/` 升级

**dev 改了 prod 不动** —— 真用户继续用 prod 的稳定版，不会被你 daily 改动伤到画。
规范见 [docs/dev-prod-split.md](dev-prod-split.md)、bundle 原理见 [docs/why-content-hash-bundle.md](why-content-hash-bundle.md)。

commit message 里仍要**坦白没在浏览器复测**（[[feedback-no-browser-self-claim]]）。

## PWA 更新检测细节（prod 入口）

prod URL 下 SW 还跑。push 之后 iPad 上不会自动刷 —— 看 [[pwa-update-detection]]
（4 路检测：`registration.waiting` / `updatefound`+`statechange='installed'` /
`asset-updated` postMessage / `visibilitychange` poke）。

v121 起 prod bundle URL 自带 content-hash，旧 URL 上没有新内容，**绝对不可能撞
"版本号对了行为旧"的 bug**（v119-v120 经历的那个坑）。如果用户重启 PWA 还是旧
版，是 SW 自己还没拿到新 `index.html`；等下次 SW 后台 revalidate 触发即可。
WKWebView bytecode cache 也不再是问题——新 bundle 文件名都不同，V8 重编译。

dev 入口 `/dev/` 不注册 SW，**改了就生效**，不需要这些机制。

## 兄弟项目复用

ScratchPad / WebXiaoHeiWu / RealHome / JustReadPapers / JustReadBooks / Background Radio / AtlasMaker（计划中）都是同一套：vanilla HTML/JS/CSS、GitHub Pages 托管、PWA 离线、iPad 测靠 push。下个 AI 进任何兄弟项目都不要试图"等本地完美再 commit"。
