// 职责（单一）：图库全屏外壳 —— 开/关图库 + chrome（视图按钮可见性）+ 新建作品 sheet +
//   IDB 占用/配额 + 加号·云·菜单 popup 按钮接线 + 名字唯一化。
//
// 从 app.js god-file 切出「图库这层壳怎么开关、壳上那几个 popup 按钮怎么接、新建作品走哪条
//   sheet」那一轴。<Gallery> 深模块本身（src/gallery/gallery.ts）仍由 app.js mountGallery 组装并经
//   ctx.gallery 注入本壳；本壳只管「围着它的全屏外壳 + chrome + 入口按钮」。
//
// **红线（CRITICAL）**：setGalleryOpen / 新建确认 等编排里对 session.* / _store.* 的调用全部
//   RELOCATE 原样（参数/顺序/语义保持），绝不改。要改 store/session 行为 → STOP，escalate。
//
// 对外导出：setGalleryOpen / checkQuotaAndWarn / uniqueNameFor（这三个经 ctx 注入 app，
//   由 session-state / import-image 消费）。updateIdbUsage / openNewDocSheet 只在本模块内用
//   （v415 核实：不在 AppContext 里、app.ts 也不 import——旧注释说它们对外是错的）。
//
// 依赖：editMode / board / gallery / store(_store) / setStatus 经 initGalleryShell(ctx) 绑入；
//   doc 同样经 ctx（openNewDocSheet 读 doc.width/height）。session / els / isSignedIn /
//   anchorPopupToBtn / setAddImportAsNewDoc / importImageAsNewDoc / readImageFromClipboard
//   直接 import（leaf/singleton）。

import { session } from "../session-state.ts";
import { reportError } from "../error-badge.ts";
import { els } from "../els.ts";
import { readImageFromClipboard } from "../session.ts";
import { sessionFileName, sessionBareName } from "../config.ts";   // 边界：裸 session 名 → 库全名（占用检查按库身份查）
import { isSignedIn } from "../app-store.ts";
import { anchorPopupToBtn } from "../anchored-popup.ts";
import { wireInlineSelect } from "../inline-select.ts";
import { applyTheme, themeLabel, THEMES, currentTheme } from "../theme.ts";
import { lang, setLang, LANGS, langDisplayName } from "../i18n/index.ts";
import { openInputSheet, openConfirmSheet } from "../sheets.ts";
import { pathJoin } from "./gallery-path.ts";
import { setAddImportAsNewDoc, importImageAsNewDoc } from "../import-image.ts";
import { isUnlocked, lock, setPassword, promptPassword } from "../crypto-state.ts";
import { hasVerifier, checkVerifier, clearVerifier } from "../password-verifier.ts";
import { t } from "../i18n/index.ts";
import { loadCanvasTemplates, fillTemplateSelect, templateById, templatePx } from "../canvas-templates.ts";

import type { AppContext } from "../app-context.ts";
const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e);

// ---- ctx-bound 协作件（app 拥有，boot 时 initGalleryShell(ctx) 注入）----
let editMode: AppContext["editMode"], board: AppContext["board"], gallery: AppContext["gallery"], doc: AppContext["doc"], _store: AppContext["store"], setStatus: AppContext["setStatus"], withBusy: AppContext["withBusy"];

// trash-bar / add / trash 按钮的可见性随视图（旧 renderGallery 内联，现 app chrome 显式管）。
function _galleryChrome(view: string) {
  els.galleryTrashBar?.classList.toggle("hidden", view !== "trash");
  els.galleryAddBtn?.classList.toggle("hidden", view === "trash");
  els.galleryTrashBtn?.classList.toggle("hidden", view === "trash");
}

