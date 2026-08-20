// 职责（单一）：图片/.ora 导入——照片新建 doc / 叠为新层 / 文件选择器 / 大图导入询问 sheet / 拖拽落图。
// 三条入口：
//   _openImagePicker()      图层面板「导入图片」按钮 → 触发 oraFileInput（强制走 importImageAsLayer）
//   importImageAsNewDoc()   图库「导入照片 / 剪贴板新建」语义：照片当新 doc 打底（doc 尺寸 = 照片，cap 8192）
//   importImageAsLayer()    photobash / Ctrl+V 粘贴 / 桌面拖拽：图片叠为当前 doc 的新层（含自动 lift transform）
// oraFileInput change-handler 按文件类型分流（.ora→session.adopt / image→As{NewDoc|ViewLeaf}）。
// 大图（> 护栏 max(2048, 画布长边)，v0.9.22）走 _openBigImportSheet 询问 适配护栏 / 保原 / 自定义尺寸。
// 与 app 经 ctx 绑核心单例（doc/board/input/...）；leaf 依赖直接 import（session/resample/ora/els）。
// 「导入照片(新建)」复用 session.newDoc 骨架（fillLayer0 画照片），不再自建 PaintingView/做 doc 替换。

import { els } from "./els.ts";
import { reportError } from "./error-badge.ts";
import { t } from "./i18n/index.ts";
import { session } from "./session-state.ts";
import { decodeImageFile, imageSourceToBytes } from "./shell/image-io.ts";
import { resampleBytes } from "./backend/algorithms/resample-bytes.ts";
import { decodeOraToPainting } from "./backend/ora.ts";
import { store as _store } from "./app-store.ts";
import { stripSessionExt } from "./config.ts";
import { unlockImportedContainer } from "./enc-thumbs.ts";
import { onPasswordVerified } from "./crypto-state.ts";
import { setTool, updateLassoToolbar } from "./toolbar.ts";
import { openChoiceSheet } from "./sheets.ts";
import { setReferenceFromFile } from "./side-windows.ts";
import { importGuardLimit, needsBigImportSheet } from "./clipboard-policy.ts";
import { droppedOraHandle, consumeLaunchFiles } from "./local-file-session.ts";
import { pickCloudImage } from "./cloud-picker-host.ts";
import { _suppressTransientPanels, _commitTransform, _cancelTransform } from "./transient-panels.ts";
import type { AppContext } from "./app-context.ts";


// 错误信息提取（catch 子句 e 在 strict 下是 unknown）。
const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e);

// （ImportLayer 接口已删 v0.9.33：fillLayer0 裸写路径退役，像素走 newDoc layer0Pixels 正门。）
// big-import sheet 的结果。
interface BigImportChoice { w: number; h: number; mode: string; }
interface TransientOpts { apply?: () => void; abort?: () => void; }

// app 单例 / 跨模块函数（initImportImage(ctx) 装入）。
let doc: AppContext["doc"], board: AppContext["board"], input: AppContext["input"], editMode: AppContext["editMode"];
let setStatus: AppContext["setStatus"];
let renderLayersPanel: AppContext["renderLayersPanel"], setGalleryOpen: AppContext["setGalleryOpen"], uniqueNameFor: AppContext["uniqueNameFor"];
let history: AppContext["history"], layers: AppContext["layers"];

// 图库「导入照片」会 set 此 flag=true，oraFileInput change 读后立即复位（语义：照片打底新 doc）。
let _addImportAsNewDoc = false;

// v123 把 layer op 抽成 named 函数：原 4 个 footer 按钮挪进 menu/popup
export function _openImagePicker() {
  // v125 修 (user：「图层面板的导入图片不成功」)
  //   图库"导入照片"会 set _addImportAsNewDoc=true，如果用户取消 file picker
  //   flag 不会清。下次从图层面板导入会被路由到 importImageAsNewDoc（替换 doc），
  //   user 觉得"不成功"。这里强制 false 让图层面板入口走 importImageAsLayer
  _addImportAsNewDoc = false;
  els.oraFileInput.value = "";
  els.oraFileInput.click();
}

