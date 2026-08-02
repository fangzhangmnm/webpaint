# v0.8 recon B · 无地骑士（store 摘除）现状勘探（易过期）

> as-of v0.8.0 / 2026-08-02
> 性质：Explore agent 勘探快照原样 dump + 拷问补充。file:line 会漂——信代码不信本文。
> 索引：`20260802-v08-recon-index-six-knights.md`

## 拷问补充（勘探后的判断，未拍板）

1. **「store ctor 返 null」不是好 practice**——更好的形状已在仓里：null-object / 内存 adapter 注入（app-prefs 的 `face()` 就是 null-object 模式）。app 面对的接口永远非 null，背后没有持久层而已。
2. **「store 代码物理删除仍编译」的极端目标**技术上可达：app 侧只 import 自己定义的窄接口类型 + 组合根一处动态装配。代价 = app 侧养一份接口镜像。样板已存在 = editor-session 的 `StoreLike`。
3. **行为锁**：build.sh 已有分层 lint 先例（scripts/build.sh:77-93）——可加「app 层禁 import store 内部」lint + 「store 缺席 boot smoke」node 测试。
4. **password**：现状政策在 app（crypto-state 永不持久化）、机制在 store（不注入 codec 则 dormant）。user 想把全局 password 收进 store 接口契约给兄弟复用——政策层要不要搬**待拷问**。
5. **mhtml 单文件 release**：esbuild 已单 bundle；风险 = file://或 mhtml 容器下 SW/IDB/GPU 限制。「无 store + 无 SW 仍可画」恰是 B 胜利条件的推论，可行性中偏高，细节待验证。
6. 越狱预警：AI 会说「gallery 要列表所以 boot 必须有 store」（错，watchFolder 已是适配层，空态即可）、「笔刷库必须 collection 否则丢数据」（错，内存 stub 即可）、为「无 store 也解密」在 app 层重造加解密（错，正确答案是 dormant，与 JRP 同构）。

---

## 以下为勘探原文（2026-08-02）

### 1. 耦合面清单

**app-store.ts 接缝**（`src/app-store.ts`，128 行）暴露：`provider`（:18，无 app 侧消费者）、**`store` 整对象裸导出**（:25，最大耦合源）、auth 转发 10 个（:65-74）、`watchFolder`（:96，gallery 列举适配 store.Item→GItem）、`listGalleryTrash`（:115）、`brushRackCollection`（:128）。模块 eval 期副作用：建 provider（:17）、`createStore`（:25）、注入 4 个 settings/state collection（:61-62 wirePreferences/wireAppState）。

**深耦合**（拿 store 对象到处用）：
- `src/ui/gallery.ts:18-21`——**13 处 `_store.`**：rename/tryMove（306,337,358）、复制 save（368）、reupload（381）、encrypt/decrypt（426,441）、delete（467）、deleteFolder（486）、restoreTrash（496）、purgeTrash（515）、emptyTrash（528）、加密 peek 判定（142）。
- `src/session-state.ts:22-23`——5 处：`_file` helper（:86，保存/打开/peek 底座）、checkpoint 密文（257,271）、复制另存（549）、readEncryptedBytes（588-591）；另把 `_store` 当 `StoreLike` 传进 createEditorSession（:613）。
- `src/app.ts:74`——store 进 AppContext（app.ts:324；类型 app-context.ts:113 = `typeof import("./app-store.ts").store`）；直接调用 5 处：isEncrypted（432）、drainOfflineQueue（491,538）、pullIfClean（493,584）。
- `src/gallery-shell.ts:42,200`——6 处：usage（121）、nameOccupied（187,190,417）、newFolder（419）。
- `src/enc-thumbs.ts:5,12`——encFile helper + verifyPassword + tryDecryptEncryptedBlob（60,69），解锁循环底座。

