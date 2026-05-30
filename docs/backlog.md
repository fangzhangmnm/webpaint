# 小本本 —— TODO 池 + 好点子

> 不是 MVP，但有趣 / 等以后做。新点子先丢这里冷藏，时机到再拎出来论证。

> 就是一个TODO list，写暂时不修的bug，好点子，需要的功能。放的是怕忘，但是一下事太多只能放一边的东西

## 状态约定

- **P0 必做**：已规划进 v89-v95 路线
- **P1 想做**：方向认可，时机未到
- **P2 备选**：有趣但远未刚需,post alpha 再做，低优先级

---

## P0（v89+ 路线明确的）

<!-- v124 第一招（partial render clip 取整 + 1px 外扩）失败；
     v124 兜底：stroke 进行中（有 live overlay）强走 _renderFull，规避 partial sliver bug。
     等 user 在 Windows 验证。 -->

### 图库文件夹管理（v124 记，user：「图库最好支持文件夹管理；文件夹删除只能空文件夹」）
- 现状：图库是 flat list 所有 doc，按名 sort
- 加 folder 概念：
  - doc 有 `folder` 字段（string），默认 ""（根）
  - 图库左边或顶部加 folder breadcrumb / 列表
  - 移动 doc 到 folder：右键 / "..." menu
  - 新建文件夹：图库 + 按钮 旁边一个"新文件夹"入口
  - **删除文件夹只允许 empty**（安全约束，防误删一堆画）
- 持久化：doc 已有元数据（IDB），新增字段 + migration
- 关联 cloud sync：folder 也要同步到 OneDrive 子目录映射

### 新画布常见模板（v124 记，user：「正方形不太常见，加几个 pixel art 等」）
- 现状：新建只让 user 填 W×H，默认 2048×2048 正方
- 候选模板：
  - **iPad 横屏** 2732×2048 (Procreate 默认 4K)
  - **手机竖屏** 1080×1920
  - **A4 300dpi** 2480×3508
  - **方形小图** 1024×1024
  - **Pixel art 像素图**：32×32 / 64×64 / 128×128（自动 set 笔刷 pixel mode）
  - **Web banner** 1200×630（社交分享卡）
  - **Twitter 头图** 1500×500
- UI：新建画作 sheet 顶部加 chip 列表，点击 → 填 W/H + 设笔刷 preset



### smudge icon 再改：单手指 45° 向下按压 (v120 记，user：「smudge 错啦，是一根手指 45° 向下伸出来按住涂抹」)
- v120 我选了 Lucide 张开手掌（4 指立 + 拇指），错了；user 要的是**单根手指**
- 设计意图：一根食指从右上 45° 角斜下来，指尖触屏，下方有涂抹/压感弧痕
  - 类似 https://lucide.dev "pointer" 但角度斜的、指尖按压有压感拖痕
  - 或参考 procreate 涂抹工具的「拇指 + 涂抹弧线」
- 关联 [feedback:artist-intuition]：图标设计也是 artist 直觉，问 user 别凭 engineer 想象
- 工作量：5 行 SVG，下次顺手做



### crop / 画布裁切
- 裁画布到选区 / 自定义矩形
- 画布尺寸缩水（layers 同步裁）
- history 一步可 undo

### resample / 画布重采样
- 整画放大 / 缩小，含 layers 同步
- 选 nearest / bilinear / bicubic 重采样
- doc.width/height + layer.canvas 全部重做
- 跟 v83 的 transform 插值模式可共享 helper

---

## P1（想做，等时机）

### adjust suite（v89 计划）
- Brightness / Contrast / Saturation / Hue（CSS filter live preview, bake on apply）
- Levels / Curves / Color Balance（pixel op，参 AtlasMaker src/canvas-filters.js）
- 应用到 active layer，受 selection mask 限制（hook）

### 多选 layer + 折叠 / 文件夹
- 见下面「多选 layer 设计」section
- Collapse all / Collapse to below / Group selected → folder
- ora模式支持图层组吗？

