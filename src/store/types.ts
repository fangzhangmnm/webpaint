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

// 删空夹的判别式结果。**backend 侧唯一的文件夹删除面**——递归/无条件的 delete(id) 不暴露给上层删文件夹，
//   护栏（只删空夹）由 provider 保证。四态让上层区分：deleted/already-gone=终态成功；non-empty=有内容（drain 取消、
//   online 拒删）；list-failed=列举失败确认不了空（drain 留队 defer、online 拒删）。绝不 throw 非空/列举失败（用 status 表达）。
export interface FolderDeleteResult { status: "deleted" | "already-gone" | "non-empty" | "list-failed" }

// 低层云端传输契约。WebPaint 用 OneDriveProvider（包 Graph），测试用 MockProvider。
export interface CloudProvider {
  list(folder?: string): Promise<CloudItem[]>;
  getItemByPath(path: string): Promise<CloudItem | null>;
  getApprootId(): Promise<string>;
  download(id: string): Promise<Blob>;
  downloadRange(id: string, offset: number, length: number): Promise<Uint8Array | ArrayBuffer | Blob>;
  upload(path: string, blob: Bytes | Blob, opts?: UploadOpts): Promise<CloudItem>;
  ensureFolder(path: string): Promise<string>;
  delete(id: string, eTag?: string): Promise<void>;   // 文件硬删（trash purge）。eTag=If-Match（硬删不可逆，必带）。**文件夹删除不走它**——走 deleteEmptyFolder（护栏在 provider）。
  // 删**空**文件夹（唯一文件夹删除面）：provider 内部证实空才删（Graph 无 native「删空夹」→ list-then-delete，带 If-Match folder etag best-effort）。
  deleteEmptyFolder(path: string): Promise<FolderDeleteResult>;
  move(id: string, targetFolderId: string, opts?: MoveOpts): Promise<CloudItem>;
  rename(id: string, newName: string, eTag?: string | null): Promise<CloudItem>;
}

// ---- 本地持久层（LocalCache）：store.local 契约（**内容无关**，存任意 binary blob）----
// **字节边界关键点**（0B bug 雷区）：save 可收 Bytes 或 Blob（store 流经 toU8 给的是 Bytes），
//   但内部必须落 Blob（size/上传/读取都按 Blob 算）；get 出 Blob。类型在此写死，错配即编译错。
export interface TrashEntry {
  trashKey: string;
  name: string;
}
export interface LocalCache {
  /** hint：save 透传的 app 旁路（store 不解释、不看内容；app 可经 hint.peek 供不透明 sidecar 字节）。 */
  save(name: string, bytes: Bytes | Blob, hint?: unknown): Promise<unknown>;
  get(name: string): Promise<Blob | null>;
  exists(name: string): Promise<boolean>;
  /** 已缓存的**应用文件名**集合（排除 trash/backup/collection 内部命名空间）——gallery 批量判 cached 用。 */
  appKeys(): Promise<string[]>;
  /** 轻量元信息（size + updatedAt），不取 blob 内容。listing 给本地项填尺寸/时间（离线/云端帧到达前也不显 0B/1970）。缺 → null。 */
  stat(name: string): Promise<{ size: number; updatedAt: number } | null>;
  /** 本地已缓存文件的总占用（字节 + 件数）。单事务 cursor，不载字节内容。
   *  ⚠ **只返标量，永不返名字** —— 这是刻意的：全库列举是被否决的退化设计（列举只走 per-folder watchFolder）。 */
  usage(): Promise<{ bytes: number; count: number }>;
  backup(name: string): Promise<string>;
  /** 移进本地 .trash。deleteEventId 由 delete.ts 生成、与云端腿**共用**（trash-merge 据此精确配对）。返 trashKey。 */
  trash(name: string, deleteEventId: string): Promise<string>;
  hardDelete(name: string): Promise<void>;
  restore(trashKey: string): Promise<string>;
  purgeTrash?(trashKey: string): Promise<void>;
  listTrash?(): Promise<TrashEntry[]>;
  /** 备份分区列举（weakOverride/keepMine loser 的本地 stash）——回收站/备份视图两端聚合用。restore/purgeTrash 已认 `backup/` 前缀 key。 */
  listBackup?(): Promise<TrashEntry[]>;
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
  /** 任意绝对偏移 byte-range 纯读（getPeek 的「CD / entry 溢出尾片时二次拉」用）。越界自动钳。 */
  pullRange(name: string, offset: number, length: number): Promise<{ bytes: Bytes; item: CloudItem } | null>;
  weakOverride(name: string, bytes: Bytes, opts?: { encrypted?: boolean }): Promise<WeakOverrideResult>;
  /** 移进云端 .trash。deleteEventId 同上——两条腿必须是同一个，否则回收站里一次删除会裂成两行/误配。 */
  trash(name: string, deleteEventId: string, opts?: { baseEtag?: string | null }): Promise<unknown>;
  /** enc.encrypted：trash 里的字节是加密容器（.zip 尾）→ 恢复必须落 encFileName（否则加密件被恢复到明文路径 = 打不开）。 */
  restore(cloudItemId: string, name: string, opts?: { encrypted?: boolean; eTag?: string | null }): Promise<unknown>;
  purge(cloudItemId: string, eTag?: string | null): Promise<unknown>;
  list(): Promise<CloudItem[]>;
  listAll(): Promise<{ files: CloudItem[]; folders: string[]; complete: boolean }>;
  /** 单夹列举（非递归，一次 provider.list 往返）——watchFolder / per-folder reconcile 用。
   *  files/folders = 该夹**直属**子项（folders=immediate 子夹全路径）。complete=false → 这一夹 list() 抛错
   *  （离线/未登录/子树失败）→ 调用方当「该夹不权威」处理，**绝不据此判 cloud-gone**（与 listAll 的 partial 守卫同纪律）。 */
  listFolder(path: string): Promise<{ files: CloudItem[]; folders: string[]; complete: boolean }>;
  listFolders(): Promise<string[]>;
  listTrash(): Promise<CloudItem[]>;
  listBackup(): Promise<CloudItem[]>;
  rename(oldName: string, newName: string, opts?: { baseEtag?: string | null }): Promise<unknown>;
  ensureFolder(path: string): Promise<void>;
  deleteEmptyFolder(path: string): Promise<FolderDeleteResult>;   // 薄委托 provider.deleteEmptyFolder（护栏在 backend）
  isDirty(name: string): boolean;
  setDirty(name: string, dirty: boolean): void;
  getETag(name: string): string | null;
  setETag(name: string, etag: string | null): void;
  clearState(name: string): void;
}

// ---- busy 注入（UI 锁；契约详见 store.ts createStore JSDoc）----
export type BusyFn = <T>(label: string, fn: () => Promise<T>) => Promise<T>;
