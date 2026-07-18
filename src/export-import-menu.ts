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
import { triggerDownload, shareOrDownloadBlob, copyImageToClipboard, readImageFromClipboard, printImageBlob, printImageInNewWindow } from "./session.ts";
import { importImageAsLayer } from "./import-image.ts";
import { editorState } from "./editor-state.ts";

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
function _getExpPrj(): { format: string } {
  return { format: editorState.exportProject.format };
}
function _getExpImg(): { format: string; target: string; scope: string } {
  // scope ← editorState.export.layerMode ("merged" | "active")
  return { format: editorState.export.format, target: editorState.export.target, scope: editorState.export.layerMode };
}
function _getImpImg(): { source: string } {
  return { source: editorState.import.source };
}
function _setExpPrj(v: { format: string }) { editorState.exportProject.format = v.format; _updateMenuSubLabels(); }
function _setExpImg(v: { format: string; target: string; scope: string }) {
  editorState.export.format = v.format;
  editorState.export.target = v.target;
  editorState.export.layerMode = v.scope;   // scope → layerMode
  _updateMenuSubLabels();
}
function _setImpImg(v: { source: string }) { editorState.import.source = v.source; _updateMenuSubLabels(); }
function _updateMenuSubLabels() {
  const ep = _getExpPrj();
  const ei = _getExpImg();
  const ii = _getImpImg();
  const epEl = document.getElementById("menuExportProjectSub");
  const eiEl = document.getElementById("menuExportImageSub");
  const iiEl = document.getElementById("menuImportImageSub");
  if (epEl) epEl.textContent = "." + ((getExporter(ep.format) || getExporter("ora")).ext);
  if (eiEl) eiEl.textContent = `${ei.format.toUpperCase()} · ${ei.scope === "active" ? t("sub.activeLayer") : t("sub.merged")} · ${ei.target === "clipboard" ? t("sub.clipboard") : ei.target === "print" ? t("sub.print") : t("sub.file")}`;
  if (iiEl) iiEl.textContent = `${ii.source === "clipboard" ? t("sub.clipboard") : t("sub.file")} · ${t("sub.newLayer")}`;
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

  els.menuExportProject.addEventListener("click", async () => {
    setMenuOpen(false);
    const exp = getExporter(_getExpPrj().format) || getExporter("ora");
    try {
      // 加密作品 + .ora → **原样导出 at-rest 密文容器**（不解不封，因此也不问密码）。
      //   文件名 <名>.ora.zip：诚实反映它是加密容器（与云端 at-rest 命名一致），
      //   也免得被别的 ORA 软件当普通 .ora 打开然后报一个看不懂的错。
      //   导入侧已能嗅探密文容器（import-image 的 looksEncrypted 分支），原样收得回来。
      if (session.enc.encrypted && exp.id === "ora") {
        const cipher = await session.readEncryptedBytes();   // 内部先 saveNow（否则导的是上次保存的旧内容）
        if (!cipher) { setStatus(t("tm.exportNoCipher"), true); return; }
        triggerDownload(cipher, `${session.name}.ora.zip`);
        setStatus(t("tm.dotExtDownloaded", { ext: "ora.zip" }));
        return;
      }
      // 加密作品 + .psd：psd 格式本身不支持加密 → 只能出明文。**user 已明确 consent**
      //   （「导出 psd/png 就当 user consent 了，正常导出」）。不拦、不额外弹窗。
      if (exp.busyHint) setStatus(exp.busyHint, true);
      const blob = await exp.encode(doc);
      triggerDownload(blob, `${session.name}.${exp.ext}`);
      setStatus(t("tm.dotExtDownloaded", { ext: exp.ext }));
    } catch (e) { setStatus(t("tm.exportFailed", { err: String(errMsg(e)) })); }
  });
  els.menuExportImage.addEventListener("click", async () => {
    setMenuOpen(false);
    const c = _getExpImg();
    try {
      if (c.target === "clipboard") {
        // 剪贴板恒为 PNG（ClipboardItem image/png）——格式选择只作用于文件/分享路径
        await copyImageToClipboard(doc, c.scope);
        setStatus(t("tm.copiedPngToClipboard", { scope: c.scope === "active" ? t("tm.scopeActiveLayer") : t("tm.scopeMerged") }));
      } else if (c.target === "print") {
        // 打印恒走位图（PNG）——矢量/ora 之类没意义；scope 仍生效。
        const exp = getExporter(c.format === "jpg" ? "jpg" : "png") || getExporter("png");
        // 首选：新标签页打印（把打印彻底搬离脆弱的 WebGL 页，修 iOS 打印丢图，见 session.ts）。
        //   window.open 必须在此**手势同步期**就开好，不能等 encode 的 await（iOS transient-activation 严）。
        const win = window.open("", "_blank");
        if (exp.busyHint) setStatus(exp.busyHint, true);
        const blob = await exp.encode(doc, { scope: c.scope });
        if (win) {
          await printImageInNewWindow(win, blob);
          setStatus(t("tm.printOpenedNewTab"));
        } else {
          // 弹窗被拦 → 降级页内 iframe 打印（可能仍丢图；提示放行弹窗更稳）。
          await printImageBlob(blob, () => board.invalidateAll());
          setStatus(t("tm.popupBlockedInlinePrint"));
        }
      } else {
        const exp = getExporter(c.format) || getExporter("png");
        if (exp.busyHint) setStatus(exp.busyHint, true);
        const blob = await exp.encode(doc, { scope: c.scope });
        const r = await shareOrDownloadBlob(blob, `${session.name}-${stampNow()}.${exp.ext}`, exp.mime);
        setStatus(r.method === "share" ? t("tm.sharePanelOpened") : r.method === "cancel" ? t("tm.shareCancelled") : t("tm.extDownloadedUpper", { ext: exp.ext.toUpperCase() }));
      }
    } catch (e) { setStatus(t("tm.exportFailed", { err: String(errMsg(e)) })); }
  });
  els.menuImportImage.addEventListener("click", async () => {
    setMenuOpen(false);
    const { source } = _getImpImg();
    if (source === "clipboard") {
      try {
        const blob = await readImageFromClipboard();
        if (!blob) { setStatus(t("tm.clipboardNoImage")); return; }
        const fakeFile = new File([blob], "clipboard.png", { type: blob.type || "image/png" });
        await importImageAsLayer(fakeFile);
      } catch (e) { setStatus(t("tm.clipboardPasteFailed", { err: String(errMsg(e)) })); }
    } else {
      els.oraFileInput.value = "";
      els.oraFileInput.click();
    }
  });

  // v126 (user：「图层窗口的导入照片还是不灵」)
  //   原本这里注册了第二个 click handler 重复触发 picker.click()，
  //   双 click() 在 iPad Safari 上 picker 干脆不开。删掉；layerImportPhotoBtn
  //   已在 line ~1788 通过 _openImagePicker 接管（含 _addImportAsNewDoc 复位）。

  els.menuExportProjectConfig.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    const c = _getExpPrj();
    const fmtRadios = listExportersByKind("project").map((exp) =>
      `<label><input type="radio" name="fmt" value="${exp.id}" ${c.format === exp.id ? "checked" : ""} /> ${exp.label}</label>`
    ).join("");
    _openMenuConfigPopup(e.currentTarget as HTMLElement, `
      <div class="menu-config-section">
        <div class="menu-config-title">${t("tm.configFormat")}</div>
        ${fmtRadios}
      </div>
    `, (popup) => {
      const fmt = (popup.querySelector('input[name="fmt"]:checked') as HTMLInputElement | null)?.value || "ora";
      _setExpPrj({ format: fmt });
    });
  });
  els.menuExportImageConfig.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    const c = _getExpImg();
    const fmtRadios = listExportersByKind("image").map((exp) =>
      `<label><input type="radio" name="fmt" value="${exp.id}" ${c.format === exp.id ? "checked" : ""} /> ${exp.label}</label>`
    ).join("");
    _openMenuConfigPopup(e.currentTarget as HTMLElement, `
      <div class="menu-config-section">
        <div class="menu-config-title">${t("tm.configFormat")}</div>
        ${fmtRadios}
      </div>
      <div class="menu-config-section">
        <div class="menu-config-title">${t("tm.configScope")}</div>
        <label><input type="radio" name="scope" value="merged" ${c.scope === "merged" ? "checked" : ""} /> ${t("tm.mergeAllVisible")}</label>
        <label><input type="radio" name="scope" value="active" ${c.scope === "active" ? "checked" : ""} /> ${t("tm.onlyActiveLayer")}</label>
      </div>
      <div class="menu-config-section">
        <div class="menu-config-title">${t("tm.configTarget")}</div>
        <label><input type="radio" name="tgt" value="file" ${c.target === "file" ? "checked" : ""} /> ${t("tm.targetFile")}</label>
        <label><input type="radio" name="tgt" value="clipboard" ${c.target === "clipboard" ? "checked" : ""} /> ${t("tm.targetClipboard")}</label>
        <label><input type="radio" name="tgt" value="print" ${c.target === "print" ? "checked" : ""} /> ${t("tm.targetPrint")}</label>
      </div>
    `, (popup) => {
      const fmt = (popup.querySelector('input[name="fmt"]:checked') as HTMLInputElement | null)?.value || "png";
      const tgt = (popup.querySelector('input[name="tgt"]:checked') as HTMLInputElement | null)?.value || "file";
      const scope = (popup.querySelector('input[name="scope"]:checked') as HTMLInputElement | null)?.value || "merged";
      _setExpImg({ format: fmt, target: tgt, scope });
    });
  });
  els.menuImportImageConfig.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    const c = _getImpImg();
    _openMenuConfigPopup(e.currentTarget as HTMLElement, `
      <div class="menu-config-section">
        <div class="menu-config-title">${t("tm.configSource")}</div>
        <label><input type="radio" name="src" value="file" ${c.source === "file" ? "checked" : ""} /> ${t("tm.targetFile")}</label>
        <label><input type="radio" name="src" value="clipboard" ${c.source === "clipboard" ? "checked" : ""} /> ${t("tm.targetClipboard")}</label>
      </div>
    `, (popup) => {
      const src = (popup.querySelector('input[name="src"]:checked') as HTMLInputElement | null)?.value || "file";
      _setImpImg({ source: src });
    });
  });
}