**浅耦合**：cloud-thumbs.ts:22（1 处 getPeek）、session-name.ts:13（nameOccupied）、import-image.ts:260（isEncryptedBlob 嗅探）、save-status.ts:52-53（isSignedIn）、topbar-menu.ts:27（signIn/isAuthConfigured，v415 后不直碰 store）、cloud-auth-ui.ts:16-18（纯 auth）、dev-console.ts:70-73（4 个 debug 命令）。

**type-only**：app-prefs.ts:12、app-state.ts:13、brush-rack-controller.ts:36（`type Collection`）、store-ui.ts:5、session-state.ts:23（`type EncryptedBlob`）。

**已绝缘的好样板**：`src/editor-session/editor-session.ts:28` 自定义结构类型 `StoreLike`（最小面），不 import store；`src/boot-restore.ts` 纯 ports 注入零依赖（:13-26）。

### 2. store.collections 用途考古

现存 5 个 collection（全在 app-store 建）：

| collection | 内容 | 门面 |
|---|---|---|
| `local-user-preference` ({local:true}) | color-theme、menu-tab | src/app-prefs.ts |
| `synced-user-preference` | lang、手势开关、fps、pixel-grid、stylus-smooth-params、gen-ai（app-prefs.ts:15-27） | 同上 |
| `synced-app-state` | current-directory、blender-panel-url、gallery-password-verifier（app-state.ts:16-36） | src/app-state.ts |
| `local-app-state` ({local:true}) | current-file（v438 从 synced 迁入） | 同上 |
| `brush-rack` | 逐 brush 一 item + `.meta` 顺序，seed 自 builtin-brushes.json | src/brush-rack-controller.ts |

**关键发现：4 个 settings/state collection 已是「缺席容忍」设计**——app-prefs/app-state 刻意不 import app-store（app-prefs.ts:6-8、app-state.ts:11），collection 惰性注入；未注入时 getItem 返 DEFAULTS、setItem no-op（app-prefs.ts:56-67 `face()`、app-state.ts:68-71），init 未注入直接 resolve（app-prefs.ts:41、app-state.ts:47）。store 消失 = 设置自动变「只读默认值+写丢弃」内存态，构造期不炸。

**brush-rack 是硬的**：app.ts:74 import brushRackCollection（app-store eval 期就 `store.collection(...)`），app.ts:129 塞进 rack 构造。但 `Collection` 接口很窄（store/collection.ts:68-76：init/setItem/deleteItem/getItem/onChange/flushLocal/reconcileWithRemote 共 7 个），内存 stub 可满足——笔刷逻辑本身（brushes.ts 的 builtinBrushInitData）不依赖 store。

### 3. boot 依赖

- **硬**：app.ts:74 静态 import app-store → app-store.ts:25 模块 eval 期 createStore（含 IDB/localStorage 命名空间、migration 自跑 create-store.ts:215-219）。删 src/store = app-store 编译不过 = 全 app 死。provider 是 eval 安全的（providers/index.ts:2「方法调用时才碰浏览器」，MSAL 懒加载）。
- **TLA 门已死（v409）**：现在是 app.ts:98 `const prefsReady = Promise.all([initPreferences(), initAppState()])`——不再挂起模块，消费方各自 await（app.ts:524-531、:536、boot.ts:40）。lang/theme 首帧走 localStorage boot 快照（src/boot-snapshot.ts:1-35），不经 store。
- store 缺席（app-store 被 stub）时：prefsReady 立即 resolve → fixup 相灌 DEFAULTS → bootRestoreSession 因 currentFile=null 走「停图库」分支（boot-restore.ts:28-40）→ 图库 watchFolder 无货；auth isAuthConfigured false → initAuth 跳过（app.ts:468-476）；rack.load() 失败有 catch（boot.ts:25-31）但 rack 构造期需要 collection 对象存在。

### 4. 绕过 store 的持久化点（centralized hub 收编清单）

