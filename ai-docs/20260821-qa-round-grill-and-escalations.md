# 2026-08-21 QA 轮：grill 决策记录 + store 库 escalation 清单

> as-of v0.10.15 / 2026-08-21。本轮已修项见同日 commit。
> **2026-08-21 下午 user 已对本文逐条拍板**——拍板结果见文末「拍板落账」节，正文保留原分析供考古。

## 1. 主菜单 File 区重排（user 提案 + AI 批判性分析，待 grill）

user 原话方向：`File = Back to gallery | New | Export | Rename | Encrypt | Timelapse`；
「save as 名字误导，应改成 save local file 和 open local file 对偶」；核心张力 =
**无地（本地文件）与 store-connected 两个模态的 mindset 不同**。

现状（v0.10.14 汉堡菜单 File 段）：图库 / 新建 / 打开本地文件 / 登录 OneDrive / 导出图片(+扳手) /
Timelapse / 重命名 / 另存为 / 回到打开时的版本 / 加密保护。

AI 分析——**同意大方向，但有一个语义地雷**：

- 今天的「另存为」（`session.saveAs`）= **图库内复制一份新身份**（Photoshop 语义，v125），
  **不是**写本地磁盘文件。把它改名「save local file」= 换掉语义而不只是换名。
  真正与 open local file 对偶的「存为本地 .ora」目前**不存在**（导出图片是 PNG 面）。
- 所以重排前要先拆三个身份操作：①图库内复制（现另存为）②存为本地 .ora 文件（缺失，待建）
  ③无地模式的存回原文件（Ctrl+S 已有）。混淆的根源是①和②共用了「另存为」这个词。

**待拍板问题**：
1. 「图库内复制一份」去哪？留 File 菜单（改名「复制一份…」）还是挪进图库卡片菜单？
2. 要不要新建「存为本地文件…」（store doc → 磁盘 .ora，= ②）与「打开本地文件」对偶？
   建两条后 File 是否按模态分段显示（无地时隐藏加密/重命名等 store-only 项）？
3. 「回到打开时的版本」（revert）去哪？低频但救命——收进 Export 扳手？留原位？
4. Timelapse 在无地模式是否显示（timelapse 状态是 per-doc sidecar，无地目前怎么处理）？

## 2. Smart save 按钮吸收 sign-in（user 思路 + AI 批判，待 grill）

user 思路：credential 掉了时，save 按钮第一下=本地存 + 图标提示未登录；第二下=触发登录。
菜单里不再放「登录 OneDrive」。

**AI 判定：思路成立，且两段式是 iOS 技术上被迫的正解**——
loginRedirect 前不能有 await（v0.6.22 红线：丢 user-gesture 会被 Safari 静默拦），
「先存后登」若并成一下就违反此红线；拆成两下，每下都是独立手势，天然合规。
也符合「只有 signIn 手势能 redirect」的家规（store 后台路径不劫持导航）。

**三个风险点要拍板**：
1. **误触第二下**：习惯性连点 save 会突然 OAuth redirect 跳走。建议第一下之后按钮**变形**成
   视觉上明显不同的「登录」chip（几秒后回落），换了视觉目标才算有意点击；或第二下先弹
   in-app 锚定小泡（「已存本地 · 登录以同步？」）——但多一步。选哪个？
2. **可发现性**：菜单删掉登录入口后，从不点 save 的人从哪登录？图库的云账号 popup 仍有入口
   （建议保留为唯一第二入口）。够吗？
3. 未登录已存本地的按钮态用哪个图标（现有 8-badge 云态体系里 `cloud-unavailable`？）
   ——判断类字段归人类。

## 3. 形状笔 Shift = 橡皮？（键位冲突，待拍板）

现状：**Shift 已被形状笔占用** = 约束反转（正方/正圆/水平线，XOR per-子工具 toggle），
且是描边**进行中**可实时切换的（input.ts:1417 → shape-brush `setConstrainInvert`）。
而橡皮模式必须在 pointerdown 锁定（mode 进 `beginStroke` 后不可变）。两者语义层级不同，
同一个键装不下。管子已通（`ShapeStroke.mode` 收 "erase"，只是无人传）。

选项：a) 换键给橡皮（E hold？注意家规：新键位不用 Alt——user 键盘 Alt 有时不识别；
Alt 现在也已是取色）；b) 约束反转让出 Shift、挪去别的键；c) 形状橡皮做成工具条 toggle 不占键。
另 user 问「shift 橡皮对普通画笔怎么办」——普通画笔 Shift 目前**空着**（无直线模式），
若普通笔 Shift=橡皮、形状笔 Shift=约束，跨工具不一致；若都=橡皮，形状笔约束要搬家。请拍板。

## 4. 已按 AI 判断先斩后奏的两个小决策（可否决）

1. **hex vs 色名优先级**（user 问「撞了谁优先」）：本轮改为**显式带 `#` → hex 优先；
   裸串 → 先色名、不中再当 hex**。理由：词库会持续膨胀（facade/decade 类 6 位纯 hex 字母词
   总有一天进来），裸串色名优先是唯一不被静默劫持的顺序；带 `#` 则永远是 hex，肌肉记忆不变。
   当前词库扫描 0 冲突，行为暂无可见变化。
