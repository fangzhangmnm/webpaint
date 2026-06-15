// ORA 嵌套组序列化（batch 2 step 3）：buildStackXml ↔ parseStackXml 树往返 + id + active。
// 纯 XML 字符串往返（无 canvas / 无 PNG）。node 无 DOMParser → 本文件装一个极简 XML parser
// polyfill（只够解析我们自己 emit 的 well-formed XML：元素 / 属性 / 自闭合 / 嵌套 stack）。
import { describe, it, assert, eq } from "./runner.mjs";

// ---- OffscreenCanvas stub（doc 构造/快照需要；同 layer-tree.test）----
function makeCtx() {
  const ctx = { getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }), putImageData: () => {} };
  return new Proxy(ctx, { get(t, p) { return p in t ? t[p] : (() => {}); }, set(t, p, v) { t[p] = v; return true; } });
}
class StubCanvas { constructor(w, h) { this.width = w; this.height = h; this._ctx = makeCtx(); } getContext() { return this._ctx; } }

// ---- 极简 XML parser polyfill（recursive descent；只解析受控输出）----
function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function makeEl(tagName) {
  return { tagName, _attrs: {}, children: [], getAttribute(n) { return n in this._attrs ? this._attrs[n] : null; } };
}
function parseXml(text) {
  text = text.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  let i = 0; const n = text.length;
  const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";
  function parseElement() {
    i++;                                            // skip '<'
    let name = "";
    while (i < n && !isWs(text[i]) && text[i] !== "/" && text[i] !== ">") name += text[i++];
    const el = makeEl(name);
    while (i < n) {
      while (i < n && isWs(text[i])) i++;
      if (text[i] === "/") { while (i < n && text[i] !== ">") i++; i++; return el; }   // self-closing
      if (text[i] === ">") { i++; break; }          // open tag done → children
      let an = "";
      while (i < n && !isWs(text[i]) && text[i] !== "=" && text[i] !== ">") an += text[i++];
      while (i < n && isWs(text[i])) i++;
      if (text[i] === "=") {
        i++; while (i < n && isWs(text[i])) i++;
        const q = text[i++]; let av = "";
        while (i < n && text[i] !== q) av += text[i++];
        i++; el._attrs[an] = decodeEntities(av);
      } else if (an) { el._attrs[an] = ""; }
    }
    while (i < n) {                                  // children until </name>
      if (text[i] === "<") {
        if (text[i + 1] === "/") { i += 2; while (i < n && text[i] !== ">") i++; i++; return el; }
        el.children.push(parseElement());
      } else i++;
    }
    return el;
  }
  while (i < n && text[i] !== "<") i++;
  return parseElement();
}
class FakeDOMParser {
  parseFromString(text) {
    const root = parseXml(text);
    return {
      querySelector(sel) {
        if (sel === "parsererror") return null;
        if (sel === "image") return (root.tagName || "").toLowerCase() === "image" ? root : null;
        return null;
      },
    };
  }
}

// ---- 装 stub，动态 import（同 layer-tree：避免静态 import 毒别的文件）----
const _prevOSC = globalThis.OffscreenCanvas;
const _prevDP = globalThis.DOMParser;
globalThis.OffscreenCanvas = StubCanvas;
globalThis.DOMParser = FakeDOMParser;
// **单**一 top-level await（用 Promise.all 合并两个 import）：多一个 await 回合会扰动
//   run.mjs 里一众 TLA 模块的微任务交错顺序，毒到 selection-morph 的 OSC-stub（实测）。
//   ora-stack-xml.js 无 canvas 依赖，本就不该碰 OSC，但 await 回合数本身是雷 → 收成 1 个。
const [_docMod, _oraXmlMod] = await Promise.all([
  import("../src/doc.js"),
  import("../src/ora-stack-xml.js"),
]);
const { PaintDoc } = _docMod;
const { buildStackXml, parseStackXml } = _oraXmlMod;
globalThis.OffscreenCanvas = _prevOSC;

const useStub = () => { globalThis.OffscreenCanvas = StubCanvas; globalThis.DOMParser = FakeDOMParser; };
const T = (name, fn) => it(name, () => { useStub(); fn(); });

