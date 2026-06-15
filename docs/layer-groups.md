# 图层组（嵌套树）— 进行中

> as-of v276 / 2026-06-14。目标：嵌套图层组（文件夹），**correctness-first**（perf/内存见
> `docs/perf-webgl-memory-clip.md`）。**详细可执行 spec 在工作计划文件**
> `~/.claude/plans/abundant-tinkering-newell.md`「Batch 2」节——本文只记状态 + 决策，不重复 spec。

## 地基（已就位，v274）
统一合成器 `src/layer-composite.js` 是唯一「图层树→像素」路径（board/导出/ORA/PSD/吸管都走它），
且 `compositeLayers` 已写好**递归组隔离 + 同级 clip**（`computeClipBaseForNodes` / `_compositeGroup` /
`nodeContentBbox` / `_drawNodeAlpha`）。→ 组天然支持，**不会渲染路径不一致**。

## 状态
- **step 1 数据模型：✅ 完成**（提交 `f44e2ac`；现 local main 含它，**未 push**；origin/main = v276 `598262e`）。
  strangler：未接 UI，doc.layers 实际仍扁平，行为同 v276，零回归。
  - `src/doc.js`：`Layer.isGroup`、`LayerGroup`、树工具（eachLeaf/flattenLeaves/findNodeById/
    findParentOf/countLeaves）、`activeId`（activeIndex 降兼容垫片）、树化 op、组 op
    （groupSelection/ungroup/moveIntoGroup/moveOutOfGroup）、递归 snapshotAll。
  - 测试：`test/layer-tree.test.mjs`（+12）。
- **step 3 ORA 序列化：✅ 完成**（提交 `ee48bad`，local main，**未 push**）。
  - 抽 `src/ora-stack-xml.js` 深模块：**纯** 图层树↔stack.xml（`buildStackXml`/`parseStackXml` +
    composite-op 映射），**无 canvas/zip 依赖** → 可纯 node 测、与 PNG codec 解耦。
  - `src/ora.js`：encode 走 `flattenLeaves`（只叶有 PNG）+ 递归发 `<stack>`/`<layer>` + `webpaint:id`/
    `webpaint:active`；decode 递归建 Layer/LayerGroup 树、按 id 还原 active/reference、
    `reseedLayerIdCounter` 防撞号。向后兼容旧扁平 .ora（无 id→发新 id；无嵌套→扁平）。
  - `src/doc.js`：+ `reseedLayerIdCounter(nodes)` 导出。
  - 测试：`test/ora-tree.test.mjs`（+3，自带极简 XML parser polyfill；**单 await 回合**——多一个
    await 会扰动 run.mjs 一众 TLA 模块的微任务交错、毒 selection-morph 的 OSC-stub，实测）。全套 **351 passed**，build OK。
- **剩余（顺序 + 细节见 plan 文件 Batch 2；均需 iPad 真机验，整批不可中途 ship）**：
  - **step 2 迁移面**：panel/undo/session-state 里 `doc.layers.findIndex`/`activeIndex`/`doc.layers[i-1]`
    等扁平假设 → tree-aware（`findParentOf`/`countLeaves`/同级边界）。
  - **step 4 panel**（最大块，UI）：`rows` computed 递归建树（组行+缩进+children 填 `LayerRow` 已有的 children
    v-for）+ 组行 UI（折叠箭头/组名/可见·opacity·mode/⋯菜单解组·删组）+ 命令栏接线（新建组/编组当前/
    移入上方组/移出组/解组 → 调 doc 组 op + history.push + `_afterDocChange`）→ **groups 在此变 UI-可达**。
  - **step 5 undo**：结构 entry 扁平 index → `{parentId, index}`；新 `group`/`ungroup`/`reparent` handler
    （最省底座 = snapshotAll/restoreSnapshotAll 递归版，已就位）。
  - **step 6 护栏**：`_beginStroke`/liquify/filterBrush + `getFloodSourceLayer` 的 `isGroup` 护栏；psd 走 flattenLeaves。

## 已定设计决策（避免用户点名的 5 类错误）
- **active = 叶或组**；绘画路径 isGroup 护栏（组不可画）→ 避免笔刷错误。
- **clip = 按同 parent 级**（clip 到同组内下方最近「非clip/可见/有内容」节点；不跨组）；组可为 clip 层/基底；
  基底隐藏/无基底 → 该 clip 链不显（用户「clip 跟基底隐显」）。
- **blend = 组隔离**（组 mode≠source-over‖opacity<1‖clippingMask → 合到独立 buffer 再整体混；
  pass-through 组摊进父级）。
- **float 本批不动**（仍画在全部之上）。多图层/组变换 = 多 float 共享一个 transform，经合成器**已有的
  per-leaf `overlayFor`** 渲染到各源层之上 → 顺带解决「float 在源层上面」z-fix。模型/合成器**无需改**
  即支持（`flattenLeaves(group.children)` 给要 lift 的叶）；是**未来 float 重做**的活，不在本批。
- **UI = 菜单/按钮式**（新建组/编组当前/移入上方组/移出组/解组），无行拖拽（守 layers-panel.ts:339 iPad 决定）。
- **id 持久化**：ORA 写 `webpaint:id`，active/clip/reference 按 id；加载 reseed `_layerIdCounter`。

## 序列化 / 兼容
- 存档格式 = ORA。**已实现（step 3）**：纯序列化抽到 `src/ora-stack-xml.js`；`buildStackXml` 递归发
  `<stack>` + `webpaint:id`/`webpaint:active`；`parseStackXml` 递归 DOM 走（不再 `querySelectorAll`）。
  向后兼容：旧 .ora 无 id→发新 id、无嵌套→扁平。
- store/cloud（`src/store/**`，红线）只见 opaque bytes → **零改动**（已确认）。
- PSD（`src/psd.js`）：组拍平进 merged（compositeLayers 已做）；per-layer records 走 flattenLeaves（**step 6 待做**）。

## 引用
- 可执行 spec：`~/.claude/plans/abundant-tinkering-newell.md` Batch 2。
- 提交：`f44e2ac`（step1 模型）、`ee48bad`（step3 ORA）；v274 合成器统一；v275 pan/FPS/clip实时；v276 混合模式同底。
- 测试：`test/layer-tree.test.mjs`、`test/ora-tree.test.mjs`、`test/layer-composite.test.mjs`。
