# 架构

一句话：**模型（PaintDoc）⇄ 显示（Board）⇄ 输入（InputController）+ 笔刷（BrushEngine），App 装配它们。**

```
+---------------- App (app.js) ------------------------+
| state: tool / color / pressureEnabled / brushSettings|
| UI:    顶栏按钮 / sliders / picker sheet / theme     |
+---|------------|------------|------------------------+
    |            |            |
    v            v            v
+-------+   +--------+   +-----------------+
| Paint |<--| Brush  |<--| Input           |
| Doc   |   | Engine |   | Controller      |
+-------+   +--------+   +-----------------+
    ^                          |
    |                          v
+--------+                +---------+
| Board  | <------ render | (pointer / wheel / keys)
+--------+                +---------+
```

## 模块边界（写代码时要尊重）

### PaintDoc / Layer — 模型，无 DOM
- 持有 layer 数组。每个 layer = 一个 OffscreenCanvas（或 HTMLCanvas 回退）。
- 提供 `snapshotActiveLayer / restoreActiveLayer` 给 undo / 文件读写用。
- 不知道屏幕、不知道工具、不知道笔刷。

### Board — 显示层
- 拥有可见的 `<canvas>`（HiDPI），把 doc 合成上去。
- 视口 `{tx, ty, scale}` 做 doc → screen 映射。
- 提供 `screenToDoc / docToScreen / pan / zoomAt / fitToScreen`。
- 提供 `setCursor` 给笔尖预览圈。
- 不写 doc 像素 —— 它只**读** doc 来渲染。

### BrushEngine — 把 stamp 落到 layer.ctx
- 三个 API：`beginStroke / extendStroke / endStroke|cancelStroke`。
- 内部 stamp 缓存按 `{size, hardness, color, mode}` keying。
- 不知道屏幕、不知道事件、不持有 undo state。

### InputController — pointer → 行为
- 监听 board.canvas 上的 pointer / wheel / 键盘事件。
- 屏幕坐标转 doc 坐标。
- 一笔开始时对当前 layer 做 `getImageData` 快照塞进 undoStack。
- 调 board.pan / zoomAt / fitToScreen，调 brush.begin/extend/end。
- 屏幕双击切笔/橡皮（ScratchPad 模式：只在 pencil-mode 的手指上响应）。

### App
- 把 state（tool / color / brush settings / pressure 开关 / 主题）拼起来。
- 顶栏按钮 → set state → 通知 input。
- HSV picker sheet（一个 `<canvas>` SV 板 + hue slider + hex input）。
- Service worker 注册 + 更新 toast。

## 一期 vs 后期边界

一期（这一波）的范围：
- 单图层 doc，固定 2048×2048。
- 圆笔 + 压感 + 橡皮 + 吸色 + 屏幕双击切笔/橡皮。
- HSV picker。
- 整图 ImageData 快照 undo。
- 适应屏幕 / pan / pinch / 键盘。
- 没有保存、没有 OneDrive、没有图层 UI、没有 brush preset、没有液化、没有选区。

后期接的钩子（已经留好的，别绕过）：
- doc.layers 数组（一期长度 1）→ 后期 UI 直接展开。
- doc.layer 已有 `opacity / mode / visible` 字段，board 已经在合成时用 → 直接可视化。
- brush.js 注释里列了一串将来要扩的 dynamics 与 stamp 类型。
- db.js stub 占了 `docs / layers / meta` 三个 store 的 schema 位置。
- 文件格式还没定（PSD vs 自定 zip-of-PNGs）—— 写到 `persistence-and-file-format.md` 时再选。

## 状态归属（别两份 SSoT）

| 数据 | 在哪 |
| - | - |
| 像素 | `doc.layers[i].canvas` |
| 当前视口 | `board.viewport` |
| 当前笔刷参数 | `state.brush`（BrushSettings 实例）；传引用给 input.brush |
| 当前颜色 | `state.color` ＋ 同步进 `state.brush.color` |
| 当前工具 | `state.tool` |
| 主题 | `[data-theme]` on `<html>`，localStorage 持久 |
| undo stack | `input.undoStack`（ImageData 列表） |

CSS 变量（`--bg / --ink / --void / ...`）是主题色的 SSoT。Board 取 `--void` 用于画布外底色；其他颜色仅 CSS 用。Board 不应该把 `--ink` 当数据用 —— ScratchPad 那个 `"ink"` sentinel 在矢量笔画里有意义，WebPaint 是栅格，画完了像素已经定下来，不该再随主题"重解析"。
