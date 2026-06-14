// Session —— 活动文档（active-document）的生命周期编排。**store-orchestration zone**。
//
// 这是从 app.js god-file 切出来的「当前打开的是哪张画、怎么存它/换它/退它」那一轴。
// **红线（CRITICAL）**：本模块只 RELOCATE 编排，**绝不**改任何 store.* / _store.flow.* /
//   _store.session.* / _store.autosave.* / _store.edit* / store.cloud.* 调用（参数/顺序/语义全保原样）。
//   同步机制（push-vs-pull / If-Match / parentBase / 备份先于覆盖 / coalescer）全在 Store 库内 enforce，
//   Session 只是把「何时调哪条 flow + 之后刷哪块 UI」从 app.js 搬过来。要改 store 行为 → STOP，escalate。
//
// 拥有（SSoT）：
//   - 中央指针 `_activeSessionName`（活动 item 名；null = 在图库没绑画）+ 镜像 localStorage（setCurrentSessionName）
//   - lazy-blank flag `_isLazyBlankSession`
//   - 落盘/打开时刻 `_docLastSavedAt` / `_sessionOpenedAt`（save 图标 / revert 用）
//   - newer-doc 降级守卫 `_loadedDocIsNewer` / `_loadedDocWriterVer` / `_loadedDocNewerConfirmed`
//   - adopt 期间 dirty 抑制 `_loadingDoc` + adopt opts 传递 `_adoptLoadedOpts`
//
// 编排方法（均从 app.js verbatim 搬来）：save / saveAndPush / adopt / adoptWithOpts / rename / exit /
//   newDoc / pull / push / unload / open / setName，外加 ora-meta/checkpoint 私有件（共用一处形状，drift 源）。
//
// 留在 app.js（经 ctx 绑入或 session 直调）：encode/decode（ora.js）、referenceWindow/paletteWindow、
//   setColor/applyCheckerboard、updateSaveStatus/updateNewerBanner、withBusy/setStatus、setGalleryOpen、
//   gateCloudSyncOnOpen（云端 freshness gate 留 app）、checkQuotaAndWarn、gallery handle。
//
// 给下一个 AI：ctx-bind 模式同 color-panel/layers-panel（全局 rt 已被显式 ctx 取代）。`current` 反应式相位
//   （gallery|editing|lazyblank）从 activeSessionName + lazy flag 派生，UI 想看相位就读它；`name` getter = 旧
//   _activeSessionName，给 app.js 的 ~30 处 read-site 兼容。

import { reactive } from "../vendor/vue/vue.esm-browser.prod.js";
import { WEBPAINT_VERSION } from "./version.js";
import {
  trashSession, renderThumbBlob,
  setCurrentSessionName,
} from "./session.js";
import { encodeDocToOra, decodeOraToDoc, parseAppVersion } from "./ora.js";
import { getMeta, setMeta } from "./storage.js";
import { PaintDoc } from "./doc.js";
import {
  isSignedIn, isCloudDirty, getKnownETag, clearCloudState,
  CloudConflictError, CloudNameCollisionError,
  store as _store,
} from "./app-store.js";
import { openInputSheet, openConfirmSheet, lockSyncGate } from "./sheets.ts";
import { pathFolder } from "./gallery-path.js";
import { stripSessionExt } from "./config.js";
import { sessionNameConflict } from "./session-name.ts";
import { serializedToolStatePatch } from "./editor-state.ts";   // 反序列化细节下沉（rec #5 part b）
import { ensureNewPassword, ensureUnlocked } from "./enc-thumbs.js";
import { setPassword } from "./crypto-state.js";
import { els } from "./els.ts";

// ---- ctx-bound 协作件（app 拥有，boot 时 initSession(ctx) 注入）----
let state: any, doc: any, board: any, input: any, editMode: any, rack: any;
let referenceWindow: any, paletteWindow: any;
let setStatus: any, withBusy: any, updateSaveStatus: any, updateNewerBanner: any;
let setColor: any, applyCheckerboard: any, renderLayersPanel: any;
let setGalleryOpen: any, gateCloudSyncOnOpen: any, checkQuotaAndWarn: any, uniqueLocalName: any;
let gallery: any;   // 晚绑（gallery 后建；通过 ctx.gallery 在 init 后回填）
let getLocalSavedAtLabel: any;   // app 的标签格式化（读 _docLastSavedAt → 经 getter）

// ---- session 拥有的 SSoT 状态 ----
// **幽灵 current path 保护**：内存里 _activeSessionName 只在 boot load 成功
// 或用户主动 open / new / save-as 后才升级到真实名字。boot 失败时保持
// safe default "未命名"，避免 save 走 rename-delete-old 路径误删。
let _activeSessionName: any = "未命名";
let _isLazyBlankSession = false;
let _docLastSavedAt = 0;
let _sessionOpenedAt = 0;
// 当前 doc 由比自己高的 WebPaint 版本写过 → 编辑保存有降级风险
let _loadedDocIsNewer = false;
let _loadedDocWriterVer: any = null;
let _loadedDocNewerConfirmed = false;   // user 已经确认过本 session 的降级风险
// _loadingDoc 在整个 adopt 期间挡掉 dirty 标记：保留 adopt 前的云端 dirty 真值（FF/pull=clean、本地脏画=仍脏）。
let _loadingDoc = false;
// adoptLoadedDoc opts 用全局传（绕开签名兼容）：调前 set，复位
let _adoptLoadedOpts: any = {};

