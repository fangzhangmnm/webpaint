// Timelapse UI（spec=ai-docs/20260819-timelapse-spec.md §3）：
//   菜单「过程录像…」入口 + 开录面板（比例 chips / 最长边 + ≈体积参考）+ 录制控制
//   （暂停/继续/预览/导出/清除二次确认）+ HUD 红点 chip（录制中全局常驻，只有红点+短词）。
// 体积显示 = 单位双层制的 UX 层：1024 进位 + MiB 标签（与 OneDrive 数值对账一致），
//   GB 以下永远 MiB、<0.1MiB 显示 "<0.1MiB"（spec §4；gallery 旧 humanSize 的收敛是另案支线）。
import { els } from "./els.ts";
import { t } from "./i18n/index.ts";
import { setMenuOpen } from "./settings-menu.ts";
import { openConfirmSheet } from "./sheets.ts";
import { triggerDownload } from "./session.ts";
import { reportError } from "./error-badge.ts";
import {
  timelapseStatus, timelapseStart, timelapsePause, timelapseResume, timelapseClear, timelapseMp4,
  type TimelapseStatus,
} from "./timelapse-session.ts";
import { TIMELAPSE_ASPECTS, TIMELAPSE_LONG_EDGES, TIMELAPSE_DEFAULT_SETTINGS, timelapseTier } from "./backend/timelapse/timelapse-core.ts";

/** UX 层体积显示（MiB-only；数据层裸字节）。 */
export function formatMiB(bytes: number): string {
  const mib = bytes / 1048576;
  if (mib < 0.1) return "<0.1MiB";
  if (mib < 10) return `${mib.toFixed(1)}MiB`;
  return `${Math.round(mib)}MiB`;
}

// 开录面板的待选值（未 pin 前的 UI 状态；开录后以 status.settings 为准）
let _selAspect: readonly [number, number] = [TIMELAPSE_DEFAULT_SETTINGS.aspectW, TIMELAPSE_DEFAULT_SETTINGS.aspectH];
let _selLongEdge = TIMELAPSE_DEFAULT_SETTINGS.longEdge;
let _previewUrl: string | null = null;

export function initTimelapseUi(currentDocName: () => string): void {
  els.menuTimelapse.addEventListener("click", () => { setMenuOpen(false); _openPanel(); });
  els.tlRecChip.addEventListener("click", () => _openPanel());
  els.tlPanelClose.addEventListener("click", () => _closePanel());
  window.addEventListener("wp:timelapse-changed", () => { _renderChip(); _renderMenuState(); if (!els.tlPanel.classList.contains("hidden")) _renderPanel(currentDocName); });
  _renderChip(); _renderMenuState();

  function _openPanel(): void { els.tlPanel.classList.remove("hidden"); _renderPanel(currentDocName); }
}

function _closePanel(): void {
  els.tlPanel.classList.add("hidden");
  _revokePreview();
}

function _revokePreview(): void {
  if (_previewUrl) { URL.revokeObjectURL(_previewUrl); _previewUrl = null; }
}

// ---- HUD 红点 chip（安全护栏：录制中全局常驻可见；暂停=灰点不呼吸）----
function _renderChip(): void {
  const s = timelapseStatus();
  const show = s.exists;   // 开过录就常驻（含暂停态——用户得知道这张画身上有录像）
  els.tlRecChip.classList.toggle("hidden", !show);
  els.tlRecChip.classList.toggle("tl-paused", show && !s.on);
}

function _renderMenuState(): void {
  const s = timelapseStatus();
  els.menuTimelapseState.textContent =
    !s.exists ? "" : s.on ? t("tl.state.recording") : t("tl.state.paused");
}

