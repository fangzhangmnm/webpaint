// 职责（单一）：图库全屏外壳 —— 开/关图库 + chrome（视图按钮可见性）+ 新建作品 sheet +
//   IDB 占用/配额 + 加号·云·菜单 popup 按钮接线 + 名字唯一化。
//
// 从 app.js god-file 切出「图库这层壳怎么开关、壳上那几个 popup 按钮怎么接、新建作品走哪条
//   sheet」那一轴。<Gallery> 深模块本身（src/ui/gallery.ts）仍由 app.js mountGallery 组装并经
//   ctx.gallery 注入本壳；本壳只管「围着它的全屏外壳 + chrome + 入口按钮」。
//
// **红线（CRITICAL）**：setGalleryOpen / 新建确认 等编排里对 session.* / _store.* 的调用全部
//   RELOCATE 原样（参数/顺序/语义保持），绝不改。要改 store/session 行为 → STOP，escalate。
//
// 对外导出（被 ctx 注入 app.js，session-state / import-image 经 ctx 消费）：
//   setGalleryOpen / checkQuotaAndWarn / uniqueLocalName / updateIdbUsage / openNewDocSheet。
//
// 依赖：editMode / board / gallery / store(_store) / setStatus 经 initGalleryShell(ctx) 绑入；
//   doc 同样经 ctx（openNewDocSheet 读 doc.width/height）。session / els / listSessions /
//   listCloudSessionsRecursive / isSignedIn / anchorPopupToBtn / setAddImportAsNewDoc /
//   importImageAsNewDoc / readImageFromClipboard 直接 import（leaf/singleton）。

import { session } from "./session-state.ts";
import { els } from "./els.ts";
import { listSessions, readImageFromClipboard } from "./session.js";
import { listCloudSessionsRecursive, listCloudAll, ensureSubfolder, isSignedIn } from "./app-store.js";
import { anchorPopupToBtn } from "./anchored-popup.ts";
import { openInputSheet } from "./sheets.ts";
import { pathJoin } from "./gallery-path.js";
import { setAddImportAsNewDoc, importImageAsNewDoc } from "./import-image.ts";

// ---- ctx-bound 协作件（app 拥有，boot 时 initGalleryShell(ctx) 注入）----
let editMode: any, board: any, gallery: any, doc: any, _store: any, setStatus: any, withBusy: any;

// trash-bar / add / trash 按钮的可见性随视图（旧 renderGallery 内联，现 app chrome 显式管）。
function _galleryChrome(view) {
  els.galleryTrashBar?.classList.toggle("hidden", view !== "trash");
  els.galleryAddBtn?.classList.toggle("hidden", view === "trash");
  els.galleryTrashBtn?.classList.toggle("hidden", view === "trash");
}

export async function setGalleryOpen(open) {
  if (open) {
    // 进图库 = 用户离开编辑场景 → apply 所有 pending transient（套索浮层等）+ 保存
    editMode.applyPendingTransient();
    if (_store.edits.localDirty() && !_store.busy.saving()) await session.save();
    await session.awaitCloudPushIdle();   // 等 cloud push 完，防 status race
    document.body.dataset.mode = "gallery";
    els.galleryFull.classList.remove("hidden");
    _galleryChrome("files");      // 每次进默认 files 视图（避免上次留在 trash 里的混乱）
    gallery.setView("files");     // setView 内含 reload
    updateIdbUsage();
  } else {
    editMode.applyPendingTransient();
    if (_store.edits.localDirty() && !_store.busy.saving()) await session.save();
    els.galleryFull.classList.add("hidden");
    delete document.body.dataset.mode;
    // 关闭可能打开的 popup
    els.galleryAddPopup.classList.add("hidden");
    els.cloudAccountPopup.classList.add("hidden");
    els.galleryMenuPopup?.classList.add("hidden");
    board.requestRender();
  }
}

