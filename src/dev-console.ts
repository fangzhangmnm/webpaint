// 职责（单一）：window.WeebPaint 调试/POC 控制台接口——云缩略图 POC + 插件注册暴露 + thumb 缓存统计。
//   纯调试面：console 里手敲 WeebPaint.* 验证云缩略图 byte-range 拉取、看缓存命中、给插件挂注册口。
//   非业务逻辑，所有依赖直接 import（无 ctx），由 app 启动时调一次 initDevConsole()。
import { fetchOraThumbnail } from "./gallery/cloud-thumbs.ts";
import { store } from "./app-store.ts";
import { registerFilter, listFilters } from "./filters.ts";
import { registerExporter, listExporters } from "./exporters.ts";
import {
  clearCloudThumbCache,
  stats as cloudThumbStats,
  config as cloudThumbConfig,
  resetStats as cloudThumbResetStats,
} from "./gallery/cloud-thumb-cache.ts";
import { clearImageThumbCache } from "./gallery/image-thumbs.ts";

// 调试控制台 = 一袋 console 手敲的函数（非业务）。诚实描述实际挂上的成员，index 兜底插件扩展。
declare global {
  interface Window {
    WeebPaint?: {
      fetchOraThumbnail?: typeof fetchOraThumbnail;
      cloudThumbStats?: () => unknown;
      cloudThumbResetStats?: () => void;
      cloudThumbSkipCache?: (on?: boolean) => void;
      clearCloudThumbCache?: () => Promise<number>;
      pocFetchThumb?: (name?: string) => Promise<Blob>;
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
  //   await WeebPaint.pocFetchThumb()  默认拉云列表第一个 ora 验证
  const WP = (window.WeebPaint = window.WeebPaint || {});
  WP.fetchOraThumbnail = fetchOraThumbnail;
  WP.cloudThumbStats = () => ({ cache: { ...cloudThumbStats } });   // 路径分布（硬扫/CD/加密）已下沉进库 getPeek，不再从 app 暴露
  WP.cloudThumbResetStats = () => { cloudThumbResetStats(); };
  WP.cloudThumbSkipCache = (on = true) => {
    cloudThumbConfig.skipCache = !!on;
    console.log(`[cloud-thumb] skipCache=${cloudThumbConfig.skipCache}`);
  };
  WP.clearCloudThumbCache = async () => {
    const n = await clearCloudThumbCache();
    console.log(`[cloud-thumb] cleared ${n} cached thumbnails`);
    return n;
  };
  // 云盘图片 picker 的缩略图缓存（image-thumbs store，与 ora 缩略图分开；无损可再生）
  WP.clearImageThumbCache = async () => {
    const n = await clearImageThumbCache();
    console.log(`[image-thumbs] cleared ${n} cached thumbnails`);
    return n;
  };
  WP.pocFetchThumb = async function (name?: string) {
    // fetchOraThumbnail 按**裸 session 名**（item.name，无后缀）走 store.getPeek（zip 解析在库内部）。
    //   POC 需显式给该 name（从 gallery tile 取 item.name）；不再是 OneDrive itemId / fileSize。
    if (!name) throw new Error("pocFetchThumb needs an explicit bare session name (item.name)");
    const t0 = performance.now();
    const blob = await fetchOraThumbnail(name, "local");   // POC 诊断：本地优先（旧行为）；要看云端字节自己改 "cloud"
    console.log(`POC done in ${(performance.now() - t0) | 0}ms, blob size ${blob.size}`);
    // 显示到 console（可见 thumbnail）
    const url = URL.createObjectURL(blob);
    console.log("thumbnail URL (click in console to preview): ", url);
    const img = new Image();
    img.src = url;
    document.body.appendChild(img);
    img.style.cssText = "position:fixed;top:60px;right:16px;z-index:99999;border:2px solid red;max-width:256px";
    setTimeout(() => { img.remove(); URL.revokeObjectURL(url); }, 10000);
    return blob;
  };

  // 回收站/备份箱管理（控制台调；backup 无 gallery UI——面板是以后的事，先控制台能清）。
  //   scope: "local" | "cloud" | "both"（默认 both）。listTrash/listBackup 返两端聚合的元数据（无 blob）。
  WP.listTrash = () => store.files.listTrash();
  WP.listBackup = () => store.files.listBackup();
  WP.emptyTrash = (scope: "local" | "cloud" | "both" = "both") => store.files.emptyTrash({ scope });
  WP.emptyBackup = (scope: "local" | "cloud" | "both" = "both") => store.files.emptyBackup({ scope });

  // 暴露给 plugin（v131）：window.WeebPaint.registerFilter(FilterClass)
  // 插件自己写 buildBody，可以放色环 / 自定义 canvas / 任何 DOM（user：「插件自己提供 UI」）
  WP.registerFilter = registerFilter;
  WP.listFilters = listFilters;
  // candidate 2：导出格式同样可插件注册（下载插件 → registerExporter）
  WP.registerExporter = registerExporter;
  WP.listExporters = listExporters;
}
