# 本 app 的图标

125 icons · 提取自家族图标库 `../../../../20260708 SVG Icons/icons.svg` · 由 `extract-icons.py` 生成，别手改。

用法：把 sprite 整段内联到 `<body>` 顶部，然后按 id 引用；
⚠ sprite 根自带的隐藏样式（1×1 + `opacity:0`）别换成 `display:none`——
不渲染的子树里 `<mask>`/`<clipPath>` 不生效，靠遮罩留白的图标会静默糊掉；
颜色跟随 CSS `color`（全部 `currentColor`）：

```html
<!-- 内联 icons.svg -->
<svg width="24" height="24"><use href="#eraser"/></svg>
```


## drawing-tool

| name | 说明 |
|------|------|
| `eraser` | 橡皮:18x11 圆角矩形斜置 -45°, 一道分割线在自下端 30% 处(下段=擦头) |
| `eyedropper` | 吸管:滴管斜置, 管尖在左下, 圆胶头在右上 |
| `lasso` | 套索:闭合绳圈 + 自左下垂出的绳尾 |
| `magic-wand` | 魔术棒:实心凹边四角星(控制点 0.12r —— 0.42r 会拉成菱形)在杖头 + 左上左下各一小星 + 斜杖 -45° |
| `paint-bucket` | 线描桶+实心水滴 (定稿:把手弧高≈4.9=原 -3) |
| `pencil` | 铅笔 Bootstrap Icons MIT |
| `stamp` | 橡皮图章 |
| `finger` | 手指按压(涂抹/触摸语义):WebPaint v124(2026-05-30) 用户手编贝塞尔原样入库, 斜指左下; 考古时从 v309 purge 中出土, 20260724 候选 5 号入库; 设计意图 brief 见 WebPaint docs/20260530-icon-iteration-prompt.md |
| `brush-rack` | 笔架:H 型架 + 三支平头刷。笔号只改梯形宽度, 长度与底边全部对齐到最大那支(梯形有底边所以不会像尖头那样读成箭头;杆的屁股探出横梁) —— 宽 1.0/1.5/2.1, 笔头长 3.8 |
| `brush-width` | 笔刷宽度:平行两条波浪(标准1.7/粗3.4) |
| `brush-width-locked` | 锁定笔刷宽度: brush-width 两条波浪 + 右下角锁徽标(遮罩挖洞, 与 snap-vanishing-point 同款徽标语法); 20260725 入库 |
| `pen-pressure` | 笔压启用·案D:库内 pencil(Bootstrap 实心, 尖本就朝左下)缩到 0.60 置右上 + 笔尖 (9.4,14.6) 处两道同心波纹环(r4.8/7.6, 缺口 100° 让给笔身); 20260728 候选 4 号入库(甲方参考图思路) |
| `pen-pressure-off` | 笔压禁用:pen-pressure 原图(pencil+两道波纹)整体 + 与笔身垂直的删除线(↘, 遮罩在笔与波纹上都留白, 同 edit-disabled 语法); 20260728 入库 |

## tool

| name | 说明 |
|------|------|
| `hand` | 手/抓取:食指左线裁到与拇指指尖弧交点 y=11.44,不再穿出 |
| `shapes-with-line` | 形状+直线:shapes(方+圆)下移 2.4, 顶上斜线(右端缩到 x18); 20260724 候选 2 号入库 |
| `shapes` | 形状工具:方+圆(圆遮挡处用 mask 裁掉方框线) |

## shapes

| name | 说明 |
|------|------|
| `rectangle` | 矩形(shapes 基本图元) |
| `circle` | 圆(shapes 基本图元,无圆心点) |
| `line` | 直线(shapes 基本图元):斜线+两端点, 与 arc 同族(同点径 1.2), 29° 防端点顶角; 20260725 入库 |
| `snap-angle` | 角度吸附(15° 整数角):字样「15°」, 数字走 fps 同款几何圆角骨架(1=杆+旗, 5=fps 的 S 同形, °=小圆); 图形系四方案(量角器/扇形/方向扇/磁铁)均落选; 20260725 入库 |
| `constrain-ratio` | 1:1 比例约束(正方/正圆两钮共用的唯一 id, 20260725 由 constrain-square/constrain-circle 更名合并):正方内手绘 1:1 |
| `grid-border` | grid 外框 toggle:虚线外框(dash 2.25/2.0, 每边恰 4 周期角上起笔对称)+实线田字内格 —— 虚线圈=可开关的 border 本体; 20260725 入库 |
| `square` | 正方(rect 变体):与 rectangle 同笔重, 边长 12 居中(rectangle 是 16x12 横矩形, 1:1 一眼可辨); 20260728 入库(甲方裁定不加 1:1 记号 —— 与 rectangle 并列时形状本身可辨, 加记号会撞 constrain-ratio 语义) |
| `ellipse` | 椭圆(circle 变体):横椭圆 rx9 ry6, 与 circle(r8) 同笔重; 20260728 入库 |
| `line-snap` | 吸附角度(line 变体)·案A:线固定在 45°(甲方 20260728) + 细水平参考线 + 夹角弧标注该角度; 20260728 入库(变体项要图形语言, 取代文字版 snap-angle 在变体槽的用法) |