const AUTOSAVE_MS = 3 * 60 * 1000;

// 反应式相位：UI 想知道「在图库 / 在编辑 / lazy 空白」读这个。从指针 + lazy flag 派生。
const _phase = reactive<{ current: "gallery" | "editing" | "lazyblank" }>({ current: "gallery" });
function _recomputePhase() {
  _phase.current = !_activeSessionName ? "gallery" : _isLazyBlankSession ? "lazyblank" : "editing";
}

// 当前画作是否加密（at-rest 字节判定，SSoT=store）。顶栏锁指示 + 菜单 label 反应式读它。
const _enc = reactive<{ encrypted: boolean }>({ encrypted: false });
async function _refreshEncrypted() {
  try { _enc.encrypted = _activeSessionName ? await _store.isEncrypted(_activeSessionName) : false; }
  catch { _enc.encrypted = false; }
}

// ============ 编辑器状态 I/O 深模块（v267b, user）============
// 编辑器「当前设成什么样」（小窗 / 主色 / per-tool dial / 棋盘 / 选中层）的存档 ↔ 内存三个统一入口。
// 进文件 / 新建 / 启动 init **一律**先 resetEditorState() 打回新文件基线，再（开文件时）
// restoreEditorStateFromOra() 反序列化恢复 —— 杜绝上一个 doc 的 RAM 态泄漏到下一个（如调色板内容、
// 参考图、棋盘）。存档统一走 storeEditorStateToOra()。
// 不含：doc 模型（layers/尺寸/选区/参考层 id 归 doc.adoptState）、viewport（设备本地态，不进 .ora）。

// ① 序列化：当前编辑器状态 → .ora webpaintState（_buildOraMeta / checkpoint / saveAndPush 共用）
function storeEditorStateToOra() {
  return {
    reference: referenceWindow.getSerializedState(),
    color: state.color,
    toolStates: state.toolStates,
    palette: paletteWindow.getSerializedState(),
    checkerboard: state.checkerboard,
    // 当前选中图层搭便车（dirty 上算 viewport 级——不单独触发存盘，随其它编辑落盘）。
    // 存 **index** 不存 id：Layer.id 是运行时计数器、不进 .ora，load 后层拿全新 id 按 id 恢复永远 miss；
    // 图层顺序在 .ora 里稳定 → index 才是可跨存档对齐的身份。
    activeLayerIndex: doc.activeIndex,
  };
}

// ② 重置：所有编辑器状态打回「新文件」基线（进文件 / 新建 / init 统一调）。
//    清小窗内容 + 收起、主色回默认、棋盘关、退 filterBrush 瞬态。dial(toolStates) 故意保留
//    （= 新文件也记住上次粗细/透，跨文件 dial 记忆是 feature）。
function resetEditorState() {
  referenceWindow.clearBitmap();
  referenceWindow.close?.();
  paletteWindow.clear?.();
  paletteWindow.close?.();
  setColor("#000000");          // gallery-first：默认黑
  applyCheckerboard(false);
  state.filterBrush = null;
}

// ③ 反序列化：把 .ora 的 _webpaintState 覆盖到已 reset 的基线之上（仅在开文件时调）。
function restoreEditorStateFromOra(loaded: any) {
  const ws = loaded?._webpaintState;
  // 参考图：先设 bitmap（异步），再套序列化的位置/变换
  if (loaded?._referenceBlob) {
    createImageBitmap(loaded._referenceBlob).then((bitmap: any) => {
      referenceWindow.setBitmap(bitmap, { persistBlob: loaded._referenceBlob });
      if (ws?.reference) referenceWindow.applySerializedState(ws.reference);
    }).catch(() => {});
  } else if (ws?.reference) {
    referenceWindow.applySerializedState(ws.reference);
  }
  if (ws?.color) setColor(ws.color);
  if (ws?.palette) { try { paletteWindow.applySerializedState(ws.palette); } catch (_) {} }
  if (ws?.toolStates && typeof ws.toolStates === "object") {
    // 反序列化细节（v98 兼容字段映射）下沉在 editor-state.serializedToolStatePatch；这里只编排循环。
    for (const t of Object.keys(state.toolStates)) {
      const patch = serializedToolStatePatch(state.toolStates[t], ws.toolStates[t]);
      if (patch) Object.assign(state.toolStates[t], patch);   // Object.assign 保留 reactive
    }
    rack.applyToolState(editMode.current());
  }
  applyCheckerboard(!!ws?.checkerboard);   // 缺省回 false（reset 已设，这里按文件值再覆盖）
  // 当前选中图层（越界静默忽略）；doc.layers 此时已由 adoptState 就位
  if (typeof ws?.activeLayerIndex === "number" && doc.setActive(ws.activeLayerIndex)) {
    renderLayersPanel();
  }
}

