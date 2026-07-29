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
import { reportError } from "./error-badge.ts";
import { thumbBlobFromCanvas, setCurrentSessionName } from "./session.ts";
import { renderNodesToCanvas } from "./doc-render.ts";
import { encodeDocToOra, decodeOraToDoc, parseAppVersion } from "./ora.ts";
import { freezeDocForEncode } from "./doc.ts";
import { PaintDoc } from "./doc.ts";
import type { Layer } from "./doc.ts";
import { isSignedIn, store as _store } from "./app-store.ts";
import type { EncryptedBlob } from "./store/index.ts";   // 密文 at-rest 字节（branded：明文流不进只收密文的 sink）
import { openInputSheet, openConfirmSheet, lockSyncGate } from "./sheets.ts";
import { pathFolder } from "./gallery-path.ts";
import { sessionFileName, sessionBareName } from "./config.ts";
import { serializedToolStatePatch, editorState } from "./workbench-state.ts";
import { getBlenderSyncState, applyBlenderSyncState } from "./blender-sync.ts";
import { ensureNewPassword, ensureUnlocked } from "./enc-thumbs.ts";
import { setPassword, getPassword } from "./crypto-state.ts";
import { shouldCapture, checkpointKey, type CheckpointTrigger } from "./checkpoint-policy.ts";
import { getCheckpoint, putCheckpoint, deleteCheckpoint } from "./storage.ts";
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
type LoadedDoc = PaintDoc & { _webpaintState?: OraWebpaintState; _editorState?: unknown; _referenceBlob?: Blob | null; _wroteWith?: string; };

// ---- ctx-bound 协作件（app 拥有，boot 时 initSession(ctx) 注入）----
let state: AppContext["state"], doc: AppContext["doc"], board: AppContext["board"];
let input: AppContext["input"], editMode: AppContext["editMode"], rack: AppContext["rack"];
let referenceWindow: AppContext["referenceWindow"], paletteWindow: AppContext["paletteWindow"];
let setStatus: AppContext["setStatus"], withBusy: AppContext["withBusy"];
let updateSaveStatus: AppContext["updateSaveStatus"], updateNewerBanner: AppContext["updateNewerBanner"];
let pullSettingsAndState: AppContext["pullSettingsAndState"];
let setColor: AppContext["setColor"], applyCheckerboard: AppContext["applyCheckerboard"], renderLayersPanel: AppContext["renderLayersPanel"];
let setGalleryOpen: AppContext["setGalleryOpen"];
let checkQuotaAndWarn: AppContext["checkQuotaAndWarn"];
let gallery: AppContext["gallery"];

// ---- session 拥有的 SSoT 状态 ----
let _activeSessionName: string | null = "未命名";   // 幽灵 path 保护：boot 成功/主动 open/new/save-as 才升级真名
let _isLazyBlankSession = false;
let _loadedDocIsNewer = false;
let _loadedDocWriterVer: string | null = null;
let _loadedDocNewerConfirmed = false;
let _loadingDoc = false;

const AUTOSAVE_IDLE_MS = 30_000;   // v0.4.11 用户拍板：停笔 30 秒即落盘（旧 3min 墙钟 gate 删——dirty 门已足够：存完即净，再编辑本身重置空闲时钟）

const _phase = reactive<{ current: "gallery" | "editing" | "lazyblank" }>({ current: "gallery" });
function _recomputePhase() { _phase.current = !_activeSessionName ? "gallery" : _isLazyBlankSession ? "lazyblank" : "editing"; }

const _enc = reactive<{ encrypted: boolean }>({ encrypted: false });
// 边界（薄库身份=全名）：app 内部 _activeSessionName 是**裸** session 名；跨到库/editor-session 前统一 sessionFileName
//   转全名（X→X.ora）。加密件 .zip 由库内部据字节态翻转，app 只传明文全名。OUT 侧（itemToG）用 stripSessionExt 还原。
const toFull = (name: string) => sessionFileName(name);
// **活动文档名的唯一写入口**（v437）。在这里归一化一次，之后全 app 的 `item.name === session.name`
//   比较就恒等可比 —— 而不是在五个比较点各自补 sessionFileName()（补漏一个就是一个 bug）。
//   为什么必须归一：store 那边的身份是 sessionBareName 之后的；app 若存用户敲进来的原始名，
//   `a:b` 与 `a_b` 会永久失配（详见 config.ts 的长注释）。
function _setActive(name: string | null): void {
  _activeSessionName = name == null ? null : sessionBareName(name);
  setCurrentSessionName(_activeSessionName ?? "");
}
const _file = (name: string) => _store.file(toFull(name), { isZip: true, mode: "existing" });   // WebPaint work-file = ora-zip 容器（有 peek）
async function _refreshEncrypted() {
  try { _enc.encrypted = _activeSessionName ? await _file(_activeSessionName).isEncrypted() : false; }
  catch { _enc.encrypted = false; }
}

