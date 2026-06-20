// Gallery 展示派生（UI 深化 candidate 1 · gallery）。
//
// 纯函数：把 store.list() 解析出的 item（{name, local|null, cloud|null, dirty}）+ 运行态
// （signedIn / 当前活动名）→ 组件渲染需要的「显示什么」。零 DOM / 零网络 / 零 store。
// 数据解析（本地⊕云 merge / dirty）在 store（app-store.listGallery）；文件夹切片 / 路径代数
// 在 gallery-model.js + gallery-path.js（已测）；这里只补**展示层派生**：徽章 4 态、面包屑、tile 字段。
//
// 复用形状：item 形状通用、徽章/面包屑无 ORA 依赖 → 整块可抬给 AtlasMaker/RealHome（WebPaint 专用 example）。

import { pathBasename } from "../gallery-path.ts";
import { itemTime } from "../gallery-model.ts";
import type { GalleryItem, CloudFile, LocalSession } from "../gallery-model.ts";

// 本地 session 包（listSessions 的元素 + 图库消费的运行态字段：缩略图 Blob / 字节大小 /
// 加密标志 / 回收站 key）。store 本体仍是 .js，这里只声明图库读到的字段。
export interface LocalSessionMeta extends LocalSession {
  size?: number;
  thumb?: Blob | null;
  encrypted?: boolean;
  trashKey?: string;
}

// 缩略图 provider（getOrFetchCloudThumb）读的云端文件字段：id / eTag / size / 下载直链。
export interface CloudFileMeta extends CloudFile {
  id?: string;
  eTag?: string;
  size?: number;
  "@microsoft.graph.downloadUrl"?: string;
}

// 图库消费的 item 形状：gallery-model 的 GalleryItem + 图库运行态（dirty / ghost）+
// local/cloud 的扩展元字段。
export interface GItem extends Omit<GalleryItem, "local" | "cloud"> {
  local: LocalSessionMeta | null;
  cloud: CloudFileMeta | null;
  dirty?: boolean;
  ghost?: boolean;
}

// 文件 tile 的同步徽章（图标 SVG 在组件 template 里按 kind 渲）。ghost = cloud-gone dirty 孤儿。
export type BadgeKind = "syncedBoth" | "dirtyBoth" | "cloudOnly" | "localOnly" | "ghost";

export interface GalleryTile {
  name: string;          // 全 path-name（key / 移动改名用）
  displayName: string;   // basename（子夹内只显文件名）
  fullPath: string;      // = name（tooltip）
  time: number;          // ms epoch
  size: number;          // bytes
  badge: BadgeKind;
  badgeTitle: string;
  ghost: boolean;        // cloud-gone dirty 孤儿（云端 path 被别的设备改名/删，本地有未推编辑）→ UI surface
  hasLocalThumb: boolean;
  cloud: CloudFileMeta | null;     // {id,eTag,size,downloadUrl?} 给 thumb provider；纯本地 = null
  isActive: boolean;
  encrypted: boolean;    // 本地字节是加密容器（ADR-0012）。纯云端项未知（thumb 拉回时按 MIME 现场识别）
}

export function tileFor(
  item: GItem,
  opts: { signedIn: boolean; activeName: string | null },
): GalleryTile {
  const isLocal = !!item.local, isCloud = !!item.cloud;
  let badge: BadgeKind, badgeTitle: string;
  if (item.ghost) {
    // ghost 优先：dirty 孤儿（曾 synced，云端 path 被别的设备改名/移动/删，本地有未推编辑）。
    //   不当普通 localOnly——明确 surface；badge≠localOnly 顺带让「推送到云端」按钮消失（防复活已删路径）。
    badge = "ghost"; badgeTitle = "云端副本已被移动或删除，本地有未推送的修改 —— 可「重命名留存」或「丢弃」";
  } else if (isLocal && isCloud) {
    if (opts.signedIn && item.dirty) { badge = "dirtyBoth"; badgeTitle = "本地+云端 · 本地有未推改动"; }
    else { badge = "syncedBoth"; badgeTitle = "本地+云端（已同步）"; }
  } else if (isCloud) {
    badge = "cloudOnly"; badgeTitle = "纯云端（未拉到本地）";
  } else {
    badge = "localOnly"; badgeTitle = opts.signedIn ? "仅本地（未上传云端）" : "本地";
  }
  return {
    name: item.name,
    displayName: pathBasename(item.name),
    fullPath: item.name,
    time: itemTime(item),
    size: (item.local?.size) || (item.cloud?.size) || 0,
    badge, badgeTitle,
    ghost: !!item.ghost,
    hasLocalThumb: !!(item.local && item.local.thumb),
    cloud: item.cloud || null,
    isActive: !!opts.activeName && item.name === opts.activeName,
    encrypted: !!(item.local && item.local.encrypted),
  };
}

// 面包屑：根 + 每段（current=最后一段 / 根无文件夹时）。
export interface Crumb { label: string; path: string; current: boolean; }

export function breadcrumb(folder: string): Crumb[] {
  const out: Crumb[] = [{ label: "/ 根目录", path: "", current: !folder }];
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
export interface TrashGItem {
  name: string;
  deletedAt?: number;
  local: LocalSessionMeta | null;
  cloud: CloudFileMeta | null;
}

// 展示格式化（纯）。humanTime 读 now：组件用，测试只覆 humanSize。
export function humanTime(ts: number): string {
  if (!ts) return "未知";
  const d = new Date(ts);
  const dt = Date.now() - ts;
  if (dt < 60 * 1000) return "刚刚";
  if (dt < 60 * 60 * 1000) return `${Math.floor(dt / 60000)} 分钟前`;
  if (dt < 24 * 60 * 60 * 1000) return `${Math.floor(dt / 3600000)} 小时前`;
  if (dt < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(dt / 86400000)} 天前`;
  return d.toLocaleDateString();
}
export function humanSize(b: number | null | undefined): string {
  if (b == null) return "?";
  if (b === 0) return "0 B";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

export function trashTileFor(item: TrashGItem): TrashTile {
  const src = item.local && item.cloud ? "本地+云端" : item.local ? "本地" : "云端";
  return {
    name: item.name,
    deletedAt: item.deletedAt || 0,
    source: src,
    hasLocalThumb: !!(item.local && item.local.thumb),
    cloud: item.cloud || null,
    local: item.local || null,
  };
}
