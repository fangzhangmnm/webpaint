# C0 · 全文件改名对照表（前后端分域搬家地图）

> as-of v0.8.24 / 2026-08-09。**timestamp 快照，可过期，不承诺维护**（handoff C0 条款）。
> 判据 = `20260808-c-headless-proposal.md` §1 五目录格律：
> `common/`（纯类型+纯几何数学）· `backend/`（算法/合成/codec/workpiece，子目录 `algorithms/`）·
> `frontend/`（UX 资产，子目录 `toolkit/` = DOM-free UX 数学）· `shell/`（platform 胶水）·
> `gallery/`（检疫堆场）。`src/store/**` = 家族库红线区，**不在格律内、不改名不搬家**。
> 「提案去处」是 C1–C3 搬家的地图，不是 pin 住的承诺——施工中形状变了回写提案即可。
> 普查方法：读头注释 + 核实主体（四个并行普查，2026-08-09）；「实际做什么」以代码现状为准，头注释与之矛盾处已按代码写。

## 0. C0 本片已执行的改名（涉及持久化 key / 算法 id 的符号一律未动）

| 旧名 | 新名 | 说明 |
|---|---|---|
| `src/lineart/`（4 文件） | `src/flat-coloring/` | Fourey–Tschumperlé–Revoy 2018 flat coloring 论文实现，非「勾线」；目录归宿 = `backend/algorithms/flat-coloring/`（C2/C3 落） |
| `src/lineart-oracle.ts` | `src/flat-coloring-oracle.ts` | app 侧缓存+参数接缝（内部类名 `LineartOracle`、算法 id `"lineart"`、`desk.magicWand.lineart*` 持久化 key 均未动——符号改名排 C3 algorithms 立户时） |
| `src/plugins/stylize_filters.ts` | `src/plugins/stylize-filters.ts` | 全仓唯一 snake_case，纯正名 |
| `test/lineart-*.test.mjs`（2 文件） | `test/flat-coloring-*.test.mjs` | 随源改名，run.mjs 注册已同步 |

## 1. 重点错位样本（最误导的文件名/头注释，普查核实）

- **`lasso.ts`（826 行三合一）**：套索手势状态机（191–345）+ 自由变换纯转发门面（512–562）+ **与套索无关的算法内核 262 行**（564–687 泛洪、688–760 容隙 EDT 形态学闭、761–826 全图同色）。→ C3 拆：内核 → `backend/algorithms/magic-wand.ts`。
- **`board.ts`「显示层」藏写路径**：commitBrushStroke/commitFill/glWarpBakeFn（766–796）是真正把像素写进文档的提交路径。→ 拆：present 归 frontend 壳、commit 面随 C4/C5 归 backend。
- **`session.ts` 名不副实最严重**：12 个导出里只有 2 个管 session 名，主体是导出/分享/剪贴板/打印工具箱；与 `session-state.ts`（真正的活文档编排器）一词之差职责完全不同。
- **`doc.ts`**：最大的类 PaintDoc（405–1152）生产零引用（测试基座/死代码）；文件名 "doc" 已不指活文档（SSoT=PaintingWorkpiece）。
- **`background-sync-jobs.ts`**：与云 sync 无关、非 Background Sync API、也不后台运行——实为 idle-scheduler（空闲时间片调度器）。
- **`engine-registry.ts`**：无 register 期的编译期硬编码常量表，不是 registry；与真 `registry.ts`（泛型注册表工厂）撞名。
- **`rotsprite.ts`**：只做 EPX/Scale2x 放大，不做旋转（旋转在 GPU nearest 采样侧；RotSprite 是管线名，文件只是其放大半边）。
- **`render-tree.ts`**：不是数据结构，是帧调度器/缓存执行器（树在 render-plan.ts）。
- **`enc-thumbs.ts`**：前 24 行是缩略图，主体是密码策略循环（ensureUnlocked / ensureNewPassword）。
- **`brush.ts` vs `brushes.ts`**：一个复数 s 之差 = 笔刷引擎 vs 笔架数据仓+schema 迁移；`brush-io.ts` 只有 O 没有 I。
- **`stroke-smoother.ts` vs `stroke-input-smooth.ts`**：名字近义、实为互斥两管线（缓冲笔中心线 vs 即时笔 per-event EMA）。
- **`checkpoint-policy.ts`**：此 checkpoint = revert 快照，与 workpiece undo checkpoint 同词两义。

