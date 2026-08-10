# ADR-0006：透视 frame（形状笔全局）+ grid 笔——尺笔透视模式被全局透视吃掉

> created 20260725
> 状态：**已决定 —— 实现于 worktree-shape-brush（P1-P6）**

## 背景

「尺笔」原始需求 = 头身比参考线（拖 AABB 画平行横杠），迭代出四个透视模式（水平/竖直/
地面 grid/透视墙）。2026-07-25 grill 中 user 推翻该结构：**透视不是尺笔的属性，是形状笔
全局的 frame**——透视开着时直线 snap、矩形、圆全都透视化，尺笔退化成平平无奇的 grid 笔。

## 决定

1. **frame 三态起步**：align-to-viewport（默认）/ 透视平面。透视配置 = **VP 0-3 个**
   （vp1/vp2 水平对按 x 自动排序、lockHorizon 默认开锁 doc 水平线（极端场景可关=歪地平线）；
   vp3 竖直族只有位置，地平线下=俯视/上=仰视，**三点透视必做**——完美解决大角度透视）+
   参考点 + 当前平面。**平面清单**：1 VP：地板/墙；2/3 VP：地板/左墙/右墙（好懂过 xyz
   convention）。**0 VP = 关**。整套 per-ora（editorState.persp，desk 跟文件走）。
2. **两角定形 → 单位方 homography**：任一平面下拖两个对角点唯一确定四边形（各角点过两族
   的线，四交点）；「单位正方形→四边形」homography 唯一 → 透视矩形=四边、**透视椭圆=内切
   圆的像**、**grid 间距=cross-ratio 透视缩短白送**。
   ~~深度缩放自由度在四角固定后不存在 → 平面内"正方/正圆"约束结构性不可定义（没有度量），
   约束键在透视下只对 line 有意义~~
   **【修订 v0.6.10 / 2026-07-26】"无度量"判决被推翻**：planeMetric 用经典作图约定重建视点
   （三点=垂心+Thales / 二点=中心投影 / 一点=d=H）→ 平面获得真欧氏度量，正方=|du|==|dv|、
   正圆=平面圆的像，约束键在透视下全形状生效（见 perspective-frame.ts planeMetric 注释块；
   本条修订原应随 4ff29b4 落 ADR 未落，2026-07-28 补）。line 的约束仍=吸向 VP 的透视辅助线，
   多 VP 时离拖拽方向最近者胜。
3. **地平线奇点（史瓦西 patch 类比）**：**所有跨线路径都要 ε 护栏，无一"结构性免疫"**。
   **【修订 2026-07-28】**原文"rect/grid/像素椭圆走 doc 锚定角点+homography、结构性不碰
   奇点"是**事实错误的前提**：两角定形只有用户给的两个角是 doc 锚定的，**导出的另两个角
   是族线交点，拖拽跨地平线时恰好落在奇点上**——解析延拓产出穿过 VP 的 bowtie quad，真机
   表现为"天空里长出第二个矩形"（2026-07-28 user 报）。修法：quadFromCorners 在任一角
   进 ε 带/越线时改走 chart 平面坐标（同一套 ε 规则），**越线角先垂直回缩钉在 ε 带上**
   （"读作 ε 带上的替身"；不能拿越线点直接喂饱和公式——饱和分母下分子在对侧深处可再变号，
   翻面复活）。quad 恒在起笔角的 manifold patch 内；起笔在天空侧则天空是你的 patch（对称）。
   徒手拟合走平面 chart，**ε 规则（user 设计）**：枚举 pencil 族的坐标
   （1 点透视的路宽/横向）1/w 用 max(w,ε) 饱和——过线后梯度按 1/ε 不按 1/z；枚举平行族的
   坐标（纵深）真发散、过线 clamp +BIG 不翻负（不进另一张 manifold patch）。测试案例：
   画无限长通向消失点的路——路宽由近端角点决定，远端拖过地平线路自然收敛进 VP，宽度不抖
   （远边钉在 ε 带 = 地平线下 HORIZON_EPS px）。
   chart 的射影行选取按 |ℓ| 最大分量丢弃（地平线过原点时 (x/w,y/w) 会塌线，教训）。
   70138b5 的幅值裁剪（Liang-Barsky/Bresenham 硬顶/COORD_LIMIT）只治"近地平线卡死"，
   对翻面结构性不可见（错误几何坐标全在 doc 内）——两层护栏各管各的，都要在。
   **【再修订 v0.6.23 / 2026-07-28 晚（user grill）】ε 无量纲化 + 回缩带解耦**：
   ① 绝对 px 的 ε 是错量纲——杠杆 = w0/ε 随构图无界（锚点 300px 时 2px ε = 150×，真机
   "太小"体感的根源）。ε_lat = max(2px, w0/HORIZON_LEVER=5)，无量纲杠杆封顶、构图自适应。
   ② user 重申原意：ε 只钉横向(x)；纵深(y)跑到 infinity、钉在施瓦西半径上——v0.6.18 的
   "回缩到 ε 带"把纵深也钉在带上，偏离原意。改为回缩到**发丝带 PIN=0.5px**（sub-pixel ≈
   就在地平线上），纵深 1/PIN→BIG；横向按回缩点分子在 ε_lat 下跟手。
   ③ **双 pencil 平面（二/三点地面）例外**：纵深与横向纠缠（两轴都收敛地平线），大 ε 会把
   饱和坐标对拉出 patch（p10 负坐标 toDoc null）——保持 2px 带旧行为；有平行族的模式
   （一点地面/各墙面）才享受杠杆封顶。若真机再报二点模式抖动，需要真正的射影杠杆定义再来。