// ---- 私有：ora-meta + checkpoint（co-used，一处形状防 drift；从 app.js verbatim 搬）----
// 当前 doc 的标准持久化 meta（reference + webpaintState）。flow.encode 回调 / checkpoint / saveAndPush 共用。
// viewport（zoom/pan）是设备本地态，不进任何 .ora 字节（ADR-0016 §6）。
function _buildOraMeta() {
  return {
    referenceImage: referenceWindow.getPersistBlob(),
    webpaintState: storeEditorStateToOra(),
  };
}
function _encodeCurrentOra() { return encodeDocToOra(doc, _buildOraMeta()); }
async function _writeSessionCheckpoint(name: any) {
  if (!name) return;
  // checkpoint 是 app 自管的旁路存储 → 过 store.seal 按文件加密态包壳（加密作品的明文绝不落盘；
  //   明文作品原样通过）。seal 对加密文件要密码在内存——checkpoint 都写在 adopt/显式存时，密码必在。
  const blob = await _encodeCurrentOra();
  const sealed = await _store.seal(name, new Uint8Array(await blob.arrayBuffer()));
  await setMeta(`revert:${name}:ora`, new Blob([sealed as any], { type: "application/zip" }));
  await setMeta(`revert:${name}:at`, _sessionOpenedAt);
}
async function _readSessionCheckpoint(name: any) {
  const blob = await getMeta(`revert:${name}:ora`);
  const at = await getMeta(`revert:${name}:at`);
  return blob ? { blob, at: at || 0 } : null;
}

// ---- blank-unnamed 自检（verbatim）----
function _docIsBlankUnnamed() {
  if (_isLazyBlankSession) {
    for (const L of doc.layers) {
      if (L.bboxW > 0 && L.bboxH > 0) { _isLazyBlankSession = false; _recomputePhase(); return false; }
    }
    return true;
  }
  if (_activeSessionName && _activeSessionName !== "未命名") return false;
  for (const L of doc.layers) {
    if (L.bboxW > 0 && L.bboxH > 0) return false;   // 有像素 → 不算 blank
  }
  return true;
}

// ---- saveNow（仅 IDB；verbatim 从 app.js）----
async function saveNow(opts: any = {}) {
  if (_store.busy.saving()) return;
  if (!_activeSessionName) return;       // gallery-first: 在 gallery 没绑 session → 不保存
  if (_docIsBlankUnnamed()) return;
  if (editMode.hasPendingTransient()) {
    if (opts.implicit) return;             // 后台路径：保持 IDB 干净，等用户回来
    editMode.applyPendingTransient();           // 显式路径：先把变换 / 浮层等都 apply
  }
  // 文档来自更新版本 → 用户必须显式确认才能覆盖（每个 session 只问一次）
  // implicit 路径（autosave / visibility / pagehide）直接 skip 保存——防自动覆盖
  if (_loadedDocIsNewer && !_loadedDocNewerConfirmed) {
    if (opts.implicit) return;
    const ok = await openConfirmSheet(
      `覆盖更新版本写的画？`,
      `这画由 ${_loadedDocWriterVer} 写的，你是 ${WEBPAINT_VERSION}。` +
      `保存会丢失新版本特有的属性（如新图层 flag 等）。建议先刷新升级。`,
    );
    if (!ok) { setStatus("已取消保存"); return; }
    _loadedDocNewerConfirmed = true;
    updateNewerBanner();
  }
  _store.busy.set("saving", true);
  updateSaveStatus();
  try {
    // v235：本地落盘走 store.flow.save（encode 出明文，加密态由 store 自动包壳——明文绝不落盘）。
    // hint.thumb = 活 doc 现成渲的缩略图（省 adapter 一次全量解码；加密文件 adapter 会自己丢弃）。
    await _store.flow.save(_activeSessionName, {
      encode: () => _encodeCurrentOra(),
      hint: { thumb: await renderThumbBlob(doc, 256) },
    });
    _store.edits.markSaved();
    _docLastSavedAt = Date.now();
    setStatus(`已保存：${_activeSessionName}`);
    checkQuotaAndWarn();
  } catch (e: any) {
    console.warn("[session] save failed:", e);
    setStatus("保存失败：" + (e && e.message || e));
  } finally {
    _store.busy.set("saving", false);
    updateSaveStatus();
  }
}