## 2. 对照表

格式：`现名 | 行 | 实际做什么 | 提案去处 | 备注`。「拆」= 一文件多归宿（随对应切片做）。

### 2.1 根目录 · 引擎/算法/字节侧

| 现名 | 行 | 实际做什么 | 提案去处 | 备注 |
|---|---|---|---|---|
| bitmap.ts | 10 | makeBitmap：OffscreenCanvas 优先的 canvas 构造 SSoT | shell/ | canvas 只活在壳（§4 名单） |
| bspline.ts | 131 | 预滤波三次 B 样条（Thévenaz/Unser）系数+采样，与 GPU 逐位同步 | backend/algorithms/ | 纯计算 |
| brush.ts | 500 | BrushEngine：笔画生命周期→stamp 参数流（GPU 栅格）；另含 pixelMode CPU 直写支路 | backend/（C5 StrokeSession 片） | 两种引擎同文件，C5 拆 |
| brushes.ts | 369 | 笔架数据模型+builtin json 加载+RackMeta+schema 迁移 | frontend/（fetch 经 shell 注入） | backend 只认 ResolvedBrush 快照 |
| brush-io.ts | 80 | 导出/分享 JSON（share API/`<a download>`） | shell/ | 只有 O 没有 I |
| brush-types.ts | 45 | 笔刷纯类型 | common/ | 头注释「brushes.js」陈旧 |
| checkpoint-policy.ts | 53 | revert 快照的触发策略纯表 | shell/ | 与 undo checkpoint 同词两义 |
| color-cluster.ts | 154 | 确定性 k-means+硬分配拆分 | backend/algorithms/ | 纯计算 |
| color-dist.ts | 52 | sRGB→OKLab+种子色距闭包 | common/ | 提案 §1 点名 |
| color-name.ts | 337 | 色名词库加载+OKLab 最近邻命名+色温黑体+搜索 | 拆：命名/色温数学→backend/algorithms/；fetch 加载→shell 注入 | |
| crop-geometry.ts | 89 | 裁剪框 8-handle 拖拽 resize 纯数学 | frontend/toolkit/ | 手势→终值数学 |
| current-brush-config.ts | 105 | DEFAULT_CONFIG 默认值表+BrushDraft 类型 | frontend/ | 「当前笔」实在 resolved-brush |
| doc.ts | 1223 | ①生产在用的 Layer/Group 节点类+树工具 ②PaintDoc 死类（405–1152）③freezeDocForEncode | 拆：①→backend/ ③→backend/codec；**②删除候选（C3）** | canvas 物化=债 b |
| doc-ops.ts | 559 | runDocTransform 整点脊柱 + 裁剪/重采样/偏移全套对话框 UI | 拆：脊柱→backend/；对话框→frontend/ | 头注释漏 rot90/offsetWrap |
| doc-render.ts | 26 | renderNodesTo* 的 late-binding 注入插座 | backend/（C7 装配收编） | 零渲染代码 |
| engine-registry.ts | 50 | PIXEL_STROKE_SPECS 硬编码常量表 | backend/（C5；提案名 pixel-stroke-specs.ts） | 不是 registry |
| enc-thumbs.ts | 106 | peek 缩略图 24 行 + 密码策略循环主体 | 拆：缩略图→gallery/；密码策略→shell/ | 名字只提 thumbs |
| explode-layers.ts | 157 | 「按颜色拆分」sheet 编排（算法在 color-cluster） | frontend/ | 弹窗控制器 |
| exporters.ts | 82 | 导出格式注册表+四内建 | backend/codec/ | |
| filter-brush.ts | 73 | FilterBrushEngine 薄委派（stroke 生命周期） | backend/ | |
| flat-coloring/（4 文件） | 727 | 论文管线：edt(Meijster)/border(端点检测)/closing(样条闭合)/partition(分区总管线) | backend/algorithms/flat-coloring/ | C0 已从 lineart/ 改名；border.ts 实为端点检测 |
| flat-coloring-oracle.ts | 131 | (layerId,contentRev) 缓存 + UI 参数旋钮持有者，tap→Selection | 拆：缓存接缝→backend/；参数状态→frontend/ | C0 已改名；符号 Lineart* 待 C3 |
| import-image.ts | 311 | 图片/.ora 导入编排（选择器/拖拽/大图询问/解密转接） | shell/ | decoder 注入槽=债 a |
| marching-ants.ts | 95 | Selection→轮廓 polyline（像素边界阶梯追踪+缓存） | frontend/toolkit/ | 提案点名 toolkit；算法已非 marching squares |
| ora.ts | 331 | .ora 编解码+缩略图降档+sidecar 读写 | backend/codec/ | mergedimage canvas=债 d |
| ora-stack-xml.ts | 214 | 图层树↔stack.xml 纯字符串 | backend/codec/ | |
| pixel-conic.ts | 183 | Zingl 有理二次 Bézier 像素透视圆 | backend/algorithms/ | |
| png-codec.ts | 124 | PNG 编解码接缝（UPNG+pHYs；iCCP 回退 canvas） | backend/codec/ | 回退路=壳注入 |
| psd.ts | 399 | PSD 导出（PackBits/扁平层/merged 经 GL） | backend/codec/ | writeMergedImage 死变量 c+死类型 Ctx 待清 |
| registry.ts | 63 | makeRegistry 泛型工厂 | common/ | 名过泛，可并注释澄清 |
| resample.ts | 115 | canvas drawImage 缩放+解码工具+一个 `<select>` 填充器 | **C3 债 a：物理消灭**（消费者迁 resample-bytes；decode 抽 shell；UI 归 frontend） | |
| resample-bytes.ts | 173 | 全 typed-array 重采样核（area/nearest/bilinear/bicubic） | backend/algorithms/（提案名 resample.ts 接位） | |
| resolved-brush.ts | 161 | resolveBrush 纯函数 + makeCurrentBrush（Vue computed） | 拆：类型→common/；resolveBrush+computed→frontend/ | 头注释「纯模块」只对一半 |
| rotsprite.ts | 59 | EPX/Scale2x 2^n 放大（不旋转） | backend/algorithms/ | 名保留可（管线名），注释澄清 |
| sel-pen.ts | 51 | 选区笔两纯函数（settings 覆写+stamps 二值化） | backend/ | |
| selection.ts | 631 | 不可变 Selection 值对象（稀疏 gray8 tile mask）+派生+rasterizePolygonGray8 | common/（提案 §1 点名）；toCanvas 三方法=债 c | 搭车的 polygon 光栅器→backend/algorithms |
| selection-ops.ts | 151 | 选区像素搬运命令+剪贴板事件接线 | 拆：搬运→backend/；剪贴板→shell/ | |
| shape-geometry.ts | 385 | 形状笔拟合数学 + Bresenham 光栅原语混装 | 拆：拟合→frontend/toolkit/；光栅原语→backend/algorithms/ | |
| shape-brush.ts | 483 | 形状笔引擎（几何→polyline→私有 BrushEngine；pixelMode 逐像素路径） | C4 普查对象；主体→backend | 违规户之一（C6 跟进） |
| sevenzip.ts | 127 | 7z-wasm 惰性加载+AES 打包 | shell/（加载器）；调用面=store crypt seam | |
| stroke-smoother.ts | 134 | 二阶临界阻尼中心线+动量弧 tail | backend/（C5 随迁，手感数学） | |
| stroke-input-smooth.ts | 48 | 即时笔 per-event 死区+EMA | backend/（C5 随迁） | 与上互斥两管线，注释写明 |
| smooth-config.ts | 42 | SMOOTH 手感参数表+持久化钩子 | 拆：参数表→backend/；持久化→shell 接缝 | |
| tile-jobs.ts | 47 | 组合根接线（codec 装配+compact 任务注册） | shell/ | 不是 jobs 定义 |
| zip.ts | 84 | vendored zip.js 薄包装（明文 zip） | shell/（window.zip 全局依赖） | 与 sevenzip 分工名字看不出 |

