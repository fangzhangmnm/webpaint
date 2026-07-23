# 0.4 batch 2 · S8 —— 编辑逻辑迁移（轻量 plan → 施工报告）

> as-of v0.4.8 起工 / 2026-07-22。上游：`docs/20260722-v04-s7-session-handoff.md`、
> `docs/20260722-v04-batch1-handoff.md` §4-S8、spec `journal/20260721 Architecture.md`
> （编辑逻辑 :187-247、autosave :36-44、异步操作 :241-242）、S7 报告 §3（交接点）。
> 分支 `worktree-v04-s8-s9-edit-migration`（基 main=3d1d7b8，v0.4.8）。
> 体重基线：v0.4.0=23,280 / 现 24,658 实质行（秤 `tools/count-src-loc.py`）；S9 合同 ≤23,280。

## 0. 轻量 plan（实现级决策，对 spec 需求逐条落地）

### 施工次序

1. **S8a** brush commit 走 GPU merge + bbox readback + tile-diff（spec:199-205）。
2. **S8b** 液化 doc-space mask 重写（H7 RED×3 转绿）+ filter-brush 抽象类统一（spec:206-207）。
3. **S8c** 吸管 composite 模式走 GL 一次性合成（spec:243-244）；board 合成缓存 cluster 死。
4. **S8d** checkpoint-autosave 机械最小（spec:36-44）：encode 走不可变 tile 快照 + bg-jobs 驱动。
5. **S8e** 顺手项：board 冗余 hint 拆除、描边中不全局失效、SD 异步范式文档化。

### S8a · brush live/commit（spec:187-205 逐条）

**现状**：live 已全 GPU（collectStamps → GLStampRasterizer instanced → overlay 叶 pass，
shader 内裁 selection/lockAlpha/erase/blendMode/Π-outer opacity）；**commit 却走另一条数学**：
rasterizeStrokeToCanvas（GPU 栅格 → readPixels → canvas）→ `brush._commitStrokeCanvas` →
`layer.editRegion` 的 **Canvas2D** globalAlpha/globalCompositeOperation 合成 → 选区靠
commit 后 `applyMaskPostStroke` CPU 兜底。live 与 commit 的合成引擎不同 = 潜在观感漂移源。

**落法（shader SSOT，零新 shader）**：
- 「合成好的图层数据」FBO = 现有 overlay 叶 pass 打进**透明底 fresh acc**、mode=source-over、
  opacity=1、无 clip —— 数学上恰好输出 merged(base tiles ⊕ stroke)，与 live 显示逐位同源
  （spec:81「commit和live可以用同一个shader, ssot」的直译）。
- ready（spec:189-192）：base tiles 经 bridge 搭 render-tree 便车（`_syncLeafSafe` 命中已上传
  tile 零动作）；选区 = 现有 R8 bbox 平面上传（`Selection.bboxMask()` 懒缓存 + 纹理身份缓存，
  一笔一传）。**per-tile 选区上传不做**：要第二座 R8 tile 池，S7 已判不值，等真机数据说话。
- live（spec:193-198）：保持现有单 pass「overlay 叶」形态。对 spec「FBO 成为 pseudo-layer
  替换下方图层」的读法：overlay 叶 pass 本身就是「该层贡献 = merged(base⊕stroke) 按层
  mode/opacity 入栈」——替换语义已成立，只是 merged 不单独物化一张 FBO（少一张 doc-size FBO
  + 少一个 pass，与 spec「用一张的，简单，省内存」同向）。
- commit（spec:199-205）：`RenderTreeGL.commitBrushStroke()`——
  1. sync 叶（搭便车）→ 栅格化最终 stamps（含 tail/taper）→ merge pass → merged FBO；
  2. bbox 一次 readPixels →（新纯函数）`applyRegionDiffToTiles`：逐 tile 与现有 tile 字节
     **memcmp，只 putTile 真变的 tile**（undo 不背未变 tile；部分覆盖 tile 与旧字节先合再比）；
  3. 变更 tile 当场 `copyBatchFromFramebuffer` 入 GPU 池 + `bridge.registerPair` ——
     **activeLayer 的 GPU 驻留不再依赖「render-tree 会 pin updatedNodes」的隐式契约**
     （spec:205 的思考题答案：commit 时双侧同建，下一帧 sync 走身份命中零上传）。