// ---- adoptLoadedDoc（verbatim）----
function adoptLoadedDoc(loaded: any, sessionName: any) {
  _loadingDoc = true;
  try {
  // 模型层字段（layers/active/尺寸/背景/参考层id/清选区）归 doc.adoptState；
  // 下面全是 app 编排（UI 刷新 / 工具态 / 参考窗 / 视口 / store base / 版本检测 / checkpoint）。
  doc.adoptState(loaded);
  resetEditorState();   // v267b：进文件先打回新文件基线（清小窗/色/棋盘），再 restore 反序列化恢复
  els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
  input.clearHistory();
  board.invalidateAll();
  board.requestRender();
  renderLayersPanel();
  _activeSessionName = sessionName;
  setCurrentSessionName(sessionName);
  _recomputePhase();
  _refreshEncrypted();   // 顶栏锁指示按新打开的画刷新（不阻塞 adopt）
  // C4：捕获本 tab 的 base-etag（打开这画时的云端版本）进 Store 内存。
  // 之后 store.flow.push 用它当 If-Match，不读共享 localStorage → 杜绝多 tab 静默覆盖。
  _store.adoptBase(sessionName, getKnownETag(sessionName));
  _store.edits.markSaved();
  _docLastSavedAt = Date.now();
  _isLazyBlankSession = false;   // 加载了真实 session，不再 lazy
  updateSaveStatus();
  // 文档版本检测：写入这画时的 WebPaint 版本 > 当前 → 警告
  _loadedDocIsNewer = false;
  _loadedDocNewerConfirmed = false;
  const writerN = parseAppVersion(loaded._wroteWith);
  const selfN   = parseAppVersion(WEBPAINT_VERSION);
  if (writerN !== null && selfN !== null && writerN > selfN) {
    _loadedDocIsNewer = true;
    _loadedDocWriterVer = loaded._wroteWith;
    setStatus(
      `这画由 ${loaded._wroteWith} 写的，你是 ${WEBPAINT_VERSION} —— ` +
      `编辑保存会丢失新版特有的层属性。建议先刷新升级。`,
      true,
    );
  } else {
    _loadedDocWriterVer = null;
  }
  updateNewerBanner();
  // v267b：编辑器状态（参考窗 / 主色 / per-tool dial / 棋盘 / 选中层）反序列化恢复——
  //   统一走深模块（已先 resetEditorState 打回基线，这里覆盖恢复）。
  restoreEditorStateFromOra(loaded);
  // v126 per-doc viewport：有就 restore，没有的话 caller 会 fitToScreen
  const vp = loaded._webpaintState?.viewport;
  if (vp && typeof vp.scale === "number") {
    Object.assign(board.viewport, vp);
    board.invalidateAll();
    board.requestRender();
  }
  // v133 revert: session-open checkpoint。opts.skipCheckpoint = true 给 revert 路径用
  if (!_adoptLoadedOpts.skipCheckpoint) {
    _sessionOpenedAt = Date.now();
    _writeSessionCheckpoint(sessionName).catch((e) => console.warn("[revert] checkpoint 失败:", e));
  }
  } finally { _loadingDoc = false; }
}
function adoptLoadedDocWithOpts(loaded: any, name: any, opts: any) {
  _adoptLoadedOpts = opts || {};
  try { adoptLoadedDoc(loaded, name); }
  finally { _adoptLoadedOpts = {}; }
}

// ---- saveAndPush（verbatim；冲突 UI 留 app 编排，store flow 调用不动）----
async function saveAndPush() {
  if (_store.busy.saving()) return;
  if (_store.busy.pushing()) await _awaitCloudPushIdle();
  if (!_activeSessionName) { setStatus("没打开作品，无法保存", true); return; }
  if (_store.edits.localDirty()) await saveNow();
  // R3：「新版本文档」守卫必须也挡 push——saveNow 里用户点了取消只保住了本地；
  //   这里不复查的话 cloud-dirty 仍为真 → 降级字节照样推上云（覆盖的还是更权威的一端）。
  if (_loadedDocIsNewer && !_loadedDocNewerConfirmed && isCloudDirty(_activeSessionName)) {
    setStatus("未推送：这画由更新版本写成，你取消了覆盖（本地与云端都保持原样）", true);
    return;
  }
  if (_activeSessionName) {
    _sessionOpenedAt = Date.now();
    _writeSessionCheckpoint(_activeSessionName).catch((e) => console.warn("[revert] explicit save checkpoint:", e));
  }
  if (isSignedIn() && navigator.onLine === false && isCloudDirty(_activeSessionName)) {
    setStatus(`已存本地：${_activeSessionName}（离线，回到在线再 Ctrl+S 推云端）`);
    return;
  }
  if (!(isSignedIn() && isCloudDirty(_activeSessionName))) {
    if (!isSignedIn() && !_store.edits.localDirty()) setStatus(`已存本地：${_activeSessionName}（IDB 易失，登录云端更安全）`);
    return;
  }
  const sessionName = _activeSessionName;
  let conflictChoice = null;
  _store.busy.set("pushing", true);
  updateSaveStatus();
  try {
    const result = await _store.flow.push(sessionName, {
      encode: () => _encodeCurrentOra(),   // 同步字节不带 viewport（ADR-0016 §6）
      adopt: async (blob: any, nm: any) => { const loaded = await decodeOraToDoc(blob); adoptLoadedDoc(loaded, nm); },
      onConflict: async () => await lockSyncGate({
        title: "云端有更新版本",
        message: `「${sessionName}」云端已被改过；你本地是 ${getLocalSavedAtLabel()}。`,
        showSpinner: false,
        actions: [
          { label: "保留本地、暂不推（稍后再决定）", value: "no-op", primary: true },
          { label: "用云端覆盖本地（我的版本存进 .backup，可恢复）", value: "pull" },
          { label: "用本地覆盖云端（云端原版存进 .backup，可恢复）", value: "weak-override" },
        ],
      }),
    });
    if (result.status === "conflict") {
      conflictChoice = result.choice;                 // no-op（app 执行）
    } else if (result.status === "resolved" && result.resolution === "pull") {
      setStatus(`已采用云端版本：${sessionName}（你的版本存进本地 .backup，可恢复）`);
      gallery.refresh();
    } else if (result.status === "resolved" && result.resolution === "weak-override") {
      setStatus(`已用本地覆盖云端：${sessionName}（云端原版存进 .backup，可恢复）`);
      gallery.refresh();
    } else {
      setStatus(result.status === "healed"
        ? `已同步到云端：${sessionName}（云端本已是这份）`
        : `已同步到云端：${sessionName}`);
      gallery.refresh();
    }
  } catch (e: any) {
    console.warn("[cloud] store push failed:", e);
    if (e instanceof CloudNameCollisionError)
      setStatus(`云端已有同名「${sessionName}」（不同作品）——已留本地、未覆盖云端，改个名再推`, true);
    else setStatus("推送失败：" + (e && e.message || e));
  } finally {
    _store.busy.set("pushing", false);
    updateSaveStatus();
  }
  if (conflictChoice === "no-op") {
    setStatus(`已保留本地，云端未动；下次推会再确认（${sessionName}）`);
  }
}

