# Tool / Mode 独占状态机（设计定稿 · 架构候选 #6 · 未实现）

> 整理自 `journal/cached feedback.md` 80–91 行（用户旧想法）+ 2026-05-31 架构 grilling。
> **接口已定稿，尚未实现。** 候选 #6，是 #2(选区)/#3(save 协调器)/#5(FloatingPanel) 的共同前置。
> 领域词见 [CONTEXT.md](../CONTEXT.md) 的 Mode / Transient；undo 事务见 [undo-architecture.md](undo-architecture.md) + 已落地的 PixelEdit；
> transient 现状见 [pending-transients.md](pending-transients.md)（本设计吸收并简化它）。

## 一句话

缺一个 **Mode（独占状态机）** 深模块做"我现在在什么模式"的 SSoT。从它派生三样东西：
**输入/快捷键 gating、UI 显隐与灰调、ctrl-z 语义**。它和 PixelEdit 合起来才是完整的 undo integrity——
PixelEdit 管"记什么"，Mode 管"何时允许记 / ctrl-z 是什么意思"。

## 问题：mode 现在是碎的

"我在什么模式"散在三处，没有单一来源：

| 来源 | 例子 | 管什么 |
|---|---|---|
| `state.tool` | brush / eraser / picker / lasso / liquify / hand | 工具选择 |
| transient 模式字符串 | `_suppressTransientPanels("transform"/"crop"/"adjust-color")` | **只**藏面板 + 离开时 apply |
| 各引擎 isActive | `liquify.isActive()` / `filterBrush.isActive()` / `lasso.state()` | 引擎自己的进行中状态 |

后果（journal 里报的症状，全是同一个根）：
- picker / lasso 时笔刷大小预览圆没隐藏（80–91 + 60 行）
- 隐藏图层上动笔没 reject（journal 第 7 行）
- transient 期间 ctrl-z 语义不对（应是"取消"，不是"弹栈"）
- undo bleaching：非法像素改动溜进 undo 栈
- 模态对话框还没统一（现在只有 ad-hoc 的 `_openResampleDialog`）

## 心智模型：三类窗口/状态

| 类 | 定义 | ctrl-z | 输入 | 例 |
|---|---|---|---|---|
| **模态 (modal)** | 完美 block 任何 drawing / input / hotkey | 关掉对话框（或无效） | 全 block | resample 对话框、factory reset 安全网 |
| **半模态 (transient)** | 绘画时停驻的 exclusive 多步模式 | **取消当前 transient**（不弹栈） | 只接当前 transient 的输入 | lasso 变换、crop、调色预览 |
| **持久 (persistent)** | 常驻可 toggle 的工具/面板 | `history.undo()` | 正常 | brush/eraser/liquify、reference 窗、topbar |

> **关键语义澄清（grilling 逼出来的）**：单次手势进行中（pointer down→up，比如笔触/液化没松手）**不是** Mode 的 transient——
> 它由 PixelEdit 的 `tx` / `tx.abort()` 管，Mode 不追踪（手按着也没法 ctrl-z）。
> Mode 的 transient 专指**停驻的多步模式**（transform/crop/adjust，跨多次手势直到 commit/cancel）。
> 这把"手势级 abort"和"模式级 cancel"两件事彻底分开。

## 已定决策（2026-05-31 grilling）

1. **Mode 身份 = 双轴 `{ tool, transient }`**。tool 是持久选择；transient 是 null 或**一个**停驻模式，覆盖在 tool 上但不丢 tool。
   取消 transient 天然回到 tool（无需 previousTool 字段）。transient 不嵌套（无栈，YAGNI）。
2. **能力表 = 纯数据表**，谓词 = 查表。Mode 纯 in-process，**不持 doc/board 引用**。
   "层可见/未锁"这种 runtime fact 在 seam 上另一道 guard 组合，不混进 Mode（保持纯函数可测、不把层语义混进模式能力）。
3. **本轮只做 persistent + transient**。modal（完美 block + 统一 in-app 对话框入口）留作后续，现在 modal 仍走各自 ad-hoc。

## Mode 接口（定稿）

