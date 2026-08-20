// <wp-cloud-picker> —— 云盘图片选择浮层（小型云端浏览器：面包屑 + 子夹导航 + 图片缩略图网格）。
// 家族 web component 约定（ai-docs/20260810-family-web-component-convention.md，试点 = reference-window）：
//   - 组件自带 chrome（shadow DOM），宿主 store 零知识——列举/字节/缓存全经注入。
//   - 入向 = property 下灌（**程序性 set 不发事件**）：open / folder / listing / loading / labels；
//     fetchThumb 为 function-valued property（「pull 例外」：缩略图字节是宿主知识）。
//   - 出向 = CustomEvent（只有用户交互发）：navigate{folder} / pick{path,name} / close。
//     宿主收 navigate 换订阅、把新 listing set 回来；收 pick 关窗走导入路由。
//   - 图标烤进 shadow（<use> 不穿 shadow 边界）；源 = 家族 sprite：image / folder / back / x（对账 key）。
// 用途 = 云盘图片 picker（ai-docs/20260820-cloud-image-picker-spec.md §3；三入口共用本组件）。

export interface CloudPickerImage { path: string; name: string; size?: number; lastModified?: number; cached?: boolean; }
export interface CloudPickerListing { images: CloudPickerImage[]; folderNames: string[]; }
export interface CloudPickerLabels { title?: string; root?: string; empty?: string; loading?: string; back?: string; close?: string; }

const THUMB_CONCURRENCY = 3;    // 缩略图并发池：miss 时一张 = 一次整图下载，别把弱网打爆

// 图标：家族 sprite 烤入（id 注记 = 对账 key）。stroke 属性同 sprite 头（1.7/round/round）。
const SVG_ATTRS = `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
const ICON_FOLDER = `<svg ${SVG_ATTRS}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;   // sprite#folder
const ICON_IMAGE = `<svg ${SVG_ATTRS}><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.3" cy="10" r="1.7"/><path d="M3.6 17.2 L9 11.8 L13 15.8 L16 12.8 L20.4 17.2"/></svg>`;   // sprite#image
const ICON_BACK = `<svg ${SVG_ATTRS}><path d="M20 12H5"/><polyline points="11 6 5 12 11 18"/></svg>`;   // sprite#back
const ICON_X = `<svg ${SVG_ATTRS}><path d="M6.5 6.5 L17.5 17.5 M17.5 6.5 L6.5 17.5"/></svg>`;   // sprite#x

const TEMPLATE = `<style>
:host {
  position: fixed; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  z-index: var(--z-window, 100);
  -webkit-tap-highlight-color: transparent;
  font-size: 13px;
}
:host(:not([open])) { display: none; }
.panel {
  display: flex; flex-direction: column;
  width: min(560px, calc(100vw - 32px));
  height: min(600px, calc(100dvh - 64px));
  background: var(--bg, #202124);
  color: var(--ink, #e8eaed);
  border: 1px solid var(--line, #3c4043);
  border-radius: var(--radius, 10px);
  box-shadow: var(--shadow, 0 8px 24px rgba(0, 0, 0, 0.4));
  overflow: hidden;
}
.head {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line, #3c4043);
  user-select: none; -webkit-user-select: none;
}
.title { font-weight: 600; flex: 1; }
.iconbtn {
  background: transparent; border: none; color: var(--ink-soft, #9aa0a6);
  cursor: pointer; padding: 4px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
}
.iconbtn svg { width: 18px; height: 18px; display: block; }
.iconbtn:hover { background: color-mix(in srgb, var(--ink, #e8eaed) 8%, transparent); color: var(--ink, #e8eaed); }
.iconbtn[disabled] { opacity: 0.35; pointer-events: none; }
.crumbs {
  display: flex; align-items: center; gap: 2px; flex-wrap: wrap;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line, #3c4043);
  color: var(--ink-soft, #9aa0a6);
  user-select: none; -webkit-user-select: none;
  min-height: 20px;
}
.crumb {
  background: transparent; border: none; color: inherit; cursor: pointer;
  padding: 2px 4px; border-radius: 4px; font: inherit; max-width: 12em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.crumb:hover { background: color-mix(in srgb, var(--ink, #e8eaed) 8%, transparent); color: var(--ink, #e8eaed); }
.crumb.cur { color: var(--ink, #e8eaed); font-weight: 600; pointer-events: none; }
.sep { opacity: 0.5; }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
}
.tile {
  background: transparent; border: 1px solid transparent; border-radius: 8px;
  padding: 6px 4px 4px; cursor: pointer; color: inherit; font: inherit;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  min-width: 0;
}
.tile:hover { background: color-mix(in srgb, var(--ink, #e8eaed) 6%, transparent); border-color: var(--line, #3c4043); }
.tile .box {
  width: 88px; height: 88px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--ink, #e8eaed) 5%, transparent);
  overflow: hidden;
}
.tile .box svg { width: 34px; height: 34px; color: var(--ink-soft, #9aa0a6); display: block; }
.tile img { width: 100%; height: 100%; object-fit: contain; display: block; }
.tile .nm {
  width: 100%; font-size: 11px; color: var(--ink-soft, #9aa0a6); text-align: center;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tile:hover .nm { color: var(--ink, #e8eaed); }
.note {
  padding: 24px 12px; text-align: center; color: var(--ink-soft, #9aa0a6); font-size: 12px;
}
.note.hidden, .grid.hidden { display: none; }
</style>
<div class="panel" part="panel">
  <div class="head" part="head">
    <button class="iconbtn" data-act="back" type="button">${ICON_BACK}</button>
    <span class="title" part="title"><slot name="title">从云盘选图</slot></span>
    <button class="iconbtn" data-act="close" type="button">${ICON_X}</button>
  </div>
  <div class="crumbs" part="crumbs"></div>
  <div class="body" part="body">
    <div class="note loading hidden"></div>
    <div class="note empty hidden"><slot name="empty">此文件夹没有图片</slot></div>
    <div class="grid"></div>
  </div>
</div>`;