// 「导入照片」语义：用照片新建一个 doc（doc 尺寸 = 照片尺寸，cap 8192），
// 单层就是这张照片。和"导入图片 / .ora"（叠新图层到当前 doc）不同。
export async function importImageAsNewDoc(file: File) {
  const bitmap = await decodeImageFile(file);
  const w = Math.min(8192, bitmap.width);
  const h = Math.min(8192, bitmap.height);
  const stem = file.name.replace(/\.[^.]+$/, "") || t("mi.defaultImportName");
  const name = await uniqueNameFor(stem);
  // v0.6.46 字节管线：解码边界读出一次 → 面积平均缩小（缩小正解）/双三次放大。
  // v0.9.33：像素先算好、经 newDoc 的 layer0Pixels 走 wp2.load 正门（令牌+suspend，不入 undo）——
  //   旧 fillLayer0 回调在 load 后裸写 = C7 硬化后的违章（LayerTiles tokenless throw，云盘导入首暴）。
  const px = imageSourceToBytes(bitmap as ImageBitmap);
  const out = (w !== px.w || h !== px.h) ? resampleBytes(px.data, px.w, px.h, w, h, "auto") : px.data;
  (bitmap as ImageBitmap).close?.();
  // 共用 session.newDoc 骨架（消 survey rec #4 孪生）：doc 替换/全部重置/落盘/checkpoint 归 session。
  // 照片导入因此与空白新建完全对齐（清 selection/参考窗 + color 归黑 + 加密归明文 + 关图库）
  // ——human 定：之前不重置这些反而是小 bug。
  await session.newDoc({ name, w, h, layer0Name: file.name.replace(/\.[^.]+$/, "") || t("mi.defaultImageName"), layer0Pixels: out });
  setStatus(t("mi.newFromPhoto", { name, w, h }));
}

