# WebPaint SVG 图标清点 + 缺口清单

> as-of v375 / 2026-07-07 · 创建日 2026-07-07

承接 i18n 方案图标决策 D5（`docs/20260707-i18n-architecture.md` §7）：
盘家底 + 搭台子，**这一步不改运行时代码**，只清点 + 建工具 + 写本 doc。真图标设计是后续 TODO。

**本 doc 的表格机械生成**（`workbench/build-doc.py` 读 `workbench/svg-data.json`，源自 `workbench/extract-svgs.py` 扫 `index.html` + `src/**.ts`）。代码变了就重跑刷新，别手改表。

## 配套本地工具（untracked，不入库）
- `workbench/workbench.html` —— 自包含单文件预览/涂鸦台：并排渲染全部已清点 SVG + glyph 占位实时预览 + 手写 SVG 多背景多尺寸涂鸦板。**本地双击打开即可**（无需 server）。
- `workbench/extract-svgs.py` → `svg-data.json` → `build-workbench.py` / `build-doc.py`：改代码后依次重跑刷新。
- `workbench/` 整个目录已进 `.gitignore`（本地工具，不污染 repo）。

## 现状概览
- **已有 inline SVG：66 处**（`index.html` 38 + `src/**.ts` 28）。含 builder helper 展开（`blender-sync.svg()` 5 个、`gallery.SVG()` 8 个）。
- **需 glyph 占位缺口：17 处**（调色板 4 + 套索文字栏 13）——现为「中文字当图标」，英文会撑爆布局。
- **独立文件**：`icon.svg`（app 图标，512 viewBox 水彩弧，非工具栏 icon）、`icon-192/512.png` + `apple-touch-icon-180.png`（PNG 位图，非 SVG）。
- **CSS 伪元素文字**：`styles.css:1980` `content:"编辑中"`（图库 tile 角标）——非 SVG，i18n 时改 JS 设文本（§7 备注）。
- **非 pill 特例**：`#lassoSampleSel` 采样模式 `<select>`（index.html:433）——下拉不是文字图标，选项由 JS 从 SSoT 填，i18n 单独处理，不在 glyph 缺口内。

## 一、需要的 SVG（缺口 · glyph 占位 → 真图标）

规则（i18n §7 / D5）：就地改成固定 `viewBox` 的 glyph-SVG（中文字形占位，**永不翻译**，语义由翻译过的 `title`/`aria-label` 承载），挂 `TODO 真图标`。多字取 1 字代表。

### 调色板

| 当前文字 | 选择器 | 位置 | 语义 (title) | glyph 建议 | 状态 |
|---|---|---|---|---|---|
| **笔** | `[data-palette-tool=brush]` | `index.html:500` | 刷（用当前色） | `笔` | 需 glyph 占位 → 需真图标 |
| **混** | `[data-palette-tool=mix]` | `index.html:501` | 混色 | `混` | 需 glyph 占位 → 需真图标 |
| **吸** | `[data-palette-tool=picker]` | `index.html:502` | 吸到主画 | `吸` | 需 glyph 占位 → 需真图标 |
| **清** | `.palette-clear` | `index.html:503` | 清空 | `清` | 需 glyph 占位 → 需真图标 |
### 套索栏

