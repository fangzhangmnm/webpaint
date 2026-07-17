// 职责（单一）：顶栏按钮 + 汉堡菜单项 + 通用 sheet 开关 + 保存触发 的事件接线。
//
// 从 app.js god-file 切出来的「点哪个顶栏/菜单按钮 → 调哪条编排」那一轴。纯接线层：
// 把 DOM 监听绑到 els.*，回调里调 session.* / _store.* / ctx 协作件。**不**持任何 SSoT 状态。
//
// **红线（CRITICAL）**：本模块只 RELOCATE 接线，**绝不**改任何 store.* / _store.flow.* /
//   _store.session.* / _store.autosave.* / _store.edit* / session.* 调用（参数/顺序/语义全保原样）。
//   menuSaveAs 用 _store.flow.saveAs + session.setName/encodeOra/markSavedNow；
//   menuRevert 用 session.readCheckpoint/adoptWithOpts + _store.edits；
//   save 触发用 _store.edit/session.request/autosave.flush。要改 store 行为 → STOP，escalate。
//
// 留在 app.js（核心 HUD glue，**不**搬）：setStatus / updateZoomLabel / board.render HUD hook。
//
// ctx 绑入（initTopbarMenu(ctx)，gallery 晚绑后才调）：
//   input / doc / board / history / editMode / setStatus / updateSaveStatus / updateZoomLabel /
//   gallery / rack。
// 直接 import（leaf/singleton）：session、_store(store)、els、
//   openInputSheet/openConfirmSheet/lockSyncGate、setMenuOpen、listSessions、
//   listCloudSessionsRecursive、decodeOraToDoc、compressPixelSnap、maybeFastForwardActive。

import { session } from "./session-state.ts";
import {
  store as _store,
} from "./app-store.ts";
import { els } from "./els.ts";
import { openInputSheet, openConfirmSheet, lockSyncGate } from "./sheets.ts";
import { setMenuOpen } from "./settings-menu.ts";
import { sessionNameConflict } from "./session-name.ts";
import { decodeOraToDoc } from "./ora.ts";
import { compressPixelSnap } from "./pixel-edit.ts";
import { t } from "./i18n/index.ts";
import type { Layer, PaintDoc } from "./doc.ts";

import type { AppContext } from "./app-context.ts";
const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e);

// ---- ctx-bound 协作件（app 拥有，boot 时 initTopbarMenu(ctx) 注入）----
let input: AppContext["input"], doc: AppContext["doc"], board: AppContext["board"], history: AppContext["history"], editMode: AppContext["editMode"];
let setStatus: AppContext["setStatus"], updateSaveStatus: AppContext["updateSaveStatus"], updateZoomLabel: AppContext["updateZoomLabel"];
let gallery: AppContext["gallery"], rack: AppContext["rack"];

// 通用 sheet 开关（清空图层 sheet 等）——纯 class toggle，无状态。
function openSheet(sheet: HTMLElement, backdrop: HTMLElement) {
  backdrop.classList.remove("hidden");
  sheet.classList.remove("hidden");
}
function closeSheet(sheet: HTMLElement, backdrop: HTMLElement) {
  backdrop.classList.add("hidden");
  sheet.classList.add("hidden");
}

