// Gallery 文件夹模型（A2 出生；C3 瘦身后 = 纯展示助手）。
// 纯数据（无 DOM / 无网络 / 无 store）。
// 旧的 mergeLocalCloud/sliceFolder/mergeTrash/classifyCloudGone/folderHasContents 已被 store 库
// 收编（listing.ts / watchFolder 切片 / trash-merge.ts / reconcile.ts——网盘模型 2026-07-11 拍板），
// 本模块只剩 gallery UI 自己的展示纯函数与列表项类型。

// 本模块只读这些字段；local session / cloud file 本体仍是未类型化 .js。
import { t } from "../i18n/index.ts";
import { sessionBareName, sessionFileName } from "../config.ts";

export interface LocalSession { name: string; updatedAt?: number; }
export interface CloudFile { path: string; name?: string; lastModifiedDateTime?: string; }
export interface GalleryItem { name: string; local: LocalSession | null; cloud: CloudFile | null; deletedAt?: number; }

// item 的展示时间（本地 updatedAt 优先，否则云端 lastModifiedDateTime）。
export function itemTime(it: GalleryItem): number {
  return (it.local?.updatedAt) || Date.parse(String(it.cloud?.lastModifiedDateTime || 0));
}

// 复制项目的目标名（纯）：源全路径 → 同文件夹下「<basename> 副本」/「<basename> 副本2」…首个不撞的。
//   sourceName = 源 item 的完整 name（含文件夹前缀，如 "插画/猫"）；taken(name) = 该全路径名是否已被占用
//   （本地⊕云端的并集，调用方传入；同步谓词，无网络）。副本保持在源同一文件夹（path 前缀不变）。
//   后缀策略：第一份不带数字（"猫 副本"），之后递增（"猫 副本2"、"猫 副本3"…）；护栏上限防 taken 恒 true 死循环。
export function copyTargetName(sourceName: string, taken: (name: string) => boolean): string {
  const slash = sourceName.lastIndexOf("/");
  const folder = slash < 0 ? "" : sourceName.slice(0, slash);
  const base = slash < 0 ? sourceName : sourceName.slice(slash + 1);
  const join = (stem: string) => (folder ? `${folder}/${stem}` : stem);
  const SUF = t("name.copySuffix");
  let candidate = join(`${base} ${SUF}`);
  if (!taken(candidate)) return candidate;
  for (let i = 2; i < 1000; i++) {
    candidate = join(`${base} ${SUF}${i}`);
    if (!taken(candidate)) return candidate;
  }
  return join(`${base} ${SUF}${Date.now()}`);
}

// 新身份的唯一裸名（v0.10.4 从 gallery-shell 提出成纯函数供 pin）。
//   「不静默覆盖旧画」链的第 2 层兜底：第 1 层 = 调用方预检（如 openImageTile 的孪生占用门），
//   第 3 层 = store 首存 mode:"new" 护栏（占用抛 CloudNameCollisionError，绝不覆盖）。
//   base（sessionBareName 归一化后）未占用即用；占用 → "base 1"…"base 19"；全占 → 时间戳兜底。
//   occupied(fullName) 收**库全名 X.ora**（store.files.nameOccupied 的入参约定）；异步（在线含云端一跳）。
export async function uniqueBareName(stem: string, occupied: (fullName: string) => Promise<unknown>): Promise<string> {
  const base = sessionBareName(stem);
  if (!(await occupied(sessionFileName(base)))) return base;
  for (let i = 1; i < 20; i++) {
    const candidate = `${base} ${i}`;
    if (!(await occupied(sessionFileName(candidate)))) return candidate;
  }
  return `${base} ${Date.now()}`;
}
