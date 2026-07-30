# 线稿填色：论文分区管线 + 魔棒「线稿闭合」算法 + drag 连续选

> as-of worktree-lineart-fill（基 v0.7.0）/ 2026-07-30
> 论文：`paper_references/Revoy A Fast and Efficient Semi-guided Algorithm for Flat Coloring Line-arts.pdf`
> （Fourey–Tschumperlé–Revoy 2018，G'MIC "Smart coloring" 同源）

## 要解决什么（user vision，journal/20260730）

1. 油漆桶的体验（color book 式一个一个点/拖着填），**不要**全局 scribble 一次跑。
2. 线稿不用完美闭合。
3. 无缝融入魔术棒：算法只是魔棒的一个 option，交互同构（tap → Selection）。
4. 未来可挂更多算法（贵的/便宜的/AI），下拉框选。

## 架构：两段式 region oracle

一切算法共用一个形状——**prepare（贵，per 层缓存）+ query（贱，per tap）**：

- 经典 flood：prepare=无，query=`floodSelectFrom`（原样未动）。
- 论文法：prepare=整层分析→**label map**（每像素属于哪个闭合区域），query=查表。
- 将来 SAM 类 AI 也是这个形状（图像 embedding 一次 + per-click decoder）。

ADR-0004 不动：**任何算法只产 `Selection`**，fill 仍是选区消费视图，auto-expand /
setOp 合并 / GPU 填色预览全部共用原路。

## 模块地图

```
src/lineart/            纯数学深模块（无 DOM，node 直测；论文 §→文件）
  edt.ts                Meijster 精确 EDT 距离平方（§3 笔画宽度估计用）
  border.ts             边界参数化（Fig 3 墙随器）+ 高斯平滑法线（式1）
                        + 曲率（式2）+ 端点检测（§4）
  closing.ts            质量因子 ω 配对（式6）→ Hermite 样条桥（§5.1）
                        + 直线段补漏（§5.2）；τ 相交测试（Def 6）+ amin 面积守卫（§5.1.5）
  partition.ts          总管线：二值化→半宽估计/腐蚀→闭合→背景 4 连通 label（§6.1）
                        →多源 BFS 洋葱剥皮把 label 推到线下 + regionMaskAt 查询
src/lineart-oracle.ts   app 接缝：按 (layer.id, contentRev, doc 尺寸) 缓存分区；
                        tap → regionMaskAt → Selection.fromGray8Region
src/lasso.ts            setMagicAlgorithm("classic"|"lineart") 在 _magicWandToSelection 分叉；
                        magic-drag 会话（beginMagicDrag/magicDragStep/End/Cancel）
src/doc.ts              Layer.contentRev（_invalidate 汇拢点 bump——所有像素写路径必经）
src/input.ts            magic 子工具 tap→drag 升级（8 screen-px 阈值，v134 同款）
src/toolbar.ts          魔棒算法文字下拉 #lassoAlgoSel（transform 采样 lassoSampleSel 同款；
                        选项 SSoT = lasso.ts MAGIC_ALGORITHMS，magic 子工具时显）
```

测试：`test/lineart-partition.test.mjs`（14）/ `test/lineart-oracle.test.mjs`（4）/
`test/magic-drag.test.mjs`（4）。合成图形全静态验证（断口圆、缺口框、粗笔画、竖条色块）。

## 与论文的已知偏差（都有意为之，注释里也有记）

- **曲率符号**：式 (2) 写 `det(ñ_{i+1}, ñ_{i-1})`，在我们的顺时针走向下凸处为负；
  实现取 `det(ñ_{i-1}, ñ_{i+1})` 使「凸=正」，语义与论文一致。测试守着。
- **watershed**：论文用精确 EDT 优先级的 watershed 洋葱剥皮；实现用**多源 BFS**
  （城市距离逐层，FIFO 确定性）。差异只在斜向线条中线一两个像素的归属，肉眼无感。
- **腐蚀半径封顶 4**：论文按半宽自动腐蚀到几 px；细线混粗笔的图里无脑腐蚀会把细线
  整段蒸发，封顶是保守化。半宽 ≤3 不腐蚀。
- **二值化**：合成到白底的亮度 ≤ θ(默认128) 判笔画，透明=白。彩色浅线稿（如浅蓝
  线）会漏判——将来可加「按 alpha 二值化」变体。
- 论文没给默认参数数值；`DEFAULT_LINEART_PARAMS`（θκ=0.18、dmax=64、amin=32、
  smax=48、cmax=2、L=5、ρ=1、α=90°）是按论文精神在合成测试图上调定的。

## 性能（已实测，别嘴测）

2048²、64 个断口圆 + 2 整宽横线的合成线稿：**build 722ms**（node，WSL）；后续 tap
= 查表 + bbox mask 拷贝，ms 级。首 tap 同步构建（一次性卡顿），层一动 contentRev
失效重建。**worker 化后置**——真机若嫌卡再做。

## drag 连续选（与算法正交）

magic 不再 tap-only：超 8 screen-px 升级 magic-drag 会话，沿路径逐点查询并按当前
布尔模式并进（subtract 拖 = 连续挖）。省钱关键：**采样点已被本笔累积盖住即跳过**
——拖动大多数点免查询。预览直写 doc.selection（不进 undo），收笔一条 entry
（一笔一整点），双指手势/pointercancel 走 cancelDrawing→magicDragCancel 无痕还原。

## 缓存与持久化（user 拍板 2026-07-30）

- **cache = 纯 RAM**（LassoEngine._lineartOracle 单条），关页即没、下次重算；
  不进 editorState、不跟 ora 走。换文档 setDoc 顺手 invalidate（腾 16MB）。
- **算法选择同 transform 采样模式**：RAM-only 文字下拉，不持久化。
- 失效判据 = `Layer.contentRev`：**全局单调计数器**取号（构造+每次 _invalidate 换号）。
  为什么不是 per-layer 自增：删层→undo 恢复保留同一 layer id、per-layer rev 从头数，
  (id,rev) 可能撞上旧缓存 → 全局取号让 (id,rev) 永不复用。

## 悬而未决（下一个 AI / 下一轮）

- trapped-ball 搁置：user 网页端讨论过、实现要鸡尾酒，等 user 整理讨论结果；
  下拉 SSoT（MAGIC_ALGORITHMS）已留好插槽，EDT-Dijkstra / AI 同理。
- 阈值滑条在 lineart 模式下无效（它是 flood 的容差）——现在还显示着，要不要藏/换成
  二值化 θ 滑条待 user 拍板。
- dmax（最大闭合距离）要不要暴露成旋钮：默认 64px，真机手感说了算。
- worker 化：真机首 tap 嫌卡再做。
