# 0.4 batch 2 · S6 —— float 层入 workpiece（施工报告）

> as-of v0.4.7 / 2026-07-22。上游：`ai-docs/20260722-v04-batch1-handoff.md` §4-S6（含 S5 交接硬约束）、
> spec `journal/20260721 Architecture.md`（:208-230）。
> 落在分支 `worktree-v04-s6-float-workpiece`，**未 merge main、未真机**。803 node 测试 + tsc + esbuild 全绿。

## 1. 落了什么

### float 状态入 workpiece internals（workpiece.ts）
- `WorkpieceInternals` 增 `floats: FloatState | null`：
  `{ floats: [{id, sourceLayerId, rect, pixels: LayerPixels}], transform: {gizmoBbox, mesh, meshN, mode, uniformAspect} }`。
  像素 = doc 网格对齐稀疏 tile（共享池 → 自动吃 S3 后台压缩；undo 按压缩字节计费）。
- 窄读口 `Workpiece.readFloatState()`；换文档 escape hatch `dropFloats()`（input.clearHistory 调）。
- 所有权纪律：`FloatState` **整体**在 internals ↔ undo 包之间移交（同一时刻一个 owner），
  prevSelection 沿 S5 的链 doc.selection → lift 包 → undo 时装回 doc。漏 dispose 由池 FR 点名。

### 新深模块 `src/workpiece/float-ops.ts`（3 operator + 像素纯函数，node 全测）
- **LiftFloatOp**（操作型，一个整点）：(清选区 + 建 float tiles + 源层挖洞)。bake 全成才 mutate（原子）；
  对称 swap 三元组 {floatState, 源层快照, selection}。`ignoreSelection` 供导入图片整层 lift。
- **FloatTransformOp**：只 swap transform metadata（纯数值）。每次拖动手势 / 模式切换 = 一个整点。
- **DropFloatOp**：浮层收摊微步（accept/reject 共用），floatState internals↔包换向。
- 像素路径全 typed-array（`materializeMaskRegion` gray8 + getRegion/putRegion）：**lift 链上的
  `materializeMaskCanvas()` Canvas2D 过渡口退场**（S5 报告点名的目标）；挖洞 = a·(255−m)/255
  （dst-out 等价，免预乘取整损耗）；全透明 tile 由 putRegion 自动回收（GL dirty 路径同旧 editRegion）。
- reject 的 `composeIdentityWriteback`：straight-alpha source-over，**不走 warp 采样器**，
  语义 ≡「identity 变换下的 commit」——stamp 保留、float 落其上（spec:220-225）。

### floating-transform.ts 降级为 gizmo 引擎 + operator 编排
- 单应性/约束数学（MODES/quadWarp/sourceWarpMatrix）原样保留；`_floating` 私有态死。
- `_live` = 拖动热路径的本地网格（每 move 零 operator，抬手 `endDrag` 才把 metadata 整点入栈——
  同 stroke 的事务型节奏；空拖不产生整点）；undo/redo 后 `syncFromWorkpiece()` 重采纳。
- stamp/accept（commit）/reject（cancel）= compound：pre-applied 烤层走 `ops.pixels`（事务型，
  与描边同路径）+ `DropFloatOp` 收尾。stamp 烤制仍走 GPU warp bakeFn（与 live 预览同采样器）。
- 渲染视图 `current()` → `{sources:[{layerId, canvas, rect}], gizmoBbox, mesh, meshN, mode}`：
  canvas = float tiles 的懒物化（WeakMap 按对象身份缓存，不可变即自失效）——**GPU warp 预览吃的
  就是 workpiece 持有的 float tiles**（S7 bridge 化时改 per-tile 上传，缓存点已隔离在
  `floatSourceCanvas()` 一处）。
- `bakeSource` 死；`lasso.ts 手拼 entry` 死（input._commitLasso 收缩成 `lasso.commit()` 一行）；
  `_makeFullLayerSelection` 死（导入走 lift 的 ignoreSelection+fallbackFullLayer，不再手写
  doc.selection——顺手修掉旧路径覆盖选区不 dispose 的泄漏）。

### undo/redo ↔ UI 对账（transient-panels.ts reconciler）
- lift/drop 都在栈上 → undo/redo 会让浮层凭空出现/消失。`scheduleFloatTransientSync`（histchange
  → 微任务，幂等）把 lasso._state / 引擎 live mesh / editMode transient / 面板抑制对齐 workpiece：
  redo 进 lift → 自动进 transform transient（同按钮路径全套）；undo 过 lift → 静默退出（不跑 apply/abort）。
- app.ts onApplied：浮层活动中 undo/redo 改了源层像素（撤 stamp/reject）→ `forceGLResyncUnderFloat()`
  强制重传（livePreview 门会挡 syncAll，借 v360 盖印同机制）。

## 2. 行为变化（spec 钉的 + 诚实清单，真机重点）

