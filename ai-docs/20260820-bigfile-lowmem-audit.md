# 超大文件 × 小内存设备审计（死循环 + 泄漏门 + 崩溃环断路器）

> as-of v0.10.9 / 2026-08-20（「夏音案」后续轮；GPU 池冷开案见 20260820-gpu-pool-cold-open-postmortem.md）

## 1. 内存压力下的循环审计——全部有界，无死循环

- `CpuTilePool._enforceRawQuotaBlocking`：单次有界 for（最坏把全部 tile 压缩一遍，raw→0 必收敛）。
  阻塞卡顿有可能（宁卡不爆是既定设计），死循环不可能。
- `GpuTilePool.reserve` 翻倍环：`totalSlices > maxSlices` 先行返 false；容量恒 ≥1，`cap*2` 单调升，
  `Math.min(maxSlices, …)` 收口。有界。
- `_evictForSpace`：候选集有限，塞不下 throw `GPU_POOL_EXHAUSTED`。有界。
- `admitWithRegrow`（v0.10.8 新）：最多两轮（第二轮扫描已是全量，再 recreate 不改变需求）。
- 降级 transient 帧：display 签名命中后走快路径只 present，静止画面不空转。
- `background-sync-jobs` tile-compact：压缩单调推进（raw→compressed 不回头）→ 必达 "done"。

## 2. 真死循环在 app 生命周期层：OOM 崩溃重启环（已修，v0.10.9）

病理：小内存设备开超大文件 → decode/驻留期间 tab 被系统杀 → PWA 重启 → boot-restore 读
持久 currentFile 无条件自动重开同一张画 → 再被杀 → **锁死环，用户连图库都进不去**。
纪律②「失败不清 currentFile」防的是优雅失败（取消密码/离线返 false）；OOM 是 tab 直接死，
永远走不到失败分支——两条纪律之间正好漏了崩溃这一格。

修（纪律③，崩溃环断路器）：
- `appState.restoreAttempt`（**新持久字段**，device-local，user 2026-08-20 批准）：boot 自动开画前
  写目标名 + `flushAppState()` 强制落盘（冷写是 400ms 防抖，OOM 比它快）；成功或优雅失败清 null。
- 冷启动「标记 == 想开的画」⇒ 上次死在开它的半路 → 跳过自动开、停图库、状态行提示
  （`mi.restoreCrashLoop`，四语）；标记保留（此后每 boot 都跳），直到任意画成功打开
  （`setCurrentSessionName` 清标记，重新武装自动开）。
- 纪律②语义不受损：优雅失败仍清标记、仍保 currentFile，下次照常 retry。
- 编排纯函数在 boot-restore.ts（端口注入），node 测试 9 条含：断路时 restore 不被调、
  标记→flush→restore 顺序、瞬态失败不毒化、陈旧标记自然失效。

残余风险（接受）：手动从图库开必死巨画仍会崩（用户可见因果，非锁死）；崩后 boot 只跳自动开。

## 3. tile 句柄泄漏门（npm test 从「退出噪音」升级为红灯）

- 病理：CpuTilePool 的 FinalizationRegistry 泄漏 assert 只在进程退出时打 console，
  不红测试——5 个泄漏在套件里躺了很久没人认领（broken windows）。
- 修：`test/run.mjs` 全绿后强制 GC×3 + 排水 finalizer，有泄漏 exit 1（npm test 带 `--expose-gc`；
  裸跑 node 静默跳过）。存量 5 漏全清（polygon-lasso ×3 / filter-gate ×1 / magic-drag ×1——
  全是测试把 Selection 塞进假 doc 后不 dispose；生产所有权链核过是干净的）。
- 调查工具（出生栈猎手，per-handle 记栈防同 tile 多句柄覆盖）在 job tmp `leak-hunt.mjs`，
  未入仓；再遇泄漏门变红按同法定位。

## 4. 已知内存上限（未修，观察）

decode/load 全量物化（PaintingData 直字节 + tiles），无流式：iPad Safari tab ~1.4GB 墙下，
4096² × 几十层的 Procreate 满画布导入可能开不进来。现状 = 断路器保证崩了不锁死。
若真机撞墙，再谈按需解码/分层惰载（大改，另立 spec）。
