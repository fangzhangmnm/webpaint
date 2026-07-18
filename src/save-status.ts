// 职责（单一）：顶栏 save 按钮 **3 态**渲染 + 文档版本 newer banner。
//   - computeSaveState：session.dirty + isSignedIn → dirty | synced | local-only。
//     （store cutover 后**不再读 busy/cloud**——sync 脏进列举，不是徽章热路径。旧注释说的"4 态/读 store"已不是事实。）
//   - updateSaveStatus：渲染成顶栏 save 按钮的 icon/title/data-state（gallery-first 无 session 时隐）。
//   - updateNewerBanner：文档版本警告 banner（doc.body.dataset.docNewer 给 CSS 染色）。
// 依赖全是单例/leaf，直接 import：isSignedIn ← app-store.ts，session ← session-state.ts，els ← els.ts。
import { els } from "./els.ts";
import { isSignedIn } from "./app-store.ts";
import { session } from "./session-state.ts";
import { t } from "./i18n/index.ts";

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
//   Save 按钮 3 态（cutover 后的真实集合）：
//   - dirty (本地未存) → 蓝色 disk + 角点
//   - synced → 灰色对勾云（已安全）
//   - local-only (未登录云端) → 灰色 disk（提示 IDB 易失，建议登录）
//   点任意状态都触发 saveAndPush。
//   （saving / cloud-dirty / cloud-busy 三态已随 cutover 消失——computeSaveState 不再产出它们；
//    对应的 ICON_UPLOAD / ICON_CLOUD_BUSY 图标和 styles.css 的 [data-state] 选择器一并作废。）
export const ICON_DISK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';
export const ICON_CLOUD_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 13 11 15 15 11"/></svg>';

function computeSaveState() {
  // cutover：busy/cloud 状态不再暴露（sync 脏进 listAllItems，非徽章热路径）。内存脏=session.dirty，其余按登录态。
  if (session.dirty) return "dirty";                       // 内存脏（未落盘）
  return isSignedIn() ? "synced" : "local-only";
}
export function updateSaveStatus() {
  // gallery-first: 没绑 session → 隐藏 save btn（没东西可保存）
  if (!session.name) {
    els.topSaveBtn.dataset.state = "none";
    els.topSaveBtn.innerHTML = ICON_DISK;
    els.topSaveBtn.title = t("save.none");
    return;
  }
  const state = computeSaveState();
  els.topSaveBtn.dataset.state = state;
  els.topSaveBtn.style.opacity = ""; els.topSaveBtn.style.color = "";   // 永不残留旧的内联灰/蓝，颜色一律交给 CSS 的 [data-state]
  //   ⚠ 按钮**永远可点**（零 disabled 逻辑）：synced 态的灰只是"没什么可存"的视觉，不是禁用。
  //   v409 起点它必 encode+推（forceSaveAndPush，让时间戳走字）。徽章只看内容脏，desk 改动 UI 静默。
  const name = session.name;
  if (state === "dirty")  { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = t("save.dirty", { name }); }
  else if (state === "synced") {
    // synced = 云✓（上次保存时已同步）。中性可按态色；点击=检查云端有没有新版本（动作走 tooltip+行为）。
    els.topSaveBtn.innerHTML = ICON_CLOUD_CHECK;
    els.topSaveBtn.title = t("save.synced", { name });
  }
  else                          { els.topSaveBtn.innerHTML = ICON_DISK; els.topSaveBtn.title = t("save.localOnly", { name }); }
}
