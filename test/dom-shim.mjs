// 零依赖 DOM 垫片（spec §5.5：不引 jsdom/jest/vitest；家族铁律：不许 npm install）。
//
// 目的：让 app.js 这个组合根能在 node 里 import 而不炸——boot smoke 测试的地基。
// 它不是真 DOM 引擎，是一张「自动顺从」的假节点网：任何属性读到的都是一个既可当函数调用、
// 又可当子节点继续访问的 FakeNode；已知的热属性（nodeType/classList/style/getContext…）返回
// 类型正确的值（boolean=false、string=""、create*=新节点），未预料的方法 = no-op。
//
// 覆盖面：catch boot 期同步抛错（eager els 查询、各 initX、Vue .mount、Board canvas）。
// 不覆盖面：点击/事件后才浮现的「undefined is not a function」——那需要真事件回放，见测试头注释。

const NOOP = () => {};

// canvas 2d context：所有方法 no-op，measureText 给个假宽度，getImageData 给空像素。
function makeCtx2d() {
  return new Proxy(
    {
      canvas: null,
      measureText: () => ({ width: 0 }),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4) || 4), width: w || 1, height: h || 1 }),
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4) || 4), width: w || 1, height: h || 1 }),
      getContextAttributes: () => ({ alpha: false }),
      createLinearGradient: () => ({ addColorStop: NOOP }),
      createRadialGradient: () => ({ addColorStop: NOOP }),
      createPattern: () => null,
      setLineDash: NOOP,
      getLineDash: () => [],
      save: NOOP, restore: NOOP, scale: NOOP, rotate: NOOP, translate: NOOP, transform: NOOP, setTransform: NOOP, resetTransform: NOOP,
      clearRect: NOOP, fillRect: NOOP, strokeRect: NOOP,
      beginPath: NOOP, closePath: NOOP, moveTo: NOOP, lineTo: NOOP, bezierCurveTo: NOOP, quadraticCurveTo: NOOP, arc: NOOP, arcTo: NOOP, ellipse: NOOP, rect: NOOP,
      fill: NOOP, stroke: NOOP, clip: NOOP, isPointInPath: () => false,
      fillText: NOOP, strokeText: NOOP,
      drawImage: NOOP, putImageData: NOOP,
    },
    {
      get(t, p) {
        if (p in t) return t[p];
        // 任何未列出的 2d 方法/属性：方法 no-op、状态读 0/""
        return NOOP;
      },
      set(t, p, v) { t[p] = v; return true; },
    },
  );
}

