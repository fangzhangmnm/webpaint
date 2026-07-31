# 同色全图（similar）——魔棒第三算法模式 + OKLab 颜色度量

> as-of v0.7.21 / 2026-07-30

## 是什么

`MAGIC_ALGORITHMS` 第三项 `similar`（zh「全图同色」）：**魔术棒但不要求连通**——tap 一个颜色，
全 doc 相似像素入选。用途 = 批量改色：fill 工具里选 similar → tap → 现有 fill 预览直接显示新色 →
调色（可撤销）→ ✓ commit。零新工具、零新管线（ADR-0004 fill=选区消费视图的红利）。
lasso 侧魔棒自动获得同一算法（共用 SSoT）；magic-drag 按住拖 = 一笔批量选多个颜色。

## 设计论证要点（journal/20260730 v0.7 feedback thread.md:116,127 的三问）

1. **科学梯子**（论证见 2026-07-30 会话）：v1 = 全局阈值 + OKLab 感知距离（本次落地）。
   往上还有：聚类裁决（k-means 决策边界代替绝对半径，`color-cluster.ts` 轮子现成，候选第二轮）、
   palette 分解保明暗改色（Chang 2015 / Tan RGBXY 2018，输出天生连续权重，属将来「保明暗 commit 算子」）。
   user 拍板：**local + user adjust 优先于 global smart but rigid** → 阈值滑条路线，不上聚类档。
2. **不引入软选区**：Selection 恒二值 0/255（user 2026-07-29 不变量不动）。批量改色需要软权重的
   两处（AA 白边解混、保明暗偏移）都属于**将来 commit 算子内部**的每像素权重——算完即弃，
   不落 doc.selection。穷人版防白边 = similar 也吃 auto-expand（选完扩 1px 盖住 AA 环再填）。
3. **颜色替换就是选区**（不是独立工具），位置在油漆桶大工具栏（user 指定）。

## 度量（color-dist.ts，新深模块）

- `makeSeedDist(metric, seed…) → (r,g,b,a) → [0,1]`：flood barrier / similar 纳入共用判据。
- `"oklab"`（**统一默认**，user 拍板）：ΔE 欧氏（Ottosson 2020；sRGB→linear 用 256 项 LUT，
  8-bit 输入下精确）。ΔE clamp 1 保「容差拉满全放行」；α 不进 Lab，独立通道取 max（对齐经典语义）。
- `"rgb"`：v242 经典逐通道 max（含 α），像素画直觉。扳手「色差」行可切，per-doc 持久化。
- `srgbToOklab` 从 color-name.ts 收拢至此（色名 nearest 共用一份，行为不变）。
- 淡色（二次元肤/发/衣）：差异集中在微小 a/b，滑条低端一格 = ΔE 0.01，够分辨；
  真极限 = 种子自身明暗散布 > 与邻色距离时无阈值可分（聚类档才能解），平涂场景罕见，
  兜底 = magic-drag 多点加选。

## 内核与 UI

- `similarSelectFrom()`（lasso.ts 尾）：与 `floodSelectFrom` 逐字对齐的语义（整 doc 迭代、
  bbox 外=透明、出界 null、二值 Selection），O(N) 单遍扫、无 prepare 缓存。
  `floodSelectFrom` 第 5 参 `metric` 缺省 `"rgb"`（旧测试/调用原样）。
- 容差**外提 Row1 内联**（user：值要一直看得见，不折扳手）：`#lassoTolWrap`，classic/similar 显、
  lineart 藏；值按当前算法路由 `magicWand.threshold` / `magicWand.similarThreshold`（**分开存**，
  两种手感互调不打架；per-doc 持久化，v0.7.21 user 拍板）。
- 扳手：classic 容差行退役 → 「色差 OKLab|RGB」行（classic/similar 共用；lineart 行不变）。

## 悬而未决（下一轮候选）

- 保明暗/防白边 commit 算子（op 内软权重 + 预览纹理泛化——预览必须与 commit 一致，防谎报）。
- 聚类档（同模式智能形态，k 旋钮；复用 color-cluster 但距离空间要换 OKLab）。
- similar 全图扫的 worker 化（4MP OKLab 全扫 ~百 ms 级；目前同步，真机手感待验）。
