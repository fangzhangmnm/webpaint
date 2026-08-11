# 真机批总单（0.8 维稳批 · 一次交付）

> as-of v0.8.48 / 2026-08-10。**上机先对水印 = v0.8.48**（不对先别测，反煤气灯）。
> 归并来源：workpiece v2 handoff §4（24 条底账 = epoch §7 遗留 12 + v2 新锚 10 + B 骑士 2）
> + C 批各片追加锚（C handoff §4 逐片摘录）。「我只测一次。就是交付」——过/挂逐条记，
> 挂的报现象即可（版本水印+复现步骤），修走 0.8.x patch。
> 维稳批终点 = 本单过完 + §F「一张画跑通」= 0.8 win condition，然后才谈 bump 0.9。

## A. C9 参考窗（置顶：webcomponent 新技术首次上真机）

> user:「这次因为用了webcomponent这个新技术，我也不知道是什么样，所以反而需要测试」。
> shadow DOM 事件所有权 / 图标烤入 shadow / wp:modechange 桥全是第一次见真机。

- [ ] A1 开窗/关窗/拖窗；关窗重开位置与视口记忆还在；换 doc 恢复各自状态；gallery 模式下隐藏。
- [ ] A2 载图（含 >2048 大图导入缩存）；双击适应；wheel 缩放；双指 pinch 缩放+旋转；touch 右下角 resize。
- [ ] A3 live 镜像跟笔（画布画一笔参考窗跟着动）。已知偏差（预期内，非 bug）：液化/形状笔像素模式**描边中**镜像显笔前内容、抬笔跟上。
- [ ] A4 吸管吸色 + 长按吸色（十字光标三连：按下出现/移动跟随/抬起取色）；吸完色板与笔刷色正确。
- [ ] A5 i18n 四语 tooltip/文案抽查（含「吸色中」提示，原硬编码中文已迁 i18n）。

## B. workpiece v2 新锚 10 条（undo 栈/组件/GL 换心后行为验证）

- [ ] B1 基本手感：连笔画→每笔一个 undo 整点→undo/redo 无卡顿无红 banner。
- [ ] B2 dirty 真值表：画→存（clean）→再画（dirty）→undo 回存档点 = **save 按钮回 clean**。
- [ ] B3 结构操作各一发：加层/复制/删层/移层/合组/解组/mergeDown/explode/stampAll → 各一步 undo+redo，面板与画面一致。
- [ ] B4 doc 几何：crop/resample/flip/rot90/offset → undo 逐字节回原；带 VP 的画 crop 后透视不错位。
- [ ] B5 fill 预览色板：进 fill 调色/吸管/色词 → 改 pending 色、**笔刷色不动**；commit 一步 undo；undo 后色板跟着回滚。
- [ ] B6 float：组上 lift（含隐藏叶）→变换→accept/undo；reject 无痕；变换后源层像素归位。
- [ ] B7 选区：lasso/魔棒/选区笔 + undo/redo + Ctrl+D；选区跨 crop/resample 存活。
- [ ] B8 配额驱逐：大文档反复大笔涂抹顶满 undo 配额 → 继续画不崩、内存不涨。
- [ ] B9 存量兼容：旧 .ora（旧轨 state.json）打开——eraser/filterBrush/selPen dial、palette、blender 设置还在；保存走新轨，再开不丢。
- [ ] B10 换文档：图库切画/新建/revert → undo 栈清空、无跨文档残留、无泄漏红 banner；GL 无串 tile/闪烁。

## C. v0.7.35-41 遗留 12 条（epoch handoff §7 照录）