// ============ 编辑器状态 I/O（v267b；app 编辑器概念，不动）============
function storeEditorStateToOra() {
  // ⚠**双轨**（诚实交代，别信"只留未迁字段"那种话）：checkerboard/viewport 确已迁走，但 color + toolStates
  //   **两处都写**——本函数写 webpaint/state.json，editorState.Serialize() 又写 .webpaint/editor-state.json。
  //   载入时 editorState 后手赢（restoreEditorStateFromOra 末尾 Unserialize）。
  //   为什么还不能删旧轨：ws.toolStates 覆盖**全部**工具（eraser/filterBrush 的 dial 只在这），而
  //   editorState.brushTool 只覆盖 brush 一个。要拆轨得先把 eraser/filterBrush dial 迁进 editorState（下一轮）。
  return {
    color: state.color, toolStates: state.toolStates,
    palette: paletteWindow.getSerializedState(),
    activeId: doc.activeId, activeLayerIndex: doc.activeIndex, blender: getBlenderSyncState(),
  };
}
function resetEditorState() {
  referenceWindow.clearBitmap(); referenceWindow.close?.();
  paletteWindow.clear?.(); paletteWindow.close?.();
  setColor("#000000"); applyCheckerboard(false); state.filterBrush = null; applyBlenderSyncState();
  editorState.reset();   // desk per-doc：开新文件/换画/卸载 → 重置 editorState struct（stage4）
}

