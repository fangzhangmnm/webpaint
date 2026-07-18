// app-store —— WebPaint 装配 sync-store 的唯一点（cutover：薄库 + editor-session）。
//   只做 config 注入（provider / ui bundle / crypto codec / crypt / validateAdopt）+ auth 转发 + gallery 列举适配。
//   app 只碰 store 两面（**file / collection**）+ editor-session。绝不裸碰 kv/IDB/graph/vendor。
//   （localSettings/syncedSettings 那两面已于 2026-07-13 删除 —— 全部 KV 化进 collection。别照旧注释找。）
import { createStore, createOneDriveProvider, isCached, isDirty } from "./store/index.ts";
import { stripSessionExt, sessionFileName } from "./config.ts";
import { storeUI } from "./store-ui.ts";
import { CLIENT_ID, SCOPES } from "./config.ts";
import { zipReadEntry, zipPack, zipUnpack } from "./zip.ts";
import { pack7z, unpack7z } from "./sevenzip.ts";
import { getPassword } from "./crypto-state.ts";
import { wirePreferences } from "./app-prefs.ts";
import { wireAppState, appState } from "./app-state.ts";
import { builtinBrushInitData } from "./brushes.ts";

// OneDrive provider + auth。
const od = createOneDriveProvider({ clientId: CLIENT_ID, scopes: SCOPES, msalUrl: "./vendor/msal/msal-browser.min.js" });
export const provider = od.provider;
const _auth = od.auth;

// 加密 codec 注入（不注入 = 加密 dormant）。
const cryptoCodec = { zipPack, zipUnpack, pack7z, unpack7z };

// 唯一 store（薄库）。app 建它（含 ui bundle）；migration 内部自跑（createStore 隐形，app 不 await）。
export const store = createStore({
  provider,
  ui: storeUI,
  appId: "webpaint",   // 本 origin 内唯一命名空间（databaseId 默认 "defaultStore"）：IDB 库 webpaint.defaultStore + localStorage webpaint.defaultStore.* 键，与兄弟 PWA(JRP 等)隔离
  // 薄命名（身份=全名）：**app 不再注入 fileName/encFileName**——库默认 fileName 恒等（身份即云端文件名）、
  //   encFileName 追加 .zip（加密容器外扩展名 ADR-0012）。app 在**边界**用 sessionFileName 把裸 session 名转成全名
  //   （X→X.ora）再传库（见 session-state 的 _file / editor-session 的 name；OUT 侧 itemToG 用 stripSessionExt 还原显示）。
  //   加密件云端 = X.ora.zip（追加，无损可逆），由库据字节加密态自动翻转，app 只管明文全名。
  //   身份从出生即全名——无迁移（无用户/无后向兼容，2026-07-13 清 tax；migration 框架留库内待将来）。
  crypto: cryptoCodec,
  crypt: {
    ext: "ora",
    makePeek: async (blob) => { try { return await zipReadEntry(blob, "Thumbnails/thumbnail.png"); } catch { return null; } },  // ora 内容知识只此一行
    getPassword,
  },
  // 采纳云字节前验真内容。**只看魔数**，不解密（这是 createStore 的 config，此刻 store 还没建好，
  //   也拿不到 store.encryption；而且这里本就只需要便宜的分流判定）。
  //   明文 ora = zip（PK\x03\x04）；加密容器 = 外壳 zip 或裸 7z —— 两者的头都在这四个字节里判得出，
  //   7z 魔数 "7z\xBC\xAF\x27\x1C" 前四字节即可识别。挡的是 captive-portal HTML / 截断字节。
  validateAdopt: async (blob) => {
    const h = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
    const eq = (...b: number[]) => b.every((v, i) => h[i] === v);
    if (eq(0x50, 0x4B, 0x03, 0x04)) return true;                     // ZIP "PK\x03\x04"：明文 ora，或加密件的明文外壳
    if (eq(0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C)) return true;         // 7z  "7z\xBC\xAF\x27\x1C"：裸 .7z 容器（老格式）
    return false;
  },
  autoCacheOpenedFile: true,
  signedIn: () => _auth.isSignedIn(),   // 连接态 store 自持（网盘模型）：watchFolder/云列举不再由 app 每次传 ctx
  // 当前打开的 doc（全名）：cloud-gone 去抖 trash 绝不碰它（连 watchFolder 自动 reconcileFolder 也跳过，防 trash 掉开着的 clean 文件本地缓存）。
  //   appState.currentFile = 活动 doc 裸名（退出置 null）；边界转全名。pre-init 抛 → null（不跳过，无害）。
  activeFileName: () => { try { return appState.currentFile ? sessionFileName(appState.currentFile) : null; } catch { return null; } },
});

// ============ 设置/状态 collection（4 个）注入 ============
// app-prefs/app-state **不 import 本文件**（防 i18n→app-store→store-ui→i18n 成环）；由此处建好 store 后惰性注入。
//   synced 变体上云 + scaffold；{local:true} 变体 local-only（设备本地、不碰云）。boot 门 await init* 后才读写。
wirePreferences(store.collection("local-user-preference", { local: true }), store.collection("synced-user-preference"));
wireAppState(store.collection("synced-app-state"), store.collection("local-app-state", { local: true }));

