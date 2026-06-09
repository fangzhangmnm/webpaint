# Gallery + sync/auth state 重写（施工图）

> 给下一个 AI / 我自己。真机测出的 UI bug 全是同一个病根，gallery 推倒重来。
> 架构 review：`docs/reports/20260604-gallery-state-architecture-review.html`。
> spec 参照（只读）：MyPWAPatterns/docs（MASTER / share-file-model / gallery-ux / context-cue）。**别改那边**，WebPaint 的写这里。

## 病根（一句话）

**auth / sync 状态散在 god file，没有可观察的源，UI 靠散落手 poke → 漂移。**
真机症状全是它：登录成功按钮不变蓝、token 过期仍假装已登录（F2）、save 图标"本地 vs 云"不准、云端画漏显、名字冲突没 detect。不是单点 bug，是缺 seam。

> **病根澄清（user 2026-06-04）**：「名字冲突没 detect」**不是缺 collision 检查**——是**假登录**（F2）把本地文件当成了云端文件来显示，叠加**离线时新建了同名文件**，于是 UI 看着像云端重名。**候选1+2 治的就是那个假登录根**，所以这条已随 1+2 解。**值得注意：即便状态混乱，两份同名文件没有互相覆盖**——store 红线（GUID-by-path / backup-before-overwrite）扛住了数据安全。新建走 `yyyymmdd-N` 自动避让（本地+云都查）后，同名本身也不再轻易发生。

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

### ✅ 候选3：gallery 重做（已做，原地重写非独立 module —— user 说「重做 ui」非「抽 module」；smart-save 抽 module 才是 optional）

**user 拍板的三个架构岔路（2026-06-04）**：
1. **空文件夹 = 云端真文件夹为准**。删掉 localStorage `explicitFolders` 旁路（就是「半残文件夹」，和真 fs 漂移）。
   空文件夹 = OneDrive 上 `ensureSubfolder` 建的真文件夹，lib 新增 `cloud.listAll()/listFolders()`（一次 walk 带回含空文件夹，排 `.trash`/`.backup`）带回。
   代价：未登录/离线建不了纯本地空文件夹（无处持久化）；删最后一个文件后云端父文件夹仍在 → 空文件夹自然保留。
2. **本遍只做 card view，做深做对**；list view 留给以后（画图 app card 天然，list 是 pdf/txt 文档类的形态）。**没做 card/list 切换。**
3. **不做拖拽**（iPad 触屏 drag-drop 不可靠，spec 也把触屏批选标 TBD）→ **卡片菜单加「移动到…」**：lockSyncGate 复用成 folder picker，移动 = 跨文件夹 rename（云端服务端 move 保 itemId/etag，无副本；身份 = path/name，GUID 方案 2026-06-07 已回滚，见 sync-identity-decision-2026-06-07.md）。

**另交付**：新建命名 `yyyymmdd / -2 / -3`（替「未命名」，避让本地+云重名）；gallery footer + 菜单显**版本号**；gallery header 加**菜单**（强制更新 + 主题，动作代理到主菜单 handler，不重复状态）。

**未做（留以后）**：list view、ls 慢（等 virtual-fs）、真正抽独立 gallery module、smart-save 深模块、候选4 单一 ConflictSheet。

<details><summary>原候选3 设想（部分已被上面取代）</summary>

#### gallery 推倒成 store.list 之上的深模块
- 现状：app.js 4572–5750 ≈1200 行浅而宽缠绕（云/本地列表 + thumb + 文件夹(explicitFolders localStorage 旁路) + 冲突 + DOM + trash），状态全在局部 let。
- 目标深模块：
  - **数据**只从 `store.cloud.list()` / `store.cloud.listTrash()`（lib 真相，带 path/name/folder）+ 本地 `store.local` 列表，**在 store 层 merge**（治"云端画漏显"——现在 merge 缺口在 god file）。
  - **视图**层：card vs list 策略（你要的）。
  - **文件夹**从 path 派生树（不是 explicitFolders localStorage 旁路）。
  - **重名**走 store 一处检查（治"名字冲突没 detect"）。
  - 订阅 `wp:auth-changed` / sync 事件 / changed → 重渲。
- 旧 1200 行**删**（toxic）。

</details>

### ⏳ 候选4：一个 conflict-sheet 接缝（spec §192）
- 现状：open-gate / push-412 / brush-rack / 新建重名 各自一套。
- 目标：一个 ConflictSheet（按 user-action-time 显两边 + 预览 + shape-appropriate 按钮），全复用。重名也走它 → detect 到。

## v174 真机回归（user 2026-06-04 测，**未修** —— user 要先整理重构再测，别 patch）

下个 thread 接手。按 user：「先重构整理好再测，不然浪费时间。」别零敲碎打。

| # | 症状 | 初判病根（待重构 thread 确认） |
|---|---|---|
| 1 | **空文件夹删不掉** | 删走 `getItemByPath(folderPath)`→`deleteItem`。可能 path 解析/缓存或 OneDrive 空文件夹 id 取不到；或 `hasItems` 误判非空（含子文件夹判断 `_galleryCloudFolders.some(startsWith)` 可能把自己算进去？）。要查。 |
| 2 | 移动到… ✅ 能用 | — |
| 3 | 多机冲突 | user 自己看，先挂。 |
| 4 | **图库菜单 z-order 又错** | **根因确诊**：项目里两个弹窗 helper —— `openAnchoredPopup`（设 z=200）vs `anchorPopupToBtn`（**不设 z-index**）。gallery 菜单/加号/云账号都用 `anchorPopupToBtn` → 不在受控 z 层。**重构 UI 库时统一成一个 owned top-layer（`<dialog>`/portal + 单 stacking context），新弹窗零配置自动对，断这个反复病。** user 已认可这是正解。 |
| 5 | **上传的文件在另一台电脑看是 0B** | ⚠ 数据红线。push 上传 → 另一端 list/download 看 0B。疑：chunked-upload 收尾（H7 路径）或 etag/content 落地不一致；或 thumb byte-range 把主文件读空？**重点查 cloud-sync.push + onedrive-provider upload 收尾。** |
| 6 | **两文件同时编辑仍不报冲突** | ⚠ 多 tab/多机并发编辑静默覆盖。C4 base-etag 在「**同名同文件**」并发已修；这条是**两个不同文件**同时编辑互不报——可能不是冲突语义问题而是同步覆盖。要复现确认到底指什么。 |

5/6 是 sync 红线级，别只当 UI bug。参照 MyPWAPatterns/docs/potential-bugs.md + sync-design.md。

## 纪律

- 不留恋旧 gallery 代码（有毒）。重写，不 patch。
- 静态验：build + lib/WebPaint test。浏览器/iOS/MSAL 我 node 测不了，但**不把不确定性转嫁给人测**——薄壳写到一眼能看对，逻辑进被测模块。
- 做完 1+2+3+4 再整体真机一次。
