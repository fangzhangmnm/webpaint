// graphToCloudProvider —— 把 Graph transport（graph.js）翻成 lib 的 CloudProvider。
// 原始 Graph item（file/folder facet、@microsoft.graph.downloadUrl）→ CloudItem。
// 纯：graph **必传**（测试传 graphFromProvider(MockCloudProvider)）。
//   graphToCloudProvider ∘ graphFromProvider ≈ 恒等 → 完整 Mock 验适配正确性。
// 完整的「config 驱动 OneDriveProvider」在 providers/index.js（wire auth+graph+本适配器）。

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

export function graphToCloudProvider(graph) {
  if (!graph) throw new Error("graphToCloudProvider: graph transport 必传");
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