// 新建作品 sheet
// v217: 文件名改成 yyyymmdd-xxxx（4 位随机 hex），同步生成无延迟。
// 冲突概率 1/65536，可接受；不再需要 async 枚举已有文件。
function _newDocName() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${stamp}-${rand}`;
}
export function openNewDocSheet() {
  const base = _newDocName();
  const folder = gallery.getFolder();
  els.newDocName.value = folder ? `${folder}/${base}` : base;
  _selectPreset("2048x2048");
  els.newDocCustomRow.style.display = "none";
  els.newDocW.value = doc.width;
  els.newDocH.value = doc.height;
  els.newDocBackdrop.classList.remove("hidden");
  els.newDocSheet.classList.remove("hidden");
  setTimeout(() => { els.newDocName.focus(); els.newDocName.select(); }, 50);
}
function closeNewDocSheet() {
  els.newDocBackdrop.classList.add("hidden");
  els.newDocSheet.classList.add("hidden");
}
function _selectPreset(val: string) {
  const btns = (els.newDocSheet as any).querySelectorAll("[data-preset]");
  btns.forEach((b: any) => b.setAttribute("aria-pressed", b.dataset.preset === val ? "true" : "false"));
  els.newDocCustomRow.style.display = val === "custom" ? "" : "none";
}

// 本地占用 = 实际所有 IDB session blob 大小之和（**不**走 storage.estimate —— 它把 SW
// 预缓存 / localStorage 算进去虚高几 MB）。
// quota 来自 storage.estimate，是**浏览器愿意分配的上限**（iOS Safari 通常 ~ 60-80% 可用
// 磁盘；动辄几十 GB），不是 "我们申请了多少"。所以放 title 里给好奇用户看，不主显。
export async function updateIdbUsage() {
  try {
    const sessions = await listSessions();
    let total = 0;
    for (const s of sessions) total += (s.size || 0);
    let label = `本地占用：${humanSize(total)}（${sessions.length} 件）`;
    let level = "ok";   // ok | warn | critical
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est && est.quota) {
        const ratio = (est.usage || 0) / est.quota;
        const pct = Math.round(ratio * 100);
        els.galleryFootUsage.title =
          `浏览器分配上限约 ${humanSize(est.quota)}；当前 ${pct}% 已用（含 SW 缓存等）`;
        if (ratio > 0.95) { level = "critical"; label += ` · 已用 ${pct}%`; }
        else if (ratio > 0.8) { level = "warn"; label += ` · 已用 ${pct}%`; }
      }
    }
    els.galleryFootUsage.textContent = label;
    els.galleryFootUsage.classList.toggle("usage-warn", level === "warn");
    els.galleryFootUsage.classList.toggle("usage-critical", level === "critical");
  } catch {
    els.galleryFootUsage.textContent = "占用：未知";
  }
}

// 每次保存后检查一次配额；> 80% 弹状态条提示用户去图库整理。
// 同一阈值短时间内不重复弹（避免每笔 stroke 后骚扰）。
let _lastQuotaWarnLevel = "ok";
export async function checkQuotaAndWarn() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return;
    const est = await navigator.storage.estimate();
    if (!est || !est.quota) return;
    const ratio = (est.usage || 0) / est.quota;
    const pct = Math.round(ratio * 100);
    let level = "ok";
    if (ratio > 0.95) level = "critical";
    else if (ratio > 0.8) level = "warn";
    if (level === _lastQuotaWarnLevel) return;
    _lastQuotaWarnLevel = level;
    if (level === "critical") {
      setStatus(`本地存储 ${pct}% 已满 — 立即去图库卸载不常用的作品`, true);
    } else if (level === "warn") {
      setStatus(`本地存储 ${pct}% 已用 — 建议在图库整理`, true);
    }
  } catch {}
}

function humanTime(ts) {
  if (!ts) return "未知";
  const d = new Date(ts);
  const now = Date.now();
  const dt = now - ts;
  if (dt < 60 * 1000) return "刚刚";
  if (dt < 60 * 60 * 1000) return `${Math.floor(dt / 60000)} 分钟前`;
  if (dt < 24 * 60 * 60 * 1000) return `${Math.floor(dt / 3600000)} 小时前`;
  if (dt < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(dt / 86400000)} 天前`;
  return d.toLocaleDateString();
}
function humanSize(b) {
  if (b == null) return "?";
  if (b === 0) return "0 B";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

// 给本地拿一个不冲突的名字（X / X 1 / X 2 / ...）
export async function uniqueLocalName(stem) {
  const existing = new Set((await listSessions()).map((s) => s.name));
  if (!existing.has(stem)) return stem;
  for (let i = 1; i < 100; i++) {
    const candidate = `${stem} ${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${stem} ${Date.now()}`;
}

export function initGalleryShell(ctx) {
  editMode = ctx.editMode;
  board = ctx.board;
  gallery = ctx.gallery;
  doc = ctx.doc;
  _store = ctx.store;
  setStatus = ctx.setStatus;
  withBusy = ctx.withBusy;

  // 加号 popup
  els.galleryAddBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const hidden = els.galleryAddPopup.classList.contains("hidden");
    els.cloudAccountPopup.classList.add("hidden");
    els.galleryAddPopup.classList.toggle("hidden", !hidden);
    if (hidden) anchorPopupToBtn(els.galleryAddPopup, els.galleryAddBtn);
    els.galleryAddBtn.setAttribute("aria-expanded", hidden ? "true" : "false");
  });
  // 云 icon popup
  els.cloudIconBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const hidden = els.cloudAccountPopup.classList.contains("hidden");
    els.galleryAddPopup.classList.add("hidden");
    els.cloudAccountPopup.classList.toggle("hidden", !hidden);
    if (hidden) anchorPopupToBtn(els.cloudAccountPopup, els.cloudIconBtn);
    els.cloudIconBtn.setAttribute("aria-expanded", hidden ? "true" : "false");
  });
  // 图库菜单 popup（版本号 + 强制更新 + 文件无关设置）
  els.galleryMenuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const hidden = els.galleryMenuPopup.classList.contains("hidden");
    els.galleryAddPopup.classList.add("hidden");
    els.cloudAccountPopup.classList.add("hidden");
    els.galleryMenuPopup.classList.toggle("hidden", !hidden);
    if (hidden) anchorPopupToBtn(els.galleryMenuPopup, els.galleryMenuBtn);
    els.galleryMenuBtn.setAttribute("aria-expanded", hidden ? "true" : "false");
  });

  // 加号 → 新建：弹 sheet 选名字 + 分辨率
  els.addNew.addEventListener("click", () => {
    els.galleryAddPopup.classList.add("hidden");
    openNewDocSheet();
  });
  els.addImportPhoto.addEventListener("click", () => {
    els.galleryAddPopup.classList.add("hidden");
    // 复用 oraFileInput 但限定 accept = image only。实际上 oraFileInput accept 包含 image
    els.oraFileInput.value = "";
    els.oraFileInput.click();
    // 上面的 onchange 会路由到 importImageAsLayer / decodeOraToDoc
    // 但用户语义是"新建作品打底"，所以新建一个 doc 把 image 当 base layer 放进去
    // 标记一个 pending flag（flag 归 import-image 模块）
    setAddImportAsNewDoc(true);
  });
  els.addImportClipboard.addEventListener("click", async () => {
    els.galleryAddPopup.classList.add("hidden");
    try {
      const blob = await readImageFromClipboard();
      if (!blob) { setStatus("剪贴板里没有图片"); return; }
      const file = new File([blob], "clipboard.png", { type: blob.type || "image/png" });
      await importImageAsNewDoc(file);
      setGalleryOpen(false);
    } catch (e) {
      setStatus("从剪切板新建失败：" + (e && e.message || e));
    }
  });

  // 新建作品 sheet 接线
  // v217：preset 改成按钮组（_selectPreset + 委托事件）
  els.newDocSheet.addEventListener("click", (e: any) => {
    const btn = e.target.closest("[data-preset]");
    if (!btn) return;
    _selectPreset(btn.dataset.preset);
  });
  els.newDocBackdrop.addEventListener("click", closeNewDocSheet);
  els.newDocCancel.addEventListener("click", closeNewDocSheet);
  els.newDocConfirm.addEventListener("click", async () => {
    const nameRaw = (els.newDocName.value || "").trim() || "未命名";
    let w, h;
    const sel = (els.newDocSheet as any).querySelector("[data-preset][aria-pressed='true']");
    const presetVal = sel ? sel.dataset.preset : "2048x2048";
    if (presetVal === "custom") {
      w = Math.max(16, Math.min(8192, parseInt(els.newDocW.value, 10) || 2048));
      h = Math.max(16, Math.min(8192, parseInt(els.newDocH.value, 10) || 2048));
    } else {
      const parts = presetVal.split("x");
      w = Math.max(16, Math.min(8192, parseInt(parts[0], 10) || 2048));
      h = Math.max(16, Math.min(8192, parseInt(parts[1], 10) || w));
    }
    const name = await uniqueLocalName(nameRaw);
    closeNewDocSheet();
    // doc 替换 + 落盘 + 切指针 + checkpoint + 关库全在 session.newDoc（session-state.ts）。
    await session.newDoc({ name, w, h });
    setStatus(`新建：${name}（${w}×${h}）`);
  });

  // 图库菜单 popup 内动作代理到主菜单已有 handler（.click() 即触发，不重复逻辑/状态）。
  els.galleryMenuForceUpdate?.addEventListener("click", () => {
    els.galleryMenuPopup.classList.add("hidden");
    els.menuForcePwaReset?.click();
  });
  els.galleryMenuTheme?.addEventListener("click", () => {
    els.galleryMenuPopup.classList.add("hidden");
    els.menuTheme?.click();
  });
  // 三个 popup 的 outside-click 关闭
  document.addEventListener("pointerdown", (e: any) => {
    if (!els.galleryAddPopup.classList.contains("hidden") &&
        !els.galleryAddPopup.contains(e.target) &&
        !els.galleryAddBtn.contains(e.target)) {
      els.galleryAddPopup.classList.add("hidden");
    }
    if (!els.cloudAccountPopup.classList.contains("hidden") &&
        !els.cloudAccountPopup.contains(e.target) &&
        !els.cloudIconBtn.contains(e.target)) {
      els.cloudAccountPopup.classList.add("hidden");
    }
    if (els.galleryMenuPopup && !els.galleryMenuPopup.classList.contains("hidden") &&
        !els.galleryMenuPopup.contains(e.target) &&
        !els.galleryMenuBtn.contains(e.target)) {
      els.galleryMenuPopup.classList.add("hidden");
    }
  });

  // + 新建文件夹（云端真文件夹为准：在 OneDrive 上建真文件夹，需登录+在线）
  els.addNewFolder?.addEventListener("click", async () => {
    els.galleryAddPopup.classList.add("hidden");
    // 文件夹模型「云端真文件夹为准」→ 必须登录+在线才能建（否则无处持久化空文件夹）
    if (!isSignedIn() || navigator.onLine === false) {
      setStatus("新建文件夹需先登录云端（空文件夹存在 OneDrive 上）", true);
      return;
    }
    const stem = await openInputSheet("新建文件夹", "新文件夹", { placeholder: "文件夹名" });
    if (stem == null) return;
    const trimmed = stem.trim();
    if (!trimmed) { setStatus("文件夹名不能空", true); return; }
    if (trimmed.includes("/")) { setStatus("文件夹名不能含 /（要建嵌套请进对应文件夹再点新建）", true); return; }
    const fullPath = pathJoin(gallery.getFolder(), trimmed);
    // 已存在 check（本地+云的 item 派生 + 云端真文件夹）
    let allNames: any[] = [], cloudFolders: any[] = [];
    try { allNames = allNames.concat((await listSessions()).map((s: any) => s.name)); } catch {}
    try {
      const all = await listCloudAll();
      allNames = allNames.concat(all.files.map((c: any) => c.path.replace(/\.ora$/i, "")));
      cloudFolders = all.folders;
    } catch (e) { console.warn("[folder] cloud list failed:", e); }
    const fullPrefix = `${fullPath}/`;
    const exists = allNames.some((n) => n === fullPath || n.startsWith(fullPrefix)) || cloudFolders.includes(fullPath);
    if (exists) { setStatus(`文件夹 "${trimmed}" 已存在`, true); return; }
    await withBusy(`正在创建文件夹 ${trimmed}…`, async () => {
      try { await ensureSubfolder(fullPath); setStatus(`已建文件夹：${trimmed}`); }
      catch (e: any) { console.warn("[folder] cloud ensure failed:", e); setStatus("建文件夹失败：" + (e && e.message || e), true); }
    });
    gallery.refresh();
  });
}
