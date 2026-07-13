// Session —— 活动文档（active-document）的 app 编排。**editor-session 的消费者 + ora editor 适配器宿主**。
//
// cutover（2026-07-09）：持久化编排全塌进家族共享模块 **editor-session**（open/存/推/失焦/退出/autosave 通用逻辑）。
//   本模块只剩 **app 编排**：ora editor 适配器（adopt/encode/onChange 包画图引擎）、相位/懒空白/版本降级守卫/
//   加密切换/rename & exit 的 UI 循环/gallery 耦合。**sync 机制全在 sync-store 库、生命周期在 editor-session**——
//   本模块不碰 If-Match/parentBase/freshness（进库了）、不碰 busy/autosave 节律（进 editor-session 了）。
//
// 三层：session（本模块，app 编排 + ora 适配器）→ editor-session（生命周期，共享）→ sync-store（文件系统，库）。
//
// ⚠ 已删依赖：gateCloudSyncOnOpen（freshness 进 store.file.open）、getKnownETag/clearCloudState/isCloudDirty
//   （dirty 分层：内存脏=es.isDirty，sync 脏=listAllItems）、_store.busy/edits/session/autosave/flow.*/adoptBase/seal。

import { reactive } from "../vendor/vue/vue.esm-browser.prod.js";
import { WEBPAINT_VERSION } from "./version.ts";
import { renderThumbBlob, setCurrentSessionName } from "./session.ts";
import { encodeDocToOra, decodeOraToDoc, parseAppVersion } from "./ora.ts";
import { PaintDoc } from "./doc.ts";
import type { Layer } from "./doc.ts";
import { isSignedIn, store as _store } from "./app-store.ts";
import { openInputSheet, openConfirmSheet, lockSyncGate } from "./sheets.ts";
import { pathFolder } from "./gallery-path.ts";
import { stripSessionExt, sessionFileName } from "./config.ts";
import { serializedToolStatePatch } from "./editor-state.ts";
import { getBlenderSyncState, applyBlenderSyncState } from "./blender-sync.ts";
import { ensureNewPassword, ensureUnlocked } from "./enc-thumbs.ts";
import { setPassword } from "./crypto-state.ts";
import { els } from "./els.ts";
import type { AppContext } from "./app-context.ts";
import type { GalleryItem } from "./gallery-model.ts";
import { t } from "./i18n/index.ts";
import { createEditorSession, type EditorSession, type StoreLike } from "./editor-session/index.ts";

const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e);

interface OraWebpaintState {
  reference?: unknown; color?: string; toolStates?: Record<string, unknown>;
  palette?: unknown; checkerboard?: boolean; activeId?: number; activeLayerIndex?: number;
  viewport?: { scale?: number } & Record<string, unknown>;
  blender?: unknown;
}
type LoadedDoc = PaintDoc & { _webpaintState?: OraWebpaintState; _referenceBlob?: Blob | null; _wroteWith?: string; };

// ---- ctx-bound 协作件（app 拥有，boot 时 initSession(ctx) 注入）----
let state: AppContext["state"], doc: AppContext["doc"], board: AppContext["board"];
let input: AppContext["input"], editMode: AppContext["editMode"], rack: AppContext["rack"];
let referenceWindow: AppContext["referenceWindow"], paletteWindow: AppContext["paletteWindow"];
let setStatus: AppContext["setStatus"], withBusy: AppContext["withBusy"];
let updateSaveStatus: AppContext["updateSaveStatus"], updateNewerBanner: AppContext["updateNewerBanner"];
let setColor: AppContext["setColor"], applyCheckerboard: AppContext["applyCheckerboard"], renderLayersPanel: AppContext["renderLayersPanel"];
let setGalleryOpen: AppContext["setGalleryOpen"];
let checkQuotaAndWarn: AppContext["checkQuotaAndWarn"], uniqueLocalName: AppContext["uniqueLocalName"];
let gallery: AppContext["gallery"];
let showFullscreenBusy: AppContext["showFullscreenBusy"], hideFullscreenBusy: AppContext["hideFullscreenBusy"];

// ---- session 拥有的 SSoT 状态 ----
let _activeSessionName: string | null = "未命名";   // 幽灵 path 保护：boot 成功/主动 open/new/save-as 才升级真名
let _isLazyBlankSession = false;
let _docLastSavedAt = 0;
let _sessionOpenedAt = 0;
let _loadedDocIsNewer = false;
let _loadedDocWriterVer: string | null = null;
let _loadedDocNewerConfirmed = false;
let _loadingDoc = false;

