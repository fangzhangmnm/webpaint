# Engineering Roadmap

> 工程视角的"未来要做"——区别于 [20260527-artist-priorities.md](20260527-artist-priorities.md)（艺术家视角）。
> 这里放：性能、技术债、平台升级、架构演进。

## WebGL 渲染通路

**为什么需要**：Canvas 2D `drawImage` 本质是 affine 变换。要做以下任何一件都得 WebGL：

- 真正 C2 连续的网格变形（warp 模式 per-pixel inverse Catmull-Rom 在 CPU 太慢）
- 真正透视正确的 distort（CPU per-pixel homography 50ms / 帧勉强，GPU < 1ms）
- 大分辨率液化 / brush stamp 实时渲染（4K 画布 + 大笔半径 → CPU 跑不动）

**当前状态**：所有路径都用 Canvas 2D + 密集三角化做近似。透视和 warp 视觉上有 PS1 artifact /
C0 折角。User 反馈接受 v1 native JS 实现，但终极目标是 WebGL。

**实现方案草稿**：
1. 离屏 WebGL canvas（独立 context）
2. 一个 vertex shader：接收 mesh 顶点 + 源纹理坐标，输出 dst 位置
3. 一个 fragment shader：透视正确的纹理采样（GPU 默认就做对）
4. 渲染完后 `gl.readPixels` 或 `transferToImageBitmap` → drawImage 回主 2D canvas
5. 仅用于：lasso transform / liquify big radius / 大画布渲染。其他路径（笔刷 stamp / 图层
   合成）保留 2D 实现，避免完全重写

**注意点**：
- WebGL context 创建 / 销毁有开销，要持久化一个共享 instance
- `readPixels` 同步阻塞，慢；用 `transferToImageBitmap` + `drawImage` 更顺
- 大分辨率纹理上传成本：layer.canvas → GPU 纹理每次都传？还是缓存 + invalidation？
- iPad WebGL 2.0 支持基本可用；WebGPU 在 iOS 18+ 才稳，暂不考虑

**预期效果**：
- distort / warp 完全无 artifact
- 大笔液化拖动 60 fps
- 4K 画布无压力

**优先级**：在 user 真正抱怨当前 Canvas 2D 精度 / 性能不够之前不开工。架构改动大，风险高，
不应该提前优化。当前 v1 native JS 实现优先稳定 + 验证用户路径。

## 其他工程项

### per-pixel inverse mapping for distort / warp（v62+ 计划）

短期内不上 WebGL 的替代：CPU per-pixel inverse map + bilinear sample。

- **distort**：inverse homography（闭式解，约 15 ops / pixel）。500×500 ≈ 50ms / 帧。preview
  可接受
- **warp commit**：inverse Catmull-Rom 走 Newton 迭代 5 步，约 50 ops / pixel × 5 = 250 ops。
  500×500 ≈ 250ms。**仅 commit 用**（一次性）
- **warp preview**：forward map + bilinear splat（src → dst 各像素写 4 邻居）+ hole-fill pass。
  约 20 ops / pixel + 后处理。500×500 ≈ 50-80ms

User 接受 preview 慢一点（液化都是 31K ops × 多 event 也是这样跑）。

### 离屏 canvas 复用池

board.js 当前对 erase 合成有一个 `_eraseComposite` 缓存。未来如果增加更多 offscreen compose
路径（active layer with floating / per-pixel warp 输出 / etc），考虑统一池子，按 size 复用。
避免每帧 new Canvas。

### IDB 配额监控

当前底栏显示 `本地占用：X / 配额 Y`。Y 是 navigator.storage.estimate().quota，iOS Safari
给到几十 GB 看起来唬人。如果实际用户写到 quota 80%+，要：
- 弹警告
- 触发一次 listSessions 提示哪些可以"卸载本地"
- 极端情况：写失败时优雅降级（保留内存版本 + 提示用户）

当前没实现配额告警。低优先级。

### 笔刷边缘 antialiasing（user 2026-05-28 暂存）

user 注意到线条边缘有"狗牙"（aliasing）。待研究 Procreate 怎么处理 brush edge AA 后决定要不要做。
当前 stamp 在 GPU 通过 drawImage 走 bilinear，边缘已经有一定柔化；要更软的需要：
- stamp 更高 hardness 默认（更锐边但更可靠的形状）
- subpixel offset jitter (4-tap supersample)
- 或上 WebGL 走 fragment shader 真做 supersampling

参考 docs/20260527-artist-priorities.md Tier 2 #8c 已有类似条目（笔刷抗抖 / 抗锯齿再升级）。

### 笔刷预设序列化格式

未来加 brush presets（Tier 2 #11）时，要决定：
- 单 preset 存哪？localStorage / IDB / .ora 内 / 单独的 .wppreset 文件
- 跨设备同步走 OneDrive 还是各自管
- 用户能否分享 preset？格式要不要 publishable spec

提前想清楚省后期改 schema 痛苦。
