# 云盘图片 picker + 图库扩展名白名单 — 设计 spec

> as-of v0.9.28 / 2026-08-20
> 本文 = 2026-08-20 grill 轮的决策落盘（user 逐条拍板），同轮开工实现。
> 出处纪律：标【拍板】= user 本轮原话决策；其余为 AI 设计、user 过目同意。

## 1. 背景与定位

- 场景 = **Claude Code ↔ WebPaint 双向素材通道**（user 本轮）：CC 往 OneDrive appfolder 扔素材
  （mock UI 图等），iPad 上 WebPaint 取用；画完的 .ora CC 直接从 appfolder fetch（ora=zip，
  内含 `Thumbnails/thumbnail.png` + merged 图，CC 侧自己解，**app 零工作量**）。
- 【拍板】**参考图/学习资料囤积库（iOS 相册级、每日 append）= 独立项目，本轮不做**——赶宣发。
  本轮只解决「丢图片、iPad 能取」。
- 【拍板】**不建 CC 检疫区**：OneDrive 版本历史兜误改、隐私图有加密（CC 读不了密文）、
  store If-Match/freshness 会把撞写 surface 成冲突而非静默覆盖。CC 侧唯一约定 =
  **别碰 `.trash/` `.backup/` `.webpaint/` 三个保留根**；建议文件名 descriptive（可带日期前缀）。
- 前提钉死：ADR-0022 scope 永久 AppFolder → WebPaint 能读的图**只能**住 appfolder 内。

## 2. 图库扩展名路由（v0.9.34 改版拍板，supersedes「图片不可见」）

- 【拍板 2026-08-20 二轮】**图片进图库当「次级 tile」**：视觉降级（半透明+image 角标+contain 缩略图）、
  排在画作 tile 之后；点击 = **孪生语义**——同夹同名 `<stem>.ora` 已存在就直接打开它，不存在才下载
  转生新 ora（名字钉死 = 孪生裸名）。心智模型：「点图片就是在这张图上画；画过了就接着画」。
  已知代价（拍板接受）：ora 改名后配对断，再点另开一个。
- 随之【拍板】**图库＋菜单「从云盘新建」入口删除**（图库本身就是浏览器，第二个 picker 门多余）；
  图层＋号/参考窗的 picker 入口照旧。
- 白名单其余不变：`.md`/未知杂物仍不显示（诚实性余账见
  `20260820-gallery-hidden-files-honesty-handoff.md`——图片可见后该 handoff 的「图片半边」已消）。
- 图片 tile 的 ⋯ 菜单：v1 只有「移到回收站」（store delete，可恢复）。
- 首轮「图片在 gallery 不可见」拍板（本节旧文）被本轮 user 明确翻案，不算 re-litigate。
- 只是展示过滤不是门禁：文件夹级操作（图库删夹/改名）仍作用于整夹含隐藏文件（store 语义，
  删除=移 .trash 可恢复）。已知边缘，接受。

## 3. `<wp-cloud-picker>` 组件（C9 家族组件约定）

- 形态 = 小型云端浏览器浮窗：面包屑 + 子夹导航 + 图片网格（缩略图）。住
  `src/frontend/cloud-picker.ts`，tag `wp-cloud-picker`，照
  `ai-docs/20260810-family-web-component-convention.md` 办理（shadow DOM、CSS 变量穿透、
  图标烤进 shadow、宿主 store 零知识）。
- 组件接口：宿主注入 provider（`listFolder(path)` / `fetchThumb(item)`），组件发
  `pick`（CustomEvent，带 item）/ `close`。数据源 = 宿主适配层包 `watchFolder`
  （与图库同一订阅面，反向 filter 只留图片 + 子夹）。
- 图片判定 = 扩展名白名单 `.png .jpg .jpeg .gif .webp .bmp .avif`（浏览器可解码集；
  tga 等自研解码器落地后再扩）。
- 【拍板】**夹不硬编码**（专门约定夹方案被否：「感觉不好，用户自定」）→ picker 有完整夹导航；
  初始位置 =【拍板】**跟随图库当前夹**（`gallery.getFolder()`，`./` 语义），零新持久化字段。

## 4. 入口与路由（三入口，语义随宿主）

【拍板】同一组件三处复用，不发明新选择面：

| 入口 | 路由 |
|---|---|
| 图库 ＋ 菜单「从云盘新建」 | → `importImageAsNewDoc`（新画打底） |
| 图层面板 ＋ 号「从云盘导入」 | → `importImageAsLayer`（叠层 + transform，大图护栏照旧） |
| 参考窗「从云盘」 | → `setReferenceFromFile`（参考图） |

字节读取 = `store.file(全名, { isZip:false, mode:"existing" }).open()`（整份拉云、离线读缓存、
加密透明——但图片本就明文）。Blob→File 包一层喂现役管线。`autoCacheOpenedFile` 会把打开过的
图片缓存进本地 IDB（算进作品占用）：离线友好，v1 不特殊处理，可 offload。

