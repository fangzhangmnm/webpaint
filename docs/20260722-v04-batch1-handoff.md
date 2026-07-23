# 0.4 纪元重构 · batch 1 交接（→ batch 2 的开工文档）

> as-of v0.4.5 / 2026-07-22。写给下一个 agent：自包含，不依赖任何 session 记忆。
> 人类 spec（pin 死，不 re-litigate）= `journal/20260721 Architecture.md`。本文只是它的施工进度 + 路线图。

## 0. 一句话现状

0.4 = 渲染与 undo 大重构。**S0–S6 已全部 merge main（80bedc1，v0.4.7，2026-07-22）**：版本换制、
不可变 tile 池、后台压缩、workpiece/document-operator/配额制 undo、选区 tile 化（S5）、float 入
workpiece（S6）切换完成，803 node 测试 + tsc + esbuild 全绿；**全部未真机**。
**下一棒 = 真机批**（batch1 §3 + S5 报告 §3 + S6 报告 §4 三份清单同批交付），验完才动 S7
（S7 开工前对该片单独轻量 plan）。S7–S9 施工图在本文 §4。

## 1. batch 1 落了什么（新读者地图）

### S0 · 版本换制（v0.3.438 → v0.4.0）
`vN` 旧制改 `vM.m.p`（AI bump patch；major/minor 要人类点头）。`src/ora.ts` `parseAppVersion`
双制全序可比：旧 `vN` ≡ `v0.3.N`——**别再改回单捕获组正则**，否则 v0.4.x 解析成 0，所有旧 ORA
误报「文档由新版本写入」。

### S1 · cpu-tile-pool（`src/tiles/cpu-tile-pool.ts`）
不可变、引用计数的 256² tile 池，0.4 一切的底座。契约（红线级，池文件头注释是 SSoT）：
- tile 一经创建**只读**；`bytes()/clampedView()` 是零拷贝视图，读者绝不能写——要改就封新 tile。
- 句柄显式 `acquire()/release()`；UAF/双 release 立刻 throw；FinalizationRegistry 只当泄漏
  assert（上报 error-badge level "log"），不当析构。
- CPU 恒为 SSoT（raw 或 compressed 至少一种形态在池里）；GPU 侧永远只是缓存。
- raw 超 quota（384MiB）→ 创建时阻塞压缩最古老（宁卡不爆）。
- `tile-geometry.ts` 已从 `gl/` 迁到 `tiles/`（纯几何非 GL 专属；TILE_SIZE 唯一定义在此）。

### S2 · LayerPixels 换底（`src/gl/tile-pixels.ts`）
内部从 `Map<key, Uint8ClampedArray>` 换成 `Map<key, TileHandle>`，copy-on-write。
`snapshot()/restore()` = 句柄 acquire/release，**零拷贝**。js 无析构 → **dispose 纪律**：
LayerPixels 被替换/丢弃前必须 `dispose()`（现有落点：`Layer.setPixels/remapPixels`、
`doc.adoptState`、operator 内部、ora 解码丢 ctor 默认层、gl-doc-renderer surrogate tmp）。
漏网由池 FR assert 点名——看到 console 里 `[tile-pool] ... GC'd without release` 就是有人漏了。

### S3 · background-sync-jobs + 压缩；tile-residency 死
- `src/background-sync-jobs.ts`：空闲调度深模块（quota 表「停 x 秒给 y ms」、优先级降序轮询、
  requeue 排队尾、输入插队跑完当前即停）。app 接线在 `src/tile-jobs.ts`。
- `src/tiles/cpu-tile-compression.ts`：**同步双向** deflate（vendored `vendor/fflate`）。
  为什么必须同步：`bytes()` 是同步读，DecompressionStream 救不了；「后台化」靠 bg-jobs 按预算
  切片调 `compactOldest()`，不靠异步 codec。动漫向自定义编码（spec line 119-121）是后续候选，
  codec 注入可换。
- **`gl/tile-residency.ts` 已删**（备份→驱逐 CPU raw→GPU readback 重物化整条机器）：tile 不可变 +
  池内压缩驻留后它失去存在理由。context-loss 恢复现在 = 直接 syncAll 从 CPU 重传。
  dirty-never-evict 红线由池不变式自动满足。

