# frontend toolkit .h —— 可移植 UX 器官清单（第二份接口）

> as-of v0.8.38 / 2026-08-10。性质：提案 §3 点名的「frontend toolkit .h」——**策展索引，不是生成物**。
> 签名真值 = `api/src/*.d.ts`（tsc 生成，随发版 ritual 重打）；本表只答「哪些模块是可搬的器官、
> 各自管什么、还欠什么迁移」。签名与本表冲突时**信 api/**。
>
> 用途（提案原话）：高中生接新平台时，输入映射自己写，难的 UX 数学从这里搬。
> 物理搬家（`src/frontend/toolkit/` 落户、`_emit` 换回调）不在 C7 范围——排 UI 骑士 / E 骑士。

## 一、器官（DOM-free 或近 DOM-free 的 UX 数学；按「接新平台会先要哪个」排序）

| 模块 | 管什么 | 关键入口（详 api/src/…d.ts） | DOM 现状 |
|---|---|---|---|
| `edit-mode.ts` | 独占编辑状态机（工具/transient 相位、canDraw fail-safe、ctrl-z 路由）——§6.2 裁定归 frontend | `EditMode`：`current()/set()/enterTransient()/applyPendingTransient()/hasPendingTransient()` | 唯 `_emit`（window.dispatchEvent）；换回调后零 DOM |
| `pointer-gesture.ts` | 手势升级判定（tap/hold/drag 阈值、多指仲裁、掌触防误） | `PointerGesture` 状态机 | 零 DOM（吃 (x,y,t,type) 事件流） |
| `floating-transform.ts` | 自由变换交互状态机（mesh 四角、homography 闭式解、拖动会话=beginDrag 快照绝对重解、整数刚体快路判定） | `FloatingTransform`：`lift/beginDrag/endDrag/rotate90CCW/flipHorizontal/resetToCenterOriginal/commit/reject` | 零 DOM（gizmo 画法归壳） |
| `stroke-input-smooth.ts` | 笔迹输入平滑管线的 frontend 侧配置/组装（引擎侧 StrokeSmoother/PressureLPF 已迁 backend，C5） | `SMOOTH` 调参束 + 组装函数 | 零 DOM |
| `shape-geometry.ts` | 形状笔几何本体（rect/圆拟合、约束、grid 排布；视口相对几何吃注入的 rot） | 见 api（纯函数群） | 零 DOM |
| `perspective-frame.ts` | 透视 frame（VP0-3、两角定形 homography、ε 护栏、地平线防 bowtie） | 见 api | 零 DOM |
| `crop-geometry.ts` | 裁剪框交互数学（handle 拖拽→rect 约束） | 见 api | 零 DOM |
| `ui/drag-value.ts` | 拖动取值深模块（相对增量、灵敏度分段、双击复位——v0.7.8） | `DragValue` | 薄 DOM 绑定可剥 |
| `ui/ramp-slider.ts` | 分段响应滑条（v0.7.8/v0.7.21 批） | `RampSlider` | 薄 DOM 绑定可剥 |
| `ui/input-sense.ts` | 输入感知（笔/触/鼠分型，压感有无） | 见 api | 近零 DOM |
| `marching-ants.ts` | 蚂蚁线轮廓提取数学（选区 → 走线段集） | 见 api | 渲染在壳（2d overlay 属壳域合法名单），提取数学可搬 |

## 二、明确不进 toolkit 的（别搬）

- `anchored-popup.ts` / `sheets.ts` / `transient-panels.ts` / `panel-state.ts`——DOM 编排本体，壳资产。
- `pixel-conic.ts`——算法本体，欠账迁 `backend/algorithms/`（被 perspective-frame/shape-geometry 拆分拖住，C3 挂账在案）。
- `lasso.ts` 余下的选区手势编排——E/UI 骑士拆（魔棒内核已析出 `backend/algorithms/magic-wand.ts`）。

## 三、契约备注

- toolkit 是**可选器官清单**，不进 backend interface（提案 §3：两份接口各管各的墙）。
- 器官的纪律：零 store 知识、零 workpiece 令牌知识（终值经调用方走 backend verbs / StrokeSession）。
