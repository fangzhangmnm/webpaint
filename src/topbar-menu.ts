// 职责（单一）：顶栏按钮 + 汉堡菜单项 + 通用 sheet 开关 + 保存触发 的事件接线。
//
// 从 app.js god-file 切出来的「点哪个顶栏/菜单按钮 → 调哪条编排」那一轴。纯接线层：
// 把 DOM 监听绑到 els.*，回调里调 session.* / ctx 协作件。**不**持任何 SSoT 状态。
// （v415：本模块**不再直接碰 store** —— 一切经 session.*。原来那份 _store.flow/_store.session/
//   _store.autosave/_store.edits 的红线清单说的调用早已一个都不剩，import 也删了。）
//
// **红线（CRITICAL）**：本模块只接线，**绝不**改任何 session.* 调用的参数/顺序/语义。
//   另存为（runSaveAsFlow，入口 2026-08-21 挪进「导出与另存」hub 的「复制一份到图库」，
//   由 export-import-menu 的 choice sheet 调）用 session.saveAs（内部 = store.file(name,{mode:"new"}).save）；
//   menuRevert 用 session.readCheckpoint + session.adoptAsExisting（**既有身份**，别错用 adoptAsNew）。
//   要改 store 行为 → STOP，escalate。
//
// 留在 app.js（核心 HUD glue，**不**搬）：setStatus / updateZoomLabel / board.render HUD hook。
//
// ctx 绑入（initTopbarMenu(ctx)，gallery 晚绑后才调）：
//   input / doc / board / history / editMode / setStatus / updateSaveStatus / updateZoomLabel /
//   gallery / rack。
// 直接 import（leaf/singleton）：session、els、openInputSheet/openConfirmSheet/lockSyncGate、
//   setMenuOpen、decodeOraToPainting 等（以实际 import 块为准）。

import { session } from "./session-state.ts";
import { isUnlocked } from "./crypto-state.ts";
import { checkpointAgeMinutes } from "./checkpoint-policy.ts";
import { els } from "./els.ts";
import { openInputSheet, openConfirmSheet, openChoiceSheet, lockSyncGate } from "./sheets.ts";
import { setMenuOpen } from "./settings-menu.ts";
import { signIn, isSignedIn } from "./app-store.ts";   // auth 是公共面（cloud-auth-ui 同款直连；v415 红线针对的是 sync store，不含 auth）
import { isCloudEnabled } from "./cloud-capability.ts";
import { sessionNameConflict } from "./session-name.ts";
import { supportsFileSystemAccess, pickLocalOraFile } from "./local-file-session.ts";
import { anchorPopupToBtn } from "./anchored-popup.ts";
import { isBusyActive } from "./fullscreen-busy.ts";
import { reportError } from "./error-badge.ts";
import { decodeOraToPainting } from "./backend/ora.ts";
import { t } from "./i18n/index.ts";
import type { ViewLeaf } from "./backend/workpiece/painting-view.ts";

import type { AppContext } from "./app-context.ts";
const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e);

// ---- ctx-bound 协作件（app 拥有，boot 时 initTopbarMenu(ctx) 注入）----
let input: AppContext["input"], doc: AppContext["doc"], board: AppContext["board"], history: AppContext["history"], editMode: AppContext["editMode"];
let layers: AppContext["layers"];
let setStatus: AppContext["setStatus"], updateSaveStatus: AppContext["updateSaveStatus"], updateZoomLabel: AppContext["updateZoomLabel"];
let _signInNav = false;   // v0.6.22：登录 redirect 导航中，beforeunload 别挡
let rack: AppContext["rack"];

function closeSheet(sheet: HTMLElement, backdrop: HTMLElement) {
  backdrop.classList.add("hidden");
  sheet.classList.add("hidden");
}