const AUTOSAVE_MS = 3 * 60 * 1000;

const _phase = reactive<{ current: "gallery" | "editing" | "lazyblank" }>({ current: "gallery" });
function _recomputePhase() { _phase.current = !_activeSessionName ? "gallery" : _isLazyBlankSession ? "lazyblank" : "editing"; }

const _enc = reactive<{ encrypted: boolean }>({ encrypted: false });
// 边界（薄库身份=全名）：app 内部 _activeSessionName 是**裸** session 名；跨到库/editor-session 前统一 sessionFileName
//   转全名（X→X.ora）。加密件 .zip 由库内部据字节态翻转，app 只传明文全名。OUT 侧（itemToG）用 stripSessionExt 还原。
const toFull = (name: string) => sessionFileName(name);
const _file = (name: string) => _store.file(toFull(name), { isZip: true });   // WebPaint work-file = ora-zip 容器（有 peek）
async function _refreshEncrypted() {
  try { _enc.encrypted = _activeSessionName ? await _file(_activeSessionName).isEncrypted() : false; }
  catch { _enc.encrypted = false; }
}

// ============ 编辑器状态 I/O（v267b；app 编辑器概念，不动）============
function storeEditorStateToOra() {
  return {
    reference: referenceWindow.getSerializedState(), color: state.color, toolStates: state.toolStates,
    palette: paletteWindow.getSerializedState(), checkerboard: state.checkerboard,
    activeId: doc.activeId, activeLayerIndex: doc.activeIndex, blender: getBlenderSyncState(),
  };
}
function resetEditorState() {
  referenceWindow.clearBitmap(); referenceWindow.close?.();
  paletteWindow.clear?.(); paletteWindow.close?.();
  setColor("#000000"); applyCheckerboard(false); state.filterBrush = null; applyBlenderSyncState();
}
function restoreEditorStateFromOra(loaded: LoadedDoc) {
  const ws = loaded?._webpaintState;
  if (loaded?._referenceBlob) {
    createImageBitmap(loaded._referenceBlob).then((bitmap: ImageBitmap) => {
      referenceWindow.setBitmap(bitmap, { persistBlob: loaded._referenceBlob });
      if (ws?.reference) referenceWindow.applySerializedState(ws.reference);
    }).catch(() => {});
  } else if (ws?.reference) { referenceWindow.applySerializedState(ws.reference); }
  if (ws?.color) setColor(ws.color);
  if (ws?.palette) { try { paletteWindow.applySerializedState(ws.palette); } catch (_) {} }
  if (ws?.toolStates && typeof ws.toolStates === "object") {
    for (const tk of Object.keys(state.toolStates)) {
      const patch = serializedToolStatePatch(state.toolStates[tk], ws.toolStates[tk]);
      if (patch) Object.assign(state.toolStates[tk], patch);
    }
    rack.applyToolState(editMode.current());
  }
  applyCheckerboard(!!ws?.checkerboard); applyBlenderSyncState(ws?.blender);
  if (ws?.activeId != null && doc.setActiveById(ws.activeId)) renderLayersPanel();
  else if (typeof ws?.activeLayerIndex === "number" && doc.setActive(ws.activeLayerIndex)) renderLayersPanel();
}
function _buildOraMeta() { return { referenceImage: referenceWindow.getPersistBlob(), webpaintState: storeEditorStateToOra() }; }
function _encodeCurrentOra(): Promise<Blob> { return encodeDocToOra(doc, _buildOraMeta() as Parameters<typeof encodeDocToOra>[1]) as Promise<Blob>; }

// ---- blank-unnamed 自检 ----
function _docIsBlankUnnamed() {
  if (_isLazyBlankSession) {
    for (const L of doc.layers as Layer[]) if (L.bboxW > 0 && L.bboxH > 0) { _isLazyBlankSession = false; _recomputePhase(); return false; }
    return true;
  }
  if (_activeSessionName && _activeSessionName !== "未命名") return false;
  for (const L of doc.layers as Layer[]) if (L.bboxW > 0 && L.bboxH > 0) return false;
  return true;
}

