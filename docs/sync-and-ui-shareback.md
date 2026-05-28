# 同步策略 + UI 设计 shareback —— 给 AtlasMaker 的同事

WebPaint 在 v45-v55 期间把云同步 / 保存按钮 / 重命名 / 全屏图库 这套东西
重写了几轮，跑顺了。这份文档给 AtlasMaker（兄弟项目）的同事看，可以原样抄、
也可以挑着抄。**不是规范、是经验**。

> 相关 doc：[persistence-and-encryption-shareback.md](persistence-and-encryption-shareback.md)（更早一版的核心思想，仍然有效）

---

## 1. 云同步策略：**只 push，不 pull**

**WebPaint 的默认行为**：
- 本地 IDB 是 source of truth（用户当前编辑场景）
- 云端是 **backup + 跨设备搬运通道**，不是 source of truth
- **没有"自动 pull"**：app 启动时只读本地 IDB，不偷偷从云覆盖本地
- 用户在图库里手动点云端 tile → "拉取" → 从云下载并 duplicate 成本地 session

**为什么不 pull？**
- 自动 pull 等于在用户没看 UI 时悄悄改本地。如果两边都改过 → 哪个赢都是错误（要么丢本地半小时工作，要么丢云端工作）
- 拉云端的语义只有用户能决定。让 UI 显示"这里有云端版本"+"你要不要拉"，把决策交给用户
- 跨设备的同步路径变成：**A 设备 push → B 设备图库里看到 → B 手动拉取**。慢，但永远不丢

**冲突处理**（412 If-Match）：
- push 失败 → 不要自动覆盖云。inline 弹改名 sheet，用户输入新名后续推一次
- 不要弹系统 confirm/alert（iPad PWA 全屏环境下系统对话框观感很糟）

## 2. 智能保存按钮：4 态

Top bar 一颗按钮，根据状态切图标 + 标题：

| state           | 触发条件                        | 图标       | 点击行为            |
| ---             | ---                             | ---        | ---                 |
| `saving`        | 正在写 IDB                      | disk dim   | no-op               |
| `cloud-busy`    | 正在 push 云端                   | cloud + 旋转弧（CSS animation） | no-op |
| `dirty`         | 本地未存                        | disk + 角点点 | save + push 一把梭 |
| `cloud-dirty`   | 本地已存、云端未同步              | upload 箭头 | push                |
| `synced`        | 本地+云都同步                    | cloud-check 灰 | no-op (or 顺手再 push) |
| `local-only`    | 未登录云端 / 未配置                | disk gray | save (no-op if clean) |

**关键决定**：
- "save" 永远是 `local + cloud` 一把梭。用户显式 consent（点击或 Ctrl+S）= 把这张图送到最安全的地方
- 不要让用户为了"上传"再点一次。Procreate 的用户也不分这俩
- 自动保存（visibility/pagehide/3min 兜底）**只写 IDB**，不触云。云推必须显式

## 3. 快捷键

| 键             | 行为                          |
| ---            | ---                           |
| `Ctrl+S`       | 完整保存（IDB + 云推）         |
| `Ctrl+Shift+S` | 只存本地（不推云）              |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo       |
| `Ctrl+Y`       | redo（别名）                    |

**save coalesce**：用户连按 Ctrl+S 时不并行串 N 次。规则：
- 当前没在跑 → 立刻跑
- 当前在跑 + 中间没新编辑 + 同类型 → no-op（state 没变，省一次空转）
- 当前在跑 + 中间真有新编辑了 → queue 一个 pending，in-flight 完成后跑
- in-flight `local` + 用户按 push → queue push（云端还没覆盖）
- pending 升级规则：push 覆盖 local；再多按几次也只一个尾巴

用 `_editVersion` 当游标（任何 `wp:histchange` 触发递增），save start 时记下 `_inFlightStartVersion`，比较两值判断中间有没有新编辑。

## 4. 重命名（"phantom current path" 教训）

**WebPaint v45-v55 的重命名 UI**：
- 汉堡菜单 → "重命名当前画作…"（画画界面也能调，**不**只在图库里）
- 弹 in-app input sheet
- **本地同名检查**：listSessions().map(name)，已有 → 提示"换一个"
- 重命名 = "saveSession 到新名 + removeSession 旧名"
- **云冲突时自动调起重命名**：push 收到 412 → inline 弹 rename sheet → 用户输入新名 → setCloudDirty(新名, true) → queueSave("push") 续推

**关键安全约束**（来自 AtlasMaker 0.7.2 事故）：
- 重命名走 "rename = save-new + delete-old" 路径时，**delete-old 用的 oldName 必须是 "actually-loaded" 的真名**，不是 localStorage 里的 `currentPath`
- WebPaint 的做法：`_activeSessionName` 这个内存变量只在 boot 成功 load / 用户主动 open / new / save-as 时才升级到真名；boot 失败保持安全默认 "未命名"