1. **transform 期间 Ctrl+Z = history undo**（spec:214；`CAPS.transform.ctrlZ` "abort-transient"→"history"）：
   逐整点回退 拖动→stamp→lift，undo 过 lift 自然退出浮层。**取消浮层 = Esc / 取消按钮**（reject）。
   redo 在 transform 期间开放。crop/adjust 的 ctrl-z=取消**不变**。
2. **reject（cancel）语义变**（spec:220-225）：旧 = preSnap 完全还原（stamp 也回滚）；
   新 = identity 写回（stamp 保留、float 落其上），本身是可撤销整点。
   ⚠ AA 半透明选区边缘：lift(cut)→reject 往返有覆盖率损失（挖洞+盖回的合成数学固有，
   与「identity commit」完全一致；binary 硬边选区逐字节精确）。spec 已预认（"不一定和一开始一样，
   不要缓存"）；真机若觉得刺眼需人类拍板另案。
3. **lift 即清选区**（spec:213）：float 期间 doc.selection=null（旧：挂着不可见直到 commit 才清）。
   undo lift 选区回来；reject 后选区不回来（要回去按 Ctrl+Z）。accept 保持现状「清」（UX 待拍板项未动）。
4. lift/挖洞成为栈上整点 → **保存状态在 lift 时就标脏**（histchange 早于旧版）。autosave（implicit）
   在 transient 中跳过（原有守卫）→ 不会把「有洞没浮层」的状态偷偷落盘；显式保存先
   applyPendingTransient 烤进（原有）。
5. 浮层期间切文档：`clearHistory → dropFloats` 直接弃浮层像素（旧版是引擎私有态悬空，更糟）。

## 3. 测试

- 新 `test/float-ops.test.mjs`（14 条）：lift 往返逐字节 + 选区所有权链、cut:false、fallback 整层、
  组 lift 多 float z 锚点、无交集拒绝、拖动/setMode 微整点（undo 只回网格）、reject binary 精确 +
  stamp 保留 + reject 可撤销、accept 往复（FloatState 对象移交非复制）、lift→拖→accept 整链
  undo×3/redo×3、redo 截断释放 float tiles、dropFloats 释放、源层被外力删 → 不可恢复协议。
- 更新 `test/floating-transform.test.mjs` 夹具（播种 `_live` 代 `_floating`；数学 golden 不变）。
- 803 passed / 0 failed / 3 todo（H7 RED 留给 S8）。GPU warp 烤制（stamp/accept 像素）node 不可测，归真机批。

## 4. 真机待验（并入 batch1 §3 + S5 §3，同批交付）

- Ctrl+T 整链：lift→多次拖动→切模式→stamp→accept；**每一步 undo/redo**（含 undo 穿越 accept
  浮层带 gizmo 回来自动进 transform、undo 穿越 lift 自动退出、redo 重进）。
- Esc/取消 = reject：stamp 保留 + float 原位落回；矩形/魔术棒硬边选区 lift→reject 无痕；
  freehand/椭圆 AA 软边 lift→立即 reject 边缘观感（已知覆盖率损失，见 §2.2）。
- 组 lift（含隐藏叶）拖动/accept/undo；float 在各自源层 z 上方。
- Ctrl+D 复制为浮层（不挖洞）+ undo；导入图片自动进变换（**先画一个选区再导入**也应整层 lift）。
- lift 后蚂蚁线消失 + 取消选区按钮态；undo lift 选区回来。
- 浮层期间 GL 显示：挖洞立即可见、stamp 立即可见、undo stamp 立即可见、undo/redo 拖动网格跳变正确。
- 双指/三指手势 undo/redo 在浮层期间 = 逐整点（不再是取消）。
- crop / 调色 adjust 的 Ctrl+Z 仍 = 取消（回归确认只有 transform 换了语义）。
- 大选区反复 lift→accept→undo→redo：内存曲线 + console 无 `[tile-pool] … GC'd without release`。
- Blender 推拉贴图 / 保存·云同步在浮层活动时的门（应先 applyPendingTransient）。

## 5. 遗留 / S7 交接

- float 源纹理 = `floatSourceCanvas()` 懒物化 canvas（WeakMap）：S7 cpu-gpu-tile-bridge 落地后改
  per-tile 上传，替换点集中在 floating-transform.ts 这一个函数 + board `_glFloatInputs`。
- reject 的 AA 覆盖率损失如需消除，方案（恢复 lift 前快照 + replay stamps）与 spec「不要缓存」冲突，
  需人类拍板；现状按 spec。
- accept 后选区去留（spec:219「恢复选区到新地方(或清选区，看UX)"）仍未拍板——现状 = 清（未动）。
- lift 提取暂未做「mask 全 255 tile 的句柄零拷贝交换」（S5 handoff 提的优化方向）：typed-array
  拷贝路径已 ≤ 旧 canvas 路径内存（旧还多一份 imageData），全 tile 句柄交换留给需要时再做。
- 属性/状态栏 toast：float 各 op 未配 statusFor（避免四语 i18n 本轮铺开）；undo/redo 浮层出现/消失
  视觉自明。真机若需要文案再补。
