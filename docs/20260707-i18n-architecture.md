# WebPaint 本地化（i18n）架构

> as-of v375 / 2026-07-06 · 创建日 2026-07-07

目标：支持 **中 / 英 / 日** 三语（外加闲得无聊的 **toki pona**）。核心诉求：
1. 所有文案有一个**单一可信源（SSoT）**，结构上杜绝漏译。
2. 修掉「中文字被当图标占位」导致的**英文撑爆布局**。

本 doc 记录已拍板的决策（含用户原话出处）+ 落地规则。反直觉条目都标了 why。

---

## 0. 已核对的现状（非估，v375）

三个字符串面：
- **静态 `index.html`**：~257 行真 UI（370 行含 CJK 扣 113 行注释）。65 个 `title=`、45 个 `aria-label=`、1 个 placeholder。约 231 条。
- **Vue 模板字符串**（7 文件）：`ui/gallery.ts`、`layers-panel.ts`、`current-brush.ts`、`ui/brush-settings.ts`、`ui/rack-sheet.ts`、`ui/color-wheel.ts`、`ui/left-dial.ts`。中文在 `<template>` 串里也在 `computed` 返回值里。
- **命令式 JS 注入**：`.textContent=` / `.title=` / `.innerHTML=`，~34 处，密集于 `save-status.ts`、`filters-adjust.ts`、`blender-sync.ts`。

其它：
- CSS 只有 **1** 处 CJK `content:`（`styles.css:1980` `content:"编辑中"`）。
- `manifest.webmanifest` 有 1 条 `description` + 硬编码 `"lang":"zh-CN"`。
- 字体：body 无显式 font-family，全靠 `<html lang="zh-CN">`（硬编码 `index.html:2`）让系统字体选 CJK 字形。**零 CJK 字体处理、零 `:lang()`**。
- 规模：去重后 ballpark **~600–1000 条**用户可见串。**这是多 session 工程，不是一次扫完。**

---

## 1. 决策记录

| # | 决策 | 出处 |
|---|---|---|
| D1 | SSoT = **单文件 · 每 key 四语同居**（非按语言分文件） | 用户选「单文件·每 key 各语同居」 |
| D2 | 切换机制 = **持久化 + `location.reload()`**，非响应式 | 用户："change language requires reload. this is easier" |
| D3 | 渲染路线 = **策略 B（Vue）**——新内容按 Vue 标准，不方便就随手修；**不被系统性修 Vue drift distract** | 用户："不被系统性的修vue drift distract… 新加的内容都按vue标准做，如果不方便就随手修。所以我选择B" |
| D4 | 执行力度 = **桥接档**（布局热点顺手组件化） | 用户："选推荐（桥接）" |
| D5 | 图标占位 = **就地改成含中文字形的固定-box glyph-SVG**（占位，TODO 真图标） | 用户："那些中文图标就地改成包含中文字形的svg，到时候todo好好设计" |
| D6 | i18n 内核 **手搓 `t()`，不 vendor vue-i18n**；保留标准 `t()` 门面 | 见 §4 论证 |

**用户否决/警示**：套索文字按钮直接换英文 = **disaster**（原话）——这是 D5 的直接动因。

---

## 2. SSoT：`src/i18n/`

```
src/i18n/
  strings.ts   ← 唯一 glossary，每 key 四语并排
  index.ts     ← t()、当前 lang、setLang()、具名插值
```

```ts
// index.ts
export type Lang = 'zh' | 'en' | 'ja' | 'tok';
// zh/en/ja 必填 → 漏译=编译错；tok 可选，缺则 fallback → en
type Entry = { zh: string; en: string; ja: string; tok?: string };
```

```ts
// strings.ts —— `as const satisfies` 保留 key 字面量 → Key union → t() typo-safe
export const S = {
  'palette.mix.tip':  { zh: '混色', en: 'Mix into swatch', ja: '色を混ぜる' },
  'status.uploading': { zh: '上传中… · {name}', en: 'Uploading… · {name}', ja: 'アップロード中… · {name}' },
  'gallery.emptyTrash.confirm': { zh: '清空回收站？', en: 'Empty trash?', ja: 'ゴミ箱を空に？' },
  // ...
} as const satisfies Record<string, Entry>;
export type Key = keyof typeof S;
```

**为什么四语同居而非按语言分文件**：分文件（`zh.ts`/`ja.ts`…）加 key 时极易漏某语 → **静默漂移**，正是家族「drift=毒」。同居 + `Entry` 类型强制 zh/en/ja 三语必填 → **漏译是编译期错误**，结构上守死。tok 可选，不拖累严肃三语。