// desk apply-on-load（stage5）：editorState.Unserialize/reset 后，把面板/视口等**回灌到 UI**。
//   各面板模块（color/layers/ref/blender panel）在 init 里监听 wp:applyEditorState，读 editorState.<panel>
//   开/关/定位自己（**只读 editorState + 裸 DOM 操作，不回写 editorState**）。
function applyEditorStateToUI(): void { window.dispatchEvent(new CustomEvent("wp:applyEditorState")); }
function restoreEditorStateFromOra(loaded: LoadedDoc) {
  const ws = loaded?._webpaintState;
  if (loaded?._referenceBlob) {
    // skipFit：ref 面板 open/位置/vp 由 editorState.refPanel 经 wp:applyEditorState 恢复；bitmap 异步载入不覆盖已载入 vp。
    createImageBitmap(loaded._referenceBlob).then((bitmap: ImageBitmap) => {
      referenceWindow.setBitmap(bitmap, { persistBlob: loaded._referenceBlob, skipFit: true });
    }).catch(() => {});
  }
  if (ws?.color) setColor(ws.color);
  if (ws?.palette) { try { paletteWindow.applySerializedState(ws.palette); } catch (_) {} }
  // 旧轨（webpaint/state.json）：灌**全部**工具的 dial（eraser/filterBrush 只在这一轨；见 storeEditorStateToOra 的双轨注）。
  const savedToolStates = (ws?.toolStates && typeof ws.toolStates === "object") ? ws.toolStates : null;
  if (savedToolStates) {
    for (const tk of Object.keys(state.toolStates)) {
      const patch = serializedToolStatePatch(state.toolStates[tk], savedToolStates[tk]);
      if (patch) Object.assign(state.toolStates[tk], patch);
    }
  }
  applyBlenderSyncState(ws?.blender);   // checkboard 已迁 editorState → 经 wp:applyEditorState 应用（settings-menu 订阅）
  if (ws?.activeId != null && doc.setActiveById(ws.activeId)) renderLayersPanel();
  else if (typeof ws?.activeLayerIndex === "number" && doc.setActive(ws.activeLayerIndex)) renderLayersPanel();
  // 新轨（desk per-doc）：载入 .webpaint/editor-state.json（缺失=老画作 → resetEditorState 已回默认）。
  //   **后手赢**：它会用 brushTool 覆盖 toolStates.brush + color。
  if (loaded._editorState != null) editorState.Unserialize(loaded._editorState);
  // ⚠ applyToolState 必须排在 **Unserialize 之后**（v409 修）：它按 toolStates 的 activeBrushId 应用笔架，
  //   而新轨刚覆盖过那个值。v407-v408 把它放在 Unserialize 之前 —— 只因两轨由同一次 _buildOraMeta 同刻写出、
  //   值必然相同才没暴露，是"靠巧合正确"。任一轨的兼容映射漂移（serializedToolStatePatch 的 v98 逻辑只作用于
  //   旧轨）就会让笔架和 dial 不一致，且无任何报错。
  if (savedToolStates || loaded._editorState != null) rack.applyToolState(editMode.current());
}
function _buildOraMeta() {
  // 存前把运行时 board 视口 + checkboard 观感开关镜像进 editorState（**不标脏**，见 syncRuntimeForSave 注）。
  editorState.syncRuntimeForSave(
    { tx: board.viewport.tx, ty: board.viewport.ty, scale: board.viewport.scale, rot: board.viewport.rot },
    state.checkerboard,
  );
  return { referenceImage: referenceWindow.getPersistBlob(), webpaintState: storeEditorStateToOra(), editorState: editorState.Serialize() };
}
// S8（spec:41 存档一致性）：encode 前**同步**冻结 {结构 + 每叶 tile 快照}（零拷贝），bytes 与 peek
//   读同一冻结视图 → encode 的 await 间隙里任何编辑（描边 commit / 层结构操作）都不撕存档，
//   且不阻塞用户（tile 不可变 ⇒ 后续编辑全是 CoW 新 tile）。达意实现 spec「保存阻塞锁写不锁读」，
//   比字面锁更强——待追认（S8 报告拍板清单）。
async function _encodeCurrentOraWithPeek(): Promise<{ bytes: Blob; peek: Blob | null }> {
  // merged（GL 合成）与 freeze 在**同一同步刻**取自活 doc → mergedimage/缩略图/层数据三者一致。
  //   GL 不可用（context lost 中的 autosave）→ merged=null：ora 用透明占位、peek 省略——层数据照常落盘。
  const merged = renderNodesToCanvas(doc.layers, doc.width, doc.height);
  const { frozen, dispose } = freezeDocForEncode(doc as Parameters<typeof freezeDocForEncode>[0]);
  try {
    const meta = _buildOraMeta() as Record<string, unknown>;
    const bytes = await encodeDocToOra(frozen, { ...meta, mergedCanvas: merged } as Parameters<typeof encodeDocToOra>[1]) as Blob;   // v0.6.44：unsafe cast 删（EncodeDoc 已兼收冻结视图）
    const peek = merged ? await thumbBlobFromCanvas(merged, 256) : null;
    return { bytes, peek };
  } finally { dispose(); }
}

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
    const vp = editorState.viewport;   // 视口从 editorState（.webpaint/editor-state.json）回灌 board
    // #27：必须经 setViewport（scale 夹取 + _clampPan），不许 Object.assign 裸灌——大屏存的
    // viewport 换小屏/旋转后画布整体落屏外，且交互 pan 夹取之外没有任何路径能把它拉回。
    if (vp && typeof vp.scale === "number") {
      board.setViewport(vp.tx ?? 0, vp.ty ?? 0, vp.scale, typeof vp.rot === "number" ? vp.rot : undefined);
      board.invalidateAll();
    } else {
      // #26：没存过视口（新建 / 新设备首开）→ fit 到合适倍率（小画布 snap 整数倍），
      //   而不是沿用上一幅画留下的视口。
      board.fitToScreen();
    }
    applyEditorStateToUI();   // desk：Unserialize 后把面板/checkboard 回灌 UI（各模块订阅 wp:applyEditorState）
  } finally { _loadingDoc = false; }
}

// ── adopt 的两个意图，显式拆开（v415）────────────────────────────────────────────────────
// 以前只有一个 adoptLoadedDoc + 一个**被完全忽略**的 opts（adoptLoadedDocWithOpts 的 _opts 没人读），
// 两个语义相反的调用方共用它：
//   · 外部 import 一个 .ora  = **新身份**，首存必须 mode:"new"（撞名不覆盖）
//   · revert 回滚            = **既有身份**，首存 mode:"existing"（就是要写回原文件）
// 结果 import 走了 existing → **导入同名 .ora 会静默覆盖已有作品**（活的数据丢失）。
// 拆成两个函数后，意图写在名字里，调用方不可能选错。

/** 外部导入：装入一个解好的 doc，作为**新身份**。首存 mode:"new"（撞名抛，不静默覆盖）。 */
function adoptAsNew(loaded: LoadedDoc, name: string) {
  _adoptCommon(loaded, name, { create: true });
  // ⚠ 这里**刻意不封 checkpoint**：此刻这个新身份在磁盘上还没有任何字节
  //   （es.adopted 只是标脏，首存要等 autosave / Ctrl+S / 退出），
  //   _captureCheckpoint 取 at-rest 字节会拿到 null 而静默跳过 —— 那是个恒 no-op 的假动作。
  //   导入件的快照在它下一次从图库被打开时封（那时字节已在）。要改成"导入即封"得先 await 一次保存，
  //   属于行为变更，攒着 escalate，不在清理批里夹带。
}
/** revert 回滚：装入一个解好的 doc，身份**不变**（首存 mode:"existing"，就是要写回原文件）。
 *  **不封存 checkpoint** —— 否则刚回滚掉的状态立刻把快照覆盖了，只能 revert 一次。 */
