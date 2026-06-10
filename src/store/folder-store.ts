// Folder-shape Store facade（L4 ③）：rack / 滤镜预设 / 文档预设 等「确定性合并·零冲突」的 Folder。
// 与 work-file Store 共享「app 只读 status / store 拥 cadence」收口，但 shape-specific：
//   - 同步走 FolderFlow（pull-merge-push, entry uat-LWW, **零冲突决策**）——内置在本 store。
//   - cadence = 编辑后**防抖自动同步**（Folder 无冲突、union 安全，频繁推也行；work-file 是 consent push，不同）。
//   - status 含 busy（busy>no-auth>offline>dirty>synced），取代 app 手搓 deriveRackCloudState + _rackCloudState="busy"。
// app 注入（configure）：snapshot()=取当前 folder 数据；onResult(res)=采纳 merge 结果到模型 + 状态提示（doc/UI 语义留 app）；
//   canSync()=auth/online 门；onBusyChange()=busy 变化时刷 UI（store 不碰 DOM）。dirty 单源=注入的 cloud。
import { createFolderFlow } from "./folder-flow.ts";
import type { FolderFlow, FolderFlowResult } from "./folder-flow.ts";
import type { FolderEnvelope, ResolveFn } from "./folder-merge.ts";
import type { Bytes, CloudSync } from "./types.ts";

export type FolderStatus = "busy" | "no-auth" | "offline" | "dirty" | "synced";

// createFolderStore 注入配置（cloud/name/encode/decode/isOnline 透传给内置 FolderFlow）。
export interface FolderStoreConfig {
  cloud: CloudSync;
  name: string;
  encode: (folder: FolderEnvelope) => Bytes | Blob;
  decode: (text: string) => FolderEnvelope | null;
  resolve?: ResolveFn;
  isOnline?: () => boolean;
  flow?: FolderFlow;            // flow 可注入（测试）
  syncDelayMs?: number;
}

// app 经 configure 注入的钩子（模型/UI 语义留 app）。
export interface FolderStoreHooks {
  snapshot?: () => FolderEnvelope | null;
  onResult?: (res: FolderFlowResult) => void | Promise<void>;
  canSync?: () => boolean;
  onBusyChange?: () => void;
}

export function createFolderStore(cfg: FolderStoreConfig) {
  const { cloud, name, encode, decode, isOnline, flow, syncDelayMs = 1500 } = cfg;
  const _flow: FolderFlow = flow || createFolderFlow({ cloud, name, encode, decode, isOnline });   // flow 可注入（测试）
  let _syncing = false;
  let _timer: ReturnType<typeof setTimeout> | null = null;
  let _snapshot: () => FolderEnvelope | null = () => null;
  let _onResult: (res: FolderFlowResult) => void | Promise<void> = async () => {};
  let _canSync: () => boolean = () => true;
  let _onBusy: () => void = () => {};
  function configure({ snapshot, onResult, canSync, onBusyChange }: FolderStoreHooks = {}) {
    if (snapshot) _snapshot = snapshot;
    if (onResult) _onResult = onResult;
    if (canSync) _canSync = canSync;
    if (onBusyChange) _onBusy = onBusyChange;
  }

  const busy = { set: (v: boolean) => { _syncing = !!v; _onBusy(); }, syncing: () => _syncing };

  // shape-specific 状态机（含 busy）：busy > no-auth > offline > dirty > synced。
  function status({ signedIn = true, online = true }: { signedIn?: boolean; online?: boolean } = {}): FolderStatus {
    if (_syncing) return "busy";
    if (!signedIn) return "no-auth";
    if (!online) return "offline";
    return cloud.isDirty(name) ? "dirty" : "synced";
  }
  function isDirty() { return cloud.isDirty(name); }
  function setDirty(d: boolean) { cloud.setDirty(name, d); }

  function _clearTimer() { if (_timer != null) { clearTimeout(_timer); _timer = null; } }
  // edit：标脏 + 防抖排自动同步（停手 ~1.5s 推；切笔 per-doc 不脏 rack，故不会狂推）。
  function edit() { setDirty(true); _clearTimer(); _timer = setTimeout(() => { _timer = null; sync(); }, syncDelayMs); }
  // flush：取消防抖、若脏立即同步（关 sheet 等显式点）。
  function flush() { _clearTimer(); return isDirty() ? sync() : Promise.resolve(); }
  // sync：canSync 门 → snapshot → FolderFlow.sync（merge）→ onResult（app 采纳 + 提示）。busy 自管。
  // dirty 收尾（K12，审计 2026-06-10）：cloud.pull 已纯读不再顺手清 dirty，收尾归这里——
  //   "synced" 才清（pushed:true 时 push 已清，pushed:false=本地贡献已在云端，这里显式清）；
  //   "dirty"/"offline"/"invalid" 一律保留 dirty → status 不再谎报 synced、flush()/下次 sync 真会重试。
  //   旧版 bug：pull 先清 dirty、push 失败无人恢复 → 「已留待重试」是谎报，本机笔刷贡献永滞本机。
  async function sync() {
    if (!_canSync()) return { status: "skipped" };
    const folder = _snapshot();
    if (!folder) return { status: "noop" };
    busy.set(true);
    try {
      const res = await _flow.sync(folder);
      if (res.status === "synced") {
        if (res.etag) cloud.setETag(name, res.etag);   // pull 纯读后 kv etag 也归这里推进
        cloud.setDirty(name, false);
      }
      await _onResult(res);
      return res;
    } finally { busy.set(false); }
  }

  return { configure, busy, status, isDirty, setDirty, edit, flush, sync };
}
