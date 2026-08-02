# Undo / Redo 架构决策（兄弟项目可参考）

> 写于 WebPaint v43 → v44 拆 undo 重构前。AtlasMaker 同样有 undo 需求（scene
> object 增删改），可直接抄这个架构。Procreate / Photoshop 走同一脉。
> **不要抄 Blender**。

## 三选一：snapshot / command / 类层级

### A. 整状态 snapshot
每个 op 拍整 doc / scene 一份。

- Pro：简单
- Con：N 个 layer × bbox = MB 级。20 个 op 几十 MB 起。Blender memfile undo
  采的就是这条路 → undo 慢 + 内存大，老 user 都吐过

→ **否**

### B. Command pattern + 注册 handler（α 形态）
每个 op = 纯对象 entry `{ type, ...minimal data }`。type 派发到注册的 handler 跑 undo / redo。

```js
// 数据
{ type: "stroke", layerId, before, after, beforeBlob, afterBlob }
{ type: "renameLayer", layerId, oldName, newName }
{ type: "setLayerProp", layerId, prop, oldVal, newVal }

// 行为
history.registerHandler("stroke", { undo(e), redo(e), refsLayer?(e, id) })
```

- Pro：每个 op 只存自己变了的**最小数据**。stroke 重（pixel snapshot ~2MB
  压缩），但 prop 改 / 改名 / 移层是几十字节
- Pro：100-250 step undo 仍可控
- Pro：data 纯对象 → DevTools 可看 / JSON-able / 未来想存进 .ora 也行
- Con：行为找不到自身（要去 handler 注册点查）
- Con：共享行为靠 helper 抽，没类继承

→ **取此方案**。Procreate / Krita / Photoshop 同款。

### C. Command pattern + 类层级（β 形态）
每个 op = HistoryOp 子类，data + undo() / redo() 绑在一起。

```js
class HistoryOp { undo(); redo(); refsLayer(id); }
class StrokeOp extends HistoryOp { ... }
class AddLayerOp extends HistoryOp { ... }
class RasterOp extends HistoryOp { ... }  // 共享 pixel snapshot + blob 压缩
```

- Pro：行为 + data 一处看；TS / IDE 类型强；共享逻辑用基类干净
- Con：行数多；类实例不天然 JSON-able；当前规模（6 op type）过度工程

→ **现在不做，预留升级**。

## 当前规模 vs 选 α 的理由

要做的 op 类型（v44 PR）：
1. stroke（已有）
2. addLayer
3. removeLayer
4. moveLayer
5. renameLayer
6. setLayerProp（visibility / opacity / mode）

6 类，没到类层级的规模拐点。α 行数少 + 设计灵活，先用。

## 升级路径（α → β）

未来若到这些场景，再升 β：
- Liquify / lasso 变换 / 曲线调整 / 滤镜 = 一堆"像素 op"，共享 "before/after
  pixel snapshot + 异步 blob 压缩" 逻辑 → 抽 `class RasterOp` 基类
- 选区 op / 蒙板 op / 文字 op = 各自一套，但有共同的 "before/after 描述"
  对象 → 类层级合适
- 大概 10+ op type 时考虑升

α → β 是机械翻译：handler closure 变成 class method，不破坏 history.js
core。所以**现在不预先做**。

## 四条纪律（α 实现时遵守，方便以后升 β）

1. **handler 注册集中** —— 所有 `registerHandler` 调用放在模块 boot 时段
   （app.js / input.js 启动段），**不要散在事件 handler 里**。grep
   `registerHandler` 一次列全 op 类型。

2. **handler shape 统一** —— `{ undo(e), redo(e), refsLayer?(e, id) }`，
   不让某些 type 加奇怪字段。base shape 稳定，将来抽 class 一对一映射。

3. **entry 数据 schema 一致** —— 所有"像素 op"共用 `{ type, layerId, before,
   after, beforeBlob, afterBlob }` 壳。抽 helper `pixelSnapshot(layer)`
   / `pixelRestore(layer, snap, blob)`，handler 只写 `redo: e =>
   pixelRestore(...)`。将来 `RasterOp.redo()` 用同一套 helper，零代码改动。

