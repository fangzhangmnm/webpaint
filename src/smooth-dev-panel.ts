// 职责（单一）：v158 平滑调参 dev 面板——读/写 SMOOTH 配置的 dev 调参浮层 + 菜单入口。
//
// 所有平滑魔数：连续用 textbox（可打任意数量级值 → 自测是否真起作用/跳出饱和区，杀煤气灯）、二元用 checkbox。
// live 改 SMOOTH + localStorage 持久化；下一笔生效。详 docs/stroke-smoother-time-gate.md。
//
// 协作件经 ctx 绑入：setStatus（状态行）。SMOOTH 配置直接 import；els / setMenuOpen 直接 import。

import { SMOOTH, SMOOTH_DEFAULTS, saveSmooth, resetSmooth } from "./smooth-config.js";
import { els } from "./els.ts";
import { setMenuOpen } from "./settings-menu.ts";
import type { AppContext } from "./app-context.ts";

let setStatus: AppContext["setStatus"];

const _SMOOTH_LABELS: Record<string, string> = {
  tauMaxMs:           "streamline=1 时间常数 tau (ms, 越大越平滑/越拖)",
  tailBow:            "弧 tail 增益 (1=自然, >1 更鼓, 0=直)",
  stabMaxPx:          "stabilization=1 死区半径 (screen px)",
  rawStaticSq:        "raw 静止门限 (screen px²)",
  pressureAlpha:      "压感 EMA α (input 端去尖刺, 0..1)",
};
let _smoothDevPanel: HTMLDivElement | null = null;
function _refreshSmoothInputs(p: HTMLElement) {
  for (const el of p.querySelectorAll<HTMLInputElement>("[data-skey]")) {
    const SM = SMOOTH as Record<string, number | boolean>;
    const k = el.dataset.skey!;
    if (el.type === "checkbox") el.checked = !!SM[k];
    else el.value = String(SM[k]);
  }
}
function _buildSmoothDevPanel() {
  const p = document.createElement("div");
  p.style.cssText = "position:fixed;right:12px;top:60px;z-index:300;background:var(--panel,#fff);color:var(--ink,#222);border:1px solid var(--line,#ccc);border-radius:10px;padding:12px 14px;font:12px/1.5 system-ui;box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:300px";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:8px";
  head.innerHTML = "<span>平滑调参 (dev)</span>";
  const close = document.createElement("button");
  close.textContent = "×";
  close.style.cssText = "border:none;background:none;font-size:18px;line-height:1;cursor:pointer;color:inherit";
  close.addEventListener("click", () => { p.style.display = "none"; });
  head.appendChild(close);
  p.appendChild(head);
  for (const k of Object.keys(SMOOTH_DEFAULTS)) {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:8px;margin:5px 0";
    const lbl = document.createElement("span");
    lbl.textContent = _SMOOTH_LABELS[k] || k;
    const SM = SMOOTH as Record<string, number | boolean>; const SD = SMOOTH_DEFAULTS as Record<string, number | boolean>;
    lbl.style.cssText = "flex:1";
    row.appendChild(lbl);
    if (typeof SD[k] === "boolean") {
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.dataset.skey = k; cb.checked = !!SM[k];
      cb.addEventListener("change", () => { SM[k] = cb.checked; saveSmooth(); });
      row.appendChild(cb);
    } else {
      const tb = document.createElement("input");
      tb.type = "text"; tb.inputMode = "decimal"; tb.dataset.skey = k; tb.value = String(SM[k]);
      tb.style.cssText = "width:74px;text-align:right;font:inherit";
      const commit = (resetIfBad: boolean) => {
        const v = parseFloat(tb.value);
        if (Number.isFinite(v)) { SM[k] = v; saveSmooth(); }   // 合法即生效（下一笔用）
        else if (resetIfBad) tb.value = String(SM[k]);          // 失焦时非法才回填，打字途中不打断
      };
      tb.addEventListener("input", () => commit(false));   // 边打边生效（不靠回车/失焦）
      tb.addEventListener("change", () => commit(true));    // 回车 / 失焦提交 + 非法回填
      row.appendChild(tb);
    }
    p.appendChild(row);
  }
  const reset = document.createElement("button");
  reset.textContent = "重置默认";
  reset.style.cssText = "margin-top:8px;width:100%;padding:6px;cursor:pointer";
  reset.addEventListener("click", () => { resetSmooth(); _refreshSmoothInputs(p); setStatus("平滑参数已重置默认"); });
  p.appendChild(reset);
  const note = document.createElement("div");
  note.style.cssText = "margin-top:8px;color:var(--ink-soft,#888);font-size:11px";
  note.textContent = "textbox 可打任意数量级值。改完下一笔生效。×100 没变化 = 该参数对当前笔无效。";
  p.appendChild(note);
  document.body.appendChild(p);
  return p;
}

export function initSmoothDevPanel(ctx: AppContext) {
  setStatus = ctx.setStatus;
  els.menuSmoothDev?.addEventListener("click", () => {
    setMenuOpen(false);
    if (!_smoothDevPanel) _smoothDevPanel = _buildSmoothDevPanel();
    const showing = _smoothDevPanel.style.display !== "none";
    _smoothDevPanel.style.display = showing ? "none" : "block";
    if (!showing) _refreshSmoothInputs(_smoothDevPanel);
  });
}
