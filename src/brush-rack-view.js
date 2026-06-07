// 笔架 sheet 的纯 view-model（A3，见 docs/reports/20260606-fresh-geological-survey.html）。
// 给 rack 数据 + 状态标志 → 派生「显示什么」。无 DOM / 无 IDB / 无 cloud。
// 笔架的 IDB 落盘 / cloud push（rackFolderFlow.sync）/ draft 生命周期是编排，留在 app
// （同 adoptLoadedDoc 的判断——不把 IDB/网络拖进模块冒充深度）。

// 云态机已迁入 createFolderStore.status（L4 ③：含 busy，rack=Folder Store 实例）——
// 旧 deriveRackCloudState 已删；这里只剩笔架视图的 folder 派生。

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
