# 图层组的 blend / clip 语义：对齐 PS/Procreate 的隔离模型，且刻意超出两处

**Status:** accepted（2026-06-14，v277 落地后 grounded 复核；**v278 加 pass-through + 改用 ORA 标准 isolation**）

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

## Pass Through vs Normal 两挡（v278 已加，缺口已闭）

v277 是**从 mode/opacity/clip 推导**隔离，没有独立的「穿透 vs 正常」两挡。**v278 补上**（用户拍板）：
- 组的模式下拉**置顶加「穿透」**，且**新建组默认 = 穿透**（`LayerGroup.mode="pass-through"`）。叶层不加此项。
- 「正常」对组的含义 = **隔离**（先拍平再 Normal 混）。这就是 PS 的两挡。
- `_groupNeedsIsolation` 判定从「mode≠source-over」改成 **「mode≠"pass-through"」**（穿透是**唯一**非隔离态；opacity<1 / clip 仍强制隔离）。
  隔离回混时把 `"pass-through"` 映射成 `source-over`（穿透≠某种混合模式）。
- 实现走 **mode 值**（不是 isolate bool）→ 一个字段表达整套 blend 状态、和 PS 单下拉一致。`group.isolate` 字段弃用。
- 影响（现在能表达了）：组里一个 Multiply 叶，**穿透组**下和背景相乘、**正常(隔离)组**下只在组内相乘。

**好消息**：这套 = **OpenRaster baseline 的隔离模型本身**——[ORA Layer Stack Spec](https://www.openraster.org/baseline/layer-stack-spec.html)：
非根 stack 隔离 ⟺ `isolation="isolate"` ‖ opacity<1 ‖ composite-op≠src-over；非隔离时 composite-op 被忽略、子层与背景混。
三方（PS / Procreate / ORA）一致。

## 文件格式对齐（v278 复核：ORA 全合规 + 互通）

存档 = ORA。`<stack>` = 组（嵌套 = baseline 支持）；用 **ORA 标准属性**，不再私有：
- **穿透 → `composite-op="svg:src-over"` + `isolation="auto"`**；**正常(隔离) → `+ isolation="isolate"`**；其它混合模式 → `composite-op="svg:<mode>"`。
  读回按 baseline 规则反推（见 `parseStackXml`）。→ **完全合规，且和 Krita/GIMP/MyPaint 双向互通**（先前 ADR 担心的「pass-through⇄ORA 语义不对齐」坑 **已消解**：用了标准 isolation，不再赌别人怎么解释 src-over stack）。
- 向后兼容：旧 .ora / 外部 .ora 的 `<stack composite-op=src-over>` 无 isolation → 缺省 `auto` → 读成穿透（PS/baseline 默认，也 = v277 行为）。无破坏。
- `webpaint:id`/`webpaint:active`/`webpaint:clipping` 仍是私有命名空间属性 = **spec 允许**的扩展，别的 reader 忽略 → 仍是合法 ORA。

**仍属私有 / 仍是坑的只剩一处**：
1. **组-clip 不可移植**（我们超出 PS 的特性）：`webpaint:clipping` 挂 `<stack>` 别的 reader 忽略 → 在它们里成普通组（clip 丢失）。这是**有意的取舍**（PS 也没这功能），跨 app 忠实产物 = merged PNG。
2. **PSD**（导出 only，本就 lossy——连叶的 clippingMask 都丢）：组**拍平**进 merged，per-layer records 走 flattenLeaves → **是合法 PSD（所有叶在、可打开），但不保留组文件夹结构**。PSD `lsct` 真组（含 passthrough 标志）= P2，要保留结构再做。

## 落地

- 语义代码：`src/layer-composite.js`（`groupNeedsIsolation` = `mode!=="pass-through"||opacity<1||clip`；`_compositeGroup` pass-through→source-over 映射 + 同级 clip）。
- 模型：`src/doc.js`（`LayerGroup.mode` 默认 `"pass-through"`；`addGroup()` 空组）。
- 序列化：`src/ora-stack-xml.js`（组写/读标准 `isolation`；穿透/正常/混合模式三态往返，node 测覆盖）。
- 面板：`src/layers-panel.ts`（组模式下拉 = `GROUP_MODE_LABEL` 穿透置顶）。
- 状态文档：`docs/layer-groups.md`。