function adoptAsExisting(loaded: LoadedDoc, name: string) {
  _adoptCommon(loaded, name, {});
}
function _adoptCommon(loaded: LoadedDoc, name: string, opts: { create?: boolean }) {
  adoptModel(loaded);
  _setActive(name); _isLazyBlankSession = false; _recomputePhase();
  es.adopted(toFull(name), opts);
  updateSaveStatus(); _refreshEncrypted();
}

// ---- checkpoint / revert（v415 重接；prod 有、dev 在 store cutover 删 _store.seal 后成了 stub）----
// 落盘 = app 自己的 webpaint 库的 checkpoints store；策略（key/何时封/加密怎么办）在纯模块 checkpoint-policy.ts。
/** 封存「本次打开这幅画」的快照。fire-and-forget：**绝不阻塞开画**，失败只 log。
 *  加密作品存**密文容器**字节（getEncryptedBlob）——绝不退化成 encodeDocToOra 的明文（红线）。 */
async function _captureCheckpoint(name: string, trigger: CheckpointTrigger) {
  if (!shouldCapture(trigger)) return;
  try {
    const full = toFull(name);
    const f = _file(name);
    const cipher = await f.getEncryptedBlob();          // 加密件 → at-rest 密文；明文件 → null
    const bytes: Blob | null = cipher ?? await f.open();   // 明文件取当前 at-rest 明文字节
    if (!bytes) return;                                 // 没字节可封（纯云端未缓存 / 锁定）→ 静默跳过
    await putCheckpoint(checkpointKey(full), { name: full, slot: 0, at: Date.now(), bytes, encrypted: cipher != null });
  } catch (e) { reportError(new Error("[checkpoint] 封存失败（不影响打开）: " + String(e)), "log"); }
}
/** 读回快照。加密的先解壳（内存密码；锁定/错密码 → null 由调用方提示要密码）。 */
async function _readSessionCheckpoint(name: string): Promise<{ blob: Blob; at: number } | null> {
  try {
    const rec = await getCheckpoint(checkpointKey(toFull(name)));
    if (!rec || !rec.bytes) return null;
    if (!rec.encrypted) return { blob: rec.bytes, at: rec.at };
    const pw = getPassword(name);
    if (!pw) return null;                                // 锁定 → 调用方提示「需要密码」
    const plain = await _store.encryption.tryDecryptEncryptedBlob(rec.bytes, pw);
    return plain ? { blob: plain, at: rec.at } : null;
  } catch (e) { reportError(new Error("[checkpoint] 读取失败: " + String(e)), "log"); return null; }
}
/** 作品被删/改名 → 丢掉它的快照（按 key 精确清，**不做全库扫描**）。 */
async function _dropCheckpoint(name: string) {
  try { await deleteCheckpoint(checkpointKey(toFull(name))); } catch (e) { reportError(new Error("[checkpoint] 清理失败: " + String(e)), "log"); }
}

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
                             // desk 不进 need：内容脏时顺手被 _buildOraMeta 捞走，不自己驱动落盘（v409）
    setStatus(t("ss.saved", { name: _activeSessionName ?? "" }));
    checkQuotaAndWarn();
  } catch (e) { reportError(new Error("[session] save failed: " + String(e)), "log"); setStatus(t("ss.saveFailed", { error: errMsg(e) })); }
  finally { updateSaveStatus(); }
}

