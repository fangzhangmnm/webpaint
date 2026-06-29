// MockCloudProvider —— 内存模拟一个 OneDrive-ish 云盘，实现 CloudProvider 契约。
// 用途：sync-store 抽取的测试替身（spec §4.2 / §9 phase 2）。Store 的 flow 测试都跑它。
// 不碰网络、不碰 MSAL，秒级 CI。
//
// 契约见 docs/20260604-sync-store-extraction.md。错误约定：throw Error 且带 .status（404/409/412），
// 与 graph.js 的 err.status 完全一致 → cloud.js 里 e.status===412/409 的判断原样可用。
//
// 模拟语义（与真 OneDrive 对齐的关键几条）：
//   - upload 带 eTag 且与云端不符 → 412（If-Match 失败 = pushSession 依赖）
//   - upload conflictBehavior="fail" 且 path 已存在 → 409
//   - move conflictBehavior="fail" 且目标名占用 → 409（restoreCloudFromTrash 防覆盖循环依赖）
//   - upload 到嵌套 path 自动建中间文件夹（Graph PUT-by-path 行为）
//   - downloadRange(offset=null, n) 取末尾 n 字节（thumb byte-range 依赖）

import type { Bytes } from "./substrate.ts";
import type { CloudProvider, CloudItem, UploadOpts, MoveOpts } from "./types.ts";

// 带 .status 的 HTTP 风格错误（与 graph.js err.status 一致）。
interface HttpError extends Error {
  status: number;
}

// 内部节点形状（path → node 索引值）。content=null 表文件夹。
interface MockNode {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  eTag: string;
  content: Bytes | null;
  contentType?: string;
  lastModifiedDateTime: string;
}

// 故障注入规格（test-only）。
interface Fault {
  op?: string;
  kind: "error" | "lostResponse";
  status?: number;
  message?: string;
  times?: number;
}

// createMockProvider 选项。
interface MockProviderOpts {
  now?: number;
  hook?: (op: string, args: object) => Promise<void> | void;
}

function httpError(status: number, message?: string): HttpError {
  const e = new Error(message || `mock cloud ${status}`) as HttpError;
  e.status = status;
  return e;
}

async function toBytes(blob: Bytes | Blob | ArrayBuffer | string | null | undefined): Promise<Bytes> {
  if (blob == null) return new Uint8Array(0);
  if (typeof blob === "string") return new TextEncoder().encode(blob);
  if (blob instanceof Uint8Array) return blob;
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  throw new Error("MockCloudProvider: 无法识别的 blob 类型");
}

function normPath(path: string): string {
  return String(path || "").split("/").filter(Boolean).join("/");
}
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
function baseOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * @param {object} [opts]
 * @param {number} [opts.now] 固定时间戳（lastModifiedDateTime 用；测试可注入避免 Date.now()）
 * @param {(op:string, args:object)=>Promise<void>|void} [opts.hook] 每个 mutating 操作开头调用，
 *        可在测试里挂起以模拟并发 / race（slice C 的 race-serialize 测试用）。
 */
// MockProvider = CloudProvider 契约（类型层验证真 provider 同契约）+ 测试辅助。
export interface MockProvider extends CloudProvider {
  injectFault(spec: Fault): MockProvider;
  _dump(): CloudItem[];
  _seed(path: string, bytes: Bytes | string): CloudItem;
}

