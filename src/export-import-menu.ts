// 职责（单一）：汉堡菜单的「导入 / 导出 / 剪贴板」项 + 导出格式偏好（project / image / import 三组 prefs）
// + 齿轮（🔧）配置 popup + 菜单子标签刷新。
//
// 旧 app.js 「菜单：导入 / 导出 / 剪贴板」区逐字搬来；app.js 短路成 import + initExportImportMenu() 装配。
// 导入/导出偏好存 desk（per-doc desk state，见 editor-state.ts）；boot 的 _updateMenuSubLabels() 进 init。
// stampNow（导出文件名时间戳）只此处用，一并搬入。
//
// 依赖直 import（叶/单例）：exporters / els / settings-menu(setMenuOpen) / session-state(session) /
//   session.js(下载·分享·剪贴板) / import-image(导入)。
// app 协作件经 ctx 绑入：doc / setStatus（核心单例）。

import { getExporter, listExportersByKind } from "./exporters.ts";
import { parseColorName, colorNameOf } from "./color-name.ts";
import { normalizeHex } from "./ui/color-model.ts";
import { parseExportBg } from "./backend/algorithms/flatten-bg.ts";
import { els } from "./els.ts";
import { t } from "./i18n/index.ts";
import { setMenuOpen } from "./settings-menu.ts";
import { session } from "./session-state.ts";
import { triggerDownload, shareOrDownloadBlob, copyImageToClipboard, readImageFromClipboard, printImageBlob, printImageInNewWindow, prefersShare } from "./session.ts";
import { importImageAsLayer } from "./import-image.ts";
import { desk } from "./workbench-state.ts";
import { reportError } from "./error-badge.ts";
import { store, storeAbsent } from "./app-store.ts";
import { nextFreeExportName } from "./gallery/cloud-image-model.ts";
import { withBusy } from "./fullscreen-busy.ts";

import type { AppContext } from "./app-context.ts";
const errMsg = (e: unknown): string => String((e as { message?: unknown })?.message || e);
let doc: AppContext["doc"], setStatus: AppContext["setStatus"], board: AppContext["board"];