// ---- 保存 + 推云（consent push）----
// v0.5.9（user）：保存/推送在飞标志——纯 app 层内存态，不碰 store 契约。
//   没有它，保存瞬间 dirty 已翻 false、pushPending 还挂着 → 徽章闪「问号虚云」（unpushed 终态），语义不对。
let _pushInFlight = false;
async function saveAndPush() {
  if (!_activeSessionName) { setStatus(t("ss.noDocCannotSave"), true); return; }
  // 版本降级守卫：新版本文档未确认 → 只本地不推（saveNow 的 confirm 已挡本地覆盖，这里挡推）。
  if (_loadedDocIsNewer && !_loadedDocNewerConfirmed) {
    await saveNow();
    if (!_loadedDocNewerConfirmed) { setStatus(t("ss.notPushedNewer"), true); return; }
  }
  const name = _activeSessionName;
  _pushInFlight = true;
  updateSaveStatus();
  try {
    // v409：用户**显式**按 save → forceSaveAndPush 无条件 encode+推，不脏也动。
    //   理由（user 2026-07-14）：「至少可以改时间戳，不然用户点了 save 看到时间戳没动会觉得坏了」。
    //   顺带把当前 desk 捞进 ora（_buildOraMeta → syncRuntimeForSave + Serialize）。
    //   冲突/错误经 store 的 ui bundle surface。
    await es.forceSaveAndPush();
    // 别无条件报「已同步」：push 失败在 store 内部被 catch 成 banner，这里**不会**抛。
    //   唯一可靠的判据是 es.isPushPending()（v433）——它是 save() 返回的 pushed 一路带上来的。
    setStatus(!isSignedIn() ? t("ss.savedLocalIdb", { name })
      : es.isPushPending() ? t("ss.savedNotPushed", { name })
      : t("ss.synced", { name }));
    gallery.refresh();
  } catch (e) { reportError(new Error("[cloud] push failed: " + String(e)), "log"); setStatus(t("ss.pushFailed", { error: errMsg(e) })); }
  finally { _pushInFlight = false; updateSaveStatus(); }
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
      gallery?.invalidateEncrypted?.(_activeSessionName!);   // #11：清图库锁态缓存（refresh 不清，probe 有缓存守卫）
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
      gallery?.invalidateEncrypted?.(_activeSessionName!);   // #11：解除加密后小锁图标不清的病根——缓存守卫跳过已探项
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
        // 改名 = 换身份 → 旧 key 的快照丢掉（不搬：搬要连密文一起复制，而"改名丢一次快照"是诚实的小代价）。
        void _dropCheckpoint(oldName);
        _setActive(trimmed); _recomputePhase();
        updateSaveStatus();
        // 别再无条件报「已重命名（含云端）」：store 现在会透出旧名到底怎么了。
        //   oldKept   谱系不明 → 改名降级为「另存」，云端旧名**原地留着** → 必须说清楚，否则用户以为旧的没了
        //   cloudDeferred 云端没推成 → 新名只在本地
        //   oldCloudOrphan 旧名进回收站失败 → 云端留了个孤儿
        if (r.cloudDeferred) setStatus(t("ss.renamedLocalOnly", { oldName, newName: trimmed }), true);
        else if (r.oldKept) setStatus(t("ss.renamedOldKept", { oldName, newName: trimmed }), true);
        else if (r.oldUnknown) setStatus(t("ss.renamedOldUnknown", { oldName, newName: trimmed }), true);
        else if (r.oldCloudOrphan) setStatus(t("ss.renamedOldOrphan", { oldName, newName: trimmed }), true);
        else setStatus(t("ss.renamedWithCloud", { oldName, newName: trimmed }));
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
    // v409（D-Q6）：退出**只有内容脏/push-pending 才推**；只改 desk（无像素编辑）→ 不推不落本地，
    //   下次开 revert 到上次保存的快照。user 2026-07-14：「退出应该只有 contentdirty 才强制推云，workspace dirty 可抛」。
    await withBusy(t("ss.savingBusy", { name: _activeSessionName ?? "" }), async () => {
      try { await es.flushAndPush(); } catch (e) { reportError(new Error("[exit] save failed: " + String(e)), "log"); }
    });
    // 内存脏没落成（保存失败/取消）→ 显式问重试/丢弃，绝不无条件宣布干净（K2 红线）。
    while (es.isDirty() && !_docIsBlankUnnamed()) {
      const choice = await lockSyncGate({
        title: t("ss.localSaveIncompleteTitle"), message: t("ss.localSaveIncompleteMsg", { name: _activeSessionName ?? "" }), showSpinner: false,
        actions: [{ label: t("ss.retrySave"), value: "retry", primary: true }, { label: t("ss.exitDiscard"), value: "discard" }],
      });
      if (choice !== "retry") break;
      await withBusy(t("ss.savingBusy", { name: _activeSessionName ?? "" }), async () => { try { await es.flushAndPush(); } catch (e) { reportError(new Error("[exit] retry failed: " + String(e)), "log"); } });
    }
    gallery.setFolder(pathFolder(_activeSessionName));
  }
  _setActive(null); _recomputePhase();
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
  _setActive(name); _recomputePhase();
  _enc.encrypted = false; input.clearHistory(); board.invalidateAll(); board.fitToScreen(); renderLayersPanel();
  resetEditorState();
  applyEditorStateToUI();   // desk：新建 → 面板回默认（关）
  es.adopted(toFull(name), { create: true });   // 新建画布/import：es 记为当前 + 脏；首存 mode:"new"（撞名不静默覆盖）。边界转全名。
  updateSaveStatus();
  await saveNow();   // 落盘（tryPush:false；撞名 → saveNow try/catch surface）
  void _captureCheckpoint(name, "new-doc");   // 空白态封一份 → revert = 回到刚新建的样子
  setGalleryOpen(false);
}

