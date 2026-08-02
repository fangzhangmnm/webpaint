# v0.8 recon E · 五兄弟 gallery 对比（骑士抽卡）（易过期）

> as-of 2026-08-02（各 repo 现状实测；WebPaint v0.8.0）
> 性质：Explore agent 勘探快照原样 dump + 拷问补充。file:line 会漂——信代码不信本文。
> ⚠ 含一条**记忆更正**：BgRadio「不用 store paradigm 的 ADR」不存在（详 §2）。
> 索引：`20260802-v08-recon-index-six-knights.md`

> ➜ 2026-08-02 稍晚：分发机制（下方补充 4 / §4 / 拍板项 5 的主题）已单独科普并列出选项谱系——见 `20260802-v08-lib-distribution-grill.md`（流派未选定，E 开工前从建议阶梯选档）。

## 拷问补充

1. **开工前第一拍板项 = 列举接口分歧**：WebPaint watchFolder 单夹订阅（红线「绝不全库 list」）vs JRP listAllItems 全树。勘探建议（未拍板）：库只吃「当前夹快照 + folders」，宿主适配；BgRadio 的 live-passthrough（user 定的禁 listing 缓存）也能塞进这形状。
2. **底盘不用从零设计**：JRP 组件（零 store、19 emit 意图）+ user 签字的五层窄接口 epic（JRP docs/20260623-folder-panel-epic.md:12-23）+ WebPaint ThumbCell/thumb-cache（app 特异只 2 个 config 参数）。
3. **WebPaint 侧抽库前必斩**：gallery.ts 绕过 GalleryHost 直调 session.* 7 处 + session-state 反向直调 gallery.refresh() 3 处（双向依赖）；gallery-model.ts 死码清理。
4. **分发机制先补课**（对 user 问的「库管理/版本 pinning best practice」最重要）：sync-store 的「byte-identical」实际是「一次性 fork 戳 + 手动 merge 承诺」，6 周漂成 32 文件全 differ——gallery 库至少要 GALLERY_LIB_VERSION 常量 + FORK-BASE 戳 + diff -rq 级对账脚本。
5. 五家都没有多选/搜索/排序 UI——库 v1 别顺手加（家族 spec 想要多选但零实现，JRP 排序是回归债单算）。
6. 顺带发现红线违规：BgRadio app.js:731 系统 confirm()（家族硬规则禁系统对话框）。

---

## 以下为勘探原文（2026-08-02）

### 1. 各家 gallery 现状

**WebPaint（20260524 WebPaint）— 最重最成熟，Vue 卡片图库**
- 规模 ≈1545 行 app 层本体 + 缩略图子系统 358 行 + i18n 153 键 + CSS ~250 行：src/ui/gallery.ts（682 行，Vue 字符串 template；ThumbCell :81-166 + Gallery :168-636 + mountGallery :667-682）、src/gallery-shell.ts（424 行命令式 DOM 全屏外壳）、src/ui/gallery-view-model.ts（168 行纯展示派生）、src/gallery-path.ts（16 行）、src/app-store.ts（128 行数据接缝）。
- 导航：无树，「网盘式单夹+面包屑」（gallery.ts:174,235,283；面包屑 gallery-view-model.ts:103-114）。红线：**唯一列举面 = watchFolder(当前夹)，绝不全库 list**（app-store.ts:111-112、store/create-store.ts:724）。
- 缩略图：ThumbCell 四级 fallback（本地 Blob → 本地加密 peek → IntersectionObserver 懒加载云端 byte-range → 首字占位，gallery.ts:126-150）；IDB 缓存带 token 新鲜度戳（cloud-thumb-cache.ts:75-93）；ORA 域知识只有两行（Thumbnails/thumbnail.png + 尾窗 80KB，cloud-thumbs.ts:13-14）。
- badge：store 9 值 SyncState（store/listing.ts:19-28）→ app 降维 6 种 BadgeKind（app-store.ts:81-93 + gallery-view-model.ts:60-98，两跳=历史包袱）+ 第 7 态加密锁（gallery.ts:204-211）。badgeTitle 硬编码中文未走 i18n（gallery-view-model.ts:69-80）。
- trash：files/trash 视图切换（:173），restore/purge/emptyTrash(scope local/cloud/both)（:492-535）；.trash 语义全在 store 内。
- 操作全集：rename/move（tryMove :306/:337）、copy（:352-373）、push/reupload/unload（:375-393）、encrypt/decrypt（:418-446）、delete→trash（:453-477）、删空夹（:479-490）、新建夹（gallery-shell.ts:400-423）。移动=⋯菜单+目标夹 sheet 无拖拽；**无多选/搜索，排序固定**（name 倒序 localeCompare numeric，app-store.ts:106）。
- 耦合点：正式接缝 GalleryHost（10 回调，gallery.ts:59-73，实现 app.ts:418-435）很干净；但 **gallery.ts 绕过 host 直调 session.* 7 处**（:34 import；:279/:288/:339/:375/:393/:469/:470），且 session-state.ts:495/517/553 反向直调 gallery.refresh()——**双向依赖是抽库最大刀口**。src/gallery-model.ts（127 行）大半死码（mergeLocalCloud/sliceFolder 被 store 内化，生产只剩 copyTargetName/itemTime）。

