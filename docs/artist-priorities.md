# 画师视角的功能优先级

下一个 AI / 6 个月后的自己看：**不要按工程师直觉排功能**。这份是 2026-05-27 user 把我 schooled 之后沉淀的，user 是真画过的 anime 画师 + 3D 美术。

## 项目元定位

> WebPaint 是栅格化版本的 Blender vertex tweaking。

Blender 里艺术家最重的活不是 fancy geometry ops，而是手动调半天 vertex position 直到顺眼。WebPaint 对应到栅格世界：lasso + 变换 + 液化 = 在像素上 tweak 半天直到顺眼。任何让"tweak"更顺的功能就是核心，任何让 "first draft" 更顺的功能（比如形状工具）都是锦上添花，错了优先级。

## 工程师直觉的反例（我犯过的错）

- ❌ **形状工具（直线/椭圆/矩形）**：完全没人用。眼睛 ≠ 两个椭圆。画师靠手画 + stabilizer + 修，不靠 tool 出形状。顶多 Procreate 那种"长按笔画末尾自动拉直 / 拉成弧"的辅助。
- ❌ **对称镜像笔刷**：anime 不用。anime 角色基本是 3/4 视角，对称工具反而打死立体感。
- ❌ **Alpha lock 替代 clipping mask**：alpha lock 能勉强做 cel shading 平涂，但**画师真正要 clip 的是喷枪涂渐变**。alpha lock 在喷枪渐变上不等价，必须真 clipping mask。
- ❌ **用 cel-shading-single-layer 作为 MVP**：忽略了 ref 导入 / 草稿迭代 / 线稿叠层这套工作流。

## 真实工作流（user 原话整理）

### 角色立绘的迭代

```
导入参考图 / photobash → 起草稿 → 草稿 collapse 了 → 在新图层重描 → 上线稿
                                                                          → 底色（一层一色块）
                                                                          → 上 cel shading（clip 到底色）
                                                                          → 喷枪润色（clip 到底色 + 渐变）
                                                                          → 高光（clip 到底色）
```

- **草稿经常崩**，画师不会去"修"它，而是新开一层重描。所以图层多 + 容易开新层 + 容易调整透明度比较看 + 容易合并清理 = 工作流核心。
- **导入参考图**当一层用。需要可拖入 / 粘贴 → 进图层。
- **clipping mask** 是上色阶段的必备：底色之上 clip 一层喷枪渐变，渐变不会溢出底色形状。
- **混色（拉底色再吐）**是 user 描述的"找颜色"动作 —— 不是水彩物理混色，而是用画布上已有的颜色寻找下一笔的色。这条目前没做，但用 eyedropper 频繁取色也能代偿。

### 调整 = WebPaint 真正的卖点

- **眼睛画歪一点点**：传统办法重画一遍永远调不完。正确方法：**lasso 圈住眼睛 → 自由变换（move/scale/rotate/skew，甚至 perspective）→ 微调到位**。这是和 Blender vertex tweak 等价的栅格操作。
- **结构 / 比例崩**（脸偏 / 身材歪）：**液化** —— 推 / 拉 / 缩 / 旋。给比例废 / 结构废的福音。液化完之后通常需要在液化后的形上**重描一遍**清理涂抹痕迹。
- **不要的部分擦掉**：橡皮 + 选区擦。

## 正确的优先级（高 → 低）

### Tier 1：让"raster vertex tweak"成立的核心

1. **多图层 + UI**：可见 / 透明度 / 模式 / 顺序 / 重命名 / 合并 / 复制 / 删除。**必做，第一个 big move**。
2. **持久化 + MSAL + 加密**：图层做完接这条，user 才能开始真正画画（无丢稿恐惧）。**兄弟项目已经完整跑通过**（grep sibling 找具体实现，应该在 WebXiaoHeiWu / RealHome 里）—— OneDrive AppFolder + MSAL auth + 客户端加密。直接抄不要重新设计。
3. **导入图片到图层**：拖入文件 / 粘贴剪贴板 / 选文件，转成一层。photobash + ref。
4. **Clipping mask（真正的）**：每个图层可以 clip 到下面那层的 alpha。喷枪 / 渐变上色用。alpha lock 不够。
5. **Lasso + 自由变换**：套索 → move / scale / rotate / skew，进阶 perspective / mesh deform。最痛的痛点。
6. **液化**：推 / 拉 / 缩 / 旋 brush。比例 / 结构修复神器。

### Tier 2：工作流润色

6. **图层透明度 + 重命名**（user 高需求 2026-05-28）：layers panel 每行加 opacity slider；双击 / 长按名字 inline edit。
7. **画布旋转**（**重要**, user 标记 2026-05-28）：board.viewport 加 rotation 字段；UI 用两指旋转手势 / 工具按钮。Procreate 标配。
8. **笔刷平滑参数化**（user 2026-05-28）：streamline 当前 hardcoded 0.3，加 slider 给用户调。也许 brush preset 系统时一起做。
9. **长按直线 / 长按弧**（Procreate quick-assist）：笔画末尾停住 → 自动拉直 / 拉成圆弧。**不是形状工具**，是"拉直辅助"。
10. **图层模式**（multiply / overlay / screen / ...）：阴影 / 高光叠加。
11. **更多 brush preset**：硬笔 / 软喷枪 / 着色笔 / 厚涂笔，先 4-5 个够用。
12. **找颜色辅助 UI**：拉一个 "near current" 调色板 / 近色搜索（user 描述的"找颜色"动作）。
13. **剪贴板导入 / 导出** —— **v40 已做**（copy PNG / paste 进新图层在汉堡菜单）。
14. **无缝贴图模式（offset / wrap）**：tileable texture 必备。
    - offset 视图：把 doc 居中点偏移 (W/2, H/2)，让 seam 在画面中央
    - wrap 笔刷：stamp 落在边缘时同时在反面镜像画一笔（modulo wrap），缝消失
    - 低优先级（user 备注），等 cel-shading + lasso 稳了再做。

### Tier 3：兜底

15. **选区扩展操作**：羽化 / 收缩 / 膨胀 / 反选。
16. **图层蒙板**（除了 clip 还有 paint mask）。
17. **曲线 / Levels** 调整层。
18. **吸色拖动 + 放大镜**（user 提过但不急）。

## 明确不做（anti-features）

- 形状工具
- 对称镜像笔刷
- 文本工具（font subset 慢死，让 AtlasMaker 兄弟处理）
- 水彩物理混色（先用 eyedropper 代偿；如果做也是 Tier 2 的"找颜色 UI"）

## 给下个 AI 的硬约束

- **遇到"画师不就是要 XX 工具？"的直觉 — 停下来问 user**。工程师对画工的直觉错误率非常高。
- **MVP 不能只跑通"画一笔"**，必须跑通"画→改→改→再改"，那才是 WebPaint 的真问题。
- **优先级以"减少 Blender 卡顿时长"为唯一 KPI**，不要为了"功能完整度"做用不上的东西。