// pullCloudPath 已删（v415）：零调用者。打开云端项走 openItem —— es.open → store.file.open，
//   本地没有就自动拉云落本地，同一条路径同时覆盖本地项和纯云端项，不需要第二个平行入口。

// ---- 打开图库 item ----
async function openItem(item: GalleryItem) {
  if (item.name === _activeSessionName) { setGalleryOpen(false); return; }
  if (es.isDirty()) await saveNow();
  // 开画顺带把 4 个 settings/state collection 拉云对齐（v409，user 2026-07-14：「开画作的时候可以顺便
  //   并行 pullandreconcile 下，fire and forget 不用 await」）。**绝不 await**：对齐是锦上添花，
  //   不该让开画等网络（且离线/local-only 内部本就 no-op）。
  pullSettingsAndState();

  try {
    // 加密且未解锁 → 先在 busy 外解锁（file.open 内部 unseal 要密码在内存）。
    if (await _file(item.name).isEncrypted()) {
      if (!(await ensureUnlocked(item.name))) { setStatus(t("ss.notOpenedNeedPasswordCancelled"), true); return; }
    }
    // ★ 返回值**必须**看（v417 修，优先级 1 = OneDrive 不丢画）：false = 字节没装进来
    //   （离线纯云端 / 文件锁定 / 本地副本没了）。旧版把它扔了，于是画布上还是**上一张画**、身份却换成了
    //   新名字、状态栏还报「已打开」——下次 autosave 就把上一张画的像素写进新身份，退出时推上 OneDrive
    //   覆盖掉目标那张画。es.open 现在失败即不改自身 _name，这里也必须不改活动名、留在图库。
    if (!(await es.open(toFull(item.name)))) { setStatus(t("ss.openFailed", { error: t("mi.lastNotFound", { name: item.name }) }), true); return; }
    _setActive(item.name); _isLazyBlankSession = false; _recomputePhase(); _refreshEncrypted();
    void _captureCheckpoint(item.name, "gallery-open");
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
      // 这个按钮的**全部意义**就是云端那条腿 —— 必须读 pushed（v436）。
      //   以前丢掉 SaveResult：离线 / 冲突面取消 / deferred 一律照报「已推送」。
      const res = await f.save(bytes, { tryPush: true });
      setStatus(res.pushed ? t("ss.pushed", { name: item.name }) : t("ss.pushNotDone", { name: item.name }), !res.pushed);
      gallery.refresh();
    } catch (err) { setStatus(t("ss.pushFailed", { error: errMsg(err) })); }
  });
}

// ---- 卸载本地副本（offload：清 shadow；非法=唯一副本→store 抛 OffloadIllegalError→banner）----
async function unloadItem(item: GalleryItem) {
  const isActive = item.name === _activeSessionName;
  // ⚠ 顺序（v417 修）：**先退出画布（落盘+推云），再 offload**。反过来的后果是数据安全问题，不只是 badge 错：
  //   store 的 head dirty（head.isDirty，落盘才置）和 es 的**内容脏**（wp:histchange 驱动）是两个不同的东西
  //   —— 注意这里说的不是 desk/workspaceDirty，那个概念 v409 已撤销（editor-state.ts:117）。用户画了几笔但还没
  //   触发 autosave 时，head 仍是 clean —— offload 的「dirty 不驱逐」守卫看不见内存里的未保存编辑，于是
  //   一路放行把本地副本 hardDelete 掉。紧接着旧代码才调 exitCanvasToGallery，退出 flush 又把 doc 写回本地
  //   并 recordEdit 重新标脏；而 head.forget 刚清空谱系 → 这次 push 是 no-base → 409 → CloudNameCollisionError
  //   被 create-store 吞成 banner → dirty 永远清不掉 → item 钉死在「待推」而不是「云端 only」。
  //   先退出后 offload：head 此时才真实反映"还有没有未推字节"，守卫就能正常拦住（抛 OffloadIllegalError）。
  // ⚠ exitCanvasToGallery 必须在 withBusy **之外**调：它内部可能弹「重试/丢弃」sheet，而交互输入永不在 busy 内。
  if (isActive) await exitCanvasToGallery();
  await withBusy(t("ss.unloadingBusy", { name: item.name }), async () => {
    try {
      await _file(item.name).offload();
      setStatus(t("ss.unloaded", { name: item.name }));
      gallery.refresh();
    } catch (err) { setStatus(t("ss.unloadFailed", { error: errMsg(err) })); }
  });
}

