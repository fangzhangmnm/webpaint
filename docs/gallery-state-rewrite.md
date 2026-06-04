# Gallery + sync/auth state 重写（施工图）

> 给下一个 AI / 我自己。真机测出的 UI bug 全是同一个病根，gallery 推倒重来。
> 架构 review：`docs/reports/20260604-gallery-state-architecture-review.html`。
> spec 参照（只读）：MyPWAPatterns/docs（MASTER / share-file-model / gallery-ux / context-cue）。**别改那边**，WebPaint 的写这里。

## 病根（一句话）

**auth / sync 状态散在 god file，没有可观察的源，UI 靠散落手 poke → 漂移。**
真机症状全是它：登录成功按钮不变蓝、token 过期仍假装已登录（F2）、save 图标"本地 vs 云"不准、云端画漏显、名字冲突没 detect。不是单点 bug，是缺 seam。

## 4 候选（顺序：1+2 是 3 的地基）

### ✅ 候选1：auth 可观察 seam（已做）
- lib `providers/auth.js`：单一源 = `activeAccount`；**每个**转变（登录 redirect 回来 / 后台 silent / 登出 / getToken 过期）都 `_emitAuth()` → fire `wp:auth-changed` + 调 `onAuthChanged` 订阅者。
- `getToken` 过期：**先清 activeAccount + 通知**再重定向（治 F2 假登录）。
- app.js：一个 `wp:auth-changed` 监听 → `updateCloudAuthUI` + `updateSaveStatus` + 云列表重渲。**按钮永不漂移、不再靠 9 个散落 poke。**
- 导出 `auth.onAuthChanged(cb)` / `auth.getAuthState()`（lib 级 pattern，见 sync-store README）。

### ✅ 候选2：sync 可观察 seam（已做）
- `computeSaveState` 改用 `_store.cloud.status(name, {signedIn, hasLocal})` 单一源（取代 ad-hoc `isSignedIn() && isCloudDirty()`）。transient（_docDirty/_cloudPushing/_docSaving）仍 app 态。
- `wp:auth-changed` 也刷 `updateSaveStatus`（auth 影响 save 图标）。
- = 你要的 smart-save-icon 的干净数据源。

### ⏳ 候选3：gallery 推倒成 store.list 之上的深模块（下一步，主菜）
- 现状：app.js 4572–5750 ≈1200 行浅而宽缠绕（云/本地列表 + thumb + 文件夹(explicitFolders localStorage 旁路) + 冲突 + DOM + trash），状态全在局部 let。
- 目标深模块：
  - **数据**只从 `store.cloud.list()` / `store.cloud.listTrash()`（lib 真相，带 path/name/folder）+ 本地 `store.local` 列表，**在 store 层 merge**（治"云端画漏显"——现在 merge 缺口在 god file）。
  - **视图**层：card vs list 策略（你要的）。
  - **文件夹**从 path 派生树（不是 explicitFolders localStorage 旁路）。
  - **重名**走 store 一处检查（治"名字冲突没 detect"）。
  - 订阅 `wp:auth-changed` / sync 事件 / changed → 重渲。
- 旧 1200 行**删**（toxic）。

### ⏳ 候选4：一个 conflict-sheet 接缝（spec §192）
- 现状：open-gate / push-412 / brush-rack / 新建重名 各自一套。
- 目标：一个 ConflictSheet（按 user-action-time 显两边 + 预览 + shape-appropriate 按钮），全复用。重名也走它 → detect 到。

## 纪律

- 不留恋旧 gallery 代码（有毒）。重写，不 patch。
- 静态验：build + lib/WebPaint test。浏览器/iOS/MSAL 我 node 测不了，但**不把不确定性转嫁给人测**——薄壳写到一眼能看对，逻辑进被测模块。
- 做完 1+2+3+4 再整体真机一次。