fallback 链：`请求语言 → en → zh`。

---

## 3. `t()` 运行时

```ts
let lang: Lang = (localStorage.getItem('wp.lang') as Lang) || detectLang();

export function t(key: Key, params?: Record<string, string | number>): string {
  const e = S[key];
  const raw = (e as any)[lang] ?? e.en ?? e.zh;              // fallback 链
  return params ? raw.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? '')) : raw;
}

export function setLang(l: Lang) {
  localStorage.setItem('wp.lang', l);
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : l;   // 字形选择，见 §6
  location.reload();                                          // D2：reload 制
}
```

- **具名插值 `{name}`**，非 ICU MessageFormat（杀鸡牛刀）。很多串带 `${name}`/计数（`save-status.ts`、`store.ts`、`blender-sync.ts`）。
- **英文复数**只在极少处：用 key 挂函数值或 `_plural` 兄弟 key 局部处理，不上通用复数引擎。
- `t()` 读**当前 lang 一次**（reload 制，无需响应式订阅）。

---

## 4. 为什么手搓 `t()`，不 vendor vue-i18n

`t` = "translate" 是跨库事实标准（i18next / vue-i18n / gettext `_()` / Rails `I18n.t` / react-intl）。我们的 `{name}` 插值跟 vue-i18n 命名插值同款——**门面用标准 `t()`，任何人/AI 一眼认得**。

但内核**不**用 vue-i18n：
1. vue-i18n 的 messages **按 locale 分袋**（`{zh:{…}, ja:{…}}`）——正是 D1 否掉的分文件形，照样漂；我们的四语同居 + 类型门它 enforce 不了。
2. D2 reload 制**不需要** vue-i18n 的响应式 locale。
3. 少 vendor 一个依赖，合 vendor-everything 红线（手搓 ~20 行）。

---

## 5. 三个字符串面怎么接线（桥接 = D3+D4）

### 5a. Vue 模板（7 文件 + 所有新内容）—— i18n 的理想宿主
Vue 里 i18n 几乎免费。**但有软肋**：用的是 `vue.esm-browser.prod.js` **运行时**编译模板字符串，**tsc 不检查模板** → 模板串里 `{{ t('typo') }}` 编译期不报错，抵消类型门。

**纪律（硬规则）**：**`t()` 只在 typed `setup()`/`computed` 里调，译文以 ref 暴露给模板；绝不在模板字符串里直接写 `t('...')`。**

```ts
setup() {
  const L = { mix: computed(() => t('palette.mix.tip')) };   // ← key 受 tsc 检查
  return { L };                                              // 模板写 {{ L.mix }}
}
```
这样 key 拼错 = tsc 报错，类型门才真守住。

### 5b. 静态 `index.html` —— data-i18n 桥（**临时 crutch，非终点**）
HTML 自己不能调 `t()`。给元素挂 `data-i18n` / `data-i18n-title` / `data-i18n-aria`，**启动期一遍 pass** 从 SSoT 填 `textContent`/`title`/`aria-label`：

```html
<button data-i18n-title="tool.brush">…SVG…</button>
```
```ts
// boot：一次性填充
for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]'))
  el.textContent = t(el.dataset.i18n as Key);
// data-i18n-title / data-i18n-aria 同理
```

**定性**：data-i18n 是**过渡桥**。缺点：key 不受 tsc 检查（会 rot）、每串两处编辑。所以——

### 5c. drift 沿断层收敛（D3）
**不做全 shell 大爆炸重写**（碰手感/布局是人类领域 +「重构禁止刮痧」）。规则：
- 新内容 / 需要动的 section → **Vue 组件 + `t()`**（5a）。
- 其余静态 chrome → 先走 data-i18n 桥（5b），**能跑就不碰**。
- 当某段 chrome 为了英文**反正要改布局**时（见 §7 热点），就地把那段迁成 Vue 弹性组件、`t()` 直用、**同时退掉它的 data-i18n**。
- data-i18n 随迁移**逐段缩小**，永不留成第二个永久 SSoT 消费者。

### 5d. 命令式 JS + 对话框 choke point
`host.confirm(title, body)` / `host.input()` / `busy()` / `{title, body, danger}` 是**收口**——让它们**收 key 不收字符串**，一处转换覆盖大量 confirm/sheet。结构化数据表（`input.ts:201–217` 快捷键 `desc`/`category`、`cloud-freshness.ts` 网络对话框选项）直接 key。

---

## 6. 字体 / `<html lang>`（做日文的前置）