| 位置 | API | 用途 |
|---|---|---|
| src/boot-snapshot.ts:28-35 | localStorage（webpaint.boot.theme/lang 两键） | pre-paint 同步读防首帧闪（v409 有意为之，:3-6 注明别删） |
| src/storage.ts:12-40 | app 自有 IDB 库 `webpaint`（与 store 的 webpaint.defaultStore 分开），v4 终态两个 object store | |
| ├ gallery-thumbs（:19,53-96） | IDB | 图库缩略图缓存（加密件存密文 peek）；消费方 cloud-thumb-cache.ts:21,46,55 |
| └ checkpoints（:20,101-127） | IDB | revert 快照（撤销更改），加密件存密文容器；消费方 session-state.ts:248- |
| src/topbar-menu.ts:273-281 | getRegistrations + caches.keys/delete | 「清缓存重载」按钮 |
| src/gallery-shell.ts:124-149 | navigator.storage.estimate() | 只读配额显示 |

**当前编辑文件暂存/灾难恢复**：store 外已无暂存——旧 sessions object store（本地 autosave 层）v415 删除、v4 upgrade 物理 deleteObjectStore（storage.ts:14-18,42-47）。落盘唯一走 store.file + editor-session（autosave 挂 bgJobs，session-state.ts:624-633；崩溃恢复在 store 库内 seal/open）。**store 缺席 = 编辑内容完全无处落地**——正是「只画不落盘」胜利条件的语义。

### 5. store 库内的 WebPaint 幻觉

代码层基本干净（grep webpaint/.ora/brush/thumbnail 命中全是注释/文档举例；collection.ts:42-43 明说「store 内容无关」）。加密容器 `.zip` 默认后缀是库级约定（ADR-0012），app-agnostic。要清的：
- **`src/store/providers/graph.ts:2` 注释写「AppFolder 沙盒 = Apps/AtlasMaker/」**——app 名都是错的（实际 approot 由 clientId 决定），陈腐注释。
- 十几处以 WebPaint 为例的注释（cloud-sync.ts:6,46、create-store.ts 多处、collection.ts:179-180,234,245「笔架/动了笔/builtin-brushes.json」、freshness.ts:95）——不影响编译，属「库文档 app 视角渗漏」。

### 6. 全局 password 现状

架构 = **app 层持密码政策，store 层非交互加解密**：
- 政策/内存态：src/crypto-state.ts——统一图库密码 `_password` + 导入件 per-name 覆盖 `_perName`（:14-15），**永不持久化**（:7）；`getPassword(name)` 是给 store 的唯一 seam（:38-41）；onPasswordVerified 决定上位全局还是记 per-name（:43-48）。
- 注入点：app-store.ts:34-39——crypto codec（zipPack/unpack、pack7z/unpack7z）+ crypt（ext/makePeek/getPassword）；**不注入则库内加密 dormant**（create-store.ts:146 注释，JRP 即如此）。
- 验证器（跨设备「图库已有密码」标记）：src/password-verifier.ts——app 层独立实现（PBKDF2×250k + AES-GCM sentinel，:16-18），存 synced-app-state 的 gallery-password-verifier（app-state.ts:30,83-84），零 store 契约（password-verifier.ts:6-8）。
- 解锁循环：src/enc-thumbs.ts:31-48 ensureUnlocked（store.verifyPassword 解 peek 验证）；导入外来密文 unlockImportedContainer（:57-71）。
- per-file 操作：`_store.file(...).encrypt()/decrypt()`（ui/gallery.ts:426,441）；语义 = 「统一图库密码 + 导入件例外」，不是真 per-file 密码。

### 总量结论

值级 import app-store 的文件 12 个（深 5：ui/gallery、session-state、app.ts、gallery-shell、enc-thumbs；浅 7）；type-only 5 处。store 对象扩散三通道：直接 import、AppContext.store、editor-session 的 StoreLike 注入（唯一已窄化）。最省力切口已存在一半：prefs/app-state 惰性注入 + DEFAULTS 回落、StoreLike、boot-restore ports——缺的是 brush-rack 内存 Collection、AppContext.store 与 ui/gallery 裸 `_store` 收敛成窄接口、auth/加密面 dormant 化。
