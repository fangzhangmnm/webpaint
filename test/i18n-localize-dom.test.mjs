// data-i18n 桥不得冲掉内联图标（v421）。
//
// 背景：v419 给一批菜单项加上内联 `<svg><use>` 图标后，boot 期的 localizeDom 当场把它们全冲没了——
//   因为它写的是 `el.textContent = ...`，而真 DOM 的 textContent setter 会**清空所有子节点**。
//   v420 把当时那几个逐个挪开修好了，但机制没堵：谁再给带图标的元素加 data-i18n，图标就会静默消失。
//
// ⚠ 为什么不用 test/dom-shim.mjs：垫片的 textContent 是个**普通属性**，赋值不会清空 childNodes。
//   拿它测这条不变式，旧代码也照样全绿 = 假测试。这里用一个刻意**忠实还原 textContent 破坏性语义**
//   的小 fake，这样「回退成 el.textContent = s」必然让下面几条红。
import { describe, it, assert, eq } from "./runner.mjs";
import { setLocalizedText } from "../src/i18n/index.ts";

function fakeText(s) {
  return {
    nodeType: 3, textContent: s, parentNode: null,
    remove() {
      const p = this.parentNode;
      if (!p) return;
      p.childNodes = p.childNodes.filter((n) => n !== this);
      p._sync(); this.parentNode = null;
    },
  };
}
function fakeEl(tag, kids = []) {
  const el = {
    nodeType: 1, tagName: tag.toUpperCase(), childNodes: [], children: [],
    _sync() { this.children = this.childNodes.filter((n) => n.nodeType === 1); },
    appendChild(n) { n.parentNode = this; this.childNodes.push(n); this._sync(); return n; },
    get textContent() { return this.childNodes.map((n) => n.textContent).join(""); },
    set textContent(s) {                       // ★ 真 DOM 语义：清空所有子节点
      for (const n of this.childNodes) n.parentNode = null;
      this.childNodes = []; this.children = [];
      if (s !== "") this.appendChild(fakeText(s));
    },
  };
  for (const k of kids) el.appendChild(k);
  return el;
}
const icon = () => fakeEl("svg");
// 形状快照：元素记 <tag>，文本记去空白后的内容（空白节点记 "␣"）——用来断言**顺序**没被打乱。
const shape = (el) => el.childNodes.map((n) =>
  n.nodeType === 1 ? `<${n.tagName.toLowerCase()}>` : ((n.textContent ?? "").trim() || "␣")).join("");

// setLocalizedText 里「只有图标没文字」那条分支要 document.createTextNode。
function withFakeDocument(fn) {
  const prev = globalThis.document;
  globalThis.document = { createTextNode: (s) => fakeText(String(s)) };
  try { return fn(); } finally { globalThis.document = prev; }
}

describe("i18n · data-i18n 桥不得冲掉内联图标", () => {
  it("纯文本元素 → 整体替换（老行为逐字不变）", () => {
    const el = fakeEl("span", [fakeText("旧文案")]);
    setLocalizedText(el, "新文案");
    eq(el.textContent, "新文案");
    eq(el.children.length, 0);
  });

  it("★ 图标在前、文字在后 → 图标必须还在，且仍在前面", () => {
    const el = fakeEl("button", [icon(), fakeText("返回图库")]);
    setLocalizedText(el, "Back to gallery");
    eq(el.children.length, 1, "★ 图标绝不能被冲掉");
    eq(shape(el), "<svg>Back to gallery", "顺序不变：图标在前");
  });

  it("★ 文字在前、图标在后 → 顺序同样保留", () => {
    const el = fakeEl("span", [fakeText("已同步"), icon()]);
    setLocalizedText(el, "Synced");
    eq(el.children.length, 1);
    eq(shape(el), "Synced<svg>", "★ 不能把文字甩到图标后面去");
  });

  it("★ 真实 HTML 排版（图标前后都有空白文本节点）→ 文案落在图标之后", () => {
    // <button data-i18n="x">\n  <svg/>\n  返回图库\n</button>
    const el = fakeEl("button", [fakeText("\n  "), icon(), fakeText("\n  返回图库\n")]);
    setLocalizedText(el, "Back");
    eq(el.children.length, 1);
    eq(shape(el), "␣<svg>Back", "★ 首个**非空白**文本节点才是标签位——挑错了文案会跑到图标前面");
  });

  it("只有图标、没有文案 → 补上文本节点，图标保留", () => {
    withFakeDocument(() => {
      const el = fakeEl("button", [icon()]);
      setLocalizedText(el, "保存");
      eq(el.children.length, 1);
      eq(shape(el), "<svg>保存");
    });
  });

  it("多个非空白文本节点 → 只留一个，不重复标签", () => {
    const el = fakeEl("button", [fakeText("重复"), icon(), fakeText("标签")]);
    setLocalizedText(el, "OK");
    eq(el.children.length, 1);
    eq(el.textContent.replace(/\s+/g, ""), "OK", "★ 别把旧文案的碎片留在后面");
  });

  it("图标是多层嵌套（<svg><use/></svg>）也不受影响", () => {
    const svg = fakeEl("svg", [fakeEl("use")]);
    const el = fakeEl("button", [svg, fakeText("撤销")]);
    setLocalizedText(el, "Undo");
    eq(el.children.length, 1);
    eq(el.children[0].children.length, 1, "★ <use> 必须还在，否则图标是空的");
    eq(shape(el), "<svg>Undo");
  });
});