### 2.2 gl/ · tiles/ · render/

| 现名 | 行 | 实际做什么 | 提案去处 | 备注 |
|---|---|---|---|---|
| gl/gl-context.ts | 245 | 唯一 WebGL2 上下文封装：能力/program 缓存/FBO 池/loss 生命周期 | **shell/browser-gl2-port.ts**（C1：改造为 BrowserGl2Port 实现体） | getContext 唯一创建点 :68 |
| gl/blend-glsl.ts | 156 | 12 blend 函数 + **整个 composite pass shader 工厂** | backend/gl/ | 名只说 blend，主体是 shader 工厂；C8 注册表挂点 |
| gl/gl-board.ts | 106 | GL 门面转发层（render/commit/吸管/导出→RenderTree/RasterService） | backend/gl/ | 唯一 GLContext 调用点 :35 |
| gl/gl-compositor.ts | 522 | pass 原语库（ping-pong 累积器）+GPU warp+present | backend/gl/ | 头注释提及已死的 composite() |
| gl/gl-doc-bridge.ts | 29 | DocNode 类型+safeMode | backend/gl/（类型可上提 common） | "bridge" 不桥接 |
| gl/gl-room.ts | 418 | GL 机房单例包+驻留台账+plan 翻译+合成机 | backend/gl/ | 自称零策略实含策略 |
| gl/gl-stamp.ts | 208 | GPU 笔迹光栅器（instanced stamps→FBO） | backend/gl/ | 唯一 drawArraysInstanced |
| gl/gpu-tile-pool.ts | 313 | GPU tile 池记账+GL backend+IndexTexture 三合一 | backend/gl/（GPU arena 归 Port 所有——C1/C7 再裁） | |
| gl/raster-service.ts | 173 | 一次性 GL 合成/烤定/readback facade | backend/gl/ | |
| gl/render-tree.ts | 240 | 帧调度器/缓存执行器（快路径/段缓存/present） | backend/gl/ | 名像数据结构，实为调度器 |
| gl/tile-bridge.ts | 96 | cpuId→gpuId 映射+身份跳传+区域切 tile | backend/gl/cpu-gpu-tile-bridge.ts | 头注释已用此名 |
| tiles/tile-geometry.ts | 76 | doc↔tile 网格纯换算 | common/ | 提案 §1 点名 |
| tiles/cpu-tile-pool.ts | 353 | 不可变引用计数 CPU tile 池+压缩驻留 | backend/tiles/ | CPU 池恒 SSoT |
| tiles/cpu-tile-compression.ts | 25 | fflate deflate codec 适配 | backend/tiles/ | |
| tiles/tile-layer.ts | 386 | LayerPixels 像素门面（CoW 写/派生/观察者）+尾部 canvas facade | backend/tiles/ | canvas facade=债 b；类名与文件名不合 |
| tiles/app-tile-pool.ts | 38 | 池单例装配+配额常量+注入口 | shell/ | |
| render/render-plan.ts | 212 | 图层树→pass 步骤表纯规划器 | backend/ | |