**JRP（20260518 JustReadPapers）— 已长成「准共享库」的 Vue 列表**
- 规模 ≈1000 行：src/ui/gallery.ts（231 行 Vue）+ src/gallery-model.ts（84 行纯函数）+ 宿主 src/ui/app.ts ~180 行 handler + src/persistence/index.ts:132-155 数据入口 + CSS 写死 index.html:76-125。
- **接口纪律五家最好**：文件头契约「零 store / 零 persistence / 零 app-specific」（gallery.ts:1-6），props 注入 + **19 个 emit 意图**、宿主执行回灌——共享库种子形状。
- 导航：面包屑钻入式，注释明确否决 expand/collapse 树（gallery.ts:5）；客户端 sliceFolder 切层（gallery-model.ts:50-77）。
- 无缩略图（纯文本行）；badge 架子有 UI 没画：store 8 态 SyncState（store/listing.ts:17-25）带到 GalleryItem.syncState（gallery-model.ts:23）但 UI 只画降级布尔 keptOffline 圆点（gallery.ts:212、index.html:124）。
- trash/backup 同挂载点视图切换（gallery.ts:38,44-45）；inline 改名（:66-75）+ folder-picker 移动（:80-87）；**无排序 UI（旧版有、FEATURES.md:32 标「必还原」未还原=回归债）、无多选/搜索**。
- 耦合全收宿主 app.ts：.pdf 补齐（:111）、PAPERS_FOLDER 前缀（:80,113,128…）、catalog rekey 身份跟随（:84,117,123）、阅读位置（:233）。

**RealHome（20260520 RealHome）— 手搓 DOM 平铺卡片，自有 IDB，非 sync-store**
- src/galleryView.js（278 行，从 app.js 肢解出的深模块）：手搓 createElement，render-token 竞态守卫（:23,30-32）、cached-first 先画 IDB 再 per-provider 异步 append（:43-91）、缩略图三级 fallback（provider URL → IDB blob → 渐变占位，:128-165）、objectURL 生命周期自管（:27,40）。
- **不接线点击**：卡片带 dataset，app.js 事件委托 dispatch（galleryView.js:6-10；app.js:285-299 closest(".world-cache"/...)；装配 app.js:500）。
- 无文件夹导航（OneDrive AppFolder 递归扫描拍平 flat grid）；**无 trash——tombstone（钉在 etag 上）隐藏**（galleryView.js:75-79、worldStore.js:83），删除按钮三态：本地永久删/去缓存/连 OneDrive 删（:232-269）；无重命名/移动/多选/搜索；排序 = lastVisitedAt（:31）。
- badge 自成一套：source（default/onedrive）+ pending（待上传）+ local only + missing upstream（ghost）（:167-196）。
- 持久化 = 自有 IDB（worldStore.js:58-59 DB "realhome" v3，listWorlds :198）+ provider 接缝（providers.js:6-7 {source, list()}，bundled :40 / onedrive :142 → graph.listAppFolderGlbs :148）+ 裸 Graph（onedriveGraph.js 278 行）。grep createStore|listAllItems|watchFolder 零命中——**没接家族 sync-store**（CLAUDE.md 自述「云=只读镜像，LWW 可接受」；memory：sync 编排冻结待新 store）。