4. **handler 之间不互相调** —— input.js 注册 `"stroke"` 的 handler、
   app.js 注册 `"addLayer"` 等的 handler，**两边解耦**。stroke handler
   不知道 layer handler 存在。这样模块边界清晰，未来谁动哪边互不影响。

## history.js API（最小可用）

```js
export class UndoStack {
  constructor(max = 50) { ... }

  registerHandler(type, { undo, redo, refsLayer })  // 注册一次

  push(entry)             // truncate redo segment, append, cap, emit
  canUndo() / canRedo()
  async undo() / redo()   // dispatch by entry.type to handler
  clear()                 // 切 session / new doc 时
}
```

- entry 必须有 `type: string`
- push 自动 emit `wp:histchange` event（current event 兼容）
- max cap = 50（混合 op 下 ~20-50 MB 内存）

## 关键的几个 op 详细

### stroke（已有，迁移到 history.js）

```js
{
  type: "stroke",
  layerId: 5,
  before: { bboxX, bboxY, bboxW, bboxH, imageData? },   // imageData 压缩后 null
  after:  { bboxX, bboxY, bboxW, bboxH, imageData? },
  beforeBlob: Blob?,   // PNG，异步压缩后填
  afterBlob:  Blob?,
}
```

undo = `pixelRestore(layer, e.before, e.beforeBlob)`；redo = `pixelRestore(layer, e.after, e.afterBlob)`。

### removeLayer（含完整 layer 数据 → 撤销时复活）

```js
{
  type: "removeLayer",
  index: 3,                  // 在 doc.layers 里的位置
  layerSpec: {
    id: 12,                  // **同一个 id 复活**（不走 auto-increment）
    name, visible, opacity, mode,
    bboxX, bboxY, bboxW, bboxH,
    imageData: null,         // 立即 toBlob 异步压缩
    blob: Blob,
  },
}
```

undo = `doc.insertLayerAt(e.index, e.layerSpec)`；redo = `doc.removeLayer(e.layerSpec.id)`。

**关键**：layer id 不变。删除后 history 里历史 stroke entry 还 referencing
旧 layerId；undo removeLayer 把同 id 层复活，那些 stroke 仍可应用。

→ **取消** 当前 input.js 里的 `dropHistoryForLayer`。

### addLayer

```js
{ type: "addLayer", index, layerSpec: { id, name, ...empty 状态 } }
```

undo = remove；redo = insert at index with spec。

### moveLayer

```js
{ type: "moveLayer", layerId, fromIdx, toIdx }
```

undo = move back；redo = move forward。

### renameLayer

```js
{ type: "renameLayer", layerId, oldName, newName }
```

### setLayerProp（visibility / opacity / mode）

```js
{ type: "setLayerProp", layerId, prop, oldVal, newVal }
```

**slider 拖动 coalescing**（重要 UX）：
- pointerdown on slider → 记 oldVal（不 push）
- input 期间只改 `layer[prop]` + render，**不动** history
- pointerup → push **一个** entry

→ 一次拖动 = 一个 entry，不是 100 个。

### 未来：rasterTransform（lasso + 自由变换 / 液化）

```js
// 同 stroke 结构 —— 共享 pixel snapshot 路径
{ type: "rasterTransform", layerId, before, after, beforeBlob, afterBlob, params?: {...} }
```

handler 复用 `pixelRestore`。`params` 字段给"显示这一步在干啥"的 UI 用，不参与 undo 计算。

## 内存预算

| op type | 平均大小 |
|---|---|
| stroke | 2 MB（压缩后 PNG × 2） |
| removeLayer | 1-3 MB（layer PNG） |
| addLayer | 100 B（empty spec） |
| moveLayer | 50 B |
| renameLayer | 200 B |
| setLayerProp | 50 B |

50 entry 混合（典型 ~10 stroke + ~5 removeLayer + ~35 small）≈ 30 MB。
比当前 20 stroke × 2 MB = 40 MB 更宽容。