现在全局 `lang="zh-CN"` → 日文共享汉字（直/骨/今…）会渲成**中文字形**。必须：
1. boot 时从持久化 locale 设 `document.documentElement.lang`（`setLang` 已做，见 §3）。
2. styles 加显式 CJK 栈 + `:lang()`：
   ```css
   :lang(zh) { font-family: system-ui, 'PingFang SC', 'Noto Sans SC', sans-serif; }
   :lang(ja) { font-family: system-ui, 'Hiragino Sans', 'Noto Sans JP', sans-serif; }
   ```
3. **toki pona 走拉丁罗马化**（`tok`）——sitelen pona 要 vendored 字体，**暂不做**。

`manifest` 的 `description`/`lang`：manifest 只 fetch 一次，运行时难本地化。**暂留 zh**（低优先），未来要么按 locale 生成多份。

---

## 7. 图标占位修复（D5）——「中文字形 glyph-SVG」

### 断点定位（已核对）
- **真断点**：调色板行 `index.html:500–503` `笔/混/吸/清`（单字 pill，`.palette-tools button` @styles.css:1736 padding:4px 12px）。已带语义属性 `data-palette-tool="brush|mix|picker"`。
- **次断点**：套索文字栏 `index.html:417–437`（`变换/填色/清除/复制层/移到层/自由/等比/透视/盖印/应用/取消`，`.lasso-tool-btn` @styles.css:190）。
- **安全（已是 SVG + title）**：主工具栏 `index.html:86–120`、套索 sub-tool `.lasso-tool-icon`（32px 方 icon）。翻 `title`/`aria-label` 即可，布局不动。

### 统一规则
把上述「中文当图标」的按钮**就地改成固定 `viewBox` 的 glyph-SVG**：把当前中文字塞进定框 SVG，宽度锁死、与语言无关。

```ts
// glyphIcon('混') → 固定 24×24 box，居中中文字形
const glyphIcon = (g: string) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
     <text x="12" y="12" text-anchor="middle" dominant-baseline="central"
           font-size="16">${g}</text></svg>`;
