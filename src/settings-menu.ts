// 职责（单一）：汉堡 ⋯ 菜单面板——设置开关（压·粗 / 压·透 / 长按吸色 / 透明棋盘 / 像素栅格 /
// 主题 / 检测更新 stub / 清空 stub）+ 快捷键 sheet（从 KEYBOARD_SHORTCUTS 自动渲染）+ 菜单开关。
//
// 旧 app.js 「汉堡菜单」区逐字搬来；app.js 短路成 import + initSettingsMenu() 装配。
// setMenuOpen export 给 ctx（doc-ops 等也调）；boot 的 apply* 初始化调用进 initSettingsMenu()。
//
// 仍留 app.js 的协作件经 ctx 绑入：state / board / setStatus / store / updateSaveStatus（核心单例）。

import { els } from "./els.ts";
import { safeLS, safeLSSet } from "./safe-ls.ts";
import { applyTheme, cycleTheme, THEME_LABEL } from "./theme.ts";
import { KEYBOARD_SHORTCUTS } from "./input.js";
import { _updateMenuCropLabel } from "./doc-ops.ts";

let state: any, board: any, setStatus: any, store: any, updateSaveStatus: any;

// openSheet/closeSheet：app.js-local 小工具被快捷键 sheet 用，inline 复制一份（app 仍各自保留）
function openSheet(sheet: any, backdrop: any) {
  backdrop.classList.remove("hidden");
  sheet.classList.remove("hidden");
}
function closeSheet(sheet: any, backdrop: any) {
  backdrop.classList.add("hidden");
  sheet.classList.add("hidden");
}

function setMenuItem(btn: any, on: any, stateLabel = on ? "开" : "关") {
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  const st = btn.querySelector('.menu-item-state');
  if (st) st.textContent = stateLabel;
}

function applyPressureSize(on: any) {
  state.pressureToSize = !!on;           // 全局开关 SSoT（反应式 → currentBrush 自动重派生）
  setMenuItem(els.menuPressureSize, on);
  safeLSSet("webpaint.pToSize", on ? "1" : "0");
}
function applyPressureOpacity(on: any) {
  state.pressureToOpacity = !!on;        // 反应式 → currentBrush 自动重派生
  setMenuItem(els.menuPressureOpacity, on);
  safeLSSet("webpaint.pToOpacity", on ? "1" : "0");
}
function applyLongPressPick(on: any) {
  state.longPressPick = !!on;
  setMenuItem(els.menuLongPressPick, on);
  safeLSSet("webpaint.longPressPick", on ? "1" : "0");
}
export function applyCheckerboard(on: any) {
  // v125: checkerboard per-doc，不再写 localStorage
  state.checkerboard = !!on;
  setMenuItem(els.menuCheckerboard, on);
  board.setShowCheckerboard?.(!!on);
  board.invalidateAll();
  board.requestRender();
}

// v163 像素栅格：全局开关（视图辅助，跟设备不跟文件），localStorage 持久化，默认开
function applyPixelGrid(on: any) {
  board.setPixelGridEnabled?.(!!on);
  setMenuItem(els.menuPixelGrid, !!on);
  safeLSSet("webpaint.pixelGrid", on ? "1" : "0");
}

// v124 快捷键 sheet：从 KEYBOARD_SHORTCUTS 自动渲染（input.js 注册的唯一真理源）
const _shortcutsSheet = document.getElementById("shortcutsSheet");
const _shortcutsBackdrop = document.getElementById("shortcutsBackdrop");
const _shortcutsBody = document.getElementById("shortcutsBody");
function _renderShortcutsSheet() {
  if (!_shortcutsBody) return;
  const byCat = new Map();
  for (const sc of KEYBOARD_SHORTCUTS) {
    const cat = sc.category || "其它";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(sc);
  }
  // 同 combo 多 entry（如 Escape 在 floating / hasSelection 两条）合并展示
  let html = "";
  for (const [cat, list] of byCat) {
    html += `<div class="shortcuts-category">${cat}</div>`;
    for (const sc of list) {
      html += `<div class="shortcuts-row"><span>${sc.desc}</span><span class="shortcuts-combo">${sc.combo}</span></div>`;
    }
  }
  _shortcutsBody.innerHTML = html;
}

