// Microsoft Graph wrapper — 所有路径锚在 /me/drive/special/approot 沙盒。
// AppFolder 沙盒 = `Apps/AtlasMaker/`，即使 token 泄漏也只能碰本 app 的目录。
//
// AtlasMaker 用得着的子集：
//   - listChildren()            列 approot 下文件
//   - getItemByPath(path)       拿 metadata（含 eTag）
//   - downloadItemBlob(id)      取二进制（atlas zip）
//   - uploadFileToApproot()     PUT zip blob，支持 If-Match 防冲突
//   - deleteItem(id)            清理
//
// 关键陷阱：
//   - body 必须接受 TypedArray —— 没有 ArrayBuffer.isView 检查会把 Uint8Array
//     JSON.stringify 成 10× 膨胀。webxiaoheiwu 踩过坑。
//   - @microsoft.graph.conflictBehavior 在 URL 查询串，不是 header（@ 在 header 非法）。
//   - 大于 4MB 走 createUploadSession 分块上传。atlas zip 大概率超 4MB。

import { getToken } from "./auth.ts";

// ---- 实际读到的 Graph JSON 形状（只声明本文件真正访问的字段，其余 Graph 字段忽略）。----
// driveItem 的 file/folder facet 二选一区分文件/文件夹；@ 前缀字段是 Graph 注解。
interface GraphDriveItem {
  id: string;
  name?: string;
  size?: number;
  eTag?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  file?: unknown;
  folder?: unknown;
  parentReference?: { id?: string };
  downloadUrl?: string;
  "@microsoft.graph.downloadUrl"?: string;
}
// children / list 分页响应。
interface GraphListResponse {
  value?: GraphDriveItem[];
  "@odata.nextLink"?: string;
}
// createUploadSession 响应。
interface GraphUploadSession {
  uploadUrl: string;
}
// graphFetch 抛的错带 HTTP status/body（caller 用 status 判 404 等）。
interface GraphError extends Error {
  status?: number;
  body?: string;
}

// graphFetch 的请求体：字符串/二进制走原样，其余对象 JSON.stringify。
type GraphBody = string | ArrayBuffer | ArrayBufferView | Blob | Record<string, unknown> | null;
interface GraphFetchOpts {
  headers?: Record<string, string>;
  body?: GraphBody;
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;

function encodeSeg(name: string): string {
  return encodeURIComponent(name).replace(/'/g, "%27");
}

export function encodeApprootPath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeSeg).join("/");
}

async function graphFetch(method: string, pathOrUrl: string, { headers = {}, body = null }: GraphFetchOpts = {}): Promise<Response> {
  const token = await getToken();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const init: RequestInit & { headers: Record<string, string> } = { method, headers: { Authorization: `Bearer ${token}`, ...headers } };
  if (body != null) {
    if (
      typeof body === "string" ||
      body instanceof ArrayBuffer ||
      ArrayBuffer.isView(body) ||
      body instanceof Blob
    ) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      if (!init.headers["Content-Type"]) init.headers["Content-Type"] = "application/json";
    }
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = "";
    try { detail = await response.text(); } catch (_) {}
    const err: GraphError = new Error(`Graph ${method} ${pathOrUrl} → ${response.status}: ${detail}`);
    err.status = response.status;
    err.body = detail;
    throw err;
  }
  return response;
}

// ----- listing -----
export async function listChildren(subfolder = ""): Promise<GraphDriveItem[]> {
  const pathPart = subfolder ? `:/${encodeApprootPath(subfolder)}:` : "";
  const items: GraphDriveItem[] = [];
  // @microsoft.graph.downloadUrl：1h 短效 CDN URL，加进 $select 让 list 一次性带回
  // → 后续 byte-range 直接打 CDN，省掉每张 thumb 的 metadata RTT
  // 过期后 caller 拿 401/403 → 重新走 getDownloadUrl 申请
  let next: string | null = `/me/drive/special/approot${pathPart}/children?$top=200&$select=id,name,size,eTag,createdDateTime,lastModifiedDateTime,file,folder,@microsoft.graph.downloadUrl`;
  while (next) {
    let response;
    try { response = await graphFetch("GET", next); }
    catch (e) { if ((e as GraphError).status === 404 && subfolder) return []; throw e; }
    const page = await response.json() as GraphListResponse;
    items.push(...(page.value ?? []));
    next = page["@odata.nextLink"] ?? null;
  }
  return items;
}

