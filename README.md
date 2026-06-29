# WebPaint 打开即用的开源画画软件

开源的网页版画画软件。目标是在二次元和3D手绘贴图领域追上Procreate的手感和画质，同时保持开源的灵活可修改性。

![v126版截图](README.files/c8a3bd3b8470d4e66f8f0e926b45f7c5.jpg)

可以网页版，也可以全屏，离线。

### 怎么用？

1. 点开：https://fangzhangmnm.github.io/webpaint/
2. 开始画

## 这是一款什么样的软件

### 开源 = 你可以按需修改

开源意味着你可以自己（或者让AI）修改源代码，加入自己喜欢的功能，或者和自己的工作流对接。

比如画好之后一键推送到Blender贴图内存，或者和Galgame数据库同步热加载，甚至是WYSIWYG的世界地图编辑器。你也可以接入你最喜欢的AI大模型，一键整理线稿，生成素材。技术宅也可以把自己写的科研，数学代码，比如分形，有趣的图形学算法（比如自动生成玫瑰花的L系统，或者大气散射模型）加进来，利用本软件的交互性和专业的画图功能进行快速迭代修改——当然，你也可以简单的导入一个Live2D猫娘每天督促你画画。

这个Modding的自由度是闭源软件所不具有的。

当然，如果你不想那68块钱买Procreate的，讨厌Photoshop的订阅制度，或者想要在PC端拥有类Procreate的手感、体验的话，也欢迎来捡漏。

### UX为艺术体验优化，直观易用，美术生友好

本软件完全用龙虾(Coding Agent)写成，v126版本（二次元绘画场景基本跑通）只用了三天，我没有写一行代码。

但是在整个开发过程中，我以一个有实际二次元绘画经验的艺术家的身份实时监督：调试了手感，UX（操作是否直观易用，是否和艺术家的肌肉记忆打架），初始笔刷预设。

一些老牌的开源画图软件虽然精神可敬，也有着有趣的社区。但是因为开发者很多都是没有太多艺术经验的程序员，所以UI反直觉。资料都是英文的，学起来很难。但更困扰广大初学者的是：社区教程，出场预设，往往都是“程序员美术”。所以虽然这些软件有着完整的能够用来进行专业的艺术创造的功能，但缺乏大牛带路，很多人都不知道该怎么设置，使用什么样的工作流。最终还是决定回归有着大量艺术教程和成功实践经验的商业软件。

所以，我根据自己绘画的经验，尽量给画画的初学者创作了一个直观，易学，UX具有引导性的绘画环境。开箱可用。在二次元场景中可以无缝移植Procreate教程。


### 网盘同步，离线可用，不需要服务器

Ipad打开网页就可以画，登陆微软Onedrive网盘后可以自动同步网盘文件夹，多端同步，电脑上打开就能看。丢Ipad不丢画。省去了整理的大麻烦。

