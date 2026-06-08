// Gallery 文件夹模型（A2，见 docs/reports/20260606-fresh-geological-survey.html）。
// 纯数据（无 DOM / 无网络 / 无 store）：本地⊕云列表合并 + 当前文件夹层切片。
// 过去内联在 app.js 的 renderGallery —— 「按 name 合并 local/cloud」「按当前文件夹切 immediate
// 子夹 vs 直属文件」是真领域逻辑、跟 DOM 渲染无关，抽出可单测。

// 合并本地 session 列表 + 云端文件列表 → 统一 item 列表（ADR-0011 身份=GUID，name 是可变属性）。
//   item = { name(规范名,显示/ops 用), guid|null, local|null, cloud|null, renamedFrom?(本地旧名,待收敛) }
// 配对优先级：① GUID（两边都有且相等）→ ② name（任一缺 GUID 时兜底）。
// **数据完整性守卫**：name 命中但两边 GUID **都有且不等** = 两个不同身份恰好撞名 → **绝不配对**（各起一卡）。
// GUID 配对成功但 name 不同（别设备改名 / provider dedup）→ 云端 path 为权威名，标 renamedFrom 待 app 收敛本地。
export function mergeLocalCloud(local, cloud) {
  const items = [];
  const byGuid = new Map();   // guid → item
  const byName = new Map();   // name → item
  for (const l of local) {
    const item = { name: l.name, guid: l.guid || null, local: l, cloud: null };
    items.push(item);
    if (l.guid) byGuid.set(l.guid, item);
    byName.set(l.name, item);
  }
  for (const c of cloud) {
    const cname = c.path.replace(/\.ora$/i, "");
    const cguid = c.guid || null;
    let ent = (cguid && byGuid.get(cguid)) || byName.get(cname) || null;
    if (ent && cguid && ent.guid && ent.guid !== cguid) ent = null;   // 撞名但不同身份 → 不配
    if (ent && ent.cloud) ent = null;                                 // 该 local 已被别的 cloud 占 → 不配
    if (ent) {
      ent.cloud = c;
      if (cguid) ent.guid = cguid;
      if (ent.local && ent.local.name !== cname) {                    // GUID 配对但名异 → 云端权威，待收敛
        ent.renamedFrom = ent.local.name;
        ent.name = cname;
      }
    } else {
      const item = { name: cname, guid: cguid, local: null, cloud: c };
      items.push(item);
      if (cguid) byGuid.set(cguid, item);
      byName.set(cname, item);
    }
  }
  return items;
}

// item 的展示时间（本地 updatedAt 优先，否则云端 lastModifiedDateTime）。
export function itemTime(it) {
  return (it.local?.updatedAt) || Date.parse(it.cloud?.lastModifiedDateTime || 0);
}

// 切当前文件夹层 → { folderNames（immediate 子夹，字母序）, files（直属文件，新→旧） }。
//   allItems = mergeLocalCloud 结果；cloudFolders = 云端真文件夹路径（含空夹）；folder = 当前路径（""=根）
export function sliceFolder(allItems, cloudFolders, folder) {
  const prefix = folder ? `${folder}/` : "";
  const folderSet = new Set();    // 当前层 immediate sub-folder name
  const files = [];                // 当前层 direct child files
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
  files.sort((a, b) => itemTime(b) - itemTime(a));
  const folderNames = [...folderSet].sort((a, b) => a.localeCompare(b));
  return { folderNames, files };
}

// 文件夹是否有内容（item 或子夹以它为 prefix）—— 非空时禁删，避免级联删整棵子树。
export function folderHasContents(allItems, cloudFolders, folderPath) {
  const fullPrefix = `${folderPath}/`;
  return allItems.some((it) => it.name.startsWith(fullPrefix)) ||
    cloudFolders.some((f) => f.startsWith(fullPrefix));
}
