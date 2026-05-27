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

import { getToken } from "./auth.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;

function encodeSeg(name) {
  return encodeURIComponent(name).replace(/'/g, "%27");
}

export function encodeApprootPath(path) {
  return path.split("/").filter(Boolean).map(encodeSeg).join("/");
}

async function graphFetch(method, pathOrUrl, { headers = {}, body = null } = {}) {
  const token = await getToken();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const init = { method, headers: { Authorization: `Bearer ${token}`, ...headers } };
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
    const err = new Error(`Graph ${method} ${pathOrUrl} → ${response.status}: ${detail}`);
    err.status = response.status;
    err.body = detail;
    throw err;
  }
  return response;
}

// ----- listing -----
export async function listChildren(subfolder = "") {
  const pathPart = subfolder ? `:/${encodeApprootPath(subfolder)}:` : "";
  const items = [];
  let next = `/me/drive/special/approot${pathPart}/children?$top=200&$select=id,name,size,eTag,createdDateTime,lastModifiedDateTime,file,folder`;
  while (next) {
    let response;
    try { response = await graphFetch("GET", next); }
    catch (e) { if (e.status === 404 && subfolder) return []; throw e; }
    const page = await response.json();
    items.push(...(page.value ?? []));
    next = page["@odata.nextLink"] ?? null;
  }
  return items;
}

// ----- 单 item metadata -----
export async function getItemByPath(path) {
  try {
    const r = await graphFetch(
      "GET",
      `/me/drive/special/approot:/${encodeApprootPath(path)}?$select=id,name,size,eTag,@microsoft.graph.downloadUrl`,
    );
    return await r.json();
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// ----- 二进制下载 -----
export async function downloadItemBlob(itemId) {
  // 优先 @microsoft.graph.downloadUrl（短期签名 CDN）；没有就走 /content
  const meta = await graphFetch(
    "GET",
    `/me/drive/items/${itemId}?$select=id,@microsoft.graph.downloadUrl`,
  );
  const metaJson = await meta.json();
  const dl = metaJson["@microsoft.graph.downloadUrl"];
  if (dl) {
    const r = await fetch(dl);
    if (!r.ok) throw new Error(`downloadUrl failed ${r.status}`);
    return await r.blob();
  }
  const r = await graphFetch("GET", `/me/drive/items/${itemId}/content`);
  return await r.blob();
}

// ----- 上传 -----
// path 相对 approot。eTag 给 If-Match（拿冲突检测）。conflictBehavior:
//   "replace" 默认覆盖；"fail" 同名拒收（用于 sibling-copy）。
export async function uploadFileToApproot(path, blob, contentType = "application/octet-stream", { conflictBehavior = "replace", eTag = null } = {}) {
  const headers = { "Content-Type": contentType };
  if (eTag) headers["If-Match"] = eTag;
  if (blob.size <= SIMPLE_UPLOAD_LIMIT) {
    const r = await graphFetch(
      "PUT",
      `/me/drive/special/approot:/${encodeApprootPath(path)}:/content?@microsoft.graph.conflictBehavior=${conflictBehavior}`,
      { headers, body: blob },
    );
    return r.json();
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
  const { uploadUrl } = await sessR.json();
  const CHUNK = 5 * 1024 * 1024;
  let offset = 0;
  let last = null;
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
      const err = new Error(`chunked upload failed ${r.status}`);
      err.status = r.status;
      throw err;
    }
    last = await r.json().catch(() => null);
    offset = end + 1;
  }
  return last;
}

// ----- 删除 -----
export async function deleteItem(itemId) {
  await graphFetch("DELETE", `/me/drive/items/${itemId}`);
}