2. **保存自动 commit 边界**：显式保存/退出（Ctrl+S、save 按钮、Ctrl+Shift+S、另存为、回图库）
   现在会先 commit fill 预览 + apply 变换浮层；**换文档（openItem）仍维持「切换=丢弃」旧拍板**，
   autosave/关标签偷存也不背着用户 commit（interrupt=cancel）。要不要把「换文档」也改成 commit，请拍板。

## 5. 透视变换 handler 挤压（user 问「好做吗」）——好做，下轮可做

现状是按注册顺序 first-match 命中。改法 = **nearest-wins**：对所有 handler 算距离取最近
（半径内），挤在一起时中间那个也点得到；可加 tie-break（内环 handle 优先）。改动集中在
hit-test 一处，风险低。属手感区（人类钉死），本轮未动，等确认再做。

## 6. 下轮候选（本轮刻意不做）

- **曲线编辑器重做**（user：v0.1 时代算法债，插值+增删移动全烂）：对标 Unity AnimationCurve /
  PS 曲线体验——切线把手、点击曲线加点、拖出删点、单调 Hermite 插值。是一个独立纪元级重做。
- **backup 管理（尤其本地）**：store 0.2.3 侧「备份箱 UI」已记账为下一轮（见 memory/store 仓）。
  本地 checkpoint 现状=单槽（`checkpoint-policy` key `:0`），双 tab 会互覆——backup 轮一并解。
- **图库长驻前台的云端轮询**：本轮已补「回前台刷新」；真轮询 = store 从被动库变主动 agent
  的大 ADR（ai-docs/20260528-backlog.md「空闲自动收敛」节），不偷跑。

## 7. store 库（@internal/store）escalation 清单——改库需另开 pwa-cloud-store session

按家规「缺接口 escalate 改库 API，绝不在 app 端绕」，本轮查明但**未动**的库内事项：

1. **busy 文案 i18n 接缝**：库内 15 处裸中文 busy label（push.ts「正在同步…」等），
   StoreUI 契约无 label 注入口。已有账：「宣发后=库串 i18n 化」。App 侧键其实都备好了。
2. **`getPeek({ preferCloud })` 或暴露 raw local mtime**：云缩略图新鲜度的根修需要——
   现状 getPeek 恒本地优先，`newer-on-cloud` 的项会把**新 token 配旧字节**写进 thumb 缓存
   （盖成「新鲜的陈图」，之后永不自愈）。app 侧本轮只修了「回前台刷新」。
3. **`converge` 用 per-tab `isDirty` 而非 `isDirtyAnywhere`**（reconcile.ts:75）：
   双 tab 场景可把 A tab 未推的脏字节移进本地回收站（可恢复，但踩 §A「dirty 永不被驱逐」）。
   offload 用对了，converge 没有——需上游核对修正。
4. **cloudless collection 跨 tab 整份盲写**（collection.ts hydrate 一次 + 整信封覆盖写）：
   `local-app-state`（current-file/restore-attempt）双 tab 互覆、永不自愈（synced 的有 LWW 自愈）。
   candidate：写前 re-read + per-key merge，或 storage 事件失效。
5. **双 tab 同一作品本地字节互覆**：本地腿无 If-Match 等价物；离线/未登录用户纯静默丢。
   candidate：Web Locks 或本地版本戳（大改，需要 grill）。
6. （轻）并发实例会误触 boot 崩溃环断路器（restore-attempt 被对方 tab 读到 → 误报崩溃循环）。

## 8. parked（user 自己 park 的，立此存照）

- 2k 图习惯性按保存 → 网络成瓶颈（不是机器性能）。与「save=无条件 encode+推」（v409 拍板）
  直接相关；若要动，方向是推云异步化/去抖，牵动时间戳走字的拍板，等专门 grill。
- timelapse 像素画残余的糊：本轮放大已改 nearest，剩下的来自 H.264 4:2:0 色度下采样
  （编码器约束）；预览 `<video>` 也无 pixelated。真要根治要换 codec/加 CSS，暂 park。

---

# 拍板落账（2026-08-21 下午，user 逐条回复原文为准；带▶的当日批二落地）

## §1 主菜单 File —— 拍板
- **不要「save local file」菜单项**——那是**导出的一个去向**；「另存为（图库复制）」也**并入导出**。
  user 判据：「如果没有这个功能，用户会自己用导出多步去实现，所以放在导出的选项里面。」
- ▶ 导出 hub 三去向：导出图片（现有 PNG）/ 存为本地 .ora（保存对话框）/ 复制一份到图库（原另存为）。
- ▶ **Revert 必须有**——现状按钮 `hidden` 永久隐藏、handler 空转（「居然没接」实锤），接活常显。
- ▶ 终序：图库 · 新建 / 打开 · 导出/另存为 · 重命名 · 加密 · Revert · Timelapse。
  （登录条目暂留，等 smart save 轮吸收。）