## perspective-reference

| name | 说明 |
|------|------|
| `snap-vanishing-point` | 透视下直线约束·最弱版:2p cube(立边全平行, 只有左右收敛) + 锁徽标; 20260725 入库, 原需求 id snap-vp 展开缩写 |
| `vanishing-point-edit` | 编辑消失点:persp 族语境版 —— 视口框+细地平线(避开箭头断开)+地平线上的 VP 大点+四向拖拽箭头; 20260725 入库, 原需求 id vp-edit 展开缩写 |
| `persp-viewport` | 视口对齐(关透视)·四角箭头版:maximize-viewport 四角语言(长方形 16:12)+N/E 双轴自共用原点分叉(北 7.0 长/东 4.6 短, 首尾相连版读成回车键已弃); 20260728 定稿入库(原 4x3 格子版与 grid/grid-border 打架, 退役) |
| `persp-1p` | 透视模式·一点透视(框系):视口框+细地平线+中心消失点+仅下方两条收敛轨(公路母题; 四角全连读成信封已弃); 20260725 入库 |
| `persp-2p` | 透视模式·两点透视:框边双点+加宽 cube(s=0.55, 宽 7.33-16.67)+地平线被 cube 遮罩留白(20260725 定); 20260725 入库 |
| `persp-3p` | 透视模式·三点透视:加宽压低俯视 cube 真算(VPl 3.5,7 · VPr 20.5,7 · VPb 12,19.8 · s=0.62: 宽 6.73-17.27, 高 8.01-17.3), 地平线不画(太挤, 只留框边双点+底点); 20260725 入库 |
| `plane-ground` | 透视平面·地板:温和收敛梯形(顶边加宽 6.5-17.5, VP 远在 y-6.6 而非旧版贴脸的 y0.5)+收敛格; 横中线=对角线交点 y12.53(投影正确且不再显高); 20260725 入库 |
| `plane-wall` | 透视平面·纵深墙: plane-wall-left 的同形别名 id(独立图形已驳回, 20260725) |
| `plane-wall-left` | 透视平面·左墙(20260725 与右墙对调):高边在右·面朝左消失点; 20260725 入库 |
| `plane-wall-right` | 透视平面·右墙(20260725 与左墙对调):高边在左·面朝右消失点; 20260725 入库 |
| `persp-iso` | 等轴测模式·iso 3x3 顶满:hw10.2/hh5.1(x1.8-22.2, 含描边到 0.95/23.05 —— 比库内惯例更满, 看是否可接受); 20260728 候选 3 号入库(顶满版; 2x2 与常规 3x3 落选) |

## image-processing

| name | 说明 |
|------|------|
| `checkerboard-background` | 透明背景(画框版):圆角框内棋盘 + evenodd 裁掉中心圆, 横向 6 格 (cell 3.0) —— 格子边长整除框宽 18, 边缘不切半格 |
| `color` | 三色文氏图(弱半透明填充,重叠处自然叠深) |
| `fx` | 滤镜/调整 fx:Charis SIL Italic 轮廓+合成粗体(已烘焙,不依赖设备字体) |
| `lock-alpha` | 锁定不透明度:棋盘格加粗到 4.33 |
| `opacity` | 不透明度:圆内左半实心+右半棋盘(甲方 spec;优于库内 transparency) |
| `reference-layer` | 设为参考层:菱形图层+右下角眼睛徽标(遮罩留白边), 眼睛不居顶所以没有共济会味 |
| `sliders` | 不写类别 |
| `clipping-mask` | 剪贴蒙版:折角箭头(PS 同款下折指向语义) |
| `layers-stack` | 图层堆叠:菱形顶片 + 下方两条平行折线示意叠层 |
| `merge-layer-down` | 向下合并一层:层宽21 间距0.3 箭尖入层62%(原6号;原名 merge-down, 20260724 改名让位给 merge-layers 双版本) |
| `offset-wrap` | offset/wrap 无缝贴图平移取模 x=(x+512)%1024:箭头从右边穿出、虚线段从左边再进(pac-man wrap), 穿越处画框用遮罩留 gap; 20260724 候选 2 号入库 |
| `merge-layers` | 合并多个图层:三层压缩交叠, z-sort 遮挡(bottom 被 top1+top2 联合遮罩留白, top2 被 top1 遮罩), 箭头置顶带白晕入底层 62%; 层宽19 斜率同 merge-layer-down; 20260724 候选 4 号入库 |
| `crop` | 裁切:两 L 交叠, 线宽 1.5x 标准(2.55) |
| `crop-fixed-size` | 定尺寸裁剪·案B:矩形缩到左上 + 底边与右边两条定长标记(宽高都定); 20260730 候选 2 号入库 |
| `fit-fill` | 填充(Fill)·长颈瓶变体J:同瓶 s1.28 轻裁瓶底(整瓶轮廓保留); 20260730 候选 J 入库(长颈瓶 口7.0/腹11.0 颈占高32%) |
| `fit-contain` | 适应(Fit)·长颈瓶变体J:口7.0/腹11.00=0.64, 颈段占高 32%(甲方 20260730: 瓶口长一点肚子小一点), 上下各留 2.6; 20260730 候选 J 入库(与 fit-fill 同一只瓶) |