### S4 · workpiece + document-operator + 配额制 undo（本批主菜）
- `src/workpiece/workpiece.ts`：聚合根（迁移期以 PaintDoc 为载体）+ `DocumentOperator` 基类 +
  写锁。privacy = 模块私有 WeakMap（不 export，模块外无路径达内部）；`mut()` 只在持锁的
  forward/backward 里合法。**operator 必须同步**（硬规则）。
- **对称 swap 契约**：`forward/backward` 都是「给 data、吐 replaced」——首跑 forward 交出 undo 包，
  undo 时 backward 装包并吐 redo 包，往复无衰减。两种执行形态：**事务型**（引擎先改，run 时带
  `_initialBefore/_initialOld`，如描边/选区/整 doc 变换）与**操作型**（forward 自己动手，调用方
  不得预 mutate，如层增删/移动/属性）。
- `src/workpiece/undo-history.ts`：microstep + checkpoint 整点（手势流 `{checkpoint:false}` +
  抬手 `sealCheckpoint()`；undo/redo 一次动一个整点）；`compound()` 原子回滚；
  **evict by maxQuotaBytes**（128MiB，整 checkpoint 粒度 + disposeData 释放句柄 + 每次 push 全量
  重扫——tile 被后台压缩后 usage 会**涨**，spec line 87-89）；**不可恢复协议**：operator 抛异常/
  backward 失败 → 弃整栈 + onUnrecoverable（error banner + 从当前文档态重建画面）——宁丢历史，
  不留半坏状态假装能撤（journal/WP feedback arch ~1777 的人类要求）。
- **快照底座深切**：`Layer.snapshot()/layerSpec/snapshotAll` 全换句柄形（`LayerSnap={pixels}`），
  undo 全同步，PNG-blob/createImageBitmap 舞蹈死；CPU 算法读者（液化 startSnap、选区
  applyMaskPostStroke）走新的只读物化 `Layer.snapshotImageData()`（老 imageData 形状，**不是**
  undo 包，别拿去 restore）。
- **死了的模块**：`src/history.ts`（UndoStack）、`src/pixel-edit.ts`、`src/layer-undo.ts`。
  37 个 push 点 → 10 个 operator 类（`src/workpiece/operators.ts`，每个 op 的头注释写明形态与
  句柄归属）。像素事务门面 = `src/workpiece/pixel-tx.ts`（`begin(layer,label)` 形状同旧 PixelEdit）。
- 副产品：复制图层变瞬时零拷贝（句柄共享 + CoW）。
- `scripts/build.sh` 新增分层 lint：workpiece/** 不 import store、tiles/** 不 import gl/**、
  已死模块不得复活 import。
- `wp:histchange` 事件契约不变（session-state 编辑门/undo 按钮态照旧吃它），由 app.ts 的
  onChange 接线派发。

### 行为样例 & 历史依据
- `test/operators.test.mjs`：各族 op 在真 PaintDoc 上的 do/undo/redo 像素级往返。
- `test/undo-history.test.mjs`：checkpoint/compound/配额驱逐/不可恢复/锁的契约。
- `docs/20260722-test-charter.md`：8 条历史 bug → 根因 → 新架构哪条保证杀死它（含
  「layer not synced:92」溯源、undo/session tile 不共享、leaky-GPU 模拟等 batch 2 测试维度）。

## 2. 已知取舍 / 暗坑（诚实清单）

1. 属性类（visible/mode/opacity…）undo/redo 的 per-prop toast 丢弃（v125 人类钉的「撤销建层要
   跳转+toast」保留在 Add/RemoveLayerRecordOp.statusFor）。
2. 删组走 TreeStructureOp（snapshotTree 活引用）：该 entry 被配额驱逐/截断时游离叶的句柄**不**
   dispose（多 entry 可能共享同批活引用，贸然释放会把别的 entry 的 undo 恢复成空层）。bounded
   泄漏（换文档 clearHistory+adoptState 时清），FR 可见。层级组件真正收进 workpiece internals
   （batch 2+）时给所有权解。
3. 点选图层不入 undo（现状 UX 保留；spec「active-layer 进 undo」按层级 op 内记录 prevActiveId
   理解——要改需人类拍板）。
4. lasso commit 中途某层消失时，后续层未消费的 `_initialBefore` 快照泄漏（commit 是同步的，
   几乎不可达；FR 兜底）。
5. worktree 里没有 node_modules 时 `build.sh` 会**跳过 tsc 门**（打印 ⚠）——在 worktree 干活要
   手动 `npx tsc --noEmit`。
6. vendor 新增 `fflate`（MIT，esm+d.ts 物理入库）——家规：不 npm install、不走 CDN。

## 3. 真机待验清单（batch 1，整批一次交付）

- 全工具 undo/redo：画笔/橡皮/像素笔、液化、滤镜笔（含带选区的描边——applyMaskPostStroke 新物化路径）。
- 图层全家：新建/删除（keep-one 护栏）/**复制（验 CoW：复制后改一层另一层不动）**/向下合并/
  移动/编组解组/移入移出组/显隐/透明度滑杆/混合模式/剪裁/锁α/重命名/参考层，各自 undo/redo。
