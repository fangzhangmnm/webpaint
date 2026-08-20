// <wp-cloud-picker> 的宿主适配层（C9 约定 §5：每组件一个；组件 store 零知识，store 接线全在这）。
//   数据面：watchFolderImages（app-store，图片白名单反向 filter）→ listing property 下灌；
//   缩略图：gallery/image-thumbs（整图下载自压 jpeg + IDB 缓存）经 fetchThumb provider 注入；
//   选中：openCloudImage 整份拉字节 → File 包装（名字 = 云端 basename，「有名保名」命名规范的上游）。
//   三入口（图库＋菜单 / 图层＋号 / 参考窗）都调 pickCloudImage()，路由语义归各宿主入口。
// spec = ai-docs/20260820-cloud-image-picker-spec.md。

import { WpCloudPicker, WP_CLOUD_PICKER_TAG } from "./frontend/cloud-picker.ts";
import type { CloudPickerImage } from "./frontend/cloud-picker.ts";
import { watchFolderImages, openCloudImage } from "./app-store.ts";
import { getOrFetchImageThumb, imageThumbToken } from "./gallery/image-thumbs.ts";
import { mimeForImageName } from "./gallery/cloud-image-model.ts";
import { t } from "./i18n/index.ts";
import { reportError } from "./error-badge.ts";
import type { AppContext } from "./app-context.ts";

const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e);

// initCloudPickerHost(ctx) 填入（构造期 null，回调 lazy 读）。
let gallery: AppContext["gallery"], withBusy: AppContext["withBusy"], setStatus: AppContext["setStatus"];

let _el: WpCloudPicker | null = null;
let _unsub: (() => void) | null = null;
let _resolve: ((r: File | null) => void) | null = null;


function _ensureEl(): WpCloudPicker {
  if (_el) return _el;
  const el = document.createElement(WP_CLOUD_PICKER_TAG) as WpCloudPicker;
  el.labels = {
    root: t("cp.root"), back: t("cp.back"), close: t("common.close.aria"), loading: t("cp.loading"),
  };
  // slot 文案（light DOM，宿主 i18n；语言切换 = 整页 reload，一次即可）
  const title = document.createElement("span");
  title.slot = "title";
  title.textContent = t("cp.title");
  const empty = document.createElement("span");
  empty.slot = "empty";
  empty.textContent = t("cp.empty");
  el.append(title, empty);
  // 缩略图 provider：miss = 整图下载自压（并发池在组件、去重在 image-thumbs）
  el.fetchThumb = async (item: CloudPickerImage) => {
    try { return await getOrFetchImageThumb(item.path, imageThumbToken(item)); }
    catch (e) { reportError(new Error("[cloud-picker] thumb failed: " + errMsg(e)), "log"); return null; }
  };
  el.addEventListener("navigate", (e) => _goto((e as CustomEvent).detail.folder as string));
  el.addEventListener("close", () => _finish(null));
  el.addEventListener("pick", async (e) => {
    const item = (e as CustomEvent).detail as CloudPickerImage;
    try {
      const blob = await withBusy(t("cp.downloading", { name: item.name }), () => openCloudImage(item.path));
      if (!blob) { setStatus(t("cp.downloadFailed", { name: item.name }), true); return; }   // 拿不到（离线未缓存等）：picker 留着，用户可换一张
      _finish(new File([blob], item.name, { type: mimeForImageName(item.name) }));
    } catch (err) {
      reportError(new Error(t("cp.downloadFailed", { name: item.name }) + ": " + errMsg(err)), "warning");
    }
  });
  document.body.appendChild(el);
  _el = el;
  return el;
}

function _goto(folder: string) {
  const el = _ensureEl();
  _unsub?.();
  el.folder = folder;
  el.loading = true;
  // watchFolder 语义：立即本地帧、云端到了同一 cb 再闪（listing setter 自动清 loading）
  _unsub = watchFolderImages(folder, (snap) => {
    el.listing = { images: snap.images, folderNames: snap.folderNames };
  });
}

function _finish(r: File | null) {
  _unsub?.();
  _unsub = null;
  if (_el) _el.open = false;
  const res = _resolve;
  _resolve = null;
  res?.(r);
}

/**
 * 打开云盘图片选择器，resolve 选中的图片 File（取消/关闭 → null）。
 * 初始夹 = 图库当前夹（user 拍板「跟随当前夹」，零持久化字段）。重入安全：旧 promise 先以 null 收口。
 */
export function pickCloudImage(): Promise<File | null> {
  _finish(null);   // 已开着（不该发生）→ 旧的先收口
  const el = _ensureEl();
  return new Promise<File | null>((resolve) => {
    _resolve = resolve;
    el.open = true;
    _goto(gallery.getFolder());
  });
}

export function initCloudPickerHost(ctx: AppContext) {
  gallery = ctx.gallery;
  withBusy = ctx.withBusy;
  setStatus = ctx.setStatus;
}