export async function setGalleryOpen(open: boolean) {
  if (open) {
    // 进图库 = 用户离开编辑场景 → apply 所有 pending transient（套索浮层等）+ 保存
    editMode.applyPendingTransient();
    if (session.dirty) await session.save();
    await session.awaitCloudPushIdle();   // 等 cloud push 完，防 status race
    document.body.dataset.mode = "gallery";
    els.galleryFull.classList.remove("hidden");
    _galleryChrome("files");      // 每次进默认 files 视图（避免上次留在 trash 里的混乱）
    gallery.setView("files");     // setView 内含 reload
    updateIdbUsage();
  } else {
    editMode.applyPendingTransient();
    if (session.dirty) await session.save();
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
  _selectPreset(DEFAULT_PRESET);
  els.newDocCustomRow.style.display = "none";
  els.newDocW.value = String(doc.width);
  els.newDocH.value = String(doc.height);
  els.newDocBackdrop.classList.remove("hidden");
  els.newDocSheet.classList.remove("hidden");
  setTimeout(() => { els.newDocName.focus(); els.newDocName.select(); }, 50);
}
function closeNewDocSheet() {
  els.newDocBackdrop.classList.add("hidden");
  els.newDocSheet.classList.add("hidden");
}
const DEFAULT_PRESET = "screen-2048sq";
let _presetVal = DEFAULT_PRESET;   // #21：preset 单一真相（confirm 读它）。值 = 模板 id 或 "custom"。
// #21 终版（v0.5.10）：全部预设进一个下拉框（#newDocPreset，三 optgroup + 自定义）——chips 已删。
// v0.7.32：option 由 canvas-templates.json 投影（不再手写在 index.html——那是和裁切分叉的第二份表）。
function _selectPreset(val: string) {
  _presetVal = val;
  const sel = document.getElementById("newDocPreset") as HTMLSelectElement | null;
  if (sel && sel.value !== val) sel.value = val;
  els.newDocCustomRow.style.display = val === "custom" ? "" : "none";
}

// 作品占用 = store 本地缓存 files 分区的字节和件数（**不**走 storage.estimate —— 它把 SW
// 预缓存 / localStorage 算进去虚高几 MB）。
//   口径诚实交代：这是「本地存了多少作品」，**不含**缩略图缓存（在 app 自己的 webpaint 库）、
//   不含回收站/备份箱、不含纯云端未缓存的作品。所以文案是「作品占用」不是「本地占用」。
//   （v415 前这里读的是早已没有写入者的 sessions 库 → 恒显 0 B / 0 件。）
// quota 来自 storage.estimate，是**浏览器愿意分配的上限**（iOS Safari 通常 ~ 60-80% 可用
// 磁盘；动辄几十 GB），不是 "我们申请了多少"。所以放 title 里给好奇用户看，不主显。
// ⚠ 只在图库打开/刷新时调：内部是一次全表 cursor（本地、无网络，但别挂每帧）。
export async function updateIdbUsage() {
  try {
    const { bytes, count } = await _store.files.usage();
    let label = t("gs.footUsage", { size: humanSize(bytes), count });
    let level = "ok";   // ok | warn | critical
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est && est.quota) {
        const ratio = (est.usage || 0) / est.quota;
        const pct = Math.round(ratio * 100);
        els.galleryFootUsage.title =
          t("gs.footUsageTitle", { size: humanSize(est.quota), pct });
        if (ratio > 0.95) { level = "critical"; label += t("gs.usedSuffix", { pct }); }
        else if (ratio > 0.8) { level = "warn"; label += t("gs.usedSuffix", { pct }); }
      }
    }
    els.galleryFootUsage.textContent = label;
    els.galleryFootUsage.classList.toggle("usage-warn", level === "warn");
    els.galleryFootUsage.classList.toggle("usage-critical", level === "critical");
  } catch {
    els.galleryFootUsage.textContent = t("gs.usageUnknown");
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
      setStatus(t("gs.quotaCritical", { pct }), true);
    } else if (level === "warn") {
      setStatus(t("gs.quotaWarn", { pct }), true);
    }
  } catch {}
}

