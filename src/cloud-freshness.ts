// 职责（单一）：前台云端新鲜度 —— 开图时的云端检查门 + 事件驱动「干净快进」+ 闲置锁屏（ADR-0016 / ADR-0017）。
//
// 这是从 app.js god-file 切出来的「这张画相对云端新不新鲜、什么时候该提醒/快进到云端最新」那一轴。
// **红线（CRITICAL）**：本模块只 RELOCATE 编排，**绝不**改任何 _store.* / store.* 调用（参数/顺序/语义全保原样）。
//   push-vs-pull / If-Match / parentBase / 备份先于覆盖 / coalescer 全在 Store 库内 enforce；
//   本模块只是把「何时调 flow.open / flow.refresh + 之后刷哪块 UI / 弹哪个 gate」从 app.js 搬过来。
//   要改 store 行为 → STOP，escalate。
//
// 对外导出（app.js boot/handlers + session-state 经 ctx 消费）：
//   - gateCloudSyncOnOpen(sessionName)：开图后调一次（session-state 也经 ctx 调）。
//   - getLocalSavedAtLabel()：本地落盘时刻标签（session-state newer-banner 也经 ctx 调）。
//   - maybeFastForwardActive({ manual })：事件驱动干净快进（topSaveBtn / 锁屏继续后调）。
//   - showIdleLockIfStale()：闲置锁屏判定（online 事件 / onForeground / tick 调）。
//   - _markActivity()：重置闲置计时（开图成功后 checkCloudETag 内调；boot 全局监听也挂它）。
//
// 依赖绑定：board / withBusy / setStatus / updateSaveStatus 经 initCloudFreshness(ctx) 注入；
//   session / store+auth / sheet gate / decodeOraToDoc / els 直接 import（leaf/singleton）。

import { session } from "./session-state.ts";
import {
  isSignedIn, isCloudDirty,
  isAuthConfigured, getLastSessionSignedIn, retrySilentSignIn, signIn,
  store as _store,
} from "./app-store.js";
import { lockSyncGate, settleSyncGate } from "./sheets.ts";
import { decodeOraToDoc } from "./ora.js";
import { els } from "./els.ts";

// ---- ctx-bound 协作件（app 拥有，boot 时 initCloudFreshness(ctx) 注入）----
let board: any, withBusy: any, setStatus: any, updateSaveStatus: any;

// 主流程：openSession 后调一次
async function gateCloudSyncOnOpen(sessionName) {
  // 未登录过 / 没开 OneDrive 配置 → 不卡
  if (!isAuthConfigured() || !getLastSessionSignedIn()) return;

  const online = navigator.onLine;
  // 上次登录这次离线 → 锁屏问意图（不动 lastSessionSignedIn 直到 user 选）
  if (!online) {
    const choice = await lockSyncGate({
      title: "未连接网络",
      message: "上次是登录 OneDrive 状态。离线只能用本地缓存。",
      showSpinner: false,
      actions: [
        { label: "离线模式", value: "offline" },
        { label: "稍后再试（取消）", value: "offline", primary: false },
      ],
    });
    if (choice === "offline") setStatus("离线模式：用本地缓存", true);
    return;
  }

  // 上次登录这次在线但 isSignedIn() false → 先 silent retry 一次确认；
  // user：「老是提示 onedrive token 过期，但实际上可以正常拉取保存」
  // → isSignedIn() 是 stale 状态，silent acquire 仍可能拿到 token
  if (!isSignedIn()) {
    try { await retrySilentSignIn(); } catch (_) {}
  }
  // 真的拿不到 token → 才弹 gate
  if (!isSignedIn()) {
    const choice = await lockSyncGate({
      title: "OneDrive 登录已过期",
      message: "token 失效。重登拿云端，离线用本地。",
      showSpinner: false,
      actions: [
        { label: "重新登录", value: "signin", primary: true },
        { label: "离线模式", value: "offline" },
      ],
    });
    if (choice === "signin") {
      try { await signIn(); setStatus("已登录"); }
      catch (e) { setStatus("登录失败：" + (e.message || e), true); return; }
      // 登录成功 → 重入流程
      return gateCloudSyncOnOpen(sessionName);
    }
    return;     // offline
  }

  // 登录 + 在线 + token 有效 → 拉云端 etag 比对
  await checkCloudETag(sessionName);
}