// ============ ora editor 适配器 + editor-session ============
// 适配器：把画图引擎（doc/board）包成 editor-session 要的 adopt/encode/onChange。editor-session 不懂 ora。
let es: EditorSession;

// adoptModel：把解出的 doc 渲进画布（模型 + UI + 编辑器状态 + 版本降级检测）。**不碰 name/es/checkpoint**。
function adoptModel(loaded: LoadedDoc) {
  _loadingDoc = true;
  try {
    doc.adoptState(loaded);
    resetEditorState();
    els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
    input.clearHistory();
    board.invalidateAll(); board.requestRender(); renderLayersPanel();
    // 版本降级检测：写这画的 WebPaint 版本 > 当前 → 警告（守卫 saveNow/saveAndPush 覆盖）。
    _loadedDocIsNewer = false; _loadedDocNewerConfirmed = false;
    const writerN = parseAppVersion(loaded._wroteWith), selfN = parseAppVersion(WEBPAINT_VERSION);
    if (writerN !== null && selfN !== null && writerN > selfN) {
      _loadedDocIsNewer = true; _loadedDocWriterVer = loaded._wroteWith ?? null;
      setStatus(t("ss.docNewerWarning", { writer: String(loaded._wroteWith), version: WEBPAINT_VERSION }), true);
    } else { _loadedDocWriterVer = null; }
    updateNewerBanner();
    restoreEditorStateFromOra(loaded);
    const vp = loaded._webpaintState?.viewport;
    if (vp && typeof vp.scale === "number") { Object.assign(board.viewport, vp); board.invalidateAll(); board.requestRender(); }
  } finally { _loadingDoc = false; }
}

// app.js 兼容：session.adopt(loaded, name) —— revert/saveAs 直接把一个解好的 doc 装入 + 设为当前（脏，待存）。
function adoptLoadedDoc(loaded: LoadedDoc, name: string) {
  adoptModel(loaded);
  _activeSessionName = name; setCurrentSessionName(name); _isLazyBlankSession = false; _recomputePhase();
  es.adopted(toFull(name));
  _docLastSavedAt = Date.now(); updateSaveStatus(); _refreshEncrypted();
}
function adoptLoadedDocWithOpts(loaded: LoadedDoc, name: string, _opts: { skipCheckpoint?: boolean }) { adoptLoadedDoc(loaded, name); }

// ---- checkpoint / revert（⚠TODO：旧走 _store.seal(已删)；待重构为 store 本地文件。暂 stub，revert 功能挂起）----
async function _writeSessionCheckpoint(_name: string) { /* TODO: store.file(".revert/"+name, local-only) */ }
async function _readSessionCheckpoint(_name: string): Promise<{ blob: Blob; at: number } | null> { return null; }

// ---- 保存（本地）----
async function saveNow(opts: { implicit?: boolean } = {}) {
  if (!_activeSessionName) return;
  if (_docIsBlankUnnamed()) return;
  if (editMode.hasPendingTransient()) { if (opts.implicit) return; editMode.applyPendingTransient(); }
  if (_loadedDocIsNewer && !_loadedDocNewerConfirmed) {
    if (opts.implicit) return;
    const ok = await openConfirmSheet(t("ss.overwriteNewerTitle"), t("ss.overwriteNewerMsg", { writer: String(_loadedDocWriterVer), version: WEBPAINT_VERSION }));
    if (!ok) { setStatus(t("ss.saveCancelled")); return; }
    _loadedDocNewerConfirmed = true; updateNewerBanner();
  }
  updateSaveStatus();
  try {
    await es.flushLocal();   // encode（+peek）→ store.file.save({tryPush:false})；只落本地（consent-safe）
    _docLastSavedAt = Date.now();
    setStatus(t("ss.saved", { name: _activeSessionName ?? "" }));
    checkQuotaAndWarn();
  } catch (e) { console.warn("[session] save failed:", e); setStatus(t("ss.saveFailed", { error: errMsg(e) })); }
  finally { updateSaveStatus(); }
}

