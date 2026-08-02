# v0.8 recon A · undo/workpiece 现状勘探（易过期）

> as-of v0.8.0 / 2026-08-02
> 性质：Explore agent 勘探快照原样 dump + 少量拷问补充。file:line 会漂——信代码不信本文。
> 拍板与施工序在别处：ADR-0007 + `20260801-v08-epoch-handoff.md`（本文不取代它们，只补 grounding 细节）。
> 索引：`20260802-v08-recon-index-six-knights.md`

## 拷问补充（勘探后的三点结论）

1. **「undo 数据契约能否 app-agnostic」有答案雏形**：undo-history.ts 只 import workpiece 一个东西，栈机制已通用；卡点是 workpiece.ts 传递性 import PaintDoc/LayerPixels。泛型化 WorkpieceInternals（或把锁/commitVersion 5 个协作点抽接口）即可搬给 3D app。承重对象（tile/geometry 句柄）的生命周期由「operator 自带 disposeData」契约承载——不用发明新机制。
2. **「用户自定 checkpoint 聚合原子操作」机制已存在**：history.compound + handoff S1 的 `{checkpoint:false}` 透传。
3. **建议**：PaintDoc→workpiece 语义改名波及大（见 §2），rename 单独成片、不与语义手术同 commit。「顺手修」树快照 bounded 泄漏会造出双 dispose（handoff §3 已点名的雷）。

---

## 以下为勘探原文（2026-08-02）

### 1. undo 数据契约现状

一个 undo entry = `Microstep { op, args, data, checkpoint, label }`（`src/workpiece/undo-history.ts:17-23`）。`data` 是「当前方向的逆包」，**绝不是纯 JSON**——按 operator 族不同持有：

- **tile 句柄快照 `LayerSnap`**：`SwapPixelsOp`（`src/workpiece/operators.ts:45-79`）、`MergeDownOp` 的 `underBefore`（operators.ts:315-319）。池驻留、可压缩，配额估计规则「压缩前记 0（走共享 raw 池配额），压缩后 = compressedBytes/refCount」（operators.ts:23-32，undo-history.ts:7-8）。
- **活 `Selection` 对象**（自身持 gray8 tile 句柄，有 `dispose()`，双 dispose 即 throw）：`SwapSelectionOp`（operators.ts:81-125；`src/selection.ts:102-134`）。
- **`LayerSpecShape`**（层规格 + snap 句柄）：`AddLayerRecordOp`/`RemoveLayerRecordOp`（operators.ts:203-275）。
- **树快照（含活叶引用！）**：`TreeStructureOp` 的 `args.before/after` 保活引用、零像素拷贝，已知取舍——驱逐时游离叶句柄**不** dispose，bounded 泄漏，注释明说「层级组件真正收进 workpiece internals（后续切片）时给出所有权解」（operators.ts:290-295）。
- **深快照 `DocSnapAll` + viewport + persp 不透明包**：`DocTransformOp`（operators.ts:365-401）。
- **浮层 `FloatState`（`LayerPixels` 句柄）**：float-ops，所有权「internals ↔ undo 包整体移交」（`src/workpiece/workpiece.ts:18-30`）。
- **纯 JSON 值**：`LayerPropOp`/`ReferenceLayerOp`/`FillColorOp`（operators.ts:127-199）。

没有 ImageData / GPU 资源直接进栈（ImageData 只在 `pixel-tx.ts` 的 `snapToImage` 按需物化给选区 finalize，不入栈，`src/workpiece/pixel-tx.ts:20-31`）。

**谁负责 dispose**：契约 = `DocumentOperator.disposeData(args, data)`（workpiece.ts:137-138）。UndoHistory 在四个时机调 `_disposeStep`（undo-history.ts:208-210）：截断 redo 段（:60-63）、`clear()` 弃整栈（:145-151）、compound 回滚弹栈（:185）、配额驱逐（:196-206）。operator 侧「消费即 dispose」：`SwapPixelsOp._install` restore 后立即 `disposeLayerSnap`（operators.ts:66-71），句柄纪律钉在文件头（operators.ts:11-12，「漏网由池 FR assert 点名」）。

**app-agnostic 程度**：`undo-history.ts` 只 import `./workpiece.ts` 的 `Workpiece, DocumentOperator, OpStatus`（undo-history.ts:15），自我声明 DOM-free（:13）。对 Workpiece 依赖只有 5 个协作点：`_acquireLock/_releaseLock`（:48,56）、`_bumpCommit`（:71,113,129）。paint-specific 是传递性的：workpiece.ts:15-16 import 了 PaintDoc 和 LayerPixels。