## 5. 全屏图库（"full screen folder"）

**布局**：
```
+----------------------------------------------------------+
| ←    图库                     [云图标] [刷新] [+]        |
+----------------------------------------------------------+
| [tile] [tile] [tile] [tile]                              |
| [tile] [tile] [tile] [tile]                              |
+----------------------------------------------------------+
| 本地占用：24.3 MB（5 件）   点 tile 上「卸载本地」可清单幅 |
+----------------------------------------------------------+
```

### 5.1 进出图库

| 触发 | 行为 |
|---|---|
| 汉堡菜单「图库」 | 进入 |
| 左上 ← 返回 | 退出，回到当前 active doc |
| 点 active tile | 退出（同 ← 返回） |
| 点别的 tile | 切到该 session 作为 active doc，退出 |
| 加号 → 新建 / 导入照片 | 创建新 doc 作为 active，退出 |
| 进 / 退图库 | **都自动 saveNow**（保险落盘当前 active） |
| 进图库后 | 主画布 / 顶栏 / 浮动面板 / HUD 全 hide（`body[data-mode="gallery"]` CSS）。canvas display:none 后没法误画 |

### 5.2 Header 右上三个 icon button

| icon | 单击 | 状态 |
|---|---|---|
| 云图标 | 弹账号 popup（账号信息 + 登录 / 退出） | 按登录状态变色：灰=未登录/未配置/离线，蓝勾=已登录 |
| 刷新 (↻) | 重渲染 gallery list（拿一次最新云列表） | 仅"已登录 + 在线"时显示。离线 → 在线后第一次按还会 silent re-auth |
| 加号 (+) | popup：新建作品 / 导入照片 | 见 §6 |

### 5.3 Tile 状态 + 按钮

每个 tile 的 metadata 行显一个状态标签：

| 标签 | 含义 | 出现的按钮 |
|---|---|---|
| `本地` | 仅本地 IDB（未配 / 未登录云端） | 删除 |
| `本地+云` | 本地有 + 云上有（同名 = 同一作品） | 卸载本地 · 删除（本地+云） |
| `纯云端` | 仅云上，本地没有 | 拉取 · 删除（云） |
| `未上传` | 本地有 + 已登录但云上没有 | 推送 · 删除 |

每个动作的精确语义：

- **点 tile（非按钮区）**：
  - active tile → 退出 gallery
  - 别的 tile + 本地有 → 切走 active 到该 session
  - 别的 tile + 纯云端 → 走"拉取"路径（同下面，**不**切走 active）
- **推送**：`encodeDocToOra(loaded_session)` + pushSession。**只动这一幅**的云端，不影响当前 active doc
- **拉取**：从云下载 + 解码 + 写本地 IDB（自动唯一名避撞）。**不切走 active doc**，user 留在 gallery，tile 变成 "本地+云"。要打开它就再点一下 tile 走切换路径（user 反馈：拉取不应跳进画布）
- **卸载本地**：删本地 IDB 那条，云端保留。tile 退化为 "纯云端"，可走 "拉取" 恢复。**不能卸载 active session**（删了内存里那份就没回家路径了）
- **删除（云）/ 删除（本地+云）/ 删除（仅本地）**：弹 sheet 确认（in-app，不用系统 confirm）。文字精确说明删了哪里。删除不可撤销

### 5.4 底栏

| 段 | 内容 | 注意 |
|---|---|---|
| 占用 | `本地占用：X MB（N 件）` | 用 `listSessions().sum(size)` 算，**不**走 `storage.estimate().usage`（混入 SW 预缓存几 MB 虚高） |
| 浏览器配额 | 不主显 | iOS 给到 36GB 数字唬人。放在占用文本的 `title` tooltip 里给好奇用户 |
| 提示 | "点 tile 上「卸载本地」可清单幅"（灰色细字） | 引导用户找精细化清理而非"清扫本地缓存"按钮（已删） |

### 5.5 设计决定

- **有返回键**（v50 → v56 → v56 改回）。最初按 picker-only 模型砍掉，但新用户 / iPad 多任务切回找不到出路。左上单图标低成本
- **没有"正在编辑：xxx"指示**。current tile 自带高亮足够；多一个标题栏 input 占地方又触发 phantom path 风险
- **Tile 状态标签** = 4 个互斥状态，**不**显示 mime / size / 太多元数据
- **拉取 = 写本地不切 active**（v59 改）。原来设计成"切走 active"会丢用户当前画作位置；现在 user 留在 gallery 看到 tile 变化，要打开就主动点

