# 3D Bodypaint —— 纹理空间绘制设计（gather 骨架）

> as-of v351 / 2026-06-28。**why + 原理 + 架构草案**（耐老化）。写在做 #5 GPU warp 时，作为后续 3D bodypaint 的设计底稿。
> 尚未实现；这是地基论证 + 落地方案，真要做时从这里出发。核心结论：**2D 自由变换 GPU warp 和 3D bodypaint 是同一个 gather 骨架**，先把 2D warp 在 GPU 跑通就是 3D 的地基。

---

## 0. 一句话

> 在视口（屏幕空间）画到一张 **stroke buffer**；落 layer 时，**在纹理（UV）空间 render 一遍模型**，每个 texel 算出自己投影到屏幕的坐标，去 sample stroke buffer。**不**预烘 UV→屏幕的 LUT —— 每次 commit 现算（相机/模型矩阵每帧都可能变）。

这叫 **texture-space painting**（纹理空间绘制 / texel-space gather）。Blender 的 "Texture Paint"、Substance、Mari 都是这套的变体。

---

## 1. 为什么是 gather（texel→屏幕），不是 scatter（屏幕→texel）

两种方向（同 [[perf-webgl-memory-clip]] 里 2D warp 的 scatter/gather 论证）：

- **Scatter（屏幕空间刷，Procreate 式）**：遍历屏幕上笔刷盖住的像素，每个反查 UV，写进纹理。
  - 问题①**缝/洞**：UV 拉伸处屏幕一个像素 ↔ 纹理一片，写不满 → 纹理上出现没刷到的洞、UV island 边界漏白。
  - 问题②**画穿**：屏幕像素同时盖住正面和背面 texel，分不清 → 漏到背面（Procreate 的经典毛病）。

- **Gather（纹理空间刷，本设计）**：遍历**纹理的每个 texel**，每个算「我投到屏幕哪？那里有笔吗？可见吗？」。
  - 每个 texel **恰好处理一次** → 无缝、无洞、UV island 内部填满。
  - 可见性靠 texel **自己**做深度测试（下面 §3）→ 不画穿。

**和 2D 自由变换 warp 同构**：2D 是「每个 dst 像素用 `H⁻¹` 反算回源纹理 (u,v) 采样」；3D 是「每个 texel 用相机投影算出屏幕坐标采样 stroke buffer」。骨架都是 **逐目标单元 → 逆映射回源 → 采样**。区别只在逆映射用什么（单应性 vs 相机投影）+ 3D 多一个深度测试。

---

## 2. 两个 pass

### Pass A —— 画（屏幕空间，live、要跟手）
- 模型照常渲到屏幕（带 depth buffer，§3 要用）。
- 笔触累积进一张 **screen-space stroke buffer**（RGBA，doc 像 2D 的 GPU stamp overlay，只是在屏幕分辨率）。
- live 预览 = 屏幕上把 stroke buffer 叠在渲染好的模型上（响应快，不碰纹理）。手感和 2D 笔刷共用同一套 `collectStamps`→GPU 栅格。

### Pass B —— 落 layer（纹理空间，commit 时烤）
**关键 trick：把 UV 当 clip-space 位置来 render。**
- 顶点 shader：`gl_Position = vec4(UV * 2 - 1, 0, 1)` —— 用每个顶点的 **UV** 当输出位置 → 三角形被光栅化到**纹理图集**上（而不是屏幕）。渲染目标 = 纹理 layer 的 FBO。
- 顶点同时把 **world position**（和 normal）插值传给 fragment。
- fragment（= 一个 texel）：
  1. 取插值后的 world pos `P`、normal `N`。
  2. 投影到屏幕：`clip = proj · view · P`；`screenUV = clip.xy/clip.w * 0.5 + 0.5`；`projDepth = clip.z/clip.w`。
  3. **深度测试**（§3）：sample Pass A 的 depth buffer @ screenUV，对比 projDepth → 可见才继续。
  4. **背面/掠射剔除**（可选）：`dot(N, viewDir)` 太小 → 跳过（防边缘脏 + 掠射拉伸）。
  5. 可见 → `sample stroke buffer @ screenUV`，按笔刷 alpha 合进该 texel（mode/lockAlpha 走和 2D 一样的合成）。

