// graphToCloudProvider —— 把 Graph transport（graph.js）翻成 lib 的 CloudProvider。
// 原始 Graph item（file/folder facet、@microsoft.graph.downloadUrl）→ CloudItem。
// 纯：graph **必传**（测试传 graphFromProvider(MockCloudProvider)）。
//   graphToCloudProvider ∘ graphFromProvider ≈ 恒等 → 完整 Mock 验适配正确性。
// 完整的「config 驱动 OneDriveProvider」在 providers/index.js（wire auth+graph+本适配器）。

import type { CloudItem, CloudProvider, UploadOpts, MoveOpts, Bytes } from "./types.ts";
import type * as graphModule from "./providers/graph.ts";

// graph transport 模块的形状（providers/index 传真 graph，测试传 graphFromProvider(Mock)）。
type GraphTransport = typeof graphModule;

// graph item 的原始形状（含 file/folder facet、path、downloadUrl 注解）。
// graph.ts 的 GraphDriveItem 不导出且不含 path（测试 mock 带 path）→ 这里本地放宽。
interface RawGraphItem {
  id: string;
  name?: string;
  size?: number;
  eTag?: string;
  lastModifiedDateTime?: string | number;
  folder?: unknown;
  path?: string;
  downloadUrl?: string;
  "@microsoft.graph.downloadUrl"?: string;
}

function toItem(it: RawGraphItem | null | undefined): CloudItem | null {
  if (!it) return null;
  return {
    id: it.id,
    name: it.name as string,
    size: it.size || 0,
    eTag: it.eTag as string,
    lastModifiedDateTime: it.lastModifiedDateTime as string | number,
    isFolder: !!it.folder,                                   // Graph: file facet vs folder facet
    path: it.path as string,
    downloadUrl: it["@microsoft.graph.downloadUrl"] || it.downloadUrl,
  } as CloudItem;
}

export function graphToCloudProvider(graph: GraphTransport): CloudProvider {
  if (!graph) throw new Error("graphToCloudProvider: graph transport 必传");
  return {
    list: async (folder = "") => (await graph.listChildren(folder)).map(toItem) as CloudItem[],
    getItemByPath: async (path: string) => toItem(await graph.getItemByPath(path)),
    download: (id: string) => graph.downloadItemBlob(id),
    downloadRange: (id: string, offset: number, length: number) => graph.downloadItemRange(id, offset, length),
    // graph.js 是 Blob 原生（按 .size 选简单/分块路径、用 .slice 切块）；lib 把字节归一成 Uint8Array。
    // 必须在这道接缝转回 Blob——Uint8Array.size===undefined → undefined<=4MB 为 false → 永远走分块、
    // while(0<undefined) 一个 chunk 都不传 → 上传 0 字节占位还回 etag（postmortem 2026-06-05 根因）。
    upload: (path: string, blob: Bytes | Blob, { contentType = "application/octet-stream", eTag = null, conflictBehavior = "replace" }: UploadOpts = {}) => {
      const body = blob instanceof Blob ? blob : new Blob([blob], { type: contentType });
      return graph.uploadFileToApproot(path, body, contentType, { conflictBehavior, eTag }).then(toItem) as Promise<CloudItem>;
    },
    delete: (id: string) => graph.deleteItem(id),
    ensureFolder: (path: string) => graph.ensureSubfolder(path),
    move: (id: string, folderId: string, opts: MoveOpts = {}) => graph.moveItemToFolder(id, folderId, opts).then(toItem) as Promise<CloudItem>,
    rename: (id: string, newName: string, eTag?: string | null) => graph.renameItem(id, newName, eTag).then(toItem) as Promise<CloudItem>,
    getApprootId: () => graph.getApprootId(),
  };
}
