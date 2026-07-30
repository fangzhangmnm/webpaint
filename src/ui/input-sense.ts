// 共享控件：文本框 IntelliSense（usage-agnostic，2026-07-30 user 点名泛化）。
// 挂在任意 <input> 上：键入 → search(query) 出候选 → 弹下拉（可选 media 前导块 + label），
// 点/回车选中 → onPick。**对数据零知识**：候选长什么样由数据源决定——media 是数据源给的
// 现成 DOM 节点工厂产物（色名源给色板 chip；以后笔刷缩略图/图标/字体预览同一个口进来，
// 控件不用改）。第一消费者 = 色轮 HEX 框（源 = color-name.searchColorNames）。
//
// 分层：宿主自己的 Enter/Esc 语义（如「回车 commit / 失焦弹回」）不动——本控件在
// **document capture 相**先截键（同元素 capture 不改顺序，宿主 @keydown 先注册必先跑）：
// 候选高亮时 Enter=选中、Esc=只收下拉（stopImmediatePropagation），没截到的键照常落宿主。
// 条目用 pointerdown+preventDefault 选中（保住输入框焦点，不触发宿主 blur-弹回竞态）。
// 弹层锚定走 anchored-popup（全仓 popup 定位唯一入口）。

import { positionPopup } from "../anchored-popup.ts";

export interface InputSenseItem<T> {
  label: string;
  value: T;
  /** 可选前导媒体块（色板 chip / 缩略图 / 图标…）。数据源现建现给，控件只负责摆。 */
  media?: HTMLElement;
}
export interface InputSenseHandle { dispose(): void }

export function attachInputSense<T>(
  input: HTMLInputElement,
  opts: {
    search: (query: string) => InputSenseItem<T>[];
    onPick: (item: InputSenseItem<T>) => void;
    /** 可选截断；缺省不设上限（菜单限高滚动，2026-07-30 user 拍板）。 */
    limit?: number;
  },
): InputSenseHandle {
  const menu = document.createElement("div");
  menu.className = "menu-panel input-sense-menu hidden";
  menu.setAttribute("role", "listbox");
  document.body.appendChild(menu);

  let items: InputSenseItem<T>[] = [];
  let hi = -1;   // 高亮 index（-1 = 无——Enter 落给宿主）

  const close = () => { menu.classList.add("hidden"); menu.innerHTML = ""; items = []; hi = -1; };

  const render = () => {
    menu.innerHTML = "";
    items.forEach((it, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "input-sense-item" + (i === hi ? " active" : "");
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", i === hi ? "true" : "false");
      if (it.media) b.appendChild(it.media);
      const nm = document.createElement("span");
      nm.textContent = it.label;
      b.appendChild(nm);
      // pointerdown 选中 + preventDefault：不让输入框失焦（宿主 blur=弹回，click 晚于 blur）
      b.addEventListener("pointerdown", (e: Event) => { e.preventDefault(); pick(i); });
      menu.appendChild(b);
    });
  };

  const pick = (i: number) => {
    const it = items[i];
    if (!it) return;
    close();
    opts.onPick(it);
  };

  const update = () => {
    const all = opts.search(input.value);
    items = opts.limit ? all.slice(0, opts.limit) : all;
    hi = -1;
    if (!items.length) { close(); return; }
    render();
    menu.classList.remove("hidden");
    positionPopup(menu, { anchor: input, align: "left", clampViewport: true });
  };

  const onInput = () => update();
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== input) return;
    if (menu.classList.contains("hidden")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopImmediatePropagation();
      const d = e.key === "ArrowDown" ? 1 : -1;
      hi = (hi + d + items.length) % items.length;
      render();
    } else if (e.key === "Enter" && hi >= 0) {
      e.preventDefault(); e.stopImmediatePropagation();
      pick(hi);
    } else if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation();   // 第一下只收下拉；再按落给宿主（弹回）
      close();
    } else if (e.key === "Enter") {
      close();   // 无高亮：Enter 落给宿主 commit，同时收下拉
    }
  };
  const onBlur = () => close();

  input.addEventListener("input", onInput);
  document.addEventListener("keydown", onKey, true);
  input.addEventListener("blur", onBlur);
  return {
    dispose() {
      input.removeEventListener("input", onInput);
      document.removeEventListener("keydown", onKey, true);
      input.removeEventListener("blur", onBlur);
      menu.remove();
    },
  };
}
