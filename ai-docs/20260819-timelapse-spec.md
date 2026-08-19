# Timelapse 终稿 spec（宣发轮 sprint）

> as-of 2026-08-19 · 基线 main=e052714 (v0.9.10) · 本文 = 2026-08-19 grill 收敛终稿，**已获实现 consent**（含 ora 格式新 entry 的显式同意，见 §5）。
> supersedes `docs/20260727-timelapse-design.md`（只存在于分支 worktree-timelapse-doc@628ed8d，从未 merge）。翻案项标 ⚡ 并注明旧案，防止实现者读到旧 doc 时被带偏。

读者预设：不熟 WebPaint 的实现 agent。目标场景 = **宣发素材**（找画手用 WebPaint 画图发视频引流）+ 学习分享。7-27 旧 doc 的场景 1「proof of work」已随 opt-in 决策一起死（见 §3）。

## 0. 一段话总览

每次事务 commit 采一帧画布合成图，H.264 硬编（WebCodecs VideoEncoder）成**解包直接可播**的单 mp4，随 .ora 保存落盘。用户显式开录（per-doc、默认关），开录时 pin 死取景框（比例+最长边），录制中右下状态栏常驻红点。无预算、无 consolidation、无重编码管线——体积靠采集端按 commit 数调和衰减自然走 log 曲线。导出 = 从 ora 抠出 mp4，尾帧定格 5s。

## 1. ⚡ 取景框：开录烤死，白边填充

旧案（7-27 §6）：crop/resize 处断段、每段原生 aspect、导出沿变换链重投影三策略。**整节作废。**

- 开录面板三控件：**比例 chips**（`1:1 · 4:3 · 3:4 · 16:9 · 9:16`，默认 1:1）+ **最长边**（`64 · 128 · 256 · 512 · 720 · 1080`，默认 512）+ 开录按钮。
- 开录即 pin，**中途不可改**（要改 = 清除重录）。短边按比例算出后取偶（编码器只要求偶数；16 对齐非硬约束）。
- 每帧独立把当时画布 fit-居中进取景框，**白边**填充（静态区 = skip 宏块，码率上≈免费）。
- 中途 crop/resize/旋转：不是特殊事件，下一帧内容在框里重新 fit，视频里表现为一次大小跳变。**跳变诚实，零补间零元数据。**
- 选单每档最长边旁标**参考体积「约 xMB」**（口径见 §4 表）——是参考不是承诺。

## 2. 采集与编码

### 采帧（何时加帧）

- 钩子：事务 commit 后（**含 undo**——悔笔要录进去），GPU 合成图 blit 到小 FBO，fence/PBO 异步 readback，不碰 60fps 热路径。长笔画只出一帧。
- 零可见变化的 commit（空笔/纯选区）跳过；dirty-bbox 用于跳帧判定。
- **Debounce 调和衰减（本 spec 核心公式，⚡ 取代旧案 30% 预算+consolidation）**：

  ```
  debounce 窗口 = 2s × (1 + n / N₀)
  ```

  n = 该录像累计见过的 commit 数（随录像持久化，见 §5）；N₀ = 每档常数 ≈ 全速录 1 个参考 MB 的 commit 数（512 档 ~330，其余档按帧成本比例标定）。
  体积走 `B·ln(1+n/N₀)` 的 log 曲线：512 档典型画作 ~1-2MB，5000-commit 马拉松 ~3MB，**永不失控故无需任何事后瘦身**。
  - 为什么按 commit 不按活跃时间：time-is-ticking 焦虑（挂机思考不该消耗采样密度），且排线/碎笔阶段 n 涨得快 → 被狠快进，正是快进该发生的地方（user 2026-08-19 拍板）。
  - 为什么调和不用几何（有界 2B）：几何让超长画作后期几乎失明，违背 timelapse 本义；log 发散慢到等于有界，后期密度只线性变稀。
  - log 映射符合人类认知：早期细看、后期快进。

### 编码（插什么帧）

- **H.264 硬编，WebCodecs VideoEncoder**。运行时 `VideoEncoder.isConfigSupported()` 守卫，不支持 → 菜单录制项灰掉+说明文案，绝不影响画画。支持面：Safari/iPadOS 16.4+ 有 VideoEncoder（16.4–18.7 是"仅视频接口"的部分 WebCodecs——我们恰好只要视频），Chrome 94+。
- 帧型 I+P 不用 B。码率模式 = 低目标码率 CBR/VBR **不用固定 QP**——码控的"静态沉淀"效应：运动小时剩余码字自动打磨静态区，狂涂段糊（在快进）、细抠时背景澄清，天然契合 timelapse 观感。**每档分辨率内部钉一个调好的质量参数，码率永不暴露给用户。**
- **双编码器架构**（旧 doc §5 原样保留，是全 spec 最精的一刀）：
  - 运动编码器 M：session 内长驻有状态，只见运动帧，输出 IDR+P+P… 链，从不知道尾帧存在。
  - 尾帧编码器 F：每次保存开一次性编码器，把当前画布现编成**同分辨率、高码率**的单张 IDR（⚡ 旧案"高清"曾隐含更高分辨率——为 §3 直接可播改为同分辨率，清晰靠码字不靠像素），用完即弃，纯函数。
  - 文件 = [M 运动分片…][F 尾帧分片]。下次保存：截尾帧分片 → 续写 M 新 P 帧 → 追加新尾帧。M 参考链不含尾帧故截尾零漂移。收尾帧**永远 gen-0**（每次保存从活画布现编）。
  - 反面教训（勿重蹈）：单编码器又编运动又编尾帧再 pop → 编码器内部参考含已删帧 → 解码漂移花屏。