// ---- 当前画作加密 / 解除（ADR-0012；编辑态对活动 doc 操作）----
// 与图库 intent 同 store operator，差别：先 saveNow flush 活 doc 的明文 → flow.encrypt 读它打包换两端。
// 活动 doc 内存态不动（at-rest 字节变容器，后续 save 自动包壳——透明）。需在线（有云副本时）。
async function encryptCurrent() {
  if (!_activeSessionName || _isLazyBlankSession) { setStatus("先打开或保存一张画再加密", true); return; }
  const online = () => isSignedIn() && navigator.onLine !== false;
  if (await _store.isEncrypted(_activeSessionName)) { setStatus("已是加密作品"); return; }
  const pw = await ensureNewPassword();
  if (pw == null) { setStatus("已取消"); return; }
  setPassword(pw);
  await withBusy(`正在加密 ${_activeSessionName}…`, async () => {
    try {
      await saveNow();   // flush 活 doc 明文 → store 读它打包
      const res: any = await _store.flow.encrypt(_activeSessionName, { isOnline: online });
      if (res.status === "offline") { setStatus("已同步过云端的作品需在线加密", true); return; }
      if (res.status === "already") { setStatus("已是加密作品"); return; }
      // 清明文残留（旧 checkpoint 明文快照）+ 重写成密文 checkpoint
      try { await setMeta(`revert:${_activeSessionName}:ora`, null); await setMeta(`revert:${_activeSessionName}:at`, null); } catch {}
      await _refreshEncrypted();
      updateSaveStatus();
      setStatus(res.status === "cloud-deferred"
        ? `已加密（本地完成；云端回线后推）：${_activeSessionName}`
        : `已加密：${_activeSessionName}（7-Zip 输此密码可恢复；忘记密码内容永久找不回）`,
        res.status === "cloud-deferred");
      gallery?.refresh?.();
    } catch (e: any) { setStatus("加密失败：" + (e && e.message || e), true); }
  });
}
async function decryptCurrent() {
  if (!_activeSessionName) { setStatus("没打开作品", true); return; }
  const online = () => isSignedIn() && navigator.onLine !== false;
  if (!(await _store.isEncrypted(_activeSessionName))) { setStatus("这不是加密作品"); return; }
  const ok = await openConfirmSheet("解除当前作品的加密？", "内容将以明文存放在本机与云端，任何能访问此设备或云账号的人都能查看。");
  if (!ok) return;
  // **必须在 withBusy 之前解锁**（密码框会被 busy 遮罩盖住→死锁；flow.decrypt 非交互拿不到密码会返 locked）
  if (!(await ensureUnlocked(_activeSessionName))) { setStatus("已取消（需要密码）", true); return; }
  await withBusy(`正在解除加密 ${_activeSessionName}…`, async () => {
    try {
      if (_store.edits.localDirty()) await saveNow();
      const res: any = await _store.flow.decrypt(_activeSessionName, { isOnline: online });
      if (res.status === "offline") { setStatus("已同步过云端的作品需在线解除加密", true); return; }
      if (res.status === "locked") { setStatus("已取消（需要密码）", true); return; }
      if (res.status === "not-encrypted") { setStatus("这不是加密作品"); return; }
      await _refreshEncrypted();
      updateSaveStatus();
      setStatus(`已解除加密：${_activeSessionName}`);
      gallery?.refresh?.();
    } catch (e: any) { setStatus("解除加密失败：" + (e && e.message || e), true); }
  });
}

// 等当前云端 push 跑完（防 status race）。L4 ②d：await store 的真信号 whenPushIdle。
// fullscreen-busy 是 app UI（showFullscreenBusy/hideFullscreenBusy 留 app，经 ctx 绑）。
let showFullscreenBusy: any, hideFullscreenBusy: any;
async function _awaitCloudPushIdle() {
  if (!_store.busy.pushing()) return;
  showFullscreenBusy("正在同步到云端…");
  try { await _store.busy.whenPushIdle(); } finally { hideFullscreenBusy(); }
}