// 拉 etag 比对 + 冲突决断 —— 整套（备份先于覆盖 / keep-pull-branch）已收进 store.flow.open。
// 这里只剩 UI：spinner 锁屏 + 「跳过到离线」probe + 弹「拉/留/分支」+ 状态提示。
async function checkCloudETag(sessionName) {
  if (!sessionName) return;
  // spinner 锁屏；点「跳过到离线」→ resolve probe（flow.open 内部 race 到 skip）。
  // 注意：settleSyncGate(null)（fetch 赢 / onNewer 弹窗时）也会 resolve 这个 promise，值是 null——
  //       只有 value.kind==="skip"（用户真点了按钮）才算跳过，避免误判。
  let onSkip;
  const probe = new Promise((res) => { onSkip = res; });
  let skipped = false;
  lockSyncGate({
    title: "检查云端", message: sessionName, showSpinner: true,
    actions: [{ label: "跳过到离线", value: { kind: "skip" } }],
  }).then((v) => { if (v && v.kind === "skip") { skipped = true; onSkip(); } });

  let res;
  try {
    res = await _store.flow.open(sessionName, {
      isOnline: () => navigator.onLine !== false,
      probe,
      now: () => Date.now(),
      localDirty: () => _store.edits.localDirty(),   // 未落盘编辑也算 dirty → 不静默快进（ADR-0016）

      // 云端比 base 新 → 关 spinner，弹「保留 / 覆盖 / 分支」。pull/branch 的备份+覆盖由 flow.open 内执行。
      onNewer: async ({ cloudTime }) => {
        settleSyncGate(null);
        return await lockSyncGate({
          title: "云端有新版本",
          message: `${sessionName} 在云端 ${formatCloudTime(cloudTime)} 有新版本。本地是 ${getLocalSavedAtLabel()}。`,
          showSpinner: false,
          // spec（file-enter）：安全项 keep 默认（本地可能有未推编辑，默认拉云会丢）。
          actions: [
            { label: "保留本地（之后 push 会再确认）", value: "keep", primary: true },
            { label: "用云端覆盖本地（本地先备份进 .backup）", value: "pull" },
            { label: "两份都留（云端另存为副本）", value: "branch" },
          ],
        });
      },
      adopt: async (blob, nm) => { const loaded = await decodeOraToDoc(blob); session.adopt(loaded, nm); },
    });
  } finally {
    settleSyncGate(null);   // 收尾确保 spinner 关（已关则安全 no-op）
  }

  // flow.open 的 source/reason → 状态提示
  if (res.source === "fast-forwarded") setStatus(`已同步到云端最新：${sessionName}`);   // clean 静默快进（ADR-0016）
  else if (res.source === "pulled") setStatus(`已拉云端；本地原版备份为「${res.backupName}」`);
  else if (res.source === "branched") setStatus(`云端版已开为「${res.branchName}」`);
  else {
    const reason = res.reason;
    if (skipped || reason === "skipped") setStatus("已跳过云端检查，用本地版本");
    else if (reason === "cloud-error") setStatus("连不上云端，用本地版本");
    else if (reason === "backup-failed") setStatus(`本地备份失败，已取消拉云端（本地未动）`, true);
    else if (reason === "cloud-vanished") setStatus(`云端找不到「${sessionName}」（本地未动）`, true);
    else if (reason === "kept") setStatus("已保留本地，云端版本暂不动");
    // in-sync / cloud-absent → 静默
  }
  // 成功联到云（非离线/出错/跳过）→ 记新鲜度时刻（ADR-0017：开图本身就是一次云端检查）。
  _markActivity();   // 刚开图 = 用户主动到场 → 重置闲置计时（别一进来就快到锁屏阈值）
}

// ADR-0016 §2：事件驱动的「干净 Work 无损快进」。放下 A 设备、回到 B 设备 → B 触发 focus/visibility/online →
// B 干净时先快进到云端最新（= A 的版本）再落笔 → B 的第一笔就根于最新 → B 的 push 是干净 If-Match（零 412 零 backup）。
// **硬约束（ADR-0016 §7）**：绝不每笔/每编辑触发——只挂人速事件；refresh 内部只 fetchMeta（etag 真动才拉内容）。
// ADR-0017（修订 2026-06-06）：**不做后台静默刷新**——内容创作里盯着画布时内容 unsolicited 突变会让人疯。
//   新鲜度走 **explicit 超时锁屏**：距上次动笔/操作 ≥ IDLE_LOCK_AFTER → 像 iPad 闲置熄屏那样**锁屏**；
//   点「继续」= 用户主动 → 才查云 + 干净则快进（任何内容变更都在用户点继续之后发生 = solicited）。
//   新鲜度是 wall-clock 属性、不靠 timer tick——suspend 期间 timer 冻结不跑，回前台靠 visibility/focus 现算
//   （关机一周再开 → 第一个事件即判 idle → 锁屏；绝不把周龄当新鲜、绝不静默 FF）。
const IDLE_LOCK_AFTER_MS = 3 * 60 * 1000;           // 距上次动笔/操作 ≥ 此 → 锁屏（explicit 继续才刷新）
let _lastActivityAt = Date.now();                   // 上次动笔/操作的时刻（idle 锁屏用）
let _idleLockShowing = false;
function _markActivity() { _lastActivityAt = Date.now(); }
// 注：save 图标 synced 态固定显「云✓+角标刷新箭」（中性色，含义=上次保存已同步·点击检查新版本），
//   不随时间变样——「过期该刷新」由闲置锁屏负责，不在图标上。故无云端新鲜度时钟（_lastCheckedAt 已删）。