## §新 无地=除云外全功能（high，家规级心态）
- user：「timelapse 不是 sidecar（注：录制态在 .ora 容器内随文件走），无地当然要全量 timelapse。
  我当时 propose 无地就是除了云之外所有功能都应该有。**所有功能只要不需要持久化就不应该
  依赖持久化，深查。**」已入 memory（feedback-localfile-full-features）。
- ▶ 当日深查+修 timelapse 无地 gate；大 gap 报告不偷跑。

## §2 Smart save + 「启用云端功能」开关 —— 方向拍板，细化下轮（大查）
- 按钮行为改口径：**一下**=照旧保存；auth 掉了→按钮换图标，按下=本地已存+**弹 in-app 对话框**
  「云端未登录，是否登录」（对话框里的登录钮就是 loginRedirect 的手势，iOS 红线天然合规）。
  从未配置云的第一次登录也走这个对话框（user 自注：不确定会不会混乱——实现时再看）。
- **新设置「启用云端功能」**（同启用 AI 的姿势，默认开）：关=真无地 single html app，
  所有云 UI 隐藏。这是宣发前 user 非常想要的形态，也是无地骑士清债的收口。
- 容器不支持云（如无 MSAL 配置）→ 该开关灰显默认关；容器支持后自愈回用户保存值。
- 徽章：不开云=save 无小圆点；开云未登录=cloud-unavailable。
- **待重 grill**：禁用云端 ≠ 无地——禁的是整个 gallery/idb/localStorage 还是只云？
  （brush rack、AI 权重仍要 idb。）user 问「用模块化工具而不是苦逼查」——AI 方案：
  建单一接缝模块（如 `src/cloud-capability.ts`），所有云能力判定/云 UI 挂载点只准 import 它，
  build.sh 加 lint（app-store 接缝同款守法）→ audit = import 图检查而非人肉 grep。下轮做。
- 可发现性结论（user）：菜单里的登录反而没人看；smart save 按钮态变化就是最强提示。
  接近「强制植入」的线，用对话框+「启用云端」总开关拦。

## §3 临时橡皮 —— 研究结论（待 user 确认再做）
- 行业惯例**不是 Shift**：PS=spring-loaded（按住工具键临时切、松开弹回，橡皮=按住 E）；
  Krita=E 切换当前笔的擦除混合模式；CSP 同属键切。普通画笔目前只有笔尾/副按钮橡皮，键盘临时橡皮未做。
- AI 提案：**按住 E=临时橡皮**（落笔瞬间判定 mode，画笔/形状笔一致语义）；形状笔 Shift 保持约束反转不动。
  待确认后实施。

## §4 先斩后奏两件 —— 拍板
- hex 优先级：**同意**（带#恒hex / 裸串色名优先 / hex 兜底）。▶ 追加：**3 位 hex 也要支持**（#abc 展开）。
- 保存自动 commit：**同意**。换文档：取决于是否 autosave（隐式不 commit）；
  **high：换文档（open/new）走丢弃时必须文案提示+弹窗挽留——AI propose 如下，待拍**：
  切换前检测 fill 预览/浮动变换挂着 → sheet「有未应用的填色/变换」三选：
  **应用并继续**（commit→存→切，默认）/ **丢弃并继续** / **取消**（留在当前画）。
  autosave/崩溃路径不弹不 commit（维持 interrupt=cancel）。

## §5 透视 handler —— 拍板：做。nearest-wins + tie-break 内环优先。▶ 当日落地。

## §6 下轮候选 —— 拍板
- 曲线编辑器：继续欠着。
- backup 管理：park，但 ▶ UI 先挂「备份箱管理（即将推出）」占位。
- 图库长驻轮询：维持 park（滚动不构成轮询——token 来自订阅时刻的帧，见 §7.2 分析）。
- ▶ 追加当日做：图库**自然排序**（10 在 2 后）。

## §7 store escalation —— 拍板（开 store 轮，走 pwa-cloud-store）
1. busy 文案 i18n 接缝：**同意做**。
2. getPeek：user 推演确认被 getPeek 本地优先卡死（etag 已能判 cloud-newer，不想全量下载就只剩 peek）。
   **方向=把来源变成强制必填参数**（`getPeek({ source: "local"|"cloud" })`，无默认），
   每个调用点被迫声明意图；「本地在场要不要重生成 thumb——应该有」归 app 侧 token 缝判断。
3. converge 用 per-tab isDirty：**修**（isDirtyAnywhere），且 per-tab 的 isDirty **全量查改名**
   （如 isDirtyThisTab，名字长一点说清楚）。
4. 双 tab 把 A 的未推脏字节移进回收站：**修**。心态纠正（已入 memory）：
   「不能『可恢复』这么想——瑞士奶酪每一层都要假设自己是最后一道承重拦截；
   做不到必须显式契约说明白。」
5. ▶ 崩溃环误触发：**修，一起**（app 侧 Web Locks 活实例互认，当日落地）。
6. **不是无地状态时双实例也要拦**（headline）：▶ app 侧当日做 per-doc Web Locks 门
   （boot 恢复让位+openItem 警告）；store 侧本地字节互覆护栏进 store 轮。

## §8 parked —— 全部确认维持 park（2k 保存网络瓶颈、timelapse 4:2:0 残糊）。