- 死掉：`rasterizeStrokeToCanvas` readback-canvas 路、`brush._commitStrokeCanvas`（Canvas2D
  合成）、GL buffered brush 的 `applyMaskPostStroke` finalize（shader 已裁，live=commit 由构造保证）。
  pixelMode brush 仍 CPU immediate + finalize 兜选区（行为不变）。
- undo 集成不变：PixelTx begin/commit（before 句柄快照 → SwapPixelsOp）原样。

### S8b · 液化 doc-space mask（spec:206-207 + charter H7）

- 病灶（liquify-engine.ts:100-123）：selection mask 在 beginStroke 按 **layer.bbox** 烤成
  固定平面，`cellIn` 对平面外一律 false → 推出旧 bbox 的像素误判「选区外」= 半拉。
- 重写：mask 平面改为**与 dispField 同一块可增长 doc-space bbox**（`_growDispField` 时同步
  增长、增量区 `selection.materializeMaskRegion` 补烤）——判定基底 = doc 空间，与 layer.bbox
  彻底解耦，H7 从构造上消灭。bleed 三模式（import/clip/edge 整数 cell march）逻辑原样保留。
- selection-tiles.test.mjs 的 3 条 H7 `todo(...)` 转真测试（node 跑引擎：mock layer +
  ImageData shim；bilinear 已有先例）。
- filter-brush 抽象类（spec:207）：LiquifyEngine 收编为 BrushFilter 形状
  （beginBrushStroke/extendBrushStamp/…），液化走 FilterBrushEngine 统一 dispatch，
  input.ts 的 `_beginLiquify` 特例死。CPU 实现暂留（spec 原话）。

### S8c · 吸管（spec:243-244）

- `input._samplePick` composite 模式：`board.ensureCompositeCache()`（CPU compositeLayers
  全量合成 + getImageData）→ `board.pickCompositeColor(ix,iy)` = GL `compositeOnce`（S7 已
  交付的一次性合成，不建缓存）+ readPixels 1×1。GL 失败态返 null（v351 起本来就「需 WebGL2」）。
- board 的合成缓存 cluster 整体死：`ensureCompositeCache`/`_compositeCache(Dirty)`/
  `_layerCompositeOpts`/`_getEraseComposite`/`_getClipTmp`/`_drawDocBg`/`_drawCheckerboard`
  （GL 合成器有自己的棋盘 shader）——board 与 `layer-composite.ts` 断开（S9 全删的前置）。

### S8d · checkpoint-autosave 机械最小（spec:36-44）

现状盘点：autosave 编排已在家族共享 editor-session（3min interval + visibility/pagehide/blur
+ exit push + v417 失败回滚），revert checkpoint 在 checkpoint-policy/session-state（开画那刻
封存，语义与本条独立）。缺的机械件：

1. **存档一致性**（spec:41「阻塞锁 workpiece 写，不锁读」的达意实现）：`encodeDocToOra` 是
   async、逐层 await PNG——编码中一笔 commit 会撕裂存档（前几层旧、后几层新、stack.xml 更旧）。
   落法 = **不可变 tile 句柄快照**：encode 入口同步冻结 {结构元数据 + 每叶 PixelsSnapshot}
   （O(tiles) 引用计数，零拷贝），编码全程读快照——tile 只读 ⇒ 后续任何写都是 CoW 新 tile，
   快照内容物理不可变。**比阻塞写严格更优**（既一致又不打断用户），与 spec 字面的「锁写」
   是偏差 → 进拍板清单待追认，不阻塞。
2. **不折腾 idb / 不在描边中 encode**（spec:40/42）：autosave 的 interval tick 改经
   background-sync-jobs 低优先级 handler（min-period 门 + dirty 门），输入插队自然让路；
   visibility/pagehide 抢救路径保持直调（崩溃安全优先于节流）。
3. **写成功再删旧**（spec:39）：本地落盘 = store 同 key IDB put，事务原子替换（旧值只在
   新值写成时才消失）——已满足，测试钉住语义即可。isDirty（spec:44）：v417 失败回滚已守，
   补 node 测试。

