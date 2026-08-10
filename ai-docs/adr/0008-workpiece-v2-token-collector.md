# ADR-0008 · workpiece v2：令牌+collector 元规则、组件化、GL 双 facade
> created 20260807
> 状态：已拍板（user，2026-08-02→07 架构讨论 session，多轮逐条 grill）。
> **supersede ADR-0007 的 operator/①型②型模型**；ADR-0007 的原则层（workpiece=undo 监管对象全部作用域、
> 写面收权、sidecar 概念、「doc mutation 必须走 undo」硬规则）**继续有效**。
> 编号说明：曾有一份被否回滚的 ADR-0008 草稿（C·GPU，未入库）——本文件与它无关，编号首次正式启用。

## 背景

v0.8.1–7（S1–S6）把写面收进了门面，但暴露出根子问题：**手写 forward/backward 逆元模型**
（operators.ts 的 ①型/②型、`_initialBefore` 所有权舞蹈）是全部复杂度与越狱风险的来源；
且 PaintDoc 是 user 认知与 AI 实现之间最大的 fork（外部持有可变引用本身即违规）。
业界对照（Krita tile memento / PS history states / Blender undo steps）：没有人手写逆元，
都是**直接写 + substrate 自动收集 diff**。

## 决策（每条带 why；「user 原话」处为拍板依据）

### 1. 元规则：令牌 + 直接写 + per-component collector

- workpiece = **令牌工厂 + undo stack + meta**（commitVersion/stateVersion）。同时只准一个令牌
  （第二次 begin → assert，即泄漏查获点；FinalizationRegistry 兜底）。
- 拿到令牌后 component 可直接写自己的 substrate；被换下的旧数据由**该 component 自己的 collector**
  静默扣押（异质数据异质收集方案：tiles 收句柄、json 收快照、值对象收引用）。
- 还令牌（commit）= 各被摸 collector 打包 → **一个 UndoStep 入栈**；**checkpoint/compound/
  sealCheckpoint 机制整体退役**（一次交互 = 一个 token = 一步）。令牌必须支持 **cancel**（倒序回滚，
  等交互的挂起令牌被用户取消时用）；跨 await 的挂起令牌并发写暂由 EditMode transient 挡（tool state
  全局类是已记名的后续坑）。
- why：忘记记账这类 bug 从「被 write-gate 锁住」变成「结构上不存在」——没令牌写不进去，写进去必被收集。

### 2. record：纯数据 + component 层 dispatch，自反 swap

```
interface WorkpieceComponent { kind; swapRecord(data)→data; recordBytes(data); disposeRecord(data) }
interface UndoStep { entries: {c, data}[]; label?; hint? }
undo = entries 倒序 swapRecord；redo = 正序再调一次（自反/对合——不存在「undo 生成 redo」问题）
```

- record **不存函数引用**（user：dispatcher 就在 component 这一层，这是 component 的意义）；
  component 内部对自己 record 的小 tagged union 局部分派合法。纯数据为未来持久化 undo/timelapse 留门。
- **computed record**（省内存的可逆变换）：`{kind:"flip"}`/`{kind:"rot",dir}` 这类零负载 record，
  swap=再变换一次。**白名单制**（首批仅 flip/rot90/offsetWrap）+ **双捕获断言**（提交 computed 时
  该组件 collector 必须零收集，否则 throw）——防 multiple-parallel-path 屎山。
- 函数注册成字符串：**否**（等于把刚杀掉的 operator 注册表换门牌复活）。
- dispatch 通用判据（全仓适用）：跨进程/持久化→string；长期契约有资源生命周期→OOP/ABC；
  一次性非权威丢了无害→闭包。**用 string dispatch 必须注释写明前两者为何不行**，写不出=不准用。

### 3. 组件化：Workpiece 基类 + PaintingWorkpiece

- **Workpiece（app-agnostic）**：令牌工厂/栈/双计数/组件注册。undo history 实例 ctor **可选注入**
  （没传 = 该 workpiece 无 undo，写照走令牌、record 直接丢弃——写面纪律统一）。
