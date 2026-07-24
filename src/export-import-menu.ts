// 职责（单一）：汉堡菜单的「导入 / 导出 / 剪贴板」项 + 导出格式偏好（project / image / import 三组 prefs）
// + 齿轮（🔧）配置 popup + 菜单子标签刷新。
//
// 旧 app.js 「菜单：导入 / 导出 / 剪贴板」区逐字搬来；app.js 短路成 import + initExportImportMenu() 装配。
// 导入/导出偏好存 editorState（per-doc desk state，见 editor-state.ts）；boot 的 _updateMenuSubLabels() 进 init。
// stampNow（导出文件名时间戳）只此处用，一并搬入。
//
// 依赖直 import（叶/单例）：exporters / els / settings-menu(setMenuOpen) / session-state(session) /
//   session.js(下载·分享·剪贴板) / import-image(导入)。
// app 协作件经 ctx 绑入：doc / setStatus（核心单例）。

import { getExporter, listExportersByKind } from "./exporters.ts";
import { els } from "./els.ts";
import { t } from "./i18n/index.ts";
import { setMenuOpen } from "./settings-menu.ts";
import { session } from "./session-state.ts";
import { triggerDownload, shareOrDownloadBlob, copyImageToClipboard, readImageFromClipboard, printImageBlob, printImageInNewWindow, prefersShare } from "./session.ts";
import { importImageAsLayer } from "./import-image.ts";
import { editorState } from "./workbench-state.ts";
import { reportError } from "./error-badge.ts";

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
// - 偏好存 editorState（per-doc desk state，setter 自动标 workspace dirty）
//   getter/setter 返回形保持不变（scope ↔ editorState.export.layerMode 映射），call site 不动。
function _getExpImg(): { format: string; target: string; scope: string; clipSelection: boolean } {
  // scope ← editorState.export.layerMode ("merged" | "active")
  return { format: editorState.export.format, target: editorState.export.target, scope: editorState.export.layerMode, clipSelection: editorState.export.clipSelection };
}
// #16：有选区且开了「仅导出选区范围」→ 选区 bbox（doc 坐标）；否则 null=全文档
function _selCropRect(): { x: number; y: number; w: number; h: number } | null {
  if (!editorState.export.clipSelection) return null;
  const sel = doc.selection as { bboxX: number; bboxY: number; bboxW: number; bboxH: number } | null;
  if (!sel || !(sel.bboxW > 0) || !(sel.bboxH > 0)) return null;
  return { x: sel.bboxX, y: sel.bboxY, w: sel.bboxW, h: sel.bboxH };
}
// v0.5.20：导出图片/导出项目合并为一个「导出」入口——format=ora/psd 即项目语义（所有图层·文件）。
function _isProjectFormat(fmt: string): boolean { return (getExporter(fmt)?.kind ?? "image") === "project"; }
function _updateMenuSubLabels() {
  const ei = _getExpImg();
  const eiEl = document.getElementById("menuExportImageSub");
  if (!eiEl) return;
  if (_isProjectFormat(ei.format)) {
    eiEl.textContent = `.${(getExporter(ei.format) || getExporter("ora")).ext} · ${t("tm.scopeAllLayers")} · ${t("sub.file")}`;
  } else {
    eiEl.textContent = `${ei.format.toUpperCase()} · ${ei.scope === "active" ? t("sub.activeLayer") : t("sub.merged")} · ${ei.target === "clipboard" ? t("sub.clipboard") : ei.target === "print" ? t("sub.print") : t("sub.file")}${ei.clipSelection ? " · " + t("sub.selection") : ""}`;
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
  // desk 载入：换画后导入导出偏好（editorState）变了 → 刷新折叠菜单 sub-label（值本身按需读，无数据问题；仅显示同步）。
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
          triggerDownload(cipher, `${session.name}.ora.zip`);
          setStatus(t("tm.dotExtDownloaded", { ext: "ora.zip" }));
          return;
        }
        // 加密 + .psd：格式不支持加密 → 出明文（user 已 consent：「导出 psd/png 就当 consent 了」）。
        if (exp.busyHint) setStatus(exp.busyHint, true);
        const blob = await exp.encode(doc);
        triggerDownload(blob, `${session.name}.${exp.ext}`);
        setStatus(t("tm.dotExtDownloaded", { ext: exp.ext }));
      } catch (e) { setStatus(t("tm.exportFailed", { err: String(errMsg(e)) })); }
      return;
    }
    const cropRect = _selCropRect();   // #16：仅导出选区范围（三种去向统一生效）
    try {
      if (c.target === "clipboard") {
        // 剪贴板恒为 PNG（ClipboardItem image/png）——格式选择只作用于文件/分享路径
        await copyImageToClipboard(doc, c.scope, cropRect);
        setStatus(t("tm.copiedPngToClipboard", { scope: c.scope === "active" ? t("tm.scopeActiveLayer") : t("tm.scopeMerged") }));
      } else if (c.target === "print" && !prefersShare()) {
        // 打印恒走位图（PNG）——矢量/ora 之类没意义；scope 仍生效。
        const exp = getExporter(c.format === "jpg" ? "jpg" : "png") || getExporter("png");
        // 首选：新标签页打印（把打印彻底搬离脆弱的 WebGL 页，修 iOS 打印丢图，见 session.ts）。
        //   window.open 必须在此**手势同步期**就开好，不能等 encode 的 await（iOS transient-activation 严）。
        const win = window.open("", "_blank");
        if (exp.busyHint) setStatus(exp.busyHint, true);
        const blob = await exp.encode(doc, { scope: c.scope, cropRect });
        if (win) {
          await printImageInNewWindow(win, blob);
          setStatus(t("tm.printOpenedNewTab"));
        } else {
          // 弹窗被拦 → 降级页内 iframe 打印（可能仍丢图；提示放行弹窗更稳）。
          await printImageBlob(blob, () => board.invalidateAll());
          setStatus(t("tm.popupBlockedInlinePrint"));
        }
      } else {
        // 文件/分享——以及 #23：iOS/iPad 上「打印」也走这里（分享面板自带打印；PWA 里 window.open 打印脆弱）
        const exp = getExporter(c.target === "print" ? (c.format === "jpg" ? "jpg" : "png") : c.format) || getExporter("png");
        if (exp.busyHint) setStatus(exp.busyHint, true);
        const blob = await exp.encode(doc, { scope: c.scope, cropRect });
        const r = await shareOrDownloadBlob(blob, `${session.name}-${stampNow()}.${exp.ext}`, exp.mime);
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
    const fmtOptions = [...listExportersByKind("image"), ...listExportersByKind("project")].map((exp) =>
      `<option value="${exp.id}" ${c.format === exp.id ? "selected" : ""}>${exp.label}</option>`).join("");
    const applyLocks = (popup: HTMLElement) => {
      const fmtSel = popup.querySelector('select[name="fmt"]') as HTMLSelectElement;
      const scopeSel = popup.querySelector('select[name="scope"]') as HTMLSelectElement;
      const tgtSel = popup.querySelector('select[name="tgt"]') as HTMLSelectElement;
      const clipEl = popup.querySelector('input[name="clipsel"]') as HTMLInputElement;
      const proj = _isProjectFormat(fmtSel.value);
      if (proj) { scopeSel.value = "all"; tgtSel.value = "file"; }
      else if (scopeSel.value === "all") scopeSel.value = "merged";   // 「所有图层」仅项目格式可选
      scopeSel.disabled = proj; tgtSel.disabled = proj;
      clipEl.disabled = proj || !doc.selection;
      editorState.export.format = fmtSel.value;
      editorState.export.target = tgtSel.value;
      editorState.export.layerMode = scopeSel.value;
      if (!clipEl.disabled) editorState.export.clipSelection = clipEl.checked;
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
        <select name="tgt" class="menu-config-select" ${proj0 ? "disabled" : ""}>
          <option value="file" ${proj0 || c.target === "file" ? "selected" : ""}>${t("tm.targetFile")}</option>
          <option value="clipboard" ${!proj0 && c.target === "clipboard" ? "selected" : ""}>${t("tm.targetClipboard")}</option>
          <option value="print" ${!proj0 && c.target === "print" ? "selected" : ""}>${t("tm.targetPrint")}</option>
        </select>
      </div>
      <div class="menu-config-section">
        <div class="menu-config-title">${t("tm.configRange")}</div>
        <label><input type="checkbox" name="clipsel" ${c.clipSelection ? "checked" : ""} ${(proj0 || !doc.selection) ? "disabled" : ""} /> ${t("tm.clipToSelection")}${doc.selection ? "" : `（${t("tm.noSelectionNow")}）`}</label>
      </div>
    `, applyLocks);
  });
}
