# GPU tile 池冷开渲染不全 postmortem（「夏音案」）

> as-of v0.10.8 / 2026-08-20

## 症状

Procreate 导入的满画布 33 层画（PSD→ora 转换件，1838×1689）首次打开**图层渲染不全**，
静置不自愈；**点几下图层眼睛后自愈**；保存后同 session 重开正常；**硬刷新（Ctrl+Shift+R）后
重开又坏**——包括 WeebPaint 自己重存过的文件。

文件无罪（已证）：问题 ora 与 WeebPaint 重存版 stack.xml 逐字节相同（除 wrote-with 戳）、
33 层 PNG 逐像素相同。复现夹具留档：
`OneDrive/2D/20260426 natsune (old ver)/20260426-夏音v0.1.psd2ora-bug-repro-首开渲染不全.ora`。

## 根因（四个坑，同一条管线）

数字背景：GPU tile 池初始 64 slot（16MiB），reserve() 惰性翻倍至 quota 1024（256MiB）；
该画静态打开时全组 pass-through 展开、无 dynamic unit → render-plan 把整幅并成
**一个 withBg prefix 段**，成员 ~29 叶共 **688 tile**。

1. **withBg 段需求漏算**（render-tree 旧 :140）：预检只数 `allTiles`（=56 拷贝目标格），
   漏数合成时必须同时驻留的 688 成员格 → `reserve(56)` 在 64 slot 冷池上静默放行不扩容。
2. **sync→compose 驱逐窗口**：全部成员先 sync 完、后统一建段；64 槽装 688 tile 连环驱逐
   （成员叶仅 preferred 档），段合成时 IndexTexture 采到已被复写的 slice → 整层缺失/串内容。
3. **残缺结果被冻结**：段缓存有效性只查段自身 tile（`_segValid`）+ display 签名命中快路径
   → 之后每帧只 present，永不重试。`syncLeafSafe` 吞 `GPU_POOL_EXHAUSTED` 零上报，console 无痕。
4. **段命中判定先于 reserve**（user 猜中的坑）：reserve grow = recreate **全部现存 gpu id 作废**，
   但已被记成「命中」的段不重判，死段照画。
   另：降级模式（reserve 被拒）旧代码干脆不 sync 段成员——注释写「慢但对」，实际整层消失。

「点眼睛自愈」的真相：每次 markDirty 重建段 → `reserve(allocatedCount+56)` 且 allocated≈capacity
→ **每点一下池容量翻倍**（64→128→…→1024），翻到装得下为止。「保存后重开正常」= 池容量
session 内保持；硬刷新回 64 → 复发。

## 修（v0.10.8，统一驻留协议）

- **`src/backend/gl/frame-demand.ts`（新，纯逻辑 node 全测）**：需求精算
  （`residentMissTiles` 问 bridge 存活只数 miss + `segCopyTiles` withBg=全图/其余=成员键并集）
  + `admitWithRegrow` 两段式准入（reserve 后 generation 变了 → 重扫死段重估再 reserve 一次）。
- **render-tree.renderFrame**：逐段「就地 sync 成员 → 立刻合成」——驱逐窗口=0；
  准入被拒时同一条路只是段不入池（transient），慢但**真的对**。live 叶 pin required 档不变。
- **raster-service.compositeOnce**（保存 mergedimage/导出/吸管/timelapse 共用）：旧版
  **完全没有 reserve**，冷池上保存/导出会静默缺层（画作字节走 CPU exportData 恒无损，
  但 mergedimage/导出 PNG 可能残）。现与 renderFrame 同口径准入 + 逐段驻留。
- **可观测**：`room.syncStats.drops` 计数吞掉的 EXHAUSTED；board 每帧盯涨、log 级 5s 节流上报；
  HUD 第二行尾缀 `dN`（`!` 仍表本帧降级）。

## 验证

- node 全量 1046 绿（含 frame-demand 新套件：withBg 需求回归钉、两段式 regrow 重扫钉）。
- 真机验收（待跑）：硬刷新 → 打开夹具 ora → 首帧即完整；HUD 无 `d` 计数。
  纯静置（不点眼睛）也应完整——这是病征 3 的杀招验证。

## 遗留观察点

- 超 quota 的巨画（>1024 tile 工作集）走 transient 慢路：每帧重合成，帧率会掉但画面正确，
  HUD 显 `!`。若真机遇到，再谈 quota 提升/分块 present。
- 池 grow 的 recreate 语义（全量作废）是既定设计（防显存双峰）；两段式准入已覆盖其正确性。