// ============ smart save（2026-08-21 user 拍板）：save 按钮 / Ctrl+S 共用的唯一入口 ============
// 分支（smart 逻辑全在 handler 层，session-state 不动）：
//   · 无地本地文件      → saveAndPush（内部即「写回文件」，无云腿，照旧）
//   · 云功能关（cloud-capability，含容器未配置 auth）→ 只本地 save（短路云腿；commitPending 保
//     「显式保存收口 fill 预览」的 QA 2026-08-21 语义，与 Ctrl+Shift+S 同款）
//   · 已登录            → saveAndPush（行为不变）
//   · 已配置未登录（含 credential 过期掉线）→ 本地 save 照做 + 弹「现在登录同步？」确认 sheet
// 防烦：同一 session 点过「暂不」→ 之后只状态行提示，不再弹（module 级布尔，可调点——
//   若想改成「每 N 次再提醒」或跨刷新记忆，改这一个旗子的读写即可；点背板/Esc 取消**不**记防烦）。
let _cloudSignInPromptDeclined = false;
function smartSaveAndPush() {
  if (session.localFile) { void session.saveAndPush(); return; }
  // 无活动文档（gallery-first 未绑 session / 云关 boot 空白画布）：走旧路 → 「无文档不能保存」的
  //   诚实提示（saveAndPush 首行分支）。没有文档就没有「登录同步」可谈，不弹。
  if (!session.name) { void session.saveAndPush(); return; }
  if (!isCloudEnabled()) { void session.save({ commitPending: true }); return; }
  if (isSignedIn()) { void session.saveAndPush(); return; }
  // —— 已配置未登录：本地保存照做（不 await——sheet 弹出与 IDB 事务并行，beforeunload 偷存同款姿态）——
  void session.save({ commitPending: true }).catch(() => {});
  // 离线时登录无意义（与旧 menuSignIn「未登录+已配置+在线才显示」同判据）→ 不弹，只提示。
  if (_cloudSignInPromptDeclined || navigator.onLine === false) {
    setStatus(t("save.savedLocalNotSignedIn"), true);
    updateSaveStatus();
    return;
  }
  // ⚠ iOS 红线（本功能最关键的技术点）：loginRedirect 必须从按钮 click listener **同步**发起——
  //   `await openChoiceSheet(...)` 之后再 signIn 走的是 Promise resolve 的微任务续体，Safari 可能
  //   已丢 transient activation → 静默拦。故登录动作走 onPick（sheets.ts 在 click listener 内、
  //   resolve 之前同步调它）；返回值只用于「暂不/取消」的收尾。姿势照抄旧 menuSignIn
  //   （_signInNav 旗、save 不 await——上面已发、signIn().catch 报错）。
  void openChoiceSheet<"signin" | "later">(t("save.signInPromptTitle"), t("save.signInPromptMsg"), [
    {
      label: t("save.signInNow"), value: "signin", primary: true,
      onPick: () => {
        _signInNav = true;
        signIn().catch((e) => {
          _signInNav = false;
          setStatus(t("cf.signInFailed", { err: String((e as Error)?.message || e) }), true);
        });
      },
    },
    { label: t("save.signInLater"), value: "later" },
  ]).then((choice) => {
    if (choice === "signin") return;   // 登录已在 onPick 同步发起（redirect 导航中）
    if (choice === "later") _cloudSignInPromptDeclined = true;   // 显式「暂不」才记防烦；背板取消不记
    setStatus(t("save.savedLocalNotSignedIn"), true);
    updateSaveStatus();
  });
}

