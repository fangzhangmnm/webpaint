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
// 直接 import（leaf/singleton）：session、_store(store)/isSignedIn/isCloudDirty/setRackDirty、els、
//   openInputSheet/openConfirmSheet/lockSyncGate、setMenuOpen、listSessions、
//   listCloudSessionsRecursive、decodeOraToDoc、compressPixelSnap、maybeFastForwardActive。

import { session } from "./session-state.ts";
import {
  store as _store,
  isSignedIn,
  isCloudDirty,
  setRackDirty,
  listCloudSessionsRecursive,
} from "./app-store.js";
import { els } from "./els.ts";
import { openInputSheet, openConfirmSheet, lockSyncGate } from "./sheets.ts";
import { setMenuOpen } from "./settings-menu.ts";
import { listSessions } from "./session.js";
import { decodeOraToDoc } from "./ora.js";
import { stripSessionExt } from "./config.js";
import { compressPixelSnap } from "./pixel-edit.js";
import { maybeFastForwardActive } from "./cloud-freshness.ts";

// ---- ctx-bound 协作件（app 拥有，boot 时 initTopbarMenu(ctx) 注入）----
let input: any, doc: any, board: any, history: any, editMode: any;
let setStatus: any, updateSaveStatus: any, updateZoomLabel: any;
let gallery: any, rack: any;

// 通用 sheet 开关（清空图层 sheet 等）——纯 class toggle，无状态。
function openSheet(sheet, backdrop) {
  backdrop.classList.remove("hidden");
  sheet.classList.remove("hidden");
}
function closeSheet(sheet, backdrop) {
  backdrop.classList.add("hidden");
  sheet.classList.add("hidden");
}

