# Filter 插件架构（v132 起）

## 一句话

调色 / 调整效果（HSB / Color Balance / Curves / Sharpen-Blur / 未来的 mosaic / halftone …）都是 **Filter 插件**：一个 ES class，import 时自注册到全局 registry，菜单按 registry 动态渲染。

第一方插件 ship 在 bundle 里；第三方 / artist filter 后期走下载，跑同一接口。

## Why

- **解耦**：调色逻辑全跟核心 paint engine 解耦，加 / 删 / 替换不影响主流程
- **未来扩展**：mosaic / 半调 / 教堂彩窗 / AI 滤镜 走插件下载，不打包进 bundle
- **统一 UI**：所有 filter 共用 adjust 面板的 preview / apply / cancel / mask 基础设施
- **plugin SDK**：暴露 `window.WebPaint.registerFilter(...)`，第三方写一个 .js 就能接入

## 代码布局

```
src/
  filters.js                     ← Filter 契约 + registry + helper（不含具体 filter）
  plugins/
    index.js                     ← barrel：import 所有第一方插件触发自注册
    hsb.js                       ← class HsbFilter { ... } registerFilter(HsbFilter)
    color-balance.js
    curves.js
    sharpen-blur.js
  app.js                         ← import "./plugins/index.js"，菜单 listFilters() 动态渲染
```

第三方插件（未来下载）：

```
<plugin source>
  mosaic.js                      ← 同样 class + registerFilter(MosaicFilter)
                                   user 安装后 fetch → IDB cache → dynamic eval
                                   注册后 onFilterRegistered hook 让菜单出现入口
```

## Filter 契约

```js
class MyFilter {
  static id = "myFilter";        // 唯一 string，菜单 + history 用
  static title = "我的滤镜";       // 中文显示名
  static category = "adjustment"; // "adjustment" / "artist" / ...，菜单分组
  static modes = ["region"];      // 或 ["region","brush"]，或 ["brush"]
                                  //   region = 整层 / 选区一次性烤
                                  //   brush  = 笔刷输入（每 stamp 触发）—— Phase B
  static bleedRadius(params) { return 0; }
                                  //   non-local 必须 override（如 blur）；brush 模式用
                                  //   它 padding stamp bbox 防边缘 clamp 失真
  static defaults() {             // 参数初始值
    return { ... };
  }
  static buildBody(container, state, onChange) {
    // 在 container 里建任意 DOM。改 state.params.X 后调 onChange() 触发预览
    // 插件可放 slider / 色环 / canvas / color ramp / ...
  }
  static bake(srcData, dstData, params, mask, w, h) {
    // 纯函数 src → dst（同尺寸）。mask=null 全图，mask 是 Uint8ClampedArray
    // mask[i*4+3] < 128 时该像素 passthrough
  }
}

registerFilter(MyFilter);
```

## Helper

`filters.js` 导出常用 DOM 工具，插件复用即可：

- `clamp8(v)` → 0..255 整数
- `makeSliderRow(label, key, min, max, step, init, onChange, {fmt, gradient})` → 一行滑块 row（含 color ramp 渐变背景）
- `makeSectionTitle(text)` → 小节标题
- `makeSelectRow(label, key, options, init, onChange)` → 下拉

## 注册时机

`registerFilter(FilterClass)` 调用时：
1. 加入 `_filters` Map
2. 触发 `onFilterRegistered` 监听器（app.js 的菜单重渲）
3. 菜单立刻出现入口

所以**插件加载完调一行 registerFilter 就完事**，不需要碰菜单 / app.js。

## App 端集成

`app.js` 只需 3 步：

```js
import { listFilters, onFilterRegistered } from "./filters.js";
import "./plugins/index.js";       // 触发第一方自注册

function _renderFilterMenu() {
  // 按 listFilters() 渲染调色菜单按钮
}
_renderFilterMenu();
onFilterRegistered(_renderFilterMenu);
```

菜单按钮 click → `_openFilterPanel(F.id)` 走 adjust 面板（preview surrogate + mask + apply / cancel）。

## 预留给 brush 模式（Phase B）

`Filter.modes` 含 `"brush"` 的 filter，runtime 走 `FilterBrushEngine`：
- 每个 stamp 提供 `brushAlpha` map
- `Filter.bakeBrush(srcData, dstData, params, brushAlpha, bbox, w, h)`
- bbox 由 brush size + pressure 决定，外扩 `bleedRadius(params)` 让 non-local kernel 不漏
- 每 stroke = 1 个 undo entry
- 适用：液化 / Sharpen-Blur brush / 未来 mosaic / 涂抹 ……

调色（HSB / Color Balance / Curves）仅 `modes=["region"]`，走选区不走 brush。

## 插件加载（未来 / backlog）

参 [docs/20260528-backlog.md] artist filter 段：

- Plugin manifest format（id / name / downloadUrl / version / size）
- 下载流程：fetch → SRI / hash 校验 → IDB Cache Storage 缓存
- 执行：`const blob = ...; const url = URL.createObjectURL(blob); await import(url)`
  （插件内部最后调 `window.WebPaint.registerFilter(...)`）
- 「插件管理」UI：可见 / 已下载 / 占用空间 / 卸载

跟 AI 本地 WASM 按需下载 是同一框架，可共用 loader。

## 调试 tip

console 里：
```js
WebPaint.listFilters().map(f => `${f.id} (${f.title})`)
```

加一个临时 filter：
```js
class TestFilter {
  static id = "test"; static title = "测试"; static category = "adjustment";
  static modes = ["region"]; static bleedRadius() { return 0; }
  static defaults() { return { strength: 50 }; }
  static buildBody(c, s, onChange) {
    const i = document.createElement("input");
    i.type = "range"; i.value = 50;
    i.addEventListener("input", () => { s.params.strength = +i.value; onChange(); });
    c.appendChild(i);
  }
  static bake(src, dst, p, mask) {
    const k = p.strength / 50;
    for (let i = 0; i < src.length; i += 4) {
      dst[i] = src[i] * k; dst[i+1] = src[i+1] * k; dst[i+2] = src[i+2] * k; dst[i+3] = src[i+3];
    }
  }
}
WebPaint.registerFilter(TestFilter);
```

菜单立刻出现「测试」入口。
