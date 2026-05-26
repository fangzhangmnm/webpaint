# WebPaint

> iPad 上的轻量绘画 PWA：Procreate 手感的克隆。压感 / 自定义笔刷 / 水彩混色 / 图层 / 液化 / 选区。OneDrive 同步，飞机模式可用。

- **🔗 PWA**: https://fangzhangmnm.github.io/webpaint/
- **📦 Source**: https://github.com/fangzhangmnm/webpaint

## 状态：一期 alpha

一期目标是**死磕手感** —— 在单图层、（暂时）不保存的情况下，把以下肌肉记忆托起来：

- 动漫 lineart
- 速写毛茸茸 sketch
- 动漫上色（需要图层 → 进一期后半段）
- 贴图制作
- 厚涂

### MVP 进度

- [x] PWA 壳 + 错误浮条 + 主题
- [ ] 固定分辨率画布 + 视口 pan / zoom
- [ ] Pointer / Pen 输入（防误触、coalesced、平滑）
- [ ] 圆笔 + 压感 → 粗细 / 不透明度
- [ ] 橡皮
- [ ] 颜色 / 吸色
- [ ] 撤销 / 重做
- [ ] 笔刷预设 ×5（lineart / sketch / 水彩 / 贴图 / 厚涂）
- [ ] 图层 + 混合模式 + 蒙版
- [ ] 色彩调整 / 曲线
- [ ] 选区 + 变形
- [ ] 液化
- [ ] 本地保存 / 文件格式
- [ ] OneDrive AppFolder 同步

## 设计要点

- **离线第一**：vendor 全部本地，飞机上能画。
- **零账号也是头等公民**：不登 OneDrive 也是一个完整的画图工具，不是"降级模式"。参考 [`../docs/`](../docs/) 和 `../20260520 RealHome/docs/sync-constraints.md`。
- **触屏防误触**：见过一次 Apple Pencil 之后，本设备的 touch 永远只走 pan / pinch，不再画线。从 ScratchPad 继承。
- **手感数据层与渲染层分离**：压感开关切的是写入数据的语义，而不是渲染分支。从 ScratchPad 继承。

## 兄弟项目

| 项目 | 路径 | 关系 |
| - | - | - |
| ScratchPad | `../20260520 ScratchPad/` | 最近的兄弟。PWA 壳 / pointer / 主题 / iPad 怪癖直接复用 |
| WebXiaoHeiWu | `../20260516 WebXiaoHeiWu/` | OneDrive 同步层参考（heavy local edits + dirty tracking） |
| RealHome | `../20260520 RealHome/` | 最新跨项目约束（principles.md / sync-constraints.md） |

详见 [`docs/`](docs/)。

## 本地跑

```bash
cd "/mnt/d/JupyterLocal/20260524 WebPaint/WebPaint"
python -m http.server 8000
# http://localhost:8000/
```

`localhost` / `127.0.0.1` 上 SW 不会注册，F5 永远拉到最新代码。要测离线 / PWA 安装，用 LAN IP 或部署版本。

## 部署（计划）

GitHub Pages，纯静态，零 build。改了客户端代码 → bump [`service-worker.js`](service-worker.js) 里的 `CACHE_VERSION`。
