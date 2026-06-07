// 笔架 sheet 的纯 view-model（A3，见 docs/reports/20260606-fresh-geological-survey.html）。
// 给 rack 数据 + 状态标志 → 派生「显示什么」。无 DOM / 无 IDB / 无 cloud。
// 笔架的 IDB 落盘 / cloud push（rackFolderFlow.sync）/ draft 生命周期是编排，留在 app
// （同 adoptLoadedDoc 的判断——不把 IDB/网络拖进模块冒充深度）。

// 云态机：登录 / 在线 / 脏 → 图标态枚举。
//   "busy"（上传中）是 push 进行中由 app 显式置，不在纯派生里。
export function deriveRackCloudState({ signedIn, online, dirty }) {
  if (!signedIn) return "no-auth";
  if (!online) return "offline";
  if (dirty) return "dirty";
  return "synced";
}

// 某工具的 brush 列表 → folder 名集合（保序去重；空则给默认夹）。
export function collectFolders(brushes, defaultFolder) {
  const set = new Set();
  for (const b of brushes) set.add(b.folder || defaultFolder);
  if (set.size === 0) set.add(defaultFolder);
  return [...set];
}

// 选某 folder 内的 brush（folder 缺省归默认夹）。
export function brushesInFolder(brushes, folder, defaultFolder) {
  return brushes.filter((b) => (b.folder || defaultFolder) === folder);
}