// 把图片当一个新图层叠进当前 doc（photobash / 参考图工作流）。
// v134 big-import sheet → v0.9.22「大图片导入」窗口（human 拍板，spec 20260819）：
//   只在图片超**护栏**（max(2048, 画布长边)，undo 内存护栏——重采样在 lift 前才真省内存）时弹；
//   不超护栏静默原尺寸进。fit 选项 = 适配护栏（fit-to-canvas 作废：photobash 常态是素材比画布大、
//   摆位后裁溢出，进门先缩到画布 = 后续放大 = 糊）。resolve { w, h, mode } 或 null（取消）。
function _openBigImportSheet(ow: number, oh: number, docW: number, docH: number, limit: number): Promise<BigImportChoice | null> {
  const backdrop = document.getElementById("bigImportBackdrop") as HTMLElement;
  const sheet = document.getElementById("bigImportSheet") as HTMLElement;
  const wIn = document.getElementById("bigImportW") as HTMLInputElement;
  const hIn = document.getElementById("bigImportH") as HTMLInputElement;
  const modeSel = document.getElementById("bigImportMode") as HTMLSelectElement;
  const info = document.getElementById("bigImportInfo") as HTMLElement;
  const okBtn = document.getElementById("bigImportConfirm") as HTMLElement;
  const cancelBtn = document.getElementById("bigImportCancel") as HTMLElement;
  // fit-to-guard（保比例缩进护栏方框内；调用方保证进来时至少一边超护栏 → scale < 1 恒成立）
  const scale = Math.min(limit / ow, limit / oh);
  const fitW = Math.round(ow * scale);
  const fitH = Math.round(oh * scale);
  info.textContent = t("mi.bigImportInfo", { ow, oh, docW, docH, limit });
  wIn.value = String(fitW);
  hIn.value = String(fitH);
  // 默认 fit choice
  for (const r of sheet.querySelectorAll('input[name="bigImportChoice"]')) {
    (r as HTMLInputElement).checked = ((r as HTMLInputElement).value === "fit");
  }
  // W/H input 联动（锁宽高比，由当前 ow/oh 决定）
  const aspect = ow / oh;
  const setChoice = (val: string) => {
    for (const r of sheet.querySelectorAll('input[name="bigImportChoice"]')) {
      (r as HTMLInputElement).checked = ((r as HTMLInputElement).value === val);
    }
    if (val === "fit") { wIn.value = String(fitW); hIn.value = String(fitH); }
    else if (val === "keep") { wIn.value = String(ow); hIn.value = String(oh); }
  };
  wIn.oninput = () => {
    setChoice("custom");
    const v = parseFloat(wIn.value) | 0;
    if (v > 0) hIn.value = String(Math.max(1, Math.round(v / aspect)));
  };
  hIn.oninput = () => {
    setChoice("custom");
    const v = parseFloat(hIn.value) | 0;
    if (v > 0) wIn.value = String(Math.max(1, Math.round(v * aspect)));
  };
  for (const r of sheet.querySelectorAll('input[name="bigImportChoice"]')) {
    r.addEventListener("change", () => setChoice((r as HTMLInputElement).value));
  }
  backdrop.classList.remove("hidden");
  sheet.classList.remove("hidden");
  return new Promise<BigImportChoice | null>((resolve) => {
    const cleanup = () => {
      backdrop.classList.add("hidden");
      sheet.classList.add("hidden");
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      backdrop.onclick = null;
    };
    okBtn.onclick = () => {
      const w = Math.max(1, Math.min(8192, parseFloat(wIn.value) | 0));
      const h = Math.max(1, Math.min(8192, parseFloat(hIn.value) | 0));
      const mode = modeSel.value || "bicubic";
      cleanup();
      resolve({ w, h, mode });
    };
    cancelBtn.onclick = () => { cleanup(); resolve(null); };
    backdrop.onclick  = () => { cleanup(); resolve(null); };
  });
}