可以讲本网页App(Progressive Web App, PWA)下载到Ipad主屏幕上。离线可用。有Wifi时自动同步你的进度到网盘（版本冲突不丢画）。怎么做[请看这里](#如何安装离线版本)

但是，这个软件完全属于你自己，不需要服务器。你可以挑一个喜欢的版本把这个repo fork下来自己托管。怎么做[请看这里](#如何自己托管并开发自己的定制版本)

目前本app托管在Github Pages上，用的Onedrive同步方案，国内访问可能不稳定。希望有在国内开发经验的大佬合作做一下国内网盘对接和镜像部署的工作！

*fangzhangmnm*
*May.30 2026, 于Long Island*

## 目前跑通的垂直绘画场景

配图都是我亲手用这个软件画的。技术不好请见谅。

<details>
<summary>✅ <b>基本功能</b>（能画画，文件不丢，整理不累）</summary>

- [x] 笔刷和橡皮，支持数位笔，鼠标，指绘
- [x] 画布裁切，调整分辨率
- [x] 本地自动备份(IndexDB)
- [x] 云盘同步
- [x] 离线也能用(PWA缓存，ServiceWorkers)
- [x] 图库和文件管理（重命名，另存为）
- [ ] 图库文件夹管理
- [x] 缩略图
- [ ] 加密画作
- [x] 文件和相册的导入导出功能
- [x] 源文件的导入导出备份
- [x] 方便的剪切板导入导出功能

</details>

<img src="README.files/d404f192633d5e816423aa8a6bc7286d.jpg" height="250" align="right" alt="草稿起形示例">

<details>
<summary>✅ <b>草稿构思和起形</b>（已跑通）</summary>

- [x] 参考小窗（第一步就是找参考！老手也一样！）
- [x] 压感
- [x] Undo, Redo, Pan, Zoom
- [x] 自动保存，导入导出，网盘备份
- [x] 液化（调整比例，身材必备！再也不怕画歪！）
- [x] 选区，变换工具（自由，等比，透视）

</details>

<br clear="right">

<img src="README.files/1539c6134977cc1e48c96f9b42816e52.jpg" height="250" align="right" alt="二次元线稿示例">

<details>
<summary>✅ <b>二次元线稿勾线</b>（已跑通）</summary>

- [x] 高质量的笔刷，半透明，流量，硬度
- [x] 平滑防抖（streamline / pull stabilizer / motion filter / velocity-adaptive 几道坑都填了，详见 [docs/20260530-streamline-velocity-math.md](docs/20260530-streamline-velocity-math.md)）
- [x] 旋转、放大画布
- [x] 图层系统，支持导入参考图片
- [x] 半透明图层叠加，图层可见性
- [ ] 我自己发明的鼠绘算法（可以画出压感！）
- [ ] 锁定透明像素
- [ ] 接入清理线稿的AI模型

</details>

<br clear="right">

<details>
<summary>🚧 <b>二次元赛璐璐平涂场景</b>（未跑通）</summary>

- [x] HSV滑块，吸色
- [x] 套索，选区
- [x] 套索上色功能（二分画的干净）
- [x] 魔棒选区（有些人喜欢用）
- [x] 魔棒参考图层
- [x] 图层蒙板
- [x] 图层叠加模式
- [x] 剪切蒙板（画二次元的都在用！）
- [x] 喷枪
- [x] 调色（色相饱和度, 色彩平衡，曲线……）
- [ ] 手指涂抹工具（身体和腿的渐变，老师叫我平涂时少用）
- [x] 合并图层
- [ ] 图层组

</details>

<details>
<summary>🚧 <b>建筑机械机甲场景</b></summary>

- [ ] 几何笔刷（直线，圆规）
- [x] 盖印（选择一个图形，变换，盖章，一个图形重复多次，类似SketchUp，Procreate里面没有的功能）
- [ ] 多边形套索
- [ ] 透视参考工具和正交投影参考工具

</details>

<details>
<summary>🚧 <b>像素画</b>（未跑通）</summary>

- [x] Pixel Perfect像素笔刷
- [x] Nearest Neighbor像素插值变换

</details>

<details>
<summary>🚧 <b>手绘贴图厚涂场景</b></summary>

- [x] 自定义笔刷，笔刷库，笔刷库的导入导出
- [ ] 水彩，混色
- [ ] 手指涂抹工具
- [ ] 纹理笔刷
- [ ] 撒小星星的笔刷（Jittering, Scattering, H/S/V Variation, Size/Rotation Variation)
- [ ] 和Blender直接通信，一键更新贴图
- [ ] Tiling Preview（预览无缝贴图）

</details>

<details>
<summary>🚧 <b>Matte Paint背景图绘制场景</b></summary>

- [x] 水笔感椭圆笔刷(RJ最喜欢的Gesinski Pen)
- [ ] 选区填色
- 完备的图层合成，抠图功能
- [ ] 保存图层到笔刷

</details>

<details>
<summary>🚧 <b>类BodyPaint直接在3D模型上绘制</b></summary>

- [ ] 在 3D 模型表面直接绘制贴图（类似 BodyPaint 3D / Substance Painter）

</details>

<details>
<summary>🚧 <b>接入AI场景</b></summary>

- [ ] 线稿清理，补空，闭塞
- [ ] 抠图，去背景
- [ ] Waifu2x超分辨率

</details>

## 使用手册

### 快捷键和手势一览

设计哲学：尽量和Procreate / Photoshop / Blender对齐，少记一个是一个。新版本加的快捷键会自动出现在菜单 → 「快捷键」面板里，不用回来翻这个表。

#### 键盘

| 键 | 作用 |
|---|---|
| `B` / `E` / `I` / `L` / `H` | 笔刷 / 橡皮 / 吸色 / 套索 / 平移 |
| `[` / `]` | 笔粗 -2 / +2 |
| `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Ctrl+A` / `Ctrl+D` / `Ctrl+Shift+I` | 全选 / 取消选区 / 反选 |
| `Ctrl+S` | 保存（顺便推一次云） |
| `Enter` / `Esc`（变换中）| 应用变换 / 取消变换 |
| `Esc`（有选区时）| 取消选区 |
| `0` / `+` / `-` | 画布居中 / 放大 / 缩小 |
| `Space`（按住）| 临时平移（松开还原工具）|

#### 手势（iPad / 多点触控板）

| 手势 | 作用 |
|---|---|
| 两指捏 / 拉 | 缩放画布 |
| 两指旋转 | 旋转画布 |
| 两指 tap | 撤销 |
| 三指 tap | 重做 |
| 单指长按 | 吸色（菜单里可关，怕误触的）|
| 双击笔 / 橡皮 图标 | 切换笔 ↔ 橡皮（Apple Pencil 单手切换党的福音）|

Apple Pencil 2 / Pencil Pro 的"双击笔身"我让 iPadOS 自己处理（系统里设成工具切换 / 颜色就行），不去 hijack。

### 常见的画画流程

<!-- 这段AI瞎写的，我还没改 -->

<!-- 仅供参考，每个人都有自己的方式。这是我自己画二次元的工作流：

1. **打开图库**（左上图库图标）。新建作品 / 导入照片 / 拉云端文件 三选一。
2. **找参考**。顶栏右侧的参考小窗拖一张图，可缩放可遮罩。老手也一样，"不查 reference 的都是闭眼乱画"。
3. **草稿打型**（默认铅笔，低不透明度，先轮廓再大形）。型卡住了上**液化**修一下比例 / 五官位置。
4. **新图层 → 勾线**。换勾线笔（高 streamline 平滑，有 taper 起收尖）。
5. **新图层 → 平涂**。组合**魔棒 + 套索 + 油漆桶**。把线稿那层设为**参考层**，魔棒就能从线稿读连通域去给色层填色，线稿本身不受影响。
6. **上面再叠加**：剪切蒙板 + 叠加 / 正片叠底 / 柔光 模式 = 阴影 / 高光 / 渲染。
7. **导出**。PNG 给社媒；.ora 是项目源文件（也支持 .psd）；剪贴板可直接粘到 PS / Krita 继续。 -->

### 如何安装离线版本

WebPaint 是 PWA（Progressive Web App），不用进 App Store，浏览器直接装。

#### iPad / iPhone (Safari)

1. 用 Safari 打开 https://fangzhangmnm.github.io/webpaint/
2. 底部「分享」(↑ 框) 图标
3. 选「添加到主屏幕」
4. 主屏出现 WebPaint 图标，点开 = 全屏 PWA，没浏览器边框，跟原生 App 一样

#### Mac (Safari 17+)

文件 → 「添加到程序坞」。

#### Windows / Mac (Chrome / Edge)

地址栏右侧会有一个安装小图标，或菜单 → 「安装 WebPaint」。

装完之后：

- 完全离线可画。所有画作存在 IndexedDB，本机里
- 有 Wifi 时自动后台同步 OneDrive（如果绑了的话）
- 想强制刷出新版本：菜单 → 调试 → 「强制更新（清缓存重启）」

### 如何绑定网盘

目前支持 **OneDrive**（微软家的，国际版）。

1. 顶栏右上角点头像 / 状态栏「未登录」处
2. 弹微软登录窗，用你的 Microsoft 账号登（个人 / 企业都行）
3. 授权 Apps folder 访问权限——它**只能读写** `Apps/WebPaint/` 这一个文件夹，碰不到你网盘里的别的东西
4. 之后每次 Ctrl+S（或顶栏的保存按钮）= 推送到云端
5. 多端登同一账号，第二台机器开图库 → 看到云端 tile → 双击拉下来打开 = 多端同步

**冲突保护**：你在 A 设备改了画推上去，又在 B 设备改了同一张准备推时，B 会先提示「云端有更新」，让你选 拉云端 / 保留本地 / 都留 三选一，不会盲推覆盖。

国内网盘（百度网盘 / 阿里云盘）和墙内镜像部署还没做（在 [backlog](docs/20260528-backlog.md) 里），想要的可以提 issue 催一下。

### 如何和Blender通信

方案叫 **BlenderTextureProtocol (BTP)**，独立子项目，目前还在做。

设计目标：

- Blender 装一个 addon，本机起一个 WebRTC peer（不需要互联网，纯局域）
- 在 WebPaint 里编辑某张贴图 → 改完 apply → 通过 WebRTC 直推 Blender 内存
- Blender 自动刷新对应 material 的 texture，所见即所得

每次开 session 都要你**显式 consent** 才开通道，不会偷偷握手。

进度在 repo 里的 `BlenderTextureProtocol` 子项目，没跑通别用。跑通了我会回来更新这里。

### 如何绑定AI API

计划但**没接**。

设计方向：

- API key 自己填，存本地 LocalStorage（不上服务器，不上云）
- 一键功能：
  - 线稿清理 / 补空 / 闭塞：调 ControlNet / segformer 之类
  - 超分辨率：Waifu2x / Real-ESRGAN（小 reference 拉大用）
  - 自动上色：anime sketch-to-color 模型
- 输入 = 当前图层 / 选区像素；输出 = 新图层（不污染原图）
- API 端可选：OpenAI 兼容接口 / Anthropic / 本地 ollama / 自己开个 FastAPI

也有 P2 备选方向（[backlog](docs/20260528-backlog.md)）：本地 WASM 模型按需下载，第一次用时再下载缓存，不默 vendor 进 bundle。

想自己接的欢迎 PR。

### 如何让AI定制属于你自己的WebPaint，或者只是托管一个自己的本地版本

WebPaint 是纯静态站点，没后端。把它跑在自己电脑上、改成自己喜欢的样子，门槛比想象中低——你甚至不用会写代码，让 Coding Agent（比如 Claude Code）帮你写就行。本软件本身就是这么写出来的。

#### 装开发环境

1. **装 VS Code**：https://code.visualstudio.com/ ，下对应系统的版本，一路下一步。
2. **准备 git + 终端**（Mac/Linux 自带；Windows 装个 [Git for Windows](https://git-scm.com/) 用它带的 Git Bash 即可）。**不需要 Node.js / npm**——构建脚本 `scripts/build.sh` 会自己 `curl` 一个独立的 esbuild 二进制下来用（丢在 `tools/esbuild/`）；所有第三方运行时库（zip.js / MSAL 等）也都物理 copy 在 `src/vendor/` 里了，没有 `npm install` 这一步。
3. **申请 Claude Code**（可选，但强烈推荐）：去 https://www.anthropic.com/claude-code 注册 Anthropic 账号，按指引装上 Claude Code（命令行或 VS Code 插件都行）。这就是帮你改代码的 AI。

#### 如何自己托管并开发自己的定制版本

```bash
git clone https://github.com/fangzhangmnm/webpaint.git
cd webpaint
bash scripts/build.sh  # 跑 esbuild → 生成 hash 文件名进 dist/（首次会自动拉 esbuild 二进制）
```

`dist/` 下生成的 bundle 丢任何静态 host 就行：

- GitHub Pages（最简单，repo 自带 workflow，push 就部署）
- Cloudflare Pages / Vercel / Netlify
- 自己的 nginx / Caddy

本地边改边看的话，跑 dev server 开在 `localhost:5173` 即可。

> **省事提示**：如果你只在 `localhost:5173` 本地跑，OneDrive 同步用的微软 client id 我已经注册好、直接能用，不需要自己去 Azure 折腾。只有当你要部署到自己的公网域名时，才需要换成自己的 client id（见下面）。

#### 让 AI 帮你改

在项目文件夹里启动 Claude Code，然后**用大白话描述你想要的功能**，让它和你讨论、写实现、迭代。你不需要自己懂架构。

举个例子：你想在画布角落挂一个 **Live2D 小猫**，眼睛跟着鼠标转，还顺便统计你每天画了多久、督促你别摸鱼——你不用自己想怎么实现、也不用先设计架构，把需求直接丢给 Coding Agent，和它来回讨论（放哪、用什么库、数据存哪、怎么不挡画布）。它负责落地，你负责审美和拍板。

这种"我提需求、AI 写代码"的 Modding 自由度，正是开源相对闭源软件最大的优势。

#### 配置自己的 OneDrive（部署到公网时）

OneDrive 同步用的是 **Microsoft Entra (Azure AD)** OAuth，我的 client id 写死在 `src/config.js`。你 fork 之后部署到自己的域名、想用同步：

1. 去 https://portal.azure.com → Microsoft Entra ID → 应用注册
2. 新建一个 SPA 应用，加 Redirect URI = 你部署的 URL（例如 `https://yourname.github.io/webpaint/`）
3. 拿到 Application (client) ID
4. 改 `src/config.js` 里的 `MSAL_CLIENT_ID` 换成你自己的

不绑 OneDrive 的话，所有功能都还在，只是没法多端同步。

#### Dev / Prod 分支

repo 维护两个 branch：

- `main` = dev：我每天往里推，可能崩
- `prod`：稳定版本，GitHub Pages 部署到根路径
- dev 部署在 `/dev/` 子路径（同一个 Pages，分目录隔离）

想跟最新的开 `/dev/`；想稳的开根路径。

#### License

MIT。改了拿去商用都行，不强制开源你的 fork。能在原 repo 提 PR 大家共享更好，不提也没关系。
