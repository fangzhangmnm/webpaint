// in-app 下拉（v0.5.40 从 settings-menu 提取——图库菜单成为第二消费者）。
// 为什么不用原生 <select>：打开态是 chrome 域（iPad 弹层系统字体→UCSUR 豆腐、夜间白底、装不了 SVG）。
// 形态：按钮（调用方自备 label span+caret）→ 锚定紧凑 list 弹层；条目**开时现建**（label 永远新鲜，
//   tok 字体门迟到翻转后自动带字形）。z 用 --z-popover band（压过 --z-menu）。
// TODO（user 点名 2026-07-25）：与组槽下拉/⋯菜单/tile 菜单一起收成 popover 深模块（open/close/锚定/z 一站式）。

import { anchorPopupToBtn } from "./anchored-popup.ts";

export function wireInlineSelect<V extends string>(
  btnId: string, menuId: string,
  items: () => { value: V; label: string }[],
  current: () => V,
  onPick: (v: V) => void,
): void {
  const btn = document.getElementById(btnId);
  const menu = document.getElementById(menuId);
  if (!btn || !menu) return;
  btn.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
    menu.innerHTML = "";
    for (const it of items()) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "lasso-tool-btn"; b.setAttribute("role", "menuitem");
      b.textContent = it.label;
      b.setAttribute("aria-pressed", it.value === current() ? "true" : "false");
      b.addEventListener("click", () => { menu.classList.add("hidden"); onPick(it.value); });
      menu.appendChild(b);
    }
    menu.classList.remove("hidden");
    anchorPopupToBtn(menu, btn, { align: "right", offsetY: 4 });
  });
  document.addEventListener("pointerdown", (e: Event) => {
    if (menu.classList.contains("hidden")) return;
    if (menu.contains(e.target as Node) || btn.contains(e.target as Node)) return;
    menu.classList.add("hidden");
  });
}