// ============ auth（转发）============
export const isAuthConfigured = () => _auth.isAuthConfigured();
export const initAuth = (...a: Parameters<typeof _auth.initAuth>) => _auth.initAuth(...a);
export const signIn = (...a: Parameters<typeof _auth.signIn>) => _auth.signIn(...a);
export const signOut = (...a: Parameters<typeof _auth.signOut>) => _auth.signOut(...a);
export const isSignedIn = () => _auth.isSignedIn();
export const getActiveAccount = () => _auth.getActiveAccount();
export const retrySilentSignIn = (...a: Parameters<typeof _auth.retrySilentSignIn>) => _auth.retrySilentSignIn(...a);
export const getToken = (...a: Parameters<typeof _auth.getToken>) => _auth.getToken(...a);
export const onAuthChanged = (cb: Parameters<typeof _auth.onAuthChanged>[0]) => _auth.onAuthChanged(cb);
export const getAuthState = () => _auth.getAuthState();

// 上次登录 flag（设备级 auth flag → local-app-state collection，经 appState struct）。boot 门 init 后才读写。

// ---- gallery 数据：统一列举（local ∪ cloud，每项带 syncState）。reconcile 已进库（watchFolder 惰性 per-folder）。----
const _CLOUD_STATES = new Set(["cloud-only", "synced", "unpushed", "newer-on-cloud", "conflict"]);   // 有云版的 syncState
// Item{path,syncState} → 旧 GalleryItem{name,local,cloud,dirty,ghost}（gallery-view-model 兼容；派生自 syncState）。
function itemToG(it: { path: string; syncState: string; lastModified?: number; size?: number }) {
  const name = stripSessionExt(it.path);
  return {
    name,
    // 本地项也带 size/updatedAt（listing 现从本地缓存记录填）→ 离线 / 云端帧到达前不显 0B/1970（itemTime 优先读 local.updatedAt）。
    local: isCached(it.syncState as never) ? { name, size: it.size, updatedAt: it.lastModified } : null,
    // size 从 store Item 带出来（listing 已从云端 c.size 或本地 stat 解析）→ 图库显真尺寸而非 0 B。
    cloud: _CLOUD_STATES.has(it.syncState) ? { path: it.path, name, size: it.size, lastModifiedDateTime: it.lastModified ? new Date(it.lastModified).toISOString() : undefined } : null,
    dirty: isDirty(it.syncState as never),
    ghost: it.syncState === "ghost",
    pendingGone: it.syncState === "pendingGone",   // clean cloud-gone 孤儿、防抖 grace 内 → gallery 显 badge + 重传/删动作
  };
}
// watchFolder（网盘模型）：订阅**当前文件夹** → 立即本地帧、云端到了同一 cb 再闪。app 只知「这一夹更新了」。
//   替代全树列举（JRP 开夹慢的根因）；连接态 store 自持、无 ctx。folderNames = immediate 子夹名。（映射 store.Item → app GItem。）
export function watchFolder(
  folder: string,
  cb: (snap: { path: string; items: ReturnType<typeof itemToG>[]; folderNames: string[] }) => void,
): () => void {
  const prefix = folder ? `${folder}/` : "";
  return store.files.watchFolder(folder, (snap) => {
    cb({
      path: snap.path,
      // 文件名**倒序**（localeCompare numeric）：新文档名 yyyymmdd-xxxx → 新日期在前，稳定（不随存盘时间跳）。
      //   store 列举顺序不保证；排序是 app 展示策略（对齐 gallery-model.sliceFolder 的既定倒序），故在此 app 层做。
      items: snap.items.map(itemToG).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })),
      folderNames: snap.folders.map((f) => f.slice(prefix.length)).filter(Boolean),   // 全路径 → immediate 段
    });
  });
}
// ⛔ listGallery（全树列举）已删 2026-07-12——**库唯一列举面 = store.watchFolder（订阅当前夹）**，app 包成 watchFolder。
//   app 原则上不知道别的 folder 内容（内存只放当前夹）；名字碰撞由 store rename/saveAs 目标护栏内化检测（撞名抛 CloudNameCollisionError），不靠先 list 目标夹。
// 回收站视图：store.listTrash 返**两端聚合**的 TrashItem[]（side/localKey/cloudItemId/encrypted/conflictLive）→ 映射成 gallery 的 TrashGItem。
//   local/cloud 两腿据 localKey/cloudItemId 填（app 原有 both-side 模型此前从没被本地腿填充）。只元数据，无 blob。
export const listGalleryTrash = async () => (await store.files.listTrash()).map((it) => ({
  name: stripSessionExt(it.name),
  deletedAt: 0,
  encrypted: it.encrypted,
  conflictLive: it.conflictLive,
  local: it.localKey ? { name: stripSessionExt(it.name), trashKey: it.localKey, encrypted: it.encrypted } : null,
  cloud: it.cloudItemId ? { path: it.name, id: it.cloudItemId } : null,
}));

// ---- brush-rack collection（逐 brush 一 item + 一条 .meta）：持久化 + 云同步唯一入口，红线在库内。----
//   getInitData（brushes.ts 域构造）：仅当这份 collection 的 json 不存在（新库）时 fetch builtin-brushes.json
//   映射成 [{id,value}…, {.meta}] 填初始值（uat=1，任何真实编辑 / 别设备真数据必胜）。
//   dirty / 冲突 / 墓碑 全归 collection；app 侧 brush-rack-controller 只做编排（无 rackStore/setRackDirty）。
export const brushRackCollection = store.collection("brush-rack", { getInitData: builtinBrushInitData });