export function initTopbarMenu(ctx: AppContext) {
  input = ctx.input;
  doc = ctx.doc;
  board = ctx.board;
  history = ctx.history;
  layers = ctx.layers;
  editMode = ctx.editMode;
  setStatus = ctx.setStatus;
  updateSaveStatus = ctx.updateSaveStatus;
  updateZoomLabel = ctx.updateZoomLabel;
  rack = ctx.rack;

  // ---- undo / redo ----
  els.undoBtn.addEventListener("click", () => input.ctrlZ());
  els.redoBtn.addEventListener("click", () => input.redo());
  window.addEventListener("wp:histchange", (e: Event) => {
    els.undoBtn.disabled = !(e as CustomEvent).detail.canUndo;
    els.redoBtn.disabled = !(e as CustomEvent).detail.canRedo;
  });
  els.undoBtn.disabled = true;
  els.redoBtn.disabled = true;

  els.clearBackdrop.addEventListener("click", () => closeSheet(els.clearSheet, els.clearBackdrop));
  els.clearSheet.addEventListener("click", (e: Event) => {
    const a = (e.target as HTMLElement | null)?.closest("[data-clear]") ? ((e.target as HTMLElement).closest("[data-clear]") as HTMLElement).dataset.clear : undefined;
    if (!a) return;
    closeSheet(els.clearSheet, els.clearBackdrop);
    if (a !== "confirm") return;
    const layer = doc.activeLayer as ViewLeaf | null;
    if (!layer || layer.isGroup) return;
    // v0.8.3（S3）：走 ctx.layers.clearLayer（快照/清空/入栈收进组件），Ctrl+Z 能复活。
    layers.clearLayer(layer.id);
    board.invalidateAll();
    setStatus(t("tm.clearedActiveLayer"));
  });

  // ---- 保存触发：wp:histchange + wp:sidecarchange dirty 门 / Ctrl+S / beforeunload / topSaveBtn ----
  // 笔触结束 / undo / redo / 图层操作（wp:histchange）与 sidecar 变更（参考图等，wp:sidecarchange，
  // v0.8.5 S5）→ dirty。这是 work-file 的**唯一编辑门**（两个信号、同一张门）。
  // store.edit(name) 一处吸：推编辑游标(local-dirty) + 经门标云脏(捕 parentBase；不 gate signedIn)。
  // name 空（gallery-first 未绑 session）→ 只推游标。门机制全在库内（app 不再直调 setCloudDirty，ADR-0016 §4）。
  const _editGate = () => {
    if (session.loadingDoc) return;             // 加载期 clearHistory 的 histchange 不算编辑（session 的适配器已挂两信号→es 标脏）
    if (!session.name) return;
    updateSaveStatus();
  };
  window.addEventListener("wp:histchange", _editGate);
  window.addEventListener("wp:sidecarchange", _editGate);
  // saveAndPush / renameCurrentSession / coalescer+autosave 接线全切到 session-state.ts。
  // Ctrl+S = 完整保存（本地 + 云端）；Ctrl+Shift+S = 只存本地（不推云）。合流状态机在 Store（_store.session）。
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();               // busy 期也吞掉，否则漏给浏览器的「保存网页」
      if (isBusyActive()) return;       // busy 遮罩挡不住 window keydown（QA 2026-08-21）
      // commitPending：Ctrl+Shift+S 也是显式保存 → fill 预览一并收口（saveAndPush 在 session 内自收）
      // Ctrl+Shift+S=只本地（不弹不变）；Ctrl+S=smart save（与 save 按钮同一个函数，2026-08-21）
      if (e.shiftKey) session.save({ commitPending: true }); else smartSaveAndPush();
    }
  });
  // autosave configure/start + visibility/pagehide flush 已切到 session-state.ts initSession。
  // v115: Ctrl+Shift+R / 关 tab / 浏览器返回 前弹挽留 + 偷偷本地备份
  // (user：「可以弹挽留对话框，应该弹」+「挽留的时候偷偷本地备份」)
  // 1. beforeunload 是唯一能 block 浏览器的钩子；对话框内容浏览器自管
  // 2. dialog 弹出时浏览器暂停 UI 但 JS async 还在跑 → 偷偷起 saveNow，user 看 dialog 时
  //    后台 IDB transaction 大概率能跑完；user 选「留下」→ 成果保住，选「离开」→
  //    至少有 dialog 那一两秒救了
  window.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
    if (_signInNav) return;   // v0.6.22：用户主动点了「登录」→ loginRedirect 是有意导航，别拿挽留框挡它
    if (session.dirty) {   // session.dirty 已含无地本地文件模式的脏（v0.9.24）——同一道挽留门
      e.preventDefault();
      e.returnValue = "";
      // 偷存本地（不 await 让 dialog 立刻起；saveNow 内部再判脏）。implicit：无地模式下降级为 no-op——
      //   静默写用户磁盘文件违背 Windows 文件语义（Alt+F4=不保存，human 拍板 spec §7.1）；store 模式
      //   的副作用是 transient 悬着/新版本未确认时偷存也让路（本就不该在关闭瞬间背着用户 commit 变换）。
      session.save({ implicit: true }).catch(() => {});
    }
  });

  // ---- topbar：save/upload + gallery ----
  // 点 save 按钮 = smart save（同 Ctrl+S；2026-08-21 拍板，分支见 smartSaveAndPush 头注释）。
  //   已登录路径仍是 saveAndPush 一把梭，**无条件**——不脏也 encode+推。
  //   v409（user 2026-07-14）：「smart save 在不 dirty 的时候也走 save，推云。至少可以改时间戳，
  //   不然用户点了 save 看到时间戳没动会觉得坏了」。
  //   故删掉旧的「synced → 只查云快进」分支（ADR-0017 的 no-op fast path）：那条路不动时间戳，
  //   且 forceSaveAndPush 内部的 save 本就走 store 的 freshness/冲突 surface，查云的效果被它包含。
  els.topSaveBtn.addEventListener("click", () => { smartSaveAndPush(); });

  // adjust panel head 拖动
  (function bindAdjustPanelDrag() {
    let drag: { id: number; sx: number; sy: number; ol: number; ot: number } | null = null;
    els.adjustPanelHead.addEventListener("pointerdown", (e: PointerEvent) => {
      if ((e.target as HTMLElement | null)?.closest(".float-panel-close")) return;
      const r = els.adjustPanel.getBoundingClientRect();
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
      els.adjustPanelHead.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    els.adjustPanelHead.addEventListener("pointermove", (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const w = els.adjustPanel.offsetWidth, h = els.adjustPanel.offsetHeight;
      const left = Math.max(0, Math.min(window.innerWidth - w, drag.ol + (e.clientX - drag.sx)));
      const top  = Math.max(0, Math.min(window.innerHeight - h, drag.ot + (e.clientY - drag.sy)));
      els.adjustPanel.style.left = left + "px";
      els.adjustPanel.style.top = top + "px";
    });
    els.adjustPanelHead.addEventListener("pointerup", (e: PointerEvent) => {
      if (drag && e.pointerId === drag.id) {
        try { els.adjustPanelHead.releasePointerCapture(e.pointerId); } catch {}
        drag = null;
      }
    });
  })();

  // v267 (user) 图库挪回三条杠菜单（menuGallery）。topGalleryBtn 已从顶栏删除，
  //   留 getElementById?. 兜底防旧缓存 DOM（有就接上，无则 no-op）。
  // gallery-first：进图库 = 关闭当前画作（active = null）+ refresh 后停 gallery
  // 云功能关（2026-08-21 gating ①）：图库入口短路（menuGallery 本体已由 settings-menu 隐藏，
  //   这里是 UI 触发点的兜底守卫——旧缓存 DOM / 竞态点击）。
  document.getElementById("topGalleryBtn")?.addEventListener("click", () => { if (isCloudEnabled()) void session.exit(); });
  // v0.5.21：图库回三条杠菜单（独立 pill 一日游——user：visually distracting）
  els.menuGallery?.addEventListener("click", () => { if (!isCloudEnabled()) return; setMenuOpen(false); void session.exit(); });
  // v0.9.25 编辑器内新建（user 2026-08-20）：复用图库加号的三选 popup（新建/从图片/从剪切板），
  //   三个条目的 handler 全在 gallery-shell（init 时已接好，与图库开合无关）——这里只开 popup，
  //   零逻辑重复。「新建文件夹」是图库视图操作，编辑器语境隐藏（图库加号打开时恢复）。
  //   无地模式不禁用：三入口都汇到 session.newDoc 的 leaveLocalFile 门（脏 → 保存/丢弃/取消）。
  document.getElementById("menuNewArtwork")?.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    setMenuOpen(false);
    els.addNewFolder.hidden = true;
    els.galleryAddPopup.classList.remove("hidden");
    anchorPopupToBtn(els.galleryAddPopup, els.menuBtn);
  });
  // 菜单「登录 OneDrive」行（v0.6.22 menuSignIn）已删（2026-08-21 拍板）：编辑器内登录入口
  //   统一走 smart save 的「现在登录同步？」sheet（见 smartSaveAndPush）；图库云账号 popup 的
  //   登录入口保留 = 第二入口（cloud-auth-ui）。iOS 手势姿势原样搬进 onPick。

  // ---- 菜单：导入 / 导出 / 剪贴板 / 适应 ----
  els.menuRename.addEventListener("click", () => {
    setMenuOpen(false);
    session.rename();
  });
  // v0.9.24 无地本地文件（spec ai-docs/20260819-clipboard-and-local-file-spec.md §7）：
  //   FS Access 在场才显示（Chromium 桌面；标签页即全功能，不依赖 PWA）。打开 = 明文+有痕迹 ora
  //   原位编辑；加密/外来 ora 交还导入路径（wp:importOraFile 由 import-image 接，走既有解锁/新身份逻辑）。
  //   2026-08-21 入口并进「新建/打开」三选 popup（addOpenLocalFile，编辑器/图库两语境共用）——
  //   独立菜单行已删，逻辑原样只挪入口。
  const openLocalBtn = document.getElementById("addOpenLocalFile") as HTMLButtonElement | null;
  if (openLocalBtn && supportsFileSystemAccess()) {
    openLocalBtn.hidden = false;
    openLocalBtn.addEventListener("click", async () => {
      setMenuOpen(false);
      els.galleryAddPopup.classList.add("hidden");   // popup 语境：点了即收
      try {
        const h = await pickLocalOraFile();
        if (!h) return;   // 用户取消 picker
        const fallback = await session.openLocalFile(h);
        if (fallback) window.dispatchEvent(new CustomEvent("wp:importOraFile", { detail: fallback }));
      } catch (e) { reportError(new Error("[local-file] open failed: " + String(e)), "warning"); }
    });
  }
  // 另存为（v125）：2026-08-21 菜单行删除，入口挪进「导出与另存」hub 的「复制一份到图库」
  //   （export-import-menu 的 choice sheet 调 runSaveAsFlow，见文件尾）。逻辑原样，只挪入口。
  // v133 revert：从 IDB checkpoint 恢复 session 打开时的状态。
  //   2026-08-21 按钮出栏常显（index.html 拿掉 hidden，位置=加密之后；user：「居然没接」）——
  //   无快照时点击走下面 tm.noOpenSnapshot 的 status 兜底，无需再藏。
  els.menuRevertToOpen?.addEventListener("click", async () => {
    setMenuOpen(false);
    if (!session.name) { setStatus(t("tm.noActiveSession"), true); return; }
    const cp = await session.readCheckpoint(session.name);
    if (!cp || !cp.blob) {
      // 加密作品的快照按密文存；锁定/密码不对时解不出 → 说清楚是"要密码"，别含糊成"没有快照"。
      setStatus(session.enc.encrypted && !isUnlocked() ? t("tm.revertFailedNeedPassword") : t("tm.noOpenSnapshot"), true);
      return;
    }
    // cp.at 由 putCheckpoint 恒写 → 不需要兜底（旧的 `|| session.sessionOpenedAt` 是假兜底：
    //   _sessionOpenedAt 的唯一写入者 markOpenedNow 零调用者，它恒为 0）。
    const ageMin = checkpointAgeMinutes(cp.at, Date.now());
    const choice = await lockSyncGate({
      title: t("tm.revertTitle"),
      message: t("tm.revertMessage", { min: ageMin }),
      actions: [
        { label: t("tm.cancel"), value: "cancel" },
        { label: t("tm.revert"), value: "ok", primary: true },
      ],
    });
    if (choice !== "ok") return;
    editMode.applyPendingTransient();
    try {
      // cp.blob 已是**明文**：加密作品的快照按密文容器存，readCheckpoint 里用内存密码解好了
      //   （锁定/错密码 → readCheckpoint 返 null，上面那个分支已提示"无快照"）。
      const loaded = await decodeOraToPainting(cp.blob);
      // 既有身份（不是新建）→ 首存 mode:"existing"，就是要写回原文件；且**不重新封存快照**
      //   （否则刚回滚掉的状态立刻覆盖快照，只能 revert 一次）。
      session.adoptAsExisting(loaded, session.name);
      // R4：revert 是内容变化（像素回到旧快照）→ 必须走 clean→dirty 门标云脏。
      //   旧版只 edits.mark() 不标云脏 → 云端永远收不到 revert，且 clean 快进会无备份吃掉 revert 结果。
      session.markEdited();
      updateSaveStatus();
      setStatus(t("tm.revertedToOpen", { min: ageMin }));
    } catch (e) {
      setStatus(t("tm.revertFailed", { err: String(errMsg(e)) }), true);
    }
  });

  // v236 加密：当前画作加密 / 解除（label 随 session.enc.encrypted 切；编排在 session-state）
  els.menuEncrypt?.addEventListener("click", async () => {
    setMenuOpen(false);
    if (session.enc.encrypted) await session.decryptCurrent();
    else await session.encryptCurrent();
  });

  els.menuFit.addEventListener("click", () => {
    setMenuOpen(false);
    board.fitToScreen();
    updateZoomLabel();
    setStatus(t("tm.viewportReset"));
  });

  // v109: 撤「笔刷平滑设置」浮动面板 —— 平滑参数 v99 起 per-preset，进 brush settings 调。
  // menuBrushSettings 僵尸（hidden 空 button + no-op handler）已删 2026-06（HTML/els/listener 一并清）。

  els.menuForcePwaReset.addEventListener("click", async () => {
    els.menuPanel?.classList.add("hidden");
    const ok = await openConfirmSheet(
      t("tm.forceResetTitle"),
      t("tm.forceResetBody"),
    );
    if (!ok) return;
    try {
      // 1. 注销所有 SW
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister().catch(() => {});
      }
      // 2. 清 Cache Storage（不动 IDB）
      if (typeof caches !== "undefined") {
        const keys = await caches.keys();
        for (const k of keys) await caches.delete(k).catch(() => {});
      }
      setStatus(t("tm.cacheClearedReloading"), true);
      setTimeout(() => location.reload(), 200);
    } catch (e) {
      setStatus(t("tm.cacheClearFailed", { err: String(errMsg(e)) }), true);
    }
  });

  els.menuResetBrushRack.addEventListener("click", async () => {
    els.menuPanel?.classList.add("hidden");
    const ok = await openConfirmSheet(
      t("tm.resetRackTitle"),
      t("tm.resetRackBody"),
    );
    if (!ok) return;
    // 非破坏性：内置笔 setItem 覆盖同 id + .meta 提前；collection 自持久化/同步。
    // 报**还原了几支内置笔**，不是笔架总数（旧版报总数 = 把用户自建笔也算进「已重置」，是谎报）。
    const n = await rack.restoreBuiltins();
    setStatus(n ? t("tm.rackRestored", { count: n }) : t("br.rackRestoreFailed"), true);
  });
}

