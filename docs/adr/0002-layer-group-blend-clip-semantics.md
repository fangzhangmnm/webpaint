# 图层组的 blend / clip 语义：对齐 PS/Procreate 的隔离模型，且刻意超出两处

**Status:** accepted（2026-06-14，v277 图层组落地后 grounded 复核）

嵌套图层组（folder）落地（batch 2，v277）。组的 blend mode / opacity / clip 怎么作用，按什么模型？
结论：**核心隔离模型对齐 Photoshop / Procreate**，并**刻意**在两处超出 PS（更接近 Clip Studio Paint）。
本 ADR 钉死语义 + 已知缺口 + **未来文件格式对齐（尤其 ORA / 跨 app 互通）的坑**。

判定代码：`src/layer-composite.js` `_groupNeedsIsolation` = `mode≠source-over ‖ opacity<1 ‖ clippingMask ‖ isolate`。

## 对齐的部分（grounded，2026-06-14 web 核实）

- **隔离 / 压平模型**：组**当且仅当**有非-Normal 混合模式 **或** opacity<100% **或** 蒙版/clip 时被**隔离**
  ——先把组内子树合成一张，再用组的 mode/opacity 与背景混 = **"folder 等价于一张拍平的图"**。
  否则是 **pass-through**：组只是收纳，子层照常和组下方背景混，**不**被压平。
  这正是 PS 官方行为（组默认 = Pass Through；改成 Normal/任意模式即隔离 = "拍平再混"）。Procreate 5.2+ 同模型（显式 Passthrough 挡）。
  来源：[PS Training Channel — Pass Through](https://photoshoptrainingchannel.com/tips/pass-through-blend-mode/)、[Procreate Folio — Pass Through](https://folio.procreate.com/discussions/4/10/43685)。
- **blend / clip 不是 folder-only**：叶图层也有自己的 mode（`layer-composite.js:93`）；clip **按同 parent 级**解析
  （同级下方最近「非clip/可见/有内容」节点为基底，**不跨组**）。PS 同理——剪贴蒙版只在同层级内裁、不穿组。

## 刻意超出 PS 的两处（用户 2026-06-14 同意保留）

1. **组可当 clip 层 / clip 基底**（`webpaint:clipping` 可挂在 `<stack>` 上）。**PS 不支持剪贴一个组**
   （[十年老需求](https://community.adobe.com/t5/photoshop-ecosystem-ideas/photoshop-clipping-mask-to-a-layer-group/idi-p/12250414)）；Clip Studio Paint 支持。我们偏 CSP，更强。
2. （隐含）clip 语义统一走规范合成器一处，叶 / 组同一套 per-level 解析。

## 已知缺口：没有独立的 "Pass Through vs Normal" 两挡

PS/Procreate 把 **Pass Through** 与 **Normal** 当**两个独立的组模式**；我们是**从 mode/opacity/clip 推导**隔离，
所以 `source-over + opacity1 + 无clip` **永远** pass-through ——**无法表达"隔离 + 仍用 Normal 混"**。
- 影响：组里一个 Multiply 叶，pass-through 下会和**背景**相乘；PS 的隔离-Normal 下只在**组内**相乘。我们没有后者这个挡位。
- 多数人用不到，故 v277 不做。**用户已拍板：有必要可以加**（加一个显式 pass-through / isolate 开关，把隔离从"推导"变"可声明"）。
  模型里 `group.isolate` 字段已存在（`_groupNeedsIsolation` 已读它），只是 UI 没暴露、序列化没写 → 加的时候接这个 hook。

## 未来文件格式对齐的坑（ORA / 跨 app —— 用户点名提醒）

存档 = ORA（`<stack>` = 组，`composite-op` / `opacity` 标准属性；`webpaint:*` 私有扩展）。对齐 / round-trip 时注意：

1. **组-clip 不可移植**：`webpaint:clipping` 挂 `<stack>` 是私有命名空间属性，别的 ORA reader（Krita/GIMP/...）**直接忽略**
   → 在它们里渲染成**普通组**（clip 丢失，视觉发散）。**唯一跨 app 忠实的产物是 merged PNG。** 反向读外部 ORA 安全（没人产 clipped-stack）。
2. **pass-through ⇄ ORA 语义不对齼**：ORA baseline **没有** pass-through 这个 composite-op，`<stack>` 默认 `svg:src-over`。
   - 我们把 pass-through 组写成 `<stack composite-op="svg:src-over">`；**别的 app 可能把 src-over stack 当成隔离-Normal**（先拍平再 Normal 混），不是 pass-through → 内部带 blend mode 的子层在对方渲染器里**到不了背景** = 发散。
   - 读 Krita 等的 ORA：它们的隔离 / pass-through 用的是 **Krita 私有标记**（如 `composite-op="krita:pass through"` / isolation 属性），我们不解析 → 一律按我们的推导规则走，可能误读。
3. **加 pass-through 时的兼容**：若将来加显式挡位，ORA 里**没有标准表示**——要么 `webpaint:passthrough`/`webpaint:isolate`（私有），
   要么对齐 Krita 的写法。**且要保证旧 .ora 的 `src-over` 组继续按 pass-through 加载**（别让新挡位改变老文件语义）；序列化补上 `group.isolate`。
4. **PSD**（导出 only，已 lossy）：组直接拍平进 merged，per-layer records 走 flattenLeaves；PSD `lsct` 真组 + pass-through(`lsct` 的 "passthrough" 标志) 留 P2。

## 落地

- 语义代码：`src/layer-composite.js`（`_groupNeedsIsolation` / `_compositeGroup` / 同级 clip 基底解析）。
- 序列化：`src/ora-stack-xml.js`（组 = `<stack>` + `composite-op`/`opacity`/`webpaint:clipping`；**未写 `isolate`** ← 加 pass-through 时补）。
- 状态文档：`docs/layer-groups.md`。
