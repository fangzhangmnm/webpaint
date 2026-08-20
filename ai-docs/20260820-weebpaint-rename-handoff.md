# WeebPaint 改名 handoff（宣发 sprint 内执行）

> **战报 2026-08-20 深夜：主体执行完毕。** v0.10.0 全量改名（含内部 key）已推 dev；.ora=新写旧读双认+`weebpaint:format=1` schema 戳（双读回归测试在 test/ora-rename-dualread.test.mjs）；prod 快照 v0.9.35 先行；文件夹/家族引用/OneDrive `.webpaint→.weebpaint` 均完成。**§1 的公私仓预案被推翻**（2026-08-20 深夜 grill）：走**公开工坊道**——现仓 rename `weebpaint` 保真史公开+毕业分拣（全绿零手术），并升级 custom domain **weebpaint.com** 正宫（cert/双通道/301 全绿，Azure 现役 `18c496a6` 已补新 URI，真机开通）。终态见家族 CLAUDE.md「家/出货模型」2026-08-20 修订节 + memory `project_webpaint_rename`。余量=微画未 pin、icon/README 内容轮、0.10 推 prod（user 一起验）。

> as-of v0.9.29 / 2026-08-20 晚
> 读者 = 执行改名的 agent（不预设读过本轮聊天）。协调 agent 只跟进度，执行归你。
> 出处纪律：标【原话】= user 2026-08-20 本轮聊天逐字/近逐字；其余为 AI 整理、user 过目。

## 0. 一句话任务

WebPaint → **WeebPaint / 微画**（EN/中文成对），全仓关键词**全量改（含内部 key）**，本地文件夹名一起改，git 按家/出货模型开公私仓。DDL 随宣发：周五 2026-08-22 最晚发。

## 1. 拍板清单（防 re-litigate）

- 名字 = **WeebPaint / 微画**。拼写一致性是红线：【原话】「我肯定忍不了两个 e 不一样的名字。这个我宁愿延期。这个是最需要透明诚实的」。全仓不许出现 `weeebpaint` / `Weeb Paint` 等变体；大小写按各处上下文惯例（品牌显示 `WeebPaint`，slug/key 小写 `weebpaint`）。
- 【原话】「关键字全量改，现在只有我在用，不用做旧版本迁移和 backward compatibility」「这是最后一次捏人的机会」——**内部 key 也改**（IDB `DB_NAME="webpaint"`、`localStorage` 的 `webpaint.*`、SW cache 名等），不写迁移 shim、不留兼容读旧库。
- 文件夹名也改（user 拍板）：`20260524 WebPaint` → `20260524 WeebPaint`。
- git 布局 = 家/出货模型 **WebRings 同款公私仓**（聚合仓 CLAUDE.md「家/出货模型」节，2026-08-18 拍板）：现 `github.com/fangzhangmnm/webpaint` 私有化（孵化仓继承真历史），新开公仓 `weebpaint` **只收构建产物**（`/`=prod、`/dev/`=dev）。「push prod 必问」映射为「push site 仓根目录必问」。
- CLIENT_ID **不换**（ADR-0022：换注册=新 appfolder，永不）。
- 后置项（本轮不做）：云同步对外开放（微软商户实名验证已提交、等待中）；旧公仓历史清洗；itch HTML 内嵌（走橱窗+外链）。宣发对陌生用户走 store 缺席/local-only 变体，文案诚实标注。

## 2. 已完成（Azure 腿全通，user 2026-08-20 晚亲手实测）

- 新路径 redirect URI **已加**（portal 可编辑，租户受限传闻对本注册不成立）。
- Azure display name + publisher domain **已改 WeebPaint**。
- OneDrive `Apps/WebPaint` → `Apps/WeebPaint` 手动改名，金丝雀 `20260820 canary.ora` 写盘落对夹、图库列举正常——**approot 跟随文件夹改名自愈实锤**。
- 结论：你没有任何微软侧依赖，路径/repo 可全量迁。

## 3. 执行范围与顺序

1. **前置安全门（开工先问 user 一句）**：各设备 dirty 是否已全部同步上云。内部 key 换名 = 旧本地 IDB 成孤儿，云是唯一真身份（数据安全词典序：云端不丢画 >> 一切）。
2. **全仓关键词 sweep**：src / test / tools / scripts / 根文件（index.html、manifest.webmanifest、package.json、service-worker.js、styles、deploy.yml、README 等）。内部 key、DB 名、cache 名、boot 快照 key（`webpaint.boot.theme` 在 index.html 内联脚本里）一起改。
   - ⚠ deploy.yml 有资产白名单前科（漏了=静默 404，见 canvas-templates 战例）——改完核对白名单与新路径。
   - manifest：name/short_name/start_url/scope/icons 路径全过一遍；已装 PWA 会断，user 已知情（重装即可）。
   - i18n SSoT：中文显示名=**微画**，en=WeebPaint；ja/tok 的处置按 SSoT 四语规则自己判断，拿不准问 user。
3. **文件夹名**：`20260524 WebPaint` → `20260524 WeebPaint`。同步改家族引用：聚合仓 CLAUDE.md、各 sibling 仓里的 `../../20260524 WebPaint/...` 相对引用（工具链样板引用最多）。共享记忆里的路径引用由协调 agent 管，不用你动。
4. **公私仓布局**（破坏性步骤逐个问 user）：新建公仓 `weebpaint`（只收 dist）→ 接 Pages → 现仓改私有。旧 URL 处置（redirect 页/直接死）问 user。
5. `gen-api.sh` 重打 api/（39 处旧名自愈）。
6. **验收 = InPrivate 整体验**（user 提议）：无痕开新 URL → local-only 全流程（新建/画/保存/重开）→ user 账号登录验新 redirect URI → 装 PWA。放在落地后、push prod 前。

## 4. 死区不碰

- `journal/`（硬规则 #2，人类区）。
- git 历史（私仓化后的历史清洗=发后另案）。
- `ARCHIVE/`、`.deprecated/`。
- ai-docs 存量（612 处/109 文件）按「留=诚实历史」处理，不强改；新写 doc 用新名。

## 5. 普查底账（2026-08-20，开工自己重跑核对）

| 区域 | 处数/文件数 |
|---|---|
| src | 214 / 50 |
| test | 84 / 19 |
| api | 39 / 13（gen-api 重打自愈） |
| ai-docs | 612 / 109（考古区，不强改） |
| scripts | 23 / 2 |
| tools | 7 / 4 |
| vendor | 2 / 2（看一眼是不是注释，别动 vendor 本体逻辑） |
| 根文件 | 54 |

## 6. 交付定义（透明报账是硬要求）

- 交付时给**全仓 `grep -ri webpaint` 余量清单**：哪些已改、哪些故意留（journal/ARCHIVE/ai-docs 考古/git 历史），一条条列，不许静默漏网。
- 版本：改名批建议随宣发进 **0.10.0** 纪元——bump 前按家规问 user 要不要先把旧版推 prod。
- 测试全绿 + dev bundle 重打 + InPrivate 验收过，才算落盘。

## 7. 相关但不归你的活（协调侧记账）

- timelapse 校准常数（等 user dogfood 录像）；夏音大头 → icon 平面设计轮（logotype 走烤轮廓 path 管线，不等 text tool）；README 重写 + itch 橱窗文案；push prod（必问）。