export async function importImageAsLayer(file: File, opts: { center?: { x: number; y: number } } = {}) {
  // v0.5.38（user 拍板）：导入会 lift 新浮层——先把悬着的 transient 按 apply 收口（丢失变换的原始报告场景）。
  if (editMode.hasPendingTransient()) editMode.applyPendingTransient();
  const bitmap = await decodeImageFile(file);
  const ow = bitmap.width, oh = bitmap.height;
  const docW = doc.width, docH = doc.height;
  // v0.9.22（human 拍板，spec 20260819）：阈值从「比画布大」改「超护栏」——不超护栏静默原尺寸进
  //   （连贴 2k 以下素材零打断），超护栏才弹「大图片导入」窗口问 适配护栏 / 保原 / 自定义。
  let w = ow, h = oh; let imgSmoothing: ImageSmoothingQuality = "high";
  if (needsBigImportSheet(ow, oh, docW, docH)) {
    const choice = await _openBigImportSheet(ow, oh, docW, docH, importGuardLimit(docW, docH));
    if (!choice) { (bitmap as ImageBitmap).close?.(); return; }   // user 取消
    w = choice.w; h = choice.h;
    imgSmoothing = choice.mode === "nearest" ? "low" : "high";
  }
  // v0.7.41 先切工具再动 doc：setTool 可能触发 fill 的「切出=commit」整点——必须落在导入前的
  // 活动层上。此前顺序是先加层再切换，fill 的 pending 预览会被填到刚导入的层上（latent bug）。
  setTool("lasso");
  // v0.8.1（S1）：新建层走 ctx.layers 门面（创建即记账；prevActiveId/locateNode 舞蹈已下沉。
  // AddLayerRecordOp 首跑只验证——像素在记账后填充合法，undo 摘层时才捕 spec、redo 连像素恢复）。
  // v0.7.41（user：「导入和进 transform 只要一个 undo checkpoint」）：checkpoint:false 微步，
  // 由紧随其后的 liftFloat（默认封口）把 [addLayer, liftFloat] 封成一个整点——一次 undo 整个导入消失。
  const a = layers.addLayer(file.name.replace(/\.[^.]+$/, ""), { checkpoint: false });
  if (!a.ok) {
    (bitmap as ImageBitmap).close?.();
    if (a.msg === "maxLayers") setStatus(t("mi.layerLimitImport", { max: doc.maxLayers }));
    else reportError(new Error("[import] addLayer failed: " + a.msg), "error");
    return;
  }
  const layer = a.layer;
  // bbox 中心：默认 doc 中心；opts.center（doc 坐标）可指定（Ctrl+V 传视口中心）
  const ccx = opts.center?.x ?? docW / 2;
  const ccy = opts.center?.y ?? docH / 2;
  const bx = Math.floor(ccx - w / 2);
  const by = Math.floor(ccy - h / 2);
  // v0.6.46 字节管线：imgSmoothing="low"（像素画）→ 最近邻；否则缩小=面积平均/放大=双三次
  const px = imageSourceToBytes(bitmap as ImageBitmap);
  const mode = imgSmoothing === "low" ? "nearest" : "auto";
  const out = (w !== px.w || h !== px.h) ? resampleBytes(px.data, px.w, px.h, w, h, mode) : px.data;
  // v0.9.2 修「选原大小导入的是被画布裁过的图」：图层像素是 doc 边界的（putRegion 与 doc 求交，
  //   越界不产生 tile）——落图层再 lift，画布外那圈在写入那一刻就没了，缩小回来也回不来。
  //   会越界就跳过图层、字节直接成浮层（浮层像素 v0.9.2 起是本地坐标，装得下画布外）。
  //   条件写「会不会被裁」而非「选了原大小」：Ctrl+V 贴在画布边缘也在吃像素，同一个 bug。
  const willClip = bx < 0 || by < 0 || bx + w > docW || by + h > docH;
  const direct = willClip && input.lasso.liftFloatFromBytes(layer, out, { x: bx, y: by, w, h });
  if (!direct) layer.replaceFromBytes(out, bx, by, w, h);   // 不越界 / 直取失败 → 老路（行为不比原来差）
  (bitmap as ImageBitmap).close?.();
  // v0.7.35 修「import 破坏 undo」：加层必记账（现由门面保证——记账失败连层都不留）。此前这里
  // 裸加层不记账 + 伪造 wp:histchange —— 后续 lift 却进栈，栈引用了历史不知道的层：undo 跨树
  // 操作会静默销毁该层 / redo 找不到层 → 整栈被弃。真 history.run 自会派 wp:histchange 驱动编辑门。
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();

  // v111: 自动 lift 全图入 transform（user：「导入图片到图层之后自动全选图片进入 transform 模式」）
  // v0.4.7：不再手写 doc.selection——lift 的隐式全选走 fallbackFullLayer（operator 内部构造，
  //   lift 本就清选区，省一条不进栈的裸赋值）。
  try {
    {
      // direct = 上面已经字节直取成浮层（越界路径），无需再从图层 lift
      const ok = direct || input.lasso.liftSelectionForTransform(layer, { fallbackFullLayer: true, ignoreSelection: true });
      if (ok) {
        (editMode.enterTransient as (n: string, o?: TransientOpts) => void)("transform", { apply: _commitTransform, abort: _cancelTransform });
        input.lasso.setMode("free");
        updateLassoToolbar();
        _suppressTransientPanels("transform");
        board.invalidateAll();
        setStatus(t("mi.importedTransform", { name: file.name }));
        return;
      }
    }
  } catch (e) { reportError(new Error("[import auto-transform] " + String(e)), "log"); }
  // lift 没走成（拒绝/异常）：addLayer 微步还敞着口——补封，别让它漏进下一个动作的整点
  history.sealCheckpoint();
  setStatus(t("mi.importedAsLayer", { name: file.name }));
}

