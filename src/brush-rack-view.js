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

// 笔刷 tile preview 的 CSS radial-gradient（按 hardness 出 smoothstep 多 stop，跟 stamp 真值一致）。
// 纯字符串构造，无 DOM。<RackSheet> tile 用它当 preview background。
// v107：smoothstep multi-stop；v108 BUG FIX：closest-side（默认 farthest-corner=√2×半宽，100% stop 跑框外角 → 视觉框边）。
export function smoothstepRadialGradient(hardness, stops = 16) {
  const hd = Math.max(0, Math.min(1, hardness));
  const out = [];
  for (let i = 0; i <= stops; i++) {
    const t = i / stops;
    let alpha;
    if (t <= hd) alpha = 1;
    else {
      const u = (t - hd) / (1 - hd);
      alpha = 1 - u * u * (3 - 2 * u);
    }
    const pct = (t * 100).toFixed(1);
    const apct = (alpha * 100).toFixed(1);
    out.push(`color-mix(in srgb, var(--ink) ${apct}%, transparent) ${pct}%`);
  }
  return `radial-gradient(circle closest-side, ${out.join(", ")})`;
}
