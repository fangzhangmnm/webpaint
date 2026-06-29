# WebPaint docs

设计决策 / 人类拍板 / 学到的东西 —— 给将来的 AI 同行（和半年后的自己）。

不是教程，每条都对应这一期实际碰到 / 决定 / 还要继续追问的东西。

| 文件 | 讲什么 |
| - | - |
| [20260526-architecture.md](20260526-architecture.md) | 模块怎么切 / 数据流走向 / 一期 vs 后期的边界 |
| [20260526-canvas-resolution.md](20260526-canvas-resolution.md) | 为什么固定 2048×2048（一期），如何不挖坑 |
| [20260526-brush-v0.md](20260526-brush-v0.md) | 一期 brush engine 的"够用就行"路线，已知坑，接下来要做的 dynamics |
| [20260526-undo-strategy.md](20260526-undo-strategy.md) | 整图 ImageData 快照 vs 增量 / 压缩；为什么先选简单的 |
| [20260526-sibling-reuse.md](20260526-sibling-reuse.md) | 从 ScratchPad 等兄弟项目直接复用的东西，哪些不一样 |
| [20260526-pwa-shell.md](20260526-pwa-shell.md) | PWA 壳的几个关键点（iPad 怪癖 / 错误浮条 / 主题 guard） |
| [20260526-pwa-update-detection.md](20260526-pwa-update-detection.md) | **跨项目可拷**：PWA 更新检测必须挂的 4 条路径（iPad standalone 不主动 check SW 的解药） |

## 怎么用这个目录

- **决策**：写在这里的，下次别人/将来的我应该能据此重做出同样的选择。或者看明白为什么不该这样了，去做下一版。
- **指南**：尽量保持对应代码段的稳定 —— 如果某个文档的核心论点已经被代码淘汰了，更新 / 删除文档，不要留 zombie。
- **跨项目**：很多模式（PWA 壳、pointer 处理）是从 [`../../20260520 ScratchPad/docs/`](../../20260520%20ScratchPad/docs/) 拿来的。复用的不重写，差异的写在 `20260526-sibling-reuse.md`。
- **proposal**：`../journal/20260524 proposal.md` 是 user 的人类输入，不可写入。

## 约定

- 引用 user 决定时说"user 当时说 …"。不引用就是 AI 自己拍的，可以反复推翻。
- 一期 = 单图层、不保存、死磕手感。后期 = 图层 / 持久化 / 同步 / 选区 / 液化。
- 兄弟项目里的决策"日期越新越权威"。RealHome / JustReadBooks 的判断优先于早期项目。