// FakeNode：用 Proxy 包一个有完整已知 DOM 面的后备对象。
// 已知属性 → 类型正确；未知属性 → 返回一个「callable 子节点」（既能 () 调用 no-op，又能继续 .访问）。
function makeNode(tag = "div") {
  const store = new Map();         // setAttribute / 任意写入的真实存储
  const listeners = new Map();
  const dataset = {};
  const style = new Proxy({ setProperty: NOOP, removeProperty: NOOP, getPropertyValue: () => "" }, {
    get(t, p) { return p in t ? t[p] : ""; },
    set(t, p, v) { t[p] = v; return true; },
  });
  const classList = {
    _set: new Set(),
    add(...c) { c.forEach((x) => this._set.add(x)); },
    remove(...c) { c.forEach((x) => this._set.delete(x)); },
    toggle(c, force) { const on = force ?? !this._set.has(c); on ? this._set.add(c) : this._set.delete(c); return on; },
    contains(c) { return this._set.has(c); },
    replace(a, b) { this._set.delete(a); this._set.add(b); },
  };

  const self = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    namespaceURI: "http://www.w3.org/1999/xhtml",
    classList,
    style,
    dataset,
    children: [],
    childNodes: [],
    firstChild: null,
    lastChild: null,
    nextSibling: null,
    previousSibling: null,
    parentNode: null,
    parentElement: null,
    ownerDocument: null,        // 由 document 创建时回填
    textContent: "",
    innerHTML: "",
    outerHTML: "",
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    width: 300,
    height: 150,
    clientWidth: 300,
    clientHeight: 150,
    offsetWidth: 300,
    offsetHeight: 150,
    scrollWidth: 300,
    scrollHeight: 150,
    scrollTop: 0,
    scrollLeft: 0,
    files: [],
    options: [],
    selectedIndex: -1,
    isConnected: true,
    // 方法
    getContext: () => makeCtx2d(),
    toDataURL: () => "data:,",
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 150, width: 300, height: 150 }),
    getClientRects: () => [],
    setAttribute(k, v) { store.set(k, String(v)); if (k.startsWith("data-")) dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v); },
    getAttribute(k) { return store.has(k) ? store.get(k) : null; },
    hasAttribute(k) { return store.has(k); },
    removeAttribute(k) { store.delete(k); },
    setAttributeNS: NOOP,
    // 真链表树：Vue patch 依赖 parentNode / nextSibling / previousSibling 一致。
    insertBefore(c, ref) {
      if (!c) return c;
      if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
      const arr = self.childNodes;
      const idx = ref ? arr.indexOf(ref) : -1;
      if (ref && idx >= 0) arr.splice(idx, 0, c); else arr.push(c);
      self.children = arr.filter((n) => n.nodeType === 1);
      c.parentNode = proxy; c.parentElement = proxy;
      // 重链 sibling 指针
      for (let i = 0; i < arr.length; i++) {
        arr[i].previousSibling = arr[i - 1] || null;
        arr[i].nextSibling = arr[i + 1] || null;
      }
      self.firstChild = arr[0] || null;
      self.lastChild = arr[arr.length - 1] || null;
      return c;
    },
    appendChild(c) { return self.insertBefore(c, null); },
    append(...cs) { cs.forEach((c) => { if (c && typeof c === "object") self.appendChild(c); }); },
    prepend(...cs) { cs.forEach((c) => { if (c && typeof c === "object") self.insertBefore(c, self.firstChild); }); },
    removeChild(c) {
      const arr = self.childNodes;
      const i = arr.indexOf(c);
      if (i >= 0) {
        arr.splice(i, 1);
        self.children = arr.filter((n) => n.nodeType === 1);
        for (let j = 0; j < arr.length; j++) { arr[j].previousSibling = arr[j - 1] || null; arr[j].nextSibling = arr[j + 1] || null; }
        self.firstChild = arr[0] || null;
        self.lastChild = arr[arr.length - 1] || null;
      }
      if (c) { c.parentNode = null; c.parentElement = null; c.nextSibling = null; c.previousSibling = null; }
      return c;
    },
    remove() { const p = self.parentNode; if (p && p.removeChild) p.removeChild(proxy); },
    replaceChild(n, o) { self.removeChild(o); self.appendChild(n); return o; },
    replaceChildren: NOOP,
    cloneNode() { return makeNode(tag); },
    contains: () => false,
    closest: () => null,
    matches: () => false,
    querySelector: () => makeNode("div"),   // 自动顺从：链式 .width/.getContext 不炸（smoke 只求不抛）
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent: () => true,
    focus: NOOP, blur: NOOP, click: NOOP,
    scrollIntoView: NOOP, scrollTo: NOOP, scrollBy: NOOP,
    insertAdjacentElement: NOOP, insertAdjacentHTML: NOOP, insertAdjacentText: NOOP,
    animate: () => ({ cancel: NOOP, finished: Promise.resolve() }),
    requestPointerLock: NOOP, releasePointerLock: NOOP,
    setPointerCapture: NOOP, releasePointerCapture: NOOP, hasPointerCapture: () => false,
    _listeners: listeners,
  };

  const proxy = new Proxy(self, {
    get(t, p) {
      if (p in t) return t[p];
      // 未预料的属性 → undefined（终止 Vue 的 parentNode/vnode 链式遍历；
      // 未设的 __vnode/_vnode 读出 falsy = 正确）。真用到的 DOM 方法走上面显式 stub；
      // 若有未 stub 的方法被调用 → "not a function" 抛错，正是 smoke 要暴露的、按需补 stub。
      return undefined;
    },
    set(t, p, v) {
      if (p === "innerHTML") {
        // Vue 运行时模板编译器的 decodeEntities 会 `decoder.innerHTML = '<div foo="RAW">'`
        // 再读 children[0].getAttribute('foo') / textContent 来借浏览器解码实体。
        // 轻量模拟：抽首标签属性进一个子节点 + 解码常见实体进 textContent，避免 children[0] undefined。
        t.innerHTML = String(v ?? "");
        const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&#0*(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
        const child = makeNode("div");
        const m = t.innerHTML.match(/<\w+([^>]*)>/);
        if (m) for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) child.setAttribute(a[1], decode(a[2]));
        t.children = [child]; t.childNodes = [child]; t.firstChild = child; t.lastChild = child;
        t.textContent = decode(t.innerHTML.replace(/<[^>]*>/g, ""));
        return true;
      }
      t[p] = v; return true;
    },
  });
  self.ownerDocument = null;
  return proxy;
}

function makeDocument() {
  const docEl = makeNode("html");
  const body = makeNode("body");
  const head = makeNode("head");
  const cache = new Map();
  const doc = {
    nodeType: 9,
    documentElement: docEl,
    body,
    head,
    title: "",
    readyState: "complete",
    cookie: "",
    activeElement: body,
    defaultView: null,         // 回填 window
    // getElementById：同一 id 返回同一节点（els.ts 多次查、Vue 也可能查），稳定身份。
    getElementById(id) { if (!cache.has(id)) { const n = makeNode("div"); n.id = id; cache.set(id, n); } return cache.get(id); },
    createElement(tag) { return makeNode(tag || "div"); },
    createElementNS(_ns, tag) { return makeNode(tag || "div"); },
    createTextNode(text) { const n = makeNode("#text"); n.nodeType = 3; n.textContent = String(text ?? ""); n.data = String(text ?? ""); return n; },
    createComment(text) { const n = makeNode("#comment"); n.nodeType = 8; n.textContent = String(text ?? ""); n.data = String(text ?? ""); return n; },
    createDocumentFragment() { const n = makeNode("#fragment"); n.nodeType = 11; return n; },
    createEvent() { return { initEvent: NOOP }; },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    addEventListener: NOOP,
    removeEventListener: NOOP,
    dispatchEvent: () => true,
    importNode: (n) => n,
    adoptNode: (n) => n,
  };
  return doc;
}