**z-index 排查约定**（项目 styles.css 顶部）：
```
10  top-bar / HUD
15  浮动面板（图层 / 笔刷 / 液化 / 参考 / 色板）
20  常规 menu-panel（汉堡 / 调整 / 图层 ⋯）
30  toast
50  gallery-full（全屏模态）
55  gallery 内部 popup（加号 / 云端账号）—— 必须 > 50
60  backdrop（sheet 背后蒙层）
61  sheet（关键确认）
```

如果 gallery 内有 menu-panel 类的 popup → **一定要给它单独的 z-index > 50**，否则被全屏 gallery 盖住。WebPaint v53 修过这个 bug。

## 6. 加号 menu

Topbar 右侧 `+` 按钮 → popup：
- 新建作品…（弹 sheet：名字 + 分辨率预设 1024/2048/4096/自定义）
- 导入照片…（用照片当新 doc 打底；不是"叠到当前层"）

**避免**：把"新建"和"另存为"混在一起。它们语义不一样：
- 新建 = 切走当前，开新空 doc
- 另存为 = 把当前内容复制到新名，**仍在编辑当前**

WebPaint v50 之前有"保存副本…"做后者，被简化掉了（用得少）。AtlasMaker 如果用户群有"复制改一改"的需求可以保留。

## 7. iPad PWA 特殊处理

下面这些是真实在 WebPaint 上踩过的坑，AtlasMaker 应该都会遇到：

### 7.1 SW 注册（v58 教训：必读）

- **register 写模块顶层，不要塞 `window.load`**。app.js 用 dynamic `import()` 加载时
  load event 经常早就 fire 完了 → `addEventListener("load", ...)` 永远不触发 → SW 根本没注册
  → iPad PWA 加主屏后断网"找不到服务器"。详见 [pwa-update-detection.md §0](pwa-update-detection.md)
- iPad 加到主屏 PWA 模式下 `navigator.serviceWorker.getRegistration()` 偶尔返 undefined
- 拿到 boot 时 `register()` 返的 registration 存进模块级变量（`_swRegistration`），"检测更新"菜单项用这个变量直接 `reg.update()`，不要走 `getRegistration()`
- **手动"检测更新"菜单项必须有**。自动检测都是异步隐式，user 主动确认时没出口
- **检测更新返回带版本号**："已是最新（vNN-YYYY-MM-DD）" 比 "已是最新" 信息量大十倍

### 7.1.1 离线 → 在线后的 silent auth retry（v59 加）

**坑**：MSAL 的 `activeAccount` 只在 boot 时 `acquireTokenSilent` 成功才设上。如果 boot
时离线（飞机模式 / 火车隧道 / iOS 后台休眠 wifi 没接上），silent 抛错 → activeAccount
永远是 null → 后面 wifi 回来 `isSignedIn()` 还是 false → 图库的"刷新"按钮按了也没用。

**修**：在 auth.js 暴露一个 `retrySilentSignIn()` 函数（不复用 initPromise，直接重试），
在 (a) `online` 事件 (b) 图库刷新按钮点击时调用：

```js
// auth.js
export async function retrySilentSignIn() {
  if (activeAccount) return true;
  if (!isAuthConfigured() || !pca) return false;
  const cached = pca.getAllAccounts();
  if (cached.length === 0) return false;
  try {
    await pca.acquireTokenSilent({ scopes: SCOPES, account: cached[0] });
    pca.setActiveAccount(cached[0]);
    activeAccount = cached[0];
    return true;
  } catch (_) {
    return false;
  }
}

// app.js
window.addEventListener("online", async () => {
  if (!isSignedIn()) await retrySilentSignIn();
  updateCloudAuthUI();
  if (galleryIsOpen) renderGallery();
});

cloudRefreshBtn.addEventListener("click", async () => {
  if (!isSignedIn() && navigator.onLine !== false) {
    await retrySilentSignIn();
    updateCloudAuthUI();
  }
  renderGallery();
});
```

### 7.2 visualViewport

- iOS Safari URL bar / 状态栏推送 → 不一定触发 window resize event
- 后果：canvas 内部 pixel buffer 是旧尺寸，被 CSS 拉伸到新 viewport → 渲染像素和 clientX/Y 错位（笔触和光标偏移几 px）
- 修：
  - `window.visualViewport.addEventListener("resize", resize)` 和 `"scroll"`
  - `ResizeObserver` 观察 canvas 元素本身的 CSS 尺寸变化
  - 双保险

### 7.3 Ghost pointer

- iOS 偶尔丢 `pointerup`（PalmRejection 抢断 / 系统手势 / app 切换）
- 后果：ghost pointer 留在 pointer map 里 → 单指 → 误判成双指 gesture → 画布持续旋转
- 修：
  - pointer record 加 `lastUpdateTs`；`pointermove` 持续更新
  - `pointerdown` 入口先 purge stale（>1.5s 没事件的 touch 视作丢失 up 的 ghost）
  - 笔尖 down 时额外 purge **所有** touch（即使没到 stale 阈值；笔在画 = 手指肯定是掌触）