**WebXiaoHeiWu（20260516 WebXiaoHeiWu）— 抽屉平铺文档列表，god file**
- Gallery = 抽屉 `<ul id="docList">`（index.html:245），≈300 行嵌在 2801 行 god file src/app.js：renderDocList()（:1435-1571 手搓 DOM 全量重建）、抽屉状态机 openDrawer(view∈{active,trash,settings})（:1352-1425）、trash handlers（:1580-1650）。
- 无文件夹（全平铺）、无缩略图（80 字正文预览 :1501-1518）、badge = CSS ::after 文字角标 ghost/stub/local-only（:1487-1494，styles.css:286-305）+ 加密钥匙（:1478-1483）；有 trash（restore/purge/清空，sync.js:788-871）；无行内重命名（名字由日期+标题派生 :209-235）、无移动/多选/搜索；排序固定（Collator 降序 :1428-1433）。
- **持久化 = 自研三层**（与家族 store 零代码共享）：裸 IDB（db.js:1,99-111 listDocs() 是列表数据源，调用点 app.js:1436）+ 裸 Graph（onedrive.js:13,58）+ 自研 sync 编排 mergeRemoteList()（sync.js:567-680，并发列 4 个云目录与 IDB 对账建 stub）。红线合规度尚可（If-Match/etag 遍布、删除=.trash）但全是手写孤本。

**Background Radio（20260517 Background Radio）— 文件夹浏览器+缓存 pin，只读镜像**
- Gallery = 主界面上半屏 browser（index.html:58-62），≈330 行嵌在 1528 行 god file app.js：**两条完全独立渲染路径**——在线 renderBrowser()（:273-364）/ 离线 renderBrowserFromCache()（:366-420，cache meta 造 fakeItem :398-405）——最明显收敛点。
- 有文件夹导航（browseStack 栈 + [..] 上行 :293-295,:422-433，无面包屑）；badge 不是 sync 是 cache：3 态 pin（empty/cached/pinned :248-272）；无 trash/重命名/移动/多选/搜索；删除仅长按 600ms 删本地缓存（:729-762）。
- ⚠ 红线违规：app.js:731 系统 confirm()。
- 持久化三通道：列表每次裸打 Graph **故意不缓存**（:153-161,:169-183）——user 否决过缓存的原文：docs/20260524-offline-and-cache-tiers.md:195「不要 cache OneDrive folder listing…OneDrive 是 SSOT」、:19「metadata 任何形态都不缓存」；音频 blob = 裸 IDB 两级 cap、pin 免疫 LRU（cache.js:13-15,:111-133）；UI 状态 = 单 localStorage key br.state（app.js:12,:19-38）。

### 2. 和 store 的关系

**JRP 架构报告——找到了，①②已落地、③正是本次任务**：docs/reports/gallery-folder-architecture-20260629.html（395 行，commit fa80d6a）。核心论断「不要一个 gallery 深模块，要三个家」：① residency-aware 列举=store 的活——✅落地为 listAllItems(ctx) 且深化成 8 态 SyncState（store/listing.ts:17-25），localKeys/list/listAll 全废留反漂移警告（create-store.ts:362-369）；② 读者域身份——✅砍哈希、身份=path（ui/app.ts:2-3,221-227，catalog.rekey catalog.ts:88-95）；③ folder-tree UI 范式=唯一真正的「gallery 模块」而它是 UI 不是存储——❌未做，组件仍 JRP 私有、CSS 未随组件走。
**现成共享库 spec**：docs/20260623-folder-panel-epic.md:12-23（user 签字）——五层窄接口表（核心/文件管理/回收箱/同步态/加密 × 谁要）+ 主题化两级 CSS fallback（var(--gal-*, var(--accent))）+「绝不 system confirm」确认流。设计起点。

**关键分叉：JRP 与 WebPaint 的 store 列举面已不同**：JRP store.listAllItems(ctx) 一次性全树、app 每次传 {signedIn, online}（persistence/index.ts:135-142）；WebPaint（更新，网盘模型）唯一列举面 = files.watchFolder(folder, cb)（订阅单夹、本地帧+云端帧同一 cb，create-store.ts:311-320,724），连接态 store 自持；listGallery 全树 2026-07-12 已删（app-store.ts:111）。**共享库开工前必先拍板此分歧**。

