# 剪贴板正宫化 + 无地本地文件模式 — UX 设计 spec

> as-of v0.9.19 / 2026-08-19
> 本文是 UX 设计轮的决策落盘（user 2026-08-19 本轮逐条拍板），**未开码**。实现轮接手前先读 §9 现成零件地图。
> 出处纪律：标【拍板】的条目 = user 本轮原话决策；标【维持】的 = 沿用历史拍板（附原出处）；其余为 AI 设计、user 过目同意。

## 1. 背景与定位

- 起因 = PSP 封面事件：WebPaint 开始在 Windows 侧承 Photoshop 的重。姿态变化：iPad 姿态 = 画从生到死都在 app 里，导出是终点仪式；Windows 姿态 = WebPaint 是桌面工作流的**中间一环**，图像高频穿过它，剪贴板是呼吸道。
- 【拍板】**不依赖"装成 PWA"解决核心路径问题**。本 spec 所有 P0 能力（快捷键、paste 事件、FS Access、beforeunload）都必须在浏览器标签页里成立；file_handlers/launchQueue 等 PWA 专属能力只做锦上添花层。
- 高频场景（按频率）：① 截图批注往返（进出全走剪贴板，不碰文件/导出菜单）② photobash/拼图（PSP 封面本尊）③ UX mockup 自拷贝 ④ AI 往返——【拍板】AI 往返走 AI 插件，不占剪贴板设计。
- 【拍板】SVG 方向（mockup 的对齐/图层效果需求）刚需但**本轮不讨论**；Text Tool parking 中。

## 2. 快捷键总表（定稿）

| 键 | 语义 | 状态 |
|---|---|---|
| Ctrl+C | 活层∩选区 → PNG（无选区=整层） | 现役，不动 |
| **Ctrl+Shift+C** | **合并复制**：合成图∩选区 mask | 新增【拍板：试用】 |
| **双击 Ctrl+C** | 第二下升级为合并复制（toast 教学"再按一次复制合成图"） | 新增【拍板】 |
| **Ctrl+X** | 剪切 = Ctrl+C + 从活层擦除选区像素，一次 undo | 新增 |
| Ctrl+V | 粘贴 = 新图层 + 自动进 transform | 现役语义不动【维持：统一新图层不 float，journal/ARCHIVE/20260530 WP feedback.md:144 human 拍板；supersedes ai-docs/20260528-backlog.md:186 的 v134 浮层方案】 |
| Ctrl+Shift+V | 原位粘贴（跨 doc 拼图/AI 对位用） | 【拍板同意】phase 顺位后置 |
| Ctrl+A / Ctrl+D / Ctrl+Shift+I | 全选 / 取消选区 / 反选 | 现役，不动。Ctrl+D 保持取消选区（PS 肌肉记忆），duplicate 不占它 |
| Ctrl+J | 选区原位浮层（duplicate float） | 现役，不动 |
| **Shift+D** | Blender 别名 → 同 Ctrl+J | 新增（家规：尽量对齐 Blender） |
| **Ctrl+E** | 合并向下（LayersFace.mergeDown 已有 API） | 新增【拍板】 |
| Enter / Esc | transform commit / abort | 现役确认。abort = identity 前写非回滚（`src/transient-panels.ts:56-58`，v0.4.7），【拍板】"前进赞，安全" |

约束：
- **新键位一律不用 Alt**（user 主力键盘 Alt 有时不识别）。Ctrl+Alt+C 备胎作废。
- Ctrl+Shift+C 有 Google Docs 先例（字数统计在 Chrome 标签页正常工作）→ 大概率不被 DevTools 吞，真机验一次（§10）。翻车则双击 Ctrl+C 独挑。
- 合并复制语义：**零配置直出透明 PNG**（所见即所得），mask 外透明（与 Ctrl+C 的 alpha×mask 口径一致，不是光裁 bbox），**不吃导出菜单的 defringe/bg 配置**——快捷键是反射动作，配置留给导出菜单。
- 合并复制**加按钮**【拍板】（lasso 工具条，iPad 侧同时受益）。

