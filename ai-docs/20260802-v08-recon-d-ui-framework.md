# v0.8 recon D · UI 层现状盘点（骑士的新装）（易过期）

> as-of v0.8.0 / 2026-08-02
> 性质：Explore agent 勘探快照原样 dump + 拷问补充。file:line 会漂——信代码不信本文。
> 索引：`20260802-v08-recon-index-six-knights.md`

## 拷问补充

1. **「UI 宽架选型」其实已发生过**：Vue 已 vendored 且 6 个 createApp 岛稳定运行——D 的真问题不是选框架，是决定手写 DOM 的另外 ~8000 行胶水要不要/哪些往岛收，以及给「浮动 UI 面」一个统一深模块。
2. **授权出处现成**：inline-select.ts:5 有 user 亲手点名的 TODO（2026-07-25）「与组槽下拉/⋯菜单/tile 菜单一起收成 popover 深模块（open/close/锚定/z 一站式）」——popover 深模块可当「还债」提前单独做，不必等 C。
3. **Unity inspector moonshot 的陷阱预警**：为 layers-panel 这类高定制面板强行套声明式 schema 会造出第二套模板语言；现实路线 = menu/popover/toolbar 三类先注册式（低定制高重复），panel 保持 Vue 岛手写。
4. sheet 双义（居中 modal vs 底部笔架弹层）→ user 提的 sheet→panel 改名有实证痛点；改名时连三份 openSheet/closeSheet 拷贝一起收。
5. 越狱预警：AI 修 z-order/菜单 bug 的默认动作是加第 15 份外点关拷贝 + 手调一个 calc(±n)——框架不先行，D 的债继续复利。

---

## 以下为勘探原文（2026-08-02）

### 1. els.ts 考古

- src/els.ts 144 行，**122 个 byId()** + 2 个 querySelector（toolBtns :130、colorPanelBody :136）。
- **被 17 个文件 import**：app、cloud-auth-ui、doc-ops、color-panel、export-import-menu、gallery-shell、filters-adjust、import-image、layers-panel、save-status、side-windows、session-state、settings-menu、topbar-menu、theme、smooth-dev-panel、toolbar。
- 索引的是 index.html 手写静态结构（els.ts:4 自述「静态存在……断言非空」）。index.html 1437 行、**487 个 id**、298 行含 hidden——几乎所有 surface 都是「静态写死+生来 hidden+JS toggle」范式。
- **els.ts 不是唯一入口**：toolbar.ts:29 自带同名 byId 另查 40+ 套索/形状元素（:52-63 裸 let 变量群）；sheets.ts:18 有自己的 `$`；filters-adjust/settings-menu 各处裸 getElementById。「全局 DOM 索引」已分叉两套。

### 2. Toolbar 范式：一个「组槽」范式 + 四种载体实现

| 实现 | 位置 | 形态 |
|---|---|---|
| 主工具列 | index.html:379-441 `.tool[data-tool]`；toolbar.ts（1242 行，setTool→editMode→wp:modechange→_syncEditModeUI 派生高亮） | 静态 HTML+命令式派生 |
| context toolbar（.lasso-toolbar-stack） | shapeToolbarStack :578、lassoToolbarStack :611（row1/row2）、pickerToolbar :698（自认「复用 lasso stack 视觉类」） | 静态 HTML，toolbar.ts 接线 |
| .crop-toolbar | cropToolbar :1176、filterBrushToolbar :1208 复用同一 CSS 类；接线 doc-ops/filters-adjust.ts:288,303 | 另一套视觉类各自接线 |
| 笔架 sheet 动作条 | brushRackSheet :895；头部动作条命令式、格子区 Vue（ui/rack-sheet.ts:6-8 明说边界） | 混合 |

**共享**：视觉类、anchored-popup 定位、_transientMenus 外点关数组、editorState per-tool 持久化样板（toolbar.ts:67-78）。
**分叉**：显隐逻辑各管各；顶栏让位靠 anchored-popup.ts:27 硬编码 `_TOP_TOOLBAR_IDS = ["lassoToolbarStack","cropToolbar","filterBrushToolbar"]`——新增 toolbar 要记得改这个数组（注册式框架能吃掉的耦合）。

**wireSlotMenu 范式**（toolbar.ts:698-705，v0.5.14；v0.7.40 拆成 openSlotMenu :682 + wireMenuItems :687）：三调用点 = lassoSubSlot(:712)、lassoAlgoBtn(:762，条目从 MAGIC_ALGORITHMS SSoT 动态生成 :753-761——**已是半注册式孤例**)、shapePerspModeSlot(:858)。第四个槽 lassoSetOpSlot(:731-747) 因 mode-aware 单击语义只用半套——范式已被特例撑开。

### 3. menu 定位 / z-order

**定位已收敛一处**：src/anchored-popup.ts（95 行）「唯一定位入口」，positionPopup + 两个兼容 wrapper（:89,:93）；v270 收敛前是 3 个近似函数 + 各处手搓。体系外：lasso 纯 CSS 钉死 popup（:6-7 自述豁免）、sheets 居中层（:8）、layers-panel 行内 ⋯ 菜单 Teleport 逃 backdrop-filter 包含块（layers-panel.ts:442-443）。