## undo 哲学：什么进栈，什么不进（2026-05-31，#6 / PixelEdit / 盖印讨论）

理清 EditMode（编辑模式 SSoT）+ PixelEdit（像素事务）后逼出来的几条统一原则，记给将来做盖印 / transform undo 的人：

1. **undo 原子 = PixelEdit tx（一次 begin→commit），不是 transient。** "transient 必须 atomic 进栈" 是伪原则。
   一个 transient（transform/crop/adjust）能产 0/1/N 个 PixelEdit entry：adjust/crop 看起来 atomic 是因为只在 commit 产 1 个。
2. **预览/调整/live 工作态住在栈外，只有"烤进 layer 的像素"才产 entry。** 同一条原则覆盖：slider tweak 不进 undo、
   adjust 用 surrogate 预览、transform 的 float-transform/mesh/handles 不进 undo、盖印每印一格。tweak 免费，bake 一次一格。
   → float 是**三层**：已烤像素=document（进栈）；float 的 transform/mesh=tweak（栈外，和 slider 同类）；
   "还在 transform 模式、float 还浮着"=mode 态（EditMode 活态，栈外）。
3. **PixelEdit 存 before/after 像素快照（结果），不重放操作** → redo = putImageData(after)，**不依赖 float**。

### 盖印（已实装）与 transform-undo：当前 = 路 2，路 1 待做

现状（路 2，已实装并验证）：`lasso.stamp()` 直接画进 layer、**不 push history**；整个 transform（lift→盖印×N→commit）
只在 commit 产**一个** "lasso" entry（before=lift 前，after=含所有盖印）。ctrl-z during transform = abort（取消全部）。

三条路（grilling 取舍）：
- **路 1（待做，长期正解）**：每次盖印包一个 PixelEdit tx = 一印一 entry；为支持"redo 回某盖印态时 float 还在"，
  每个 stamp entry 存当时 **mesh**（几十字节）+ 引用 **lift 时拍的不可变 float 画布**。ctrl-z 改 history（逐印剥，剥到 pre-lift 自然退出）。
  破"float ⊥ undo"纯度但为盖印手感值；便宜（float 画布共享不可变）。
- **路 2（当前）**：transform atomic，ctrl-z=abort 全部。安全、保持 float 全程栈外。代价：浮着时不能单独撤一印。
- **路 3（否决）**：护栏 clamp undo range during transform。商软常用但脆、易 bug（用户自评）。不在刚理干净的架构里埋雷。

**决策**：#6 先做完（stage 2-5）保持路 2（`ctrlZMeans("transform")="abort-transient"`，只是改由 EditMode 路由）；
**路 1 当 #6 之后的独立 follow-up**（骑在 EditMode.ctrlZMeans + PixelEdit tx 上，聚焦改 transform 那行 + stamp 走 tx + 存 mesh）。

### 图层 op 怎么 snapshot（同一条 command-pattern）

结构 op 存命令数据（addLayer/moveLayer/renameLayer/setLayerProp = index/id/old-new，几十字节）；
含像素 op 复用 PixelEdit before/after blob（removeLayer 存完整层 + **保留原 id** 复活；复制到层/移动到层 = 新层 spec + 源层 before/after；mergeDown = 下层 before/after + spec）；
docTransform（crop/resample）动全图 → 唯一用 snapshotAll（全层 + selection 引用）。live 工作态永不进栈。

## 给 AtlasMaker 同事

你的场景 op 类型不同，但**架构同构**：

- `addObject` / `removeObject` / `moveObject` / `transformObject` / `setObjectProp`
- 大对象（图集 atlas、photobash 大图）和 WebPaint 的"重 stroke"类比 —— 数据
  存 Blob，异步压缩

四条纪律同样适用。可以共用一份 history.js（vendored 进各项目）—— **现在
不抽**，等到第 2 个项目（AtlasMaker）真要用 + 接口稳定后再拉到共享 vendor。
phase 1 各自抄。