// ---- renameCurrentSession（verbatim）----
async function renameCurrentSession({ suggested, reason }: any = {}) {
  editMode.applyPendingTransient();
  const oldName = _activeSessionName;
  let candidate = suggested || oldName;
  let note = "";   // v267：把上一轮的错误（重名/空名）写进重弹标题，保证用户看得到
  while (true) {
    const title = note ? `重命名（${note}）` : (reason ? `重命名（${reason}）` : "重命名当前画作");
    const input2 = await openInputSheet(title, candidate, { placeholder: "作品名字" });
    if (input2 === null) return null;
    const trimmed = input2.trim();
    if (!trimmed) { note = "名字不能空"; candidate = ""; continue; }
    if (trimmed === oldName) return oldName;       // 没改 = 等于成功
    // 锁屏从**确认即开始**，把冲突检查（await listSessions，可能慢）也包进来——否则确认到锁屏
    // 之间有空窗，用户以为「点了没反应、过一会才锁」。冲突 → 退出锁屏后重新弹名字（continue）。
    // 锁屏跑改名（编码 ora + 云端 move/push + 本地存+渲 thumb 都重），与 sibling 深模块 op 对齐；
    // store 现在内部也对 rename 强制 busy（可重入），这里外层 busy 只是为了覆盖冲突检查那段 await。
    const outcome: any = await withBusy(`正在重命名 ${oldName} → ${trimmed}…`, async () => {
      if (await sessionNameConflict(trimmed)) return { conflict: true };   // 本地查（共用 helper）；rename 不预检云端（store.flow.rename 管云端 move）
      try {
        const cloudOn = isSignedIn() && navigator.onLine !== false;
        const res = await _store.flow.rename(oldName, trimmed, {
          encode: () => _encodeCurrentOra(),
          cloud: cloudOn,
        });
        _activeSessionName = trimmed;
        setCurrentSessionName(trimmed);
        _recomputePhase();
        _store.edits.markSaved();
        _docLastSavedAt = Date.now();
        updateSaveStatus();
        if (!cloudOn) setStatus(`已重命名：${oldName} → ${trimmed}`);
        else if (res.cloudDeferred) setStatus(`已重命名（仅本地）：${oldName} → ${trimmed}（云端稍后 Ctrl+S 推）`);
        else setStatus(`已重命名（含云端）：${oldName} → ${trimmed}`);
        gallery.refresh();
        return { ok: true };
      } catch (e: any) {
        setStatus("重命名失败：" + (e && e.message || e));
        return { error: true };
      }
    });
    if (outcome.conflict) {
      setStatus(`本地已有同名 "${trimmed}"，换一个`, true);
      note = `已有同名 "${trimmed}"，换一个`;
      candidate = trimmed;
      continue;
    }
    return outcome.ok ? trimmed : null;
  }
}

// ---- _exitCanvasToGallery → exit()（verbatim）----
async function exitCanvasToGallery() {
  if (_activeSessionName) {
    await withBusy(`正在保存 ${_activeSessionName}…`, async () => {
      try { await saveAndPush(); } catch (e) { console.warn("[exit-to-gallery] save failed:", e); }
    });
    // K2（审计 2026-06-10）：本地落盘没成（保存失败 / 用户取消了新版本覆盖）时**不无条件宣布干净**——
    //   旧版照样 markSaved → dirty 被清、beforeunload 解除武装、开下一张画时内存编辑被覆盖，零追索。
    //   现在显式问：重试 / 仍要退出（丢弃）。只有用户亲口选丢才丢。
    while (_store.edits.localDirty() && !_docIsBlankUnnamed()) {
      const choice = await lockSyncGate({
        title: "本地保存未完成",
        message: `「${_activeSessionName}」的修改还没写进本地存储（保存失败或被取消）。直接退出会丢这些修改。`,
        showSpinner: false,
        actions: [
          { label: "重试保存", value: "retry", primary: true },
          { label: "仍要退出（丢弃本次修改）", value: "discard" },
        ],
      });
      if (choice !== "retry") break;
      await withBusy(`正在保存 ${_activeSessionName}…`, async () => {
        try { await saveAndPush(); } catch (e) { console.warn("[exit-to-gallery] retry failed:", e); }
      });
    }
    gallery.setFolder(pathFolder(_activeSessionName));
  }
  _activeSessionName = null;
  setCurrentSessionName("");
  _recomputePhase();
  _enc.encrypted = false;   // 回图库无活动画，清锁指示
  _store.edits.markSaved();
  _isLazyBlankSession = false;
  updateSaveStatus();
  await setGalleryOpen(true);
}

// ---- newDoc（从 newDocConfirm handler 的 doc-replacing 部分 verbatim 搬）----
// 尺寸/名字由 caller（app 的 newDoc sheet）算好后传入；session 负责 doc 替换 + 落盘 + 切指针。
// fillLayer0(layer)：可选，新 doc 建好后、渲染/fit/落盘前调，往 base layer 画内容（导入照片用）。
// 缺省 = 空白新建。照片导入经此共用骨架（消 survey rec #4 孪生），故同享全部重置（selection/参考窗/
// color 归黑/加密归明文/关图库）——human 定「导入照片完全对齐空白新建」。
async function newDoc({ name, w, h, fillLayer0 }: any) {
  if (_store.edits.localDirty()) await saveNow();
  const fresh = new PaintDoc({ width: w, height: h });
  doc.layers = fresh.layers;
  doc.activeIndex = 0;
  doc.width = w; doc.height = h;
  doc.selection = null;
  doc.referenceLayerId = null;
  els.canvasSizeLabel.textContent = `${w}×${h}`;
  if (fillLayer0) fillLayer0(doc.layers[0]);
  _activeSessionName = name;
  setCurrentSessionName(name);
  _recomputePhase();
  _enc.encrypted = false;   // 新建一律明文
  input.clearHistory();
  board.invalidateAll();
  board.fitToScreen();
  renderLayersPanel();
  _store.edits.mark();
  _docLastSavedAt = 0;
  updateSaveStatus();
  resetEditorState();   // v267b：新建 = 编辑器状态打回基线（清小窗/棋盘关/色归黑），与开文件同一入口
  await saveNow();
  _sessionOpenedAt = Date.now();
  _writeSessionCheckpoint(name).catch((e) => console.warn("[revert] new-doc checkpoint:", e));
  setGalleryOpen(false);
}