// 构造：[L0, G{ L1, L1b }, L2]，active=L1，ref=L2。
function buildTreeDoc() {
  const d = new PaintDoc();
  const L0 = d.layers[0];
  L0.bboxX = 5; L0.bboxY = 7; L0.bboxW = 10; L0.bboxH = 10;
  const L1 = d.addLayer();
  d.groupSelection(L1.id);
  const G = d.layers[1];
  G.opacity = 0.5; G.mode = "multiply"; G.name = "组A";
  d.setActiveById(L1.id);
  const L1b = d.addLayer();              // 进 G（active=L1 的同级之上）
  L1.lockAlpha = true;
  L1b.clippingMask = true;
  d.setActiveById(G.id);
  const L2 = d.addLayer();               // 进根（active=G 的同级之上）
  d.referenceLayerId = L2.id;
  d.setActiveById(L1.id);                // active = 组内叶
  return { d, L0, L1, L1b, L2, G };
}

describe("ora-tree · 嵌套组 XML 往返", () => {
  T("结构 / id / 组属性 / active / clip / lockAlpha / reference 全保真", () => {
    const { d, L0, L1, L1b, L2, G } = buildTreeDoc();
    const xml = buildStackXml(d);
    const { w, h, nodes } = parseStackXml(xml);
    eq(w, d.width, "w"); eq(h, d.height, "h");
    eq(nodes.length, 3, "根 3 节点（bottom-first）");

    // [0] = L0 叶
    eq(nodes[0].isGroup, false, "n0 叶");
    eq(nodes[0].id, L0.id, "n0 id");
    eq(nodes[0].x, 5, "n0 x"); eq(nodes[0].y, 7, "n0 y");

    // [1] = 组 G
    const g = nodes[1];
    eq(g.isGroup, true, "n1 组");
    eq(g.id, G.id, "组 id");
    eq(g.name, "组A", "组名");
    assert(Math.abs(g.opacity - 0.5) < 1e-4, "组 opacity");
    eq(g.mode, "multiply", "组 mode");
    eq(g.children.length, 2, "组 2 子（bottom-first）");
    eq(g.children[0].id, L1.id, "子[0]=L1");
    eq(g.children[0].lockAlpha, true, "L1 lockAlpha");
    eq(g.children[0].isActive, true, "L1 active");
    eq(g.children[1].id, L1b.id, "子[1]=L1b");
    eq(g.children[1].clippingMask, true, "L1b clip");

    // [2] = L2 叶（reference）
    eq(nodes[2].id, L2.id, "n2 id");
    eq(nodes[2].isReference, true, "L2 reference");

    // active 唯一：只有 L1
    let activeCount = 0;
    const walk = (ns) => ns.forEach((x) => { if (x.isActive) activeCount++; if (x.isGroup) walk(x.children); });
    walk(nodes);
    eq(activeCount, 1, "active 标记唯一");
  });

  T("空组往返：<stack></stack> → children []", () => {
    const d = new PaintDoc();
    const G = d.groupSelection(d.layers[0].id).group;   // 包住唯一叶
    G.children = [];                                     // 清空 → 空组（仅测序列化形状）
    const xml = buildStackXml(d);
    const { nodes } = parseStackXml(xml);
    eq(nodes.length, 1, "根 1 节点");
    eq(nodes[0].isGroup, true, "是组");
    eq(nodes[0].children.length, 0, "空组 children=[]");
  });
});

describe("ora-tree · 向后兼容（旧扁平 .ora）", () => {
  T("无 webpaint:id / 无 active → id null、active 全 false、扁平解析", () => {
    const oldXml = `<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.3" w="800" h="600">
  <stack name="root">
    <layer name="上" src="data/layer2.png" x="0" y="0" opacity="1.0000" visibility="visible" composite-op="svg:src-over" />
    <layer name="下" src="data/layer1.png" x="3" y="4" opacity="0.8000" visibility="hidden" composite-op="svg:multiply" />
  </stack>
</image>`;
    const { w, h, nodes } = parseStackXml(oldXml);
    eq(w, 800, "w"); eq(h, 600, "h");
    eq(nodes.length, 2, "2 叶扁平");
    // bottom-first：XML top="上"(layer2) → 反转后 [下, 上]
    eq(nodes[0].name, "下", "n0=下");
    eq(nodes[0].id, null, "无 id → null");
    eq(nodes[0].visible, false, "下 hidden");
    eq(nodes[0].mode, "multiply", "下 multiply");
    eq(nodes[1].name, "上", "n1=上");
    eq(nodes[1].isActive, false, "无 active 标记");
  });
});
