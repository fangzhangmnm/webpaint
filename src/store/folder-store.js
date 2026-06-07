// Folder-shape Store facade（L4 ③）：rack / 滤镜预设 / 文档预设 等「确定性合并·零冲突」的 Folder。
// 与 work-file Store 共享「app 只读 status / store 拥 cadence」收口，但 shape-specific：
//   - 同步走 FolderFlow（pull-merge-push, entry uat-LWW, **零冲突决策**）——内置在本 store。
//   - cadence = 编辑后**防抖自动同步**（Folder 无冲突、union 安全，频繁推也行；work-file 是 consent push，不同）。
//   - status 含 busy（busy>no-auth>offline>dirty>synced），取代 app 手搓 deriveRackCloudState + _rackCloudState="busy"。
// app 注入（configure）：snapshot()=取当前 folder 数据；onResult(res)=采纳 merge 结果到模型 + 状态提示（doc/UI 语义留 app）；
//   canSync()=auth/online 门；onBusyChange()=busy 变化时刷 UI（store 不碰 DOM）。dirty 单源=注入的 cloud。
import { createFolderFlow } from "./folder-flow.js";

export function createFolderStore({ cloud, name, encode, decode, isOnline, flow, syncDelayMs = 1500 }) {
  const _flow = flow || createFolderFlow({ cloud, name, encode, decode, isOnline });   // flow 可注入（测试）
  let _syncing = false, _timer = null;
  let _snapshot = () => null, _onResult = async () => {}, _canSync = () => true, _onBusy = () => {};
  function configure({ snapshot, onResult, canSync, onBusyChange } = {}) {
    if (snapshot) _snapshot = snapshot;
    if (onResult) _onResult = onResult;
    if (canSync) _canSync = canSync;
    if (onBusyChange) _onBusy = onBusyChange;
  }

  const busy = { set: (v) => { _syncing = !!v; _onBusy(); }, syncing: () => _syncing };

  // shape-specific 状态机（含 busy）：busy > no-auth > offline > dirty > synced。
  function status({ signedIn = true, online = true } = {}) {
    if (_syncing) return "busy";
    if (!signedIn) return "no-auth";
    if (!online) return "offline";
    return cloud.isDirty(name) ? "dirty" : "synced";
  }
  function isDirty() { return cloud.isDirty(name); }
  function setDirty(d) { cloud.setDirty(name, d); }

  function _clearTimer() { if (_timer != null) { clearTimeout(_timer); _timer = null; } }
  // edit：标脏 + 防抖排自动同步（停手 ~1.5s 推；切笔 per-doc 不脏 rack，故不会狂推）。
  function edit() { setDirty(true); _clearTimer(); _timer = setTimeout(() => { _timer = null; sync(); }, syncDelayMs); }
  // flush：取消防抖、若脏立即同步（关 sheet 等显式点）。
  function flush() { _clearTimer(); return isDirty() ? sync() : Promise.resolve(); }
  // sync：canSync 门 → snapshot → FolderFlow.sync（merge）→ onResult（app 采纳 + 提示）。busy 自管。
  async function sync() {
    if (!_canSync()) return { status: "skipped" };
    const folder = _snapshot();
    if (!folder) return { status: "noop" };
    busy.set(true);
    try {
      const res = await _flow.sync(folder);
      await _onResult(res);
      return res;
    } finally { busy.set(false); }
  }

  return { configure, busy, status, isDirty, setDirty, edit, flush, sync };
}