export function setMenuOpen(open: any) {
  els.menuPanel.classList.toggle("hidden", !open);
  els.menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    // v124 menu panel 跟随菜单按钮屏坐标（top-bar 居中 transform，
    // 用 viewport 写死的 left: 12px 在宽屏上对不齐图标）
    const r = els.menuBtn.getBoundingClientRect();
    els.menuPanel.style.top = (r.bottom + 6) + "px";
    els.menuPanel.style.left = r.left + "px";
    els.menuPanel.style.right = "auto";
    _updateMenuCropLabel?.();
  }
}

export function initSettingsMenu(ctx) {
  ({ state, board, setStatus, store, updateSaveStatus } = ctx);

  els.menuPressureSize.addEventListener("click", () => {
    applyPressureSize(!state.pressureToSize);
    setStatus(`压·粗 · ${state.pressureToSize ? "开" : "关"}`);
  });
  els.menuPressureOpacity.addEventListener("click", () => {
    applyPressureOpacity(!state.pressureToOpacity);
    setStatus(`压·透 · ${state.pressureToOpacity ? "开" : "关"}`);
  });
  els.menuLongPressPick.addEventListener("click", () => {
    applyLongPressPick(!state.longPressPick);
    setStatus(`长按吸色 · ${state.longPressPick ? "开" : "关"}`);
  });
  els.menuCheckerboard.addEventListener("click", () => {
    applyCheckerboard(!state.checkerboard);
    // UI 态不 mark dirty（user 2026-06-10）：棋盘是观感开关，下次真编辑保存时顺手捞进 state.json。
    //   不再 edits.mark()——否则切个棋盘就让已同步的画变「未保存」。
    setStatus(`透明棋盘 · ${state.checkerboard ? "开" : "关"}`);
  });

  applyPixelGrid(safeLS("webpaint.pixelGrid") !== "0");   // boot：缺省=开
  if (els.menuPixelGrid) els.menuPixelGrid.addEventListener("click", () => {
    const next = !board.getPixelGridEnabled();
    applyPixelGrid(next);
    setStatus(`像素栅格 · ${next ? "开" : "关"}`);
  });
  els.menuTheme.addEventListener("click", () => {
    const next = cycleTheme();
    applyTheme(next);
    setStatus(`主题 · ${THEME_LABEL[next]}`);
  });
  // v100：删「检测更新」menu (实测在 iPad PWA 上不可靠，user：「检测更新功能没用」)。
  // 强制更新一律走「强制清缓存重启」（menuForcePwaReset）— 详 docs/pwa-update-detection.md。
  // 老 element 在 HTML 里 hidden，handler 留空保 element exists 防 null deref。
  if (els.menuCheckUpdate) els.menuCheckUpdate.addEventListener("click", () => setMenuOpen(false));
  // v124b: menuClear 撤了（user：「清空内容跟删除重复，删掉」）。stub 留兜底
  if (els.menuClear) els.menuClear.addEventListener("click", () => setMenuOpen(false));

  document.getElementById("menuShortcuts")?.addEventListener("click", () => {
    setMenuOpen(false);
    _renderShortcutsSheet();
    openSheet(_shortcutsSheet, _shortcutsBackdrop);
  });
  document.getElementById("shortcutsClose")?.addEventListener("click", () => closeSheet(_shortcutsSheet, _shortcutsBackdrop));
  _shortcutsBackdrop?.addEventListener("click", () => closeSheet(_shortcutsSheet, _shortcutsBackdrop));

  applyPressureSize(state.pressureToSize);
  applyPressureOpacity(state.pressureToOpacity);
  applyLongPressPick(state.longPressPick);
  applyCheckerboard(state.checkerboard);

  els.menuBtn.addEventListener("click", (e: any) => {
    e.stopPropagation();
    setMenuOpen(els.menuPanel.classList.contains("hidden"));
  });
  document.addEventListener("pointerdown", (e: any) => {
    if (els.menuPanel.classList.contains("hidden")) return;
    if (els.menuPanel.contains(e.target) || els.menuBtn.contains(e.target)) return;
    setMenuOpen(false);
  });
}