### 7.4 系统对话框

- 不要用 `alert` / `prompt` / `confirm`
- 全屏 PWA 上系统对话框观感很糟；用 in-app sheet + backdrop（z-index 60/61）
- sheet 要支持 input（rename / new name）和 confirm（delete）两种形态

### 7.5 emoji icon

- 不要用 emoji 当 UI 按钮（📁 📷 ⤢ ⚠ 等）
- 不同 iOS 版本 / 字体配置渲染不一致；浏览器 zoom 也奇怪
- 自己画 SVG。约定：`viewBox="0 0 24 24"` `fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`

---

## 8. 误报 / 调试经验：IDB 在隐私窗口被静默禁

**真实事故**（WebPaint v57 排查）：

user 报告"离线模式下图库无法使用"。AI 工程师（我）的第一反应是诊断离线降级路径
（云调用没 catch / activeAccount 在 token 过期时 stuck），开始往 renderGallery 各处糊
try/catch，写一堆"防御代码"。

跑到一半 user 自己想到："会不会是因为匿名模式下没法用 idb 导致的，是误报？"

**真因**就是这个。iOS Safari 隐私窗口：
- 老版本（< Safari 14）：indexedDB.open 直接抛 SecurityError
- 新版本：允许 open，但配额极小（几 MB） + 关 tab 即清；写大 blob 时静默失败 / 抛
  QuotaExceededError

user 测试的"离线模式"其实是 Safari 隐私窗口。listSessions 抛错 → renderGallery 静默
死在 await → 用户看到空白图库。

跟离线一点关系没有。

### 教训
- **不要照"用户描述的现象"想象 root cause**。"离线"在用户语义里 ≠ "navigator.onLine=false"
- **少糊 try/catch**。原代码绝大多数 try/catch 是 cargo cult；只有 listSessions 这一处真有
  必要（因为它的错对用户行为有可见后果）
- **静默失败 = 最大的坑**。每一条用户路径出错都要落到状态行 / UI 上，让用户能反馈
- **隐私 / 匿名模式 ≠ 离线模式 ≠ 未登录**。这三个状态都会让"云功能不可用"，但 root cause
  完全不同，UI 提示也该不同
- **navigator.onLine** 在 iOS Safari 不是 100% 可信。`false` 几乎确定离线，但 `true` 不一定真
  在线（DNS 走通但 server 不可达也 true）。所以 only 用 `=== false` 当 fast-path
- **debug 路径**：让用户自己提一个可能性比工程师猜 5 个先。AI 容易在猜测上 spiral

### 最终修法（最小集）
1. `listSessions` 加 try/catch + 状态行明确报错（含"可能是隐私窗口 / IDB 被禁"提示）
2. 区分 UI：`isSignedIn() && navigator.onLine === false` → 显"云端：离线"，藏登录 / 刷新按钮
3. saveAndPush 离线时跳过云推（不弹 "推送失败"，地铁里不友好）

没加：boot 时 IDB 健康探针。理由：第一次 setMeta 失败已经能传到 UI；探针只是早一点，
overhead 不值

### AtlasMaker 抄什么
- listSessions / 任何 IDB 操作的入口都套 try/catch + UI 状态条
- 在线 / 离线 / 未登录 / IDB-blocked 四态独立做 UI 提示，不要混
- 用户报"X 不能用"时，先问"什么浏览器 / 隐私窗口吗 / 在线吗"，再动手改代码

---

## 9. 不想抄的东西（WebPaint 特定）

下面这些是 WebPaint 自己的特殊需求，AtlasMaker 不一定要做：
- 棋盘透明背景显示（绘画 app 特有；AtlasMaker 不需要）
- 参考小窗（绘画 app 特有）
- liquify / lasso（绘画 app 特有）
- 笔刷平滑四件套

---

## 改动历史

- v45 (2026-05-28): save 语义重写（local + push 一把梭）+ 系统对话框替换 + 图层 ⋯ 菜单
- v46-v48: 液化 + adjustments popup（不在本 doc 范围）
- v49: 参考小窗（不在本 doc 范围）
- v50: 图库 UI 重做（无返回键 / 加号 popup / 云图标 / 底栏 IDB）
- v51: PSD 导出（不在本 doc 范围）
- v52: save coalesce + reference 实时镜像 + 一票 emoji → SVG
- v53: z-order 修 + 按画卸载本地
- v54: 笔触偏移修 + ghost finger 防误触 + ref 持久化进 .ora（webpaint/ namespace）
- v55: 重命名画画界面入口 + 云冲突 inline 重命名续推 + Lasso phase 1
- v57: lasso 4 模式 gizmo + UX 重构（selected vs transforming）+ 离线 / 隐私模式 IDB 误报教训