归属：挂现有 session-state/editor-session 不动窝（handoff 拍板默认，workbench-session
重组留给用户下一轮）。

### S8e · 顺手项

- **hint 机器拆除**（S7 遗留）：`forceGLResyncUnderFloat`/`_wasFloatActive`（执行器已忽略
  forceSync → 真死，删两个调用点 + 管道）。**liveSyncProvider 勘探结论：不是冗余**——它是
  执行器 updated 集的喂口（原地引擎的叶不进段缓存靠它），保留。
- **描边中不全局失效**（S7 报告承诺的「液化每帧 sb0」实际没成立）：`markDocDirty` 在原地
  描边中每 move 都 `markContentDirty` → **全段失效每帧重建**。改：活动原地描边期间
  markDocDirty 只 requestRender（叶已在 updated 集、contentVersion 自会重传变更 tile），
  抬笔 commit 的 invalidateAll 才全失效。
- **SD 异步操作范式**（spec:241-242，文档化无 UI）：见本文 §SD。

### 测试

- node：`applyRegionDiffToTiles`（满/部分覆盖、擦空、无变化零 putTile）；液化 doc-space mask
  H7 3 条转绿 + bleed 三模式回归；autosave frozen-encode 一致性（encode 中途 mutate，产物
  = 冻结时刻）+ min-period/bg-jobs 调度 + isDirty 门。
- smoke（SwiftShader 真 GL）：**GPU commit ≡ live** ——同一 stroke 的 commitBrushStroke 产出
  tile vs overlay live pass readback 逐像素（选区/erase/lockAlpha/blendMode/opacity 矩阵）；
  吸管 pickCompositeColor vs CPU compositeLayers 采样点 parity。

### 不做（诚实边界）

- 选区 per-tile GPU 池（见 S8a，等真机数据）。
- 液化/滤镜笔迁 GPU（spec:207「现在可以先 cpu 算」）。
- brush live 改独立 merged-FBO pseudo-layer 物化（见 S8a 读法论证——替换语义已成立）。
- reference-gallery 归属（spec:26 留空，S8/S9 不碰）。

## §SD · 异步操作范式（spec:241-242 的文档化，无 UI 无实现）

需要不定长等待的操作（Stable Diffusion 生成、未来任何网络推理）：

- **await http 期间不算操作、不进 undo、不碰 workpiece**——只锁 UI（busy 面）。
- 结果到达后才调 operator：**generative 输出一律写入新图层**（AddLayer + upsert tiles 一个
  compound checkpoint）。改图也一样：旧图层隐藏、新图层写入——绝不 in-place 覆盖用户像素。
- 等待期间用户强退/崩溃 = cancel（家规 interrupt=cancel）：无半成品持久化。
- kill-previous-job：重量在线预览（spec:239-240）用 float 层 last-write-win，杀旧任务起新任务。

## 1. 施工记录（v0.4.9 / 2026-07-22 完工；839 node + tsc + SwiftShader smoke 全绿）

> 分支 `worktree-v04-s8-s9-edit-migration`；commit 链：ad94548(S8a) → b8ab867(S8b) →
> e0e1607(S8c) → 4ed5e11(S8d) → S8e → 版本 bump。§0 计划全部落地，偏差见下。

### 落了什么

1. **S8a**：`RenderTreeGL.commitBrushStroke`（merge = overlay 叶 pass 打透明底/source-over/op1
   → bbox readPixels → `Layer.applyRegionDiff` 只封真变 tile → `copyBatchFromFramebuffer` 入池
   + `registerPair` + 叶记录就地更新）。**commit ≡ live 逐位一致（smoke 五用例 maxΔ=0）**——
   旧 Canvas2D commit 与 GPU live 是两套合成引擎，从此同一个。收养后下一帧 sync 零上传
   （断言过）。死：rasterizeStrokeToCanvas 链、brush._commitStrokeCanvas、GL buffered brush 的
   applyMaskPostStroke finalize、glMode 旗标。
