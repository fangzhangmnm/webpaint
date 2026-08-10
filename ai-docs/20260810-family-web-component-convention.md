# 家族 web component 约定（C9 试点定形）

> as-of v0.8.47 / 2026-08-10。试点 = `<wp-reference-window>`（`src/frontend/reference-window.ts`，
> 宿主适配层 = `src/side-windows.ts`）。出处：C 骑士 grill §七.2/.3（iframe 手势稀烂已否 →
> web component 壳；「如果这轮抽反而帮助逼出来接口就这轮」）。本 doc 是约定模板——下一个组件
> （gallery=E 骑士、webpaint-editor=embedding 纪元）照此办理；试点没踩到的坑照常更新本 doc。

## 0. 什么算「家族组件」

自带 chrome（DOM/样式/图标/手势）、**宿主 store 零知识**、可被兄弟项目 vendor 的自定义元素。
判据（grill 粒度语义）：「src 目录的五个是 webcomponent 或者背景进程或者代码库」量级——
一个浮窗/一块自治 UI 够格；一个按钮/一个控件类一般不够（「不用分的那么细」）。

## 1. 文件与命名

- 组件住 `src/frontend/<name>.ts`（frontend 格律：只准 import common+backend+vendor；
  组件**再收紧一档：只 import common**——backend 知识经宿主注入，否则 vendor 出去带走半个引擎）。
- tag = `wp-<name>`（前缀 = 原产 app；跨仓复用时保留原产前缀，同 sprite id 语义）。
- `customElements.define` 在模块 eval 时做，**guarded**（`if (!customElements.get(tag))`——
  双注册 throw，vendor 场景可能被两个 bundle 各带一份）。导出类 + `WP_<NAME>_TAG` 常量。

## 2. 接口面（核心约定：谁发事件）

| 方向 | 机制 | 语义 |
| --- | --- | --- |
| 宿主 → 组件（状态下灌） | 属性/property set（`open`/`viewport`/`rect`…） | **程序性 set 不发事件**（同原生 `<input>.value`）。apply-on-load 回灌走这里 → 不会触发宿主回写、不误标脏 |
| 组件 → 宿主（用户交互） | `CustomEvent`（不 bubble，宿主直接挂元素上） | **只有用户交互发**：pan/pinch/wheel/拖窗/resize/按钮/吸色。宿主拿去持久化（desk/store） |
| 组件 → 宿主（意图请求） | `request*` 事件（`requestload`/`requestlivetoggle`） | 组件只发意图，动作是宿主知识（文件对话框、live 源、状态栏文案） |
| 宿主 → 组件（推送通道） | 方法调用（`markLiveDirty()`/`setBitmap()`） | 组件**不监听 window 全局事件**——`wp:*` 通道是宿主约定，适配层转发 |
| 宿主 → 组件（手势中查询） | function-valued property（`queryLongPressPick`） | **pull 例外**：交互瞬间才需要的宿主态。能用属性同步就不用 pull（见 §5 pick 桥） |

**回声守卫归宿主**：ResizeObserver 在程序性改动后也会 fire（组件如实发 `rectchange`），
宿主写 store 前做值比较（side-windows `rectchange` 监听是样板）。组件不需要 `_applying`
之类的抑制期 hack——试点里旧 reference.ts 的两帧守卫正是被这套分工退役的。

## 3. Shadow DOM

- `attachShadow({ mode: "open" })`（可调试 + smoke 可 querySelector）。
- chrome 样式全在 shadow `<style>`；**主题 = CSS 变量穿透**：只消费 `--bg/--ink/--ink-soft/
  --line/--accent/--radius/--shadow/--z-window`，**全部带 fallback**（裸挂第三方页也成型）。
  宿主想覆盖，document 规则天然赢过 `:host` 默认。
- **图标烤进 shadow**：`<use href="#id">` 不穿 shadow 边界（sprite 内联在宿主 body 够不到）。
  从家族 sprite 拷 symbol 内容进模板，**源 id 写进注释 = 对账 key**（图标库对账义务照旧：
  上游改了这几个 id 就重拷）。
- 文案两条路：**slot**（title/empty 等成块文案——light DOM，宿主 i18n `data-i18n` 扫得到，
  零接口）+ **`labels` property**（shadow 内按钮 tooltip/aria，slot 够不到 attribute）。
  语言切换 = 整页 reload（i18n 既有约定），labels 在 init 设一次即可。
- 宿主侧必备两行 CSS：`<tag>:not(:defined) { display:none }`（define 前不闪 light DOM）+
  slot 内容排版（slotted 子孙由 document 样式管，`::slotted()` 只够到顶层）。

## 4. 状态所有权

- **交互态归组件**（viewport/拖窗/手势/吸色进行中/live 开关反射）；**持久化归宿主**
  （desk/store/localStorage 组件一概不认识）。组件 attribute 反射只读状态（`live`）供 CSS/宿主读。
- 宿主注入的重资源走 **provider 函数**（`setLiveProvider(() => canvas)`）：合成/解码/resample
  是 backend 知识，留在宿主；组件只吃「一张能 drawImage 的图」。节流/脏标（显示学问）归组件。
- 宿主布局事实（安全区钳制、默认 spawn 位）以常量留在组件内并注释——它是原产 app 的组件；
  第二消费者出现且布局不同时再升属性，**非必要不加接口**。

## 5. 宿主适配层（每组件一个，试点=side-windows.ts）

适配层是组件的「全部宿主知识」集中地：store 持久化、`wp:*` 全局事件转发、i18n labels、
与其他系统的桥（吸色 → setColor + picker pin；工具态 → `pick` 属性）。
工具态桥用**属性同步**而非 pull：监听宿主变更通知（`wp:modechange`）→ `toggleAttribute`，
组件 CSS/行为都吃属性（`:host-context()` Safari/FF 不可靠，**禁用**）。
z-order：组件是普通 HTMLElement，照常进 surfaces window band（registerWindow/raiseWindow）。

## 6. vendor 提取

`bash scripts/gen-component.sh src/frontend/<name>.ts` → `dist-components/<name>.mjs`
（esbuild --bundle --format=esm；脚本自检 bundle 零裸 import）。兄弟项目物理拷进自己的
`src/vendor/`（家规 #4），`import "./vendor/<name>.mjs"` 即注册。产物 gitignored——
它是导出件；SSoT 永远是原产仓的 .ts。

## 7. 测试

- 纯逻辑（手势数学等）抽 `src/common/` 纯函数 → node 直测（试点：pointer-gesture 已在）。
- 组件本体要真浏览器：**gl-smoke harness 加 check**（试点 `referenceComponentCheck`：
  define/挂载/渲染读回/交互发事件 vs 程序性静默/live provider）。
- 手感（拖窗/双指/长按）照旧真机批。

## 8. embedding 终态备忘（不在本轮）

webpaint-editor 组件 = 同一约定的大号版：webcomponent 壳 + **Worker backend**
（postMessage 协议 = webpaint-backend-interface 同一份接口文件，「multiplayer 一刀，
webcomponent 一刀」）。iframe 只留给完全不信任第三方的场景。gallery 组件归 E 骑士。
