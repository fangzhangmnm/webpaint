# 小本本 —— TODO 池 + 好点子

> 不是 MVP，但有趣 / 等以后做。新点子先丢这里冷藏，时机到再拎出来论证。

> 就是一个TODO list，写暂时不修的bug，好点子，需要的功能。放的是怕忘，但是一下事太多只能放一边的东西

## 状态约定

- **P0 必做**：已规划进 v89-v95 路线
- **P1 想做**：方向认可，时机未到
- **P2 备选**：有趣但远未刚需,post alpha 再做，低优先级

---

## P0（v89+ 路线明确的）

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

### size popup 预览 bug 一堆（v108 记）
- user：「大小预览忘了算 scale，而且太大会被 clamp（可以框有最大，然后 preview crop）。
  然后笔的预设我也动过」
- 现状：size popup 显「N px」+ mini circle (capped 60px display)
- bug 1：忘算 board zoom scale —— "100 px" 是 doc 像素，但屏幕 cursor 实际半径
  = 100 × board.zoom；user 拖 slider 时看不到屏幕实际大小
- bug 2：超过 60px display 时被 clamp，预览不再随 size 增长 → 反馈断
- 解：popup 框设最大尺寸（如 80×80 或 100×100），circle 真正按 size × zoom 画，
  超出框时 overflow: hidden crop 显示（procreate 是这样）
- 加 text 同时显「N px（屏幕约 M px）」二行展示
- backlog，等顺手做

### 大喷枪低 alpha 处 color quantize banding（v104 记）
- user：「大喷枪能看到 color quantize error」
- 现状：buildup 模式 buffer = Canvas2D RGBA (8-bit/channel)
- 低 alpha stamps 累积时每步 round 到 8-bit → 视觉 banding（特别是 spacing 2% 时层数极多）
- 解：buffer 升 16-bit（offscreen canvas RGBA16 还没真正普及，要 WebGL2 RGBA16F 路径）
- 或：buffer 改 float32 Uint8 模拟（每像素 4 bytes int → float scale，自己做 alpha 累加）
- 或：Wash mode 的 JS per-pixel 路径也升 16-bit Uint16Array 存 α
- 关联 docs/engineering-roadmap.md WebGL 通路（已论证）

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

### lasso 反选/去选 应该在一起（v104 记）
- user：「lasso 里面反选和去选应该在一个地方，你分类错了」
- 现状：「反选」和「去选」按钮分散在 lasso toolbar 不同位置
- 都是 selection 修改类操作（接受当前选区，输出新选区或无），归一起
- 改：lassoToolbarRow2 重排，selectionActions 里把反选 / 去选 / 填色 / 清除选区
  四个 grouping 到一起；变换 / 复印 / 复制层等 lift-类操作另一组

### 液化 + 笔刷 respect 选区 (v113 记，user：「液化和笔刷都要 respect 选区」)
- 现状：lasso fill/clear 受选区影响；adjust suite v113 起 respect；笔刷 / 液化 不 respect
- 笔刷：current stroke 走 brush engine 直接写 layer，选区 mask 没 hook
  - lasso.applySelectionMaskPostStroke 已有！是 stroke 结束后把选区外像素 revert 到 preSnap
  - 检查为啥没在 brush endStroke 后自动调；找 input.js _abortStroke / _commitStroke 路径
- 液化：current 走 liquify engine 改 layer 像素，同样没受 mask 限制
  - 同思路：preSnap → liquify → 选区外 revert，applySelectionMaskPostStroke 可复用
- 关联：stroke entry beforeSnap 已经存了；只缺 "endStroke 时检查 doc.selection 并 mask"
- 工作量 ~20 行 hook

### lasso transform 数学大修 (v112 记，user：「建议好好理一遍数学」)
v110 加 mesh 后 v111 投影补丁，user 测出多个 drag/handle bug：
- **uniform 还是错**：应该用 opposite angle 做 pivot（拖角时对角角固定），现在大概 pivot 在中心
- **自由 / 等比 忘了旋转 handle**：通常在 top-edge 上方浮一个 rotation handle
- **free transform 拖动上面下面动**：top/bottom 拖某条边时另一条跟着动，math 错了
- **变换 commit 后 lasso 再拖矩形蚂蚁线不见**：可能新 selection 的 _chains / _outline 没正确重算
- 建议重新论证 transform basis：
  - free = pure affine (rotate + scale + skew)，需要旋转 handle
  - uniform = affine + lock aspect，opposite corner pivot
  - distort = perspective (free quad)，4 corner = 4 control points
  - warp = bezier patch (4x4 mesh)
- 写 docs/transform-math.md 论证 + 比对 Procreate / Photoshop UX

### 颜色调整 ctx.filter 兜底 (v112 记，user：「颜色调整没 work」)
- v110 用 ctx.filter on board render；v112 加 save/restore 包裹防 setter 不清
- 若 iPad Safari Canvas2D filter 仍偶发不渲染：fallback 走 off-screen canvas 预渲染
  + board.setActiveLayerSurrogate(layerId, canvas) 路径
- 终极 fallback：JS per-pixel 算 B/C/S/H (avoid Canvas2D filter)
- 优先级：v112 先看 save/restore 够不够

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

### transform 模式自由度切换 drag 异常（v103 记）
- user：「transform 模式下你高自由度（比如 perspective）时调回低自由度模式（比如 free, uniform）时拖拽行为异常」
- 现象：在 perspective 模式下拖动后，切回 free / uniform 拖角行为异常（猜：handle 锚点 / 矩阵基底没重算）
- 根因猜：mode 切换时 floating.transform matrix 是 perspective 的（4 控制点变形），降级回 free
  时该把 matrix 投影回 affine basis（rotation + scale + translation），而不是直接当 free 用
- 改：lasso.js setMode 切换路径加 matrix 降级 helper（perspective → affine 投影，反之保持当前不动）
- 工作量 ~30 行；待复现 + 测

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

### VR方案
- meta quest webxr画笔方案？类似3d白板（太远了，但是有趣）

### 导入人体参考
可以滑块调比例，甚至3d。同样太远了

### 插件系统
ai vr 3d等东西可以作为第一方插件？用户可以选择安装。

## 用我这本本子的方式

新点子来了 → 先写这里，标 P0/P1/P2/❄。等积累到自然想做某件，再单独开个 docs/lesson-*.md / 设计 doc 论证。

P0 永远是路线上**下一个**该做的，不堆。