export function createMockProvider(opts: MockProviderOpts = {}): MockProvider {
  let idSeq = 0;
  const nextId = () => `id-${++idSeq}`;
  let clock = typeof opts.now === "number" ? opts.now : 1_700_000_000_000;
  const stamp = () => new Date(clock++).toISOString();
  const hook = opts.hook || (() => {});

  // path → node。root = "" 隐式存在。
  /** node: { id, name, path, isFolder, eTag, content:Uint8Array|null, lastModifiedDateTime } */
  const byPath = new Map<string, MockNode>();
  const byId = new Map<string, MockNode>();

  const ROOT_ID = nextId();
  const root = { id: ROOT_ID, name: "", path: "", isFolder: true, eTag: "0", content: null, lastModifiedDateTime: stamp() };
  byPath.set("", root);
  byId.set(ROOT_ID, root);

  let etagSeq = 0;
  const newEtag = () => `etag-${++etagSeq}`;

  // ---- 故障注入（test-only）----
  // 模拟真云的失败模式：限流/5xx、上传中断、lost-response（写成功但回执丢 → B5 假 412）。
  // injectFault({ op?, kind, status?, times? })：
  //   kind="error"          → 操作前抛 httpError(status)（云端不变 = clean fail / 中间强退-写前）
  //   kind="lostResponse"   → 先真的写入（云端 etag 变了），再抛无 status 的网络错（回执丢失）
  //                           仅 upload / move 支持；其余 op 的 lostResponse 当 error 处理
  // op 省略 = 匹配任意 op。times 默认 1（一次性）。
  const _faults: Fault[] = [];
  function consumeFault(op: string): Fault | null {
    for (let i = 0; i < _faults.length; i++) {
      const f = _faults[i];
      if (f.op && f.op !== op) continue;
      f.times = (f.times ?? 1) - 1;
      if (f.times <= 0) _faults.splice(i, 1);
      return f;
    }
    return null;
  }
  function faultError(f: Fault): Error {
    if (f.kind === "lostResponse") return new Error("mock: 网络中断，回执丢失（写已落盘）"); // 无 .status，模拟 fetch reject
    return httpError(f.status ?? 500, f.message || `mock fault ${f.status ?? 500}`);
  }

  function toItem(node: MockNode): CloudItem {
    return {
      id: node.id,
      name: node.name,
      path: node.path,
      size: node.content ? node.content.length : 0,
      eTag: node.eTag,
      lastModifiedDateTime: node.lastModifiedDateTime,
      isFolder: node.isFolder,
      downloadUrl: node.isFolder ? undefined : `mock://${node.id}`,
    };
  }

  function ensureFolderSync(path: string): string {
    const p = normPath(path);
    if (p === "") return ROOT_ID;
    const existing = byPath.get(p);
    if (existing) {
      if (!existing.isFolder) throw new Error(`${p} 已存在但不是文件夹`);
      return existing.id;
    }
    // 逐段建
    const segs = p.split("/");
    let cum = "";
    let parentId = ROOT_ID;
    for (const seg of segs) {
      cum = cum ? `${cum}/${seg}` : seg;
      let n = byPath.get(cum);
      if (!n) {
        n = { id: nextId(), name: seg, path: cum, isFolder: true, eTag: newEtag(), content: null, lastModifiedDateTime: stamp() };
        byPath.set(cum, n);
        byId.set(n.id, n);
      } else if (!n.isFolder) {
        throw new Error(`${cum} 已存在但不是文件夹`);
      }
      parentId = n.id;
    }
    return parentId;
  }

  function relocateSubtree(node: MockNode, newPath: string): void {
    // node 自身
    byPath.delete(node.path);
    const oldPrefix = node.path + "/";
    const moved: MockNode[] = [];
    for (const [pth, n] of byPath) {
      if (pth.startsWith(oldPrefix)) moved.push(n);
    }
    node.path = newPath;
    node.name = baseOf(newPath);
    byPath.set(newPath, node);
    for (const n of moved) {
      byPath.delete(n.path);
      const rest = n.path.slice(oldPrefix.length);
      n.path = `${newPath}/${rest}`;
      byPath.set(n.path, n);
    }
  }

  const provider: MockProvider = {
    // ---- 只读 ----
    async list(folder = "") {
      const f = normPath(folder);
      const node = byPath.get(f);
      if (f !== "" && (!node || !node.isFolder)) throw httpError(404, `folder 不存在: ${f}`);
      const prefix = f === "" ? "" : f + "/";
      const out: CloudItem[] = [];
      for (const [pth, n] of byPath) {
        if (pth === f) continue;
        if (!pth.startsWith(prefix)) continue;
        const rest = pth.slice(prefix.length);
        if (rest.includes("/")) continue; // 只要直接 children
        out.push(toItem(n));
      }
      return out;
    },

    async getItemByPath(path: string) {
      await hook("getItemByPath", { path });   // 读 hook：可在测试里挂起模拟慢网（openSession 跳过用）
      const n = byPath.get(normPath(path));
      return n ? toItem(n) : null;
    },

    async getApprootId() {
      return ROOT_ID;
    },

    async download(id: string) {
      const n = byId.get(id);
      if (!n || n.isFolder) throw httpError(404, `item 不存在: ${id}`);
      return new Blob([n.content || new Uint8Array(0)]);
    },

    async downloadRange(id: string, offset: number | null, length: number) {
      const n = byId.get(id);
      if (!n || n.isFolder) throw httpError(404, `item 不存在: ${id}`);
      const buf = n.content || new Uint8Array(0);
      const slice = offset == null
        ? buf.slice(Math.max(0, buf.length - length))      // 末尾 length 字节
        : buf.slice(offset, offset + length);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },

    // ---- 写 ----
    async upload(path: string, blob: Bytes | Blob, { contentType = "application/octet-stream", eTag = null, conflictBehavior = "replace" }: UploadOpts = {}) {
      await hook("upload", { path, eTag, conflictBehavior });
      const fault = consumeFault("upload");
      if (fault && fault.kind !== "lostResponse") throw faultError(fault); // 写前抛：云端不变
      const p = normPath(path);
      if (p === "") throw httpError(400, "不能上传到根");
      const existing = byPath.get(p);
      let node: MockNode;
      if (existing) {
        if (existing.isFolder) throw httpError(409, `${p} 是文件夹`);
        if (eTag && existing.eTag !== eTag) throw httpError(412, `If-Match 失败: ${p}`);
        if (conflictBehavior === "fail") throw httpError(409, `已存在: ${p}`);
        existing.content = await toBytes(blob);
        existing.eTag = newEtag();
        existing.lastModifiedDateTime = stamp();
        existing.contentType = contentType;
        node = existing;
      } else {
        // 新建：自动建中间文件夹（Graph PUT-by-path 行为）
        const parent = parentOf(p);
        if (parent) ensureFolderSync(parent);
        node = {
          id: nextId(), name: baseOf(p), path: p, isFolder: false,
          eTag: newEtag(), content: await toBytes(blob), contentType,
          lastModifiedDateTime: stamp(),
        };
        byPath.set(p, node);
        byId.set(node.id, node);
      }
      // lostResponse：写已落盘（etag 已变），但回执丢了 → 调用方以为失败（B5 假 412 的源头）
      if (fault && fault.kind === "lostResponse") throw faultError(fault);
      return toItem(node);
    },

    async ensureFolder(path: string) {
      await hook("ensureFolder", { path });
      return ensureFolderSync(path);
    },

    async delete(id: string) {
      await hook("delete", { id });
      const fault = consumeFault("delete");
      if (fault) throw faultError(fault);
      const n = byId.get(id);
      if (!n) throw httpError(404, `item 不存在: ${id}`);
      if (n.isFolder) {
        const prefix = n.path + "/";
        for (const [pth, sub] of [...byPath]) {
          if (pth === n.path || pth.startsWith(prefix)) {
            byPath.delete(pth);
            byId.delete(sub.id);
          }
        }
      } else {
        byPath.delete(n.path);
        byId.delete(n.id);
      }
    },

    async move(id: string, targetFolderId: string, { newName = null, eTag = null, conflictBehavior = "fail" }: MoveOpts = {}) {
      await hook("move", { id, targetFolderId, newName, conflictBehavior });
      const fault = consumeFault("move");
      if (fault && fault.kind !== "lostResponse") throw faultError(fault);
      const n = byId.get(id);
      if (!n) throw httpError(404, `item 不存在: ${id}`);
      const folder = byId.get(targetFolderId);
      if (!folder || !folder.isFolder) throw httpError(404, `目标 folder 不存在: ${targetFolderId}`);
      if (eTag && n.eTag !== eTag) throw httpError(412, `If-Match 失败: ${id}`);
      const name = newName || n.name;
      if (name.includes("/")) throw httpError(400, "newName 不能含 /");
      const destPath = folder.path ? `${folder.path}/${name}` : name;
      if (destPath !== n.path && byPath.has(destPath)) {
        if (conflictBehavior === "fail") throw httpError(409, `目标已存在: ${destPath}`);
      }
      relocateSubtree(n, destPath);
      n.eTag = newEtag();
      n.lastModifiedDateTime = stamp();
      // lostResponse：move 在服务端已完成（如已挪进 .trash），但回执丢失
      if (fault && fault.kind === "lostResponse") throw faultError(fault);
      return toItem(n);
    },

    async rename(id: string, newName: string, eTag: string | null = null) {
      await hook("rename", { id, newName });
      const fault = consumeFault("rename");
      if (fault) throw faultError(fault);
      const n = byId.get(id);
      if (!n) throw httpError(404, `item 不存在: ${id}`);
      if (eTag && n.eTag !== eTag) throw httpError(412, `If-Match 失败: ${id}`);
      if (newName.includes("/")) throw httpError(400, "newName 不能含 /");
      const parent = parentOf(n.path);
      const destPath = parent ? `${parent}/${newName}` : newName;
      if (destPath !== n.path && byPath.has(destPath)) throw httpError(409, `已存在: ${destPath}`);
      relocateSubtree(n, destPath);
      n.eTag = newEtag();
      n.lastModifiedDateTime = stamp();
      return toItem(n);
    },

    // ---- 测试辅助（非契约，调试 / 断言用）----
    injectFault(spec: Fault) { _faults.push(spec); return provider; },
    _dump() {
      return [...byPath.values()].filter((n) => n.path !== "").map(toItem);
    },
    _seed(path: string, bytes: Bytes | string) {
      const p = normPath(path);
      const parent = parentOf(p);
      if (parent) ensureFolderSync(parent);
      const node: MockNode = {
        id: nextId(), name: baseOf(p), path: p, isFolder: false,
        eTag: newEtag(), content: bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes)),
        lastModifiedDateTime: stamp(),
      };
      byPath.set(p, node);
      byId.set(node.id, node);
      return toItem(node);
    },
  };
  return provider;
}