- **IDR 事件**：session 冷启动（API 墙：无主流 API 暴露参考帧注入）/ 暂停后重开 / 每 N 百帧 seek 保底。

## 3. ⚡ UX：opt-in + 红点，翻掉「默认静默开」

旧案（7-27 §8）：默认静默开，理由是 proof-of-work「只有默认开才成立」。**翻案理由（user 原话大意）：Procreate 常年不开录制，全局静默反而 discouraging；隐私全控制更好——spiral 的时候可以关，构图 grill 完了再开，宣发可以只录中间，更适合社交表演的本质。** proof-of-work 场景随之死亡，隐私角（录像留住已删内容/参考照片）也随 opt-in 自动消解。

- **主菜单主动开**。per-document、绝不串扰、默认关、**sticky**（开关状态随文档持久化，跨 session 续录）。不做"新画自动录"全局开关（那是 default-on 借尸还魂）。
- **录制指示 = 安全护栏，全局常驻可见**（不许藏进菜单）：右下角状态栏，红点（CSS 呼吸）+ i18n 短词一条 key：`录` / `REC` / `録画` / `lukin`。点击直达录制控制（暂停/体积实况/清除）。
- **关 = 纯暂停**，已录素材一字节不动；**清除录像 = 独立显式按钮**（防误触，删不可逆）。
- 暂停再开：视频里就是一次内容跳变（断片=剪视频），重开走新 IDR，不记"此处停录过"。
- **自愈 = 止损不重建**：崩溃尾分片坏 → 截到最后完整分片继续录；整条流坏到没法 append → 静默停录+红点消失，画照画 ora 照存，**录像永远不许绑架画画和保存路径**。注意：opt-in 世界里"视频=历史的纯函数可重导"已不成立（无操作日志），丢了就是丢了。
- 崩溃语义合家规 interrupt=cancel：帧只随保存落盘，崩溃丢"上次保存之后的帧"，与未保存笔画同命，无独立恢复机制。

## 4. ⚡ 体积哲学：无预算、无 consolidation

旧案（7-27 §3/§7）：30% 预算 clamp + 超预算 decode→抽稀→re-encode→原子换名。**整套蒸发。** 理由：①预算只为静默默认开时替不知情用户控体重，consent 世界里"胖得知情"；②decimate 旧料+新料全速 = 后期细录早期粗录，方向反了，正解是采集端衰减（§2）；③管线是最大一块代码肥肉，宣发短录像根本用不上。

用户面对的全部技术面 = **比例 + 最长边 + 开关 + 清除**。事前选单参考体积、事中状态栏实况体积、事后嫌胖清除重录。

帧成本 grounding（绘画类内容，静态区 skip 几乎免费，成本只在笔画 bbox）：

| 最长边 | IDR | P 帧/笔 | 每百帧参考 | 选单标注 |
|---|---|---|---|---|
| 64 | ~1KB | ~0.2KB | ~30KB | 约 0.1MB |
| 128 | ~3KB | ~0.5KB | ~80KB | 约 0.2MB |
| 256 | ~8KB | ~1-2KB | ~0.2MB | 约 0.5MB |
| 512 | ~15-25KB | ~2-5KB | ~0.5-1.5MB | 约 2MB |
| 720 | ~30-50KB | ~4-8KB | ~1-3MB | 约 4MB |
| 1080 | ~60-100KB | ~8-15KB | ~2-6MB | 约 8MB |

（选单标注口径=典型完整画作的 log 曲线落点，实现时按真实编码输出校准数字，别照抄。）

## 5. 存储：跟 ora（sidecar 否决），两个新 entry【已获 user consent 2026-08-19】

- sidecar 否决理由：store 要懂配对关系 = 红线区动土；跟 ora 则改名/移动/回收站/加密(.7z)/删文档全自动继承，store 零改动零红线。代价 = ora 整文件重传的同步带宽，由 §4 的 log 体积曲线兜住。
- 新 entry（ora 对其他 reader 仍是合法 zip，GIMP/Krita 无视陌生条目）：
  - **`timelapse.mp4`**：放**中间大块区**（mergedimage.png 旁）。**绝不能放到 Thumbnails/thumbnail.png 之后**——thumbnail 钉死最后 entry 是云端 byte-range 契约（`src/gallery/cloud-thumbs.ts` 只拉尾 80-128KB），见 `src/backend/ora.ts` 头注释。
  - **`.webpaint/timelapse.json`**：录制状态（n 计数器、开关 sticky、pin 的比例/最长边）。独立小条目，**不塞进 `.webpaint/editor-state.json`**——那是 desk struct 有自己的 Serialize 通道，录制状态是 doc 级不是桌面 UI 级。