// boot：按名恢复上次 doc（file.open 内含本地/云端 + freshness + unseal）。返回是否成功装入。
async function restoreSession(name: string): Promise<boolean> {
  // 开画顺带把 4 个 settings/state collection 拉云对齐（v409，user 2026-07-14：「开画作的时候可以顺便
  //   并行 pullandreconcile 下，fire and forget 不用 await」）。**绝不 await**：对齐是锦上添花，
  //   不该让开画等网络（且离线/local-only 内部本就 no-op）。
  pullSettingsAndState();
  try {
    // 加密件的冷启动/tab 重开契约（v415 核对确认现状即正确，勿"优化"掉）：
    //   ① 先问密码（ensureUnlocked 在 busy 外弹，验的是 peek，便宜）；
    //   ② 取消 → 直接 return false，**在 es.open 之前**——所以这张画从头到尾没被装入编辑器：
    //      es 无 doc ⇒ session.dirty=false ⇒ 随后 boot 的 setGalleryOpen(true) 里那句
    //      `if (session.dirty) await session.save()` 不会触发 ⇒ **退出时不推**（不会拿空/旧状态盖云端）；
    //   ③ boot 收到 false 只把**内存**名降回 null，持久的 currentFile 有意保留（防幻影路径 +
    //      取消密码常是瞬态的，清了下次冷启动就再也不自动开这张画）——见 boot.ts。
    //   store 侧的两半已有 node 覆盖（seal.test.ts：无密码写抛 LOCKED 绝不静默存明文；锁定读返 null）。
    if (await _file(name).isEncrypted()) { if (!(await ensureUnlocked(name))) return false; }
    if (!(await es.open(toFull(name)))) return false;   // 文件缺失/锁定 → 未装入。边界转全名。
    _setActive(name); _isLazyBlankSession = false; _recomputePhase(); _refreshEncrypted();
    updateSaveStatus();
    return true;
  } catch (e) { reportError(new Error("[session] restore failed: " + String(e)), "log"); return false; }
}

// 另存为：当前内容写新身份（旧的不动）+ 切到新名继续编辑。
async function saveAs(newName: string): Promise<void> {
  const { bytes, peek } = await _encodeCurrentOraWithPeek();
  // 另存为=写**新身份** → mode:"new"（撞名不静默覆盖；topbar 已 nameOccupied 预检，这里 store 层再兜底红线）。
  await _store.file(toFull(newName), { isZip: true, mode: "new" }).save(bytes, { tryPush: true, hint: peek ? { peek } : undefined });
  _setActive(newName); _isLazyBlankSession = false; _recomputePhase();
  es.adopted(toFull(newName));   // es 切到新名（内容即新名的；下轮 autosave 若跑=同内容 re-save，无害）。边界转全名。
  void _captureCheckpoint(newName, "save-as");   // 新身份的「打开态」= 此刻
  updateSaveStatus(); gallery.refresh();
}

// setName(name)：改活动身份（内存 + 持久 appState.currentFile 两轨齐动）。
// setName(name, { persist: false })：**只动内存**——给 boot 加载失败用。
//   幽灵 path 纪律（feedback-phantom-current-path）：加载失败要把内存名降回 safe default（防 save 走 rename
//   路径把"加载失败的 path"当 oldName 删掉），但**持久的 currentFile 必须留着**，好让用户下次冷启动重试。
//   失败不只是"文件真没了"：加密画取消密码框 / 离线只有云端副本 都会返 false。清了它们就再也不自动开了。
function setName(name: string | null, opts: { persist?: boolean } = {}) {
  // 同样归一化（v437）：这条路是 gallery 移动文件后同步活动名的，不归一就会把用户敲的
  //   原始名塞回来，重新制造 `item.name === session.name` 的失配。
  _activeSessionName = name == null ? null : sessionBareName(name);
  if (opts.persist !== false) setCurrentSessionName(_activeSessionName as string);
  _recomputePhase();
}

