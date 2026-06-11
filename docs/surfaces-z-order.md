# Surfaces —— z-order 深模块

> as-of v232 / 2026-06-11

## 问题

v231 以前 z-index 是 30+ 个散落在 CSS/JS 里的手填数字，两类反复出现的 bug：

1. **窗口互相盖**：toggle 图层面板，它还压在参考窗下面（float-panel 全是静态 15）。
   v113 的 `_bringPanelTop` 用无上限递增计数器（15→16→17…），点 15 次就爬过菜单层
   （menu-panel 30），菜单反被窗口盖住。
2. **新 UI 手填数字踩坑**：图库菜单 popup 没写 z → 落到 .menu-panel 30 < .gallery-full 50，
   点了菜单弹不出来（其实弹在图库下面）。

user 的原话（2026-06-11）：「有什么深模块能一劳永逸的解决 zorder 的问题吗，还有一个就是
保证菜单在窗口上面，不用程序员手动填」。

## 设计

两半：**静态 band 表（CSS SSoT）** + **窗口 band 内的动态栈（surfaces.ts）**。

### 1. band 表 = styles.css `:root` 的 `--z-*` 变量

全仓唯一允许出现 z-index 数字的地方。band 序（结构不变量，新 UI 不许违反）：

```
chrome(10) < toolbar(25) < window(100..) < sheet(220) < overlay(300)
  < menu(400) < toast(450) < modal(500) < gate(520) < busy(540)
  < popout(600) < dev(700) < error(9999)
```

- **chrome**：顶栏 / 左栏 / HUD。
- **toolbar**：lasso / crop / filterBrush 顶栏条（crop-overlay = -1）。
- **window**：浮窗（参考 / 图层 / 颜色 / 调整面板 / 色板）。基底 100，**band 内顺序归 surfaces.ts**。
- **sheet**：笔架 sheet（220）、笔设置全屏 view（+10）。
- **overlay**：全屏页（图库 / 云端）。
- **menu**：一切菜单 / popup（汉堡、调整、图库菜单、size popup、回收站⋯）。
  band 序保证「菜单永远在窗口、sheet、全屏 overlay 上面」——这正是图库菜单 bug 的根治。
- **modal**：.backdrop / .sheet 确认对话（resample = -2/-1，使确认能盖住调整尺寸）。
- **gate / busy**：sync 锁屏 / fullscreen-busy 防误点。
- **popout**：anchored-popup、picker-pin——按设计「永远最高」（比 modal 还高，色轮等要浮在确认上）。

新 UI 接入 = 选 band 写 `z-index: var(--z-menu)`，**不发明数字**。
局部 stacking context 内的相对值（gallery tile 内 ⋯popup、menu-config-popup、board-grid/cursor）
不在表内，保持小整数。

### 2. surfaces.ts = window band 内的动态栈

```
registerWindow(el)   // 注册：进栈底 + pointerdown capture → raise（点谁谁到顶）
raiseWindow(el)      // open/toggle 显示时调：提到栈顶，整栈重新归一化 z = base + idx
```

归一化让 z 永远困在 band 内（取代递增计数器）。base 从 computed style 读 `--z-window`
（SSoT 仍在 CSS）。接入点：

- 注册：transient-panels.ts `initTransientPanels`（colorPanel / paletteWindow /
  referencePanel / adjustPanel / **layersPanel**）。
- raise on open：layers-panel `toggleLayersPanel`、reference.js `open()`、palette.js `open()`、
  color-panel `toggleColorPanel`、filters-adjust（经 `_bringPanelTop` 别名，已 re-export 成
  raiseWindow）。

### 不变量清单（改 UI 时自查）

- 菜单/popup 永远 > 任何窗口、sheet、overlay（band 序）。
- 窗口 z 永不离开 [--z-window, --z-sheet) 区间（归一化）。
- 确认 sheet（modal）> 菜单：菜单里点出确认对话不会被自己盖。
- anchored-popup > modal：modal 里仍可弹色轮 / dropdown popout。
- 新浮窗 = `registerWindow` 一行 + open 时 `raiseWindow`；新菜单 = class 用 var(--z-menu)。
