# 没测的改动 / 等明天验

> 已经发 dev / prod，但 user 还没在真机上跑过的功能。明天 / 后天验完打勾，确认没回归再算结案。
> 验出 bug 的，要么修了 push 新 dev，要么挪去 [20260528-backlog.md](20260528-backlog.md)。

## v124 → v128 checklist

### 1. 笔刷手感
- [ ] **勾线笔 streamline=0.9** 拖慢笔够 procreate 夸张？V_REF=0.1 下慢仔细笔不应该 anti-lag 抢走平滑
- [ ] **默认铅笔 streamline=0.3** 跟老版本手感差不多？拖落点不应明显比 v123 慢
- [ ] **size slider 分段步长**（1-20 步 1, 20-50 步 2, 50-100 步 5, 100-500 步 10）：300 px 能准确选到？
- [ ] **硬橡皮** size 30/300, sizeCoeff 1.0 拖压感擦笔触渐变正常？

### 2. 图层
- [ ] **隐藏图层动笔**：点眼睛关图层 → 画任何东西 → 状态栏「当前图层已隐藏」+ 没改像素
- [ ] **点 active 图层名 rename**：点 active 行的名字直接编辑（非 active 行不应触发）
- [ ] **undo 创建图层** → status 显示「已撤销创建图层 X」
- [ ] **redo 创建图层** → 自动 setActive 到那层 + status「已恢复图层 X」
- [ ] **undo/redo mergeDown / moveLayer / renameLayer / setLayerProp** 每个都有 toast
- [ ] **图层面板"导入照片"按钮** 点了能开 file picker 并加为新层（v126→v127 修了两次）

### 3. 选区 / 套索
- [ ] **lasso 全画外**：在画布外画一圈套索 → 状态栏「选区全在画布外，已取消」（不应静默吞）
- [ ] **lasso 跨边界**：一半在画布内一半外 → 自动 clip 到画内部分

### 4. 变换
- [ ] **transform 默认 bicubic**：lasso lift 一片像素变形 → 默认双三次（采样 dropdown 第一项）
- [ ] **resize 画布默认 bicubic**：「调整尺寸」对话框默认双三次
- [ ] **gizmo 安全区**：变换时拖角 handle 别那么难按了（10→18 doc-px）
- [ ] **transform 拖外移动**：free/uniform/distort 模式下，按 quad 外面拖也能整体 translate（warp 模式仍是 no-op）

### 5. 裁切
- [ ] **handle 视觉**：黑色直角 L (4 corner) + 黑色短线 (4 edge)，不再是白方块
- [ ] **handle hit-area**：指尖按 handle 附近就 OK（::after inset -16px）
- [ ] **rect 空白不可拖**：点 rect 中间空白 → 啥也不动
- [ ] **裁切可扩张**：拖 handle 出 doc 边界 → rect 可超出画布；apply 后新 doc 比老大，原画在新 doc 内部（外围透明）
- [ ] **裁切到选区** 还正常（菜单"裁切"在有选区时改 label "裁切到选区"）

### 6. 文件
- [ ] **另存为**：菜单 → 另存为 → 输入新名 → 本地 + 云冲突检查 → 切到新 doc 继续编辑（原 doc 保留在画库）
- [ ] **云端 rename**：登录 OneDrive 后重命名当前画作 → 云端旧文件应消失，新文件出现（不应俩并存）
- [ ] **棋盘 per-file**：A 文件开棋盘 → 切到 B 文件 → B 自己的状态（默认关）；新建 doc 默认关
- [ ] **viewport per-file**：A 文件旋转/缩放后画几笔触发保存 → 关闭重开 → 旋转/缩放恢复；切到 B 文件 → B 的旋转/缩放

### 7. UI 杂项
- [ ] **主菜单第一栏「文件」label** 出现（重命名/另存为/裁切/调整尺寸/参考小窗 上方）

## 跨度回归提醒

v124 之前修的容易回归的几个：
- Windows 黑框（partial render sliver） — stroke 期间走 _renderFull 兜底
- bilinear 黑边（transform stamp） — clamp-to-edge fix
- iPad 双触防误（4 层 dblclick / 三指 / pointer 自愈）