## transform

| name | 说明 |
|------|------|
| `flip-horizontal` | 水平翻转(尖端朝内):左空心 右实心+圆角描边。实心那个按 0.88 缩放 —— 外轮廓一致时实心墨迹 41.4(空心 40.2), 视觉上更重, 故需略缩。此处外宽 6.4(空心 7.03) |
| `free-transform` | 自由变换·中心加 move 四向箭头:虚框放大到 4-20(原 6-18 里十字挤成一坨)+手柄缩到 2.9 挪到框角外, 十字臂长 4.6(move 同画法 ×0.51); 20260725 甲方定稿入库(原纯虚框+四手柄版退役) |
| `scale-perspective` | 透视缩放·梯形包住虚框:虚框尺寸对齐旧版(7.5w x 12h, 旧版旋转后屏幕实测同值), 置左 x3.5-11 y6-18; 梯形左边窄=虚框左边两顶点(3.5, 6/18)完全重合, 右边宽 x21 y2.6-21.4 张开包住; 箭头指张开方向; 20260725 甲方定稿入库(旧版镜像+旋转构造退役) |
| `rotate-ccw` | 逆时针旋转+轴 (WebPaint 在用) |
| `scale-free` | 自由缩放(矩形框+小方虚线) |
| `scale-uniform` | 等比缩放(正方框+小方虚线) |

## selection

| name | 说明 |
|------|------|
| `select-all` | 全选:实线外框 + 内嵌虚线框, 内部浅填充表示整幅已选中 |
| `select-ellipse` | 椭圆选区:虚线椭圆 |
| `select-freehand` | 自由套索选区:虚线不规则闭合圈 |
| `select-rectangle` | 矩形选区:虚线矩形 |
| `selection-clear` | 取消选区:虚线方框 + 内部 × |
| `selection-difference` | 差集:后框被前框 mask 遮挡(留 gap)+减号 |
| `selection-expand` | 编辑选区:虚线外框 + 内部实线小方框 |
| `selection-invert` | 反选:圆角方框沿对角线切开, 一半填实一半留空 —— 选区与非选区对调 |
| `selection-new` | 虚线方框+加号 |
| `selection-union` | 并集:后框被前框 mask 遮挡(留 gap)+加号 |
| `select-polygon` | 多边形套索·flag 变体1:五边不规则, 下缘 V 形凹口(concave 顶点在 12,13.2 朝下), 左右两端不对称; 20260728 候选 1 号入库 |

## edit

| name | 说明 |
|------|------|
| `arrow-redo` | 重做:arrow-undo 的水平镜像 |
| `arrow-undo` | 撤销:向左的直角回勾箭头 |
| `clear-document` | 清空文档:文档 + 右上角橡皮(放大到 0.72;原位置墨迹顶到 x=24 出框, 已左移到 7.7) |
| `clipboard` | 从剪切板新建:夹板+纸(夹子用 mask 遮挡板身边线) |
| `copy` | 两个文件叠放 |
| `move-to-file` | 文件+绕行箭头(移到文件) |

## file

| name | 说明 |
|------|------|
| `export` | 导出:向上箭头离开托盘(import 的上下镜像) |
| `floppy-disk` | 软盘/保存:滑盖左右对称(7/17)且两竖线顶到顶边 + 防呆角 k=3 |
| `folder` | 文件夹:左边 tab + 矩形主体 |
| `folder-open` | 打开的文件夹:背板止于盖顶 T 接,不再互相压线 |
| `gallery` | 图库入口:图片堆叠(沿用 image 的太阳+山母题) |
| `image` | 从图片新建:相框+山+太阳 |
| `import` | 导入:向下箭头落进托盘(托盘=开口朝上的 U) |
| `new` | 新建:纯加号(等长十字线) |
| `rename` | 重命名:文字光标+铅笔 |
| `restore-trash` | 同上但盖只掀 -16° |
| `trash-can` | 垃圾桶:桶身收口(feather 是直筒);与 fluent(圆提手/更低)、heroicons(弧形透视)亦不同 — own |
| `save-as` | 另存为(floppy-disk=保存 的配对键):双软盘叠放(copy 的前后件语法), 后盘右上探出, 前盘遮罩留白; 20260724 候选 3 号入库 |