// ----- 单 item metadata -----
export async function getItemByPath(path: string): Promise<GraphDriveItem | null> {
  try {
    const r = await graphFetch(
      "GET",
      `/me/drive/special/approot:/${encodeApprootPath(path)}?$select=id,name,size,eTag,lastModifiedDateTime,folder,@microsoft.graph.downloadUrl`,
    );
    return await r.json() as GraphDriveItem;
  } catch (e) {
    if ((e as GraphError).status === 404) return null;
    throw e;
  }
}

// ----- 二进制下载 -----
export async function downloadItemBlob(itemId: string): Promise<Blob> {
  // 优先 @microsoft.graph.downloadUrl（短期签名 CDN）；没有就走 /content
  const dl = await getDownloadUrl(itemId);
  if (dl) {
    const r = await fetch(dl);
    if (!r.ok) throw new Error(`downloadUrl failed ${r.status}`);
    return await r.blob();
  }
  const r = await graphFetch("GET", `/me/drive/items/${itemId}/content`);
  return await r.blob();
}

// byte-range 下载
//   offset = null + length 给 suffix range "bytes=-N"（取最后 N 字节）
//   offset 给 prefix range "bytes=OFFSET-OFFSET+LEN-1"
//   走 downloadUrl 拿 CDN signed URL（支持 Range header），fallback /content
export async function downloadItemRange(itemId: string, offset: number | null, length: number): Promise<ArrayBuffer> {
  const dl = await getDownloadUrl(itemId);
  if (dl) return await downloadRangeFromUrl(dl, offset, length);
  const r = await graphFetch("GET", `/me/drive/items/${itemId}/content`, { headers: { Range: _rangeHeader(offset, length) } });
  return await r.arrayBuffer();
}

function _rangeHeader(offset: number | null, length: number): string {
  return (offset == null)
    ? `bytes=-${length}`
    : `bytes=${offset}-${offset + length - 1}`;
}