export function initTopbarMenu(ctx) {
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
  window.addEventListener("wp:histchange", (e) => {
    els.undoBtn.disabled = !e.detail.canUndo;
    els.redoBtn.disabled = !e.detail.canRedo;
  });
  els.undoBtn.disabled = true;
  els.redoBtn.disabled = true;

  els.clearBackdrop.addEventListener("click", () => closeSheet(els.clearSheet, els.clearBackdrop));
  els.clearSheet.addEventListener("click", (e) => {
    const a = e.target.closest("[data-clear]")?.dataset.clear;
    if (!a) return;
    closeSheet(els.clearSheet, els.clearBackdrop);
    if (a !== "confirm") return;
    const layer = doc.activeLayer;
    if (!layer) return;
    // 走 stroke handler 让 Ctrl+Z 能复活。before = 当前像素；after = 空层快照。
    const before = layer.snapshot();
    doc.clearActiveLayer();
    const after = layer.snapshot();
    const entry = { type: "stroke", layerId: layer.id, before, after, beforeBlob: null, afterBlob: null };
    history.push(entry);
    compressPixelSnap(entry.before, (blob) => { entry.beforeBlob = blob; });
    compressPixelSnap(entry.after,  (blob) => { entry.afterBlob  = blob; });
    board.invalidateAll();
    setStatus("已清空当前图层（Ctrl+Z 撤销）");
  });

  // ---- 保存触发：wp:histchange dirty 门 / Ctrl+S / beforeunload / topSaveBtn ----
  // 笔触结束 / undo / redo / 图层操作（任何 wp:histchange）→ dirty。这是 work-file 的**唯一编辑门**。
  // store.edit(name) 一处吸：推编辑游标(local-dirty) + 经门标云脏(捕 parentBase；不 gate signedIn)。
  // name 空（gallery-first 未绑 session）→ 只推游标。门机制全在库内（app 不再直调 setCloudDirty，ADR-0016 §4）。
  window.addEventListener("wp:histchange", () => {
    if (session.loadingDoc) return;             // 加载/采纳/FF 期间 clearHistory 派发的 histchange 不算编辑（不标脏）
    _store.edit(session.name || null);
    if (!session.name) return;                  // gallery-first: 无绑 session 时不刷 save 按钮
    updateSaveStatus();
  });
  // saveAndPush / renameCurrentSession / coalescer+autosave 接线全切到 session-state.ts。
  // Ctrl+S = 完整保存（本地 + 云端）；Ctrl+Shift+S = 只存本地（不推云）。合流状态机在 Store（_store.session）。
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      _store.session.request(e.shiftKey ? "local" : "push");
    }
  });
  // autosave configure/start + visibility/pagehide flush 已切到 session-state.ts initSession。
  // v115: Ctrl+Shift+R / 关 tab / 浏览器返回 前弹挽留 + 偷偷本地备份
  // (user：「可以弹挽留对话框，应该弹」+「挽留的时候偷偷本地备份」)
  // 1. beforeunload 是唯一能 block 浏览器的钩子；对话框内容浏览器自管
  // 2. dialog 弹出时浏览器暂停 UI 但 JS async 还在跑 → 偷偷起 saveNow，user 看 dialog 时
  //    后台 IDB transaction 大概率能跑完；user 选「留下」→ 成果保住，选「离开」→
  //    至少有 dialog 那一两秒救了
  window.addEventListener("beforeunload", (e) => {
    if (_store.edits.localDirty() && !_store.busy.saving()) {
      e.preventDefault();
      e.returnValue = "";
      // 偷存（implicit 只写 IDB 不推云）；不 await 让 dialog 立刻起。flush 内部再判一次 dirty/busy（无害）
      _store.autosave.flush().catch(() => {});
    }
  });

  // ---- topbar：save/upload + gallery ----
  // 点 save 按钮 = saveAndPush 一把梭（同 Ctrl+S）。state == "synced" 时
  // 也跑一遍（no-op fast path）让 user 永远不需要"再点一下"。
  els.topSaveBtn.addEventListener("click", () => {
    const name = session.name;
    // synced（无可存可推）→ 按钮兼作「刷新云端态」（ADR-0017，点一下 = 现场查云 + 干净则快进）；否则正常存/推。
    if (name && name !== "未命名" && isSignedIn() && !_store.edits.localDirty() && !isCloudDirty(name)) {
      maybeFastForwardActive({ manual: true });
    } else {
      _store.session.request("push");
    }
  });

  // adjust panel head 拖动
  (function bindAdjustPanelDrag() {
    let drag = null;
    els.adjustPanelHead.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".float-panel-close")) return;
      const r = els.adjustPanel.getBoundingClientRect();
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
      els.adjustPanelHead.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    els.adjustPanelHead.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const w = els.adjustPanel.offsetWidth, h = els.adjustPanel.offsetHeight;
      const left = Math.max(0, Math.min(window.innerWidth - w, drag.ol + (e.clientX - drag.sx)));
      const top  = Math.max(0, Math.min(window.innerHeight - h, drag.ot + (e.clientY - drag.sy)));
      els.adjustPanel.style.left = left + "px";
      els.adjustPanel.style.top = top + "px";
    });
    els.adjustPanelHead.addEventListener("pointerup", (e) => {
      if (drag && e.pointerId === drag.id) {
        try { els.adjustPanelHead.releasePointerCapture(e.pointerId); } catch {}
        drag = null;
      }
    });
  })();

  // v124 (user) 图库挪回顶栏：topGalleryBtn 直接开图库；menuGallery 留 stub 兜底
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
      const input = await openInputSheet("另存为", candidate, { placeholder: "新作品名字" });
      if (input === null) return;
      const trimmed = input.trim();
      if (!trimmed) { setStatus("名字不能空", true); candidate = ""; continue; }
      if (trimmed === oldName) { setStatus("名字和当前一样，换一个", true); candidate = trimmed; continue; }
      const localNames = (await listSessions()).map((s) => s.name);
      if (localNames.includes(trimmed)) {
        setStatus(`本地已有同名 "${trimmed}"，换一个`, true);
        candidate = trimmed; continue;
      }
      if (isSignedIn() && navigator.onLine !== false) {
        try {
          const cloud = await listCloudSessionsRecursive();
          const cloudNames = cloud.map((c) => stripSessionExt(c.path));
          if (cloudNames.includes(trimmed)) {
            setStatus(`云端已有同名 "${trimmed}"，换一个`, true);
            candidate = trimmed; continue;
          }
        } catch (e) { console.warn("[saveAs] cloud list failed:", e); }
      }
      // 另存为 = 写新身份、旧的不动（store.flow.saveAs：本地存 + 云端 push，云端 best-effort）。
      try {
        const cloudOn = isSignedIn() && navigator.onLine !== false;
        const res = await _store.flow.saveAs(trimmed, {
          encode: () => session.encodeOra(),
          cloud: cloudOn,
        });
        session.setName(trimmed);
        _store.edits.markSaved();
        session.markSavedNow();
        updateSaveStatus();
        if (!cloudOn) setStatus(`已另存为：${trimmed}`);
        else if (res.cloudDeferred) setStatus(`已另存为（仅本地）：${trimmed}（云端稍后 Ctrl+S 推）`);
        else setStatus(`已另存为（含云端）：${trimmed}`);
        gallery.refresh();
        return;
      } catch (e) {
        setStatus("另存为失败：" + (e && e.message || e));
        return;
      }
    }
  });
  // v133 revert：从 IDB checkpoint 恢复 session 打开时的状态
  els.menuRevertToOpen?.addEventListener("click", async () => {
    setMenuOpen(false);
    if (!session.name) { setStatus("没活动 session", true); return; }
    const cp = await session.readCheckpoint(session.name);
    if (!cp || !cp.blob) {
      setStatus("没找到本次打开时的快照", true);
      return;
    }
    const ageMin = Math.max(1, Math.round((Date.now() - (cp.at || session.sessionOpenedAt)) / 60000));
    const choice = await lockSyncGate({
      title: "撤销修改",
      message: `回到约 ${ageMin} 分钟前的快照（本次打开或上次保存时的版本）。\n之后所有修改将丢失。`,
      actions: [
        { label: "取消", value: "cancel" },
        { label: "撤销", value: "ok", primary: true },
      ],
    });
    if (choice !== "ok") return;
    editMode.applyPendingTransient();
    try {
      // checkpoint 字节按文件加密态包过壳 → 先 unseal（明文原样过；密码在内存则无感）
      const plain = await _store.unseal(session.name, cp.blob);
      if (!plain) { setStatus("恢复失败：需要密码解锁", true); return; }
      const loaded = await decodeOraToDoc(plain);
      session.adoptWithOpts(loaded, session.name, { skipCheckpoint: true });
      // R4：revert 是内容变化（像素回到旧快照）→ 必须走 clean→dirty 门标云脏。
      //   旧版只 edits.mark() 不标云脏 → 云端永远收不到 revert，且 clean 快进会无备份吃掉 revert 结果。
      _store.edit(session.name);
      updateSaveStatus();
      setStatus(`已恢复到本次打开时（${ageMin} 分钟前）`);
    } catch (e) {
      setStatus("恢复失败：" + (e && e.message || e), true);
    }
  });

  els.menuFit.addEventListener("click", () => {
    setMenuOpen(false);
    board.fitToScreen();
    updateZoomLabel();
    setStatus("适应屏幕");
  });

  // v109: 撤「笔刷平滑设置」浮动面板 —— 平滑参数 v99 起 per-preset，进 brush settings 调
  // 删了：toggleBrushPanel / syncBrushPanelFromState / bindBrushSlider / brushPanelHead 拖动 handler
  // menuBrushSettings element hidden 保兼容（HTML 不报 null），handler no-op
  if (els.menuBrushSettings) els.menuBrushSettings.addEventListener("click", () => setMenuOpen(false));

  els.menuForcePwaReset.addEventListener("click", async () => {
    els.menuPanel?.classList.add("hidden");
    const ok = await openConfirmSheet(
      "强制清缓存重启？",
      "会清掉 SW + Cache Storage，强制重新拉所有 JS / CSS。" +
      "你的画 / 笔架（IDB / OneDrive）不会动。\n" +
      "用途：PWA 卡老版本，点更新还是老的时候用。",
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
      setStatus("已清缓存，正在硬重载…", true);
      setTimeout(() => location.reload(), 200);
    } catch (e) {
      setStatus("清缓存失败：" + (e.message || e), true);
    }
  });

  els.menuResetBrushRack.addEventListener("click", async () => {
    els.menuPanel?.classList.add("hidden");
    const ok = await openConfirmSheet(
      "重置笔架？",
      "会删除全部自定义笔刷 + 改过的默认笔，恢复出厂 8 个 brush。不可撤销。",
    );
    if (!ok) return;
    rack.reset(true);   // 恢复出厂 resetAt watermark + 重置 toolStates + persist + applyToolState + bump
    setRackDirty(true);
    if (isSignedIn()) rack.syncCloud();
    setStatus(`笔架已重置（${rack.get().brushes.length} 个 brush）`, true);
  });
}