## 3. paste/copy 事件通道

- 现状零 `paste` 事件监听，只走 keydown 主动 `navigator.clipboard.read()`（有权限弹窗 + 历史案底"Windows 截图 Ctrl+V 没反应"，journal/ARCHIVE/20260530 WP feedback.md:143）。
- 设计：**`paste` 原生事件为主通道**（clipboardData 免权限弹窗，白送 Shift+Insert），快捷键表条目保留（帮助面板 SSoT + 兜底），实现去重。copy/cut 事件可选（write 端权限宽松，优先级低）。
- file drop 现役保持【拍板：也可以做】；drop 的 `getAsFileSystemHandle` 兼任 §7 无地模式入口。
- **iPad 三指手势**两拆【拍板：undo/redo 本轮处理】：
  - 压误触（确定项）：笔画进行中（pointer active）忽略一切剪贴板/undo 事件；系统 HUD 不该在画画中途弹。
  - 接手势（spike，真机裁决收不收）：offscreen contenteditable 保持聚焦，监听 `beforeinput` 的 historyUndo/historyRedo/insertFromPaste 转发 app——注意撞 `_keydown` 的 contentEditable 豁免（`src/input.ts:1371`），需白名单；iPadOS 版本漂移大，不进 P0 承诺。

## 4. UI 露出（正宫仪式）

- lasso 工具条 ⋯ 溢出菜单（`SEL_ACTIONS`，`src/toolbar.ts:1103`）加：复制 / 剪切 / 合并复制 / 粘贴【拍板：lasso 加 UI 同意】。快捷键沿用"代理 click 隐藏按钮"惯例。
- **不**在汉堡菜单新开"编辑"节（undo/redo 都不在菜单里，不为剪贴板破例）。
- **toast 反馈全覆盖**【拍板】：成功报做了什么（"已复制当前图层" vs "已复制合成图"——顺带教学双击语义）；失败必报不许吞（剪贴板无图 / 组层软拒 / 超 maxLayers）。i18n 走 `strings.ts` 的 `se.*` 段扩 key。

## 5. 大图片导入护栏（定稿）

- 护栏本职 = **undo 内存护栏**（重采样必须发生在 lift 之前才真省内存），**不是构图意见**。
- 护栏值 = **max(2048, 画布长边)**。
- 【拍板】**不超护栏：不跳窗口，静默原尺寸进**，直接 transform 摆位。**超护栏：跳"大图片导入"窗口**（复用 `_openBigImportSheet` 换阈值和选项：适配护栏 / 按比例自定义重导）。
- **作废**：fit-canvas 方案（psp 墙纸案：photobash 常态是素材比画布大、摆位后裁溢出；进门先缩到画布 = 后续放大 = 糊）。transform 里不自动 fit，默认 1:1 居中，裁多少是构图决定留给 gizmo。
- 连贴节奏：下一张 Ctrl+V 自动收口悬着的 transform（【拍板：对连贴自动 enter】；现役 `importImageAsLayer` 已收口，实现轮确认收口 = commit 并加测试钉住）。

## 6. 格式队列

| 格式 | 判 | 依据 |
|---|---|---|
| TGA in/out | **进队** | 便宜：BGRA+RLE，解/编各约百行纯字节手写，零依赖零 canvas |
| 静态 GIF in/out | **进队，像素画优先** | 像素画天然 ≤256 色直接打调色板，白捡；GIF 是像素画社区流通格式（核心承诺）。照片级导出需 median-cut 量化，后置 |
| DDS | **停车，不留坑**【拍板】 | 伪需求：老游戏解包场景里 Claude Code 逆向时顺手转 png |
| HDR | 停车 | 8bit 管线语义不匹配（进=必 tonemap 有损，出=无意义） |

结构：出口走 `registerExporter` 注册表（现成）；进口新开一个"浏览器不认格式"的字节解码小接缝，与 png-codec 同款零 canvas 纪律。动图 GIF 与像素动画一起 park。