```js
// mode.js —— 纯 in-process（只持 _tool 字符串 + _transient 对象）
const CAPS = {                 // 能力表 = 纯数据，谓词 = 查表（接口即测面）
  // 持久·交互式 stamp 工具（brush-driven）：都 canDraw、笔刷 cursor、ctrlZ history、产 "stroke" PixelEdit。
  //   唯一实质差别 = allowsColor。"stamp 干什么" 是引擎 payload，不是 mode：
  //   paint=上色, eraser=擦, filterBrush=滤镜/液化/涂抹...（见下"stamp 家族"）
  brush:       { canDraw: true,  allowsColor: true,  cursor: "brush", ctrlZ: "history" },
  eraser:      { canDraw: true,  allowsColor: false, cursor: "brush", ctrlZ: "history" },
  filterBrush: { canDraw: true,  allowsColor: false, cursor: "brush", ctrlZ: "history" }, // liquify / 未来 smudge / 色彩滤镜笔 = 它的 payload
  // 非绘画持久工具
  picker: { canDraw: false, allowsColor: true,  cursor: "none", ctrlZ: "history" },
  lasso:  { canDraw: false, allowsColor: true,  cursor: "none", ctrlZ: "history" },
  hand:   { canDraw: false, allowsColor: false, cursor: "grab", ctrlZ: "history" },
  // 半模态 transient（活跃时覆盖工具行）
  transform: { canDraw: false, allowsColor: false, cursor: "none", ctrlZ: "abort-transient" },
  crop:      { canDraw: false, allowsColor: false, cursor: "none", ctrlZ: "abort-transient" },
  adjust:    { canDraw: false, allowsColor: false, cursor: "none", ctrlZ: "abort-transient" }, // 整个滤镜家族共用一行，见下
};

class Mode {
  // --- SSoT 状态（双轴）---
  setTool(tool)                          // 取代 state.tool 写入；若有 transient 先 applyPendingTransient()
  tool()                                 // 当前持久工具
  enterTransient(name, { apply, abort }) // 进 transform/crop/adjust
  exitTransient()                        // commit 后正常退（不调 apply/abort）
  current()  // _transient?.name ?? _tool
  isTransient()

  // --- 谓词（O(1) 查表）---
  canDraw()          // CAPS[current()].canDraw
  allowsColor()
  showsBrushCursor() // cursor === "brush"
  cursor()
  ctrlZMeans()       // "history" | "abort-transient"

  // --- ctrl-z / decisive-action 执行点（吸收 pending-transients）---
  abortTransient()        // 调 _transient.abort()，清
  hasPendingTransient()   // !!_transient?.apply
  applyPendingTransient() // _transient.apply()，清

  // 每次 setTool / enterTransient / exitTransient → emit "wp:modechange"（沿用 wp:histchange 模式）
  // UI 监听重新派生面板显隐 + cursor
}
```

### 调用点

```js
// input._down —— gate 在 seam，分类在表
if (!mode.canDraw()) return;
if (!doc.activeLayer?.visible) { this.status("隐藏图层不能画"); return; }  // ← 层可见性是 seam 的另一道 guard
this._strokeTx = this.pixelHistory.begin(doc.activeLayer, "stroke");

// 全局 ctrl-z —— 语义由 Mode 路由
mode.ctrlZMeans() === "abort-transient" ? mode.abortTransient() : history.undo();
```

**分类 vs event-guard（journal 83 行的问题）：两者分层。** 能力表放 Mode（一处定义每模式准什么 = locality）；
guard 留 event callback 但只调谓词（每 callback/UI 读同一组 = leverage）。纯声明式 visibility 表罩不住 hotkey 细节；纯手写 reject 会散。

## 它怎么吃掉 pending-transients（并简化）

[pending-transients.md](pending-transients.md) 设想"可同时多个 pending（lasso-floating + text-editing）"，用一个多项注册表 + `applyAllPendingTransients()`。
**独占状态机下至多一个 transient**——这正是 exclusive 的意义。所以多项注册表**塌成 Mode 里单个 `_transient`**：

- 进 transform/lasso-floating/crop/adjust 时 `enterTransient(name, { apply, abort })`。
- `hasPendingTransient()` = `!!_transient?.apply`；`applyPendingTransient()` = 调它的 apply。
- 新增 `abort`（给 ctrl-z 的 abort-transient 用，pending-transients 原来没有这个）。
- 显式/隐式区别（后台 autosave 跳过、显式动作 apply）**仍在调用点**（saveNow/setTool/进图库），Mode 只暴露 has/apply。
- `_suppressTransientPanels(name)` 的模式字符串就是 `mode.current()` 的 transient 取值，不再是平行第二套。

## 两个 payload 家族都不增加 mode 行（journal 52–54、65、86 行）

Mode 枚举的是**能力 profile，不是工具**。两大族各自共用一行，成员是 payload，不是新 mode 行：

**① stamp 家族（brush-driven，持久，canDraw）** —— `brush` / `eraser` / `filterBrush` 三行其实是一类，
区别只在 allowsColor。"stamp 干什么"是引擎 payload：上色 / 擦 / 滤镜 / **液化** / **未来 smudge**。
**liquify 和 smudge 是 filter brush 的 payload，不是独立工具**（journal 65：「液化还没接 filter brush」正是这个统一）。
现状代码 liquify 有独立 `LiquifyEngine` + `_beginLiquify` 路径——目标是收进 filterBrush 引擎，届时 `liquify` 不再是单独的 tool 取值，
而是 `filterBrush` 的一个 effect payload。nudge（journal 93）同理是又一个 payload，不是新 mode。

