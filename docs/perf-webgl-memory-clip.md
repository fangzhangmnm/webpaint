# 性能 / 内存 / clip — 未来工程（WebGL + tiling）

> as-of v276 / 2026-06-14。本文是**决策 + 路线图**（why 类，耐老化）。数据来自用户 iPad mini 真机实测。
> 现状渲染管线见 `src/layer-composite.js`（统一合成器）+ `src/board.js`；提交 v274–v276。

## 真机现状（用户实测，~2K doc，二次元工作流，≈10–11 图层）
- **pan = 60fps** ✓（board 的 1:1 doc 合成缓存，命中只 1 次 blit；见 board.ensureCompositeCache）。
- **plain-layer 描边 = 60fps** ✓。
- **有 clip 蒙版时描边 ≈ 30fps** ✗ ← 本文要解决的核心。
- **11 个 plain 图层仍 60fps** → 多图层本身不掉帧 → **partial-render 复杂度确实没必要**（v275 已删 `_renderPartial` + 黑缝补丁）。
- **内存偏紧**：iPad mini ~11 层（2K）已紧。每满幅层 ≈ 2048²×4 ≈ **16.8MB**；11 层 ≈ 184MB。

## clip 为何贵（live 描边路径）
描边走 live 直接合成，每帧重合**所有**层。每层代价：
- plain 层 = 1 次 `drawImage(layer→screen)`（GPU blit，便宜）。
- clip 层 = `clearRect(tmp)+drawImage(clip→tmp)+drawImage(base→tmp, destination-in)+drawImage(tmp→screen)`
  = **3 次 doc 分辨率 canvas 操作**算 `clip∩base` 再 blit ≈ 4× plain。
- **关键浪费**：描边期间，**静态** clip 层（clip 和 base 都没在被画）也被这套 dance 每帧重算 60×/s，结果每帧相同。

## 方案权衡（已论证）
| 方案 | 结论 |
|---|---|
| **三明治**（缓存 active 上/下，每帧只合 active） | **否决**：active 上方有多个不同 blend mode 时，"above" 无法预合成一张 source-over 图（每个 blend 要真实 below+active 背景）→ 频繁回退全合，复杂度白付。用户点破。 |
| **clip 结果缓存**（缓存每个静态 clip 层的 clip∩base，每帧只 blit） | 可行：clip 层降到 ~1 drawImage = plain 代价，**原生兼容 blend mode**；epoch（wp:histchange）失效 + liveLayerId 旁路。**但加内存**（每 clip 一张缓存）→ 在内存吃紧下方向错 → 暂缓。 |
| **WebGL/WebGPU 渲染器** | **真正答案**（见下）。 |
| **tiling 稀疏分块** | **per-layer 内存的真正杠杆**（见下）。 |

## WebGL 能否优化内存？（用户问，已答）
- **per-layer 存储：无直接收益**。GPU 纹理 ≈ canvas backing（RGBA8 4 字节/px）。11 层 ≈ 184MB 两者一样。
- **辅助内存：大收益**。2D 路径要一堆额外 canvas 才快（合成缓存 16MB、clip/erase tmp、潜在 clip 缓存）。
  WebGL 在 shader 里每帧重合，**这些缓存全不需要** → 重负载下省 ~50–100MB。且 clip/blend 一次过 → 无 clip 缓存内存。
- **clip 性能：原生解决**（fragment shader 一次过 clip+blend+合成，30fps 问题消失）。
- **per-layer 内存真正的解法是 tiling**（稀疏 256² tile，只分配有画的 tile）。空层 ≈ 0 内存。Procreate 即此法。
  tiling 配 WebGL 自然，但它本身才是攻 184MB baseline 的杠杆；WebGL 单独不缩 baseline。

## 路线图（用户已记 todo，本批不碰）
1. **WebGL/WebGPU 渲染器**：clip/blend/合成进 shader → clip 60fps + 去辅助内存 + 为 tiling 铺路。
2. **tiling**：稀疏分块图层 → 攻 per-layer 内存 baseline。
- **大工程、多 session、风险在笔刷手感 path（human-pinned）**。当独立项目**认真规划**，不要 mid-stream bolt-on。
- 临时止血（若内存逼急、又不上 WebGL）：不加 clip 缓存；白边 1:1 缓存可改按需/可关；紧 bbox；压缩/限 undo。

## 引用
- 统一合成器：`src/layer-composite.js`（`compositeLayers` 已含递归组隔离 + per-level clip）。
- 1:1 合成缓存 + 内容-only 失效：`src/board.js`（`ensureCompositeCache` / `render` / `_drawDocBg`），v274–v275。
- FPS 计（防煤气灯）：设置→调试→「FPS 计」（v275）。
