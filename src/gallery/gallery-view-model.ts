// Gallery 展示派生（UI 深化 candidate 1 · gallery）。
//
// 纯函数：把 store.list() 解析出的 item（{name, local|null, cloud|null, dirty}）+ 运行态
// （signedIn / 当前活动名）→ 组件渲染需要的「显示什么」。零 DOM / 零网络 / 零 store。
// 数据解析（本地⊕云 merge / dirty）在 store（app-store.listGallery）；文件夹切片 / 路径代数
// 在 gallery-model.js + gallery-path.js（已测）；这里只补**展示层派生**：徽章 4 态、面包屑、tile 字段。
//
// 复用形状：item 形状通用、徽章/面包屑无 ORA 依赖 → 整块可抬给 AtlasMaker/RealHome（WeebPaint 专用 example）。

import { t } from "../i18n/index.ts";
import { pathBasename } from "./gallery-path.ts";
import { itemTime } from "./gallery-model.ts";
import type { GalleryItem, CloudFile, LocalSession } from "./gallery-model.ts";

// 本地项（watchFolder 单夹快照的元素 + 图库消费的运行态字段：缩略图 Blob / 字节大小 /
// 加密标志 / 回收站 key）。store 本体仍是 .js，这里只声明图库读到的字段。
export interface LocalSessionMeta extends LocalSession {
  size?: number;
  thumb?: Blob | null;
  encrypted?: boolean;
  trashKey?: string;
}

// 云端文件元字段。缩略图走 store.getPeek（按 name，不再要 itemId/downloadUrl，内容盲）——
//   这里只留 size（新鲜度戳退路）；lastModifiedDateTime 在基类 CloudFile。
//   id 仅回收站 restore/purge 的 cloudItemId 用（store.listTrash 带回），缩略图路径不碰。
export interface CloudFileMeta extends CloudFile {
  id?: string;
  size?: number;
}

// 图库消费的 item 形状：gallery-model 的 GalleryItem + 图库运行态（dirty / ghost）+
// local/cloud 的扩展元字段。
export interface GItem extends Omit<GalleryItem, "local" | "cloud"> {
  local: LocalSessionMeta | null;
  cloud: CloudFileMeta | null;
  dirty?: boolean;
  ghost?: boolean;
  pendingGone?: boolean;   // clean cloud-gone 孤儿、防抖 grace 内（云端刚没了，本地干净副本待处理）
  cloudNewer?: boolean;    // 云端字节比本地新（newer-on-cloud / conflict）→ ThumbCell 取图走 source:"cloud"（见 app-store.itemToG）
}

// 文件 tile 的同步徽章（图标 SVG 在组件 template 里按 kind 渲）。ghost = cloud-gone dirty 孤儿；pendingGone = cloud-gone clean（grace 内）。
export type BadgeKind = "syncedBoth" | "dirtyBoth" | "cloudOnly" | "localOnly" | "ghost" | "pendingGone";

export interface GalleryTile {
  name: string;          // 全 path-name（key / 移动改名用）
  displayName: string;   // basename（子夹内只显文件名）
  fullPath: string;      // = name（tooltip）
  time: number;          // ms epoch
  size: number;          // bytes
  badge: BadgeKind;
  badgeTitle: string;
  ghost: boolean;        // cloud-gone dirty 孤儿（云端 path 被别的设备改名/删，本地有未推编辑）→ UI surface
  pendingGone: boolean;  // cloud-gone clean 孤儿、防抖 grace 内（照常显示 + badge；宽限后自动移入回收站；可「重新上传」/「删除」）
  hasLocalThumb: boolean;
  cloud: CloudFileMeta | null;     // {size,lastModifiedDateTime} 给 thumb provider（按 name+token 拉）；纯本地 = null
  isActive: boolean;
  encrypted: boolean;    // 本地字节是加密容器（ADR-0012），由 gallery 按夹探测注入。纯云端项未知（thumb 拉回时按 MIME 现场识别）
}

