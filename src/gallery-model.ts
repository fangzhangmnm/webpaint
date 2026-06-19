// Gallery 文件夹模型（A2，见 docs/reports/20260606-fresh-geological-survey.html）。
// 纯数据（无 DOM / 无网络 / 无 store）：本地⊕云列表合并 + 当前文件夹层切片。
// 过去内联在 app.js 的 renderGallery —— 「按 name 合并 local/cloud」「按当前文件夹切 immediate
// 子夹 vs 直属文件」是真领域逻辑、跟 DOM 渲染无关，抽出可单测。

// 本模块只读这些字段；local session / cloud file / trash 本体仍是未类型化 .js。
export interface LocalSession { name: string; updatedAt?: number; }
export interface CloudFile { path: string; name?: string; lastModifiedDateTime?: string; }
export interface GalleryItem { name: string; local: LocalSession | null; cloud: CloudFile | null; deletedAt?: number; }
export interface LocalTrash { originalName: string; deletedAt?: number; }
export interface TrashItem { name: string; local: LocalTrash | null; cloud: CloudFile | null; deletedAt: number; }

// 合并本地 session 列表 + 云端文件列表，按 name（云端去 .ora/.zip 后缀——.zip=加密容器）当 key。
//   item = { name, local|null, cloud|null }（本模块保持零依赖纯函数，后缀剥离与 config.stripSessionExt 同步）
export function mergeLocalCloud(local: LocalSession[], cloud: CloudFile[]): GalleryItem[] {
  const byName = new Map<string, GalleryItem>();
  for (const l of local) byName.set(l.name, { name: l.name, local: l, cloud: null });
  for (const c of cloud) {
    const name = c.path.replace(/\.(ora|zip)$/i, "");
    const ent = byName.get(name);
    if (ent) ent.cloud = c;
    else byName.set(name, { name, local: null, cloud: c });
  }
  return [...byName.values()];
}

// item 的展示时间（本地 updatedAt 优先，否则云端 lastModifiedDateTime）。
export function itemTime(it: GalleryItem): number {
  return (it.local?.updatedAt) || Date.parse(String(it.cloud?.lastModifiedDateTime || 0));
}

// 回收站合并：本地 trash（{trashKey,originalName,deletedAt,thumb,size}）⊕ 云端 trash 文件，
// 按 originalName 配对 → 统一 item { name, local|null, cloud|null, deletedAt }，新→旧。
// 云端名要剥两层：.ora 后缀 + move-aside 撞名加的 ` [N]` 尾标。
export function mergeTrash(localTrash: LocalTrash[], cloudTrash: CloudFile[]): TrashItem[] {
  const byName = new Map<string, TrashItem>();
  for (const t of localTrash) {
    byName.set(t.originalName, { name: t.originalName, local: t, cloud: null, deletedAt: t.deletedAt || 0 });
  }
  for (const c of cloudTrash) {
    const name = (c.name || c.path || "").replace(/\.(ora|zip)$/i, "").replace(/ \[\d+\]$/, "");
    const dAt = Date.parse(String(c.lastModifiedDateTime || 0)) || 0;
    const ent = byName.get(name);
    if (ent) { ent.cloud = c; ent.deletedAt = Math.max(ent.deletedAt, dAt); }
    else byName.set(name, { name, local: null, cloud: c, deletedAt: dAt });
  }
  return [...byName.values()].sort((a, b) => b.deletedAt - a.deletedAt);
}

// 切当前文件夹层 → { folderNames（immediate 子夹，字母序）, files（直属文件，按文件名倒序） }。
//   allItems = mergeLocalCloud 结果；cloudFolders = 云端真文件夹路径（含空夹）；folder = 当前路径（""=根）
//   文件排序按 name 倒序（localeCompare，numeric）：新文档名是 yyyymmdd-xxxx，倒序 = 新日期在前，
//   且稳定——不像旧的 updatedAt 排序那样，一存盘就把旧文件顶到最前（用户感知为「按上次访问」）。
export function sliceFolder(allItems: GalleryItem[], cloudFolders: string[], folder: string): { folderNames: string[]; files: GalleryItem[] } {
  const prefix = folder ? `${folder}/` : "";
  const folderSet = new Set<string>();    // 当前层 immediate sub-folder name
  const files: GalleryItem[] = [];        // 当前层 direct child files
  for (const it of allItems) {
    if (folder && !it.name.startsWith(prefix)) continue;
    const rest = it.name.slice(prefix.length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx >= 0) folderSet.add(rest.slice(0, slashIdx));
    else if (rest) files.push(it);
  }
  // 云端真文件夹（含空）—— 文件夹模型单一真相源
  for (const f of cloudFolders) {
    if (folder) {
      if (f === folder || !f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const seg = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
      if (seg) folderSet.add(seg);
    } else {
      const first = f.split("/")[0];
      if (first) folderSet.add(first);
    }
  }
  files.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  const folderNames = [...folderSet].sort((a, b) => a.localeCompare(b));
  return { folderNames, files };
}

// cloud-gone 分类（纯）：哪些本地名是「曾 synced 但云端 path 没了」的孤儿，且该收敛还是 surface。
//   drop  = clean 孤儿（有 etag = 曾 synced、云端无此 path、无未推编辑）→ 调用方删本地缓存（改名/删除有效传播）。
//   ghost = dirty 孤儿（有未推编辑）→ surface 让用户选，**绝不删**。
//   无 etag = 真本地文件（从没上传）→ 永不碰。
// **硬护栏**：authoritative=false（云列表不权威：未登录/离线/list 失败/空列表）→ 返回全空，绝不收敛
//   （否则一次网络抖动会把所有本地缓存误判成 cloud-gone 全量删）。决策纯、可穷举测；副作用留 app 接缝。
export function classifyCloudGone(
  localNames: string[],
  cloudNameSet: Set<string>,
  { hasEtag, isDirty, authoritative }: { hasEtag: (name: string) => boolean; isDirty: (name: string) => boolean; authoritative: boolean },
): { drop: string[]; ghost: string[] } {
  const drop: string[] = [], ghost: string[] = [];
  if (!authoritative) return { drop, ghost };
  for (const name of localNames) {
    if (cloudNameSet.has(name)) continue;   // 云端还在 → 不是孤儿
    if (!hasEtag(name)) continue;           // 无 etag = 真本地文件 → 永不碰
    if (isDirty(name)) ghost.push(name);    // dirty 孤儿 → surface
    else drop.push(name);                   // clean 孤儿 → 收敛
  }
  return { drop, ghost };
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
  let candidate = join(`${base} 副本`);
  if (!taken(candidate)) return candidate;
  for (let i = 2; i < 1000; i++) {
    candidate = join(`${base} 副本${i}`);
    if (!taken(candidate)) return candidate;
  }
  return join(`${base} 副本${Date.now()}`);
}

// 文件夹是否有内容（item 或子夹以它为 prefix）—— 非空时禁删，避免级联删整棵子树。
export function folderHasContents(allItems: GalleryItem[], cloudFolders: string[], folderPath: string): boolean {
  const fullPrefix = `${folderPath}/`;
  return allItems.some((it) => it.name.startsWith(fullPrefix)) ||
    cloudFolders.some((f) => f.startsWith(fullPrefix));
}
