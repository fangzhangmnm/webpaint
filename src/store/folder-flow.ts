// ┌──────────────────────────────────────────────────────────────────────────┐
// │ GENERIC — Folder shape 同步循环（pull-merge-push）over 一个 CloudSync 实例。  │
// │ app-agnostic 深模块；备 merge-up 到 MyPWAPatterns/sync-store/。               │
// │                                                                              │
// │ offline-first 铁律：正确性来自 folder-merge（CRDT-lite），**不来自 gate**。     │
// │ 编辑永远本地即时（app 侧），这里只在能连时后台 reconcile：pull → merge → push。 │
// │ 离线/慢网超时/伪在线 → 退回本地、留 dirty、绝不丢本地、绝不让脏字节进 merge。     │
// │                                                                              │
// │ 分工：merge 在库内、零回调（folder-merge）。encode/decode（envelope 格式 +     │
// │ 旧格式迁移）是 transport 关注点，由 app 注入——这跟 CloudSync 收 fileName/      │
// │ contentType 一样，不是 merge 逻辑外泄。                                        │
// └──────────────────────────────────────────────────────────────────────────┘

import { mergeFolders, emptyFolder, normalizeFolder } from "./folder-merge.ts";
import type { FolderEnvelope, ResolveFn } from "./folder-merge.ts";
import type { Bytes, CloudSync } from "./types.ts";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms) return p;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { _timeout: true })), ms)),
  ]);
}
const is412 = (e: unknown): boolean => {
  const x = e as { name?: string; status?: number } | null;
  return !!x && (x.name === "CloudConflictError" || x.status === 412);
};

// FolderFlow.sync 结果（status 见下）。
export interface FolderFlowResult {
  status: "synced" | "offline" | "invalid" | "dirty";
  folder: FolderEnvelope;
  etag?: string | null;
  pushed?: boolean;
  error?: unknown;
}

// createFolderFlow 注入配置。
export interface FolderFlowConfig {
  cloud: CloudSync;                                  // 一个 CloudSync 实例（pull/push/getETag…）
  name: string;                                      // 同步键（如 "rack"）
  encode: (folder: FolderEnvelope) => Bytes | Blob;  // folder → 上传字节（app 决 envelope 格式）
  decode: (text: string) => FolderEnvelope | null;   // 云端字节 → folder（含旧格式迁移；非法/脏字节返 null）
  resolve?: ResolveFn;                               // 字段级合并 override（罕见；默认整 entry LWW）
  isOnline?: () => boolean;
  timeoutMs?: number;
}

export interface FolderFlow {
  sync(localFolder: FolderEnvelope): Promise<FolderFlowResult>;
}

/**
 * @param {object} cfg
 * @param {object} cfg.cloud      一个 CloudSync 实例（pull/push/getETag…）
 * @param {string} cfg.name       同步键（如 "rack"）
 * @param {(folder)=>Blob} cfg.encode   folder → 上传字节（app 决 envelope 格式）
 * @param {(text:string)=>object|null} cfg.decode  云端字节 → folder（含旧格式迁移；非法/脏字节返 null=伪在线防线）
 * @param {(x,y)=>object} [cfg.resolve]  字段级合并 override（罕见；默认整 entry LWW）
 * @param {()=>boolean} [cfg.isOnline]
 * @param {number} [cfg.timeoutMs=15000]
 */
export function createFolderFlow(cfg: FolderFlowConfig): FolderFlow {
  const { cloud, name, encode, decode, resolve, isOnline, timeoutMs = 15000 } = cfg;
  let chain: Promise<FolderFlowResult> = Promise.resolve(null as unknown as FolderFlowResult);

  // 串行化同名 sync（避免自我并发 race）。返回 { status, folder, etag?, pushed? }。
  //   status: "synced" | "offline" | "invalid" | "dirty"
  function sync(localFolder: FolderEnvelope): Promise<FolderFlowResult> {
    const run = () => _sync(localFolder, 0);
    chain = chain.then(run, run);
    return chain;
  }

  async function _sync(localFolder: FolderEnvelope, depth: number): Promise<FolderFlowResult> {
    if (isOnline && !isOnline()) return { status: "offline", folder: localFolder };

    let pulled;
    try { pulled = await withTimeout(cloud.pull(name), timeoutMs); }
    catch (e) { return { status: "offline", folder: localFolder, error: e }; }   // 离线 / 慢网超时 / 伪在线 API 错

    let cloudFolder = emptyFolder();
    if (pulled && pulled.blob) {
      let text;
      try { text = await pulled.blob.text(); }
      catch (e) { return { status: "offline", folder: localFolder, error: e }; }
      const parsed = decode(text);
      if (!parsed) return { status: "invalid", folder: localFolder };   // 伪在线防线：脏字节绝不进 merge
      cloudFolder = parsed;
    }

    const merged = mergeFolders(localFolder, cloudFolder, { resolve });

    // 本地没贡献任何云端没有的东西 → 不必 push（pull-before-edit / 重复 sync 不白写云端）。
    if (normalizeFolder(merged) === normalizeFolder(cloudFolder)) {
      return { status: "synced", folder: merged, pushed: false, etag: pulled?.item?.eTag };
    }

    try {
      // CloudSync.push 现收 Bytes|Blob（cloud-sync 内部 toU8 归一化），encode 出 Blob 直接传。
      const res = await withTimeout(cloud.push(name, encode(merged), { baseEtag: pulled?.item?.eTag }), timeoutMs);
      return { status: "synced", folder: merged, pushed: true, etag: res?.item?.eTag };
    } catch (e) {
      if (is412(e) && depth < 5) return _sync(merged, depth + 1);   // 有人插队 → 重拉重 merge 重推（带上已 merge 的本地）
      return { status: "dirty", folder: merged, error: e };
    }
  }

  return { sync };
}
