# 画师视角的功能优先级

下一个 AI / 6 个月后的自己看：**不要按工程师直觉排功能**。这份是 2026-05-27 user 把我 schooled 之后沉淀的，user 是真画过的 anime 画师 + 3D 美术。

## 跑通的绘画场景

按"实际能稳定完成某个 2D 绘画动作"算 milestone。每条 = 一个真实创作场景跑通过。

### v40 (2026-05-28)：**勾线**（对照参考描线）

User 在 iPad 上对着参考图描了一个动漫角色立绘的线稿。**第一个真正交付的 end-to-end 绘画流程**。

**Minimal set（必备，全部 ✓）**：
- 多图层 + 可见性 toggle（盖参考图、新层描线）
- 导入照片
- **稳定的笔**（streamline 0.3 默认，timeStamp 单调过滤 v26，buffer max-alpha v28，pressure-aware step v30）
- **压感**（user 标记"比想象的重要！"—— size + opacity 都开）
- 橡皮
- 持久化（IDB 自动 + Ctrl+S）
- Undo / Ctrl+Z
- Pan + zoom

**这一关跑通的意义**：WebPaint 的 "稳定基础笔" 立住了。后续加功能不会因为画一条线都画不顺而崩盘。

**补完更顺**：
- 图层 opacity slider（盖参考图时调透明度比 toggle 强）
- 笔刷平滑可调（streamline slider 而不是 hardcoded）
- 旋转画布（描某些角度时手腕不舒服）
- **Lineart 换色**（红描线 → 黑 / 棕等。alpha-lock 或图层 fx）
- 笔刷抗抖 / 抗锯齿再 polish 一档

### 下一个目标：**草稿打形**（**不是** cel shading 上色，user 2026-05-28 修正）

denoising 工作流的核心场景：从一团完全错的乱涂出发，反复大幅变形 / 重描，让形体浮现。

需要三件：
1. **Lasso + 自由变换**（must） —— 圈住歪掉的部分、整体平移 / 缩放 / 旋转 / skew
2. **液化**（extremely helpful） —— 比例 / 结构修复神器，推 / 拉 / 缩 / 旋
3. **Reference 小窗** —— 浮动窗口装一张参考图（导入文件 / 当前画布 snapshot），独立 pinch / zoom / rotate。**不**抄 Procreate 的"相机参考"风格（那个太重）

cel shading 上色是下一个之后的 milestone（需要 clipping mask）。

---

## 项目定位

WebPaint = **iPad 上的开源 Procreate clone**（standalone 2D 绘画 app）。

身份是 standalone：可以独立装、独立画、独立导出（.ora / .png / .jpg）。不依赖任何外部 host app 才能用。**功能集合的目标是高度还原 Procreate**（手感 / 工作流 / 工具集），让 Procreate 老用户无缝迁移。

### 关于 Blender / 3D 工作流

WebPaint 是 user 兄弟项目家族里的一员，家族远景是消除 Blender 贴图绘制 friction（见 `journal/<date> proposal.md`）。**但**：

- **Blender 接入靠另一个独立兄弟项目** `BlenderTextureProtocol`（Blender addon + WebRTC 桥）—— 不写进 WebPaint
- WebPaint 本身**不**做贴图专用化（不锁 4K 方形 / 不强制 PBR 通道 / ...）

不过 user 同时是 Blender 3D 美术 + 2D anime 画师 + 厚涂玩家。**这三类工作流是 user 实际场景**，所以功能优先级会被它们 inform —— 比如：tileable 模式（贴图）/ 旋转画布（厚涂）/ lasso 变换（角色立绘修脸）。**但定位仍是通用 2D**，不是 "专门做贴图"。

**比 Procreate 多一步的部分**：long-term aim 是在"Blender aware"维度上**比 Procreate 强**。例：做一个真正好用的 BodyPaint 3D 替代（接入 BlenderTextureProtocol 后，直接在 3D model 上画）。但这些是远期，**不影响 Tier 1 的 2D 基础**。

### Mental model：调整 = 从混沌到形体的迭代收敛

**这不是"画好之后磨掉小瑕疵"** —— 那是工程师对画工的误解。真实的画工是：

> **从一开始比例和结构都很不对的乱涂状态，反复用液化 / lasso 变换 / 重描，慢慢迭代到具体的形体浮现出来**。

类比 **stable diffusion 的 denoising 过程**：每一步都不要求接近最终态，只要求比上一步少一点错。轮廓在 N 次大幅变形中逐渐收敛，不是在某个时刻画对的。