**BgRadio「不用 store paradigm 的 ADR」——不存在（考古更正）**：两 repo 均无 adr/ 目录；家族 ADR 集（MyPWAPatterns/docs/adr/0001-0021）grep radio 三处无一豁免。被记混的真实出处是三条约束：① dev/prod split 豁免（非 store）：WebPaint ai-docs/20260529-dev-prod-split.md:9「Background Radio 之类纯读项目可能根本不需要，单分支保持简单」；② user 原话说的是 cache 策略：BgRadio docs/20260524-offline-and-cache-tiers.md:206「音乐跟论文/写作 app 不一样——cache 不是备份，是选择性下载」；③ 家族分类：MyPWAPatterns docs/20260602-share-file-model.md:214「lone no-Workbench case，resolved as read-only streaming」。反向证据：store **已专门为它实现** autoCacheOpenedFile:false（流式消费 app：RealHome glb / BgRadio，WebPaint src/store/README.md:101，⚠ range/streaming 优化仍 TODO）；gallery 共享库原始设想也点了它的名（WebPaint ai-docs/20260530-gallery-cloud-trash-design.md:4-7）。**净结论：文档从未豁免它用 store；给它的三条约束（无 dev/prod、无 Workbench、禁 listing 缓存）是共享库要满足的输入。**

### 3. 共性/分叉功能矩阵

| 功能 | WebPaint | JRP | 小黑屋 | RealHome | BgRadio |
|---|---|---|---|---|---|
| 渲染 | Vue template | Vue template | 手搓 DOM(god file) | 手搓 DOM(深模块) | 手搓 DOM ×2 路径 |
| 文件夹导航 | 单夹+面包屑 | 面包屑钻入 | ✗ 平铺 | ✗ 平铺 | 栈式+[..]无面包屑 |
| 缩略图 | ✓ 四级 fallback+IDB | ✗ | ✗(文本预览) | ✓ 三级 fallback | ✗(封面当背景) |
| sync badge | 9 态→6 badge+锁 | 8 态在数据、UI 画 1 圆点 | ghost/stub/local-only 角标 | 自成一套 4 badge | ✗（cache pin 3 态） |
| trash 视图 | ✓ +scope 清空 | ✓ +backup 视图 | ✓ | ✗（tombstone 隐藏） | ✗ |
| 重命名 | ✓ tryMove | ✓ inline | ✗ | ✗ | ✗ |
| 移动 | ✓ picker sheet | ✓ picker | ✗ | ✗ | ✗ |
| 多选 | ✗ | ✗ | ✗ | ✗ | ✗ |
| 排序 UI | ✗(固定) | ✗(固定，旧版有=回归) | ✗(固定) | ✗(lastVisited) | ✗(固定) |
| 搜索 | ✗ | ✗ | ✗ | ✗ | ✗ |
| 加密行级 | ✓ | ✗(epic 排了) | ✓ 钥匙角标 | ✗ | ✗ |
| cache/pin | unload/reupload | keepOffline 圆点 | stub prefetch | ↓缓存/×去缓存 | pin 3 态+LRU 免疫 |
| 数据源 | store watchFolder | store listAllItems | 自研 sync+IDB | 自有 IDB+provider 接缝 | 裸 Graph 直连(禁缓存) |

**真共性（可进库）**：面包屑/单夹导航+行/卡两 layout、trash/backup 视图+restore/purge、rename/move picker、SyncState→badge 渲染、缩略图 cell（IntersectionObserver+objectURL 生命周期+token 失效缓存——ThumbCell 完全通用，app 特异只 2 config 参数）、in-app confirm 意图流、cache/pin badge 通道（与 sync badge 正交，ADR-0014 已有 pin）。epic 五层表与实测矩阵基本吻合。
**app 专属（留宿主）**：打开动作（解 ora / 阅读位置+rekey / 进 VR / 播放）、扩展名与根前缀、新建入口、缩略图内容来源、加密 UX。
**结构性硬约束**：BgRadio 禁 listing 影子（live-passthrough）vs 小黑屋依赖 IDB stub 影子（shadow-backed）——**库的 listing 来源必须可插拔**；RealHome flat-grid 无 trash 变体（epic :21 已预留）。