- 选区全链：圈/矩形/圆/魔术棒、反选/全选/取消、填充/清除、扩缩、变换 lift→拖→stamp→commit、
  Enter/Esc、整链 undo（一次 undo 回整个变换）。
- 整 doc 变换：crop/flip/rotate/offset + undo（含 viewport 复位、尺寸标签）。
- 清空图层（顶栏菜单）+ undo。选区转新图层（复制/剪切两模式）+ undo。
- Blender 推拉贴图（blender-sync 改走 replaceFromCanvas）。
- 长绘画 session：内存曲线（后台 tile 压缩生效、undo 配额驱逐、无 FR 泄漏刷屏）。
- 切后台再回（visibilitychange compactAll）+ GPU context-loss 恢复（syncAll 直接重传）。
- 加密件开/存、云同步往返、v438 旧 ORA 打开无「新版本」误报。

## 4. batch 2+ 路线图（S5–S9 施工图）

（~~次序建议：先真机验完 §3 再动 S7~~ **已被用户 2026-07-22 拍板推翻：完整做完 S8+S9 再统一
真机，中途不插验收**——见 docs/20260722-v04-s7-session-handoff.md 的 Sequencing 节。）

### S5 · selection-mask tile 化 + 蚂蚁线深模块 ✅ 已落 v0.4.6 并 merge main（未真机；报告 = docs/20260722-v04-s5-selection-tiles.md）
- 目标：选区 = workpiece 内 gray8 tile 层（池 `"gray8"` 格式现成）；每次选区编辑 =
  SelectionMaskOperator checkpoint；蚂蚁线抽 `src/marching-ants.ts` 深模块（自持久化 outline
  缓存 keyed by commitVersion，重算走 background-sync-jobs；蚂蚁线不是 workpiece 的职责）。
- 动：`src/selection.ts`（maskCanvas 死，类变 reader 或删）、`selection-ops.ts`（per-tile 布尔
  运算，8-bit AA 边）、`input.ts`/`lasso.ts` 圈选路径、`fillOnLayer/applyMaskPostStroke` 改
  `materializeMaskRegion`/sampler 窄读口、brush 的 GPU 选区 mask 上传（先直传 tile 字节，S7 走 bridge）。
- cutover：maskCanvas + SwapSelectionOp 的 canvas 引用交换 → tile 快照交换。
- 测试：per-tile 布尔运算、bbox 聚合、outline 走线 golden 向量、与旧 canvas 路径的 AA 对拍；
  charter 里的液化选区边界测试在此落 **RED**（S8 转绿）。
- 风险：AA 视觉 parity（真机批）；大 mask outline 性能（bg-jobs 切片）。

### S6 · float 层入 workpiece ✅ 已落 v0.4.7 并 **merge main（80bedc1，2026-07-22）**，未真机；报告 = docs/20260722-v04-s6-float-workpiece.md。⚠ 行为变化：transform 期 Ctrl+Z=history、reject=identity 写回 stamp 保留、lift 即清选区——详报告 §2。下一片 = **S7，须先真机验完 batch1+S5+S6 再动 + 单独轻量 plan**）
**S5 交接给本片的硬约束**（详 docs/20260722-v04-s5-selection-tiles.md）：
- Selection 已是 gray8 tile + clone()/dispose() 所有权（对齐 LayerSnap）。lift 消费 doc.selection、
  commit 记 prevSelection 的链路今天是：commit() 把 doc.selection 交给 entry.prevSelection →
  input._commitLasso 喂 ops.selection（所有权归包）。S6 把 lift/stamp/accept operator 化时**必须
  沿用这条所有权链**，别让同一个 Selection 出现两个 owner（漏 dispose 由池 FR 点名）。