let _ffInFlight = false;
async function maybeFastForwardActive({ manual = false } = {}) {
  if (_ffInFlight) return;
  if (!isSignedIn() || navigator.onLine === false) { if (manual) setStatus("离线，暂时无法检查云端", true); return; }
  const name = session.name;
  if (!name || name === "未命名") return;
  if (els.galleryFull && !els.galleryFull.classList.contains("hidden")) return;   // 在图库（无活动画布）不 FF
  if (_store.edits.localDirty() || isCloudDirty(name)) return;                     // 仅干净（refresh 内还会再判，这里先省一次网络）
  _ffInFlight = true;
  try {
    const vp = { ...board.viewport };   // 视口是设备态：FF 换的是内容，别让本设备的 zoom/pan 跟着跳
    const res = await _store.flow.refresh(name, {
      isOnline: () => navigator.onLine !== false,
      localDirty: () => _store.edits.localDirty(),
      adopt: async (blob, nm) => { const loaded = await decodeOraToDoc(blob); session.adopt(loaded, nm); },
      busy: manual ? withBusy : undefined,   // 手动点 → 锁屏（反馈 + 防刷新中途动笔）；自动轮询 → 静默
    });
    if (res.status === "fast-forwarded") {
      board.setViewport(vp.tx, vp.ty, vp.scale, vp.rot || 0);   // 还原本设备视口
      setStatus(`已同步到云端最新：${name}`);
    } else if (manual && res.status === "in-sync") {
      setStatus(`已是云端最新：${name}`);
    }
    updateSaveStatus();   // 刷新新鲜度指示（synced 图标 fresh/stale）
  } catch (e) { console.warn("[ff] 快进失败：", e); }
  finally { _ffInFlight = false; }
}

// ADR-0017（修订）：超时 → 锁屏，点「继续」才 explicit 刷新。复用 lockSyncGate 当锁屏覆盖。
//   只在「活动·干净·已同步·登录·在线·闲够了·没别的 gate」时锁——这正是原来会**静默 FF** 的时机，
//   现在改成等用户主动点继续才把内容换到云端最新（绝不在你看着画布时突变）。dirty/离线/图库 → 不锁。
async function showIdleLockIfStale() {
  if (_idleLockShowing) return;
  if (!isSignedIn() || navigator.onLine === false) return;
  const name = session.name;
  if (!name || name === "未命名") return;
  if (els.galleryFull && !els.galleryFull.classList.contains("hidden")) return;   // 图库里不锁
  if (_store.edits.localDirty() || isCloudDirty(name)) return;                     // 有未存/未推编辑 → 不锁（不会 FF，你的活还在）
  if (Date.now() - _lastActivityAt < IDLE_LOCK_AFTER_MS) return;                   // 还没闲够
  _idleLockShowing = true;
  try {
    await lockSyncGate({
      title: "暂离编辑",
      message: "离开一会儿了。点「继续」会检查云端最新版本（可能是其他设备的改动）。",
      showSpinner: false,
      actions: [{ label: "继续编辑", value: "resume", primary: true }],
    });
  } finally {
    settleSyncGate(null);   // 收尾（已关则 no-op）
    _idleLockShowing = false;
    _markActivity();        // 点了继续 = 重新活跃，重置闲置计时
  }
  await maybeFastForwardActive({ manual: true });   // explicit：查云 + 干净则快进（withBusy 锁着拉，拉完才放手）
}

function formatCloudTime(iso) {
  if (!iso) return "?";
  const t = Date.parse(iso);
  if (!t) return iso;
  const d = new Date(t);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function getLocalSavedAtLabel() {
  if (!session.docLastSavedAt) return "（未保存）";
  const d = new Date(session.docLastSavedAt);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export {
  gateCloudSyncOnOpen,
  getLocalSavedAtLabel,
  maybeFastForwardActive,
  showIdleLockIfStale,
  _markActivity,
};

// ADR-0017（修订）前台新鲜度 —— **不静默 FF**，超时 explicit 锁屏：
//   · 活动监听：动笔/操作重置闲置计时（pointerdown/keydown 全局 capture）。
//   · idle 检查 tick：前台时每 30s 看闲够没 → 锁屏（像 iPad 闲置熄屏；suspend 时 timer 冻结，回前台靠 visibility 现算）。
export function initCloudFreshness(ctx) {
  board = ctx.board;
  withBusy = ctx.withBusy;
  setStatus = ctx.setStatus;
  updateSaveStatus = ctx.updateSaveStatus;

  document.addEventListener("pointerdown", _markActivity, true);
  document.addEventListener("keydown", _markActivity, true);
  setInterval(() => { if (document.visibilityState === "visible") showIdleLockIfStale(); }, 30 * 1000);
}