## 5. validateAdopt 魔数扩表

现值只认 zip/7z → 云端 png 会被当 captive-portal 假字节拒。扩表（`app-store.ts` app config，
不碰库）：+PNG(`89 50 4E 47`) +JPEG(`FF D8 FF`) +GIF(`GIF8`) +RIFF/WebP(`RIFF`) +BMP(`BM`)。
仍挡 HTML/截断字节，红线本职不变。

## 6. 缩略图（【拍板】must，本轮做）

- png/jpg 没有 ora 那种 zip 内嵌 thumb 可 peek → **整张下载、自己压、缓存派生物**。
- 【拍板】**与 ora 缩略图分开存**：webpaint DB 新开 `image-thumbs` object store（storage.ts
  版本 bump）。形状照 cloud-thumb-cache 家族样板：key = store 文件身份（全名含扩展名）、
  token = lastModified 优先退 size、token 变即重拉覆盖同 key、全删无损可再生。
- 规格：128px 长边（「Windows 资源管理器-大图标」档）、**JPEG q≈0.8**（【拍板】jpg 更高压，
  但不许压出可见噪点）。管线守家规「字节进出不走 canvas」：`decodeImageFile` 解码边界 →
  `resampleBytes` 缩 → vendored 纯字节 JPEG 编码器（jpeg-js 编码半边，物理进 repo）。

## 7. 文件名生成规范（家族统一表述）

【拍板】**「有名保名，无名日期」**：

- 有意义来源名（文件 picker / 云盘图 / 拖拽）→ 保留 stem（`foo.png → foo.ora`，png↔ora
  配对可追溯）；撞名后缀 ` 1` ` 2`（uniqueNameFor 现状维持）。
- 无来源名（空白新建、**剪贴板新建**）→ `yyyymmdd-xxxx`（4 位随机 hex，v217 生成器）。
  本轮修正：剪贴板新建从写死 `"clipboard"`（产出 clipboard 1/2/3…分叉）改走同一生成器。
- 归一化纪律不变：诞生处归一（sessionBareName，v437 血案）。
- 双文件语义：导入云盘图后 `foo.png` 原件**留在原地**（gallery 看不见，管理走 OneDrive）；
  不做自动清理、不做配对显示——自动删原件撞数据安全红线。

## 7.5 导出到云盘（v0.9.30 补章，user 2026-08-20 追加拍板）

- **cloud = 第四个导出去向 sink**（file/clipboard/print/cloud，🔧 popup 选、sticky per-doc）。
  exporter 字节管线不动；sink 写 `store.file(name,{mode:"new"}).save()`（首存护栏/离线补推全走库）。
- 【拍板】开放范围 = **image 组（png/jpg，吃全套导出配置）+ psd**；ora 仍锁 file（ora 上云本身
  就是同步的本职）。psd 的剪贴板/打印选项灰掉。
- 【拍板】落点 = **随画所在夹**（session.name 自带夹前缀），命名 = `<画名>-<YYYYMMDD-HHMM>.<ext>`
  （与下载导出同款时间戳；多次导出留历史），撞名自动 ` 1` ` 2` 后缀（纯函数 nextFreeExportName）。
- **诚实 toast**：按 save() 返回的 pushed 事实说话——「已导出到云盘」vs「已存本地（联网后自动上云）」。
- **加密件软拒**（AI 按红线精神定，user 可翻）：加密模型承诺=明文字节不落云端；
  明文导出（png/jpg/psd）+ cloud 去向 → 状态行拒绝，指去「文件」下载。
- 已知副作用：导出的 png 会出现在 import picker（它就是夹里的图片，对 CC 工作流正是目的）；
  psd 非图片扩展名，两边都不显示（CC 从 OneDrive 直取）。

## 8. 真机验证项（攒批）

1. iPad：三入口各走一遍（云盘图 → 新画 / 叠层 / 参考窗）。
2. 缩略图：首开慢路（整张下载）+ 二开缓存命中；改图后 token 失效重拉。
3. 图库白名单：appfolder 里丢 .md/.png 后 gallery 干净、夹导航照常。
4. CC 工作流全程：CC 写 png → iPad 取 → 画 → CC fetch .ora 解 merged。

## 9. 已否决 / 停车（防 re-litigate）

- ❌ 专门约定夹（inbox/ 等）——user：「之前专门放了一个文件夹，感觉不好，用户自定」。
- ❌ CC 检疫区（见 §1）。
- ❌ 参考图囤积库进本轮（独立项目，appfolder 内选址 + 按月分夹等设计另开）。
- ❌ picker 记住上次夹的持久化字段（跟随图库当前夹，零字段）。
- ❌ 导入后自动删/移原 png。
- 🅿 缩略图 Graph 服务端 thumbnails API（库缺接口，逐案 escalate；本地自压先行）。
- 🅿 `<option>` 结构性阻塞、SVG 方向等与本轮无关旧账照旧。