## hierarchy

| name | 说明 |
|------|------|
| `create-folder` | 加号做成右下角徽标 |
| `explode-folder` | 解散文件夹:虚线 folder 残影 + 内容三方块排成一行落在下方 |
| `lock` | 锁:体 13x11+锁梁抬高(腿3.5),整体居中 |
| `move-out-folder` | 移出文件夹(定 3 号):folder + 弧 R9.5 由内向外, 箭头方向按弧末端切线求得(80.8°) |
| `move-to-folder` | 移入文件夹(定 2 号):小 folder + 弧箭头, 箭头头部在 folder 内 · 尾巴在外 |
| `unlock` | 开锁:同 lock 体型+锁梁弹开 |
| `visibility-hide` | 隐藏:同 show 撑高版+斜杠(mask 留 gap) |
| `visibility-show` | 可见:撑高眼裂+瞳孔 r4.3(甲方实测原版太小) |

## common

| name | 说明 |
|------|------|
| `back` | 返回:左向整箭头(带杆;裸 chevron-left 曾因小尺寸渲染差被 sunset) |
| `check` | 勾 |
| `chevron-down` | 下移:竖线 + 底端 ∨ 箭头 |
| `chevron-up` | 上移:竖线 + 顶端 ∧ 箭头 |
| `x` | 叉 |

## cloud

| name | 说明 |
|------|------|
| `cloud` | 云 |
| `cloud-busy-base` | 云端忙 静态件:云轮廓中心挖圆洞, 与 cloud-busy-spinner 叠放合成一个资产 |
| `cloud-busy-spinner` | 云端忙 旋转件:弧+箭头, 圆心正在 (12,12) 所以 CSS rotate 原地转不甩 |
| `cloud-pending` | 待判定:虚线云 + 云内问号(加粗 2.4, 遮罩描边留白与云脱开;问号下点的半径=描边半宽) |
| `cloud-synced` | 云+勾 |
| `cloud-unavailable` | — |
| `cloud-upload` | 云+上传箭头 (云形统一为 feather 的) |
| `download` | 下载 |
| `refresh` | 刷新:顺时针 3/4 圆 + 箭头(从 12 点绕到 9 点, 箭头尖在右上) |
| `sign-out` | 退出登录:门框+向外箭头(通用 logout 图元) |
| `unload-local-cache` | 卸载本地副本:database(=本地) + 斜删除线(mask 留 gap)【非垃圾桶, 云端仍保留】 |
| `upload` | 上传 |

## globalization

| name | 说明 |
|------|------|
| `globe-speech` | 语言=地球+对话气泡(mask 抠洞遮挡,留 gap) |

## viewport

| name | 说明 |
|------|------|
| `grid` | 网格:直角外框 1.2 与内网格线同宽(20260725 甲方定稿; 原 rx1.6 圆角粗框版退役), 内部 4x4 细网格 |
| `maximize-viewport` | 适配视口:四角向外的箭头 |
| `picture-in-picture` | 画中画:大框(主画布) + 右下角内嵌小窗(参考小窗自己) |

## ui

| name | 说明 |
|------|------|
| `database` | — |
| `menu` | 汉堡菜单:三条等长横线(y=7/12/17) |
| `more` | 溢出菜单:横向三点(原 ⋯ 字符跨平台字形不一) |
| `shortcut` | 快捷键:键帽圆角方块内放 V |
| `theme` | 主题日月同辉:细月牙(大圆挖近等大圆) + 八芒太阳嵌在缺口里, 光芒是与太阳脱开的短线。日月直径比 1.00, 分离角 -30°, 分离距离 1.05 倍月半径;太阳用遮罩描边留白从月牙上抠出白边 |
| `wrench` | 扳手:斜置组合扳手轮廓(feather:wrench 衍生), 20260724 候选 1 号入库 |
| `fps` | fps 帧率·纯字母 手绘几何圆角大写(7 段数码管骨架连笔无断口+圆角转角, F/P/S bbox 对齐; 字体/7段断口/点阵/手绘幼圆方案均落选); 20260725 候选 6 号入库 |

## ai

| name | 说明 |
|------|------|
| `ai-slop` | AI slop/胡言乱语:dumb 方头+蚊香眼+装乱码的大灯泡+头顶天线(线+球, 避开右侧灯泡); 20260725 加天线版回库 |

## third-party

| name | 说明 |
|------|------|
| `blender` | Blender sync:瘦长体 Bl + Adobe 式圆角方框(PT Sans Narrow Bold, l 带钩不与 i/1 混; 宽高比 0.96) |