// ---- pull → pullCloudPath（verbatim；store.flow.acquire 不动）----
async function pullCloudPath(path: any) {
  const cloudName = stripSessionExt(path);
  // 加密容器云端名 = .zip（约定）。拉取前先在 busy 外解锁（验证用云端 peek byte-range）——
  //   acquire 内部 adopt 会 unseal，密码不在内存会抛 LOCKED；且 busy 起来后弹密码框死锁。
  if (/\.zip$/i.test(String(path))) {
    if (!(await ensureUnlocked(cloudName))) { setStatus("未拉取：需要密码解锁（已取消）", true); return; }
  }
  showFullscreenBusy(`正在从云端拉取…`);
  try {
    const localName = await uniqueLocalName(cloudName);
    const res = await _store.flow.acquire(cloudName, {
      localName,
      adopt: async (blob: any, nm: any) => { const loaded = await decodeOraToDoc(blob); adoptLoadedDoc(loaded, nm); },
    });
    if (res.status === "absent") { setStatus(`找不到：${path}`); return; }
    setGalleryOpen(false);
    setStatus(`已打开：${res.localName}（从云端拉取）`);
    gateCloudSyncOnOpen(res.localName).catch((e: any) => console.warn("[sync-gate]", e));
  } catch (err: any) {
    console.warn("[cloud] pull failed:", err);
    setStatus("拉取失败：" + (err && err.message || err));
  } finally {
    hideFullscreenBusy();
  }
}

// ---- 图库 host 画布耦合操作（从 mountGallery host 回调 verbatim 搬）----
async function openItem(item: any) {
  if (item.name === _activeSessionName) { setGalleryOpen(false); return; }
  if (_store.edits.localDirty()) await saveNow();
  try {
    if (item.local) {
      // 本地读取走 store.flow.load（自动解壳，明文原样）。加密且未解锁 → locked →
      // 在这里（非 busy）ensureUnlocked 后重 load。openItem 不在 withBusy 内，弹密码框安全。
      let r: any = await _store.flow.load(item.name);
      if (r.status === "locked") {
        if (!(await ensureUnlocked(item.name))) { setStatus("未打开：需要密码解锁（已取消）", true); return; }
        r = await _store.flow.load(item.name);
      }
      if (r.status === "absent") { setStatus(`找不到：${item.name}`); return; }
      if (r.status === "locked") { setStatus("未打开：需要密码解锁", true); return; }
      const loaded = await decodeOraToDoc(r.blob);
      adoptLoadedDoc(loaded, item.name);
      setGalleryOpen(false);
      setStatus(`已打开：${item.name}`);
      gateCloudSyncOnOpen(item.name).catch((e: any) => console.warn("[sync-gate]", e));
    } else if (item.cloud) {
      setStatus(`正在拉取：${item.name}…`);
      await pullCloudPath(item.cloud.path);   // 自带 busy + adopt + 关库
    }
  } catch (err: any) { setStatus("打开失败：" + (err && err.message || err)); }
}

async function pushItem(item: any) {
  // 加密文件先在 busy 外解锁（push 内 load 要解壳；密码框不能在 busy 里弹）
  if (await _store.isEncrypted(item.name)) {
    if (!(await ensureUnlocked(item.name))) { setStatus("未推送：需要密码解锁（已取消）", true); return; }
  }
  await withBusy(`正在推送 ${item.name} 到云端…`, async () => {
    try {
      const r: any = await _store.flow.load(item.name);   // 解壳读取（密码已在内存）
      if (r.status === "absent") throw new Error("找不到本地 session");
      if (r.status === "locked") throw new Error("需要密码解锁");
      const loaded = await decodeOraToDoc(r.blob);
      if (item.local && item.cloud) _store.adoptBase(item.name, getKnownETag(item.name));  // reloaded 后补锚 If-Match（W2 红线）
      const res = await _store.flow.push(item.name, {
        encode: () => encodeDocToOra(loaded, { referenceImage: loaded._referenceBlob, webpaintState: loaded._webpaintState }),
        onConflict: async () => "keep",
      });
      if (res.status === "conflict") setStatus(`云端有更新版本：${item.name}（打开处理 / 先改名）`, true);
      else setStatus(`已推送：${item.name}`);
    } catch (err: any) {
      if (err instanceof CloudNameCollisionError) setStatus(`云端已有同名「${item.name}」（不同作品）——未覆盖，改名再推`, true);
      else if (err instanceof CloudConflictError) setStatus(`云端冲突：${item.name}（打开处理）`, true);
      else setStatus("推送失败：" + (err && err.message || err));
    }
  });
}