### 图库里支持重命名
- user：「图库 ui 可以重命名」
- 当前 menuRename 只能改当前打开的画
- 图库 tile 长按 / ⋯ 菜单 → 重命名 + 删除 + 卸载本地
- 重命名要处理 IDB key + cloud rename + UI 更新

### Texture brush 真导入
- brush settings 全屏 view 已有 shape.kind = "texture" 占位
- 缺 PNG 文件选择 + b64 嵌入 brush JSON 的 UI
- engine `_getStamp` 已可吃 textureB64（待 brush.shape.textureB64 通路打通）

### 笔画稳定化全 stack
- BrushSettings 已经有 streamline / stabilization / pullStabilizer / motionFilter
- UI 还散在 menu「笔刷平滑设置」里，应该入 brush settings full view
- 顺便加每条曲线的 live preview

### 颜色 + 色板合并窗
- v77 论证的"折叠面板"：HSV / 调色板 256 mixer / 最近色 在一个常驻窗里
- 当前 color panel 还独立，palette window 是另一个 widget
- 整合：单一面板 + 3 个折叠 section

### Procreate 笔画扭动稳定化
- 高强度 stabilization 时 Procreate 会让 stroke 路径**回头扭动**找最佳曲线
- 每帧重画整笔（性能压力大）
- 暂不做，先看 user 是否需要

### 大笔刷性能优化
走per pixel js解决没有lighten的问题，是否可以用其他聪明的数学绕开？

---

## P2（备选 / 有趣）

### 导入图片 → auto transform → Ctrl+Z 行为很差
v126 / v127 导入照片后自动 lift 进 transform。这时候按 Ctrl+Z：
- 各种没有复位（transform float / selection / 新建的 layer / 入口的 setTool / 各种 panel suppress 状态）
- 涉及好几个系统：lasso transform state、selection、history（addLayer 没 push 进 history）、ui state（_suppressTransientPanels）
- 期望：一键回到导入之前的样子

设计要点：
- 导入流程要 push 一个 composite history entry（addLayer + setSelection + lift + setTool 一起）
- 或者：transform 期间 Ctrl+Z 先 abort transform，再 undo 上一步（两段式）

### 导入图片 iPad 上仍偶发黑边
v124 修了 transform bilinear edge 黑边（clamp-to-edge），但 user v128 实测 iPad 上某些图还是有。
- 可能是 importImageAsLayer 的 drawImage(bitmap, 0, 0, w, h) 走 Canvas2D imageSmoothing 仍有 1px 透明 fringe
- 或者 auto transform 走 mesh stamp 时还有 bilinear → bicubic 没接到位
- 待 user 给具体图复现，看是哪个路径

### iPad 偶发 zoom 误触（水珠 / 误触挡板还会漏）
v124 装了 4 层防御（body touch-action、capture-phase dblclick / 三指、paint-UI user-select、pointer 自愈），日常稳了。但极偶发还是会 zoom 一下——典型是手心湿 / iPad 屏上有水珠 / 戴手套点击，触发系统级 multi-touch 拼接的"伪 dblclick"绕过 dblclick handler。

可能要的兜底：
- viewport scale 锁定后 visualViewport scale 任何变化 → 直接 reset
- iOS 17+ 看看 GestureEvent 能不能再补一刀

不阻塞日常使用，遇到了重画一笔。等真踩多了再上面动。

### AI 本地 WASM（按需下载，不默 vendor）

| 工具 | 包大小 | 用途 | 一张耗时 |
|---|---|---|---|
| **rembg / U^2-Net** | ~15 MB | 背景移除（reference 去背景、线稿洗白底） | 1-3 s |
| **waifu2x / Real-ESRGAN** | ~20 MB | 超分（小 reference 清晰放大） | 2-5 s |
| **sketch-to-color** anime 模型 | 30-50 MB | 自动给线稿上色 | 5-10 s |

