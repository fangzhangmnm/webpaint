// tile-jobs —— tile 池压缩的 app 级接线（组合根从 app.ts 调一次）：
//   ① deflate codec 接入池（此后 raw quota 才 enforcement——超额阻塞压缩，宁卡不爆）
//   ② 池泄漏 assert → error-badge funnel（level "log"：开发期线索，不打扰用户）
//   ③ background-sync-jobs：空闲时按预算切片压缩最古老 tile
//   ④ 切后台（visibilitychange hidden）→ 全量 compactAll（用户看不见，卡也无妨）
// 返回 disposer（真 app 永不调；app-boot 测试靠它拆 interval/监听，否则 node 进程挂死）。

import { BackgroundSyncJobs } from "./background-sync-jobs.ts";
import { appTilePool, setTilePoolCodec, setTilePoolLeakReporter } from "./backend/tiles/app-tile-pool.ts";
import { deflateTileCodec } from "./backend/tiles/cpu-tile-compression.ts";
import { reportError } from "./error-badge.ts";

const TICK_MS = 250;

export function initTileJobs(): { jobs: BackgroundSyncJobs; dispose: () => void } {
  setTilePoolCodec(deflateTileCodec);
  setTilePoolLeakReporter((info) => reportError(new Error("[tile-pool] " + info), "log"));

  const jobs = new BackgroundSyncJobs({
    onError: (name, e) => reportError(new Error(`[bg-jobs] handler "${name}" 抛错: ${String(e)}`), "warning"),
  });

  // tile 压缩：低优先级循环 handler。budget = 距 deadline 的剩余毫秒。
  const unregCompact = jobs.register("tile-compact", 10, (deadlineTs) => {
    const budget = deadlineTs - performance.now();
    return appTilePool().compactOldest(budget) === "more" ? "requeue" : "done";
  });

  const noteInput = () => jobs.noteInput();
  const inputEvents = ["pointerdown", "pointermove", "wheel", "keydown", "touchstart"] as const;
  for (const ev of inputEvents) window.addEventListener(ev, noteInput, { capture: true, passive: true });

  const onVis = () => { if (document.visibilityState === "hidden") appTilePool().compactAll(); };
  document.addEventListener("visibilitychange", onVis);

  const timer = setInterval(() => jobs.tick(), TICK_MS);

  return {
    jobs,
    dispose: () => {
      clearInterval(timer);
      unregCompact();
      for (const ev of inputEvents) window.removeEventListener(ev, noteInput, { capture: true } as EventListenerOptions);
      document.removeEventListener("visibilitychange", onVis);
    },
  };
}
