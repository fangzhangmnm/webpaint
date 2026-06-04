// OneDriveProvider —— WebPaint 的 CloudProvider 实现，薄包 graph.js（Graph/approot）。
// 把 graph.js 的原始 Graph item（file/folder facet、@microsoft.graph.downloadUrl）翻成 lib 的 CloudItem。
// 这是「cloud.js 拆成 provider」的低层一半：session 语义归 lib 的 cloud-sync，传输归这里。
//
// graph 注入（默认真 graph.js）→ 可用 graphFromProvider(MockCloudProvider) 测：
//   OneDriveProvider ∘ graphFromProvider ≈ 恒等 → 完整 Mock 验适配正确性。

import * as _realGraph from "../graph.js";

function toItem(it) {
  if (!it) return null;
  return {
    id: it.id,
    name: it.name,
    size: it.size || 0,
    eTag: it.eTag,
    lastModifiedDateTime: it.lastModifiedDateTime,
    isFolder: !!it.folder,                                   // Graph: file facet vs folder facet
    path: it.path,
    downloadUrl: it["@microsoft.graph.downloadUrl"] || it.downloadUrl,
  };
}

export function createOneDriveProvider(graph = _realGraph) {
  return {
    list: async (folder = "") => (await graph.listChildren(folder)).map(toItem),
    getItemByPath: async (path) => toItem(await graph.getItemByPath(path)),
    download: (id) => graph.downloadItemBlob(id),
    downloadRange: (id, offset, length) => graph.downloadItemRange(id, offset, length),
    upload: (path, blob, { contentType = "application/octet-stream", eTag = null, conflictBehavior = "replace" } = {}) =>
      graph.uploadFileToApproot(path, blob, contentType, { conflictBehavior, eTag }).then(toItem),
    delete: (id) => graph.deleteItem(id),
    ensureFolder: (path) => graph.ensureSubfolder(path),
    move: (id, folderId, opts = {}) => graph.moveItemToFolder(id, folderId, opts).then(toItem),
    rename: (id, newName, eTag) => graph.renameItem(id, newName, eTag).then(toItem),
    getApprootId: () => graph.getApprootId(),
  };
}