**关键约束**：默认**不**装。"AI 工具"菜单第一次点开 → 提示「需要下载 X MB 才能用」→ user 确认后从 GitHub Pages 路径 download → IDB / Cache Storage 存。再次启动用缓存。可手动「卸载 AI 工具」释放空间。

`navigator.storage.estimate()` 已经在用 → 加 AI 包尺寸提示。

PWA install/uninstall 子模块的可行性：Cache Storage + Service Worker 可控制，用户能从「设置」面板手动清。需写文档：[docs/ai-modular-vendor.md] 待新建。

有没有清理线稿的AI?

### AI 远程 API（user 自带 key）

| 服务 | 用途 | 成本 |
|---|---|---|
| Replicate / fal.ai | image-to-image / inpaint / SDXL | $0.01-0.10/张 |
| Anthropic Claude vision | 图描述、辅助 critique，画作 review | per token |
| OpenAI gpt-4o vision | 同上 | per token |

UX：菜单「AI 工具」分组 → 「配置 API key」→ 填进 localStorage（不出本地，user 自己付费）。

还有一个点子，让LLM帮你推荐配色色板

### 油画 / 水彩 / 厚涂笔刷
- 见 docs/lessons-magic-wand-gap-closing.md 类似思路（暂不实装但留 hook）
- 厚涂需要 normal map / 法线方向
- 水彩需要 wet-edge + 干燥状态机
- v82 加了 smudge engine 后已经可以做基础混色，更细的留 v100+

### WebGL / WebGPU 加速通路
- 详 [docs/engineering-roadmap.md] 已有完整论证
- 用途：lasso transform / liquify 大半径 / 大画布 brush stamp / distort 真透视
- 当前 Canvas 2D + 三角化近似有 PS1 artifact / C0 折角
- iPad WebGL 2.0 可用；WebGPU iOS 18+ 才稳
- 决策：「在 user 真正抱怨当前 Canvas 2D 精度 / 性能不够之前不开工」

### PSD 导出最小子集
- user 早期提过（v37 左右）：「导出 psd 做一下，最小子集可以啊」
- 最小子集 = 多 layer + 名字 + opacity + blend mode；不做 vector / smart object
- PSD bin spec 自己实现 ~300 行（zip 都不用）
- 跟 .ora 导出同模式，多一个文件格式选项

### 无缝贴图模式（offset / wrap）
- 详 docs/artist-priorities.md Tier 2 #14
- offset 视图：doc 居中偏移 (W/2, H/2) 让 seam 在画面中央
- wrap 笔刷：stamp 落在边缘时同时在反面镜像画一笔
- 目标场景：tileable texture（贴图工作流，3D 用）
- user 备注：「等 cel-shading + lasso 稳了再做」→ 现在 lasso 稳了，但仍是 P2

### 找颜色辅助 UI（near-current 近色搜索）
- 详 docs/artist-priorities.md Tier 2 #12
- "near current"调色板 / 在画布已有颜色里搜近色
- user 描述的「找颜色」动作 = 用画布上已有的颜色寻找下一笔的色
- 当前用 eyedropper 频繁取色代偿。palette window 也帮一点
- 真做出来 = 一个小窗显「画布上跟当前色 ΔE < N 的所有色」

### 吸色拖动 + 放大镜 + 拖 size 时浮 radius indicator
- 详 docs/artist-priorities.md Tier 3 #18
- 吸色：长按吸色时在指尖上方浮放大镜（user：「eyedropper 小圆 indicator 只要显示颜色也就够了」）
- 拖 size 滑块时弹个小窗显示当前 px 直径（user：「Procreate 是在旁边弹小窗，计算好尺寸」）
- 两者形式相近：浮动小窗 + 跟随手指 + 显数值或色块
- 一起做时 share 一个 floating-bubble 组件