**z-order 半深模块双层制**：
- band 表 SSoT = styles.css:3-26 的 13 个 --z-* band（chrome10/toolbar25/window100/sheet220/overlay300/menu400/popover420/toast450/modal500/busy520/gate540/popout600/dev700/error9999），自称「全仓唯一允许出现 z-index 数字的地方」。
- window band 内动态序 = src/surfaces.ts（42 行）raiseWindow/registerWindow，base+栈内序号归一化。
- 体系外硬编码：styles.css:157,168（自认豁免）、:922（z-index:50 裸数字）、:995,2210,2220,2313（局部 stacking context 相对值）、若干 calc(var(--z-*)±n) 微调（:412,602,683,1637,1713,1717,1825,2045,2659）——band 内相对关系仍手填。index.html:29 __errBar inline z-index:9999 与 --z-error 靠注释对齐。

**z-order bug 化石清单（框架动机证据）**：surfaces.ts:10-11（v113 无上限递增计数器「点 15 次爬过菜单层」）；transient-panels.ts:46（user 原话「adjust panel 点出来之后在 color panel 下面，导致我以为坏了」）；styles.css:275（v0.5.38「同 z 时 DOM 序不可靠」→ --z-popover band+「深模块化 TODO」）；styles.css:812（user 原话「主菜单 zorder 应该在 lasso 等的菜单上面」）；styles.css:8-9 + sheets.ts:7-15（busy/gate/sheet 三层互压两次翻车：v0.4.11 gate 抬过 busy；busy 盖 input sheet=await 永不 resolve 死锁，现靠 _assertNotBusy 响亮 throw 顶着）；设计文档 ai-docs/20260611-surfaces-z-order.md（v232）。

### 4. panel / sheet 命名普查

**三层面板体制**（panel-state.ts:3-6）：常驻自理 / 互斥 exclusive / modal 三路各一套机制。
- **sheet（modal 居中）**：src/sheets.ts（191 行）= genericSheet（input/confirm/choice 三原语）+ syncGateSheet。体系外 per-feature sheet 各写各：newDocSheet（:539）、resampleSheet/offsetSheet、clearSheet、explodeSheet（:959）、shortcutsSheet、exportConfigSheet。
- **sheet（底部弹层，另一义）**：brushRackSheet（:895，--z-sheet band，Vue）——**「sheet」一词双义**。
- **float panel（window band）**：colorPanel、paletteWindow、referencePanel、adjustPanel、layersPanel（transient-panels.ts:104-107 注册清单）+ blender btpPanel（blender-sync.ts:410 运行时 innerHTML 造，没进 surfaces 注册清单）。
- **open/close/定位各写各**：拖动逻辑至少 5 份手搓（color-panel.ts:76-95、layers-panel.ts:828+、topbar-menu.ts:128-150 bindAdjustPanelDrag、reference.ts:279、side-windows.ts:48-77 resize 又一份）。互斥归 panel-state（65 行）、transient 抑制归 transient-panels（allowList 按 id 字符串硬编码 :20-26）、置顶归 surfaces——一个「浮窗」概念切成 4 个模块 + N 份私有拖动。

### 5. UI 框架现状

- **Vue 3 已 vendored**（vendor/vue/vue.esm-browser.prod.js），**6 个 createApp 岛**：layers-panel.ts:805、ui/color-wheel.ts:203、ui/rack-sheet.ts:88、ui/brush-config-view.ts:165、ui/left-dial.ts:135、ui/gallery.ts。reactive 原语另渗透 7 个非组件模块（session-state:13、workbench-state:20、signals:4、brush-rack-controller:18、resolved-brush:18、app:66、fill-mode:26）。其余全手写 DOM。
- **规模**：36 个 UI 文件 ≈ 8,277 行 TS（不含 index.html 1437 行 + styles.css 2709 行）。Top：toolbar 1242 / layers-panel 924 / ui/gallery 682 / reference 578 / brush-rack-controller 477 / gallery-shell 424 / filters-adjust 409 / topbar-menu 301 / settings-menu 299 / ui/color-wheel 215 / export-import-menu 207 / sheets 191 / ui/brush-config-view 178 / ui/gallery-view-model 168 / ramp-slider·els·left-dial·color-panel ≈140 各。

### 6. 复制粘贴 boilerplate 实证（深模块候选证据）

1. **弹出菜单外点关三行样板 ≥14 份**：toolbar.ts:534,627,692,793,971,1010、settings-menu.ts:294、layers-panel.ts:814,900、gallery-shell.ts:376、filters-adjust.ts:385、export-import-menu.ts:82、inline-select.ts:33、blender-sync.ts:87。**inline-select.ts:5 有 user 点名 TODO（2026-07-25）**：「收成 popover 深模块（open/close/锚定/z 一站式）」——本次框架的直接授权出处。
2. **openSheet/closeSheet 函数体 3 份**：sheets.ts:30-37、topbar-menu.ts:43-46、settings-menu.ts:29-37（settings-menu.ts:28 自认「inline 复制一份」）。
3. **浮窗标题栏拖动 4-5 份近似拷贝**（见 §4）。
4. 滑条/数值控件已部分深模块化（ramp-slider、drag-value、brush-size），但 dial-controls 和原生 range 并存——「提炼成功后旧实现没清完」样本。

**一句话结论**：定位（v270）、z-band（v232）、互斥（panel-state）、modal（sheets）四个半成品深模块各自收敛过一轮，但「一个浮动 UI 面」的生命周期（注册/开关/定位/置顶/外点关/拖动/transient 抑制）仍横跨 4 模块 + 14 份外点关 + 5 份拖动 + 487 静态 id 的 els 查表；Vue 已 6 岛，注册式框架有现成落点和 user 点名的 popover TODO 作为切入缝。