| 当前文字 | 选择器 | 位置 | 语义 (title) | glyph 建议 | 状态 |
|---|---|---|---|---|---|
| **1:1** | `#lassoConstrainBtn` | `index.html:410` | 约束 1:1（正方 / 圆） | `⊡` | 需 glyph 占位 → 需真图标 |
| **设置** | `#lassoMagicCfgBtn` | `index.html:411` | 魔术棒阈值（真图标宜齿轮） | `设` | 需 glyph 占位 → 需真图标 |
| **变换** | `#lassoTransformBtn` | `index.html:417` | 变换 / 移动 | `变` | 需 glyph 占位 → 需真图标 |
| **填色** | `#lassoFillBtn` | `index.html:419` | 用当前颜色填选区 | `填` | 需 glyph 占位 → 需真图标 |
| **清除** | `#lassoClearBtn` | `index.html:420` | 清除选区内像素 | `除` | 需 glyph 占位 → 需真图标 |
| **复制层** | `#lassoDuplicateBtn` | `index.html:422` | 复制选区到新层 | `复` | 需 glyph 占位 → 需真图标 |
| **移到层** | `#lassoMoveToLayerBtn` | `index.html:423` | 选区移动到新层（旧层清除） | `移` | 需 glyph 占位 → 需真图标 |
| **自由** | `[data-lasso-mode=free]` | `index.html:427` | 自由变换 | `自` | 需 glyph 占位 → 需真图标 |
| **等比** | `[data-lasso-mode=uniform]` | `index.html:428` | 等比缩放 | `比` | 需 glyph 占位 → 需真图标 |
| **透视** | `[data-lasso-mode=distort]` | `index.html:429` | 透视变换 | `视` | 需 glyph 占位 → 需真图标 |
| **盖印** | `#lassoStampBtn` | `index.html:435` | 盖印（写入但保留浮层） | `印` | 需 glyph 占位 → 需真图标 |
| **应用** | `#lassoCommitBtn` | `index.html:436` | 应用变换 | `✓` | 需 glyph 占位 → 需真图标 |
| **取消** | `#lassoCancelBtn` | `index.html:437` | 取消变换 | `✕` | 需 glyph 占位 → 需真图标 |

## 二、已有 inline SVG（清点）

`复用` = 同一形状在别处重复出现（去重后是同一枚图标，改真图标时一处改多处受益）。

### `index.html` · 38

| id / 选择器 | 行 | 语义 | 形态 | 复用 |
|---|---|---|---|---|
| `menuButton` | 66 | tool.menu | inline | ✓×2 |
| `topEncLock` | 77 | enc.locked | inline | — |
| `toolPen` | 87 | tool.brush | inline | — |
| `toolEraser` | 95 | tool.eraser | inline | — |
| `toolPicker` | 108 | tool.picker | inline | — |
| `toolLasso` | 115 | tool.lasso | inline | — |
| `toolHand` | 121 | tool.pan | inline | — |
| `topAdjustBtn` | 134 | tool.adjust | inline | — |
| `layersButton` | 142 | tool.layers | inline | — |
| `undoButton` | 160 | action.undo | inline | — |
| `redoButton` | 166 | action.redo | inline | — |
| `cloudRefreshBtn` | 181 | cloud.refresh | inline | — |
| `galleryTrashBtn` | 189 | nav.trash | inline | — |
| `galleryAddBtn` | 196 | 新增 | inline | ✓×2 |
| `galleryMenuBtn` | 203 | 图库菜单（更新 / 设置） | inline | ✓×2 |
| `lassoSubToolBar` | 326 | 自由套索 | inline | — |
| `—` | 331 | 矩形选区 | inline | — |
| `—` | 336 | 椭圆选区 | inline | — |
| `—` | 341 | 魔术棒 | inline | — |
| `—` | 353 | 新建选区（替换当前） | inline | — |
| `—` | 360 | 添加到选区 | inline | — |
| `—` | 368 | 从选区减去 | inline | — |
| `lassoSelectAllBtn` | 380 | 全选 (Ctrl+A) | inline | — |
| `lassoInvertBtn` | 387 | 反选 (Ctrl+Shift+I) | inline | — |
| `lassoSelEditBtn` | 397 | 编辑选区：扩张 / 收缩 | inline | — |
| `lassoDeselectBtn` | 404 | 取消选区 (Ctrl+D) | inline | — |
| `brushRackImport` | 515 | 导入笔架 JSON | inline | — |
| `brushRackExportFolder` | 521 | 导出当前文件夹为 JSON | inline | — |
| `brushRackCloudPush` | 527 | 云备份笔架到 OneDrive | inline | — |
| `brushRackNew` | 533 | 新建笔刷 | inline | — |
| `layerAddBtn` | 595 | 新建 / 导入 | inline | ✓×2 |
| `layerMoveUpBtn` | 601 | 上移图层 | inline | — |
| `layerMoveDownBtn` | 607 | 下移图层 | inline | — |
| `layerDeleteBtn` | 614 | 删除当前图层 | inline | — |
| `referenceLoadBtn` | 639 | 从文件载入 | inline | — |
| `referenceLiveBtn` | 645 | 实时镜像主画布 | inline | — |
| `referenceFitBtn` | 652 | 适应窗口 | inline | — |
| `referenceResizeHandle` | 664 | 拖动调整大小 | inline | — |

