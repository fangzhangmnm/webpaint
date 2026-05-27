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

正确流程：
1. 写完代码
2. **commit + push**（即使你觉得逻辑还没复测）
3. 等 GitHub Pages 部署（顶栏版本号会切，或 SW 触发更新 toast）
4. 用户 iPad 上测
5. 不对再迭代

但要在 commit message 里**坦白没在浏览器复测**（[[feedback-no-browser-self-claim]]），让用户知道这一坨是"等你来测"的状态。

## PWA 更新检测细节

push 之后 iPad 上不会自动刷 —— 看 [[pwa-update-detection]]（4 路检测：`registration.waiting` / `updatefound`+`statechange='installed'` / `asset-updated` postMessage / `visibilitychange` poke）。

如果用户从 home screen 重启 PWA 仍然装着旧版：WKWebView bytecode cache 按 URL 缓存 V8 bytecode。SW 已经在 fetch 里给 `./xxx.js` 加 `?v=VERSION` 强制 URL 变化绕开（见 `service-worker.js` 的 `rewriteImportUrls`）。如果还不行，让用户从 app switcher 强制 kill PWA 再开。

## 兄弟项目复用

ScratchPad / WebXiaoHeiWu / RealHome / JustReadPapers / JustReadBooks / Background Radio / AtlasMaker（计划中）都是同一套：vanilla HTML/JS/CSS、GitHub Pages 托管、PWA 离线、iPad 测靠 push。下个 AI 进任何兄弟项目都不要试图"等本地完美再 commit"。