// v125 (user：「菜单加另存为（画库 + 名字冲突检查）」)
//   "另存为" = 当前 doc 复制到新名字 session（原 session 保留）。
//   完成后切到新 session 继续编辑（Photoshop 语义）。同名检查本地 + 云端。
// 2026-08-21：菜单行删除，唯一入口 = 「导出与另存」hub 的「复制一份到图库」
//   （export-import-menu 的 choice sheet 调本函数）。**逻辑从旧 menuSaveAs handler 原样搬入**
//   （红线：session.saveAs 调用参数/语义一个字不改）；调用点在 initTopbarMenu 之后才可能触发
//   （菜单点击），module 级 editMode/setStatus 届时已绑定。
export async function runSaveAsFlow(): Promise<void> {
  editMode.applyPendingTransient();
  // 无地本地文件模式（spec §7）：另存为 = 收编入库。session.name 恒 null（双墙设计）→ 建议名用
  //   本地文件 stem（不是「无题 副本」）；且没有「与当前名字相同」可言——文件 stem 不是 store 身份，
  //   同名入库合法（撞已有作品由下面 nameOccupied 预检 + mode:"new" 护栏兜）。
  const lf = session.localFile;
  const oldName = session.name || t("nd.untitled");
  let candidate = lf ? (lf.name.replace(/\.[^.]+$/, "") || oldName) : `${oldName} ${t("name.copySuffix")}`;
  while (true) {
    const input = await openInputSheet(t("tm.saveAs"), candidate, { placeholder: t("tm.newArtworkNamePlaceholder") });
    if (input === null) return;
    const trimmed = input.trim();
    if (!trimmed) { setStatus(t("tm.nameEmpty"), true); candidate = ""; continue; }
    if (!lf && trimmed === oldName) { setStatus(t("tm.nameSameAsCurrent"), true); candidate = trimmed; continue; }
    const occ = await sessionNameConflict(trimmed);   // 统一 store.files.nameOccupied（boolean：local + 在线 remote）
    if (occ) { setStatus(t("tm.nameExists", { name: trimmed }), true); candidate = trimmed; continue; }
    // 极端 race（预检后到落盘间被占）→ file(name,{mode:"new"}) 的护栏抛 CloudNameCollisionError，
    //   下面 catch 兜底循环重问。另存为 = 写新身份、旧的不动（本地存 + 云端 best-effort 推）。
    try {
      await session.saveAs(trimmed);   // 当前内容写新身份 + 切新名（session 编排；tryPush best-effort）
      setStatus(t("tm.savedAsWithCloud", { name: trimmed }));
      return;
    } catch (e) {
      if ((e as { name?: string })?.name === "CloudNameCollisionError") { setStatus(t("tm.cloudNameExists", { name: trimmed }), true); candidate = trimmed; continue; }
      setStatus(t("tm.saveAsFailed", { err: String(errMsg(e)) }));
      return;
    }
  }
}