## 7. 无地本地文件模式（无地骑士收文件落地）

核心承诺映射：**doc 的家可以是一个本地文件句柄，而不是 store 身份**。底座 = File System Access API（标签页全功能：`showOpenFilePicker` / drop 的 `getAsFileSystemHandle`）。

| 打开物 | 打开语义 | 保存语义 | 文件关联 |
|---|---|---|---|
| .ora（有 WebPaint 痕迹） | 本地原位打开，不上传、无 store 身份 | Ctrl+S 原位写回 | **抢默认**【拍板】 |
| .ora（外来，Krita 等） | 导入为新 doc | 只能另存 | （同一注册） |
| .psd | 导入为新 doc | 另存，默认格式 = ora；psd 只出不进驻 | 注册 handler **不主张默认**（永不原位写 psd，注册无害） |
| | ↑ 实施注（v0.9.24）：WebPaint 目前**没有 psd 解码器**（exporters 只有出口），psd 行保留为方向，未实装 | | |
| png/jpg/webp | 导入为新 doc（现役 `importImageAsNewDoc`） | 只能另存 | 注册 handler 不抢默认 |

- WebPaint 痕迹检测 = 拆 ora zip 看我们的扩展 sidecar 在场与否。
- 原位写回前查文件 lastModified（FS Access 无 etag，mtime 检查 = 零成本防陈旧覆盖，对齐家族 freshness 红线精神）。
- 【拍板】**无地 = session 级，没有任何持久化托底**：不进图库、刷新即散、重开走 picker/drop。IDB 句柄持久化（"最近本地文件"）**已否决**。
- 谱系：无地 doc = store ADR-0008 "consent 前不建库条目的 float doc" 概念的正统继承人，把 crash-shadow 也拆掉的版本。

### 7.1 Windows 对齐：弃自动保存

【拍板】本地模式和 Windows 对齐而不是 mobile 对齐，Alt+F4 = 不保存。设计成立的**硬前提三件套**（缺一即煤气灯）：

1. **dirty 持续可见**：标题区 `文件名.ora •`（未保存点），保存后消点。
2. **beforeunload 守门**：只在 dirty 时挂；UI 层每次关闭都过知情确认，确认即放行。
3. **Ctrl+S 写回 + toast**（"已保存到 xxx.ora"）。

实现注意：无地 doc 必须**整体退订** autosave bgJob 和 blur/pagehide 抢救 flush（它们的去处是 store IDB，无地没有那个家；静默 flush 会违反 consent 前不建条目）。smart save 按钮加**第四态**（本地文件态），否则三态图标在无地模式全是谎报。

反面论证存档：**"自动写回用户文件"比弃自动保存更危险**——静默改磁盘 .ora 违背 Windows 文件语义，且撞家规 interrupt=cancel（未保存编辑绝不持久化）。

### 7.2 关闭护栏（两模式统一语义）

**"有真正会丢的字节才拦"**：

- 无地模式：拦"没写盘的一切"。
- store 模式【拍板：也加】：只拦"内存里还没落进 IDB 的写入"（真丢失窗口，autosave 30s 节流间隙）；**不拦**"IDB 有、云端没有"（offline-first 常态，dirty 永不被驱逐重开续传；拦了 = 每次离线关闭挨一枪 = 狼来了，护栏信用打光）。
- beforeunload 事实（本轮核实）：标签页/PWA 同效；关标签、Ctrl+W、关窗口、Alt+F4、刷新、导航全覆盖；**可反复拦**（sticky activation 页面存续期不消耗，没有"只许拦一次"策略）；文案是浏览器统一的不能自定义；任务管理器杀进程 / Chrome 崩 / 断电不弹——【拍板】本来就不该拦，那是"游戏打了坏存档"的紧急逃生通道。

## 8. 灾难恢复（结案）

【拍板】**灾难恢复 ≠ session resume**，两个东西：

