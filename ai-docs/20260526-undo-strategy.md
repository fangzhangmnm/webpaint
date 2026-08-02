# Undo / Redo 策略

一期：**snapshot 链 + pointer**。chain[i] = 那一刻 layer 的 ImageData 全张。撤销/重做 = 移指针 + putImageData。链上限 20。

简单粗暴，能跑通，性能 OK。

> **更新 2026-05-25**：原本实现是每笔存 `{before, after}` 双份 → 20 步 = 640MB。改成链式后变成"每个状态一份"，**降到 320MB**。再压一档要走 PNG blob 或 tile diff（见下）。

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

## 数字（链式之后）

| 项 | 大小 / 数 |
| - | - |
| 一张快照 | 2048 × 2048 × 4B = **16 MB** |
| 链上限 | 20 |
| 单 entry = 一张快照 | 16 MB |
| 满链 | **320 MB** 内存 |

iPad Pro 2018+（4GB+）OK。iPad 6 (2GB) 仍可能 OOM —— 下一档要 PNG 压缩或 tile-diff。

## 链式的语义

```
chain[0]   chain[1]   chain[2]   ...   chain[k]
 (空白)     ↑ stroke1   ↑ stroke2  ↑ strokeK
            后状态       后状态     后状态
```

`undoIndex = k` 表示"现在 layer 长得是 chain[k] 那样"。
- 起手 lazy push chain[0]（layer 当前状态，通常空白）；undoIndex = 0
- 一笔结束：截掉 redo 段（`chain.length = undoIndex + 1`），push after，undoIndex++
- undo: undoIndex--, putImageData(chain[undoIndex])
- redo: undoIndex++, putImageData(chain[undoIndex])
- canUndo = undoIndex > 0
- canRedo = undoIndex < chain.length - 1
- 超出 MAX 时从队首 shift，undoIndex--


## 边界 case 已处理

- **笔画被取消（中途 touch 进来变 gesture）**：`_abortStroke()` 把 before-snapshot putImageData 回去，相当于"假装没画"，不入 undo stack。
- **clear button**：当前实现 = `doc.clearActiveLayer()` + `input.clearHistory()` —— 不进 undo（"不可撤销，烧掉" 语义）。一期可以；后期持久化引入后，clear 应该是个能撤销的操作（覆盖式 putImageData）。
- **图层切换**：每个 undo entry 里存 `layerId`，撤销时找回原 layer。一期只有一个 layer，但代码已经按多 layer 写。

## 后期升级路径

1. **PNG blob 替代 ImageData**：每 entry 内存 4-10× 缩水。代价：async；undo 体验上多个微小卡顿。
2. **Tile-diff**：每 layer 拆 256² tile，每笔后比对 dirty tile 重存。最高效，但代码量大 + 需要 hash 比较。
3. **`browser-image-compression` 库**：用 WebCodecs / OffscreenCanvas 把 ImageData 转 PNG 走 worker。要 vendor 一份。

切换时机：用户报"画几笔 iPad 卡了" / "撤销栈太浅"。