- 图库/文档信息显示「已录制 · x.xMB」。

## 6. 直接可播的 mp4（解包即 VLC/QuickTime 能放）

旧案说"唯一读者、frame_num 不讲究、导出必重编码归一"。方块世界里直接可播只需三个便宜自律，**买**：

1. 尺寸全程恒定（§1 开录 pin 死送了一半）；
2. 尾帧同分辨率高码率（单一 SPS）；
3. muxer 单调时间戳、拼接只发生在 IDR 边界（IDR 重置解码器，播放器安全）。

**muxer = vendor `mp4-muxer` v5.2.2**（源码审计 2026-08-19 完成，选型报告见本节尾注）：MIT、运行时零依赖、全源 2316 行/6 文件、bundle 实测 28.4KB min / 8.4KB gzip、红旗扫描全零（无 eval/网络/埋点）。已被作者废弃（继任 mediabunny）——由 vendor 模型吸收：mp4 容器是冻结规范，2300 行自己养。mediabunny 否决：110KB min（4 倍）+ MPL-2.0 + 5.8 万行审不动。
- vendor 最小集合：`src/{box,index,misc,muxer,target,writer}.ts` + LICENSE 原样拷进 `src/vendor/mp4-muxer/`，**不裁**音频/hevc 死代码（esbuild tree-shake 兜底，裁剪=对 vetted 源引入 drift）。
- 接入注意：VideoEncoder 配 `avc: {format:'avc'}`（length-prefixed 非 annexb），avcC 取首个 key chunk 的 `decoderConfig.description` 传 `addVideoChunkRaw` 的 meta。
- 尾帧定格：`addVideoChunkRaw(..., duration_µs)` 最后一帧显式 duration=5_000_000 即成（stts/trun 两路径源码已核实）。
- 工作流 = 内存攒裸 chunk 字节（可序列化进 ora），每次保存整体 re-mux（mux 便宜，纯容器）。既然整文件本在内存，`fastStart:'in-memory'`（moov 前置普通 mp4）兼容面比 fragmented 只宽不窄，实现时两挡都留（一个枚举值）。
- 审计源码留档：`~/jupyter/third-party/mp4-muxer/`、`~/jupyter/third-party/mediabunny/`。

## 7. 导出

- **裸导出 = 从 ora 抠出 `timelapse.mp4` 存文件**，零重编码（§6 已保证可播）。
- **结尾定格 5s**：muxer 把最后一帧（gen-0 收尾帧）时间戳拉长 5s，常数不做旋钮。
- 回放节奏参考：10fps，百帧=10s 成片；512 档 3 小时画 ≈ 90s 片。
- mp4 无播放器普遍尊重的"禁 loop"元数据（loop 是播放器/平台决定）；5s 定格就是现实里最好的 anti-loop。
- ☠️ **水印卡「Made with WebPaint」已否决**（user 2026-08-19：「你觉得我的整个产品设计哲学我会喜欢水印？」）。旧 doc §1/§9 有此条，勿复活。
- 高级导出（运镜/里程碑停顿）随 §1 翻案一起死，无变换链无里程碑。

## 8. 实现注意

- WebCodecs 是纯浏览器 API（`window.VideoEncoder`），零 npm 零后端。node 测试没有此全局 → 编码器包薄注入槽（同 `ora.ts` `setOraLogReporter` 模式），衰减/debounce/分片记账/muxer 全部纯 node 可测，真编码只在浏览器冒烟 + user 真机瞄一眼（Safari 有部分实现前科，但 feature-gate 兜底本来就要写，不做专门探针轮）。
- 状态栏 i18n：一条 key 四语（zh/en/ja/tok=`lukin`），走 i18n SSoT，漏译=编译错。红点是 styled dot 不需进图标库；若要配小眼睛图标走 `20260708 SVG Icons` 对账流程。
- 分片 append-only 进内存录制态，随保存序列化进 ora（每次保存重写整 zip，无就地 append）。
- 版本号：timelapse = 新功能纪元 → **minor bump（0.10.0？）**，按家规 bump 前先问 user 要不要把之前版本 push prod。

## 9. 已否决清单（防复活）

| 项 | 出处 | 死因 |
|---|---|---|
| 操作日志重放 / 连续视频录制 | 7-27 §2 | 路线 C 胜出，不变 |
| 分段原生 aspect + 导出重投影 | 7-27 §6 | §1 取景框烤死 |
| 默认静默开 + proof-of-work 场景 | 7-27 §1/§8 | §3 opt-in |
| 30% 预算 + consolidation + 采集预算退避 | 7-27 §3/§7 | §4 调和衰减 |
| 里程碑高清帧 | 7-27 §9 | 无 consolidation 无世代问题，高质量帧只剩收尾一张 |
| 水印卡 | 7-27 §1/§9 | user 否决 |
| 尾帧更高分辨率 | 7-27 §5 隐含 | §6 直接可播要单 SPS |
| 设备探针轮 | 7-27 §9 | 网查+运行时 isConfigSupported+feature-gate 兜底 |