export class WpCloudPicker extends HTMLElement {
  #root: ShadowRoot;
  #crumbsEl: HTMLElement;
  #gridEl: HTMLElement;
  #emptyEl: HTMLElement;
  #loadingEl: HTMLElement;
  #backBtn: HTMLButtonElement;

  #folder = "";
  #listing: CloudPickerListing = { images: [], folderNames: [] };
  #loading = false;
  #labels: CloudPickerLabels = {};
  #urls = new Map<string, string>();        // path → objectURL（换 listing 时 revoke）
  #renderGen = 0;                            // listing 换代号：旧代的缩略图异步回来直接丢

  /** 宿主注入：拿一条图片的缩略图字节（miss = 整图下载自压，宿主管缓存）。null/抛错 → 占位图标。 */
  fetchThumb: ((item: CloudPickerImage) => Promise<Blob | null>) | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
    this.#root.innerHTML = TEMPLATE;
    this.#crumbsEl = this.#root.querySelector(".crumbs") as HTMLElement;
    this.#gridEl = this.#root.querySelector(".grid") as HTMLElement;
    this.#emptyEl = this.#root.querySelector(".empty") as HTMLElement;
    this.#loadingEl = this.#root.querySelector(".loading") as HTMLElement;
    this.#backBtn = this.#root.querySelector('[data-act="back"]') as HTMLButtonElement;
    this.#backBtn.addEventListener("click", () => {
      if (!this.#folder) return;
      this.#emitNavigate(this.#folder.includes("/") ? this.#folder.slice(0, this.#folder.lastIndexOf("/")) : "");
    });
    (this.#root.querySelector('[data-act="close"]') as HTMLElement).addEventListener("click", () => this.#emitClose());
    // backdrop 点击关（点在 :host 本体 = panel 之外）
    this.addEventListener("pointerdown", (e) => { if (e.target === this) this.#emitClose(); });
  }

  // ---- 属性下灌（程序性 set 不发事件）----
  get open(): boolean { return this.hasAttribute("open"); }
  set open(v: boolean) { this.toggleAttribute("open", !!v); }

  get folder(): string { return this.#folder; }
  set folder(v: string) { this.#folder = v || ""; this.#renderCrumbs(); }

  get listing(): CloudPickerListing { return this.#listing; }
  set listing(v: CloudPickerListing) {
    this.#listing = v || { images: [], folderNames: [] };
    this.#loading = false;
    this.#render();
  }

  get loading(): boolean { return this.#loading; }
  set loading(v: boolean) { this.#loading = !!v; this.#renderNotes(); }

  set labels(v: CloudPickerLabels) {
    this.#labels = v || {};
    const t = this.#labels;
    if (t.back) { this.#backBtn.title = t.back; this.#backBtn.setAttribute("aria-label", t.back); }
    const closeBtn = this.#root.querySelector('[data-act="close"]') as HTMLButtonElement;
    if (t.close) { closeBtn.title = t.close; closeBtn.setAttribute("aria-label", t.close); }
    this.#renderCrumbs();
    this.#renderNotes();
  }

  disconnectedCallback() { this.#revokeAll(); }

  // ---- 事件（只有用户交互发）----
  #emitNavigate(folder: string) { this.dispatchEvent(new CustomEvent("navigate", { detail: { folder } })); }
  #emitClose() { this.dispatchEvent(new CustomEvent("close")); }

  // ---- 渲染 ----
  #renderCrumbs() {
    this.#crumbsEl.textContent = "";
    const segs = this.#folder ? this.#folder.split("/") : [];
    const mk = (label: string, target: string | null) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "crumb" + (target == null ? " cur" : "");
      b.textContent = label;
      if (target != null) b.addEventListener("click", () => this.#emitNavigate(target));
      this.#crumbsEl.appendChild(b);
    };
    mk(this.#labels.root || "/", segs.length ? "" : null);   // 宿主经 labels.root 给 i18n 文案；裸挂 fallback 用纯文本 "/"（图标禁 emoji/特殊字形，家规）
    segs.forEach((seg, i) => {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "›";
      this.#crumbsEl.appendChild(sep);
      mk(seg, i === segs.length - 1 ? null : segs.slice(0, i + 1).join("/"));
    });
    this.#backBtn.disabled = !segs.length;
  }

  #renderNotes() {
    this.#loadingEl.textContent = this.#labels.loading || "…";
    this.#loadingEl.classList.toggle("hidden", !this.#loading);
    const emptyNow = !this.#loading && !this.#listing.images.length && !this.#listing.folderNames.length;
    this.#emptyEl.classList.toggle("hidden", !emptyNow);
    this.#gridEl.classList.toggle("hidden", this.#loading);
  }

  #render() {
    this.#renderGen++;
    this.#revokeAll();
    this.#gridEl.textContent = "";
    for (const name of this.#listing.folderNames) {
      const b = this.#tile(ICON_FOLDER, name);
      b.addEventListener("click", () => this.#emitNavigate(this.#folder ? `${this.#folder}/${name}` : name));
      this.#gridEl.appendChild(b);
    }
    const thumbJobs: Array<() => Promise<void>> = [];
    for (const img of this.#listing.images) {
      const b = this.#tile(ICON_IMAGE, img.name);
      b.addEventListener("click", () => this.dispatchEvent(new CustomEvent("pick", { detail: { ...img } })));
      this.#gridEl.appendChild(b);
      thumbJobs.push(() => this.#loadThumb(b, img, this.#renderGen));
    }
    this.#renderCrumbs();
    this.#renderNotes();
    this.#runPool(thumbJobs);
  }

  #tile(iconSvg: string, name: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tile";
    b.title = name;
    const box = document.createElement("div");
    box.className = "box";
    box.innerHTML = iconSvg;
    const nm = document.createElement("div");
    nm.className = "nm";
    nm.textContent = name;
    b.append(box, nm);
    return b;
  }

  async #loadThumb(tileEl: HTMLElement, item: CloudPickerImage, gen: number) {
    if (!this.fetchThumb) return;
    let blob: Blob | null = null;
    try { blob = await this.fetchThumb(item); } catch { /* 占位图标兜底，宿主已 report */ }
    if (!blob || gen !== this.#renderGen || !this.isConnected) return;
    const url = URL.createObjectURL(blob);
    this.#urls.set(item.path, url);
    const im = document.createElement("img");
    im.alt = item.name;
    im.decoding = "async";
    im.src = url;
    const box = tileEl.querySelector(".box") as HTMLElement;
    box.textContent = "";
    box.appendChild(im);
  }

  #runPool(jobs: Array<() => Promise<void>>) {
    let i = 0;
    const next = async (): Promise<void> => {
      const j = jobs[i++];
      if (!j) return;
      await j();
      return next();
    };
    for (let k = 0; k < THUMB_CONCURRENCY; k++) void next();
  }

  #revokeAll() {
    for (const url of this.#urls.values()) URL.revokeObjectURL(url);
    this.#urls.clear();
  }
}

export const WP_CLOUD_PICKER_TAG = "wp-cloud-picker";
if (!customElements.get(WP_CLOUD_PICKER_TAG)) customElements.define(WP_CLOUD_PICKER_TAG, WpCloudPicker);