export function initTopbarMenu(ctx: AppContext) {
  input = ctx.input;
  doc = ctx.doc;
  board = ctx.board;
  history = ctx.history;
  editMode = ctx.editMode;
  setStatus = ctx.setStatus;
  updateSaveStatus = ctx.updateSaveStatus;
  updateZoomLabel = ctx.updateZoomLabel;
  gallery = ctx.gallery;
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
    const layer = doc.activeLayer as Layer | null;
    if (!layer) return;
    // 走 stroke handler 让 Ctrl+Z 能复活。before = 当前像素；after = 空层快照。
    const before = layer.snapshot();
    doc.clearActiveLayer();
    const after = layer.snapshot();
    const entry: { type: string; layerId: number; before: unknown; after: unknown; beforeBlob: Blob | null; afterBlob: Blob | null } = { type: "stroke", layerId: layer.id, before, after, beforeBlob: null, afterBlob: null };
    history.push(entry);
    compressPixelSnap(entry.before as Parameters<typeof compressPixelSnap>[0], (blob: Blob | null) => { entry.beforeBlob = blob; });
    compressPixelSnap(entry.after  as Parameters<typeof compressPixelSnap>[0], (blob: Blob | null) => { entry.afterBlob  = blob; });
    board.invalidateAll();
    setStatus(t("tm.clearedActiveLayer"));
  });

  // ---- 保存触发：wp:histchange dirty 门 / Ctrl+S / beforeunload / topSaveBtn ----
  // 笔触结束 / undo / redo / 图层操作（任何 wp:histchange）→ dirty。这是 work-file 的**唯一编辑门**。
  // store.edit(name) 一处吸：推编辑游标(local-dirty) + 经门标云脏(捕 parentBase；不 gate signedIn)。
  // name 空（gallery-first 未绑 session）→ 只推游标。门机制全在库内（app 不再直调 setCloudDirty，ADR-0016 §4）。
  window.addEventListener("wp:histchange", () => {
    if (session.loadingDoc) return;             // 加载期 clearHistory 的 histchange 不算编辑（session 的 ora 适配器已挂 histchange→es 标脏）
    if (!session.name) return;
    updateSaveStatus();
  });
  // saveAndPush / renameCurrentSession / coalescer+autosave 接线全切到 session-state.ts。
  // Ctrl+S = 完整保存（本地 + 云端）；Ctrl+Shift+S = 只存本地（不推云）。合流状态机在 Store（_store.session）。
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      if (e.shiftKey) session.save(); else session.saveAndPush();   // Ctrl+Shift+S=只本地；Ctrl+S=存+推
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
    if (session.dirty) {
      e.preventDefault();
      e.returnValue = "";
      session.save().catch(() => {});   // 偷存本地（不 await 让 dialog 立刻起；saveNow 内部再判脏）
    }
  });

  // ---- topbar：save/upload + gallery ----
  // 点 save 按钮 = saveAndPush 一把梭（同 Ctrl+S），**无条件**——不脏也 encode+推。
  //   v409（user 2026-07-14）：「smart save 在不 dirty 的时候也走 save，推云。至少可以改时间戳，
  //   不然用户点了 save 看到时间戳没动会觉得坏了」。
  //   故删掉旧的「synced → 只查云快进」分支（ADR-0017 的 no-op fast path）：那条路不动时间戳，
  //   且 forceSaveAndPush 内部的 save 本就走 store 的 freshness/冲突 surface，查云的效果被它包含。
  els.topSaveBtn.addEventListener("click", () => { session.saveAndPush(); });

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
  document.getElementById("topGalleryBtn")?.addEventListener("click", () => session.exit());
  els.menuGallery?.addEventListener("click", () => { setMenuOpen(false); session.exit(); });

  // ---- 菜单：导入 / 导出 / 剪贴板 / 适应 ----
  els.menuRename.addEventListener("click", () => {
    setMenuOpen(false);
    session.rename();
  });
  // v125 (user：「菜单加另存为（画库 + 名字冲突检查）」)
  //   "另存为" = 当前 doc 复制到新名字 session（原 session 保留）。
  //   完成后切到新 session 继续编辑（Photoshop 语义）。同名检查本地 + 云端。
  els.menuSaveAs.addEventListener("click", async () => {
    setMenuOpen(false);
    editMode.applyPendingTransient();
    const oldName = session.name || "未命名";
    let candidate = `${oldName} 副本`;
    while (true) {
      const input = await openInputSheet(t("tm.saveAs"), candidate, { placeholder: t("tm.newArtworkNamePlaceholder") });
      if (input === null) return;
      const trimmed = input.trim();
      if (!trimmed) { setStatus(t("tm.nameEmpty"), true); candidate = ""; continue; }
      if (trimmed === oldName) { setStatus(t("tm.nameSameAsCurrent"), true); candidate = trimmed; continue; }
      const occ = await sessionNameConflict(trimmed);   // 统一 store.nameOccupied：local + 在线 remote
      if (occ) { setStatus(t(occ === "local" ? "tm.localNameExists" : "tm.cloudNameExists", { name: trimmed }), true); candidate = trimmed; continue; }
      // 极端 race（预检后到落盘间被占）→ store saveAs 护栏抛，下面 catch 兜底循环重问。
      // 另存为 = 写新身份、旧的不动（store.flow.saveAs：本地存 + 云端 push，云端 best-effort）。
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
  });
  // v133 revert：从 IDB checkpoint 恢复 session 打开时的状态
  els.menuRevertToOpen?.addEventListener("click", async () => {
    setMenuOpen(false);
    if (!session.name) { setStatus(t("tm.noActiveSession"), true); return; }
    const cp = await session.readCheckpoint(session.name);
    if (!cp || !cp.blob) {
      setStatus(t("tm.noOpenSnapshot"), true);
      return;
    }
    const ageMin = Math.max(1, Math.round((Date.now() - (cp.at || session.sessionOpenedAt)) / 60000));
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
      // checkpoint 字节按文件加密态包过壳 → 先 unseal（明文原样过；密码在内存则无感）
      const plain = cp.blob;   // ⚠TODO checkpoint 重构后过透明解壳；当前 readCheckpoint stub 返 null，此路不可达
      if (!plain) { setStatus(t("tm.revertFailedNeedPassword"), true); return; }
      const loaded = await decodeOraToDoc(plain);
      session.adoptWithOpts(loaded as PaintDoc, session.name, { skipCheckpoint: true });
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
    await rack.resetBuiltin();   // 非破坏性：出厂笔 setItem 覆盖同 id + .meta 提前；collection 自持久化/同步
    setStatus(t("tm.rackReset", { count: rack.get()?.brushes.length ?? 0 }), true);
  });
}