### `src/blender-sync.ts` · 5

| id / 选择器 | 行 | 语义 | 形态 | 复用 |
|---|---|---|---|---|
| `ICON_OFF` | 35 | 云（未连接） | builder展开 | — |
| `ICON_ON` | 36 | 云+勾（已连接） | builder展开 | — |
| `ICON_BUSY` | 37 | 云+转圈（连接中） | builder展开 | — |
| `ICON_DL` | 38 | 下载（拉取贴图） | builder展开 | — |
| `ICON_UL` | 39 | 上传（推送贴图） | builder展开 | — |

### `src/cloud-auth-ui.ts` · 2

| id / 选择器 | 行 | 语义 | 形态 | 复用 |
|---|---|---|---|---|
| `—` | 22 | 云（账号·未登录） | inline | — |
| `—` | 23 | 云+勾（账号·已登录） | inline | ✓×2 |

### `src/filters-adjust.ts` · 2

| id / 选择器 | 行 | 语义 | 形态 | 复用 |
|---|---|---|---|---|
| `—` | 198 | 调整/滤镜列表（三横线+滑点） | inline | — |
| `—` | 204 | 画笔（液化类菜单项） | inline | — |

### `src/layers-panel.ts` · 5

| id / 选择器 | 行 | 语义 | 形态 | 复用 |
|---|---|---|---|---|
| `—` | 83 | 眼睛（图层可见） | inline | — |
| `—` | 84 | 眼睛划线（图层隐藏） | inline | — |
| `—` | 86 | 文件夹（展开态） | inline | — |
| `—` | 87 | 文件夹（合上态） | inline | — |
| `—` | 493 | 剪裁徽章（裁到下方第一颗非剪裁层） | inline | — |

### `src/save-status.ts` · 4

| id / 选择器 | 行 | 语义 | 形态 | 复用 |
|---|---|---|---|---|
| `—` | 35 | 硬盘/本地已存（云端未动） | inline | — |
| `—` | 36 | 上传（上箭头） | inline | — |
| `—` | 37 | 云+勾（已同步） | inline | ✓×2 |
| `—` | 39 | 云+转圈（同步中） | inline | — |

### `src/ui/gallery.ts` · 8

| id / 选择器 | 行 | 语义 | 形态 | 复用 |
|---|---|---|---|---|
| `localOnly` | 46 | 仅本地（圆柱 DB） | builder展开 | — |
| `cloudOnly` | 47 | 仅云（云） | builder展开 | — |
| `syncedBoth` | 48 | 已同步（云+勾） | builder展开 | — |
| `dirtyBoth` | 49 | 本地改动待传（云+上箭头） | builder展开 | — |
| `folder` | 50 | 文件夹 | builder展开 | — |
| `cloudBig` | 51 | 云（大·breadcrumb） | builder展开 | — |
| `ghost` | 52 | 云已失联（云+斜杠） | builder展开 | — |
| `lock` | 53 | 锁（加密） | builder展开 | — |

### `src/ui/left-dial.ts` · 2

| id / 选择器 | 行 | 语义 | 形态 | 复用 |
|---|---|---|---|---|
| `sizeSlider` | 105 | 笔粗 | inline | — |
| `opacitySlider` | 118 | 不透明度 | inline | — |

## 三、复用形状（去重线索）

66 处 inline SVG 去重后约 63 枚不同形状。以下形状被复用多处——真图标阶段改 1 处应同步：

| 出现次数 | 代表语义 | 出现位置 |
|---|---|---|
| 2 | tool.menu | index.html:66, index.html:203 |
| 2 | 新增 | index.html:196, index.html:595 |
| 2 | 云+勾（账号·已登录） | cloud-auth-ui.ts:23, save-status.ts:37 |

> 注：云图标（`M18 10h-1.26A8 8…`）在顶栏保存态、blender-sync、save-status、gallery 徽章、cloud-auth 多处出现，是家族云语义的事实标准形状。
