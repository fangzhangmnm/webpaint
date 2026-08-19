// Timelapse UI（spec=ai-docs/20260819-timelapse-spec.md §3；user 2026-08-19 二轮返工）：
//   菜单「过程录像…」入口 + 面板（可拖）。未开录=设置面（比例 chips / 最长边 + ≈体积参考）；
//   已开录=**一行控制**：[暂停|继续] [回放] [导出] [⋯→清除]（user：清除太显眼，藏进 ⋯）。
//   回放 = 画布全屏 overlay；回放/导出 = timelapseSnapshotMp4 内存临时 mux（新鲜且零落盘——
//   v0.9.17 曾静默 session.save()，user 否决：save 节律不许被回放劫持）。
// 体积显示 = 单位双层制的 UX 层：1024 进位 + MiB 标签（GB 以下永远 MiB、<0.1MiB 兜底；spec §4）。
import { els } from "./els.ts";
import { t } from "./i18n/index.ts";
import { setMenuOpen } from "./settings-menu.ts";
import { openConfirmSheet } from "./sheets.ts";
import { triggerDownload } from "./session.ts";
import { reportError } from "./error-badge.ts";
import {
  timelapseStatus, timelapseStart, timelapsePause, timelapseResume, timelapseClear, timelapseSnapshotMp4,
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
let _moreOpen = false;          // ⋯ 溢出行开合（session 态，不持久化）
let _currentDocName: () => string = () => "";

export function initTimelapseUi(currentDocName: () => string): void {
  _currentDocName = currentDocName;
  els.menuTimelapse.addEventListener("click", () => { setMenuOpen(false); _openPanel(); });
  els.tlRecChip.addEventListener("click", () => _openPanel());
  els.tlPanelClose.addEventListener("click", () => els.tlPanel.classList.add("hidden"));
  _wireDrag();
  window.addEventListener("wp:timelapse-changed", () => {
    _renderChip(); _renderMenuState();
    if (!els.tlPanel.classList.contains("hidden")) _renderPanel();
  });
  _renderChip(); _renderMenuState();
}

function _openPanel(): void { _moreOpen = false; els.tlPanel.classList.remove("hidden"); _renderPanel(); }

// 拖标题栏移动（同 colorPanel 手势；位置 session 态不持久化）
function _wireDrag(): void {
  let drag: { id: number; sx: number; sy: number; ol: number; ot: number } | null = null;
  els.tlPanelHead.addEventListener("pointerdown", (e: PointerEvent) => {
    if ((e.target as HTMLElement | null)?.closest(".close-x")) return;
    const r = els.tlPanel.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ol: r.left, ot: r.top };
    els.tlPanelHead.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  els.tlPanelHead.addEventListener("pointermove", (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const w = els.tlPanel.offsetWidth, h = els.tlPanel.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth - w, drag.ol + (e.clientX - drag.sx)));
    const top = Math.max(60, Math.min(window.innerHeight - h, drag.ot + (e.clientY - drag.sy)));   // top 地板=出血区（同 colorPanel）
    els.tlPanel.style.left = left + "px";
    els.tlPanel.style.top = top + "px";
  });
  els.tlPanelHead.addEventListener("pointerup", (e: PointerEvent) => {
    if (drag && e.pointerId === drag.id) {
      try { els.tlPanelHead.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
      drag = null;
    }
  });
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

// ---- 面板渲染（两态：未开录=设置面；已开录=一行控制）----
function _renderPanel(): void {
  const s = timelapseStatus();
  const body = els.tlPanelBody;
  body.textContent = "";

  if (s.supported === false) { body.appendChild(_note(t("tl.unsupported"))); return; }
  if (s.supported === null) { body.appendChild(_note(t("tl.probing"))); return; }

  if (!s.exists) {
    // —— 设置面：比例 chips + 最长边（≈参考体积）+ 开录 ——
    body.appendChild(_label(t("tl.aspect")));
    body.appendChild(_chips(TIMELAPSE_ASPECTS.map(([w, h]) => ({
      label: `${w}:${h}`,
      pressed: _selAspect[0] === w && _selAspect[1] === h,
      onPick: () => { _selAspect = [w, h]; _renderPanel(); },
    }))));
    body.appendChild(_label(t("tl.longEdge")));
    body.appendChild(_chips(TIMELAPSE_LONG_EDGES.map((px) => ({
      label: `${px}`,
      sub: `≈${formatMiB(timelapseTier(px).refBytes)}`,   // 参考不是承诺（发版前 dogfood 校准）
      pressed: _selLongEdge === px,
      onPick: () => { _selLongEdge = px; _renderPanel(); },
    }))));
    body.appendChild(_note(t("tl.lockedNote")));
    const actions = _div("tl-actions");
    actions.appendChild(_btn(t("tl.start"), "tl-primary", () => {
      try {
        timelapseStart({ aspectW: _selAspect[0], aspectH: _selAspect[1], longEdge: _selLongEdge });
      } catch (e) { reportError(e, "warning"); }
      _renderPanel();
    }));
    body.appendChild(actions);
    return;
  }

  // —— 控制面：状态行 + 一行按钮 ——
  const st = _div("tl-statusline");
  const dot = document.createElement("span");
  dot.className = "tl-rec-dot"; if (!s.on) dot.style.animation = "none";
  dot.style.background = s.on ? "#e5484d" : "var(--ink-soft)";
  st.appendChild(dot);
  const parts = [s.on ? t("tl.state.recording") : t("tl.state.paused")];
  parts.push(`${s.settings!.aspectW}:${s.settings!.aspectH} · ${s.settings!.longEdge}px`);
  if (s.bytes > 0) parts.push(formatMiB(s.bytes));
  if (s.pendingFrames > 0) parts.push(t("tl.pendingFrames", { n: String(s.pendingFrames) }));
  st.appendChild(document.createTextNode(parts.join(" · ")));
  body.appendChild(st);

  const noFootage = s.bytes === 0 && s.pendingFrames === 0;
  const row = _div("tl-actions");
  row.appendChild(_btn(s.on ? t("tl.pause") : t("tl.resume"), s.on ? "" : "tl-primary", () => {
    if (timelapseStatus().on) timelapsePause(); else timelapseResume();
  }));
  const replayBtn = _btn(t("tl.preview"), "", () => { void _replayFullscreen(); });
  const exportBtn = _btn(t("tl.export"), "", () => { void _exportFresh(); });
  replayBtn.disabled = exportBtn.disabled = noFootage;
  row.appendChild(replayBtn);
  row.appendChild(exportBtn);
  const more = _btn("⋯", "tl-more", () => { _moreOpen = !_moreOpen; _renderPanel(); });
  more.setAttribute("aria-expanded", String(_moreOpen));
  row.appendChild(more);
  body.appendChild(row);

  if (_moreOpen) {
    const overflow = _div("tl-actions");
    overflow.appendChild(_btn(t("tl.clear"), "tl-danger", async () => {
      const ok = await openConfirmSheet(t("tl.clearConfirmTitle"), t("tl.clearConfirmMsg"));
      if (!ok) return;
      timelapseClear();   // 不可 undo（非绘画操作）；下次保存时 ora 内 entry 随之消失
      _moreOpen = false;
    }));
    body.appendChild(overflow);
  }
}

/** 拿**新鲜**的 mp4：内存临时 mux（纯函数零落盘）——绝不静默 save（save 是 user consent 的事，
 *  user 2026-08-19 否决了 v0.9.17 的回放前自动落盘）。 */
async function _freshMp4(): Promise<Uint8Array | null> {
  return await timelapseSnapshotMp4();
}

async function _exportFresh(): Promise<void> {
  const bytes = await _freshMp4();
  if (!bytes) return;
  // Uint8Array → 独立 ArrayBuffer 拷贝（防 BlobPart 收窄/共享 buffer 偏移坑）
  triggerDownload(new Blob([bytes.slice().buffer], { type: "video/mp4" }), `${_currentDocName()} timelapse.mp4`);
}

// ---- 画布全屏回放 overlay ----
let _overlay: { root: HTMLElement; video: HTMLVideoElement; url: string | null } | null = null;

async function _replayFullscreen(): Promise<void> {
  const bytes = await _freshMp4();
  if (!bytes) return;
  if (!_overlay) {
    const root = document.createElement("div");
    root.className = "tl-preview-overlay hidden";
    const video = document.createElement("video");
    video.className = "tl-preview-video";
    video.controls = true; video.muted = true; video.loop = false;
    video.setAttribute("playsinline", "");   // iPad 全屏 PWA：防 iOS 原生全屏劫持
    const close = document.createElement("button");
    close.type = "button"; close.className = "tl-preview-close";
    close.setAttribute("aria-label", t("common.close.aria"));
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#x"/></svg>';
    close.addEventListener("click", _closeOverlay);
    root.addEventListener("click", (e) => { if (e.target === root) _closeOverlay(); });   // 点黑边关
    window.addEventListener("keydown", (e) => { if (e.key === "Escape" && _overlay && !_overlay.root.classList.contains("hidden")) _closeOverlay(); });
    root.appendChild(video); root.appendChild(close);
    document.body.appendChild(root);
    _overlay = { root, video, url: null };
  }
  if (_overlay.url) URL.revokeObjectURL(_overlay.url);
  _overlay.url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "video/mp4" }));
  _overlay.video.src = _overlay.url;
  _overlay.root.classList.remove("hidden");
  _overlay.video.play().catch(() => { /* 自动播放被拒 → 用户点原生 controls */ });
}

function _closeOverlay(): void {
  if (!_overlay) return;
  _overlay.video.pause();
  _overlay.root.classList.add("hidden");
  _overlay.video.removeAttribute("src"); _overlay.video.load();
  if (_overlay.url) { URL.revokeObjectURL(_overlay.url); _overlay.url = null; }
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
function _chips(items: Array<{ label: string; sub?: string; pressed: boolean; onPick: () => void }>): HTMLDivElement {
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