// ---- 公开 session 对象（app.js 兼容面）----
export const session = {
  enc: _enc,
  encryptCurrent, decryptCurrent,
  get name() { return _activeSessionName; },
  get loadingDoc() { return _loadingDoc; },
  get loadedDocIsNewer() { return _loadedDocIsNewer; },
  get loadedDocNewerConfirmed() { return _loadedDocNewerConfirmed; },
  get dirty() { return es ? es.isDirty() : false; },            // 内存脏（save-status 徽章用）
  get pushPending() { return es ? es.isPushPending() : false; },   // 已落本地但没上云（徽章第四态；与 dirty 正交）
  get saving() { return _pushInFlight; },   // v0.5.9：saveAndPush 在飞（app 层过程态，徽章显转圈云）
  markEdited() { if (es) es.markDirty(); },                     // app 驱动内容变化（导入/blender/参考窗）→ 标脏
  setName, restore: restoreSession, saveAs,
  save: saveNow, saveAndPush,
  // adopt 的两个意图显式分开（别再合成一个带 flag 的）：import=新身份 / revert=既有身份。
  adoptAsNew, adoptAsExisting,
  rename: renameCurrentSession, exit: exitCanvasToGallery, newDoc, open: openItem, push: pushItem, unload: unloadItem,
  /** 当前作品的 at-rest **密文**字节（原样，不解壳、不要密码）。非加密件 → null。
   *  先 saveNow()：at-rest 字节是「上次保存」的内容，不先落盘就会导出成旧版本。 */
  async readEncryptedBytes(): Promise<EncryptedBlob | null> {
    if (!_activeSessionName) return null;
    await saveNow();                              // 未保存编辑先落盘（seal 会在写入前包壳 → 落地即密文）
    return await _file(_activeSessionName).getEncryptedBlob();
  },
  readCheckpoint: _readSessionCheckpoint, dropCheckpoint: _dropCheckpoint,
  // （v415 删掉一批零读者的 facade 条目：current/lazyBlank/docLastSavedAt/sessionOpenedAt/
  //   loadedDocWriterVer/refreshEncrypted/encodeOra/buildOraMeta/markOpenedNow/markNewerConfirmed/
  //   markSavedNow/resetSavedAt。背后的私有实现该活的都还活着，只是不再从这个门面漏出去。）
  awaitCloudPushIdle: async () => { /* 薄库 push 内联 await，无独立在飞态 */ },
};

export function initSession(ctx: AppContext) {
  state = ctx.state; doc = ctx.doc; board = ctx.board; input = ctx.input;
  editMode = ctx.editMode; rack = ctx.rack;
  referenceWindow = ctx.referenceWindow; paletteWindow = ctx.paletteWindow;
  setStatus = ctx.setStatus; withBusy = ctx.withBusy;
  updateSaveStatus = ctx.updateSaveStatus; updateNewerBanner = ctx.updateNewerBanner;
  pullSettingsAndState = ctx.pullSettingsAndState;
  setColor = ctx.setColor; applyCheckerboard = ctx.applyCheckerboard; renderLayersPanel = ctx.renderLayersPanel;
  setGalleryOpen = ctx.setGalleryOpen;
  checkQuotaAndWarn = ctx.checkQuotaAndWarn;
  gallery = ctx.gallery;

  // ora editor 适配器 + editor-session（生命周期编排全塌进这里）。
  es = createEditorSession({
    store: _store as unknown as StoreLike,   // 真 store 结构满足 StoreLike（file/reconcile 超集）；断言解耦

    editor: {
      adopt: async (bytes: Blob) => { const loaded = await decodeOraToDoc(bytes) as LoadedDoc; adoptModel(loaded); },
      encode: async () => await _encodeCurrentOraWithPeek(),
      // ⚠ wp:histchange 在 **window** 上 dispatch（history.ts）——绑 document 收不到 → 打开的文档编辑永不标脏、
      //   保存静默 no-op、编辑丢失（2026-07-12 真机抓到的数据丢失根因；其余监听者都用 window）。
      onChange: (cb: () => void) => { window.addEventListener("wp:histchange", () => { if (!_loadingDoc) cb(); }); },
    },
    isZip: true,
    policy: { autosaveMs: 0, pushOn: ["exit"] },   // S8：interval autosave 退役，改挂 bg-jobs（下方）
  });
  es.start();   // visibility/pagehide/blur 抢救 flush（崩溃安全直调，不受空闲节流）
  // S8/v0.4.11：autosave 挂 background-sync-jobs（minIdleMs=30s：停笔 30 秒才落盘，输入插队自动让路，
  //   不在描边中途 encode）。dirty 门足够防重复（flushLocal 后即净；encode 中的重入由 es._saving 挡）。
  //   encode 内部有冻结快照 → 即使 flushLocal 的 await 期间用户开画，存档也一致。
  //   v0.5.11（user pin）：操作做到一半（笔画/浮层变换/transient/fill 预览）时 autosave 让路——
  //   bgJobs 每轮重排队 = 天然 defer，谓词翻 false 后下个空闲窗自动补上。saveNow 的显式路径
  //   有自己的 hasPendingTransient 门（:284），此处是 idle 路径的对应门。crash-safety flush 不受此门。
  ctx.bgJobs.register("autosave", 5, () => {
    if (es.isDirty() && !ctx.isMidOperation()) void es.flushLocal();
    return "done";
  }, { minIdleMs: AUTOSAVE_IDLE_MS });
  // （v409：无 desk 改动桥 —— desk 不标脏、不驱动落盘，只在顺路 encode 时被 _buildOraMeta 捞走。详 editor-state.ts ⚠）

  _recomputePhase();
  resetEditorState();
}

export function setSessionGallery(g: AppContext["gallery"]) { gallery = g; }