// ---- 面板渲染（两态：未开录=设置面；已开录=控制面）----
function _renderPanel(currentDocName: () => string): void {
  const s = timelapseStatus();
  const body = els.tlPanelBody;
  _revokePreview();
  body.textContent = "";

  if (s.supported === false) { body.appendChild(_note(t("tl.unsupported"))); return; }
  if (s.supported === null) { body.appendChild(_note(t("tl.probing"))); return; }

  if (!s.exists) {
    // —— 设置面：比例 chips + 最长边（≈参考体积）+ 开录 ——
    body.appendChild(_label(t("tl.aspect")));
    const aspects = _chips(TIMELAPSE_ASPECTS.map(([w, h]) => ({
      key: `${w}:${h}`, label: `${w}:${h}`,
      pressed: _selAspect[0] === w && _selAspect[1] === h,
      onPick: () => { _selAspect = [w, h]; _renderPanel(currentDocName); },
    })));
    body.appendChild(aspects);
    body.appendChild(_label(t("tl.longEdge")));
    const edges = _chips(TIMELAPSE_LONG_EDGES.map((px) => ({
      key: String(px), label: `${px}`,
      sub: `≈${formatMiB(timelapseTier(px).refBytes)}`,   // 参考不是承诺（发版前 dogfood 校准）
      pressed: _selLongEdge === px,
      onPick: () => { _selLongEdge = px; _renderPanel(currentDocName); },
    })));
    body.appendChild(edges);
    body.appendChild(_note(t("tl.lockedNote")));
    const actions = _div("tl-actions");
    actions.appendChild(_btn(t("tl.start"), "tl-primary", () => {
      try {
        timelapseStart({ aspectW: _selAspect[0], aspectH: _selAspect[1], longEdge: _selLongEdge });
      } catch (e) { reportError(e, "warning"); }
      _renderPanel(currentDocName);
    }));
    body.appendChild(actions);
    return;
  }

  // —— 控制面 ——
  const st = _div("tl-statusline");
  const dot = document.createElement("span");
  dot.className = "tl-rec-dot"; if (!s.on) dot.style.animation = "none";
  dot.style.background = s.on ? "#e5484d" : "var(--ink-soft)";
  st.appendChild(dot);
  const parts = [s.on ? t("tl.state.recording") : t("tl.state.paused")];
  parts.push(`${s.settings!.aspectW}:${s.settings!.aspectH} · ${s.settings!.longEdge}px`);
  if (s.bytes > 0) parts.push(formatMiB(s.bytes));
  st.appendChild(document.createTextNode(parts.join(" · ")));
  body.appendChild(st);
  if (s.pendingFrames > 0) body.appendChild(_note(t("tl.pendingFrames", { n: String(s.pendingFrames) })));

  const actions = _div("tl-actions");
  actions.appendChild(_btn(s.on ? t("tl.pause") : t("tl.resume"), s.on ? "" : "tl-primary", () => {
    if (s.on) timelapsePause(); else timelapseResume();
  }));
  const mp4 = timelapseMp4();
  const previewBtn = _btn(t("tl.preview"), "", () => _showPreview(body));
  const exportBtn = _btn(t("tl.export"), "", () => {
    const bytes = timelapseMp4();
    if (!bytes) return;
    // Uint8Array → 独立 ArrayBuffer 拷贝（防 BlobPart 收窄/共享 buffer 偏移坑）
    triggerDownload(new Blob([bytes.slice().buffer], { type: "video/mp4" }), `${currentDocName()} timelapse.mp4`);
  });
  if (!mp4) { previewBtn.disabled = true; exportBtn.disabled = true; }
  actions.appendChild(previewBtn);
  actions.appendChild(exportBtn);
  actions.appendChild(_btn(t("tl.clear"), "tl-danger", async () => {
    const ok = await openConfirmSheet(t("tl.clearConfirmTitle"), t("tl.clearConfirmMsg"));
    if (!ok) return;
    timelapseClear();   // 不可 undo（非绘画操作）；下次保存时 ora 内 entry 随之消失
  }));
  body.appendChild(actions);
  if (!mp4) body.appendChild(_note(t("tl.saveToExport")));
}

function _showPreview(body: HTMLElement): void {
  const bytes = timelapseMp4();
  if (!bytes) return;
  _revokePreview();
  let video = body.querySelector<HTMLVideoElement>("video.tl-video");
  if (!video) {
    video = document.createElement("video");
    video.className = "tl-video";
    video.controls = true;
    video.muted = true;
    // iPad 全屏 PWA：防 iOS 原生全屏劫持（spec §8 防坑清单）
    video.setAttribute("playsinline", "");
    body.appendChild(video);
  }
  _previewUrl = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "video/mp4" }));
  video.src = _previewUrl;
  video.play().catch(() => { /* 自动播放被拒 → 用户点原生 controls */ });
}

// ---- 小件 ----
function _div(cls: string): HTMLDivElement { const d = document.createElement("div"); d.className = cls; return d; }
function _label(text: string): HTMLDivElement { const d = _div("tl-row-label"); d.textContent = text; return d; }
function _note(text: string): HTMLDivElement { const d = _div("tl-note"); d.textContent = text; return d; }
function _btn(label: string, extraCls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button"; b.className = `tl-btn${extraCls ? " " + extraCls : ""}`; b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
function _chips(items: Array<{ key: string; label: string; sub?: string; pressed: boolean; onPick: () => void }>): HTMLDivElement {
  const wrap = _div("tl-chips");
  for (const it of items) {
    const c = document.createElement("button");
    c.type = "button"; c.className = "tl-chip"; c.setAttribute("aria-pressed", String(it.pressed));
    c.textContent = it.label;
    if (it.sub) { const s = document.createElement("span"); s.className = "tl-chip-sub"; s.textContent = it.sub; c.appendChild(s); }
    c.addEventListener("click", it.onPick);
    wrap.appendChild(c);
  }
  return wrap;
}
