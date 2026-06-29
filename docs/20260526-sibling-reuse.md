# 兄弟项目复用

WebPaint 一期搭起来，**90% 是从兄弟项目搬的**。这里记下来什么搬了什么没搬，让下一个项目继续接力。

## 路径

- `../../20260520 ScratchPad/` —— 最直接的兄弟（也是 canvas + Pencil），抄得最多
- `../../20260516 WebXiaoHeiWu/` —— OneDrive 同步层（一期没启用，后期接）
- `../../20260520 RealHome/` —— `docs/20260524-principles.md` 和 `docs/20260524-sync-constraints.md` 是跨项目宪法

## 直接搬过来的

| 主题 | 来源 | WebPaint 怎么用 |
| - | - | - |
| PWA 壳 `<head>` 完整 | ScratchPad `index.html` | iPad meta / theme guard / 错误浮条 / icon link 全套 |
| `apple-touch-icon` 必须 PNG | ScratchPad `docs/20260524-ios-pwa-quirks.md` | 用 ImageMagick 从 SVG 生成 180/192/512 PNG |
| 错误浮条 inline `<script>` | 同上 | 改了一下变量名（`__sp_showFatal` → `__wp_showFatal`） |
| FOUC 主题 guard inline | 同上 | localStorage key 换成 `webpaint.theme` |
| service worker cache-first + ETag 检测 + skipWaiting toast | ScratchPad `service-worker.js` | 改了 cache name 和 PRECACHE_URLS |
| PointerEvent 模式：palm rejection、coalesced events、平滑 α=0.65、屏幕双击切笔/橡皮、wheel 缩放、Space 临时 pan | ScratchPad `src/input.js` + `docs/20260524-pointer-and-pen-input.md` | 抄了行为矩阵和大部分 _down/_move/_up 骨架；不同的是画笔走 BrushEngine 而非矢量 stroke |
| 主题 CSS 变量 + 三档（auto/day/night） | ScratchPad `src/styles.css` + `app.js` 主题切换 | 加了一个 `--void` 给画布外底色 |
| 顶栏 / sheet / backdrop / toast 的样式骨架 | 同上 | 复制 + 微调（加了 `.swatch.active-color`, `.sv-pad`） |
| 状态文本 setStatus 1.8s 自动复位 | ScratchPad `app.js` | 一字不改 |
| HUD 右下角缩放标签 | 同上 | 加了 doc 尺寸 |

## **有意没搬**的

| 不搬的 | 为什么 |
| - | - |
| `Float32Array` 矢量笔画 | WebPaint 是栅格 —— 笔画一旦 stamp 进 layer，就没有"重渲"的概念了 |
| `"ink"` 颜色 sentinel + theme reactive 重渲 | 同上：栅格定死了像素颜色，主题切换不该回去改 |
| `Path2D` quadratic 中点平滑 + 变宽丝带渲染 | WebPaint 走 stamp brush；圆笔可以未来再加 Path2D 描边作为 size<4 的 fast path |
| 多档 grid（无 / 点 / 方 / 横线） | 绘画不太需要 grid；以后可能加 1 档简单 grid 给 texture tile |
| 整套 PNG / PDF 导出（jspdf） | 一期不导出。后期 PNG 导出会有，PDF 不一定 |

## 接 OneDrive 时**要搬**的

（一期未用，列在这等触发）

| 主题 | 来源 |
| - | - |
| MSAL 设置 / `auth.js` 形状 / scopes / redirect | JustReadPapers / WebXiaoHeiWu |
| Graph 辅助函数（getItemMeta, downloadUrl, chunked upload） | WebXiaoHeiWu `src/graph.js`（或 onedrive.js） |
| 离线 list fallback（IDB 兜底） | JustReadPapers `app.js` `loadFolderItems` |
| `reconcileWithRemoteList` 空列表保护 | JustReadBooks |
| 抽屉 + 汉堡菜单 UI | Background Radio |
| sync 优先级宪法 | RealHome `docs/20260524-sync-constraints.md` |
| vendor MSAL（不走 CDN）打包 | RealHome esbuild 那套 |

接的时候 **先 grep 同主题的最新兄弟，不要直接抄 WebXiaoHeiWu**——它早期的几个决定（比如 PUT semantics）后来在 RealHome 被覆盖了。

## 不一样的地方

- **canvas 是栅格**（不是矢量），所以 board.js 没有 stroke 数据、没有 bbox cull、没有可重渲的颜色 sentinel。
- **多 layer**：board.render() 内层多了 `for layer of doc.layers` —— ScratchPad 只有"strokes 数组"。
- **画笔有 cursor 预览圈**：ScratchPad 没做（写公式用不上）。
- **吸色**：ScratchPad 没有。WebPaint 既有专门工具按钮，又支持 Alt 临时切。
- **HSV picker**：ScratchPad 用固定 swatch。
- **没有"阅后即焚"叙事**：ScratchPad 强调没 library 只 clear；WebPaint 后期要做完整持久化 + 同步，clear 只是清当前 layer。
