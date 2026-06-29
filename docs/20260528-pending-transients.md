# Pending Transients：通用护栏

> 用户 2026-05-28 提议。架构级机制，给未来的"未提交瞬时状态"做兜底。

## 问题

WebPaint 在编辑过程中有些**未提交的瞬时状态**：
- 套索浮层（lasso floating）：lift 后未 commit / cancel
- 未来可能有：text-in-progress、shape draft、liquify 还没松手、笔触还没结束等

任何"用户决定性动作"（切工具 / save / 进图库 / 切 session / rename / 新建 / 导入）都应该
让这些 pending state **先 apply**，否则容易出现"用户切走 → state 丢失或半态污染数据"。

如果每个 caller 都手写 `if (lasso.hasFloating()) commit; if (text.editing) ...`，N 个 caller × M
种 pending = NM 个 if，必丢。

## 方案

中心化注册表 + 单一 `applyAllPendingTransients()` 入口：

```js
// app.js（boot 时一次性）
const _pendingTransients = [];
function registerPendingTransient({ check, apply, label }) {
  _pendingTransients.push({ check, apply, label });
}
function hasAnyPendingTransient() {
  return _pendingTransients.some((p) => { try { return p.check(); } catch { return false; } });
}
function applyAllPendingTransients() {
  for (const p of _pendingTransients) {
    try { if (p.check()) p.apply(); }
    catch (e) { console.warn(`[pending] ${p.label} apply failed:`, e); }
  }
}
```

每个"会有 pending state 的工具"在 boot 时注册一行：

```js
registerPendingTransient({
  label: "lasso-floating",
  check: () => input.lasso.hasFloating(),
  apply: () => input.commitLassoIfFloating(),
});
```

每个"用户决定性动作"的 entry point 在最前面调一次：

```js
function setTool(t) {
  applyAllPendingTransients();   // ← 唯一一行
  // ... 切工具
}
async function saveNow(opts) {
  if (hasAnyPendingTransient()) {
    if (opts.implicit) return;            // 后台路径跳过
    applyAllPendingTransients();          // 显式路径 apply
  }
  // ... save
}
async function setGalleryOpen(open) {
  applyAllPendingTransients();
  // ...
}
```

## 显式 vs 隐式

| 路径 | 行为 | 例子 |
|---|---|---|
| 显式（用户决定性动作）| apply 所有 pending 再继续 | Ctrl+S / 点 save / 切工具 / 进图库 / 切 session / rename / 新建 |
| 隐式（后台路径）| floating 时**跳过**整个操作 | 3min autosave / visibilitychange / pagehide |

理由：
- 显式 = 用户主动，他期望"我做的全保留"，apply 是符合期望的
- 隐式 = 后台 silently 触发，apply 会"凭空"把变换烤进 layer，用户回来会困惑

## 数据安全约束

每个 transient 实现 apply 时必须保证：
- apply 后，doc / layer 是合法已提交状态
- 后续任何 save 都能正确序列化
- 失败要么完全 apply 要么完全不动（**不**留半态）

apply 后再 save，IDB 状态正确。这就是这套机制的核心保证。

## 当前注册表

| transient | check | apply | 备注 |
|---|---|---|---|
| `lasso-floating` | `input.lasso.hasFloating()` | `input.commitLassoIfFloating()` | v56 起 |

## 未来注册示例

```js
// 假设未来有 text tool 的"编辑中"状态
registerPendingTransient({
  label: "text-editing",
  check: () => input.text.isEditing(),
  apply: () => input.text.commitEdit(),
});

// 假设 shape draft（未确认形状）
registerPendingTransient({
  label: "shape-draft",
  check: () => input.shape.hasDraft(),
  apply: () => input.shape.commitDraft(),
});
```

不需要改 setTool / saveNow / setGalleryOpen / ... 自动覆盖。

## 给 AtlasMaker 同事

如果你的项目有类似的 "in-progress 编辑状态" 概念（比如未保存的笔记草稿、未提交的标注、
未确认的搜索 query），照搬这个模式：
1. 中心化注册表
2. apply 在 user 决定性动作的 entry point 调一次
3. 隐式后台路径跳过 transient state 期间的 save

避免到处糊 if，避免遗漏某个 entry point。