// .ora 导入为**新身份**（v0.9.24 从 oraFileInput change-handler 提出，供 file-input / drop 降级 /
// 无地入口的加密·外来 ora 回退共用）。首存 mode:"new"，撞名抛而不静默覆盖
// （v415 前走 existing → 导入同名 .ora 会静默盖掉已有作品，活的数据丢失）。
async function importOraFileAsNew(file: File) {
  if (!(await session.leaveLocalFile())) return;   // 无地且脏 → 先问（adoptAsNew 是同步入口，门在这里过）
  const nm = stripSessionExt(file.name) || t("nd.untitled");
  // 外来文件可能是加密容器（可能用与图库不同的密码）→ busy 外解锁 + 显式密码解，
  //   再按落库 name 记忆（onPasswordVerified：全局空→上位 / 否则 per-name 覆盖）。
  let plain: Blob = file;
  if (await _store.encryption.isEncryptedBlob(file)) {   // 便宜嗅探（不解密）→ 分流
    // 解锁循环一次尝试 = 一次解密，成功那次的明文直接拿来用（旧版要全量解两遍）。
    const got = await unlockImportedContainer(file);
    if (!got) { setStatus(t("mi.importCancelledNeedPw"), true); return; }
    plain = got.plain;
    onPasswordVerified(nm, got.pw);
  }
  const loaded = await decodeOraToPainting(plain);
  session.adoptAsNew(loaded, nm);
  setStatus(t("mi.imported", { name: nm }));
  setGalleryOpen(false);
}