- **PaintingWorkpiece extends Workpiece**：`layerTree / layerTiles / selection / floatLayer /
  pendingFill / persp`（recorded）+ `referenceGallery / palette`（silent）。全名不缩写。
- **sidecar = silent 形容词，不开新 workpiece**：一个主 workpiece + 组件注册表（undoPolicy:
  recorded|silent、持久化去向、变更信号）= 用途一目了然的 SSOT。silent 组件写走令牌但 seal 丢
  record、只发信号+标脏（silentDirty）；升 recorded = 注册表改一个字段（AI 动参考图那天用）。
  `wp:sidecarchange` 事件届时退役，信号统一从 workpiece 出。
- **外部唯一引用 = workpiece**（持有 PaintDoc 本身即违规，user 原话）。构造全白；**load 也是令牌写**
  （解码器产 plain data 灌入，随后清栈）→ `ctx.docRaw`/`DocView`/`readDoc()` 全部退役。
- **PaintDoc 拆解至消失**：LayerTree = 纯 json（可持久化树/结构共享，非深拷）+ 每层 pixelsRef；
  LayerTiles = tile 扁平仓（gltf 的 json/VBO 分工）。**tileset 引用计数**（json 持有 +1、record 持有
  +1、归零还池）——顺手修 TreeStructureOp 注释在案的 bounded 泄漏（user：泄漏伤性能引发闪退，必修）。

### 4. undo 白/黑名单（每项具体理由，判据：「这个值变了，用户期待 ctrl-z 撤它吗」）

| 项 | 归属 | why |
|---|---|---|
| 层树/像素/选区/浮层 | recorded | 内容本体，丢=丢画 |
| persp | **recorded（本 ADR 升格）** | 画坐标系数据、随 doc 几何重映射；undo 不同步还原=透视静默错位（ADR-0006 实测）。持久化去向仍是 editor-state 文件——**存哪个文件与 undo 归属正交**。DocTransform 的 persp 信封机制退役。**v0.8.29 扩到 VP 编辑器**（user 2026-08-10「persp也全量进undo吧，拖一次可以undo一次」——commitPreApplied 每拖一步；旧「VP 编辑不进栈」收窄 supersede，见 ADR-0006 修订记录） |
| referenceLayerId | recorded | 影响魔棒/fill 取源=影响创作结果 |
| PendingFill.color | recorded | user 拍板：预览换色可撤；改的是「将要落画布的东西」 |
| active 焦点 | 不记 | 导航非创作；记了 ctrl-z 变成翻点击史（PS 同判） |
| 笔刷色/粗细/手感/容差类旋钮 | 不记（dials/desk） | **调好的手感是偏好不是创作**——undo 撤画布上的事，不撤手里的工具（user 原话） |
| 面板位置/开关 | 不记（desk） | 桌面布置；v409 钉子连 dirty 都不标 |
| viewport | 不记，走 step.hint | 设备态不进字节；undo 跳镜头只是舒适度 |
| 参考图/palette | silent | 丢=丢数据（要落盘）但无撤销预期；AI 时代可升 recorded |

### 5. dirty 派生 + 双计数

`dirty = (stateVersion !== lastSavedVersion) || silentDirty`。stateVersion = 游标处 step 的 id
（位置身份，undo 回存档点自动 clean——真值表三行 user 复核通过，无保守模式）；commitVersion =
单调计数（undo 也 +1，渲染缓存失效用）。两计数语义不同不许合并。isDirty 可变布尔退役。

### 6. color-target + PendingFill

