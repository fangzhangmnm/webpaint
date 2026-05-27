# 持久化 + 加密：从 AtlasMaker 抄过来这套

> AtlasMaker 0.5 → 0.7 迭代出一套 IDB-atomic-zip + OneDrive + per-session AES 的持久化模式。WebPaint 同期场景（重度本地编辑 + 多设备 + 网盘）适用相同模式。canonical 文档在 [../../AtlasMaker/docs/persistence-and-encryption.md](../../AtlasMaker/docs/persistence-and-encryption.md)，下面是给 WebPaint 视角的几条关键决策摘要，避免再考古一遍。

## TL;DR（WebPaint 适配版）

1. **一个 .wpaint 文件 = 一次 IDB put**（原子）。**不要**拆 layer-blobs 多 store 多 tx —— refresh 截断会丢半边。
2. **保存策略：Ctrl+S 主导 + 3 分钟兜底 + visibility/pagehide 抢救**。**不要**抄 webxiaoheiwu 的 debounce/heartbeat/trivial-skip —— 那是给文字编辑的，画图工具用户习惯 Blender / Photoshop 模式，自动保存频繁带来不稳定。
3. **OneDrive push / pull 必须用户显式按按钮**，autosave 永不触云。这一条对 WebPaint 尤其重要：画到一半改了几笔自动推上去 → 412 → 自动 sibling-copy → 用户当时不在场 → 整个 work 不可追溯。
4. **本地 autosave 之后状态要明示「云端未同步」**：双独立指示，pill 反映本地，云端按钮上画个脉冲点。
5. **加密走外层明文 zip 包内层 AES-256**（vendor `zip.js`）。WebPaint 也可能涉及 NSFW / 私密素描，per-session 加密是合理需求。
6. **密码绝不持久化**，关 tab 就忘。
7. **document.title 不能放文件名** —— 历史里会重复 + privacy leak。

## 抄什么具体文件 / 模块

| 模块 | 用途 | AtlasMaker 文件 |
|---|---|---|
| `storage.js` | IDB atomic put：one key per session/file | [../../AtlasMaker/src/storage.js](../../AtlasMaker/src/storage.js) |
| `zip.js` | `zip.js` 库的薄包装；直接 / 加密两套 API | [../../AtlasMaker/src/zip.js](../../AtlasMaker/src/zip.js) |
| vendored zip.js | gildas-lormeau/zip.js UMD bundle ~135KB | [../../AtlasMaker/src/vendor/zip-js/zip-full.min.js](../../AtlasMaker/src/vendor/zip-js/zip-full.min.js) |
| `auth.js` | MSAL.js 包装：vendored bundle 懒加载，scope = `Files.ReadWrite.AppFolder + offline_access` | [../../AtlasMaker/src/auth.js](../../AtlasMaker/src/auth.js) |
| `graph.js` | Graph wrapper：`uploadFileToApproot` 含 If-Match / chunked upload；body 接受 TypedArray | [../../AtlasMaker/src/graph.js](../../AtlasMaker/src/graph.js) |
| `cloud.js` | session push/pull 加 sibling-copy on 412 | [../../AtlasMaker/src/cloud.js](../../AtlasMaker/src/cloud.js) |

## WebPaint 特有的需要重新考虑的

- **WebPaint 的单文件 size**：一张 4096×4096 的多 layer PSD-like 文件可能 100MB+。AtlasMaker session 通常 10-50MB，atomic 整包重写还行。WebPaint 100MB+ 每次 Ctrl+S 写整包会卡。
  - **可能要分层 atomic**：每个 layer 一个 IDB key，统一管理。但这就违背了「一个文件 = 一次 atomic 写」原则。需要重新设计 —— 也许 base atlas + 增量 layer，或 worker offload。
  - 或者：layer 数据延迟落盘（保持 dirty），Ctrl+S 时才整包写。
- **WebPaint 内层格式**：要不要兼容 .psd？.atlas.zip 是自定义的，但 PSD 有 OneDrive 缩略图、其它工具兼容性。值得讨论。
- **多设备同步的「劳动」颗粒度**：AtlasMaker 一次 Ctrl+S = 一次完整提交。WebPaint 是不是要支持「自动 push 每 5 分钟一次」给「正在画」的高频场景？需要 user 决定。一旦上「自动 push」就要面对 412 sibling-copy 不在场场景，认真做 UX。

## 关键的「不要这样做」

不要做以下事情，每条都是 AtlasMaker 走过的弯路：

- ❌ **IDB 拆多个 store + 多 tx 写一次保存** —— refresh 在中间截断丢东西
- ❌ **debounce 自动保存** —— Blender 用户原话「don't push 300ms after a stray keystroke」
- ❌ **autosave 触云** —— 用户看不到 412 sibling 发生，sync surprises
- ❌ **encrypted zip 不裹外层** —— 网盘扫描器拒
- ❌ **`@microsoft.graph.conflictBehavior` 放 header** —— `@` 非法
- ❌ **Graph `body` 没 `ArrayBuffer.isView` 检查** —— TypedArray 被 JSON-stringify 10× 膨胀
- ❌ **document.title 放文件名** —— 浏览器历史 confusing + privacy
- ❌ **persist 密码** —— 持久化加密 = 名义加密

完整列表与各项 anti-pattern 解释见 canonical doc。

## 关联

- [pwa-update-detection.md](pwa-update-detection.md) — SW 缓存 + 版本号水印（也是和 AtlasMaker 共用的模式）
- [../../AtlasMaker/docs/persistence-and-encryption.md](../../AtlasMaker/docs/persistence-and-encryption.md) — canonical 文档
