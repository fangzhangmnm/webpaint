import { WEBPAINT_VERSION } from "./version.js";
// OpenRaster stack.xml 序列化 —— **纯** 图层树 ↔ XML（无 canvas / 无 zip / 无 PNG）。
//
// 从 ora.js 抽出（batch 2）：buildStackXml / parseStackXml 只处理结构（嵌套组 + id + 属性），
// 不碰像素。好处：① 可纯 node 测（无 OffscreenCanvas 依赖，不毒 OSC-stub 测试生态）；
// ② 把「树→XML」这件单一职责的事打包成深模块，与 PNG/zip 的 codec（ora.js）解耦。
//
// 节点形状（与 doc.js 的 Layer / LayerGroup 对齐，但本模块不 import doc.js —— 只读字段）：
//   叶 Layer：{ isGroup:false, id, name, visible, opacity, mode, clippingMask, lockAlpha, bboxX, bboxY }
//   组 LayerGroup：{ isGroup:true, id, name, visible, opacity, mode, clippingMask, children:[] }
// 写入端额外读 doc.activeId / doc.referenceLayerId 决定 active / reference 标记。

// 写入端读到的节点 / doc 的最小结构（doc.js 本体仍未类型化）。
export interface OraNode {
  id: number;
  name: string;
  visible: boolean;
  opacity?: number;
  mode?: string;
  clippingMask?: boolean;
  isGroup: boolean;
  children?: OraNode[];
  bboxX?: number;
  bboxY?: number;
  lockAlpha?: boolean;
}
export interface OraDoc {
  layers: OraNode[];
  width: number;
  height: number;
  activeId?: number;
  referenceLayerId?: number;
}

// 读取端产出的 spec 节点（id 可能为 null：旧 .ora 无 webpaint:id，decode 时再发新 id）。
interface ParsedCommon {
  id: number | null;
  name: string;
  opacity: number;
  visible: boolean;
  mode: string;
  clippingMask: boolean;
  isActive: boolean;
}
export type ParsedNode =
  | (ParsedCommon & { isGroup: true; children: ParsedNode[] })
  | (ParsedCommon & { isGroup: false; src: string; x: number; y: number; lockAlpha: boolean; isReference: boolean });