### 长按 quick-assist（直线 / 弧）
- 详 docs/artist-priorities.md Tier 2 #9
- 笔画末尾停住 → 自动拉直 / 拉成圆弧
- **不是**形状工具（那个已经 P0 + 在做了），是 Procreate-style「画完一段笔画停手 0.5s 自动拉直」
- 跟 ShapesEngine 不冲突
- 兴趣不大，但留在这里参考

### 图层 alpha mask（PS-style，非 clipping）
- 详 docs/artist-priorities.md Tier 3 #16
- 跟现有 clipping mask 区别：clipping 是「clip 到下一层 alpha」，alpha mask 是「附加一张 mask canvas 控制本层 alpha」
- mask 是独立画布，可以独立画 / 擦
- PS 用了几十年的标准做法
- 兴趣不大，但留在这里参考

<!-- v123 删：size popup 预览 bug —— v123 全部重写（缩小 64px、竖排、显 "N px · M%"、boot 静默） -->

### 大喷枪低 alpha 处 color quantize banding 16-bit 升级（v104 记，v123 user 确认 8-bit 有瑕疵但无伤大雅，**tier 2 拖到以后做**）
- 现状：buildup 模式 buffer = Canvas2D RGBA 8-bit / channel；低 alpha stamps 累积每步 round 到 8-bit → 视觉 banding
- 8-bit 路径**可用**，banding 在大喷枪 + spacing 2% 时才明显，不影响日常画
- 升级路径备选：
  - 推 WebGL2 RGBA16F offscreen buffer
  - 或 Wash mode JS per-pixel buffer 升 Uint16Array 存 α
- 关联 docs/engineering-roadmap.md WebGL 通路



### iPad 双击误触 window 拖动 → finger state 抽风（v104 记）
- user：「有时双击时还是会错误拖动 ipad window 然后 finger state 抽风，按钮都按不了」
- 现象：iPad PWA 在某些位置双击触发了系统级 window drag gesture，本应进 app 的 finger
  state 被劫持，后续 pointer 事件错乱，按钮无响应
- 调查方向：
  - meta viewport `user-scalable=no` 是否生效？
  - touch-action 全局 manipulation 是否漏了某些区域？
  - PWA standalone mode display: `standalone` 是否影响 window drag 行为？
  - 双击是否被 iPad 系统判定为 "drag to resize/move"？需要 preventDefault on double-tap
- 短期修：global doubletap detector → preventDefault + 重置 pointer state
- 长期：可能要 logging 双击事件 + finger state，看 iOS 14/15/16/17 行为差异

<!-- v123：反选 + 去选 跟 全选 同组 —— 移入 immediately-now 这一批做（不在 backlog） -->

### 未下载文件的 thumb 显示（v124 记，user：「在头疼未下载文件的 thumbs 问题」）
- 现状：图库 tile 显示需要 thumb；云端文件未下载本地时 IDB 没缓存 → tile 显示问号 / 空
- 痛点：user 在云端有 N 张画，登录后不想全下载（流量 / 时间），但又想在图库里**看到缩略图**
- 候选路径：
  - sidecar thumb：每个 .ora 在云上同目录存一个 `<name>.thumb.png`（小，256-512px），
    图库只拉 thumb 不拉本体；user 点开才下 .ora
  - thumb 进 IDB 单独 store，登录后**只**同步 thumb store，本体懒下载
  - .ora 内部 mergedimage.png 是 thumb 候选，但要拉整 zip 才能读 → 不能省流量
- 关联：之前 backlog 有 "thumb 改 sidecar 文件 + 改善线稿缩图狗牙"，是同根问题
- 工作量：sidecar 路径 ~50 行（save 时多写一个 file；load 时优先拉 thumb）

### 蚂蚁线动画（tier 2，v123 记）
- 现状：marching squares 抽轮廓画黑白相间虚线，**不动**（user v113 起反映动画太干扰，撤了）
- 后续可加**很缓慢**的 dash offset 动画（每秒 1-2 像素，跟 Photoshop 比要慢）让"这是选区在动"语义更明确
- tier 2 低优先级