4. **像素模式也透视**（user 拍板）：直线/四边形边/grid 线在 doc 空间仍是直线 → 普通
   Bresenham；**透视圆 = conic = Zingl 有理二次 Bézier 栅格化**（plotQuadRationalBezier(Seg)，
   权重从 45° 弧中点的像解析求出，零可调参数；正解，密采样折线只是护栏逃生门）。全形状
   统一 seen-set 去重（格线交叉不双叠）。VP 坐标 snap **像素中线 +0.5**（与形状端点同格系
   → VP 到端点连线斜率整数比，Bresenham 对称）。
5. **grid 笔**：第四子工具，nu×nv 平行线格（默认 2×6 = 6 头身+中线），outer border 可开关
   默认关；**+/- steppers 不弹键盘**；参考线**画在图层上**（草稿层用户自己管），不是 snap
   参考线也不是 gizmo。透视 frame 下自动成为地面格/透视墙格（原尺笔四模式的复活，免费）。
   多线一条 stroke 一条 undo（引擎多 polyline 合成）。**最小间距护栏不做**（user：护栏反而
   不可控，画完自己清理）。
6. **VP 编辑 = crop 同款半模态 transient**：DOM 手柄拖（screen 坐标，VP 常在画布外也能拖；
   pan/zoom 手柄跟随），淡地平线 + VP 圈 + **参考点射线**（数学无用、帮美工立框架；
   **只在编辑模式显示**——作画时参考线用 grid 笔落图层，形状笔无持久 gizmo 的初心不破）。
   应用=保留、取消/ctrl-z=回快照。
7. **doc 几何操作重映射**（user：小心裁剪时 VP 坐标）：裁剪/旋转 90°/水平翻转/偏移环绕
   五个 op 全过 `remapShapePersp`（doc-ops choke point），且 **persp 快照进 docTransform
   的 undo 信封**（operator 经注入回调还原，workpiece 不碰 desk）。旋转 90° 后 VP 对的
   地平线变竖直 → 自动解锁 lockHorizon。

## 弃案（别再提）

- **3D grid**（三点透视的立体格）：两个对角点拖不出来（需要第三轴输入），user 拍板手动画。
- **grid 线最小间距护栏**：护栏造成不可控。
- ~~isometric frame：排队~~ **已落地 v0.6.20 / 2026-07-28**，要点：
  - **轴固定 2:1 像素惯例**（对角 ±(2,∓1)/√5 + 竖直；有理斜率格点连线 Bresenham 对称，非 22.5°/30°）。
  - **无 VP**：PerspConfig.axes 三平行族；平行×平行无消失线 → 全管线走仿射路径**零奇点**
    （quadFromCorners 精确、chart 仿射、像素 conic g=h=0）。
  - **编辑面 = 参考 box 独任**（editorState.persp.iso.box——anchor 即 box.A，+0.5 格系与 VP
    同待遇，crop/翻转/旋转/resample 过 remapShapePersp）；C 角 2×2 解析解、D 角 = 竖直高度
    手柄，无 Gauss-Newton。lockHorizon 钮在 iso 下隐藏（无地平线）。
  - **度量 = 解析仿射**（planeMetric 的 iso 分支；经典约定视点重建对平行投影发散）：世界单位
    屏向量 对角 (±2,−1)、竖直 (0,2) → 单位立方 = 顶面菱形 4×2 + 侧高 2（sprite 恰 4×4）；
    正方/正圆下游（constrainSquareOnPlane/metricCirclePolyline）接口不变零改动。
  - 平面清单复用 ground/wallL/wallR = 顶面/左面/右面；常显 gizmo = 过锚点三轴参考线（rays 槽复活）。

## 后果

- perspective-frame.ts / pixel-conic.ts / persp-edit.ts 三个新深模块；shape-brush 引擎吃
  frame provider；`_endStroke`/stamp overlay/undo 管线零改动（多 polyline 在引擎内 merge）。
- 新图标缺口：`perspective`（透视槽）——字形「透」stopgap，登记库 TODO.md。

## 修订记录

- **2026-08-10（v0.8.29）**：§6「取消/ctrl-z=回快照」supersede——快照回滚从未实现（C4 普查
  census §7 分歧#2 上呈），user 裁决改为 **VP 编辑全量进 undo**（「persp也全量进undo吧，
  拖一次可以undo一次」）。落地 = PerspComponent.commitPreApplied：拖动期 desk 直写当 transient
  预览、pointerup 持 before 快照收口一步（重置/锁切换同为一步、整包记账）；perspEdit 的 ctrl-z
  语义 abort-transient → history（与 transform 同款——无挂起令牌的会话可逐整点回退，
  census §3.2 的结构判据）。
- 注：§7 的「persp 快照进 docTransform undo 信封」已被 ADR-0008 §4 的 PerspComponent
  升格取代（信封机制退役，remap 走组件记账）——此为落地形态更替，语义（undo 同步还原）不变。
