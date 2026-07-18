// 图标 = 指向内联 sprite 的 <use>。sprite 在 index.html 顶部（tools/inline-sprites.py 生成）。
//
// 为什么全走这里：在此之前 53 个图标各自手写内联 <svg>，同一条云朵 path 复制了 9 遍、
// 加号 3 遍，还并存三个互不相识的 svg() 字符串工厂。改一个图标要全仓库 grep。
//
// 尺寸不在这里定：全部由 CSS 按语境给（.tool svg / .layers-foot-btn svg / .gallery-icon-btn svg …）。
// 传 size 只用于 CSS 够不着的地方（比如塞进 v-html 的裸片段）。
//
// 图标名 = 共享库（20260708 SVG Icons）的 symbol id，或 assets/webpaint_legacy.svg 里的本地补丁。
// 名字写了但两边都没有 → 页面上那个位置空白。加图标请走 assets/ 下的源文件 + 重跑脚本。

export type IconName = string;

/** 图标的 HTML 字符串（给 innerHTML / v-html / 模板拼接用）。 */
export function iconHtml(name: IconName, opts: { size?: number; cls?: string } = {}): string {
  const { size, cls } = opts;
  const attrs = [
    'viewBox="0 0 24 24"',
    cls ? `class="${cls}"` : "",
    size ? `width="${size}" height="${size}"` : "",
    'aria-hidden="true"',
  ].filter(Boolean).join(" ");
  return `<svg ${attrs}><use href="#${name}"/></svg>`;
}

/** 图标 DOM 节点（给 appendChild 用）。 */
export function iconEl(name: IconName, opts: { size?: number; cls?: string } = {}): SVGSVGElement {
  const tpl = document.createElement("template");
  tpl.innerHTML = iconHtml(name, opts);
  return tpl.content.firstElementChild as SVGSVGElement;
}
