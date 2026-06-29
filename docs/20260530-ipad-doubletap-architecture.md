# iPad 双击误触 —— systematic 解决方案设计稿（v124 起讨论）

## 痛点

iPad PWA 在某些位置双击会触发**系统级**手势（window drag / split-view / 文本选中等），
本应进 app 的 pointer 被劫持，后续 finger state 抽风，按钮无响应。

每次新加 div / button / panel 都可能引入新的"漏网区域"。**靠手动 case-by-case
preventDefault 不能根除**——会一直漏新元素。

## 现状（v124）

零散地：
- `meta viewport user-scalable=no` ✓ 全局
- `touch-action: manipulation` 在大多数 canvas / tool button 上加了
- v111 加了 global `pointercancel` / `blur` / `visibilitychange` → `cancelAllPointers()`
- 全局 `wp:doubletap` 自定义事件（pencil 模式下双击切笔↔橡皮）

漏的：每次新加 panel / popup 都可能漏 `touch-action`；动态生成的 DOM（layer rows、
gallery tiles、custom popup）容易没标注。

## 系统性方案（4 层防御）

### 1️⃣ Body 级 touch-action（最外层兜底）

```css
html, body {
  touch-action: manipulation;
  -webkit-touch-callout: none;   /* iOS 长按链接 / 图片菜单 */
  -webkit-user-select: none;     /* iOS 长按文本选中 */
  overscroll-behavior: none;     /* 阻止 PWA 下拉刷新 */
}
```

`touch-action: manipulation` 关掉 double-tap-to-zoom。**默认从根传给所有子元素**，
不需要每个新加的 div 都单独标注。

### 2️⃣ Global pointer interception（capture phase）

```js
// 在 capture phase 拦所有 dblclick / touchstart 多手指
window.addEventListener("dblclick", (e) => {
  // 没明确进入 input / textarea 等需要原生 dblclick 的元素 → preventDefault
  if (!isTextEditableTarget(e.target)) e.preventDefault();
}, { capture: true, passive: false });

window.addEventListener("touchstart", (e) => {
  // 阻止 3 指及以上的系统 gesture (split-view, slide-over)
  if (e.touches.length >= 3 && !isAllowedMultiTouch(e.target)) {
    e.preventDefault();
  }
}, { capture: true, passive: false });
```

`capture` phase 在元素自己的 listener 之前先跑，比 bubble preventDefault 强。

### 3️⃣ Page-level CSS: pointer-events / user-select

```css
.canvas, .top-bar, .left-sidebar, .float-panel, .lasso-toolbar {
  user-select: none;          /* 整个 paint UI 区域不允许选文本 */
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;  /* iOS tap 时蓝色高光 */
}
input, textarea, [contenteditable] {
  user-select: text;          /* 只有真正需要输入的 elements 反向开 */
}
```

一次性写到 `body.css`，所有新 panel 自动继承"不可选文本"。

### 4️⃣ Pointer state 自愈

每次 visibilitychange / blur / pointer 异常时**强制 cancel 所有 in-flight pointers**：

```js
function resetPointerState() {
  // input.pointers Map 清空，所有 active 工具 abort
  input.cancelAllPointers();
  // 关闭可能卡住的 transient（lasso floating / crop / adjust 等）
  applyAllPendingTransients();
}
window.addEventListener("visibilitychange", () => {
  if (document.hidden) resetPointerState();
});
window.addEventListener("blur", resetPointerState);
window.addEventListener("pointercancel", (e) => {
  // 系统 cancel 单个 pointer → 也清掉 input.pointers 里对应那个
  input.cancelPointer(e.pointerId);
}, { capture: true });
```

即使 1-3 都漏了一些，4 能保证"被劫持的 finger state 自动重置"——
最坏 case 是 user 看到 stroke 卡一下，重新落笔 OK。

## 这套设计的好处

- **不需要给每个新加 div / panel 单独标注**：1 在 body 级、3 在 paint UI 区域级
  自动继承
- **多手指系统 gesture 被 capture phase 拦住**：不会进 elementsFromPoint 路径
- **pointer state 自愈**：偶发劫持也能恢复，user 体验最坏是顿一帧
- **未来加新 panel 自动安全**：只要它的祖先在 `.canvas` / `.top-bar` 这些覆盖范围里

## 实施工作量

- v124：不实施，先 review 设计
- v125 候选：~50 行 CSS + ~30 行 JS。1-2 小时
- 风险：第 2 步 capture-phase preventDefault 可能误拦一些合法 dblclick（双击编辑名字之类）。要白名单 `isTextEditableTarget` 仔细列

## 测试 checklist

实施后 user 在 iPad 上验证：
- [ ] 双击 canvas 不触发 window drag
- [ ] 三指 swipe 不触发 split-view
- [ ] 双击 layer row 仍可编辑名（rename input）
- [ ] gallery tile 双击仍可 open（如果设计是双击 open）
- [ ] PWA 标题栏区域双击不触发系统 swipe-down 关闭 PWA
- [ ] 长按 stroke 期间 home indicator swipe up 后回来，stroke 不卡

## Open question

iPad 系统**显示 status bar 区域**的双击是不是必然进系统？目前看不可拦。
唯一办法是 PWA 全屏 + viewport-fit=cover 让 status bar 上的双击落到 app 外。
但 viewport-fit=cover 又有 safe-area inset 处理负担。tradeoff 想过再说。
