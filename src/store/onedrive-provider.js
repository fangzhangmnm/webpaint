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
    // graph.js 是 Blob 原生（按 .size 选简单/分块路径、用 .slice 切块）；lib 把字节归一成 Uint8Array。
    // 必须在这道接缝转回 Blob——Uint8Array.size===undefined → undefined<=4MB 为 false → 永远走分块、
    // while(0<undefined) 一个 chunk 都不传 → 上传 0 字节占位还回 etag（postmortem 2026-06-05 根因）。
    upload: (path, blob, { contentType = "application/octet-stream", eTag = null, conflictBehavior = "replace" } = {}) => {
      const body = blob instanceof Blob ? blob : new Blob([blob], { type: contentType });
      return graph.uploadFileToApproot(path, body, contentType, { conflictBehavior, eTag }).then(toItem);
    },
    delete: (id) => graph.deleteItem(id),
    ensureFolder: (path) => graph.ensureSubfolder(path),
    move: (id, folderId, opts = {}) => graph.moveItemToFolder(id, folderId, opts).then(toItem),
    rename: (id, newName, eTag) => graph.renameItem(id, newName, eTag).then(toItem),
    getApprootId: () => graph.getApprootId(),
  };
}