### 2.3 workpiece/

全目录 → `backend/workpiece/`（workpiece v2 = backend 核心；令牌墙一字不动）。

| 现名 | 行 | 实际做什么 | 备注 |
|---|---|---|---|
| workpiece.ts | 258 | v2 基类：令牌工厂/写门/组件注册/双计数 | — |
| undo-stack.ts | 165 | undo 栈本体+WorkpieceComponent 接口定义处 | multiplayer op 标记位挂点（C7） |
| history.ts | 119 | withPoint 令牌编排+不可恢复协议 | — |
| layer-tree.ts | 458 | 层树组件（不可变 TreeJson）+doc 尺寸持有者 | 名未透露兼管 doc 元数据 |
| layer-tiles.ts | 413 | 全文档 tileset 注册表+像素写面+collector 三合一 | 名像单层 tile 集合 |
| painting-view.ts | 337 | app 读写端口（ViewLeaf/ViewGroup+canvas 物化缓存） | canvas=债 b；引擎直写违规户容身处（C6） |
| painting-workpiece.ts | 204 | 六组件装配+load/exportData | host/树两形态并存 |
| selection-component.ts | 141 | 选区组件+SelectionPreviewTx 搭车 | — |
| float-component.ts | 158 | 浮层状态组件+float 类型族定义处 | 与 floating-transform 分持同态两半 |
| float-ops.ts | 161 | 浮层像素纯函数 ×6 | "ops"≠operator，纯函数 |
| pending-fill.ts | 65 | 「将要填的颜色」组件 | v0.8.24 色板 target 扩 fill 全程 |
| persp-component.ts | 79 | 透视配置记账代理（substrate 住 desk） | 只有 remap 走令牌 |

