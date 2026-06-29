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

正确流程（v122 起：bundle + branch + Actions Pages）：
1. 写完代码（src/ 里），保持在 main 分支
2. `bash scripts/build.sh` —— bundle src → dist/main-<hash>.mjs，sed 改 index.html 引新 hash
3. `git add . && git commit && git push origin main`
4. **GH Actions 自动跑** ~30 秒 → /dev/ 部署完成
5. iPad 开 `https://<host>/<project>/dev/`，刷新即见
6. 不对再迭代
7. 用户**显式 consent** 后（人手操作）：
   ```bash
   git checkout prod
   git merge --ff-only main
   git push origin prod          # ← 这一步必须问人，AI 不擅自做
   git checkout main
   ```
   Actions 自动跑 → / 部署。真用户下次刷新见新版。

**dev 改了 prod 不动**——真用户继续用上一次 promote 的稳定版，不会被 daily 改动伤到画。
规范见 [docs/20260529-dev-prod-split.md](20260529-dev-prod-split.md)。bundle 原理见 [docs/20260529-why-content-hash-bundle.md](20260529-why-content-hash-bundle.md)。

commit message 里仍要**坦白没在浏览器复测**（[[feedback-no-browser-self-claim]]）。

## PWA 更新检测细节（prod 入口）

prod URL 下 SW 跑。push 之后 iPad 上不会自动刷 —— 看 [[pwa-update-detection]]
（4 路检测：`registration.waiting` / `updatefound`+`statechange='installed'` /
`asset-updated` postMessage / `visibilitychange` poke）。

v121 起 prod bundle URL 自带 content-hash，旧 URL 上没有新内容，**绝对不可能撞
"版本号对了行为旧"的 bug**（v119-v120 经历的那个坑）。如果用户重启 PWA 还是旧
版，是 SW 自己还没拿到新 `index.html`；等下次 SW 后台 revalidate 触发即可。
WKWebView bytecode cache 也不再是问题——新 bundle 文件名都不同，V8 重编译。

dev 入口 `/dev/` 不注册 SW，**改了就生效**，不需要这些机制。

## 兄弟项目复用

ScratchPad / WebXiaoHeiWu / RealHome / JustReadPapers / JustReadBooks / Background Radio / AtlasMaker（计划中）都是同一套：vanilla HTML/JS/CSS、GitHub Pages 托管、PWA 离线、iPad 测靠 push。下个 AI 进任何兄弟项目都不要试图"等本地完美再 commit"。