// ---- 保存 + 推云（consent push）----
async function saveAndPush() {
  if (!_activeSessionName) { setStatus(t("ss.noDocCannotSave"), true); return; }
  // 版本降级守卫：新版本文档未确认 → 只本地不推（saveNow 的 confirm 已挡本地覆盖，这里挡推）。
  if (_loadedDocIsNewer && !_loadedDocNewerConfirmed) {
    await saveNow();
    if (!_loadedDocNewerConfirmed) { setStatus(t("ss.notPushedNewer"), true); return; }
  }
  const name = _activeSessionName;
  updateSaveStatus();
  try {
    // flushAndPush：encode（若内存脏/push-pending）→ save({tryPush:true})。冲突/错误经 store 的 ui bundle surface。
    await es.flushAndPush();
    _docLastSavedAt = Date.now();
    setStatus(isSignedIn() ? t("ss.synced", { name }) : t("ss.savedLocalIdb", { name }));
    gallery.refresh();
  } catch (e) { console.warn("[cloud] push failed:", e); setStatus(t("ss.pushFailed", { error: errMsg(e) })); }
  finally { updateSaveStatus(); }
}

// ---- 加密 / 解除（对活动 doc；at-rest 字节换容器，内存态透明不动）----
async function encryptCurrent() {
  if (!_activeSessionName || _isLazyBlankSession) { setStatus(t("ss.openOrSaveBeforeEncrypt"), true); return; }
  const online = () => isSignedIn() && navigator.onLine !== false;
  if (await _file(_activeSessionName).isEncrypted()) { setStatus(t("ss.alreadyEncrypted")); return; }
  const pw = await ensureNewPassword();
  if (pw == null) { setStatus(t("ss.cancelled")); return; }
  setPassword(pw);
  await withBusy(t("ss.encryptingBusy", { name: _activeSessionName ?? "" }), async () => {
    try {
      await saveNow();   // flush 活 doc 明文 → store 读它打包
      const res = await _file(_activeSessionName!).encrypt({ isOnline: online });
      if (res.status === "offline") { setStatus(t("ss.encryptNeedsOnline"), true); return; }
      if (res.status === "already") { setStatus(t("ss.alreadyEncrypted")); return; }
      await _refreshEncrypted(); updateSaveStatus();
      setStatus(res.status === "cloud-deferred" ? t("ss.encryptedDeferred", { name: _activeSessionName ?? "" }) : t("ss.encrypted", { name: _activeSessionName ?? "" }), res.status === "cloud-deferred");
      gallery?.refresh?.();
    } catch (e) { setStatus(t("ss.encryptFailed", { error: errMsg(e) }), true); }
  });
}
async function decryptCurrent() {
  if (!_activeSessionName) { setStatus(t("ss.noDocOpen"), true); return; }
  const online = () => isSignedIn() && navigator.onLine !== false;
  if (!(await _file(_activeSessionName).isEncrypted())) { setStatus(t("ss.notEncrypted")); return; }
  const ok = await openConfirmSheet(t("ss.decryptConfirmTitle"), t("ss.decryptConfirmMsg"));
  if (!ok) return;
  if (!(await ensureUnlocked(_activeSessionName))) { setStatus(t("ss.cancelledNeedPassword"), true); return; }
  await withBusy(t("ss.decryptingBusy", { name: _activeSessionName ?? "" }), async () => {
    try {
      await saveNow();
      const res = await _file(_activeSessionName!).decrypt({ isOnline: online });
      if (res.status === "offline") { setStatus(t("ss.decryptNeedsOnline"), true); return; }
      if (res.status === "locked") { setStatus(t("ss.cancelledNeedPassword"), true); return; }
      if (res.status === "not-encrypted") { setStatus(t("ss.notEncrypted")); return; }
      await _refreshEncrypted(); updateSaveStatus();
      setStatus(t("ss.decrypted", { name: _activeSessionName ?? "" }));
      gallery?.refresh?.();
    } catch (e) { setStatus(t("ss.decryptFailed", { error: errMsg(e) }), true); }
  });
}

