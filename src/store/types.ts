// store 深模块的共享类型契约（v223 TS 化）。被 Uint8Array/Blob 类型 bug 雷击两次 →
// 把跨文件的形状收到这一个文件，tsc strict 检查（esbuild 只 strip 不查）。
// 设计原则：把「字节边界」写死——谁吃 Bytes、谁吃/出 Blob，一眼可辨、错配即编译错。

import type { Bytes } from "./substrate.ts";
export type { Bytes } from "./substrate.ts";

// ---- 注入端口 ----
// localStorage / IDB / 内存 都能实现的极简 KV（store 不直碰 localStorage，红线 #7）。
export interface Kv {
  get(k: string): string | null;
  set(k: string, v: string): void;
  remove(k: string): void;
}

// ---- 云端低层（CloudProvider）：list/get/download/upload/delete/ensureFolder/move/rename ----
// 一个云端文件/文件夹的元信息（provider 各方法返回的统一形状）。
export interface CloudItem {
  id: string;
  name: string;
  path: string;
  size: number;
  eTag: string;
  lastModifiedDateTime: string | number;
  isFolder?: boolean;
  contentType?: string;
  downloadUrl?: string;
  /** Graph 直传的下载 URL 字段（thumb byte-range 用）。 */
  "@microsoft.graph.downloadUrl"?: string;
}

export interface UploadOpts {
  contentType?: string;
  eTag?: string | null;
  conflictBehavior?: "fail" | "replace" | "rename";
}
export interface MoveOpts {
  newName?: string | null;
  eTag?: string | null;
  conflictBehavior?: "fail" | "replace" | "rename";
}

// 低层云端传输契约。WebPaint 用 OneDriveProvider（包 Graph），测试用 MockProvider。
export interface CloudProvider {
  list(folder?: string): Promise<CloudItem[]>;
  getItemByPath(path: string): Promise<CloudItem | null>;
  getApprootId(): Promise<string>;
  download(id: string): Promise<Blob>;
  downloadRange(id: string, offset: number, length: number): Promise<Uint8Array | ArrayBuffer | Blob>;
  upload(path: string, blob: Bytes | Blob, opts?: UploadOpts): Promise<CloudItem>;
  ensureFolder(path: string): Promise<string>;
  delete(id: string): Promise<void>;
  move(id: string, targetFolderId: string, opts?: MoveOpts): Promise<CloudItem>;
  rename(id: string, newName: string, eTag?: string | null): Promise<CloudItem>;
}

// ---- 本地持久层（LocalAdapter）：store.local 契约 ----
// **字节边界关键点**（v221 0B bug 雷区）：save 可收 Bytes 或 Blob（store 流经 toU8 给的是 Bytes），
//   但内部必须落 Blob（pkg.ora.size 给图库列大小、decodeOraToDoc 的 BlobReader 都只吃 Blob）；
//   get 出 Blob（解码/上传再各自转）。类型在此写死，错配即编译错。
export interface TrashEntry {
  trashKey: string;
  name: string;
}
export interface LocalAdapter {
  /** hint：flow.save 透传的 app 旁路（store 不解释；如 WebPaint 带活 doc 现成缩略图省一次解码）。 */
  save(name: string, oraBytes: Bytes | Blob, hint?: unknown): Promise<unknown>;
  get(name: string): Promise<Blob | null>;
  exists(name: string): Promise<boolean>;
  backup(name: string): Promise<string>;
  trash(name: string): Promise<string>;
  hardDelete(name: string): Promise<void>;
  restore(trashKey: string): Promise<string>;
  purgeTrash?(trashKey: string): Promise<void>;
  listTrash?(): Promise<TrashEntry[]>;
}

// ---- cloud-sync（session 级同步 over CloudProvider）：Store 消费的「cloud 后端」 ----
// pull 返回拉到的字节 + 权威 item（H7：分片末响应无 item 时拉权威 etag）+ 建议落地名（撞名 caller 用）。
export interface PullResult {
  blob: Blob;
  item: CloudItem | null;
  suggestedName: string;
}
export interface PushResult {
  item: CloudItem | null;
}
// fetchMeta 只取轻量元信息（store open/refresh 比对 etag 用），不下载内容。
export interface FetchMetaResult {
  etag: string;
  lastModified: string | number;
  size: number;
  item: CloudItem;
}
// 弱覆盖（冲突解决 weak-override 分支）：覆盖云端 + 留底，返回新 item 与备份名。
export interface WeakOverrideResult {
  item: CloudItem | null;
  backedUp: string | null;
}
// cloud-sync 暴露给 store/app 的面（dirty/etag 状态 + push/pull/list/trash 等）。
// push 收 Bytes|Blob（store 传 toU8 后的 Bytes，folder-flow 传 encode 出的 Blob；内部交 provider.upload）。
export interface CloudSync {
  // encrypted：字节是加密容器（ADR-0012）→ 落 encFileName（.zip）路径；未配 encFileName 时忽略。
  push(name: string, bytes: Bytes | Blob, opts?: { baseEtag?: string | null; encrypted?: boolean }): Promise<PushResult>;
  pull(name: string): Promise<PullResult | null>;
  fetchMeta(name: string): Promise<FetchMetaResult | null>;
  /** 尾部 byte-range 纯读（peek 预览纯云端文件用；store.getTailBytes 的云端腿）。 */
  pullTail(name: string, n: number): Promise<{ bytes: Bytes; item: CloudItem } | null>;
  weakOverride(name: string, bytes: Bytes, opts?: { encrypted?: boolean }): Promise<WeakOverrideResult>;
  trash(name: string): Promise<unknown>;
  restore(cloudItemId: string, name: string): Promise<unknown>;
  purge(cloudItemId: string): Promise<unknown>;
  list(): Promise<CloudItem[]>;
  listAll(): Promise<{ files: CloudItem[]; folders: string[]; complete: boolean }>;
  listFolders(): Promise<string[]>;
  listTrash(): Promise<CloudItem[]>;
  rename(oldName: string, newName: string): Promise<unknown>;
  remove(name: string): Promise<unknown>;
  ensureFolder(path: string): Promise<void>;
  removeFolder(path: string): Promise<boolean>;
  isDirty(name: string): boolean;
  setDirty(name: string, dirty: boolean): void;
  getETag(name: string): string | null;
  setETag(name: string, etag: string | null): void;
  clearState(name: string): void;
}

// ---- busy 注入（UI 锁；契约详见 store.ts createStore JSDoc）----
export type BusyFn = <T>(label: string, fn: () => Promise<T>) => Promise<T>;