// 直接打已知 CDN URL 的 byte-range（省掉每张 thumb 的 metadata RTT）
// caller 处理 401/403 = downloadUrl 过期，重申请 getDownloadUrl 重试一次
export async function downloadRangeFromUrl(downloadUrl: string, offset: number | null, length: number): Promise<ArrayBuffer> {
  const r = await fetch(downloadUrl, { headers: { Range: _rangeHeader(offset, length) } });
  if (!r.ok && r.status !== 206) {
    const err: GraphError = new Error(`range download failed ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return await r.arrayBuffer();
}

// 拿一个新的 1h 短效 downloadUrl（过期重申请用）
export async function getDownloadUrl(itemId: string): Promise<string | null> {
  const r = await graphFetch("GET", `/me/drive/items/${itemId}?$select=id,@microsoft.graph.downloadUrl`);
  const j = await r.json() as GraphDriveItem;
  return j["@microsoft.graph.downloadUrl"] || null;
}

// ----- 上传 -----
// path 相对 approot。eTag 给 If-Match（拿冲突检测）。conflictBehavior:
//   "replace" 默认覆盖；"fail" 同名拒收（用于 sibling-copy）。
interface UploadFileOpts {
  conflictBehavior?: string;
  eTag?: string | null;
}
export async function uploadFileToApproot(path: string, blob: Blob, contentType = "application/octet-stream", { conflictBehavior = "replace", eTag = null }: UploadFileOpts = {}): Promise<GraphDriveItem | null> {
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (eTag) headers["If-Match"] = eTag;
  if (blob.size <= SIMPLE_UPLOAD_LIMIT) {
    const r = await graphFetch(
      "PUT",
      `/me/drive/special/approot:/${encodeApprootPath(path)}:/content?@microsoft.graph.conflictBehavior=${conflictBehavior}`,
      { headers, body: blob },
    );
    return r.json() as Promise<GraphDriveItem>;
  }
  // 大文件分块
  const sessR = await graphFetch(
    "POST",
    `/me/drive/special/approot:/${encodeApprootPath(path)}:/createUploadSession`,
    {
      body: {
        item: {
          "@microsoft.graph.conflictBehavior": conflictBehavior,
          name: path.split("/").pop(),
        },
      },
      headers: eTag ? { "If-Match": eTag } : undefined,
    },
  );
  const { uploadUrl } = await sessR.json() as GraphUploadSession;
  const CHUNK = 5 * 1024 * 1024;
  let offset = 0;
  let last: GraphDriveItem | null = null;
  while (offset < blob.size) {
    const end = Math.min(offset + CHUNK, blob.size) - 1;
    const chunk = blob.slice(offset, end + 1);
    const r = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.size),
        "Content-Range": `bytes ${offset}-${end}/${blob.size}`,
      },
      body: chunk,
    });
    if (!r.ok && r.status !== 202) {
      const err: GraphError = new Error(`chunked upload failed ${r.status}`);
      err.status = r.status;
      throw err;
    }
    last = await r.json().then((j) => j as GraphDriveItem).catch(() => null);
    offset = end + 1;
  }
  return last;
}

// ----- 删除 -----
export async function deleteItem(itemId: string): Promise<void> {
  await graphFetch("DELETE", `/me/drive/items/${itemId}`);
}

// ----- approot + 子文件夹 ensure / 移动 -----（trash + folder feature 用）

let _approotIdCache: string | null = null;
const _subfolderIdCache = new Map<string, string>();

export function clearFolderCaches(): void { _approotIdCache = null; _subfolderIdCache.clear(); }

export async function getApprootId(): Promise<string> {
  if (_approotIdCache) return _approotIdCache;
  const r = await graphFetch("GET", "/me/drive/special/approot?$select=id");
  _approotIdCache = (await r.json() as GraphDriveItem).id;
  return _approotIdCache;
}

// 确保 approot 下有指定子文件夹（name 单段或多段 "a/b/c"），返 folder id。
// 加缓存：第一次拉 / 建，之后 reuse。
export async function ensureSubfolder(name: string): Promise<string> {
  if (!name) return getApprootId();
  const cached = _subfolderIdCache.get(name);
  if (cached !== undefined) return cached;
  // 先试拿现有
  try {
    const r = await graphFetch(
      "GET",
      `/me/drive/special/approot:/${encodeApprootPath(name)}?$select=id,name,folder`,
    );
    const item = await r.json() as GraphDriveItem;
    if (item.folder) {
      _subfolderIdCache.set(name, item.id);
      return item.id;
    }
    throw new Error(`${name} 已存在但不是文件夹`);
  } catch (e) {
    if ((e as GraphError).status !== 404) throw e;
  }
  // 不存在 → 逐段建。多段路径用 children POST 每段。
  const segments = name.split("/").filter(Boolean);
  let parentId = await getApprootId();
  let cumulative = "";
  for (const seg of segments) {
    cumulative = cumulative ? `${cumulative}/${seg}` : seg;
    const cachedSeg = _subfolderIdCache.get(cumulative);
    if (cachedSeg !== undefined) { parentId = cachedSeg; continue; }
    try {
      const r = await graphFetch(
        "GET",
        `/me/drive/special/approot:/${encodeApprootPath(cumulative)}?$select=id,folder`,
      );
      const it = await r.json() as GraphDriveItem;
      if (it.folder) { parentId = it.id; _subfolderIdCache.set(cumulative, parentId); continue; }
    } catch (e) { if ((e as GraphError).status !== 404) throw e; }
    const r = await graphFetch("POST", `/me/drive/items/${parentId}/children`, {
      body: {
        name: seg,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      },
    });
    const it = await r.json() as GraphDriveItem;
    parentId = it.id;
    _subfolderIdCache.set(cumulative, parentId);
  }
  return parentId;
}

// 把 item 移到指定 parent folder。atomic at server side（PATCH parentReference）
// eTag 给 If-Match 防覆盖；newName 不传保持原 name
// conflictBehavior: "fail" | "replace" | "rename" —— 默认 "fail"（防误覆盖目标位置同名）
//   trash / restore 用 "fail" 保护数据，caller 自己 fallback 改名
interface MoveItemOpts {
  eTag?: string | null;
  newName?: string | null;
  conflictBehavior?: string;
}
export async function moveItemToFolder(itemId: string, targetFolderId: string, { eTag = null, newName = null, conflictBehavior = "fail" }: MoveItemOpts = {}): Promise<GraphDriveItem> {
  const headers: Record<string, string> = {};
  if (eTag) headers["If-Match"] = eTag;
  const body: Record<string, unknown> = {
    parentReference: { id: targetFolderId },
    "@microsoft.graph.conflictBehavior": conflictBehavior,
  };
  if (newName) body.name = newName;
  const r = await graphFetch("PATCH", `/me/drive/items/${itemId}`, { headers, body });
  return r.json() as Promise<GraphDriveItem>;
}

// 改名 only（不移动）
export async function renameItem(itemId: string, newName: string, eTag: string | null = null): Promise<GraphDriveItem> {
  const headers: Record<string, string> = {};
  if (eTag) headers["If-Match"] = eTag;
  const r = await graphFetch("PATCH", `/me/drive/items/${itemId}`, {
    headers,
    body: { name: newName },
  });
  return r.json() as Promise<GraphDriveItem>;
}
