// OpenRaster (.ora) encode / decode。
//
// 标准：https://www.openraster.org/baseline/file-layout-spec.html
//
// .ora 是一个 zip，内部布局：
//   mimetype                 ASCII "image/openraster"（STORE，首个 entry）
//   stack.xml                XML 描述 <image><stack><layer .../></stack></image>
//   data/layerN.png          每层的 PNG bitmap（任意尺寸，由 stack.xml 的 x/y 决定位置）
//   mergedimage.png          整图合成预览（OneDrive 缩略图 / 其他 reader 兜底用）
//   Thumbnails/thumbnail.png 小缩略图（最长边 ≤ 256，规范要求）
//
// 我们的层 bbox 直接对应 spec 的 x / y / 自带尺寸 PNG —— 零转换。
//
// composite-op 映射：
//   "source-over"     → svg:src-over
//   "multiply"        → svg:multiply
//   ...（先只支持 source-over，phase 1 没图层 mode）
//
// **注意**：blob 全是 Uint8Array 传给 zip.js。Canvas.toBlob 拿到 Blob，需要
// arrayBuffer() 转 Uint8Array。

import { zipPack, zipUnpack } from "./zip.js";
import { Layer, PaintDoc } from "./doc.js";

// ---- 工具 ----

function makeBitmap(w, h) {
  if (typeof OffscreenCanvas !== "undefined") {
    try { return new OffscreenCanvas(w, h); } catch (_) {}
  }
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

async function canvasToPngBytes(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("canvas.toBlob 失败");
  return new Uint8Array(await blob.arrayBuffer());
}

function bytesToString(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  })[c]);
}

// ---- encode：PaintDoc → .ora Blob ----

/**
 * 渲染整图合成预览。doc-size canvas + 逐 layer drawImage（带 bbox 偏移 + opacity + mode）。
 */
function renderMerged(doc) {
  const c = makeBitmap(doc.width, doc.height);
  const ctx = c.getContext("2d");
  // 白底（doc.backgroundColor）
  ctx.fillStyle = doc.backgroundColor || "#ffffff";
  ctx.fillRect(0, 0, doc.width, doc.height);
  for (const L of doc.layers) {
    if (!L.visible) continue;
    if (L.bboxW <= 0 || L.bboxH <= 0) continue;
    const prevA = ctx.globalAlpha;
    const prevC = ctx.globalCompositeOperation;
    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = L.mode || "source-over";
    ctx.drawImage(L.canvas, L.bboxX, L.bboxY);
    ctx.globalAlpha = prevA;
    ctx.globalCompositeOperation = prevC;
  }
  return c;
}

/** 缩略图：最长边 = maxSide 的小图，PNG。 */
function renderThumbnail(merged, maxSide = 256) {
  const w = merged.width, h = merged.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const c = makeBitmap(tw, th);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(merged, 0, 0, tw, th);
  return c;
}