let _storage;
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

// 安装全局，返回 uninstall()。**必须 hermetic**：本套件其他测试（crypto/store）靠 globalThis.window.zip
// 等全局；垫片把 window 换成假对象会污染它们（曾 24 个 crypto 测试因此假红）。故快照原值、测试 finally 里复原。
export function installDomShim() {
  if (globalThis.__domShimInstalled) return globalThis.__domShimUninstall || (() => {});
  const document = makeDocument();
  _storage = makeStorage();

  const win = {
    document,
    devicePixelRatio: 1,
    innerWidth: 1024,
    innerHeight: 768,
    location: { href: "http://localhost/", origin: "http://localhost", pathname: "/", search: "", hash: "", reload: NOOP, assign: NOOP, replace: NOOP },
    localStorage: _storage,
    sessionStorage: makeStorage(),
    navigator: { maxTouchPoints: 0, onLine: true, userAgent: "node-boot-smoke", language: "zh-CN", clipboard: { writeText: () => Promise.resolve(), read: () => Promise.resolve([]) }, serviceWorker: { register: () => Promise.reject(new Error("no-sw-in-node")), ready: new Promise(NOOP), addEventListener: NOOP } },
    matchMedia: () => ({ matches: false, addEventListener: NOOP, removeEventListener: NOOP, addListener: NOOP, removeListener: NOOP, media: "" }),
    getComputedStyle: () => ({ getPropertyValue: () => "", width: "300px", height: "150px" }),
    requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now?.() ?? 0), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    requestIdleCallback: (cb) => setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: true }), 0),
    cancelIdleCallback: (id) => clearTimeout(id),
    addEventListener: NOOP,
    removeEventListener: NOOP,
    dispatchEvent: () => true,
    scrollTo: NOOP,
    alert: NOOP, confirm: () => false, prompt: () => null,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.reject(new Error("no-fetch-in-node")),
    WebPaint: undefined,
  };
  win.window = win;
  win.self = win;
  win.globalThis = globalThis;
  document.defaultView = win;

  // 观察者类 → no-op
  class NoopObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }

  const assign = {
    window: win,
    document,
    navigator: win.navigator,
    location: win.location,
    localStorage: _storage,
    sessionStorage: win.sessionStorage,
    devicePixelRatio: 1,
    matchMedia: win.matchMedia,
    getComputedStyle: win.getComputedStyle,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    requestIdleCallback: win.requestIdleCallback,
    cancelIdleCallback: win.cancelIdleCallback,
    fetch: win.fetch,
    matchMedia: win.matchMedia,
    indexedDB: { open: () => { const r = { result: null, error: new Error("no-idb-in-node"), onerror: null, onsuccess: null, onupgradeneeded: null }; setTimeout(() => r.onerror && r.onerror({ target: r }), 0); return r; }, deleteDatabase: () => ({ onsuccess: null, onerror: null }) },
    HTMLElement: class HTMLElement {},
    HTMLCanvasElement: class HTMLCanvasElement {},
    HTMLInputElement: class HTMLInputElement {},
    HTMLSelectElement: class HTMLSelectElement {},
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    SVGElement: class SVGElement {},
    SVGSVGElement: class SVGSVGElement {},
    MathMLElement: class MathMLElement {},
    Element: class Element {},
    Node: class Node {},
    DocumentFragment: class DocumentFragment {},
    Text: class Text {},
    Comment: class Comment {},
    Event: class Event { constructor(type) { this.type = type; } preventDefault() {} stopPropagation() {} },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } preventDefault() {} stopPropagation() {} },
    Image: class Image { constructor() { return makeNode("img"); } },
    Path2D: class Path2D { addPath() {} },
    IntersectionObserver: NoopObserver,
    ResizeObserver: NoopObserver,
    MutationObserver: NoopObserver,
    customElements: { define: NOOP, get: () => undefined, whenDefined: () => Promise.resolve() },
  };
  // 快照原值（用于 uninstall 复原），再装。window/document 强制覆盖；其余仅在缺失时补。
  const snapshot = new Map();
  const had = new Map();
  const remember = (k) => { if (!snapshot.has(k)) { snapshot.set(k, globalThis[k]); had.set(k, k in globalThis); } };
  for (const [k, v] of Object.entries(assign)) {
    if (globalThis[k] === undefined) { remember(k); globalThis[k] = v; }
  }
  for (const k of ["window", "document"]) remember(k);
  globalThis.window = win;
  globalThis.document = document;
  globalThis.__domShimInstalled = true;

  const uninstall = () => {
    for (const [k, was] of had) { if (was) globalThis[k] = snapshot.get(k); else delete globalThis[k]; }
    delete globalThis.__domShimInstalled;
    delete globalThis.__domShimUninstall;
  };
  globalThis.__domShimUninstall = uninstall;
  return uninstall;
}

export { makeNode };
