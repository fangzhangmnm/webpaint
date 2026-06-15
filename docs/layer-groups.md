# 图层组（嵌套树）— 全 6 步落地，待真机验

> as-of v277 / 2026-06-14。目标：嵌套图层组（文件夹），**correctness-first**（perf/内存见
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
- **step 2/4/5/6：✅ 完成**（v277，未 push 时 = local main；node 测 357 passed + build OK；**待 iPad 真机验**）。
  - **step 2 迁移面**：`pixel-edit.js`（recursive findNodeById）、`session-state.ts`（activeId 持久化 + 老 index 兜底）、
    `selection-ops.ts`（locateNode 插入 + 组 guard）、`session.js`（缩略图走 compositeLayers，不再手抄扁平 loop）、
    `psd.js`（per-layer records 走 flattenLeaves）、panel/undo 全 tree-aware。board.js 本就走合成器无需改。
  - **step 4 panel**（`layers-panel.ts`）：`rows` computed 递归建**扁平+depth**行；组行（折叠三角▾/▸ + 组名 + 可见 +
    opacity/mode + ⋯菜单：解组/删组/剪裁/重命名）；⋯菜单接线 编组(叶/组都可，可嵌套)/解组/移入上方组/移出组；
    `collapsedIds:Set` 折叠态；计数/上下移禁用走 `countLeaves`/`canMoveLayer`(同级边界)。CSS：`.layer-group-row`/`.layer-collapse`。
  - **step 5 undo**：结构 entry 扁平 index → `{parentId, index}`（`insertLayerAt(index,spec,parentId)` + `locateNode`）；
    moveLayer 改 delta 制；组 op（编组/解组/移入移出/删组）走新 `treeStructure` handler，底座 = `snapshotTree`/`restoreTree`
    （**保叶活引用、零像素拷贝** → iPad 内存友好；像素历史靠 id 不变保活）。mergeDown/duplicate 返回同级位。
  - **step 6 护栏**：input.js 单一 chokepoint isGroup 拒画（touch 降级 hold 不拦多指手势，单指真画才弹中文）；
    `getFloodSourceLayer` 组→null（doc 层已做）；吸管走合成缓存（组安全，无需改）。

### 真机待验清单（按批，反煤气灯）
- 建组（叶 ⋯→编组）/ 嵌套（组 ⋯→编组）/ 折叠箭头 / 移入上方组 / 移出组 / 解组 / 删组（连带 children）。
- 组 opacity·mode·可见性·剪裁 改了画面对 + 抬笔不弹回。组内叶 clip 到组内基底；基底隐显跟随。
- 组内画图：选叶可画、选组拒画（弹「图层组…」中文，多指 undo/redo 不被拦）。
- 存 .ora → 重载：树结构完整 + 组 props + active 还原（含 active=组）。导出 PNG / 缩略图与屏一致（组内层不丢）。
- 撤销/重做：编组/解组/移入移出/删组（叶回到原组同级位）/ 组内删叶 + 普通增删移合并。
- PSD 导出：组拍平、所有叶在（per-layer records 扁平）。float 仍正常（本批没动）。

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
