// 职责（单一）：window.WebPaint 调试/POC 控制台接口——云缩略图 POC + 插件注册暴露 + thumb 缓存统计。
//   纯调试面：console 里手敲 WebPaint.* 验证云缩略图 byte-range 拉取、看缓存命中、给插件挂注册口。
//   非业务逻辑，所有依赖直接 import（无 ctx），由 app 启动时调一次 initDevConsole()。
import { fetchOraThumbnail } from "./cloud-thumbs.ts";
import { isSignedIn, listCloudSessionsRecursive } from "./app-store.ts";
import { registerFilter, listFilters } from "./filters.ts";
import { registerExporter, listExporters } from "./exporters.ts";
import {
  clearCloudThumbCache,
  stats as cloudThumbStats,
  config as cloudThumbConfig,
  resetStats as cloudThumbResetStats,
} from "./cloud-thumb-cache.ts";
import { telemetry as cloudThumbTelemetry, resetTelemetry as cloudThumbResetTelemetry } from "./cloud-thumbs.ts";

// 调试控制台 = 一袋 console 手敲的函数（非业务）。诚实描述实际挂上的成员，index 兜底插件扩展。
declare global {
  interface Window {
    WebPaint?: {
      fetchOraThumbnail?: typeof fetchOraThumbnail;
      cloudThumbStats?: () => unknown;
      cloudThumbResetStats?: () => void;
      cloudThumbSkipCache?: (on?: boolean) => void;
      clearCloudThumbCache?: () => Promise<number>;
      pocFetchThumb?: (itemId?: string, fileSize?: number) => Promise<Blob>;
      registerFilter?: typeof registerFilter;
      listFilters?: typeof listFilters;
      registerExporter?: typeof registerExporter;
      listExporters?: typeof listExporters;
      [k: string]: unknown;
    };
  }
}

export function initDevConsole() {
  // v136 POC: 云缩略图 byte-range 拉取 — console 调试
  //   await WebPaint.pocFetchThumb()  默认拉云列表第一个 ora 验证
  const WP = (window.WebPaint = window.WebPaint || {});
  WP.fetchOraThumbnail = fetchOraThumbnail;
  WP.cloudThumbStats = () => ({ cache: { ...cloudThumbStats }, paths: { ...cloudThumbTelemetry } });
  WP.cloudThumbResetStats = () => { cloudThumbResetStats(); cloudThumbResetTelemetry(); };
  WP.cloudThumbSkipCache = (on = true) => {
    cloudThumbConfig.skipCache = !!on;
    console.log(`[cloud-thumb] skipCache=${cloudThumbConfig.skipCache}`);
  };
  WP.clearCloudThumbCache = async () => {
    const n = await clearCloudThumbCache();
    console.log(`[cloud-thumb] cleared ${n} cached thumbnails`);
    return n;
  };
  WP.pocFetchThumb = async function (itemId?: string, fileSize?: number) {
    if (!itemId) {
      // 自动找第一个云端 ora
      if (!isSignedIn()) throw new Error("没登录云");
      const list = await listCloudSessionsRecursive();
      if (!list.length) throw new Error("云端没 session");
      const first = list[0];
      itemId = first.id; fileSize = first.size;
      console.log("POC：拉", first.path, "size", fileSize);
    }
    const t0 = performance.now();
    // 手动路径可只给 itemId（fileSize 由 byte-range 探测）；auto 路径两者都填。运行时契约不变。
    const blob = await fetchOraThumbnail(itemId, fileSize as number);
    console.log(`POC 完成 ${(performance.now() - t0) | 0}ms, blob size ${blob.size}`);
    // 显示到 console（可见 thumbnail）
    const url = URL.createObjectURL(blob);
    console.log("thumbnail URL（在 console 点击预览）：", url);
    const img = new Image();
    img.src = url;
    document.body.appendChild(img);
    img.style.cssText = "position:fixed;top:60px;right:16px;z-index:99999;border:2px solid red;max-width:256px";
    setTimeout(() => { img.remove(); URL.revokeObjectURL(url); }, 10000);
    return blob;
  };

  // 暴露给 plugin（v131）：window.WebPaint.registerFilter(FilterClass)
  // 插件自己写 buildBody，可以放色环 / 自定义 canvas / 任何 DOM（user：「插件自己提供 UI」）
  WP.registerFilter = registerFilter;
  WP.listFilters = listFilters;
  // candidate 2：导出格式同样可插件注册（下载插件 → registerExporter）
  WP.registerExporter = registerExporter;
  WP.listExporters = listExporters;
}
