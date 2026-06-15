# 图层组（嵌套树）— 进行中

> as-of v276 / 2026-06-14。目标：嵌套图层组（文件夹），**correctness-first**（perf/内存见
> `docs/perf-webgl-memory-clip.md`）。**详细可执行 spec 在工作计划文件**
> `~/.claude/plans/abundant-tinkering-newell.md`「Batch 2」节——本文只记状态 + 决策，不重复 spec。

## 地基（已就位，v274）
统一合成器 `src/layer-composite.js` 是唯一「图层树→像素」路径（board/导出/ORA/PSD/吸管都走它），
且 `compositeLayers` 已写好**递归组隔离 + 同级 clip**（`computeClipBaseForNodes` / `_compositeGroup` /
`nodeContentBbox` / `_drawNodeAlpha`）。→ 组天然支持，**不会渲染路径不一致**。

## 状态
- **step 1 数据模型：✅ 完成**（提交 `f44e2ac`，分支 `worktree-small-highs-v268`，**未 push**；
  origin/main = v276 `598262e`）。strangler：未接 UI，doc.layers 实际仍扁平，行为同 v276，零回归。
  - `src/doc.js`：`Layer.isGroup`、`LayerGroup`、树工具（eachLeaf/flattenLeaves/findNodeById/
    findParentOf/countLeaves）、`activeId`（activeIndex 降兼容垫片）、树化 op、组 op
    （groupSelection/ungroup/moveIntoGroup/moveOutOfGroup）、递归 snapshotAll。
  - 测试：`test/layer-tree.test.mjs`（+12，全套 348 passed）。
- **剩余**（顺序 + 细节见 plan 文件 Batch 2）：ORA 递归序列化（`<stack>` + `webpaint:id`）→
  panel 递归 + 组 UI + 组 op 接线（**groups 在此变 UI-可达**）→ undo 树化 + 组 handler → 笔刷/吸管/选区 isGroup 护栏。

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
- 存档格式 = ORA（`src/ora.js`）。写 `buildStackXml` 递归发 `<stack>`；读 `parseStackXml`
  （现 `querySelectorAll("stack > layer")` 扁平）改递归 DOM 走。向后兼容：旧 .ora 无 id→发新 id、无嵌套→扁平。
- store/cloud（`src/store/**`，红线）只见 opaque bytes → **零改动**。
- PSD（`src/psd.js`）：组拍平进 merged（compositeLayers 已做）；per-layer records 走 flattenLeaves。

## 引用
- 可执行 spec：`~/.claude/plans/abundant-tinkering-newell.md` Batch 2。
- 提交：`f44e2ac`（step1 模型）；v274 合成器统一；v275 pan/FPS/clip实时；v276 混合模式同底。
- 测试：`test/layer-tree.test.mjs`、`test/layer-composite.test.mjs`。