### 2. 命名审计：runtime 里叫 doc 的东西

| 现名 | 位置 | 按新术语 |
|---|---|---|
| `class PaintDoc` | `src/doc.ts:407` | workpiece 本体（workpiece.ts:11-12 自认「迁移期形态：internals 以现有 PaintDoc 为载体」） |
| `src/doc.ts` 文件 | 1225 行 | runtime 模型（Layer/LayerGroup/树/快照），非持久格式 |
| `ctx.doc: PaintDoc` | `src/app-context.ts:103` | ctx.workpiece 已并存（app-context.ts:107），双轨 |
| `readDoc()` | workpiece.ts:75 | 迁移期 escape hatch，仅 3 调用点（floating-transform.ts:390,455） |
| `WorkpieceInternals.doc` 字段 | workpiece.ts:52-53 | 每个 operator 的 `this.mut(w).doc` 都摸它 |
| `DocumentOperator` | workpiece.ts:117 | 25 处引用 / 4 文件（全在 workpiece/ 内） |
| `DocTransformOp` / `"docTransform"` / `DocSnapAll` | operators.ts:366-373 | 36 处引用 |
| `src/doc-ops.ts` | 468 行 | workpiece-level geometry ops 的 app 胶水 |
| `src/doc-render.ts` | 26 行 | 合成的是 runtime 树 |
| `bumpDoc` signal | signals.ts，13 处 | |
| `LoadedDoc` | session-state.ts:47 | 接近合法（「刚从 .ora 解码出来的东西」），但类型是 `PaintDoc &` 扩展 |

**波及面数量级**：`PaintDoc` 显式引用 63 处 / 17 文件；从 doc.ts import 的文件 30 个；`ctx.doc`/`C.doc` 21 处；全字 doc token 共 1346 处 / 85 文件（上界，含大量「per-doc」「doc 坐标」注释——语义仍成立不必改）。机械改名量级 ≈ 低几百处；`ctx.doc` 单例名是大头（~20 个深模块 `let doc; initX(ctx)` 模式接线）。

### 3. editor-state / workbench-state 内容清单

文件 `src/workbench-state.ts`（398 行），两块刻意同居（:1-4）：

**① `createEditorState()` 反应式 RAM SSoT**（:27-88）：toolStates（brush/eraser/filterBrush/selPen 各 size/opacity/activeBrushId，:31-42）、filterBrush 瞬态、color、longPressPick/singleFingerDraw（**跨设备 synced 偏好，不是 per-doc**，:50-54）、pickMode、checkerboard、dialReactive 的 tool/color/canDraw/pressureOff（:64-69）。

**② `editorState` struct = per-doc desk**（:113 起），`freshGroups()` 即字段清单（:137-198）：export、colorPanel/layersPanel/refPanel/blenderPanel（enabled+position）、brushTool、magicWand（含 lineart 5 knob）、lassoTool/fillTool、shapeBrush、persp（VP 槽位+box）、grid、crop.templateId、liquify、colorPicker、viewport、checkboard、pressureDisabled。

**分类**：
- **应被 undo 管的**：active layer 和 selection **不在这里**——在 PaintDoc 上（doc.ts:411,413），且 selection 已被 SwapSelectionOp 管、referenceLayerId 已被 ReferenceLayerOp 管。desk 里唯一沾 undo 的是 `persp`：不自持 undo，随 DocTransformOp 信封 snapshot/restore（workbench-state.ts:389-398，operators.ts:368-370「undo/redo 必须一起还原否则透视静默错位」）；以及 fill 预览期的 color（FillColorOp，operators.ts:173-176 明说「当前色是 desk 态，workpiece 不碰 editorState」）。
- **画室状态**：viewport、toolStates/brushTool dial、magicWand/lassoTool/fillTool/shapeBrush/liquify knob、grid、persp、pressureDisabled、checkboard。
- **纯 UI**：四个 panel 的 enabled/position、export 对话框记忆、crop.templateId、blenderPanel.show。

**「别把 dirty 加回来」钉子原文**（workbench-state.ts:122-131）：