### smudge engine 真实装（v123 记，user：「smudge 之后做，先灰显」）
- 现状：tool=smudge 在 input.js 路由成 role=draw，走 brush engine（fallback）；setTool("smudge") 直接 return + status "暂未启用"
- v123 计划：UI 改灰显（按钮 visually 标 disabled、title 显"待实装"），不挑起用户预期
- 后续真做：参考 docs/brush-architecture.md 的 smudge 通路；engine 已有 `_sampleLayerColor`，需要 mode="smudge" 的 stamp-with-loaded-color + 步长内 color decay

### 7 个 toolbar icon webui 迭代后替换（v123 记）
- 求助信 docs/icon-iteration-prompt.md：smudge / 魔棒 / Venn 并 / Venn 差 / 橡皮 / eyedropper / 图库 / 笔刷 / 套索 / 全选 共 10 个
- user 走 Claude WebUI 拿回新 SVG → 替到 index.html 对应 `<button id="...">` 即可

### 颜色调整：更多模式（port AtlasMaker，v123 记）
- 现状：BCSH (亮度/对比/饱和/色相) per-pixel 烤进 surrogate canvas
- AtlasMaker 有：色阶 (levels)、曲线 (curves)、色彩平衡 (color balance)、HSL 选择性调整
- 抄前先看 AtlasMaker 实现，per-pixel 路径模板已稳
- 关联 v123 immediately-now 的"颜色调整 transient + UI 整理"先收尾，再扩

### 导入图片大过画板：apply 后用户主动 crop（v123 记，user 行为澄清）
- 现状（v122 起）：导入图片自动 lift 进 transform，user 调位置 / 缩放
- **要确认**：当导入图片大过画板边界时，**不要** auto-crop。让 user apply 后看到 floating 像素出 doc 边，然后用画布裁切手动收
- 工作量 ~5 行：lift 时**不**调整 lift 后的 bbox 到 doc 边内；commit 时仍按 selection 走（selection = whole doc 仅 doc 范围内被写）

### history entry blob 压缩节奏监控（v123 记）
- 现状：stroke / lasso / docTransform / liquify 等 entry 都走 compressPixelSnap → blob，imageData 释放
- 没 bug，但 memory pressure 大时（多 entry 累积）blob 仍可观；监控**内存峰值**，必要时减少 entry 保留窗口或 OPFS spill
- tier 2

### Lasso 描边 v125+（user 早提，v124 归位）
- 现在 lasso 只有 fill / clear；user 要 stroke 选区边
- 参数（user 列）：width / softness / use active brush vs 简单线 / inner-outer 对齐（inside/center/outside）
- 接现有 lasso UI row 2，加 "描边" 按钮 + 弹配置 popup
- 工作量：~80 行 stroke rendering（按 mask 边缘 marching squares 路径走 + 模拟笔刷 stamp 或简单线）

### Lasso polygon mode（**已在上面 "lasso 多边形模式" 条**，这条删避重复）

### 颜色调整：更多模式（port AtlasMaker，v123 记，**已在上面**，去重）

### 智能形状笔（brush preset toggle，v125+，user 早提）
- brush settings 加 toggle："智能形状"
- 开启后：用户画完一笔，**实时**分析（不是 procreate 那种长按激活）：
  - 直线 / 折线 / 闭合多边形 / 矩形 / 椭圆 / 正圆 / 正方形
  - 自动 snap，保留压感（继承原 stroke 的 size variation）
- UX 论证待写：什么 stroke shape 判定准则；何时弹"已被识别为 X"提示；如何允许 user reject
- 不是替代 procreate 长按；是默认行为
- 关联 backlog 旧条 "shape 工具改 procreate 自动建议" — 思路一致但更激进（自动而非建议）