// （humanTime 死码已删 2026-06：gallery-shell 无调用者；展示用的 humanTime 在 gallery-view-model.ts。）
function humanSize(b: number | null | undefined): string {
  if (b == null) return "?";
  if (b === 0) return "0 B";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

// 拿一个不占用的名字（X / X 1 / X 2 / ...）。
//   走 store.files.nameOccupied = **唯一权威**占用检查（本地 + 在线时云端；本地命中即短路，
//   常见 0-1 次网络往返）。不列举任何文件夹——全库 list 是被否决的退化设计。
//   （旧名 uniqueLocalName 撒谎：它现在也查云端。且旧实现读死了的 sessions 库 → 恒不撞名。）
//   上限 20（旧 100）：每次未命中最坏一次 fetchMeta，别让「新建」确认卡在上百次往返上；
//   兜底加时间戳，保证一定返回一个名字。
//   ⚠ 返回**归一化后**的裸名（v437）：以前查占用用 sessionFileName(stem)（归一）却把**原始** stem
//   返回去，于是 newDoc 拿着 `a:b` 当活动名，而 store/gallery 那边是 `a_b` → 五处 `===` 比较失配。
//   归一化必须发生在名字**诞生的地方**，不是比较的地方。
export async function uniqueNameFor(stem: string) {
  const base = sessionBareName(stem);
  if (!(await _store.files.nameOccupied(sessionFileName(base)))) return base;
  for (let i = 1; i < 20; i++) {
    const candidate = `${base} ${i}`;
    if (!(await _store.files.nameOccupied(sessionFileName(candidate)))) return candidate;
  }
  return `${base} ${Date.now()}`;
}

export function initGalleryShell(ctx: AppContext) {
  editMode = ctx.editMode;
  board = ctx.board;
  gallery = ctx.gallery;
  doc = ctx.doc;
  _store = ctx.store;
  setStatus = ctx.setStatus;
  withBusy = ctx.withBusy;

  // 加号 popup
  els.galleryAddBtn.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    const hidden = els.galleryAddPopup.classList.contains("hidden");
    els.cloudAccountPopup.classList.add("hidden");
    els.galleryAddPopup.classList.toggle("hidden", !hidden);
    if (hidden) anchorPopupToBtn(els.galleryAddPopup, els.galleryAddBtn);
    els.galleryAddBtn.setAttribute("aria-expanded", hidden ? "true" : "false");
  });
  // 云 icon popup
  els.cloudIconBtn.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    const hidden = els.cloudAccountPopup.classList.contains("hidden");
    els.galleryAddPopup.classList.add("hidden");
    els.cloudAccountPopup.classList.toggle("hidden", !hidden);
    if (hidden) anchorPopupToBtn(els.cloudAccountPopup, els.cloudIconBtn);
    els.cloudIconBtn.setAttribute("aria-expanded", hidden ? "true" : "false");
  });
  // 回收站视图：进/出 + 清空。v211/v214 把图库收成 Vue 深模块时，trash 按钮的接线漏搬
  // （setView/getView/emptyTrash 已在 GalleryHandle 上，只是 chrome 这层没人调）→「回收站打不开」。
  // chrome 可见性 _galleryChrome + 视图切 gallery.setView 两件一起（与 setGalleryOpen 进库同模式）。
  const _switchView = (view: "files" | "trash") => { _galleryChrome(view); gallery.setView(view); };
  els.galleryTrashBtn?.addEventListener("click", () => _switchView("trash"));
  els.galleryTrashBack?.addEventListener("click", () => _switchView("files"));
  els.galleryTrashMenuBtn?.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    const hidden = els.galleryTrashMenuPopup.classList.contains("hidden");
    els.galleryTrashMenuPopup.classList.toggle("hidden", !hidden);
    if (hidden) anchorPopupToBtn(els.galleryTrashMenuPopup, els.galleryTrashMenuBtn);
  });
  els.galleryEmptyTrashLocalBtn?.addEventListener("click", () => {
    els.galleryTrashMenuPopup.classList.add("hidden");
    gallery.emptyTrash("local");
  });
  els.galleryEmptyTrashCloudBtn?.addEventListener("click", () => {
    els.galleryTrashMenuPopup.classList.add("hidden");
    gallery.emptyTrash("cloud");
  });

  // 图库菜单 popup（版本号 + 强制更新 + 文件无关设置）
  els.galleryMenuBtn?.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    const hidden = els.galleryMenuPopup.classList.contains("hidden");
    els.galleryAddPopup.classList.add("hidden");
    els.cloudAccountPopup.classList.add("hidden");
    els.galleryMenuPopup.classList.toggle("hidden", !hidden);
    if (hidden) anchorPopupToBtn(els.galleryMenuPopup, els.galleryMenuBtn);
    els.galleryMenuBtn.setAttribute("aria-expanded", hidden ? "true" : "false");
    // 解锁/锁定按钮的标签随锁态（每次开菜单刷一次即可）
    const lockLabel = els.galleryMenuLock?.querySelector(".menu-item-label");
    if (lockLabel) lockLabel.textContent = isUnlocked() ? t("gs.lockLabel") : t("gs.unlockLabel");
  });

  // 加密作品 解锁/锁定（ADR-0012 统一图库密码；密码只在内存，锁定 = 清掉）
  els.galleryMenuLock?.addEventListener("click", async () => {
    els.galleryMenuPopup.classList.add("hidden");
    if (isUnlocked()) {
      lock();
      setStatus(t("gs.locked"));
      gallery.refresh();
      return;
    }
    // 在**当前夹**找一件本地加密作品 → 交互解锁（busy 外 prompt + verifyPassword 验 peek + 记忆）。
    //   本夹一件都没有 → 收下未验证的密码当统一密码（用到时自然验证，错了会重问）。
    //   刻意只看当前夹：列举唯一面 = watchFolder，不做全库扫描。
    //   （v415 前这里读死了的 sessions 库 → 恒找不到，永远走下面的未验证分支。）
    try {
      if (await gallery.requestUnlock()) { setStatus(t("gs.unlocked")); gallery.refresh(); return; }
    } catch (_) {}
    // v0.4.11（真机 2.3）：有 verifier（跟账号走）→ 输入并校验；三错给唯一的重置出口。
    //   旧病：本夹无本地加密件时未验证密码被直接坐实成全局——错密码随后被 encrypt 复用 = 两套密码 softlock。
    if (hasVerifier()) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const pw = await promptPassword({ title: t("gs.unlockTitle"), message: attempt > 0 ? t("gs.pwWrongRetry") : t("gs.unlockVerifierMsg") });
        if (pw == null) return;
        if ((await checkVerifier(pw)) === "ok") { setPassword(pw); setStatus(t("gs.unlocked")); gallery.refresh(); return; }
      }
      if (await openConfirmSheet(t("gs.resetPwTitle"), t("gs.resetPwMsg"))) { clearVerifier(); setStatus(t("gs.pwResetDone")); }
      return;
    }
    const pw = await promptPassword({ title: t("gs.unlockTitle"), message: t("gs.unlockNoLocalMsg") });
    if (pw != null) { setPassword(pw); setStatus(t("gs.pwRecorded")); gallery.refresh(); }
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
      if (!blob) { setStatus(t("gs.clipboardNoImage")); return; }
      const file = new File([blob], "clipboard.png", { type: blob.type || "image/png" });
      await importImageAsNewDoc(file);
      setGalleryOpen(false);
    } catch (e) {
      reportError(new Error(t("gs.clipboardNewFailed", { err: errMsg(e) })), "warning");   // #34：iPad 权限被拒要看得见
    }
  });

  // 新建作品 sheet 接线
  // #21 终版（v0.5.10）：唯一的尺寸下拉框（v217 的 chips 按钮组已删）
  const presetSel = document.getElementById("newDocPreset") as HTMLSelectElement | null;
  // v0.7.32：option 来自 canvas-templates.json（async fetch）。先同步投影一次——此刻表可能还空着，
  // 但「自定义…」这条立刻就在，下拉框不会有一段完全空白的窗口；json 回来再投影一次并选回默认。
  if (presetSel) {
    fillTemplateSelect(presetSel, t("nd.custom"));
    void loadCanvasTemplates().then(() => {
      fillTemplateSelect(presetSel, t("nd.custom"));
      _selectPreset(_presetVal);
    });
  }
  presetSel?.addEventListener("change", () => { if (presetSel.value) _selectPreset(presetSel.value); });
  els.newDocBackdrop.addEventListener("click", closeNewDocSheet);
  els.newDocCancel.addEventListener("click", closeNewDocSheet);
  // v0.5.40（user：「确认总是要点好几下」）：名字输入框聚焦时点按钮，pointerdown 默认行为先 blur →
  //   键盘收起 → 底部 sheet 位移 → click 落空。preventDefault 挡掉焦点转移，按钮原位吃到 click。
  for (const b of [els.newDocConfirm, els.newDocCancel]) {
    b.addEventListener("pointerdown", (e: Event) => e.preventDefault());
  }

  els.newDocConfirm.addEventListener("click", async () => {
    const nameRaw = (els.newDocName.value || "").trim() || t("gs.untitled");
    let w, h;
    const presetVal = _presetVal || DEFAULT_PRESET;
    // v0.7.32：preset 值 = canvas-templates.json 的模板 id（此前是 "WxH" 字面量）。模板查不到
    // （json 没加载到）→ 退到自定义输入框里的当前画布尺寸，而不是静默造一张 2048²。
    const tpl = presetVal === "custom" ? null : templateById(presetVal);
    if (tpl) {
      const px = templatePx(tpl);
      w = Math.max(16, Math.min(8192, px.w));
      h = Math.max(16, Math.min(8192, px.h));
    } else {
      w = Math.max(16, Math.min(8192, parseInt(els.newDocW.value, 10) || 2048));
      h = Math.max(16, Math.min(8192, parseInt(els.newDocH.value, 10) || 2048));
    }
    const name = await uniqueNameFor(nameRaw);
    closeNewDocSheet();
    // doc 替换 + 落盘 + 切指针 + checkpoint + 关库全在 session.newDoc（session-state.ts）。
    await session.newDoc({ name, w, h });
    setStatus(t("gs.created", { name, w, h }));
  });

  // 图库菜单 popup 内动作代理到主菜单已有 handler（.click() 即触发，不重复逻辑/状态）。
  els.galleryMenuForceUpdate?.addEventListener("click", () => {
    els.galleryMenuPopup.classList.add("hidden");
    els.menuForcePwaReset?.click();
  });
  // v0.5.40：主题/语言 in-app 下拉（同设置页机制）；gen-AI 代理主菜单同一 handler。
  wireInlineSelect("galleryThemeBtn", "galleryThemeMenu",
    () => THEMES.map((th) => ({ value: th, label: themeLabel(th) })),
    () => currentTheme(),
    (th) => { applyTheme(th); });
  const galLangLabel = document.getElementById("galleryLanguageBtnLabel");
  if (galLangLabel) galLangLabel.textContent = langDisplayName(lang());
  wireInlineSelect("galleryLanguageBtn", "galleryLanguageMenu",
    () => LANGS.map((l) => ({ value: l, label: langDisplayName(l) })),
    () => lang(),
    (l) => { void setLang(l).catch((e) => reportError(e)); });
  // 三个 popup 的 outside-click 关闭
  document.addEventListener("pointerdown", (e: Event) => {
    if (!els.galleryAddPopup.classList.contains("hidden") &&
        !els.galleryAddPopup.contains(e.target as Node) &&
        !els.galleryAddBtn.contains(e.target as Node)) {
      els.galleryAddPopup.classList.add("hidden");
    }
    if (!els.cloudAccountPopup.classList.contains("hidden") &&
        !els.cloudAccountPopup.contains(e.target as Node) &&
        !els.cloudIconBtn.contains(e.target as Node)) {
      els.cloudAccountPopup.classList.add("hidden");
    }
    if (els.galleryMenuPopup && !els.galleryMenuPopup.classList.contains("hidden") &&
        !els.galleryMenuPopup.contains(e.target as Node) &&
        !els.galleryMenuBtn.contains(e.target as Node)) {
      els.galleryMenuPopup.classList.add("hidden");
    }
    if (els.galleryTrashMenuPopup && !els.galleryTrashMenuPopup.classList.contains("hidden") &&
        !els.galleryTrashMenuPopup.contains(e.target as Node) &&
        !els.galleryTrashMenuBtn.contains(e.target as Node)) {
      els.galleryTrashMenuPopup.classList.add("hidden");
    }
  });

  // + 新建文件夹（云端真文件夹为准：在 OneDrive 上建真文件夹，需登录+在线）
  els.addNewFolder?.addEventListener("click", async () => {
    els.galleryAddPopup.classList.add("hidden");
    // 文件夹模型「云端真文件夹为准」→ 必须登录+在线才能建（否则无处持久化空文件夹）
    if (!isSignedIn() || navigator.onLine === false) {
      setStatus(t("gs.folderNeedSignin"), true);
      return;
    }
    const stem = await openInputSheet(t("gs.newFolderTitle"), t("gs.newFolderDefault"), { placeholder: t("gs.folderNamePlaceholder") });
    if (stem == null) return;
    const trimmed = stem.trim();
    if (!trimmed) { setStatus(t("gs.folderNameEmpty"), true); return; }
    if (trimmed.includes("/")) { setStatus(t("gs.folderNameNoSlash"), true); return; }
    const fullPath = pathJoin(gallery.getFolder(), trimmed);
    // 点确定即刻锁屏（含「已存在」预检的网络往返也在锁内）——修「新建文件夹延迟锁屏 F」。
    //   withBusy 可重入（ref-count），内层 store.flow.newFolder 再包一层 busy 不会提前解锁。
    await withBusy(t("gs.creatingFolder", { name: trimmed }), async () => {
      // 统一走 store.nameOccupied（唯一占用检查）：同名文件占了 → 提示；纯文件夹已存在则 ensureFolder 幂等（复用无害）。
      if (await _store.files.nameOccupied(fullPath)) { setStatus(t("gs.folderExists", { name: trimmed }), true); return; }
      // 走 store.flow.newFolder（深模块窄接口）而非裸 ensureSubfolder——锁屏/单飞守卫由库内强制。
      try { await _store.files.newFolder(fullPath); setStatus(t("gs.folderCreated", { name: trimmed })); }
      catch (e) { reportError(new Error("[folder] cloud ensure failed: " + String(e)), "log"); setStatus(t("gs.folderCreateFailed", { err: errMsg(e) }), true); }
    });
    gallery.refresh();
  });
}