async function unloadItem(item: any) {
  const isActive = item.name === _activeSessionName;
  if (isCloudDirty(item.name)) {
    const ok = await openConfirmSheet(`卸载本地 "${item.name}"？`, "本地有未推送到云端的修改——会移进**本地回收站**（可恢复）。云端保留旧版本。");
    if (!ok) return;
  }
  await withBusy(`正在卸载本地 ${item.name}…`, async () => {
    // K3（审计 2026-06-10）：进本地回收站而非硬删（红线「删除=移到.trash」——dirty 的未推字节可救回）。
    //   清同步态：① dirty 残留会让 cloud-only 项挂假「未推」徽章；② 残留 etag 是 K6 类
    //   「saveAs/rename 拿受害者 etag 当 If-Match 静默覆盖」的使能条件。
    try { await trashSession(item.name); clearCloudState(item.name); if (isActive) await exitCanvasToGallery(); setStatus(`已卸载本地：${item.name}（修改在本地回收站，云端保留）`); }
    catch (err: any) { setStatus("卸载失败：" + (err && err.message || err)); }
  });
}

function setName(name: any) { _activeSessionName = name; setCurrentSessionName(name); _recomputePhase(); }

// ---- 公开 session 对象 ----
export const session = {
  // 反应式相位
  current: _phase,                              // { current: "gallery"|"editing"|"lazyblank" }
  enc: _enc,                                    // { encrypted } 反应式：顶栏锁指示 + 菜单 label 读它
  encryptCurrent, decryptCurrent,              // 编辑态加密/解除（画板菜单）
  refreshEncrypted: _refreshEncrypted,
  // app.js 兼容读取面（取代散落的 _activeSessionName / 状态变量读）
  get name() { return _activeSessionName; },
  get lazyBlank() { return _isLazyBlankSession; },
  get loadingDoc() { return _loadingDoc; },
  get docLastSavedAt() { return _docLastSavedAt; },
  get sessionOpenedAt() { return _sessionOpenedAt; },
  get loadedDocIsNewer() { return _loadedDocIsNewer; },
  get loadedDocWriterVer() { return _loadedDocWriterVer; },
  get loadedDocNewerConfirmed() { return _loadedDocNewerConfirmed; },
  // 写面（取代 _activeSessionName = x；保 localStorage 镜像 + 相位）
  setName,
  // 生命周期方法
  save: saveNow,
  saveAndPush,
  adopt: adoptLoadedDoc,
  adoptWithOpts: adoptLoadedDocWithOpts,
  rename: renameCurrentSession,
  exit: exitCanvasToGallery,
  newDoc,
  pull: pullCloudPath,
  open: openItem,
  push: pushItem,
  unload: unloadItem,
  // app-local 调用面（export / revert / saveAs 等仍在 app 的 fn 需要这些原语）
  encodeOra: _encodeCurrentOra,
  buildOraMeta: _buildOraMeta,
  writeCheckpoint: _writeSessionCheckpoint,
  readCheckpoint: _readSessionCheckpoint,
  awaitCloudPushIdle: _awaitCloudPushIdle,
  // revert 之类需要直接改 sessionOpenedAt 的少数点
  markOpenedNow() { _sessionOpenedAt = Date.now(); },
  markNewerConfirmed() { _loadedDocNewerConfirmed = true; },
  // app 里仍住的 saveAs / importImageAsNewDoc 写 saved-at 的少数原语（session 拥有该变量）
  markSavedNow() { _docLastSavedAt = Date.now(); },
  resetSavedAt() { _docLastSavedAt = 0; },
};

export function initSession(ctx: any) {
  state = ctx.state; doc = ctx.doc; board = ctx.board; input = ctx.input;
  editMode = ctx.editMode; rack = ctx.rack;
  referenceWindow = ctx.referenceWindow; paletteWindow = ctx.paletteWindow;
  setStatus = ctx.setStatus; withBusy = ctx.withBusy;
  updateSaveStatus = ctx.updateSaveStatus; updateNewerBanner = ctx.updateNewerBanner;
  setColor = ctx.setColor; applyCheckerboard = ctx.applyCheckerboard;
  renderLayersPanel = ctx.renderLayersPanel;
  setGalleryOpen = ctx.setGalleryOpen; gateCloudSyncOnOpen = ctx.gateCloudSyncOnOpen;
  checkQuotaAndWarn = ctx.checkQuotaAndWarn; uniqueLocalName = ctx.uniqueLocalName;
  getLocalSavedAtLabel = ctx.getLocalSavedAtLabel;
  showFullscreenBusy = ctx.showFullscreenBusy; hideFullscreenBusy = ctx.hideFullscreenBusy;
  gallery = ctx.gallery;   // 可能晚绑：init 时若为 null，下面 setGallery 回填
  _recomputePhase();
  resetEditorState();   // v267b：启动也走统一入口，保证编辑器状态从干净基线起步（进文件/新建/init 三处同源）

  // ---- autosave + coalescer 接线（**verbatim**，store 调用一字不改）----
  // Ctrl+S = 完整保存（本地 + 云端）；Ctrl+Shift+S = 只存本地。合流状态机在 Store（_store.session）。
  _store.session.configure({ doLocal: () => saveNow(), doPush: () => saveAndPush() });
  // autosave cadence 归 store（L4 ②c）：app 注入 persist + start 3min 兜底。
  _store.autosave.configure({ persist: () => saveNow({ implicit: true }) });
  _store.autosave.start(AUTOSAVE_MS);   // 3 min 兜底
  // visibility / pagehide 抢救（implicit：floating 跳过）→ store.autosave.flush()
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") _store.autosave.flush();
  });
  window.addEventListener("pagehide", () => { _store.autosave.flush(); });
}

// gallery 是 const（非 hoisted），app 在 mountGallery 后回填。
export function setSessionGallery(g: any) { gallery = g; }