色板 = 编辑器，指向 color target：平时 `brush.color`（**永不 undo**）；fill 预览期自动指
`PendingFill.color`（进入时从笔刷色同步初值；recorded、不持久化，先例=selection）。
预览期调色 = 真 undo step（防抖合并，v0.7.8 UX 原样保留）；commit = [tiles+selection 清+PendingFill 清]
一步。收益：undo 永远不再改用户调色盘上的当前色（今日实况的别扭）。PendingFill **只收参与 undo
时间线的操作参数**（判据同 §4），region 归 Selection（fill=选区的消费视图，ADR-0004 不动）。
文字多色/模态编辑=已记名坑。
> v0.8.29 落地注：「PendingFill 清」曾漏实现（C4 census §7 分歧#1 上呈，user 2026-08-10
> 「应该清」）——现 commit 步内 clearRecorded 记账清；留在 fill 时 commit 后用刚落地的色
> 重新 begin（导航态 re-seed）——「✓ 连续填下一块」色不丢。同批修出口错序（曾先 clear 后
> commit → 落色错回笔刷色，行为锚钉住）。

### 7. step.hint：单闭包，非权威附注

`hint?: (dir:"undo"|"redo") => void`，栈应用完 entries 后调。三纪律：①非权威（不参与 swap/
stateVersion/配额）②lossy 无害（丢了画面仍逐字节正确，可全局关）③消费在 app 不在栈。
为什么闭包在这安全而在 record 不安全：hint 无权威性诉求，且 **token 墙**保证闭包内摸不到
workpiece 权威数据（无令牌写必拒）——它物理上只碰得到该碰的（视口）。纪律：只捕原始值/小 plain
object。唯一住户 = viewport；准入标准 = 丢了完全无害的纯舒适度效果。

### 8. GL 双 facade：RenderTree + RasterService，共享机房

- **RenderTree**：单一职责 tree composite（renderFrame/markDirty/contextRestored）。
- **RasterService**：一次性算像素服务（笔迹烤定/浮层 warp/composite-to-bytes/吸管）——也是
  C 骑士「合成栅格 GPU-only」那块硬骨头的显形接缝。
- **硬前提：两 facade 共享同一 GLContext/GpuTilePool/CpuGpuTileBridge/GLCompositor 实例**
  （笔迹烤定搭 base-tile 便车零上传；拆成两套缓存=每笔整层重传的性能灾难）。拆门面不拆机房。
- workpiece/引擎零 GL 零 canvas：GPU 只算不管账，账本（tiles/undo）永远是 CPU 句柄操作；
  合成字节外部烤好递入（mergeDown 留 workpiece，collapseGroup 现状同形）。
- LayerTiles 读口两档：**TileReadPort**（身份制零拷贝，render/bridge 用）+ `getRegion`（引擎/导出）。
- 三面预览旗（overlay/surrogate/float）：push RAM 引用，VRAM 全归 render 侧私有；预览是引擎
  自持物，**不进 workpiece**（可撤销的中间态如 float 除外——它是 recorded 组件不是预览）。

### 9. 命名与清理

dials（RAM 反应式层，Vue `useDials()` 惯例）/ desk（per-doc 桌面 struct；持久化文件名暂不改）/
PendingFill / FloatLayerComponent（单数名；内部 sources[] 复数，组 lift 每叶一 float 现状已支持）。
旧轨 `webpaint/state.json` **停写删除**（user 确认从未授权其歧义存在；存量 .ora 读兼容保留数版本）。
Tx=transaction 词义保留，三个 Tx 类溶解（PixelTx/SelectionPreviewTx/treeTx → 令牌+组件写 API）。
「doc」一词回归 user 术语（惰化持久格式）；rename 波及单独成片。

## 后果

- v0.8.1–7 的 write-gate/DocView/docRaw/operators/undo-history 旧栈是**过渡脚手架**，v2 落地后拆除
  （其行为锚测试迁移为 v2 锚）。
- 已记名未排期：预览违规户迁移（液化就地写、魔棒拖选直写 selection、形状笔 pixelMode）、
  tool state 全局类、color 编辑器模态化、C 骑士 headless（RasterService 即其接缝）。
- .h ritual 见家族总 CLAUDE.md（`scripts/gen-api.sh` → `api/`）。
- 目标 API 全签名：`ai-docs/20260807-workpiece-v2-proposal-h.md`；施工序：`ai-docs/20260807-workpiece-v2-handoff.md`。
