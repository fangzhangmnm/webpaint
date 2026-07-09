// @local/sync-store —— 唯一公开入口（封口）。
//
// ⚠ 接库只准从这里拿 createStore + 一个 provider。**绝不 deep import 内部文件**
//   （cloud-sync / local-head / push / seal / safe-resolve / folder-* / store.ts …）——
//   那些是红线 guts，绕过 = 绕过红线（见 README.md 铁律）。build.sh 的 lint 会挡 app 的 deep import。
export { createStore } from "./create-store.ts";
export type { StoreConfig, StoreUI, RawFile, ZipFile, Store } from "./create-store.ts";
// 统一列举面（README §2）：Item/SyncState/ListContext + syncState 便利判定（isCached/isDirty）。
export type { Item, SyncState, ListContext } from "./listing.ts";
export { isCached, isDirty } from "./listing.ts";
export type { Bytes } from "./types.ts";   // 字节别名（host adapter 的类型用；不暴露内部文件路径）
export type { Collection, CollectionItem } from "./collection.ts";
export type { LocalSettings, SyncedSettings } from "./settings.ts";
// 本地缓存 adapter（host 装配 createStore 时注入 local 用；prod=idb）。
export { createLocalCache } from "./local-cache.ts";

// provider（云端低层 adapter）：OneDrive（浏览器）/ graph 适配器（可 mock 验）。
export { createOneDriveProvider } from "./providers/index.ts";
export { graphToCloudProvider } from "./onedrive-provider.ts";
