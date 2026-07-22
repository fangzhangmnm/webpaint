# WebPaint 0.4 · 真机批总单（S0–S7 全部积压，一次交付）

> as-of v0.4.8 / 2026-07-22。四份来源清单的**去重合并版**，按 iPad 上一遍过的动线排序。
> 细节以来源为准：batch1 = `20260722-v04-batch1-handoff.md` §3 · S5 = `…-s5-selection-tiles.md` §3
> · S6 = `…-s6-float-workpiece.md` §4 · S7 = `…-s7-render-tree.md` §2。每条尾标出处。

## 0. 前置

- merge PR #8 → main，等 /dev/ 部署完成，**先对版本水印 = v0.4.8** 再开测（反煤气灯）。
- 报 bug 时带：水印版本 + 复现步骤 + HUD 第二行读数（如相关）+ console 有无刷屏。

## 1. 先读：这些是有意的行为变化，不是 bug

1. **transform 期间 Ctrl+Z / 手势 undo = 逐整点 history undo**（拖动→stamp→lift 逐步回退，
   undo 穿过 lift 自然退出浮层）；**取消浮层 = Esc / 取消按钮**。redo 在 transform 期间开放。
   crop / 调色 adjust 的 Ctrl+Z 仍 = 取消，没变。(S6)
2. **reject（取消浮层）= identity 写回**：stamp 保留、float 原位落回，且本身可撤销。
   ⚠ freehand/椭圆等 **AA 软边选区 lift(cut)→reject 有固有覆盖率损失**（挖洞+盖回的合成数学；
   硬边选区逐字节精确）。spec 已预认；刺眼的话是拍板项不是 bug 单。(S6)
3. **lift 即清选区**（蚂蚁线消失、取消选区按钮态变）；undo lift 选区回来；reject 后选区不回来。
   accept 后选区去留 = 现状「清」，待拍板项。(S6)
4. **subtract 减光 / 反选到全空 → 选区消失**（旧版留「隐形选区」把笔画全裁掉；新版诚实回无选区）。(S5)
5. **选区 bbox 恒紧**（旧版略大/收缩不紧/offset=整幅）。(S5)
6. lift 挖洞即标脏（保存提示比旧版来得早）；浮层期间切文档 = 直接弃浮层像素。(S6)
7. **S7 纯渲染重构，用户可见语义应零变化**——凡观感差异都值得报，尤其
   **color-dodge / color-burn / 软边淡色累积**（u8 累积器量化最可见区）。刺眼 →
   `render-tree-gl.ts` ctor `accumPrec` 一行拨回 `"f16"` 即回 v0.4.7 精度（预埋逃生门）。(S7)

## 2. 基础工具 undo/redo

- 画笔/橡皮/像素笔、液化、滤镜笔逐个：画→undo→redo；含**带选区的描边**
  （GL live 预览裁剪 + 抬笔 applyMaskPostStroke——选区外必须一像素不动）。(batch1, S5)
- 液化带选区：行为应与 v0.4.5 一致（**含 H7 旧 bug 也一致——别误报「修了」**，S8 才修）。(S5)

## 3. 图层全家（每一下都验显示即时正确 = S7 markDirty→重建）

- 新建/删除（keep-one 护栏）/**复制（验 CoW：复制后改一层另一层不动）**/向下合并/移动/
  编组解组/移入移出组/显隐/透明度滑杆/混合模式/剪裁/锁α/重命名/参考层，各自 undo/redo。(batch1, S7)
- 混合模式观感重点：dodge/burn + 半透明多层叠（见 §1.7）。(S7)

## 4. 选区全链

- 四种圈选（freehand/rect/ellipse/魔术棒）× 四种集合模式（新建/并/减/交），蚂蚁线与旧版一致
  （尤其 AA 边：椭圆边缘、魔术棒半透明停线）。(S5)
- 反选/全选/取消；减光到空 → 蚂蚁线消失 + 按钮态正确（§1.4）。(batch1, S5)
- 扩张/收缩 modal：实时预览、应用/取消、undo。(S5)
- 填充/清除、选区转新图层（复制/剪切两模式）、复制粘贴，各自 undo。(batch1, S5)

## 5. 浮层/变换整链（S6 主战场；S7 的 float pass 也走新执行器，重跑一遍）

- Ctrl+T 整链：lift→多次拖动→切模式→stamp→accept；**每一步 undo/redo**（undo 穿越 accept
  浮层带 gizmo 回来自动进 transform、undo 穿越 lift 自动退出、redo 重进）；一次 undo 回整链的
  旧预期已变为逐整点（§1.1）。(batch1, S5, S6, S7)
- Esc/取消 = reject：stamp 保留 + 原位落回；硬边选区 lift→reject 无痕；AA 软边观感（§1.2）。(S6)
- 组 lift（含隐藏叶）拖动/accept/undo；float 在各自源层 z 上方。(S6)
- Ctrl+D 复制为浮层（不挖洞）+ undo；导入图片自动进变换（**先画选区再导入**也应整层 lift）。(S6)
- 浮层期间 GL 显示：挖洞/stamp/undo stamp 立即可见，undo/redo 拖动网格跳变正确。(S6)
- 双指/三指手势 undo/redo 在浮层期间 = 逐整点。(S6)
- 浮层活动时保存/云同步/Blender 推拉的门（应先 applyPendingTransient 烤进）。(S6)

## 6. 整 doc 变换与杂项

- crop/flip/rotate/resample/offset + undo（viewport 复位、尺寸标签）；**带选区**也来一遍（快照
  clone 路径）。(batch1, S5)
- 清空图层（顶栏菜单）+ undo。(batch1)
- 颜色调整 live preview（S7 surrogate 换源路径）+ 抬手恢复；crop/adjust Ctrl+Z 仍=取消（§1.1）。(S6, S7)

## 7. 性能 / 显存（S7 主收益，盯 HUD）

HUD 第二行速查：`Np`=pass 数 · `sb`=本帧建段 · `sh`=段命中 · `!`=显存 quota 塞不下段缓存降级。

- 多层文档（10+ 层，含 clip/组）描边 fps vs v0.4.7；描边中健康形态 = **`Np` 个位数 + `sb0 shN`**
  （首帧 sbN 一次，后续全命中）。(S7)
- clip 层繁重场景（v339 的 11 层痛点）+ 液化（live-sync：每帧 sb0、只重传变更 tile）。(S7)
- pan/zoom 手感（快路径）。(S7)
- 长 session：内存/显存曲线（后台 tile 压缩、undo 配额驱逐、HUD tile 数有界、FBO 池有界、
  `!` 不常亮）；大选区反复 lift→accept→undo→redo；console 无 FR 泄漏 /
  `[tile-pool] … GC'd without release` 刷屏。(batch1, S5, S6, S7)
- 大文档（4K²）：池惰性增长（初始 16MiB 按需翻倍），不一上来占 256MiB。(S7)

## 8. 韧性 + 集成面

- 切后台再回（compactAll）+ GPU context-loss 恢复（含**带选区继续画** `_selTex` 重建）。(batch1, S5, S7)
- 加密件开/存、云同步往返、v438 旧 ORA 打开无「新版本」误报。(batch1, S7)
- 导出 ora/psd/png 不回归（仍 CPU 路径）。(S7)
- Blender 推拉贴图（replaceFromCanvas 路径）。(batch1)

## 9. 待人类拍板项（测的时候顺手感受，别当 bug 报）

① accept 后选区去留（现状=清）；② reject 在 AA 软边的覆盖率损失（§1.2）；③ 点选图层是否入 undo。(S6)