```

- 这些 glyph **不进 i18n、永不翻译**（图标就是图标，中文字形只是占位）；语义由**翻译过的 `title`/`aria-label`** 承载。
- 每个挂 `<!-- TODO 真图标，见 docs/20260530-icon-iteration-prompt.md -->`。
- **多字按钮**（复制层/移到层/透视/盖印）：24×24 塞 3 字不清 → 现取 **1 字代表**（复/移/视/印），真图标阶段再设计。
- 净效果：palette + lasso 全变**宽度稳定**的 icon 按钮，套索英文 disaster 消失，**且不被 SVG 设计 distract**。

### CSS `content:"编辑中"`（@styles.css:1980）
CSS 吃不了变量 → 改成 JS 设 badge 元素文本，或 `::before` 读 `data-*`。小事。

---

## 8. 落地顺序（切片）

- [x] **切片 1（v376，已落 dev，已 Chromium 端到端验）**：`src/i18n/` 核心（`strings.ts` 类型门 + `index.ts` t/setLang/localizeDom）+ 语言切换器（⋯菜单，cycle zh→en→ja→tok + reload）+ 首批 SVG-free 文案：**工具栏 tooltip（data-i18n-title 桥）+ ⋯菜单 Settings/Debug 段 + 通用对话框 OK/取消 + 状态行 idle**。`:lang(ja)` 字体栈。playwright 验：en/ja/tok 四语渲染、`<html lang>` 动态、tok→en fallback、endonym、idle 复位均过（18/18）。**真机未验**（桌面 Chromium 已验）。
  - 遗留（切片内诚实交代）：`topSaveBtn` title、`cloudIconBtn`、⋯菜单**文件段**（导入/导出/重命名/加密/裁切…）、`menuEncryptLabel`/`menuCropLabel` 等 JS 动态标签、绝大多数 `setStatus` 消息 —— 仍中文，归切片 2。
- [x] **切片 2（v377，已落 dev，Chromium 端到端验 30/30）**：⋯菜单文件段静态标签（import/export/rename/saveAs/revert/flipH/rotate90/offset/resample/reference/fit/gallery）+ 扳手 tooltip（3 config）+ 动态标签 encrypt(`app.ts` watch)/crop(`doc-ops.ts`)/subs(`export-import-menu.ts`)+ 顶栏保存按钮 7 态（`save-status.ts`，{name} 插值）。**⋯菜单现全 4 语**。遗留：对话框 **caller** 侧标题/消息（`openConfirmSheet`/`openInputSheet` 的 title/message 仍中文，散在 doc-ops/session-state/brush-rack 等）→ 归切片 2b/5；OK/取消按钮已切片 1 localized。
- [x] **切片 3（Vue 7 文件全部完成）**：模板 `t()`（§5a：setup 里 `L` manifest，模板引 `L.*`；TS handler/status 直接 `t()`）。
  - [x] **3a（v378，已落 dev，Chromium 36/36）**：color-wheel / left-dial / rack-sheet / **layers-panel**（含 `LAYER_MODE_LABEL`/`GROUP_MODE_LABEL` 混合模式名收成 i18n 单一源→图层面板+笔刷设置下拉共用；badge/eye/menu/status/undo 全 4 语）。
  - [x] **3b（v379，已落 dev，组件级 Chromium 48/48 en·ja + 无 CJK 残留负检）**：`ui/brush-settings.ts` 全屏表单（section 标题/label/option/按钮；latin 参数名 size/opacity/flow/streamline/…/compositeMode 有意不译）。验证=esbuild 单组件 harness 直接挂载渲染（模板不受 tsc 检查 → 必须真渲染验 L.* 无 typo）。
  - [x] **3c（v380，已落 dev，Chromium 38/38 含 gallery 空态 en·ja）**：`ui/gallery.ts`（图库/文件管理 ~75 串：host.status/confirm/input/busy + emptyText/nameTaken + 模板 tile 按钮/菜单）。TS handler 直接 `t()`；模板 buttons 走 `L` manifest；复用 menu.encrypt/decrypt + enc.locked.aria。验证=typecheck + 无 CJK 残留扫描 + gallery 空态实渲染 + 模板 `L.*` 引用逐条人工核对（tile-menu 因需真作品渲染，headless-gallery 空态到不了，靠静态核对+扫描）。current-brush.ts 无用户可见串。
- [ ] **切片 4**：图标占位 glyph-SVG（§7，与 SVG track 的 `20260707-svg-icon-inventory.md` 对接）+ 套索栏布局。
- [~] **切片 5**：命令式 JS 散点 + `input.ts` 快捷键表 + `cloud-freshness.ts` 网络对话框。
  - [x] **5a（v381，已落 dev，Chromium 40/40 shortcuts en·ja）**：`input.ts` KEYBOARD_SHORTCUTS 表——desc/category 改存 i18n key，`settings-menu.ts` `_renderShortcutsSheet` 渲染时 `t()`。+~30 key(sc.*)。验证=程序触发 menuShortcuts 渲染 sheet 读 #shortcutsBody。
  - [~] **5b**：index.html 剩余静态 chrome。
    - [x] **5b-1（v382，已落 dev，Chromium 48/48）**：gallery 菜单/回收站 chrome + 新建作品 sheet + 浮窗标题(图层 restructure 保 count / 参考) + 图层脚工具 + 参考窗 + 关闭 aria（~48 处 data-i18n，subagent fan-out 应用 + 我审）。
    - [x] **5b-2（v383，已落 dev，Chromium 55/55）**：lasso icon tooltips + brush rack/settings-view header + sync-gate spinner + 大图导入/重采样/偏移/裁切/调整/颜色/清空/更新toast 对话框 + 共用 dim.*/interp.*/common.apply/save/reset/exit/custom（~65 处，subagent fan-out+审）。**遗留(小)**：icon 按钮的 aria-label 仍中文（title 已译，视觉全对；aria≈title 的 a11y polish，可后补）。glyph 文字按钮(套索文字栏 变换/填色…+palette 笔混吸清)=切片 4；JS 动态标签(galleryFootUsage/cloudAccountInfo/brushRackTitle/lassoSelOpTitle/syncGateTitle/adjustPanelTitle/bigImportInfo)=5c。
  - [ ] **5c**：命令式 setStatus 散点（filters-adjust / blender-sync / cloud-auth-ui / import-image / doc-ops / session-state / brush-rack …）+ `cloud-freshness.ts` 网络对话框。
- [ ] **抽取**：subagent 按文件簇 fan-out 机械抽 key。按面分批交付（高可见 chrome 优先）。

**诚实标注**：全量 ~600–1000 条，多 session。每批按家族「我只测一次就是交付」的批量真机纪律走。

---

## 附：反直觉备忘
- **glyph 图标不翻译**——中文字形当占位，UI 切英文时它仍是中文字（tooltip 才翻）。这是有意的，避免被 SVG 设计 distract；真图标是独立 TODO。
- **模板里不写 `t()`**（§5a）——写了就丢 key 类型安全，白搭四语同居的 SSoT。
- **data-i18n 是桥不是家**（§5b/c）——别把它当第二个永久机制养。
