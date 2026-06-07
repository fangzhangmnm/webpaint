// Folder-shape Store facade（L4 ③）：rack / 滤镜预设 / 文档预设 等「确定性合并·零冲突」的 Folder。
// 与 work-file Store 共享同款「app 只读 status」收口，但语义是 shape-specific：
//   - 同步走 FolderFlow（pull-merge-push, entry uat-LWW, 零冲突决策）——不在此模块（③a 先收 busy/status）。
//   - status 含 busy（work-file 的 busy 在 store.busy，这里 Folder 自带），取代 app 手搓 deriveRackCloudState
//     + _rackCloudState="busy" 双轨（报告 C4：两套 sync-icon 态机合一）。
// dirty 单源 = 注入的 cloud（rackSync 的 cloud.isDirty/setDirty(name)）。
export function createFolderStore({ cloud, name }) {
  let _syncing = false;
  const busy = { set: (v) => { _syncing = !!v; }, syncing: () => _syncing };

  // Folder-shape 状态机（含 busy）：busy > no-auth > offline > dirty > synced。
  // signedIn/online 是 app context（auth/网络），调用方传入；同步返回，给 UI 高频查。
  function status({ signedIn = true, online = true } = {}) {
    if (_syncing) return "busy";
    if (!signedIn) return "no-auth";
    if (!online) return "offline";
    return cloud.isDirty(name) ? "dirty" : "synced";
  }

  return {
    busy,                                   // 同步进行中（app 的 sync 编排置位，status 读取）
    status,                                 // shape-specific 状态派生（含 busy）——取代 deriveRackCloudState
    isDirty: () => cloud.isDirty(name),
    setDirty: (d) => cloud.setDirty(name, d),
  };
}