// ---- rename（UI 循环 + es.rename）----
async function renameCurrentSession({ suggested, reason }: { suggested?: string; reason?: string } = {}) {
  editMode.applyPendingTransient();
  const oldName = _activeSessionName!;
  let candidate = suggested || oldName;
  let note = "";
  while (true) {
    const title = note ? t("ss.renameTitleWith", { detail: note }) : (reason ? t("ss.renameTitleWith", { detail: reason }) : t("ss.renameTitle"));
    const input2 = await openInputSheet(title, candidate, { placeholder: t("ss.artworkNamePlaceholder") });
    if (input2 === null) return null;
    const trimmed = input2.trim();
    if (!trimmed) { note = t("ss.nameCannotBeEmpty"); candidate = ""; continue; }
    if (trimmed === oldName) return oldName;
    const outcome: { conflict?: boolean; ok?: boolean } = await withBusy(t("ss.renamingBusy", { oldName, newName: trimmed }), async () => {
      try {
        const r = await es.rename(toFull(trimmed));   // es 先 flushLocal 旧内容 → store.tryMove（唯一入口，含占用检查）；边界转全名
        if (!r.ok) return { conflict: true };  // 目标占用（local/cloud）→ 循环重问；未改 _name
        _activeSessionName = trimmed; setCurrentSessionName(trimmed); _recomputePhase();
        _docLastSavedAt = Date.now(); updateSaveStatus();
        setStatus(t("ss.renamedWithCloud", { oldName, newName: trimmed }));
        gallery.refresh();
        return { ok: true };
      } catch (e) { setStatus(t("ss.renameFailed", { error: errMsg(e) })); return {}; }
    });
    if (outcome.conflict) { setStatus(t("ss.localNameTakenStatus", { name: trimmed }), true); note = t("ss.nameTakenNote", { name: trimmed }); candidate = trimmed; continue; }
    return outcome.ok ? trimmed : null;
  }
}

// ---- 退出到图库（推 + 保存失败重试环）----
async function exitCanvasToGallery() {
  if (_activeSessionName) {
    await withBusy(t("ss.savingBusy", { name: _activeSessionName ?? "" }), async () => {
      try { await es.flushAndPush(); } catch (e) { console.warn("[exit] save failed:", e); }
    });
    // 内存脏没落成（保存失败/取消）→ 显式问重试/丢弃，绝不无条件宣布干净（K2 红线）。
    while (es.isDirty() && !_docIsBlankUnnamed()) {
      const choice = await lockSyncGate({
        title: t("ss.localSaveIncompleteTitle"), message: t("ss.localSaveIncompleteMsg", { name: _activeSessionName ?? "" }), showSpinner: false,
        actions: [{ label: t("ss.retrySave"), value: "retry", primary: true }, { label: t("ss.exitDiscard"), value: "discard" }],
      });
      if (choice !== "retry") break;
      await withBusy(t("ss.savingBusy", { name: _activeSessionName ?? "" }), async () => { try { await es.flushAndPush(); } catch (e) { console.warn("[exit] retry failed:", e); } });
    }
    gallery.setFolder(pathFolder(_activeSessionName));
  }
  _activeSessionName = null; setCurrentSessionName(""); _recomputePhase();
  _enc.encrypted = false; _isLazyBlankSession = false; updateSaveStatus();
  await setGalleryOpen(true);
}

// ---- 新建 doc ----
async function newDoc({ name, w, h, fillLayer0 }: { name: string; w: number; h: number; fillLayer0?: (layer: unknown) => void }) {
  if (es.isDirty()) await saveNow();
  const fresh = new PaintDoc({ width: w, height: h });
  doc.layers = fresh.layers; doc.activeIndex = 0; doc.width = w; doc.height = h; doc.selection = null; doc.referenceLayerId = null;
  els.canvasSizeLabel.textContent = `${w}×${h}`;
  if (fillLayer0) fillLayer0(doc.layers[0]);
  _activeSessionName = name; setCurrentSessionName(name); _recomputePhase();
  _enc.encrypted = false; input.clearHistory(); board.invalidateAll(); board.fitToScreen(); renderLayersPanel();
  resetEditorState();
  es.adopted(toFull(name));   // 新内容装入 editor（非 store.open）→ es 记为当前 + 脏；边界转全名
  _docLastSavedAt = 0; updateSaveStatus();
  await saveNow();   // 落盘（tryPush:false）
  setGalleryOpen(false);
}

// ---- 打开云端路径（cloud item：unified open，file.open 自动拉云落本地）----
async function pullCloudPath(path: string) {
  const name = stripSessionExt(path);
  if (/\.zip$/i.test(String(path))) { if (!(await ensureUnlocked(name))) { setStatus(t("ss.notPulledNeedPassword"), true); return; } }
  showFullscreenBusy(t("ss.pullingFromCloudBusy"));
  try {
    await es.open(toFull(name));   // file.open：本地无→拉云落本地→adopt。freshness/冲突经 store ui。边界转全名。
    _activeSessionName = name; setCurrentSessionName(name); _isLazyBlankSession = false; _recomputePhase(); _refreshEncrypted();
    setGalleryOpen(false); setStatus(t("ss.openedFromCloud", { name }));
  } catch (err) { console.warn("[cloud] pull failed:", err); setStatus(t("ss.pullFailed", { error: errMsg(err) })); }
  finally { hideFullscreenBusy(); }
}