### dev/prod branch 抄给 sibling family（v123 记）
- WebPaint v122 走通后，按 docs/dev-prod-split.md checklist 逐个考量 sibling：
  - 满足"外部用户 + 用户有数据 + dependency 你 URL"三条的：上 branch + Actions
  - 不满足的（如 Background Radio 纯 read）：留单分支保持简单
- 评估 + 决定一个一个来，不强推

<!-- v124 删：液化 + 笔刷 respect 选区 —— 实际全部实施完了 (input.js _endStroke / _endLiquify 已 hook applySelectionMaskPostStroke；color adjust _bakeBCSHWithMask；board live overlay _clipOverlayToSelection)。backlog 条目过时。 -->


<!-- v123 删：lasso transform 数学大修 整条
  - uniform 角拖：v118 + v119 修完，user 多次确认"fix 角"而非中心缩放（**不要再加中心缩放**）
  - rotation handle：v117 加了 line + circle（无 arc icon per user v118）
  - free top/bottom 拖动反向：v117 swap 修了
  - ants 不见：v113 marching squares virtual padding 修了
  - distort → free 切换基底：v117 + v122 已修

  v123 删：颜色调整 ctx.filter 兜底
  - v113 已切 per-pixel BCSH（user 确认走这条），ctx.filter 通路废
-->


### lasso 多边形模式（v104 记）
- user：「lasso 能加多边形模式吗？最好是 down 之后拖拽，然后 up 之后才写入」
- procreate / PS 标准多边形 lasso：tap = 落点，拖拽 = 预览下一段线，up = 写入下一顶点；
  闭合靠 tap 起点 或 双击
- 跟现有 freehand lasso 的 sub-tool 切换并列（add SubTool: "polygon"）
- 也可以 Photoshop 那种"拖一段画曲线，up 转多边形"风格——user 描述更像 down 拖 up 写入
- 工作量：~80 行 lasso.js 状态机 + drawingPath 渲染

### shape 工具改 procreate 自动建议（v104 记）
- user：「我感觉直线和正圆还是需要轻重变化。所以也许还是应该参考 procreate 的方案，
  而不是单独的无压感图形工具」
- 现状：shapes tool 独立工具，画形状无压感（无 size variation）
- procreate：画完任意 stroke 末尾停手不抬笔 0.5s → 自动 snap 到「最接近」的几何形状
  （直线 / 圆 / 椭圆 / 矩形 / 三角形）。形状继承原 stroke 的 size variation（压感留着）
- 实现：detect end-of-stroke pause → 形状识别（curvature analysis / circle fit / line fit）
  → 提示 "auto-line / auto-circle / ..."，user 点确认 snap
- 好处：保留压感笔感，user 不需要切工具
- shapes 工具可保留但弱化（fallback for cases auto detect 不准）
- 工作量：~300 行（识别算法 + UI 提示 + 适配现有 stroke buffer）

### 导入图片自动进 transform（v103 记）
- user：「导入图片到图层之后自动全选图片进入 transform 模式」
- 现状：导入图片 = 新图层 + 像素就位，user 还得手动 lasso 全选才能调位置 / 缩放
- 目标：导入完直接 lift 整个 layer 到 floating transform，user 直接拖角调位置 / 缩放 /
  旋转 / 透视；commit 落到 layer 像素
- 关联：layer 操作（add layer with image）+ lasso lift selection 等价但选区 = 全部
- 改：menuImport / addImportPhoto 等 handler 走 fillSelection (whole doc) → liftSelectionForTransform
- 工作量 ~50 行

<!-- v123 删：transform 模式自由度切换 drag 异常 —— v117/v118/v122 修完，distort→free 已加 shearless 投影 (_projectMeshToRectangle)；user v123 确认"修好了" -->


### thumb 改 sidecar 文件 + 改善线稿缩图狗牙（v102 记）
- user：「thumb 生成的时候在线稿场景狗牙很厉害」+「thumb 改成 sidecar，可以从云上批量拉，
  然后也方便 pc 端管理」
