// 职责（单一）：顶栏 save 按钮 4 态渲染 + 文档版本 newer banner。
//   - computeSaveState：读 store（busy/edits/cloud）+ session.name + isSignedIn 推 save 态。
//   - updateSaveStatus：把 4 态渲染成顶栏 save 按钮的 icon/title/data-state（gallery-first 无 session 时隐）。
//   - updateNewerBanner：文档版本警告 banner（doc.body.dataset.docNewer 给 CSS 染色）。
// 依赖全是单例/leaf，直接 import：store/isSignedIn ← app-store.js，session ← session-state.ts，els ← els.ts。
// 注：ICON_DISK/ICON_UPLOAD/ICON_CLOUD_CHECK/ICON_CLOUD_BUSY 也被 app.js 的 rack.init({icons}) 消费，
//   故在此 export，app.js 改为从本模块 import（单一定义源）。
import { els } from "./els.ts";
import { store as _store, isSignedIn } from "./app-store.js";
import { session } from "./session-state.ts";

// 文档版本警告：在 setStatus 之上再呈现一个持久 banner（用 doc.body.dataset 给 CSS 染色）
export function updateNewerBanner() {
  if (session.loadedDocIsNewer && !session.loadedDocNewerConfirmed) {
    document.body.dataset.docNewer = "1";
  } else {
    delete document.body.dataset.docNewer;
  }
}

// v45 新语义：
//   **Ctrl+S / 点 save 按钮 = "save local + push cloud" 一把梭**（user 显式 consent）。
//   autosave (3min / visibility / pagehide) **仅写 IDB**，不触云 —— autosave
//   只防崩，IDB 是 transient（浏览器随时可能 evict / 用户清缓存），不算安全位置。
//   真正"安全"= 同步到云端。
//
//   Save 按钮 4 态：
//   - saving → 半透明
//   - dirty (本地未存) → 蓝色 disk + 角点
//   - cloud-dirty (IDB 已存但云端未同步) → 橙色上传箭头
//   - synced → 灰色对勾云（已安全）
//   - local-only (未登录云端) → 灰色 disk（提示 IDB 易失，建议登录）
//   点任意状态都触发 saveAndPush（dirty + cloud-dirty 一次性处理）。
//   冲突 (412) → alert 提示用户改名，本地已保存但云端没动。
export const ICON_DISK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';
export const ICON_UPLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
export const ICON_CLOUD_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 13 11 15 15 11"/></svg>';
// 上传中：云形 + 旋转的弧。CSS animation rotate 由 [data-state="cloud-busy"] 触发
export const ICON_CLOUD_BUSY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><g class="spin-arc" style="transform-origin: 12px 13px;"><path d="M9 13a3 3 0 0 1 5.5-1.6" /><polyline points="14.5 9.5 14.5 11.4 12.6 11.4" /></g></svg>';

export function computeSaveState() {
  // transient（本地未存/存盘中/推云中）= app 态；synced/dirty/local-only = store.cloud.status 单一源（候选2）。
  if (_store.busy.pushing()) return "cloud-busy";
  if (_store.busy.saving()) return "saving";
  if (_store.edits.localDirty()) return "dirty";
  // session.name: string|null；updateSaveStatus 在调本函数前已 `if(!session.name) return` 守门（跨函数 tsc 看不到）。
  const st = _store.cloud.status(session.name as string, { signedIn: isSignedIn(), hasLocal: true });
  if (st === "dirty") return "cloud-dirty";     // 本地已存、云端未同步
  if (st === "synced") return "synced";         // 与云端一致
  return "local-only";                          // 未登录（含 cloud-only/absent，对本地视角=只本地）
}
export function updateSaveStatus() {
  // gallery-first: 没绑 session → 隐藏 save btn（没东西可保存）
  if (!session.name) {
    els.topSaveBtn.dataset.state = "none";
    els.topSaveBtn.innerHTML = ICON_DISK;
    els.topSaveBtn.title = "未打开作品";
    return;
  }
  const state = computeSaveState();
  els.topSaveBtn.dataset.state = state;
  els.topSaveBtn.style.opacity = ""; els.topSaveBtn.style.color = "";   // 永不残留旧的灰/蓝 —— 云=可按态主题色（灰=不可按，禁用）
  const name = session.name;
  if (state === "cloud-busy") { els.topSaveBtn.innerHTML = ICON_CLOUD_BUSY; els.topSaveBtn.title = `上传中… · ${name}`; }
  else if (state === "saving")      { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `保存中… · ${name}`; }
  else if (state === "dirty")  { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `保存 + 推送 (Ctrl+S) · ${name} · 未保存`; }
  else if (state === "cloud-dirty") { els.topSaveBtn.innerHTML = ICON_UPLOAD; els.topSaveBtn.title = `推送到云端 (Ctrl+S) · ${name} · 本地已存，云端未同步`; }
  else if (state === "synced") {
    // synced = 云✓（上次保存时已同步）。中性可按态色；点击=检查云端有没有新版本（动作走 tooltip+行为）。
    els.topSaveBtn.innerHTML = ICON_CLOUD_CHECK;
    els.topSaveBtn.title = `已同步云端（上次保存时）· 点击检查是否有新版本 · ${name}`;
  }
  else                          { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = `已存本地（IDB 易失，登录云端更安全） · ${name}`; }
}