// 导出文件名时间戳（YYYYMMDD-HHMM）—— 仅导出图片路径用
function stampNow() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}-${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}`;
}

// v120: 主菜单导出/导入 重组（user：「导出项目和导出语义分开」+「小扳手」)
// - 主行 = 按 sticky config 一键执行；🔧 = 弹 inline popup 改 config
// - 偏好存 desk（per-doc desk state，setter 自动标 workspace dirty）
//   getter/setter 返回形保持不变（scope ↔ desk.export.layerMode 映射），call site 不动。
function _getExpImg(): { format: string; target: string; scope: string; clipSelection: boolean } {
  // scope ← desk.export.layerMode ("merged" | "active")
  return { format: desk.export.format, target: desk.export.target, scope: desk.export.layerMode, clipSelection: desk.export.clipSelection };
}
// #16：有选区且开了「仅导出选区范围」→ 选区 bbox（doc 坐标）；否则 null=全文档
function _selCropRect(): { x: number; y: number; w: number; h: number } | null {
  if (!desk.export.clipSelection) return null;
  const sel = doc.selection as { bboxX: number; bboxY: number; bboxW: number; bboxH: number } | null;
  if (!sel || !(sel.bboxW > 0) || !(sel.bboxH > 0)) return null;
  return { x: sel.bboxX, y: sel.bboxY, w: sel.bboxW, h: sel.bboxH };
}
// v0.5.20：导出图片/导出项目合并为一个「导出」入口——format=ora/psd 即项目语义（所有图层·文件）。
function _isProjectFormat(fmt: string): boolean { return (getExporter(fmt)?.kind ?? "image") === "project"; }

// 导出文件名的基名（v0.9.31，QA ③）：无地本地文件模式 session.name 恒 null（双墙设计），
//   用打开的本地文件 stem；否则用 store 裸名（自带夹前缀）。所有导出 sink 共用。
function _exportBaseName(): string {
  const lf = session.localFile;
  if (lf) return lf.name.replace(/\.[^.]+$/, "") || "export";
  return session.name ?? "export";   // name=null ∧ 非无地 不该发生；防御兜底别让文件名变 "null"
}

// 云盘去向的前置闸（v0.9.31，QA ③④）：返回拒绝文案或 null=放行。encode 之前调，别白编码。
//   - store 缺席（?nostore）：null-store 的 save 什么都不落，放行会让 toast 撒谎（QA ④）。
//   - 无地本地文件：无地=零 store 身份（spec 20260819 §7），cloud 导出会建 store 条目，软拒。
//   - 加密作品：加密模型承诺明文字节不落云端（v0.9.30 起）。
function _cloudSinkBlocked(): string | null {
  if (storeAbsent) return t("tm.exportCloudUnavailable");
  if (session.localFile) return t("tm.exportLocalDocNoCloud");
  if (session.enc.encrypted) return t("tm.exportEncryptedNoCloud");
  return null;
}

// v0.9.30 导出到云盘（spec 20260820 §7.5，user 拍板：image+psd 开放 / 落画所在夹+时间戳）：
//   第四个 target sink——落点 = 画所在夹（基名自带夹前缀），名 = <画名>-<stamp>.<ext>，
//   撞名自动后缀（mode:"new" 首存护栏仍兜底）。save 默认 best-effort push：
//   toast 按 pushed 事实说话（在线=已上云 / 离线=已存本地待补推），不谎报。
async function _exportBlobToCloud(blob: Blob, ext: string): Promise<void> {
  const name = await nextFreeExportName(`${_exportBaseName()}-${stampNow()}`, ext, (n) => store.files.nameOccupied(n).then(Boolean));
  const r = await store.file(name, { isZip: false, mode: "new" }).save(blob);
  setStatus(r.pushed ? t("tm.exportedCloud", { name }) : t("tm.exportedCloudLocal", { name }), true);
}
function _updateMenuSubLabels() {
  const ei = _getExpImg();
  const eiEl = document.getElementById("menuExportImageSub");
  if (!eiEl) return;
  if (_isProjectFormat(ei.format)) {
    // psd 可选云盘去向（v0.9.30）；ora 恒 file
    const tgtLabel = ei.format === "psd" && ei.target === "cloud" ? t("sub.cloud") : t("sub.file");
    eiEl.textContent = `.${(getExporter(ei.format) || getExporter("ora")).ext} · ${t("tm.scopeAllLayers")} · ${tgtLabel}`;
  } else {
    // v0.9.14：底色非透明时 sub-label 带一眼（色名系统给人话：「白」「藏青」；词库未到 = hex 兜底）
    const bgRgb = parseExportBg(desk.export.bg);
    const bgTail = bgRgb ? ` · ${colorNameOf(bgRgb.r, bgRgb.g, bgRgb.b)}` : "";
    eiEl.textContent = `${ei.format.toUpperCase()} · ${ei.scope === "active" ? t("sub.activeLayer") : t("sub.merged")} · ${ei.target === "clipboard" ? t("sub.clipboard") : ei.target === "print" ? t("sub.print") : ei.target === "cloud" ? t("sub.cloud") : t("sub.file")}${ei.clipSelection ? " · " + t("sub.selection") : ""}${bgTail}`;
  }
}

// 🔧 配置 popup（点开 / 点别处关）。setMenuOpen 不变，popup 嵌在 menu-item-row 里
function _openMenuConfigPopup(wrenchBtn: HTMLElement, html: string, onApply: (popup: HTMLElement) => void) {
  // v124 toggle：再点同一个扳手就收回（user：「再按一下扳手应该收回」）
  const existing = wrenchBtn.closest(".menu-item-row")?.querySelector(".menu-config-popup");
  if (existing) { existing.remove(); return; }
  document.querySelectorAll(".menu-config-popup").forEach((el) => el.remove());
  const row = wrenchBtn.closest(".menu-item-row");
  if (!row) return;
  const popup = document.createElement("div");
  popup.className = "menu-config-popup";
  popup.innerHTML = html;
  row.appendChild(popup);
  const onPopupChange = () => onApply(popup);
  popup.addEventListener("change", onPopupChange);
  // popup 内点击不冒泡（让 menu 自身的「点外面关」别误把 popup 当外面）
  popup.addEventListener("click", (e) => e.stopPropagation());
  setTimeout(() => {
    function onDocClick(ev: Event) {
      if (popup.contains(ev.target as Node) || wrenchBtn.contains(ev.target as Node)) return;
      popup.remove();
      document.removeEventListener("pointerdown", onDocClick, true);
    }
    document.addEventListener("pointerdown", onDocClick, true);
  }, 0);
}

export function initExportImportMenu(ctx: AppContext) {
  ({ doc, setStatus, board } = ctx);

  _updateMenuSubLabels();
  // desk 载入：换画后导入导出偏好（desk）变了 → 刷新折叠菜单 sub-label（值本身按需读，无数据问题；仅显示同步）。
  window.addEventListener("wp:applyEditorState", _updateMenuSubLabels);

  els.menuExportImage.addEventListener("click", async () => {
    setMenuOpen(false);
    const c = _getExpImg();
    // v0.5.20：ora/psd = 项目语义（所有图层含隐藏 · 文件），与图片路径在此分流。
    if (_isProjectFormat(c.format)) {
      const exp = getExporter(c.format) || getExporter("ora");
      try {
        // 加密作品 + .ora → **原样导出 at-rest 密文容器**（不解不封，因此也不问密码）。
        //   文件名 <名>.ora.zip：诚实反映它是加密容器（与云端 at-rest 命名一致）。导入侧能嗅探收回。
        if (session.enc.encrypted && exp.id === "ora") {
          const cipher = await session.readEncryptedBytes();   // 内部先 saveNow（否则导的是上次保存的旧内容）
          if (!cipher) { setStatus(t("tm.exportNoCipher"), true); return; }
          triggerDownload(cipher, `${_exportBaseName()}.ora.zip`);
          setStatus(t("tm.dotExtDownloaded", { ext: "ora.zip" }));
          return;
        }
        // v0.9.30：psd + 云盘去向（ora 锁 file 不进这里；缺席/无地/加密 前置闸软拒，v0.9.31）。
        if (c.target === "cloud" && exp.id === "psd") {
          const blocked = _cloudSinkBlocked();
          if (blocked) { setStatus(blocked, true); return; }
          // busy 遮罩（QA ⑥）：psd 编码 + 上传都可能秒级，给防误点 + 可见进行时
          await withBusy(t("tm.exportingCloud"), async () => {
            const blob = await exp.encode(doc);
            await _exportBlobToCloud(blob, exp.ext);
          });
          return;
        }
        // 加密 + .psd：格式不支持加密 → 出明文（user 已 consent：「导出 psd/png 就当 consent 了」）。
        if (exp.busyHint) setStatus(exp.busyHint, true);
        const blob = await exp.encode(doc);
        triggerDownload(blob, `${_exportBaseName()}.${exp.ext}`);
        setStatus(t("tm.dotExtDownloaded", { ext: exp.ext }));
      } catch (e) { setStatus(t("tm.exportFailed", { err: String(errMsg(e)) })); }
      return;
    }
    const cropRect = _selCropRect();   // #16：仅导出选区范围（三种去向统一生效）
    try {
      if (c.target === "clipboard") {
        // 剪贴板恒为 PNG（ClipboardItem image/png）——格式选择只作用于文件/分享路径；底色/防黑边同享（v0.9.14）
        await copyImageToClipboard(doc, c.scope, cropRect, desk.export.defringe, desk.export.bg);
        setStatus(t("tm.copiedPngToClipboard", { scope: c.scope === "active" ? t("tm.scopeActiveLayer") : t("tm.scopeMerged") }));
      } else if (c.target === "print" && !prefersShare()) {
        // 打印恒走位图（PNG）——矢量/ora 之类没意义；scope 仍生效。
        const exp = getExporter(c.format === "jpg" ? "jpg" : "png") || getExporter("png");
        // 首选：新标签页打印（把打印彻底搬离脆弱的 WebGL 页，修 iOS 打印丢图，见 session.ts）。
        //   window.open 必须在此**手势同步期**就开好，不能等 encode 的 await（iOS transient-activation 严）。
        const win = window.open("", "_blank");
        if (exp.busyHint) setStatus(exp.busyHint, true);
        const blob = await exp.encode(doc, { scope: c.scope, cropRect, defringe: desk.export.defringe, bg: desk.export.bg });
        if (win) {
          await printImageInNewWindow(win, blob);
          setStatus(t("tm.printOpenedNewTab"));
        } else {
          // 弹窗被拦 → 降级页内 iframe 打印（可能仍丢图；提示放行弹窗更稳）。
          await printImageBlob(blob, () => board.invalidateAll());
          setStatus(t("tm.popupBlockedInlinePrint"));
        }
      } else if (c.target === "cloud") {
        // v0.9.30 导出到云盘（缺席/无地/加密 前置闸软拒 v0.9.31；导出配置 defringe/底色/选区裁剪全生效）
        const blocked = _cloudSinkBlocked();
        if (blocked) { setStatus(blocked, true); return; }
        const exp = getExporter(c.format) || getExporter("png");
        await withBusy(t("tm.exportingCloud"), async () => {
          const blob = await exp.encode(doc, { scope: c.scope, cropRect, defringe: desk.export.defringe, bg: desk.export.bg });
          await _exportBlobToCloud(blob, exp.ext);
        });
      } else {
        // 文件/分享——以及 #23：iOS/iPad 上「打印」也走这里（分享面板自带打印；PWA 里 window.open 打印脆弱）
        const exp = getExporter(c.target === "print" ? (c.format === "jpg" ? "jpg" : "png") : c.format) || getExporter("png");
        if (exp.busyHint) setStatus(exp.busyHint, true);
        const blob = await exp.encode(doc, { scope: c.scope, cropRect, defringe: desk.export.defringe, bg: desk.export.bg });
        const r = await shareOrDownloadBlob(blob, `${_exportBaseName()}-${stampNow()}.${exp.ext}`, exp.mime);
        setStatus(r.method === "share" ? t("tm.sharePanelOpened") : r.method === "cancel" ? t("tm.shareCancelled") : t("tm.extDownloadedUpper", { ext: exp.ext.toUpperCase() }));
      }
    } catch (e) { reportError(new Error(t("tm.exportFailed", { err: String(errMsg(e)) })), "warning"); }   // #34：剪贴板/分享权限被拒也走 banner，不再静默状态栏
  });
  // v0.5.19（user）：「导入图片」出主菜单——导入文件/剪贴板收进图层窗口 + 菜单（import-image.ts 接线）。

  // v126 (user：「图层窗口的导入照片还是不灵」)
  //   原本这里注册了第二个 click handler 重复触发 picker.click()，
  //   双 click() 在 iPad Safari 上 picker 干脆不开。删掉；layerImportPhotoBtn
  //   已在 line ~1788 通过 _openImagePicker 接管（含 _addImportAsNewDoc 复位）。

  // v0.5.20：统一导出配置（user：选项改下拉框；ora/psd 锁 图层=所有图层、去向=文件、裁剪禁用）。
  //   onApply 每次 change 触发 → 动态锁定就地生效（选回图片格式即解锁）。
  els.menuExportImageConfig.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    const c = _getExpImg();
    const proj0 = _isProjectFormat(c.format);
    const proj0Ora = proj0 && c.format !== "psd";   // v0.9.30：psd 去向可选 file/cloud；ora 锁 file
    const tgt0 = proj0Ora ? "file" : (proj0 && (c.target === "clipboard" || c.target === "print")) ? "file" : (c.target || "file");
    const bg0 = desk.export.bg;
    const bgCustom0 = bg0 !== "transparent" && bg0 !== "#ffffff" && bg0 !== "#000000";
    const fmtOptions = [...listExportersByKind("image"), ...listExportersByKind("project")].map((exp) =>
      `<option value="${exp.id}" ${c.format === exp.id ? "selected" : ""}>${exp.label}</option>`).join("");
    const applyLocks = (popup: HTMLElement) => {
      const fmtSel = popup.querySelector('select[name="fmt"]') as HTMLSelectElement;
      const scopeSel = popup.querySelector('select[name="scope"]') as HTMLSelectElement;
      const tgtSel = popup.querySelector('select[name="tgt"]') as HTMLSelectElement;
      const clipEl = popup.querySelector('input[name="clipsel"]') as HTMLInputElement;
      const defrEl = popup.querySelector('input[name="defringe"]') as HTMLInputElement;
      const proj = _isProjectFormat(fmtSel.value);
      const projOra = proj && fmtSel.value !== "psd";   // v0.9.30：psd 开放 file/cloud 去向；ora（及其他 project 格式）仍锁 file
      if (projOra) { scopeSel.value = "all"; tgtSel.value = "file"; }
      else if (proj) { scopeSel.value = "all"; if (tgtSel.value === "clipboard" || tgtSel.value === "print") tgtSel.value = "file"; }   // psd 无剪贴板/打印语义
      else if (scopeSel.value === "all") scopeSel.value = "merged";   // 「所有图层」仅项目格式可选
      scopeSel.disabled = proj; tgtSel.disabled = projOra;
      (tgtSel.querySelector('option[value="clipboard"]') as HTMLOptionElement).disabled = proj;
      (tgtSel.querySelector('option[value="print"]') as HTMLOptionElement).disabled = proj;
      clipEl.disabled = proj || !doc.selection;
      desk.export.format = fmtSel.value;
      // QA ⑥：ora 锁死去向时不把锁定值写回 desk——切回 png/jpg/psd 后用户的 cloud 偏好还在
      if (!tgtSel.disabled) desk.export.target = tgtSel.value;
      desk.export.layerMode = scopeSel.value;
      if (!clipEl.disabled) desk.export.clipSelection = clipEl.checked;
      // v0.9.14 导出底色：preset radio 直落；自定义走 hex/色名/色温 parse，非法=保留现值（半输入永不生效）。
      //   项目格式（ora/psd）不碰像素 → 整节灰掉。
      const bgChecked = popup.querySelector('input[name="expbg"]:checked') as HTMLInputElement | null;
      const bgInput = popup.querySelector('input[name="expbgc"]') as HTMLInputElement;
      const bgChip = popup.querySelector('[data-role="expbg-chip"]') as HTMLElement;
      popup.querySelectorAll<HTMLInputElement>('input[name="expbg"]').forEach((r) => { r.disabled = proj; });
      if (!proj && bgChecked) {
        if (bgChecked.value !== "custom") desk.export.bg = bgChecked.value;
        else {
          const parsed = normalizeHex(bgInput.value) ?? parseColorName(bgInput.value);
          if (parsed) desk.export.bg = parsed;
        }
      }
      bgInput.disabled = proj || bgChecked?.value !== "custom";
      const bgEff = parseExportBg(desk.export.bg);
      bgChip.style.background = bgEff ? desk.export.bg : "transparent";
      // v0.9.13/14 联动：defringe 只对「PNG 且透明底」有意义（涂了底 α 全 255；JPG 无 alpha；项目格式不碰像素）
      defrEl.disabled = fmtSel.value !== "png" || !!bgEff;
      if (!defrEl.disabled) desk.export.defringe = defrEl.checked;
      _updateMenuSubLabels();
    };
    _openMenuConfigPopup(e.currentTarget as HTMLElement, `
      <div class="menu-config-section">
        <div class="menu-config-title">${t("tm.configFormat")}</div>
        <select name="fmt" class="menu-config-select">${fmtOptions}</select>
      </div>
      <div class="menu-config-section">
        <div class="menu-config-title">${t("tm.configScope")}</div>
        <select name="scope" class="menu-config-select" ${proj0 ? "disabled" : ""}>
          <option value="merged" ${!proj0 && c.scope === "merged" ? "selected" : ""}>${t("tm.mergeAllVisible")}</option>
          <option value="active" ${!proj0 && c.scope === "active" ? "selected" : ""}>${t("tm.onlyActiveLayer")}</option>
          <option value="all" ${proj0 ? "selected" : ""}>${t("tm.scopeAllLayers")}</option>
        </select>
      </div>
      <div class="menu-config-section">
        <div class="menu-config-title">${t("tm.configTarget")}</div>
        <select name="tgt" class="menu-config-select" ${proj0Ora ? "disabled" : ""}>
          <option value="file" ${tgt0 === "file" ? "selected" : ""}>${t("tm.targetFile")}</option>
          <option value="clipboard" ${tgt0 === "clipboard" ? "selected" : ""} ${proj0 ? "disabled" : ""}>${t("tm.targetClipboard")}</option>
          <option value="print" ${tgt0 === "print" ? "selected" : ""} ${proj0 ? "disabled" : ""}>${t("tm.targetPrint")}</option>
          <option value="cloud" ${tgt0 === "cloud" ? "selected" : ""}>${t("tm.targetCloud")}</option>
        </select>
      </div>
      <div class="menu-config-section">
        <div class="menu-config-title">${t("tm.configBg")}</div>
        <label><input type="radio" name="expbg" value="transparent" ${bg0 === "transparent" ? "checked" : ""} ${proj0 ? "disabled" : ""} /> ${t("tm.bgTransparent")}</label>
        <label><input type="radio" name="expbg" value="#ffffff" ${bg0 === "#ffffff" ? "checked" : ""} ${proj0 ? "disabled" : ""} /> ${t("tm.bgWhite")}</label>
        <label><input type="radio" name="expbg" value="#000000" ${bg0 === "#000000" ? "checked" : ""} ${proj0 ? "disabled" : ""} /> ${t("tm.bgBlack")}</label>
        <label><input type="radio" name="expbg" value="custom" ${bgCustom0 ? "checked" : ""} ${proj0 ? "disabled" : ""} /> ${t("tm.bgCustom")}
          <input type="text" name="expbgc" maxlength="24" style="width:9em" placeholder="${t("tm.bgCustomPh")}" value="${bgCustom0 ? bg0 : ""}" ${(proj0 || !bgCustom0) ? "disabled" : ""} />
          <i class="color-chip" data-role="expbg-chip" style="display:inline-block;vertical-align:middle;background:${parseExportBg(bg0) ? bg0 : "transparent"}"></i>
        </label>
      </div>
      <div class="menu-config-section">
        <div class="menu-config-title">${t("tm.configRange")}</div>
        <label><input type="checkbox" name="clipsel" ${c.clipSelection ? "checked" : ""} ${(proj0 || !doc.selection) ? "disabled" : ""} /> ${t("tm.clipToSelection")}${doc.selection ? "" : `（${t("tm.noSelectionNow")}）`}</label>
        <label><input type="checkbox" name="defringe" ${desk.export.defringe ? "checked" : ""} ${(c.format !== "png" || !!parseExportBg(bg0)) ? "disabled" : ""} /> ${t("tm.defringe")}</label>
      </div>
    `, applyLocks);
  });
}
