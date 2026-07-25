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
   圆的像**、**grid 间距=cross-ratio 透视缩短白送**。深度缩放自由度在四角固定后不存在 →
   **平面内"正方/正圆"约束结构性不可定义**（没有度量），约束键在透视下只对 line 有意义
   （吸向 VP 的透视辅助线，多 VP 时离拖拽方向最近者胜）。
3. **地平线奇点（史瓦西 patch 类比）**：rect/grid/像素椭圆全走 doc 锚定角点+homography，
   结构性不碰奇点。徒手拟合走平面 chart，**ε 规则（user 设计）**：枚举 pencil 族的坐标
   （1 点透视的路宽/横向）1/w 用 max(w,ε) 饱和——过线后梯度按 1/ε 不按 1/z；枚举平行族的
   坐标（纵深）真发散、过线 clamp +BIG 不翻负（不进另一张 manifold patch）。测试案例：
   画无限长通向消失点的路——路宽由近端角点决定，远端拖过地平线路自然收敛进 VP，宽度不抖。
   chart 的射影行选取按 |ℓ| 最大分量丢弃（地平线过原点时 (x/w,y/w) 会塌线，教训）。
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
- **isometric frame**：不是弃案，是**排队**（experimental，2:1 像素惯例非 22.5°；等透视真机
  验过后单独 slice）。

## 后果

- perspective-frame.ts / pixel-conic.ts / persp-edit.ts 三个新深模块；shape-brush 引擎吃
  frame provider；`_endStroke`/stamp overlay/undo 管线零改动（多 polyline 在引擎内 merge）。
- 新图标缺口：`perspective`（透视槽）——字形「透」stopgap，登记库 TODO.md。