### 2.4 UI/交互（frontend 侧）

| 现名 | 行 | 实际做什么 | 提案去处 | 备注 |
|---|---|---|---|---|
| input.ts | 1567 | 指针/触摸状态机+笔画编排+快捷键+undo 门面+吸色+双指手势 | frontend/（C5 抽走 stroke 事务 input.ts:918-940 一带后瘦身） | 头注释 undo=ImageData 快照是化石 |
| lasso.ts | 826 | 三合一（见 §1） | 拆：手势→frontend/；算法内核→backend/algorithms/magic-wand.ts；变换转发→frontend/ | C3 点名 |
| toolbar.ts | 1241 | 工具选择+三条工具栏+扩张收缩 modal | frontend/ | 头注释「单一职责」不实 |
| board.ts | 1165 | 视口+合成显示+**像素提交出口**+套索 overlay | 拆：present/视口→frontend/；commit 面→backend（C4/C5） | 见 §1 |
| layers-panel.ts | 911 | 图层面板 Vue+全部图层 op 调用点 | frontend/ | |
| color-panel.ts | 157 | 主色 SSoT 写入+面板 chrome+ColorTarget 注册制 | frontend/ | |
| palette.ts | 223 | 256² 混色小窗（自持 canvas+三迷你工具） | frontend/（提案名 mixer-window.ts） | 非「调色板」 |
| fill-mode.ts | 187 | 油漆桶模式编排（零 flood 知识） | frontend/ | fill 已是第一类工具，"mode" 名旧 |
| persp-edit.ts | 433 | 消失点编辑 transient UI（手柄拖拽/box 求解调用） | frontend/ | |
| perspective-frame.ts | 725 | 透视/等距几何纯函数库（homography/GN 求解/planeMetric） | frontend/toolkit/ | DOM-free 可移植器官 |
| pointer-gesture.ts | 104 | 双指手势纯数学 | frontend/toolkit/ | 头注释 input.js 化石 |
| pointer-route.ts | 51 | 指针角色路由纯决策 | frontend/toolkit/ | 同上 |
| floating-transform.ts | 1055 | 浮层生命周期总编排+gizmo 数学+6 几何纯函数 | 拆：几何→toolkit/；生命周期→C4 transaction 定形 | 见 float-component 备注 |
| ui/color-wheel.ts | 215 | 色轮 Vue 组件 | frontend/ui/ | |
| ui/color-model.ts | 66 | HSV⇄hex 纯模型 | frontend/toolkit/ | |
| ui/brush-config-view.ts | 178 | 笔刷编辑器 Vue | frontend/ui/ | |
| ui/brush-size.ts | 64 | 笔粗分段量化纯函数 | frontend/toolkit/ | |
| ui/drag-value.ts | 117 | 拖动取值核（pointer capture） | frontend/ui/ | 深模块 |
| ui/ramp-slider.ts | 144 | 自绘滑块工厂 | frontend/ui/ | 深模块 |
| ui/input-sense.ts | 109 | 文本框 IntelliSense | frontend/ui/ | |
| ui/left-dial.ts | 141 | 左栏 dial Vue | frontend/ui/ | |
| ui/rack-sheet.ts | 91 | 笔架 sheet Vue | frontend/ui/ | |
| ui/icon.ts | 26 | sprite `<use>` 包装 | frontend/ui/ | |
| i18n/index.ts | 159 | t()/setLang/localizeDom 运行时 | frontend/i18n/ | |
| i18n/strings.ts | 954 | 四语文案 SSoT | frontend/i18n/ | |
| i18n/ucsur.ts | 92 | sitelen pona 转写+字体探测门 | frontend/i18n/ | |
| topbar-menu.ts | 301 | 顶栏+汉堡菜单接线 | frontend/ | |
| settings-menu.ts | 299 | ⋯ 菜单面板+快捷键 sheet | frontend/ | 头注释漏语言/云登录 |
| export-import-menu.ts | 207 | 导入导出菜单项+格式偏好 | frontend/ | |
| side-windows.ts | 127 | 参考窗+混色窗构造接线 | frontend/ | 是浮窗不是侧栏 |
| sheets.ts | 190 | 应用内模态原语（input/confirm/多选/锁屏 gate） | frontend/ | 与 rack-sheet 的 sheet 异义 |
| transient-panels.ts | 111 | transient 面板抑制复原 + 变换 commit/cancel 护栏 | frontend/ | 后者与面板无关，可随 C4 挪 |
| anchored-popup.ts | 95 | popup 定位唯一入口 | frontend/ui/ | |
| inline-select.ts | 38 | 应用内下拉 | frontend/ui/ | |
| dial-controls.ts | 57 | dial 程序化写入 API（零渲染） | frontend/ | UI 在 left-dial |
| smooth-dev-panel.ts | 95 | 手感 dev 调参浮层 | frontend/ | |
| brush-rack-controller.ts | 477 | 笔架编排（collection 订阅/命令/自愈） | frontend/ | |
| brush-rack-view.ts | 44 | 笔架纯 view-model 三函数 | frontend/ | |
| theme.ts | 75 | 主题切换+持久化 | frontend/ | |
| canvas-templates.ts | 122 | 模板 json 加载器+`<select>` 投影 | frontend/（fetch 经 shell） | 数据已外置 |
| panel-state.ts | 64 | 互斥面板注册表 | frontend/ | |
| workbench-state.ts | 419 | ①dial 反应式 RAM SSoT ②desk per-doc 序列化门面 | frontend/（desk 序列化=editorState，C7 sidecar 相关） | 两层刻意同居 |
| save-status.ts | 78 | save 按钮三态+newer banner | frontend/ | |
| fullscreen-busy.ts | 41 | busy 遮罩+withBusy | frontend/ | |
| error-badge.ts | 72 | 全 app 错误汇拢 banner/状态栏/console 分级 | shell/（store 也经它；capability 契约挂点） | 非「徽章」 |
| dev-console.ts | 82 | window.WebPaint 调试接口 | shell/ | |
| els.ts | 144 | DOM 元素注册表 | frontend/ | |
| surfaces.ts | 41 | 浮窗 z-order 栈 | frontend/ | z band SSoT 在 styles.css |
| edit-mode.ts | 157 | 编辑模式状态机+能力表 | frontend/（EditMode 归属=C4 裁定，提案 §6 留白） | |
| editable-leaf.ts | 26 | requireEditableLeaf UI 守卫 | frontend/ | 三条提示语未走 i18n |
| filters.ts | 318 | Filter 契约+registry 封装+DOM 控件工厂+brush 行为引擎四合一 | 拆：契约/registry/brush 引擎→backend/；控件工厂→frontend/ | |
| filters-adjust.ts | 411 | 全体 filter 的面板控制器 | frontend/ | "adjust" 只是其一 |
| plugins/index.ts | 17 | 自注册 barrel | backend/filters/ | |
| plugins/color-balance.ts | 106 | 色彩平衡 filter（UI+bake） | 拆：bake→backend/filters/；UI 行→frontend | 各 filter 同此模式 |
| plugins/curves.ts | 252 | 曲线 filter（自绘 canvas 编辑器+Hermite LUT） | 同上 | 唯一自绘交互 canvas 插件 |
| plugins/hsb.ts | 122 | 亮度/对比/饱和/色相 filter | 同上 | 含对比度非纯 HSB |
| plugins/sharpen-blur.ts | 143 | 模糊/锐化 brush filter | 同上 | 头注释 modes 陈旧（region 已删） |
| plugins/stylize-filters.ts | 277 | 马赛克/网点/彩窗三 filter | 同上 | C0 已正名 |
| plugins/liquify.ts | 95 | LiquifyEngine 的 Filter 包装 | backend/filters/ | |
| plugins/liquify-engine.ts | 403 | 液化引擎（位移场+反向采样重建） | backend/algorithms/ | **C6 第一户**（putImageData 就地写→surrogate 化） |