const XML_ENT: Record<string, string> = {
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
};
function escapeXml(s: string): string {
  return String(s).replace(/[<>&"']/g, (c) => XML_ENT[c]);
}

// ---- canvas composite mode ↔ ORA composite-op ----

const MODE_TO_ORA: Record<string, string> = {
  "source-over": "svg:src-over",
  "multiply":    "svg:multiply",
  "screen":      "svg:screen",
  "overlay":     "svg:overlay",
  "darken":      "svg:darken",
  "lighten":     "svg:lighten",
  "color-dodge": "svg:color-dodge",
  "color-burn":  "svg:color-burn",
  "hard-light":  "svg:hard-light",
  "soft-light":  "svg:soft-light",
  "difference":  "svg:difference",
  "exclusion":   "svg:exclusion",
};
export function oraCompositeOp(canvasMode: string): string {
  return MODE_TO_ORA[canvasMode] || "svg:src-over";
}
const ORA_TO_MODE: Record<string, string> = Object.fromEntries(
  Object.entries(MODE_TO_ORA).map(([k, v]) => [v, k]),
);
export function canvasModeFromOra(op: string): string {
  return ORA_TO_MODE[op] || "source-over";
}

// ---- 写：doc 树 → stack.xml 字符串 ----

// 单节点 → XML（递归）。indent = 缩进层级（root stack 的直接子 = 2）。
//   Layer → 自闭合 <layer ... />；LayerGroup → <stack ...>children</stack>。
//   组与叶共享 name/opacity/visibility/composite-op/webpaint:id/clipping/active；
//   叶独有 src/x/y/lock-alpha/reference。
function nodeToXml(node: OraNode, doc: OraDoc, indent: number): string {
  const pad = "  ".repeat(indent);
  const common = [
    `name="${escapeXml(node.name)}"`,
    `opacity="${(node.opacity ?? 1).toFixed(4)}"`,
    `visibility="${node.visible ? "visible" : "hidden"}"`,
    `composite-op="${oraCompositeOp(node.mode || "source-over")}"`,
    `webpaint:id="${node.id}"`,
    ...(node.clippingMask ? [`webpaint:clipping="true"`] : []),
    ...(doc.activeId === node.id ? [`webpaint:active="true"`] : []),
  ];
  if (node.isGroup) {
    // ORA baseline 组隔离模型（与我们 layer-composite.groupNeedsIsolation 一致，故用**标准** isolation 属性，
    //   不用私有扩展 → 全合规 + 和 Krita/GIMP/MyPaint 互通）：
    //   隔离 ⟺ isolation="isolate" ‖ opacity<1 ‖ composite-op≠svg:src-over；非隔离时 composite-op 被忽略。
    //   映射：穿透 → src-over + isolation="auto"；正常(隔离) → src-over + isolation="isolate"；其它混合模式 → svg:<mode>。
    const groupAttrs = [
      ...common,
      `isolation="${node.mode === "pass-through" ? "auto" : "isolate"}"`,
    ];
    // children top-first（与 spec 一致）：同级倒序输出。
    const ch = node.children || [];
    const kids: string[] = [];
    for (let i = ch.length - 1; i >= 0; i--) {
      kids.push(nodeToXml(ch[i], doc, indent + 1));
    }
    const inner = kids.length ? `\n${kids.join("\n")}\n${pad}` : "";
    return `${pad}<stack ${groupAttrs.join(" ")}>${inner}</stack>`;
  }
  const attrs = [
    common[0],                                  // name
    `src="data/layer${node.id}.png"`,
    `x="${node.bboxX}"`,
    `y="${node.bboxY}"`,
    ...common.slice(1),                          // opacity/visibility/composite-op/id/clipping/active
    ...(node.lockAlpha ? [`webpaint:lock-alpha="true"`] : []),
    ...(doc.referenceLayerId === node.id ? [`webpaint:reference="true"`] : []),
  ];
  return `${pad}<layer ${attrs.join(" ")} />`;
}

export function buildStackXml(doc: OraDoc): string {
  // OpenRaster spec：layer 顺序 = top first（top of stack 在 XML 前）。
  // doc.layers[0] 是 bottom，所以同级倒序输出（递归在 nodeToXml 内）。
  const nodes: string[] = [];
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    nodes.push(nodeToXml(doc.layers[i], doc, 2));
  }
  // wrote-with：记录写入这份 .ora 时的 WebPaint 版本号。
  // 用途：读取端若发现比自己版本高 → 警告（避免旧版客户端静默吃掉新版图层属性）
  // 论证见 conversation v71→v72。
  const wroteWith = WEBPAINT_VERSION;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.3" w="${doc.width}" h="${doc.height}" xres="72" yres="72" xmlns:webpaint="https://github.com/fangzhangmnm/webpaint/ns" webpaint:wrote-with="${escapeXml(wroteWith)}">
  <stack name="root">
${nodes.join("\n")}
  </stack>
</image>
`;
  return xml;
}

// ---- 读：stack.xml 字符串 → spec 树（bottom-first）----

// 元素标签（去命名空间前缀、小写）。
function elemTag(el: Element): string {
  return (el.tagName || el.nodeName || "").toLowerCase().replace(/^.*:/, "");
}
// 单 DOM 元素 → spec（递归）。<layer> → 叶 spec；<stack> → 组 spec（含 children）。
//   id 解析自 webpaint:id（旧 .ora 无此属性 → null，decode 时发新 id）。
function parseNode(el: Element): ParsedNode {
  const idAttr = el.getAttribute("webpaint:id");
  const common: ParsedCommon = {
    id: idAttr != null && idAttr !== "" ? parseInt(idAttr, 10) : null,
    name: el.getAttribute("name") || "图层",
    opacity: parseFloat(el.getAttribute("opacity") || "1"),
    visible: (el.getAttribute("visibility") || "visible") === "visible",
    mode: canvasModeFromOra(el.getAttribute("composite-op") || "svg:src-over"),
    clippingMask: el.getAttribute("webpaint:clipping") === "true",
    isActive: el.getAttribute("webpaint:active") === "true",
  };
  if (elemTag(el) === "stack") {
    // 组 mode 按 ORA baseline 隔离规则反推（standard isolation 属性）：
    //   composite-op≠src-over → 该混合模式（本就隔离）；src-over 时 isolation=isolate→正常(隔离)、auto/缺→穿透。
    const compositeOp = el.getAttribute("composite-op") || "svg:src-over";
    const isolation = el.getAttribute("isolation") || "auto";
    const mode = compositeOp !== "svg:src-over"
      ? canvasModeFromOra(compositeOp)
      : (isolation === "isolate" ? "source-over" : "pass-through");
    return { ...common, mode, isGroup: true, children: parseChildren(el) };
  }
  return {
    ...common,
    isGroup: false,
    src: el.getAttribute("src") || "",
    x: parseInt(el.getAttribute("x") || "0", 10),
    y: parseInt(el.getAttribute("y") || "0", 10),
    lockAlpha: el.getAttribute("webpaint:lock-alpha") === "true",
    isReference: el.getAttribute("webpaint:reference") === "true",
  };
}
// 一个 stack 的直接子节点 → bottom-first spec 数组。
//   XML 是 top-first（spec 顺序），doc 内部 [0]=bottom，所以 reverse。
function parseChildren(stackEl: Element): ParsedNode[] {
  const kids = [...stackEl.children].filter((c) => {
    const t = elemTag(c);
    return t === "layer" || t === "stack";
  });
  kids.reverse();
  return kids.map(parseNode);
}

export function parseStackXml(xmlText: string): { w: number; h: number; nodes: ParsedNode[]; wroteWith: string | null } {
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = dom.querySelector("parsererror");
  if (err) throw new Error("stack.xml 解析失败：" + err.textContent);
  const image = dom.querySelector("image");
  if (!image) throw new Error("stack.xml 缺 <image>");
  const w = parseInt(image.getAttribute("w") || "0", 10);
  const h = parseInt(image.getAttribute("h") || "0", 10);
  if (!w || !h) throw new Error("stack.xml <image> w/h 无效");
  // root <stack>（image 的直接子 stack）。递归建树。
  const rootStack = [...image.children].find((c) => elemTag(c) === "stack");
  const nodes = rootStack ? parseChildren(rootStack) : [];
  const wroteWith = image.getAttribute("webpaint:wrote-with") || null;
  return { w, h, nodes, wroteWith };
}