// ---- 打开图库 item ----
async function openItem(item: GalleryItem) {
  if (item.name === _activeSessionName) { setGalleryOpen(false); return; }
  if (es.isDirty()) await saveNow();
  try {
    // 加密且未解锁 → 先在 busy 外解锁（file.open 内部 unseal 要密码在内存）。
    if (await _file(item.name).isEncrypted()) {
      if (!(await ensureUnlocked(item.name))) { setStatus(t("ss.notOpenedNeedPasswordCancelled"), true); return; }
    }
    await es.open(toFull(item.name));   // file.open：load + freshness + 冲突 surface + 崩溃恢复；返 null（锁定/缺失）→ adopt 跳过。边界转全名。
    _activeSessionName = item.name; setCurrentSessionName(item.name); _isLazyBlankSession = false; _recomputePhase(); _refreshEncrypted();
    setGalleryOpen(false); setStatus(t("ss.opened", { name: item.name }));
  } catch (err) { setStatus(t("ss.openFailed", { error: errMsg(err) })); }
}

// ---- 图库「推到云」（非活动 item）：读本地字节 → 带 tryPush 重存（薄库无独立 push，re-save 触发推）----
async function pushItem(item: GalleryItem) {
  if (await _file(item.name).isEncrypted()) { if (!(await ensureUnlocked(item.name))) { setStatus(t("ss.notPushedNeedPassword"), true); return; } }
  await withBusy(t("ss.pushingToCloudBusy", { name: item.name }), async () => {
    try {
      const f = _file(item.name);
      const bytes = await f.open();
      if (!bytes) { setStatus(t("ss.notFound", { name: item.name })); return; }
      await f.save(bytes, { tryPush: true });
      setStatus(t("ss.pushed", { name: item.name }));
      gallery.refresh();
    } catch (err) { setStatus(t("ss.pushFailed", { error: errMsg(err) })); }
  });
}

// ---- 卸载本地副本（offload：清 shadow；非法=唯一副本→store 抛 OffloadIllegalError→banner）----
async function unloadItem(item: GalleryItem) {
  const isActive = item.name === _activeSessionName;
  await withBusy(t("ss.unloadingBusy", { name: item.name }), async () => {
    try {
      await _file(item.name).offload();
      if (isActive) await exitCanvasToGallery();
      setStatus(t("ss.unloaded", { name: item.name }));
      gallery.refresh();
    } catch (err) { setStatus(t("ss.unloadFailed", { error: errMsg(err) })); }
  });
}

// boot：按名恢复上次 doc（file.open 内含本地/云端 + freshness + unseal）。返回是否成功装入。
async function restoreSession(name: string): Promise<boolean> {
  try {
    if (await _file(name).isEncrypted()) { if (!(await ensureUnlocked(name))) return false; }
    if (!(await es.open(toFull(name)))) return false;   // 文件缺失/锁定 → 未装入。边界转全名。
    _activeSessionName = name; setCurrentSessionName(name); _isLazyBlankSession = false; _recomputePhase(); _refreshEncrypted();
    _docLastSavedAt = Date.now(); updateSaveStatus();
    return true;
  } catch (e) { console.warn("[session] restore failed:", e); return false; }
}

// 另存为：当前内容写新身份（旧的不动）+ 切到新名继续编辑。
async function saveAs(newName: string): Promise<void> {
  const bytes = await _encodeCurrentOra();
  const peek = await renderThumbBlob(doc, 256);
  await _file(newName).save(bytes, { tryPush: true, hint: peek ? { peek } : undefined });
  _activeSessionName = newName; setCurrentSessionName(newName); _isLazyBlankSession = false; _recomputePhase();
  es.adopted(toFull(newName));   // es 切到新名（内容即新名的；下轮 autosave 若跑=同内容 re-save，无害）。边界转全名。
  _docLastSavedAt = Date.now(); updateSaveStatus(); gallery.refresh();
}