**② adjust 家族（拉 slider，transient，!canDraw）** —— curves / hsb / color-balance / sharpen-blur / stylize / 艺术滤镜……
（见 [filter-plugin-architecture.md](filter-plugin-architecture.md)）全是**同一个 transient kind = `adjust`**，payload = 哪个 Filter + 参数 UI。
新增一个艺术滤镜 = 注册一个 Filter class，**不动 Mode 表**。

> 对称：stamp 家族用同一个 Filter/effect 当"交互式笔刷 payload"（canDraw，产 stroke edit）；
> adjust 家族用同一个 Filter 当"停驻 slider payload"（transient，拉完烤一刀）。**同一批 Filter，两种使用模式**——
> 这正是 journal 52 行区分的 "adjust brush（交互）" vs "adjust filter（选区/全画布拉）"。

| 用法 | mode | canDraw | 语义 | undo |
|---|---|---|---|---|
| **filter brush**（交互式刷，含 liquify/smudge） | 持久 `filterBrush` | true | 一笔 = 一个 "stroke" 像素 edit | 走 PixelEdit `tx`（已落地） |
| **adjust filter**（选区/全画布拉 slider） | transient `adjust` | false | 停驻预览，commit/cancel | 见下 |

**adjust transient 的 undo 语义（journal 86：不 log slider tweak）**：
- 进入：`enterTransient("adjust", { apply, abort })`，payload 记当前 Filter + params。
- 拖 slider：**只更新 live preview**（board 上的临时滤镜），**不动 history**——否则 N 次微调瞬间吃光配额。
- commit（apply）：把滤镜结果**一次性**烤成**一个** PixelEdit `tx`（`begin(layer) → 应用滤镜 → commit()`）→ 一个 undo entry。
- cancel（abort）：丢弃 preview，layer 不变（无 entry）。
- ctrl-z（在 adjust 里）：`ctrlZMeans()==="abort-transient"` → 等价 cancel。

这正好接上已有的 slider coalescing 先例（图层 opacity：拖动期间不 push，松手 push 一个 entry）和 PixelEdit 事务。
adjust transient 的 apply 内部就是一个 PixelEdit tx——Mode 与 PixelEdit 在这里组合，互不知内部。

## 面板派生（journal 90 行）

面板显隐/灰调由 Mode 谓词驱动，不再各 panel 手写：
- **color**：`mode.allowsColor()` 为真才显示（brush / 选区等用到颜色的上下文）
- **sidebar（笔刷调整+选择）**：无笔刷上下文时灰调，但 **undo/redo 留着**
- **reference**：常驻
- **topbar**：默认开，等以后全屏预览功能才隐藏

和候选 #5（FloatingPanel）合流：FloatingPanel 提供 open/close/toggle 机制，Mode 提供"该不该开/该不该灰"的判据。

## 落地顺序（建议，一阶段一 commit）

1. **Mode + 谓词**（初版 setTool/current/canDraw/ctrlZMeans，能力表）。`state.tool` 改为 `mode.tool()` 的薄包装或迁移。
2. `_down` / hotkey 接 `canDraw()` gate + 隐藏层 guard → 当场修掉 undo bleaching 的非法笔来源。
3. ctrl-z 接 `ctrlZMeans()` 路由 + `abortTransient()` → transient 取消语义。
4. transient 入口改 `enterTransient/exitTransient`，吸收 pending-transients 注册表（含 `abort`）。
5. 面板显隐/cursor 改读谓词（监听 `wp:modechange`）→ 和 #5 FloatingPanel 合流；顺手治 picker 笔刷圆没隐藏。

## 这一块里混了三类，别一起做

| 类 | 项 | 去向 |
|---|---|---|
| **架构（本 Mode 机）** | 模/半模分类、reject/guard、transient ctrl-z、面板显隐派生、picker 笔刷圆没隐藏 | 候选 #6（本文档） |
| **功能** | revert（回到上次 explicit save / 打开态）；collapse all layers（to new layer / 替换全部）；filter stage 不 log slider tweak | revert → #3 save 协调器；collapse → 独立 feature；slider 合并已有先例（图层 opacity：pointerdown 记 old、pointerup 才 push 一个 entry） |
| **一行 / ad-hoc** | undo 配额 50→调大；picker 笔刷圆先 ad-hoc 藏 | 配额**待办：需查 memory（内存预算）再定数**；笔刷圆由步骤 5 的 `showsBrushCursor()` 统一治 |

## 待决 / 开放问题

- **undo 配额数**：用户要求查 memory（内存预算，见 [undo-architecture.md](undo-architecture.md) 内存预算节）再定，以后做。
- **modal 统一调用**：本轮不做。Mode 的 modal kind + 统一 in-app modal 入口（**不**用 alert/confirm/prompt）留作后续一并解决。
- **liquify/smudge/nudge 收进 filterBrush 引擎**（journal 65、93）：这是引擎层重组（payload 化），**不是** Mode 的事——Mode 表里它们已归 `filterBrush` 行。重组本身是独立工作项。