2. **S8b**：液化 mask 改 doc-space 平面（与 dispField 同 bbox 同步长、平面外回落
   `selection.sampleAt`）→ **H7 三条 RED 转绿**（test/liquify-docspace-mask.test.mjs 四条真像素
   测试，node 全跑）。**考古发现**：v132 起液化真身已走 filterBrush（plugins/liquify.ts 的
   BrushFilter），input 的 role="liquify" 直连 LiquifyEngine 是**无人触发的死双轨**（没有任何
   代码再 setTool("liquify")）——整条删除（input/engine-registry/pointer-route/edit-mode/toolbar）。
   「filter-brush 抽象类」的落点 = 既有 BrushFilter 契约 + FilterBrushEngine dispatcher 成为唯一
   路径（TS interface 即抽象类，无共享实现时更薄）；CPU 实现暂留（spec 原话）。
3. **S8c**：吸管 composite 模式 = `RenderTreeGL.pickColor`（compositeOnce + 1px readback，
   底与显示同源）。board 合成缓存 cluster 死（ensureCompositeCache/_compositeCache/
   _layerCompositeOpts/erase/clip tmp 池/_drawDocBg/_drawCheckerboard）——board 与
   layer-composite.ts 断开。行为注：调整面板开着时吸管取的是真像素非 surrogate 替身
   （旧缓存路径喂替身；吸管与调整面板在 UI 上互斥，实际不可达——真机批顺手确认）。
4. **S8d**：`doc.freezeDocForEncode`——encode 入口同步冻结{结构 + 每叶 tile 句柄快照}（零拷贝），
   ora bytes 与 peek 读同一冻结视图；**修掉一类真损坏**：encode 逐层 await 中的结构操作会让
   stack.xml 与 layer PNG 列表错位（最坏解不开）。autosave 从 setInterval 改挂
   background-sync-jobs（输入插队让路 + makeAutosaveGate min 周期）；visibility/pagehide 抢救
   直调不受节流。「写成功再删旧」= store 同 key IDB put 事务原子替换（无先删窗口）。
5. **S8e**：forceGLResyncUnderFloat/_wasFloatActive/render 死参数拆除；
   `markDocDirty` 在原地描边中不再全局失效段缓存（真正兑现「液化每帧 sb0」）。

### 与 §0 计划 / handoff 的偏差（诚实交代）

- **liveSyncProvider 没拆**：handoff S8 条目把它列进「冗余 hint」，勘探结论相反——它是执行器
  updated 集的喂口（原地引擎的叶靠它不进段缓存）。拆了功能不坏（每帧全段重建兜底）但性能退化。
  保留，并借它做了 markDocDirty 的描边中免全失效。
- **brush live 未改独立 merged-FBO 物化**：现行 overlay 叶 pass 已是「替换下方图层」语义
  （见 §0-S8a 论证）；commit 用同一 shader 重跑一次（含 tail/taper 的最终 stamps）→
  「live 即 commit 所见」由 smoke maxΔ=0 钉死。少一张常驻 doc-size FBO。
- **选区 per-tile GPU 上传不做**（§0 已声明）：R8 bbox 平面 + Selection 不可变身份缓存已零重复
  上传；per-tile 需第二座 R8 池。等真机数据。

### 测试落点

- node（839）：applyRegionDiff ×5、液化 doc-space ×4（含 bleed 三模式回归）、freeze ×4、
  autosave gate ×2、engine-registry/pointer-route 死双轨清理后的回归锁更新。
- smoke：commit≡live 五用例（wash/buildup/erase/multiply+lockAlpha/selMask）全 maxΔ=0 +
  收养零上传断言 + pickColor vs golden（maxΔ=1）。

## 2. 拍板累积清单新增（并入 handoff 总清单，不阻塞）

1. encode 一致性用「不可变 tile 快照」而非 spec 字面的「阻塞锁 workpiece 写」（spec:41）——
   效果严格更强（一致 + 不打断用户），待追认。
2. 吸管在调整预览中取真像素（非 surrogate；见 S8c 行为注）。
3. 液化死双轨删除后 undo 历史标签统一为 "stroke"（旧 "liquify" 独立事务类型随之退役，
   UI 无感知——该 label 无 UI 面）。
