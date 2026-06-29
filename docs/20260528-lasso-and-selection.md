# Lasso 与选区架构

> v65+ 重做（user 2026-05-28）。原 lasso 把"圈→lift→transform"做成一条线。新架构把
> **选区**抽成一等公民：选区是 doc 上的一个 mask，独立于 layer 像素，独立进 undo。
> transform 只是用户拿着选区"接下来要做的事"之一。

## 数据模型

```js
// PaintDoc 新字段
doc.selection = null | {
  bboxX, bboxY, bboxW, bboxH,    // doc 坐标
  maskCanvas,                     // alpha 通道 = mask（0 外 / 255 内；将来支持 feather alpha）
}
```

`null` = 没选区 = 所有像素都可作用（默认）。

## 状态机

```
            ┌── lasso 子工具：自由 / 矩形 / 魔术棒 ──┐
            │                                          │
[no-selection] ─── 圈一次 ─────────────────────────> [has-selection]
                                                          │
                                                          ├── 「变换」 → [transforming] (Pending Transient)
                                                          │                ↑ commit / cancel
                                                          │                └─── 回 [has-selection]
                                                          ├── 「填色」 → 选区内填色（一步 history）
                                                          ├── 「清除」 → 删除选区内像素
                                                          ├── 「反选」 → mask 反转
                                                          ├── 「取消选区」 / Esc → [no-selection]
                                                          │
                                                          ├── 切笔刷 / 橡皮 / 液化 → 工具 respect mask
                                                          │   留在 [has-selection]，选区还在
                                                          │
                                                          └── lasso 再圈 + 集合 modifier → 修改 mask
                                                              留在 [has-selection]
```

关键认识：
- **选区不是 transient**。它有自己的 undo entry（`selectionChange`）。
- **transform 才是 transient**。Pending Transients 护栏管它（见 [20260528-pending-transients.md](20260528-pending-transients.md)）。
- 选区是 transform **的前一步**。

## Lasso 工具 sub-modes

工具栏新增 lasso sub-tool 选择器（套索激活时显示）：

| sub-mode | 行为 |
|---|---|
| **自由（默认）** | 拖动画自由曲线，松手时闭合成多边形 |
| **矩形** | 拖动画轴向矩形（可选：按住某 modifier 转成等比正方形）|
| **魔术棒** | 单击像素，flood-fill 连通区域（与点击像素颜色差 ≤ 阈值）。阈值滑块 0-100 |

## 集合操作 modifier

每次圈完应用到现有选区，决定怎么合并：

| modifier | 数学 | UI |
|---|---|---|
| 新建 | `sel = new` | 默认 |
| 并 (union) | `sel = old ∪ new` | 工具栏 + 号 |
| 减 (subtract) | `sel = old \ new` | 工具栏 − 号 |
| 交 (intersect) | `sel = old ∩ new` | 工具栏 ∩ 号 |

实现：在 maskCanvas 上分别用 `source-over` / `destination-out` / `destination-in` 组合 + 复合 alpha
计算。或 per-pixel boolean op。

## 选区工具栏（has-selection 时显示，位置同原 transform 工具栏）

```
[变换] [填色] [清除] [反选] | [取消选区]
                              └── lasso 激活时额外有：[新建][+][−][∩]  [自由][矩形][魔术棒] [阈值=20]
```

## 其他工具 respect mask

| 工具 | 改法 |
|---|---|
| 笔刷 | endStroke 后用 `dst-in mask` 把选区外像素抹掉；或 stamp 阶段就 clip。最简：stroke buffer + composite |
| 橡皮 | 同上（橡皮也是 stroke 类型）|
| 液化 | per-pixel 循环内加 `if (mask[x,y] == 0) continue` |
| 调色（未来） | dst-in mask |
| 填色 | 选区内填色 = drawImage solid + dst-in mask + over layer |

## History

新 handler `selectionChange`:
```js
{ type: "selectionChange", before: maskCanvas | null, after: maskCanvas | null }
```

undo = 把 doc.selection 还原回 before；redo 还原回 after。
maskCanvas 用 PNG blob 压缩异步存（同 stroke pixel snap pattern）。

笔刷 / 液化 / 填色 / 清除 仍是 raster pixel snap（已存在的"stroke" handler），不变。

## 分阶段

**P1（v65）** —— 架构 + 自由 lasso + 变换入口
- `doc.selection` + history `selectionChange`
- 自由 lasso 圈 → 更新 selection（不 lift）
- board 画 marching ants
- 工具栏：变换 / 取消选区
- 「变换」按钮才进 transform（现有 floating + mesh + gizmo + 应用/取消复用）

**P2（v66）** —— 集合操作
- 工具栏 segment control：新建 / 并 / 减 / 交
- 第二次圈按 modifier 合并

**P3（v67）** —— 矩形 + 魔术棒
- 矩形 sub-mode（拖角）
- 魔术棒 sub-mode（点击 + 阈值滑块 + flood fill）

**P4（v68+）** —— 选区动作
- 填色 / 清除 / 反选 按钮
- 笔刷 / 橡皮 / 液化 respect mask

## 给 AtlasMaker / 兄弟项目

选区作为一等公民的设计可以抄；这套状态机适用于任何"先选范围再操作"的编辑器。
关键决策：
- 选区**不进** Pending Transients 护栏（它不是 transient，是持久 state）
- 选区**有独立 undo 类型**（不和像素 undo 混）
- "选区→操作"是显式步骤（"变换"是按钮，不是 lasso 圈完自动进入），降低误触

参考 [20260528-pending-transients.md](20260528-pending-transients.md) 区分 transient state 和持久 state。