function buildStackXml(doc) {
  const layers = [];
  // OpenRaster spec：layer 顺序 = top first（top of stack 在 XML 前）。
  // doc.layers[0] 是 bottom，所以倒序输出。
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const L = doc.layers[i];
    if (L.bboxW <= 0 || L.bboxH <= 0) {
      // 空层：spec 允许 empty layer。仍输出占位 png（1×1 透明）
    }
    const attrs = [
      `name="${escapeXml(L.name)}"`,
      `src="data/layer${L.id}.png"`,
      `x="${L.bboxX}"`,
      `y="${L.bboxY}"`,
      `opacity="${L.opacity.toFixed(4)}"`,
      `visibility="${L.visible ? "visible" : "hidden"}"`,
      `composite-op="${oraCompositeOp(L.mode || "source-over")}"`,
    ];
    layers.push(`    <layer ${attrs.join(" ")} />`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.3" w="${doc.width}" h="${doc.height}" xres="72" yres="72">
  <stack name="root">
${layers.join("\n")}
  </stack>
</image>
`;
  return xml;
}

const MODE_TO_ORA = {
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
function oraCompositeOp(canvasMode) {
  return MODE_TO_ORA[canvasMode] || "svg:src-over";
}
const ORA_TO_MODE = Object.fromEntries(
  Object.entries(MODE_TO_ORA).map(([k, v]) => [v, k]),
);
function canvasModeFromOra(op) {
  return ORA_TO_MODE[op] || "source-over";
}

/** doc → Blob (.ora) */
export async function encodeDocToOra(doc) {
  const merged = renderMerged(doc);
  const thumb = renderThumbnail(merged, 256);
  const mergedPng = await canvasToPngBytes(merged);
  const thumbPng = await canvasToPngBytes(thumb);

  const entries = [
    // spec 要求 mimetype 是第一个 entry
    { path: "mimetype", data: "image/openraster" },
    { path: "stack.xml", data: buildStackXml(doc) },
    { path: "mergedimage.png", data: mergedPng },
    { path: "Thumbnails/thumbnail.png", data: thumbPng },
  ];

  for (const L of doc.layers) {
    let png;
    if (L.bboxW > 0 && L.bboxH > 0) {
      png = await canvasToPngBytes(L.canvas);
    } else {
      // 空层 → 1×1 透明 png
      const c = makeBitmap(1, 1);
      png = await canvasToPngBytes(c);
    }
    entries.push({ path: `data/layer${L.id}.png`, data: png });
  }

  return await zipPack(entries);
}

// ---- decode：.ora Blob → PaintDoc ----

function parseStackXml(xmlText) {
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = dom.querySelector("parsererror");
  if (err) throw new Error("stack.xml 解析失败：" + err.textContent);
  const image = dom.querySelector("image");
  if (!image) throw new Error("stack.xml 缺 <image>");
  const w = parseInt(image.getAttribute("w") || "0", 10);
  const h = parseInt(image.getAttribute("h") || "0", 10);
  if (!w || !h) throw new Error("stack.xml <image> w/h 无效");
  // 取所有 <layer>。spec 是 top-first 顺序，doc.layers[0] = bottom，所以反转。
  const layerNodes = [...dom.querySelectorAll("stack > layer")].reverse();
  const layers = layerNodes.map((n) => ({
    name: n.getAttribute("name") || "图层",
    src: n.getAttribute("src") || "",
    x: parseInt(n.getAttribute("x") || "0", 10),
    y: parseInt(n.getAttribute("y") || "0", 10),
    opacity: parseFloat(n.getAttribute("opacity") || "1"),
    visible: (n.getAttribute("visibility") || "visible") === "visible",
    mode: canvasModeFromOra(n.getAttribute("composite-op") || "svg:src-over"),
  }));
  return { w, h, layers };
}

/** Blob (.ora) → PaintDoc */
export async function decodeOraToDoc(blob) {
  const files = await zipUnpack(blob);
  if (!files["stack.xml"]) throw new Error(".ora 缺 stack.xml");
  // mimetype 检验（友好，不强制）
  if (files["mimetype"]) {
    const m = bytesToString(files["mimetype"]).trim();
    if (m !== "image/openraster") {
      console.warn(`[ora] mimetype 不是 image/openraster：${m}`);
    }
  }
  const xml = bytesToString(files["stack.xml"]);
  const meta = parseStackXml(xml);

  const doc = new PaintDoc({ width: meta.w, height: meta.h });
  doc.layers = [];                                // 清掉 ctor 默认的 1 层
  for (const L of meta.layers) {
    const png = files[L.src];
    if (!png) throw new Error(`.ora 缺图层 PNG：${L.src}`);
    const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
    const layer = new Layer({
      width: meta.w,
      height: meta.h,
      name: L.name,
      empty: true,            // 起空，下面手填 bbox + canvas
    });
    layer.visible = L.visible;
    layer.opacity = L.opacity;
    layer.mode = L.mode;
    layer.bboxX = L.x;
    layer.bboxY = L.y;
    layer.bboxW = bitmap.width;
    layer.bboxH = bitmap.height;
    layer.canvas = makeBitmap(bitmap.width, bitmap.height);
    layer.ctx = layer.canvas.getContext("2d", { willReadFrequently: false });
    layer.ctx.imageSmoothingEnabled = true;
    layer.ctx.imageSmoothingQuality = "low";
    layer.ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    doc.layers.push(layer);
  }
  if (doc.layers.length === 0) {
    // 防御：完全空 .ora → 给个默认层
    doc.layers.push(new Layer({ width: meta.w, height: meta.h, name: "图层 1" }));
  }
  doc.activeIndex = Math.max(0, doc.layers.length - 1);
  return doc;
}