function setName(name: string | null) { _activeSessionName = name; setCurrentSessionName(name as string); _recomputePhase(); }

// ---- 公开 session 对象（app.js 兼容面）----
export const session = {
  current: _phase, enc: _enc,
  encryptCurrent, decryptCurrent, refreshEncrypted: _refreshEncrypted,
  get name() { return _activeSessionName; },
  get lazyBlank() { return _isLazyBlankSession; },
  get loadingDoc() { return _loadingDoc; },
  get docLastSavedAt() { return _docLastSavedAt; },
  get sessionOpenedAt() { return _sessionOpenedAt; },
  get loadedDocIsNewer() { return _loadedDocIsNewer; },
  get loadedDocWriterVer() { return _loadedDocWriterVer; },
  get loadedDocNewerConfirmed() { return _loadedDocNewerConfirmed; },
  get dirty() { return es ? es.isDirty() : false; },            // 内存脏（save-status 徽章用）
  markEdited() { if (es) es.markDirty(); },                     // app 驱动内容变化（导入/blender/参考窗）→ 标脏
  setName, restore: restoreSession, saveAs,
  save: saveNow, saveAndPush, adopt: adoptLoadedDoc, adoptWithOpts: adoptLoadedDocWithOpts,
  rename: renameCurrentSession, exit: exitCanvasToGallery, newDoc, pull: pullCloudPath, open: openItem, push: pushItem, unload: unloadItem,
  encodeOra: _encodeCurrentOra, buildOraMeta: _buildOraMeta,
  writeCheckpoint: _writeSessionCheckpoint, readCheckpoint: _readSessionCheckpoint,
  awaitCloudPushIdle: async () => { /* 薄库 push 内联 await，无独立在飞态 */ },
  markOpenedNow() { _sessionOpenedAt = Date.now(); },
  markNewerConfirmed() { _loadedDocNewerConfirmed = true; },
  markSavedNow() { _docLastSavedAt = Date.now(); },
  resetSavedAt() { _docLastSavedAt = 0; },
};

export function initSession(ctx: AppContext) {
  state = ctx.state; doc = ctx.doc; board = ctx.board; input = ctx.input;
  editMode = ctx.editMode; rack = ctx.rack;
  referenceWindow = ctx.referenceWindow; paletteWindow = ctx.paletteWindow;
  setStatus = ctx.setStatus; withBusy = ctx.withBusy;
  updateSaveStatus = ctx.updateSaveStatus; updateNewerBanner = ctx.updateNewerBanner;
  setColor = ctx.setColor; applyCheckerboard = ctx.applyCheckerboard; renderLayersPanel = ctx.renderLayersPanel;
  setGalleryOpen = ctx.setGalleryOpen;
  checkQuotaAndWarn = ctx.checkQuotaAndWarn; uniqueLocalName = ctx.uniqueLocalName;
  showFullscreenBusy = ctx.showFullscreenBusy; hideFullscreenBusy = ctx.hideFullscreenBusy;
  gallery = ctx.gallery;

  // ora editor 适配器 + editor-session（生命周期编排全塌进这里）。
  es = createEditorSession({
    store: _store as unknown as StoreLike,   // 真 store 结构满足 StoreLike（file/reconcile 超集）；断言解耦

    editor: {
      adopt: async (bytes: Blob) => { const loaded = await decodeOraToDoc(bytes) as LoadedDoc; adoptModel(loaded); },
      encode: async () => ({ bytes: await _encodeCurrentOra(), peek: await renderThumbBlob(doc, 256) }),
      // ⚠ wp:histchange 在 **window** 上 dispatch（history.ts）——绑 document 收不到 → 打开的文档编辑永不标脏、
      //   保存静默 no-op、编辑丢失（2026-07-12 真机抓到的数据丢失根因；其余监听者都用 window）。
      onChange: (cb: () => void) => { window.addEventListener("wp:histchange", () => { if (!_loadingDoc) cb(); }); },
    },
    isZip: true,
    policy: { autosaveMs: AUTOSAVE_MS, pushOn: ["exit"] },
  });
  es.start();   // autosave 3min（只本地）+ visibility/pagehide flush（内部按 policy）

  _recomputePhase();
  resetEditorState();
}

export function setSessionGallery(g: AppContext["gallery"]) { gallery = g; }