- 现状 = thumb 烧进 .ora 文件内的 mergedimage.png；本地 gallery 渲染要先解压 ora 才能看
- 目标 = 拆出独立的 `<name>.thumb.png`（OneDrive 同目录），跟 .ora 平级
  - 云端 list 一次就拿到所有 thumb url，gallery 批量 fetch + cache，速度上来
  - PC 端 / Finder 端文件管理友好（双击就看见缩图）
  - .ora 内部还保留 mergedimage.png 当 fallback（offline 兜底）
- 狗牙问题（独立）：当前 `drawImage` 单步 box-filter；线稿 + 大面积透明 → hard edge 出狗牙
  - 解：多步降采样（每步缩半级联）；或线稿专用 path（detect alpha 占比 + 边缘锐度）
- 改：session.js 加 thumb 单独读写；cloud.js / OneDrive 同步 thumb；gallery.js 渲染换 thumb url
- 跟 v98 brush rack 同套云端同步 + 冲突 model 复用

### 像素艺术工作流：pixel grid 显示 + 整数缩放
- v97 加了像素笔（pixelMode）：整数 snap + fillRect 无 AA
- 缺：缩放 ≥ 8× 时叠 1px 网格线（Aseprite 风格）
- 缺：像素笔时 cursor 显示为 1px 方块（不是圆圈）
- 缺：缩放 snap 到整数倍（避免 1.5× 出现锯齿）
- 工作量 ~150 行 board / overlay 改

### 调色板小窗 (palette mixer)
- v87 实装 256×256 浮动 mixer 窗 → v94 撤掉 UI（user 觉得不值得自己做）
- user：「需要同样的笔刷混色。你觉得麻烦，那还不如就在画布上调色」
- code 在 src/palette.js 留着；HTML / 菜单入口 / CSS 已删
- 重启时机：如果做了「找颜色辅助 UI 近色搜索」，可考虑跟 mixer 合并

### Lineart 重新着色
- 详 docs/artist-priorities.md Tier 2 #8b
- 把已有描线颜色换成另一色（红描线 → 黑 / 棕）
- 简化版：alpha lock + 全填新色
- 终极版：图层 fx「色相 / 染色」effect 层（依赖 Tier 3 调整层）

### 容隙 (gap closing) for 魔术棒
- v71 实装 → v79 撤掉
- 详 [docs/lessons-magic-wand-gap-closing.md]
- 重做思路：EDT 距离场 + Dijkstra-like cost-flood / dead-end 桥接 / 双层混合
- 距 P2 也远

### PC鼠绘方案
- 关键是缺压感，是否可以使用滚轮来设置压感
- 鼠标拖拽画笔来实现平滑

### 手机模式
小屏指绘，UI需要特别精简，全部空间留给画布

### VR方案
- meta quest webxr画笔方案？类似3d白板（太远了，但是有趣）

### 导入人体参考
可以滑块调比例，甚至3d。同样太远了

### 插件系统
ai vr 3d等东西可以作为第一方插件？用户可以选择安装。

### 字体工具
只带一个轻量的最基本的（或者浏览器有？那么连这个都不提供）。提供字体管理小窗用户可以上传到appfolder/.fonts/里面，自动根据fontname(或者别的什么）改名方便检索）

### 撒花撒星星
jitter, scattering, h/s/v variation, texture, rotation/size variation

### 记录时间和重放
记录画的时间，stroke数。不过如何判断idle呢需要一个规则
然后也可以考虑下procreate的保留一个replay mp4的功能

### 测试指绘，PC板绘（数位板）

## 用我这本本子的方式

新点子来了 → 先写这里，标 P0/P1/P2/❄。等积累到自然想做某件，再单独开个 docs/lesson-*.md / 设计 doc 论证。

P0 永远是路线上**下一个**该做的，不堆。
