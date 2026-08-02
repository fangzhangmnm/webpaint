# 画布分辨率

一期硬编码 **2048×2048**。原因和坑写在这里。

## 为什么固定，为什么 2048

| 候选 | 优 | 劣 |
| - | - | - |
| 让用户开 doc 时选 | 灵活 | 一期还没 "new doc" 流程；多一个 friction step；现在重点是手感 |
| 固定 1024 | 内存小（4MB / layer）；老机器友好 | 缩放放大看糊；texture 用太小 |
| **固定 2048** | RGBA = 16MB / layer，撑得住 20 步 undo；放大到屏幕大小依然清晰；典型 Blender texture 尺寸 | 不到顶配 |
| 固定 4096 | 印刷 / 高端 texture 够用 | 64MB / layer，undo 20 步 = 1.28GB，iPad 慢机会炸 |

结论：一期 2048，到了后期加 "new doc with size" UI 时再放开。

## 性能预算（粗算）

- 一个 layer = 2048 × 2048 × 4B = **16 MB** ImageData
- undo 20 步 = **320 MB**（一期可接受；后期换 PNG 压缩或 tile-diff）
- 60 fps 渲染 = 每帧 drawImage(2048×2048) → 在 iPad 上稳，Quest 应该也行（毕竟它扛 WebXR）
- 笔刷 stamp drawImage 频率 = ~120Hz × 5 stamps/move = 600/s；预 cache stamp 让每次 drawImage 是单一 bitblt，OK

## 防止挖坑

- **doc 尺寸是 model 自己的属性**，board 和 brush 从 `doc.width / doc.height` 读。改大不需要碰渲染代码。
- **brush spacing 用 doc-px 算**，不用屏幕 px。"放大了画"和"缩小了画"密度一致。
- **input 输出 doc 坐标**给 brush；屏幕 px 只在 input 内部、board pan/zoom 内部、cursor 预览圈用。
- **save 出来的格式必须包含 width/height**。一旦持久化层介入，开个 1024×1024 的老文件不能被新版当 2048×2048 渲染。

## 后期开 size 选择 UI 时

提供几个常用预设 + 自定义。参考：
- 1024 × 1024 — 小 texture / 头像
- 2048 × 2048 — 默认 / 标准 texture
- 4096 × 4096 — 高分 texture / 印刷
- iPad 屏幕原生（2732 × 2048）— 走 Procreate 流的人会想要
- 自定义任意

需要 cap 上限（如 8192）以免有人手抖打 16384。
