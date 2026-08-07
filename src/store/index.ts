// @local/sync-store —— 唯一公开入口（封口）。
//
// ⚠ 接库只准从这里拿 createStore + 一个 provider。**绝不 deep import 内部文件**
//   （cloud-sync / local-head / push / seal / safe-resolve / folder-* / store.ts …）——
//   那些是红线 guts，绕过 = 绕过红线（见 README.md 铁律）。
//   ✅ scripts/build.sh 有真的 deep-import lint 挡着（v415 补——在那之前这句是**谎注释**，只有约定没有守卫）。
//   要用的东西这里没导出 → 说明公开面缺了，补这里的 export（并想清楚该不该暴露），别绕过封口。
export { createStore } from "./create-store.ts";
export type { StoreConfig, StoreUI, RawFile, ZipFile, Store, EncryptedBlob } from "./create-store.ts";
// 统一列举面（README §2）：Item/SyncState/ListContext + syncState 便利判定（isCached/isDirty）。
export type { Item, SyncState, ListContext } from "./listing.ts";
export { isCached, isDirty } from "./listing.ts";
export type { Bytes } from "./types.ts";   // 字节别名（host adapter 的类型用；不暴露内部文件路径）
// 加密：**裸字节**级的面走 store.encryption（有 name 的场景走 file.*）；EncryptedBlob 是 at-rest 密文的 branded 类型。
export type { Collection, CollectionEntry, ReconcileResult } from "./collection.ts";
// 本地缓存 adapter（host 装配 createStore 时注入 local 用；prod=idb）。
export { createLocalCache } from "./local-cache.ts";

// provider（云端低层 adapter）：OneDrive（浏览器）/ graph 适配器（可 mock 验）。
export { createOneDriveProvider } from "./providers/index.ts";
export type { AuthState } from "./providers/auth.ts";   // .h 生成需要可命名（TS4023）；公开面缺了就补这里
export { graphToCloudProvider } from "./onedrive-provider.ts";
//   注：迁移（migration）不暴露——createStore 内部自跑（数据搬迁是同步细节，app 不该看见）。
//   brush-rack 走 store.collection、gallery 缩略图/文件夹走 file.getPeek / store.list——不再 deep import
//   cloud-sync/folder-store/graph（接口尽可能瘦，见 ADR：迁移的意义=发现最少接口）。