export function tileFor(
  item: GItem,
  opts: { signedIn: boolean; activeName: string | null; encrypted?: boolean },
): GalleryTile {
  const isLocal = !!item.local, isCloud = !!item.cloud;
  let badge: BadgeKind, badgeTitle: string;
  if (item.ghost) {
    // ghost 优先：dirty 孤儿（曾 synced，云端 path 被别的设备改名/移动/删，本地有未推编辑）。
    //   不当普通 localOnly——明确 surface；badge≠localOnly 顺带让「推送到云端」按钮消失（防复活已删路径）。
    badge = "ghost"; badgeTitle = t("gv.badge.ghost");
  } else if (item.pendingGone) {
    // pendingGone：clean 孤儿（曾 synced，云端 path 没了，本地干净副本）。防抖 grace 内照常显示 + 此 badge；
    //   宽限期后 reconcile 会自动移入回收站。用户可「重新上传」（推回云端）或「删除」（提前入回收站）。
    badge = "pendingGone"; badgeTitle = t("gv.badge.pendingGone");
  } else if (isLocal && isCloud) {
    if (opts.signedIn && item.dirty) { badge = "dirtyBoth"; badgeTitle = t("gv.badge.dirtyBoth"); }
    else { badge = "syncedBoth"; badgeTitle = t("gv.badge.syncedBoth"); }
  } else if (isCloud) {
    badge = "cloudOnly"; badgeTitle = t("gv.badge.cloudOnly");
  } else {
    badge = "localOnly"; badgeTitle = opts.signedIn ? t("gv.badge.localOnly") : t("gv.badge.localPlain");
  }
  return {
    name: item.name,
    displayName: pathBasename(item.name),
    fullPath: item.name,
    time: itemTime(item),
    size: (item.local?.size) || (item.cloud?.size) || 0,
    badge, badgeTitle,
    ghost: !!item.ghost,
    pendingGone: !!item.pendingGone,
    hasLocalThumb: !!(item.local && item.local.thumb),
    cloud: item.cloud || null,
    isActive: !!opts.activeName && item.name === opts.activeName,
    // 加密态由调用方探测后注入（store 的 Item 内容盲、没有 encrypted 轴）。
    //   v415 前这里读 item.local.encrypted —— 那个字段**从来没有写入者**，故恒 false。
    encrypted: !!opts.encrypted,
  };
}

// 面包屑：根 + 每段（current=最后一段 / 根无文件夹时）。
export interface Crumb { label: string; path: string; current: boolean; }

export function breadcrumb(folder: string): Crumb[] {
  const out: Crumb[] = [{ label: t("gv.rootDir"), path: "", current: !folder }];
  if (folder) {
    const segs = folder.split("/").filter(Boolean);
    let accum = "";
    segs.forEach((seg, i) => {
      accum = accum ? `${accum}/${seg}` : seg;
      out.push({ label: seg, path: accum, current: i === segs.length - 1 });
    });
  }
  return out;
}

// 回收站 tile：来源标签 + 删除时间 + thumb 线索。
export interface TrashTile {
  name: string;
  deletedAt: number;
  source: string;        // 本地 / 云端 / 本地+云端
  hasLocalThumb: boolean;
  cloud: CloudFileMeta | null;
  local: LocalSessionMeta | null;
}

// 回收站 item：deletedAt + 本地 trash 记录（含 thumb / trashKey）+ 云端文件。
//   encrypted：云端字节是加密容器（restore 落 encFileName）。conflictLive：离线删被 edit-wins 撤销 → 本地 trash 有、云端还活着（两存，UI surface）。
export interface TrashGItem {
  name: string;
  deletedAt?: number;
  local: LocalSessionMeta | null;
  cloud: CloudFileMeta | null;
  encrypted?: boolean;
  conflictLive?: boolean;
}

// 展示格式化（纯）。humanTime 读 now：组件用，测试只覆 humanSize。
export function humanTime(ts: number): string {
  if (!ts) return t("gv.time.unknown");
  const d = new Date(ts);
  const dt = Date.now() - ts;
  if (dt < 60 * 1000) return t("gv.time.justNow");
  if (dt < 60 * 60 * 1000) return t("gv.time.minAgo", { n: Math.floor(dt / 60000) });
  if (dt < 24 * 60 * 60 * 1000) return t("gv.time.hourAgo", { n: Math.floor(dt / 3600000) });
  if (dt < 7 * 24 * 60 * 60 * 1000) return t("gv.time.dayAgo", { n: Math.floor(dt / 86400000) });
  return d.toLocaleDateString();
}
// 家规：数据层裸字节、显示层二进制单位（KiB/MiB，1024 进制）——见 timelapse-state.ts 注释。
//   旧版 1024 进制却标 KB/MB（十进制单位名）是违约方，2026-08-21 改标 KiB/MiB/GiB。
export function humanSize(b: number | null | undefined): string {
  if (b == null) return "?";
  if (b === 0) return "0 B";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KiB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1048576).toFixed(1)} MiB`;
  return `${(b / 1073741824).toFixed(2)} GiB`;
}

export function trashTileFor(item: TrashGItem): TrashTile {
  const base = item.local && item.cloud ? t("gv.src.both") : item.local ? t("gv.src.local") : t("gv.src.cloud");
  const src = item.conflictLive ? t("gv.src.cloudStillAlive", { base }) : base;   // 离线删被撤销：本地 trash 有、云端还活着 → 提示两存
  return {
    name: item.name,
    deletedAt: item.deletedAt || 0,
    source: src,
    hasLocalThumb: !!(item.local && item.local.thumb),
    cloud: item.cloud || null,
    local: item.local || null,
  };
}