落 layer 走纹理 layer 的 `editRegion`/tile（和 2D commit 同接缝），不破红线。

---

## 3. 深度测试（不画穿的核心）

texel 投到屏幕后，那个屏幕位置可能是模型**正面**（该 texel 可见）也可能被它**自己/别的面挡住**（该 texel 在背面）。判据：

```
sceneDepth = texture(u_depth, screenUV).r   // Pass A 渲的深度
visible = abs(projDepth - sceneDepth) < bias // texel 自己的深度 ≈ 屏幕那点的深度 → 它就是最前面那个
```

- `bias` 防 z-fighting（深度精度 + 曲面）。太小漏刷、太大画穿，要调（曲率/距离自适应更稳）。
- 这一步就是 Procreate 没做、导致画穿的那步。

---

## 4. footprint / 缩小（aliasing，同 2D 的 minification）

一个 texel 投到屏幕的 footprint 不是一个像素：
- 远处/小 UV 密度 → 多个 texel 挤进一个屏幕像素（放大 stroke buffer，bilinear/bicubic 够）。
- 近处/斜面 → 一个 texel 盖住屏幕一大片（**缩小** → 点采样会 alias/摩尔/沸腾）。

→ stroke buffer 采样**同样要 mipmap / 各向异性**（和 [[perf-webgl-memory-clip]] / 2D warp 的 minification 一回事，不是新问题）。另外纹理空间这边还要 **UV 缝膨胀（seam dilation）**：把刷到的颜色沿 UV island 边界外扩几像素，否则 mipmap/双线性在缝处采到空背景 → 渲染时缝隙漏底色。

---

## 5. 和 2D GPU warp（#5）的复用关系

| | 2D 自由变换 warp | 3D bodypaint |
|---|---|---|
| 目标单元 | dst doc 像素 | 纹理 texel |
| 逆映射 | 单应性 `H⁻¹`（mat3 uniform） | 相机投影 `proj·view·model`（+ world pos 顶点属性） |
| 源采样 | 源纹理 (u,v) | 屏幕 stroke buffer (screenUV) |
| 可见性 | 落 [0,1]² 即可 | **深度测试**（+ 背面剔除） |
| 缩小 | mip/aniso 源纹理 | mip/aniso stroke buffer + UV 缝膨胀 |
| 采样质量 | 手写 bicubic | 同一套手写采样可复用 |

**结论**：#5 做的「逐 dst 像素逆映射 gather + 手写 bicubic 采样 + GPU 栅格管线」直接复用。3D 时把逆映射换成相机投影、加深度测试、源换成 stroke buffer。**先做 2D warp = 给 3D 打地基**，不是绕路。

---

## 6. 落地顺序（真要做时）

1. 模型 + 相机 viewport（glTF/obj 载入、轨道相机），Pass A 渲模型到屏幕 + depth。
2. 屏幕 stroke buffer + live 叠加预览（复用 2D 笔刷栅格）。
3. Pass B 纹理空间 bake（UV-as-position + world pos 投影 + 深度测试），落纹理 layer。
4. seam dilation + stroke buffer mip/aniso。
5. 手感/性能调（bias 自适应、背面 falloff、笔刷沿表面而非屏幕的尺寸）。

## 7. 开放问题（留给那时的自己）
- depth bias 怎么自适应（曲率 × 距离）才不漏不穿。
- stroke buffer 该屏幕分辨率还是更高（超采样防缝）。
- 笔刷尺寸定义：屏幕恒定 px，还是沿表面恒定（透视下哪个更顺手）—— 大概率要表面恒定，靠 footprint 反推。
- 多 UDIM / 多 texture island 的 atlas 管理。
- 和现有 tiling 存储（[[perf-webgl-memory-clip]]）怎么对接：纹理 layer 也是 tile 化的，Pass B 写哪些 tile 按笔刷屏幕 footprint 反投影圈定。

---

参考：[[perf-webgl-memory-clip]]（2D WebGL 合成/warp 主文档）、`src/floating-transform.ts`（2D warp 的 CPU 原型 + #5 GPU 化）、`src/gl/gl-stamp.ts`（笔刷 GPU 栅格，screen stroke buffer 复用）。
