# ADR-0005：形状笔 = 一个 shape 一个 stroke 的笔（supersede v120「shapes 收进笔刷 preset」+ artist-priorities「形状工具=anti-feature」）

> created 20260725
> 状态：**已决定 —— 实现中（worktree-shape-brush 分支）**

## 背景

三条旧记录都判过「形状工具」死刑或缓刑：

- `ai-docs/20260527-artist-priorities.md:75/81`：形状工具（直线/椭圆/矩形）列为 anti-feature——「完全没人用」。
- v120（index.html 注释）：撤掉当时的 shapes 工具，判「shapes toggle 放在笔刷里面」。
- `ai-docs/20260528-backlog.md`「智能形状笔」两条：Procreate 式实时手势识别 + 画完停手自动 snap。

2026-07-23/25 user 本人推翻（journal `20260723 v0.5 feedback thread.md:64-79`「smartshape方案初稿」+
2026-07-25 grill 多轮）。新使用场景：①画角色的大头圆底 ②建筑拉透视线/结构线（机械绘制）。

## 决定

1. **否决手势识别自动 snap**（长按/停手判定延迟「为了极简化和炫技而伤害用户效率和 ergonomics」）。
   机械绘制场景切换形状是**冷路径**，真正要优化的是**每种形状下的输入效率**——独立工具 + 子工具组。
2. **形状笔是笔，不是带 gizmo 的可编辑对象**（user：「笔是我们的第一公民，选区是 staff，不太需要
   其他的实体」，对标滤镜笔）。一个 shape = 一个 stroke：按下→拖动（live 预览）→抬手落像素。
   **没有** adjusting 态、手柄、确认按钮。中断（切子工具/手势接管）= cancel 不进 undo（`_abortStroke`
   既有语义）。落位 = 第四个 pixel-stroke 引擎（`engine-registry` 加一行；CONTEXT [[Engine]] 名册的
   ShapesEngine 槽位）。
3. **恒压 0.5、不记录笔压**（专注形状不控笔 = 鼠标矢量绘图体验）；**强制无视 taper**（taper 本是
   笔压修饰，笔压已禁用；机械绘制要粗细均匀）。共享 brush 笔架与当前笔（`getRackToolKey` alias）。
   曾议过的 per-brush `defaultPressure` 字段**撤案**（勘探发现鼠标主路径本就恒 0.5，字段失去动机）。
4. **子工具三件 + 一个约束钮**（约束图标按子工具换义）：
   - **直线**：起点→终点拖拽；约束 = **画布相对**角度吸附，先试 per 15°（45+30+60 备选，像素画/
     isometric 手感观察后再定）。
   - **矩形**：**视口相对** AABB 拉框（画歪的 = 转视口再画）；约束 = 屏幕系 1:1 正方。只做 AABB
     不做旋转手柄。配套：视口双指旋转松手吸附网格 90°→15°（`snapRotation`），不顺手退 45°。
   - **圆/弧**：**鼠绘一笔→拟合**（拖 AABB 画圆被否——「圆和它的 AABB 端点视觉上没有联系」）。
     拟合哲学 = **max 范数**：用户对「切线边界在哪」掌握最精确，闭合形状用视口轴 AABB 极值定椭圆
     （最小二乘 mean 平均会把边界抖糊，否决）；正圆约束半径取 max(rx,ry)。
     **弧判定 = winding number**（user 拍板）：绕圆心累计有向扫角 ≥360° 才闭合（过冲多绕 15° 没关系），
     <360° 出弧（355° 想留口子留得住）；弧的圆心用 Kasa 代数圆拟合（弧的 AABB 是半截框，中心全错——
     切线语义只对闭合成立，弧场景「精确」= 弧贴着笔迹走）。
5. **不做**：多边形（连续线段代）、透视工具（有直线就够）、纯线条填充（油漆桶代）。
6. 渲染/commit 零新管线：几何采样点列 → 私有 BrushEngine（`t=null` 走 stroke-smoother 的
   FALLBACK_DT 口子，tau=0 直通）→ 现有 GPU stamp overlay（live）→ `board.commitBrushStroke`
   （commit，live==commit 同一份 StampCollect）。pixelMode 不降级：每帧
   `restoreFromSnapshot`（tile 句柄零拷贝）+ 整条重驱动。

## 后果

- artist-priorities 的 anti-feature 判决、backlog 两条手势识别方案、v120「收进 preset」判决
  全部作废（原文就地打 superseded 标注，别再引用当依据）。
- 反面教材：旧 `src/shapes.js`（v257 删，`git show 1bc6531^:src/shapes.js`）的 ctx.fillRect
  直填路线**不复活**——不走 Engine seam、不吃笔刷、有选区 stub。
- `input._endStroke` 的 `engine === this.brush` 特判被泛化成「endStroke 返 StampCollect 即 GPU
  commit」——加第五个 stamp 引擎不再碰 input。
- 缺 4 个图标（line / snap-angle / constrain-square / constrain-circle）走 icon-missing 占位，
  登记在 `ai-docs/20260718-icon-todo.md`，进库后重跑 extract 即换真图。
