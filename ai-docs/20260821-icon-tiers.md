# 图标档位与接线（为什么有一张手绘的 32×32）

> as-of v0.10.14 / 2026-08-21 · 美术源在 OneDrive `apps/WeebPaint/`，不进 repo（大稿 4.6MB）

## 档位表

| 文件 | 来源 | 生成方式 | 用在哪 |
|---|---|---|---|
| `icon-32.png` | `20260821-WeebPaint像素图标.ora`（32×32，user 手绘） | **1:1 原样，绝不重采样** | 浏览器标签页 / 书签 / 任务栏 |
| `icon-192.png` | `20260820-WeebPaint图标设计.ora`（1024×1024） | LANCZOS 缩放 | manifest、`<link rel=icon>` 大档 |
| `icon-512.png` | 同上 | LANCZOS 缩放 | 装机弹窗、manifest `maskable` |
| `apple-touch-icon-180.png` | 同上 | LANCZOS 缩放 | iOS/iPad 主屏 |
| `icon.svg` | 同上 | 内嵌 192 栅格的 `<image>` 包装 | **只给 manifest 的 `sizes:"any"`** |

底色统一 `#f6f4ef`（家族米色，= manifest `background_color`，与 ScratchPad / RealHome 同源）。
两份 .ora 的底色层 2026-08-21 由 user 补成不透明满铺，导出件因此零透明像素——深色标签栏上不会漏底。

## 两条别再踩回去的线

**① `icon.svg` 不许挂进 `<link rel="icon">`。**
它内嵌的是 192 栅格、没有任何矢量可缩放性。一旦挂上，浏览器会优先取 SVG 再自行缩到 16 px，
把细节缩成灰雾——这正是 2026-08-21 那轮要手绘 32 档的起因。标签页必须走 `icon-32.png`。

**② `icon-32.png` 不许由大稿缩放重生成。**
它是逐像素手画的：线稿整体压淡（最暗 L=59.1）好让铅笔（最暗 L=35.7）成为画面里唯一的深色主体，
构图也换成拉近裁切（刘海+双眼撑满、铅笔斜切）。大稿缩到 32 得到的是完全不同且糊掉的东西。
要改这一档，改 .ora 重新导出，别过缩放管线。

## 加档位要同时改三处（deploy.yml 注释里也写着）

1. `service-worker.js` 的 `STATIC_PRECACHE`
2. `.github/workflows/deploy.yml` 的根目录 asset 拷贝白名单（漏了会静默 404，踩过）
3. `index.html` 的 `<link>` / `manifest.webmanifest` 的 `icons`

## 未做

- **16×16 没有手绘档**：目前由浏览器从 `icon-32.png` 自行缩。真要 1x 屏标签页锐利，
  得另画一张 16（那是另一幅画，不是 32 缩的），user 尚未决定要不要。