> ⚠desk 没有 dirty 标记（v409 决策，撤销 v407 的 workspaceDirty 设计）：
>   desk 改动不标脏、不触发保存、不触发退出推云。只有内容脏（history 的 wp:histchange）或用户显式按
>   save 才落盘；落盘时顺手把当前 desk 捞进快照。代价（用户 2026-07-14 明示接受）：只拖面板/只换笔、
>   不画、不按 save 就退出 → desk 改动丢失，下次开 revert 到上次保存的快照。
>   历史：v407 曾有 workspaceDirty + setDirtyFlag() callback，用来让「push 是否 no-op」的判定含 desk 改动。
>   v409 定了①退出只有 contentDirty 才推②按 save 无条件 encode+push（时间戳必须动）→ 该标记零 reader → 删。
>   别再加回来，除非先推翻①或②。
>
> setter 纪律（同 collection 浅拷贝）：整枝赋值 position/viewport（`x.position = {...}`），别原地改子对象字段。

### 4. workpiece 接口 vs god-object 起点

`Workpiece` 类本身很瘦（workpiece.ts:59-104）：isDirty、commitVersion、readDoc()、readFloatState()、dropFloats() + 协作面 `_acquireLock/_releaseLock/_isLocked/_bumpCommit` ≈ **9 个成员**。

「40 方法 god-object」真身 = **PaintDoc：约 39 个公共方法/getter + 7 个公共字段**（doc.ts:407-1180）。天然分块（= component 化切法）：

1. **LayerTree 结构**（~19）：addLayer/removeLayer/insertLayerAt/moveLayer/canMoveLayer/duplicateLayer/addGroup/groupSelection/ungroup/moveIntoGroup/moveOutOfGroup/locateNode/findLayer/snapshotTree/restoreTree/collapseGroupToLayer/explodeLayerToLayers/stampAllToTopLayer/mergeDownLayer（doc.ts:554-910）
2. **active/reference 焦点**（~8）：activeLayer/activeIndex/setActive/setActiveById/activeEditableLeaf/activeNodeHidden/getReferenceLayer/getFloodSourceLayer（doc.ts:463-536）
3. **Selection**：`selection` 字段（对象在 selection.ts，op 在 SwapSelectionOp）
4. **整体几何变换**（~7）：cropResampleTo/cropTo/flipHorizontal/resampleTo/offsetWrap/snapshotAll/restoreSnapshotAll（doc.ts:970-1180）
5. **生命周期/内存**（~4）：adoptState/configureMemory/maxLayers/clearActiveLayer
6. **Float**：已收进 workpiece internals（workpiece.ts:18-55）

即 LayerTreeComponent + SelectionComponent + GeometryComponent + FocusComponent ≈ 4-5 块。operator 注册表已有 14 op（operators.ts:404-419），`history.run/compound` 调用点 47 处 / 13 文件。

### 5. sidecar 现场

- 参考图：`setReferenceFromFile` decode → ≤2048² 缩放 → `referenceWindow.setBitmap(fit.source, { persistBlob })`（side-windows.ts:116-124）；存盘时 `_buildOraMeta()` 捞走 `{ referenceImage, webpaintState, editorState }`（session-state.ts:146-152）；载入 `loaded._referenceBlob` → createImageBitmap → setBitmap（session-state.ts:118-124）。
- 调色板：`paletteWindow.getSerializedState()` 进 `webpaint/state.json`（session-state.ts:101），载入 applySerializedState（:125）。
- **伪造 wp:histchange 全仓唯一存活点** = side-windows.ts:125-127（`session.markEdited(); updateSaveStatus(); dispatchEvent(wp:histchange)`——参考图变更无合法标脏通道逼出来的；canUndo/canRedo 用真值填充所以按钮态不被污染）。`session.markEdited()` → `es.markDirty()`（session-state.ts:580，注释「导入/blender/参考窗」——现在只剩参考窗一个正当用户）。import-image 已改真 history.run（import-image.ts:191-193）；blender-sync 走真 tx.commit（blender-sync.ts:305-309）。
- **sidecar 候选全家福**（跟 ora 走不进 undo）：①参考图 blob ②调色板画布状态 ③旧轨 `webpaint/state.json`（color/toolStates 含 eraser/filterBrush 只在这一轨/checkerboard/activeId；**双轨都写**，session-state.ts:95「两处都写」）④新轨 `.webpaint/editor-state.json` = 整个 desk（workbench-state.ts:350-358）⑤viewport/checkboard：真 SSoT 在 board/state，存盘时 `syncRuntimeForSave` 单向镜像进 desk（:339-343,364-366）。
- **两个跨界者要单独裁决**：`persp`（desk 态但被 DocTransformOp undo 信封捎带）；`doc.activeId`（workpiece 态但经旧轨 state.json 持久化）。