- [ ] C1 导入大图→transform→commit→**一次 undo 整个导入消失**→redo 全回放，无红 banner。
- [ ] C2 导入后移层/合并再跨树 undo/redo，历史存活。
- [ ] C3 Blender 拉贴图 undo/redo（无环境跳过）。
- [ ] C4 显存压力下（大文档反复开关图层）缩放平移无 256px 串 tile。
- [ ] C5 doc A 导出单层→同尺寸 doc B 导入逐像素归位；更大居中；更小走 sheet。
- [ ] C6 复位钮：任意缩放旋转后→原尺寸+居中+锐利，commit 与原像素一致；undo 一步回复位前。
- [ ] C7 从图层建选区：普通层/空层提示/组与隐藏层拒绝；lasso 与 fill 两菜单入口。
- [ ] C8 选区→送入填色：进 fill 保选区；classic+union 下选区当墙且选区内种子能填；退出再进照旧清。
- [ ] C9 fill 布尔单击 toggle（无菜单无三角，title 显当前态）；lasso 与其余 3 槽行为不变。
- [ ] C10 Row1 同槽互斥钮（无选区=全选/有选区=反选）；Ctrl+A / Ctrl+Shift+I；⋯ 菜单旧项消失。
- [ ] C11 蚂蚁线：新 doc 双默认开；selection/fill 各自独立开关、per-doc 持久；老 doc fill 偏好回开（预期内）。
- [ ] C12 i18n 抽查 en/ja/tok（复位/从图层建选区/送入填色）。

## D. B 骑士 2 条（store 缺席变体）

- [ ] D1 `?nostore` 打开 → gallery 空态、能画/undo/导出 ora、内置笔刷在、无红 banner；去参数恢复正常。
- [ ] D2 正常模式回归：登录/列举/保存推云无异常。

## E. C 批追加锚（C0-C8 逐片，C handoff §4 摘录）

- [ ] E1（C0 fill 色窗）进 fill →（无选区）色窗换色→点选区，预览色=色窗色；✓ 连续填下一块色不丢；出 fill 色窗回笔刷色。
- [ ] E2（C4 裁决）fill 换色→**切工具**出口，落地色=预览色；✓ 连续填两块不同色各自正确、undo 逐步回。
- [ ] E3（C4 裁决）persp 编辑拖 VP→ctrl-z 回拖前；连拖三次撤三次；重置/锁切换各占一步；undo 中手柄跟着跳。
- [ ] E4（C5 压感事件钟）压感笔快甩起伏一笔——粗细跟压感比 v0.8.29 略更跟手，无尖刺无断笔。
- [ ] E5（C6 液化替身）液化推/收/胀/旋手感与旧版无差（含选区边界三模式、采样核切换）。
- [ ] E6（C6 取消无痕）液化/模糊锐化**描边中**二指转手势 = 无痕取消；形状笔像素模式拖拽预览如旧、Esc/切子工具取消无痕。
- [ ] E7（C6 调整面板）HSV 等 Apply 后 undo 正常。
- [ ] E8（C3 字节管线）存档缩略图/图库 peek/mergedimage 观感如旧；导出 PNG 透明保持、JPG 底色正确、含选区裁剪导出；blender 推图 POT 缩放；参考图 >2048 导入缩存。
- [ ] E9（C7 无令牌硬化探测）画/擦/液化/形状笔/调整/变换/填色/裁剪全流程**无「无令牌像素写」红 banner**——任何一处弹了就是抓到真 bug 或白名单漏登记，原文报上来。
- [ ] E10（C7 壳迁移回归）开画→画→存→图库缩略图/导出 PNG·JPG/mergedimage 观感如旧。

## F. 一张画跑通（0.8 端到端 win condition，最后压轴）

- [ ] F1 新建 → 画一张真的画（多层、含液化/形状笔/填色/选区/参考窗随用）→ 存 → 云同步 →
  关 app 重开从图库回来接着画 → 导出 PNG/ORA 都对。全程无红 banner、水印 v0.8.48（或当时 patch 号）。

---

**跑批口径**：A 置顶先跑（新技术风险最高）；B-E 顺手交叉着过没关系，条目独立；F 最后。
挂单直接在本文件打 ×+一句现象，或口头报——修走 0.8.x patch，改完哪条只回归哪条。