- 浮层源像素今天在 bakeSource 里走 `sel.materializeMaskCanvas()`（Canvas2D 过渡口）+ layer.canvas
  drawImage。S6 把 float tiles 收进 workpiece internals 时优先改成句柄交换（挖洞 = per-tile
  dst-out 也行，但 pixel-accurate 优先级更高——spec:222-223 reject 必须 identity 写回）。
- **一个 UX 未拍板**（spec:219 原文「恢复选区到新地方(或者清选区，看UX)」）：现状 = commit 清选区。
  S6 先保持现状（清），要改成"选区跟到新位置"需人类点头——别自作主张换行为。

- 目标：float 状态从 `floating-transform.ts` 的 `_ft` 私有态移入 workpiece internals
  （`floats: {id, tiles, transform, insertBeforeLeafId, sourceLayerId}[]`）；lift/调 transform
  （metadata 微步）/stamp/accept 全部 operator 化；**reject = identity 写回 operator（非 undo）**，
  pixel-accurate 句柄交换、不走 warp 采样器、stamp 保留（spec lines 220-225）。
- `floating-transform.ts` 保留 gizmo/单应性数学 + GPU warp 渲染；`lasso.ts` 手拼 entry 死
  （batch 1 已把 commit entry 减到 `{layerId, before}`，此片把 lift/stamp 也收进栈）。
- 测试：状态机各相位入栈整点；reject 像素精确（node CPU 路径）；组 lift 多 float z 锚点；
  lift→stamp→accept 序列 undo。
- 风险：与层级 op 的复合（挖洞 + 结构一个 compound）；GPU warp 预览要继续吃 workpiece 持有的 float tiles。

### S7 · render-tree + gpu-tile-pool + cpu-gpu-tile-bridge ✅ 已落 v0.4.8 并 merge main（2026-07-22，PR #8；未真机，总单=docs/20260722-v04-device-test-batch.md；报告 = docs/20260722-v04-s7-render-tree.md——含轻量 plan、两处偏差交代、真机待验、S8 交接。7a/7b/7c 全交付：pool+bridge+straight rgba8+render-plan+执行器+compositeOnce+golden 基线；gl-doc-renderer/tile-backend-gl/tile-store/tile-index 死）

（下面是开工前的原施工图，留档；现状以上一行+报告为准。）

### S7 · 原施工图（最重，分三小片）
- 7a `src/gl/gpu-tile-pool.ts` + `src/gl/tile-bridge.ts` 切上传路径：GPU tile 永不承诺 pin、
  随时 evict、用户注册 pin 回调（必须/建议两档）、batch-only 创建、大 FBO+bbox 批量
  readback（per-tile readPixels 太慢）、双向映射只防重复劳动、禁反查、resize=删→glFlush→重建
  （CPU 是 SSoT 丢 GPU 无妨）。旧 `tile-backend-gl.ts`/`tile-index.ts`/`tile-store.ts` 逐步死。
- 7b `src/render/render-plan.ts`（**纯规划，node 全测**）：输入 hierarchy + pseudoLayers
  （surrogate/float/笔刷预览统一，替代现在 gl-doc-renderer 的三个 ad-hoc 注入口）+ updatedNodes +
  requiredNodes → pass 列表 + 跨帧缓存集（updatedNodes、其兄弟、直系祖先的兄弟；兄弟合并策略
  小心剪裁基底须额外驻留，spec lines 144-155；多 updatedNodes 合并 = live2D 前瞻）。
  `src/gl/render-tree-gl.ts` 执行器替代 gl-compositor 编排 + gl-board 缓存。**gl-doc-renderer.ts
  （耦合结节）死**。undo/redo/commit → invalidate 合成缓存重算树（keyed by workpiece.commitVersion）。
