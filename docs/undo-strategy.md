# Undo / Redo 策略

一期：**每笔前对当前 layer 做 `getImageData` 快照**，撤销时 `putImageData` 回去。stack 上限 20。

简单粗暴，能跑通，性能 OK。

## 备选方案 vs 现选

| 方案 | 描述 | 一期适用？ |
| - | - | - |
| **整图 ImageData**（现选） | 每笔前 / 后各拍一张 2048² × RGBA = 16MB；撤销 putImageData | ✅ 简单、快、no async |
| 整图 PNG blob | 每笔后 toBlob('image/png')，撤销时 createImageBitmap → drawImage | 慢得多，体积小 5-10x，async |
| Dirty rect | 算笔触 bbox，只快照那一片 | 实现复杂；笔触一旦覆盖全屏退化成整图 |
| Tile 差异 | 把 layer 切成 256² tile，只拍改过的 tile | 真正能 scale 但工程量大 |
| 重放 stroke | 存"笔画指令"，撤销时清空重放 | brush 必须是确定性的；水彩 / jitter 都破坏这点 |

一期选 ImageData 因为：
- 不阻塞（同步 API，几 ms）
- 不依赖 brush 是确定性的（水彩、jitter 等后期 dynamic 不破坏 undo）
- 单图层 + 单 doc，320MB 上限可接受

## 数字

| 项 | 大小 / 数 |
| - | - |
| 一张快照 | 2048 × 2048 × 4B = **16 MB** |
| stack 上限 | 20 |
| 单笔 entry = before + after | 32 MB |
| 满栈 | **640 MB** 内存 |

iPad Air M2+ 12-16GB 没事；iPad 第 9 代 4GB 会有压力。后期要换更省的策略。

## 边界 case 已处理

- **笔画被取消（中途 touch 进来变 gesture）**：`_abortStroke()` 把 before-snapshot putImageData 回去，相当于"假装没画"，不入 undo stack。
- **clear button**：当前实现 = `doc.clearActiveLayer()` + `input.clearHistory()` —— 不进 undo（"不可撤销，烧掉" 语义）。一期可以；后期持久化引入后，clear 应该是个能撤销的操作（覆盖式 putImageData）。
- **图层切换**：每个 undo entry 里存 `layerId`，撤销时找回原 layer。一期只有一个 layer，但代码已经按多 layer 写。

## 后期升级路径

1. **PNG blob 替代 ImageData**：每 entry 内存 4-10× 缩水。代价：async；undo 体验上多个微小卡顿。
2. **Tile-diff**：每 layer 拆 256² tile，每笔后比对 dirty tile 重存。最高效，但代码量大 + 需要 hash 比较。
3. **`browser-image-compression` 库**：用 WebCodecs / OffscreenCanvas 把 ImageData 转 PNG 走 worker。要 vendor 一份。

切换时机：用户报"画几笔 iPad 卡了" / "撤销栈太浅"。