### 4. byte-identical copy 机制现状——没有机制，只有一次性 fork 戳，已全面漂移

- **canonical 抽取从未发生**：MyPWAPatterns/sync-store/ 只有 90 行 README；docs/20260619-backlog.md item 3 自认 vaporware（SYNC_STORE_VERSION 常量 + sync-store/src/ 从未实现，live 引擎 baked 在 WebPaint/src/store/）。
- **目标工作流写好了没执行**（docs/20260610-shared-lib-workflow.md，⚠ PLAN banner）：baked copy 头部戳 fork 版本号=merge-base 指针；三流（在地 dev → upstream release+bump → 按需 reconcile）；两条纪律（app 差异只进两个接缝、漏进引擎标 // APP-DIVERGENCE）。
- **现状**：唯一锚 = FORK-BASE.md（WebPaint 与 JRP 两份 byte-identical，fork_base_commit: 2e9a809，2026-06-19 拷贝）。此后各自演化：**32 个共有文件全部 differ，仅 substrate.ts 还 byte-identical**；WebPaint 多 8 文件（blob-partition/error-handling/folder-delete/is-hidden/kv-namespace/migration/pending-gone/trash-merge），JRP 多 settings.ts；行数 5799 vs 4177。无版本常量、无校验脚本、无 diff 工具。
- **收敛已拍板未落地**（memory：锚 JRP + ADR-0019 显式版本迁移 / 0020 dirty 双轨 / 0021 app 四面不碰 kv，MyPWAPatterns/docs/adr/）。
- **对 gallery 库的启示**：「byte-identical」实际是「fork 戳+手动三方 merge 的承诺」，6 周就漂成 32 文件全 differ——gallery 库照抄这套同样命运；至少补：版本常量 + diff -rq 级对账脚本。

### 5. esbuild bundle + dev/prod split 采纳表

| repo | esbuild | dev/prod 分支 | 证据 |
|---|---|---|---|
| 20260524 WebPaint | ✓ | ✓（main→/dev/，prod→/） | scripts/build.sh、deploy.yml、dist/webpaint-<hash>.mjs |
| 20260518 JustReadPapers | ✓ | ✓ | 同构；origin/prod 在 branch -a |
| 20260520 RealHome | ✓ | ✓ | 同构；本地+remote prod |
| 20260520 ScratchPad | ✓ | ✓ | 同构（memory：v27 待用户翻 Pages 源） |
| 20260516 WebXiaoHeiWu | ✗ | ✗（仅 main） | 无 scripts/、无 .github/；版本号双写 app.js:149+service-worker.js:4 |
| 20260517 Background Radio | ✗ | ✗（仅 main） | 无 scripts/、无 .github/；仅 CACHE_VERSION |
| 20260523 JustReadBooks | ✗ | ✗ | 无 scripts/、无 dist |
| 20260524 AtlasMaker | ✗ | ✗ | 无 scripts/、无 dist |

注：纯读项目可只上 esbuild 不上双分支（dev-prod-split.md:9）；但**要吃多文件 TS 的 gallery 库，小黑屋和 BgRadio 必须先补 build 管线**（现在 script module 直连源码，BgRadio index.html:194）。

### 6. 给「骑士抽卡」的五个开工前拍板项（按依赖序）

1. **列举接口统一**：watchFolder 订阅 vs listAllItems 全树——库吃哪个？（建议：库只吃「当前夹快照+folders」，宿主适配，BgRadio live-passthrough 也能塞进。）
2. **JRP emit-意图组件是最佳底盘** + WebPaint ThumbCell/thumb-cache 是最佳缩略图件——但 WebPaint 侧先斩 session.* 双向依赖（7+3 直调点）并删 gallery-model.ts 死码。
3. **badge 拆两条正交通道**：sync 语义（9 态 SyncState 直进组件，砍两跳降维）⊥ cache/pin 语义。
4. **CSS/i18n 随组件走**：JRP CSS 写死 index.html、WebPaint badgeTitle 硬编码中文；epic :22 两级 var(--gal-*, var(--accent)) fallback 是既定约定。
5. **分发机制先补课**：GALLERY_LIB_VERSION 常量 + FORK-BASE 戳 + 对账脚本，别重演 sync-store 六周漂移。