- 7c：context-loss/evict 自愈（GPU tile missing 是日常事件）、export 专用一次性合成路径
  （不引入缓存）、tile 非预乘 rgba8 + FBO rgba8（现在是 f16 预乘 ping-pong——省一半显存，
  `blend-glsl.ts` 适配）。
- 测试：render-plan node golden（合并矩阵/clip 基底/requiredNodes 剪枝/失效）；charter 的
  **leaky-GPU 全量模拟**（fake backend 对抗性 evict，用户必须自愈，UAF 必 throw——参照
  `test/tile-store.test.mjs` 的 fake backend 模式）；**首次引入 SwiftShader golden 图像 hash**
  （`npm run smoke` 基建已有，golden 尚无——预乘→straight 的视觉回归靠它挡）。
- 风险：全重构最高。预乘转换可能移动混合视觉（先拍 before golden）；iPad 性能回归；三小片保持独立可交付。
- ⚠ 开工前值得对本片单独做一次轻量 plan：spec 的兄弟合并/驻留规则是需求级，实现级的数据结构
  （pass 列表形状、缓存 key、pin 回调协议）需要落定。

### S8 · 编辑逻辑迁移 ✅ 已落 v0.4.9（分支 worktree-v04-s8-s9-edit-migration，未 merge 未真机；报告 = docs/20260722-v04-s8-edit-migration.md）
- brush：live = doc-size FBO 单张方案（替换下方图层的 pseudo-layer，继承其合成模式）；commit =
  tile-diff（bbox+逐 tile 变更检测）→ bridge 批量 readback → SwapPixels/UpsertTiles；旧
  rasterize→presentTo→readPixels→canvas→editRegion 路径死。**手感数学（smoother/taper/gamma）
  是人类钉死区，一个字节不动。**
- 液化重写为 doc 空间 mask 采样 → **liquify-engine.ts:95-125 的「mask 按 layer.bbox 烤」bug
  从构造上消灭**（S5 落的 RED 测试转绿）；filter-brush 抽象类化（CPU 实现暂留）。
- 吸管 composite 模式 → render-tree 单帧 GPU read（杀 `board.ensureCompositeCache` CPU 合成）。
- checkpoint-autosave 改造挂本片（ora checkpoint、最小周期、写成功再删旧、副线程不支持就
  bg-jobs；spec lines 36-44）——**动它先跟人类对齐 workbench-session 归属**（spec line 26 明说
  「到时候我重新整理…好好想一下」）。
- 异步操作范式（SD 生成等）：await 期间不算 operator、锁 UI，图片到了走 new-layer operator，
  generative 一律写新图层（spec lines 241-242）——文档化即可，无 UI。

### S9 · 日落 + 改名 ✅ 已落 v0.4.10（同分支；体重合同未达标，诚实交代见 docs/20260722-v04-s9-sunset-weight.md §2；下一棒 = 真机总批，交接 = docs/20260722-v04-s8-s9-session-handoff.md）
- 删 `src/layer-composite.ts`（消费方 ora renderMerged/psd/session 缩略图/board 2D fallback →
  render-tree export 路径）；删 `reference.ts` 手抄扁平合成；Canvas2D 残余（materialize/editRegion
  收缩到 import/export 边界）。
- `editor-state.ts` → `workbench-state.ts` 改名（ORA 内 `.webpaint/editor-state.json` key 保持
  向后兼容）；`gl/tile-pixels.ts` → `tiles/tile-layer.ts` 归位。
- build.sh 给每个新死模块补防复活 grep。

## 5. 给下一个 agent 的开工方式

1. 读 `journal/20260721 Architecture.md`（spec，人类 pin）→ 本文 → `docs/20260722-test-charter.md`。
2. 红线照旧：`src/store/**` 改前 escalate；手感/UX/store model 人类钉死；错误全走 error-badge。
3. 每片开工：worktree 分支 → 轻量 plan（对着本文该片条目 + spec 对应行，S7 必须，其余可略）→
   施工 → `npm test` + `npx tsc --noEmit` 每 commit 绿 → bump `v0.4.x` patch → 报告 + 待验清单。
4. 别重跑 batch 1 那轮的全仓勘探——本文 §1 的地图 + 各新模块头注释已覆盖。