这条类比解释 WebPaint Tier 1 优先级：
- **液化 + lasso + 自由变换**：核心的"denoising step" 工具。必须够廉价、够大力，鼓励用户多迭代。
- **多图层 + 高 undo 深度**：每次大变形保留备份，允许 try-and-discard cycle。
- **"形状工具" / "对称笔刷"** = anti-feature：它们假设用户能"一笔到位"，违背 denoising 心智。

**类比 Blender vertex tweak**：3D 里也是这样 —— 没人 box-modeling 一次到位，都是 sculpt + retopo + 反复改 verts 直到模型对。WebPaint 在栅格世界做同件事。但**这是类比，不是 WebPaint 的身份**。Procreate 用户也走 denoising 工作流。

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

### 调整 = WebPaint 的核心价值

WebPaint 卖的不是 "一笔到位"，而是 "**denoising-style iteration**"：从一团混乱的乱涂出发，反复大幅变形 / 重描 / 液化，让具体形体在迭代中浮现。**不是把"基本对的图"磨掉小瑕疵**，而是从"完全不对"逼近"勉强对"再逼近"对"。

让用户能廉价地大幅改动而不心疼，而不是被迫"画对一次"。

User 原话举例：

- **眼睛画歪一点点**：传统办法重画一遍永远调不完。正确方法：**lasso 圈住眼睛 → 自由变换（move/scale/rotate/skew，甚至 perspective）→ 微调到位**。
- **结构 / 比例崩**（脸偏 / 身材歪）：**液化** —— 推 / 拉 / 缩 / 旋。给比例废 / 结构废的福音。液化完之后通常需要在液化后的形上**重描一遍**清理涂抹痕迹。
- **不要的部分擦掉**：橡皮 + 选区擦。

注意"重描一遍"在每个 denoising step 都常出现 —— 所以 v40 的**稳定的笔**不光是基础功能，也是 iteration 工具链的一环。

## 正确的优先级（高 → 低）

### Tier 1：让"画→改→改→再改"成立的核心

1. ~~**多图层 + UI**~~ ✅ v34-v45 全做了（含 opacity slider / mode / rename / "⋯" 菜单）
2. ~~**持久化 + MSAL + 加密**~~ ✅ v35-v45 本地 IDB + OneDrive 都做了（加密暂未做，user 兴趣不大）
3. ~~**导入图片到图层**~~ ✅ v39 统一入口（File / 相册 / 剪贴板）
4. **Lasso + 自由变换**：套索 → move / scale / rotate / skew，进阶 perspective。**草稿打形** vertical slice 必备
5. **液化**：推 / 拉 / 缩 / 旋 brush。比例 / 结构修复神器。草稿打形必备
6. **Reference 小窗**：浮动可拖窗口装参考图（导入 / 当前画布 snapshot），独立 pinch / zoom / rotate。草稿打形必备
7. **Clipping mask（真正的）**：每个图层可以 clip 到下面那层的 alpha。喷枪 / 渐变上色用。alpha lock 不够。**cel shading 上色** 后续 slice 必备

### Tier 2：工作流润色

6. **图层透明度 + 重命名**（user 高需求 2026-05-28，勾线场景必要）：layers panel 每行加 opacity slider；双击 / 长按名字 inline edit。盖参考图描线时透明度比 toggle 强。
7. **画布旋转**（**重要**, user 标记 2026-05-28）：board.viewport 加 rotation 字段；UI 用两指旋转手势 / 工具按钮。Procreate 标配，某些角度手腕舒服度差很多。
8. **笔刷平滑参数化**（user 2026-05-28）：streamline 当前 hardcoded 0.3，加 slider 给用户调。也许 brush preset 系统时一起做。
8b. **Lineart 重新着色**（v40 勾线场景反馈）：把已有描线的颜色换成另一色（例：红描线 → 黑描线）。实现路径：
    - 简化版：图层 "alpha lock" + 全填新色（依赖 alpha-lock 概念，本来 Tier 1 #4 clipping mask 一起会涉及）
    - 终极版：图层 fx「色相 / 染色」effect 层 —— Tier 3 调整层范畴
8c. **笔刷抗抖 / 抗锯齿再升级**（v40 反馈）：现有 stamp 走 GPU bilinear，已 OK；可探索：
    - stamp 走更高 hardness 默认（更锐边）
    - sub-pixel offset jitter (4-tap supersample) 减锯齿
    - WebGL/WebGPU 加速通路（远期，brush preset 系统稳定后）
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
- **WebPaint 是通用 2D 绘画 app，不是 Blender 工具**。功能优先级按 Procreate 用户期望排，不按"对 Blender 工作流有用"排。Blender 接入是另一个独立兄弟项目 (BlenderTextureProtocol) 的事。