### 2.5 shell/session/gallery 侧

| 现名 | 行 | 实际做什么 | 提案去处 | 备注 |
|---|---|---|---|---|
| app.ts | 575 | 组合根：单例构造+39 键 ctx+~20 initX+业务编排内联 | shell/（C7 裁 backend 装配） | 「只装配」不实：fixup/回线/gallery host 都是业务 |
| app-context.ts | 158 | AppContext 39 键纯类型 | shell/（C7 backend 瘦版） | |
| app-state.ts | 94 | 4 个跨文件持久键门面（collection） | shell/ | RAM 态在 workbench-state |
| app-prefs.ts | 72 | user-preference collection 门面 | shell/ | |
| app-store.ts | 145 | sync-store 装配唯一点+auth 转发+gallery 列举适配 | 拆：装配/auth→shell/；GItem 适配→gallery/ | **B2 store 窄接口 C7 一并裁** |
| boot.ts | 52 | rack boot+restore 接线两片段 | shell/ | 真 boot 序在 app.ts |
| boot-restore.ts | 46 | 上次文件恢复编排（幽灵路径纪律） | shell/ | |
| boot-snapshot.ts | 36 | theme/lang 两个 LS 键首帧快照 | shell/ | 名过泛 |
| pwa-shell.ts | 85 | SW 注册+更新检测+onForeground 业务钩子 | shell/ | |
| platform-guards.ts | 66 | 全局手势拦截+指针自愈 | shell/ | |
| storage.ts | 127 | app 私有 IDB（缩略图缓存+revert 快照两 store） | shell/ | 名极泛 |
| store-absent.ts | 152 | store 缺席模式（内存 collection+null store） | shell/ | |
| store-ui.ts | 47 | createStore 的 StoreUI 回调适配 | shell/ | |
| crypto-state.ts | 48 | 密码内存持有+记忆政策（零密码学） | shell/ | |
| password-verifier.ts | 73 | PBKDF2+AES-GCM sentinel 验证 | shell/ | |
| cloud-auth-ui.ts | 86 | 图库云图标状态+登录按钮接线 | gallery/ | |
| cloud-thumbs.ts | 25 | ora 缩略图 peek 取字节 | gallery/ | "cloud" 名不准（本地同路） |
| cloud-thumb-cache.ts | 100 | 缩略图 IDB 缓存层（token 失效） | gallery/ | fileSize 死参待清 |
| background-sync-jobs.ts | 92 | 空闲时间片调度器（纯逻辑） | shell/（提案名 idle-scheduler.ts） | 见 §1 |
| session.ts | 330 | session 名 2 函数 + 导出/分享/剪贴板/打印工具箱 | 拆：名→shell/；工具箱→shell/（提案名 export-tools.ts）；renderDocToImageBlob=债 d | 见 §1 |
| session-state.ts | 663 | 活文档生命周期编排（ora 适配器/加密切换/checkpoint/rename/门面） | shell/（≥5 关注点可再拆，随 C7） | 非 "state" |
| session-name.ts | 14 | 占用检查一函数 | shell/ | _opts 死参 |
| editor-session/editor-session.ts | 236 | 家族共享 doc 生命周期编排器 | shell/ | C7 sidecar 槽雏形（peek） |
| editor-session/index.ts | 6 | 出口 barrel | shell/ | |
| gallery-model.ts | 127 | 图库纯数据函数 | gallery/；**大半死代码候选**（merge 系列已收进 store，仅测试引用；活的只剩 itemTime/copyTargetName） | |
| gallery-path.ts | 16 | 路径纯字符串三函数 | gallery/ | |
| gallery-shell.ts | 424 | 图库外壳+新建 sheet+配额告警+密码锁 | gallery/ | 三条不相干轴 |
| ui/gallery.ts | 682 | 图库 Vue 深模块（watchFolder 订阅/tile/intent） | gallery/ | 双向依赖：直调 session.* 7 处（E 骑士清单，C2 文件头记账） |
| ui/gallery-view-model.ts | 168 | 纯展示派生（6 态徽章等） | gallery/ | 头注释 .js 后缀过期 |
| blender-sync.ts | 580 | BTP 双向同步+整套浮动面板 DOM | 拆：sync→shell/；面板→frontend/ | 两条持久化轴混装 |
| reference.ts | 578 | ReferenceWindow 参考图浮窗类 | **C9 web component 试点对象** | 名极泛 |
| config.ts | 57 | Azure AD 常量 + session 文件名代数 | 拆：AD→shell/；文件名代数→common/（提案名 session-name-algebra） | 两域混装 |
| version.ts | 8 | 版本常量 | **不动**（bump.sh/build.sh sed 锚定此路径） | |
| signals.ts | 7 | docVersion 一个 Vue ref | frontend/ | 复数名单信号 |

### 2.6 src/store/**（39 文件，红线区）

**全部不改名、不搬家**——家族 sync-store 库开发面，接缝 = `app-store.ts` + `store/local-adapter`（现 `providers/`）。一句话职责普查已核实与头注释相符（详见普查记录），仅一处跨兄弟拷贝残留：`store/providers/graph.ts` 头注释的沙盒说明写的是 "AtlasMaker"（改注释也属红线区，留给下次 store 批）。

## 3. 死代码/陈旧注释清理候选（C3 收账素材，本片未动）

- `doc.ts` PaintDoc 类（405–1152，生产零引用）；`gallery-model.ts` merge 系列（仅测试引用）。
- `psd.ts` writeMergedImage 死变量 c + 死类型 Ctx；`cloud-thumb-cache.ts` fileSize 死参；`session-name.ts` _opts 死参。
- 化石注释：`input.ts` 头（undo=ImageData 快照）、`pointer-gesture/route`（input.js）、`gl-compositor.ts` 头（composite() 已死）、`sharpen-blur.ts` 头（region 模式已删）、`brush-types.ts` 头（brushes.js）、`ui/gallery.ts` 头（listGallery 已删）。