- **session resume** = 现役 boot-restore 链（current-file → store autosave 字节 → 恢复到上次落盘），不动。
- **灾难恢复** = 化石快照：不要求 realtime sync、不查云端 divergent、archive and forget。
- 【拍板结案】**revert 就是灾难恢复**。revert 现役且是活的（v415 重接）：快照点 = 打开这幅画的那一刻（非定时，`src/checkpoint-policy.ts` 显式 trigger 枚举），落 app 侧 `webpaint` IDB `checkpoints` store 单档（slot 恒 0，key 预留多档），加密件存密文容器（明文永不落持久层），恢复走既有身份 adopt + 标云脏。**parking，不做新东西**；日后 unpark 路径 = 往 CheckpointTrigger 加触发点 + 往 slot 加档，不是新系统。

## 9. 实现期现成零件地图

- 剪贴板 IO：`src/session.ts:189-215`（copyImageToClipboard / writeImageBlobToClipboard 的 lazy-promise 保 iOS user-gesture 写法是硬经验 / readImageFromClipboard）。
- Ctrl+C/V 现役：`src/selection-ops.ts:101-131`；Ctrl+J：同文件 :133-145。
- 合并复制管线：`renderDocToImageBlob`（`src/session.ts:96`，GL 合成→字节→`encodePngFromBytes` 零 canvas）+ 选区 mask（`Selection.materializeMaskRegion` / `bboxMask`，`src/backend/selection.ts`；tile 句柄所有权纪律：dispose/clone）。
- 粘贴落地：`importImageAsLayer`（`src/import-image.ts:150`，含收口 transient / 越界走 `liftFloatFromBytes` 字节直接成浮层）。
- 快捷键 SSoT：`src/input.ts:197` `KEYBOARD_SHORTCUTS`（帮助面板自动渲染）；文本输入豁免 :1371。
- UI：`SEL_ACTIONS`（`src/toolbar.ts:1103`）、图层面板"导入剪贴板"（`index.html:1019`）、图库"从剪切板新建"。
- i18n：`src/i18n/strings.ts`（zh/en/ja 必填，`sc.*`/`se.*`/`tm.*` 段）。
- 顺带翻出的 store 旧账（与本轮无关，仅指针）：C1b 离线 `queuedCloudDelete` 队列未持久化，强退丢队列云端文件复活——store 库红线区，动 = escalate（`ai-docs/20260604-sync-store-extraction.md:203`）。

## 10. 真机验证项（攒批）

1. Ctrl+Shift+C 在标签页/PWA 是否被 DevTools 吞（Google Docs 先例预期能拦；翻车 → 双击 Ctrl+C 独挑）。
2. paste 事件 vs `navigator.clipboard.read()` 的权限弹窗行为对照。
3. 透明 PNG 贴进微信/Discord/PS 的 alpha 表现（决定要不要 toast 提示，非我方 bug）。
4. iPad 隐藏 contenteditable 接三指手势 spike（收不收由真机裁决）。
5. beforeunload 各退出路径实测（Alt+F4 / 关窗 / 反复拦）。
6. 无地模式全流程：drop .ora → 原位编辑 → Ctrl+S 写回 → mtime 冲突路径。

## 11. 已否决 / 停车清单（防 re-litigate）

- ❌ 粘贴 = 浮层（v134 方案）——维持 20260530 human 拍板：统一新图层不 float。
- ❌ Ctrl+Alt+C 备胎（Alt 不识别）。
- ❌ fit-canvas 护栏 / 护栏与画布尺寸挂钩的"适配画布"语义。
- ❌ psd 主张默认关联（注册 handler 但不抢）。
- ❌ IDB 持久化文件句柄 / "最近本地文件"列表（无地 = 零托底）。
- ❌ 定时"你还没保存"提醒（烦人，是对 dirty 标记没做好的补偿）。
- ❌ 灾难恢复新机制（= revert，结案 parking）。
- 🅿 DDS（不留坑）、HDR、动图 GIF/像素动画、SVG 方向、Text Tool、原位粘贴（同意但后置）、iPad 接手势 spike（真机裁决）。