export function initImportImage(ctx: AppContext) {
  doc = ctx.doc;
  board = ctx.board;
  input = ctx.input;
  editMode = ctx.editMode;
  setStatus = ctx.setStatus;
  renderLayersPanel = ctx.renderLayersPanel;
  setGalleryOpen = ctx.setGalleryOpen;
  uniqueNameFor = ctx.uniqueNameFor;
  history = ctx.history;
  layers = ctx.layers;

  // 图层面板「导入图片」按钮 → file picker（强制叠层，复位 _addImportAsNewDoc）。
  document.getElementById("layerImportPhotoBtn")?.addEventListener("click", _openImagePicker);
  // 从云盘导入 → 叠为当前 doc 新层（spec 20260820 §4；大图护栏照旧走 importImageAsLayer 内部）
  document.getElementById("layerImportCloudBtn")?.addEventListener("click", async () => {
    try {
      const file = await pickCloudImage();
      if (file) await importImageAsLayer(file);
    } catch (e) {
      reportError(new Error(t("cp.importFailed", { err: errMsg(e) })), "warning");
    }
  });
  // v0.5.19 导入剪贴板（+菜单）：复用 Ctrl+V 全链路（selection-ops 的 wp:paste——读剪贴板→新层视口居中→错误上 banner）
  document.getElementById("layerImportClipboardBtn")?.addEventListener("click", () => window.dispatchEvent(new CustomEvent("wp:paste")));

  // file-input plumbing：按文件类型分流（.ora→adopt / image→As{NewDoc|ViewLeaf}）。
  els.oraFileInput.addEventListener("change", async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    // 图库里"导入照片"语义：把照片当新 doc 打底（不是叠到当前）
    const asNewDoc = _addImportAsNewDoc;
    _addImportAsNewDoc = false;
    if (!file) return;
    const isOra = /\.(ora|zip)$/i.test(file.name);   // .zip = 加密容器导出件（ADR-0012）
    const isImage = (file.type || "").startsWith("image/");
    try {
      if (isOra) {
        await importOraFileAsNew(file);
      } else if (isImage) {
        if (asNewDoc) {
          await importImageAsNewDoc(file);
          setGalleryOpen(false);
        } else {
          await importImageAsLayer(file);
        }
      } else {
        setStatus(t("mi.unsupportedFileType", { type: file.type || file.name }));
      }
    } catch (err) {
      reportError(new Error("[import] failed: " + String(err)), "log");
      setStatus(t("mi.importFailed", { err: errMsg(err) }));
    }
  });

  // v156 桌面拖拽图片到画布；#19（v0.5）iOS 手指拖图同路径。两个常见意图（photobash 新图层 /
  //   参考图）→ 落点弹 in-app 选择 sheet（无系统对话框红线）。取消 = 什么都不做。
  window.addEventListener("dragover", (e: DragEvent) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault();   // 允许 drop
  });
  window.addEventListener("drop", async (e: DragEvent) => {
    const files = [...(e.dataTransfer?.files || [])];
    // v0.9.24 无地（spec §7）：拖 .ora 进来 → 文件系统句柄 → 本地原位打开（图库里也可用，
    //   openLocalFile 自己关图库）。⚠ droppedOraHandle 的句柄收集必须在本处理器**首个 await 之前**
    //   同步发生（DataTransferItemList 随后失效）。拿不到句柄（浏览器不支持）/加密/外来 ora → 导入新身份。
    const oraFile = files.find((f: File) => /\.ora$/i.test(f.name));
    if (oraFile) {
      e.preventDefault();
      const handlePromise = droppedOraHandle(e.dataTransfer);   // 同步收集，await 在后
      try {
        const h = await handlePromise;
        const fallback = h ? await session.openLocalFile(h) : oraFile;
        if (fallback) await importOraFileAsNew(fallback);
      } catch (err) { setStatus(t("mi.dropFailed", { err: errMsg(err) }), true); }
      return;
    }
    const img = files.find((f: File) => f.type && f.type.startsWith("image/"));
    if (!img) return;                                  // 非图片（如 .zip 容器）不拦，让默认行为
    e.preventDefault();
    if (document.body.dataset.mode === "gallery") { setStatus(t("mi.exitGalleryBeforeDrop"), true); return; }
    const center = board.screenToDoc(e.clientX, e.clientY);
    const choice = await openChoiceSheet<"layer" | "ref">(t("mi.dropChoiceTitle"), img.name || "", [
      { label: t("mi.dropAsLayer"), value: "layer", primary: true },
      { label: t("mi.dropAsReference"), value: "ref" },
    ]);
    if (!choice) return;
    try {
      if (choice === "layer") await importImageAsLayer(img, { center });
      else await setReferenceFromFile(img);
    } catch (err) { setStatus(t("mi.dropFailed", { err: errMsg(err) }), true); }
  });

  // v0.9.24 无地入口的回退通道：topbar 菜单「打开本地文件」遇到加密/外来 ora → 派此事件走导入。
  window.addEventListener("wp:importOraFile", (e: Event) => {
    const file = (e as CustomEvent<File>).detail;
    if (file) void importOraFileAsNew(file).catch((err) => setStatus(t("mi.importFailed", { err: errMsg(err) }), true));
  });
  // v0.9.24 安装态 PWA：双击 .ora 唤起（manifest file_handlers + launchQueue；非安装态静默 no-op）。
  consumeLaunchFiles((h) => {
    void (async () => {
      const fallback = await session.openLocalFile(h);
      if (fallback) await importOraFileAsNew(fallback);
    })().catch((err) => reportError(new Error("[local-file] launch open failed: " + String(err)), "warning"));
  });

  // 图库「导入照片」入口（galleryAddPopup → addImportPhoto）设 _addImportAsNewDoc 经此函数。
  // app.js 的 addImportPhoto 按钮仍直接调 els.oraFileInput.click()，需先 setAddImportAsNewDoc(true)。
}

// 图库「导入照片 / 剪贴板新建」语义切换器：app.js addImportPhoto / addImportClipboard 路径要置 true。
export function setAddImportAsNewDoc(v: boolean) { _addImportAsNewDoc = v; }
