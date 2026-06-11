import { WEBPAINT_VERSION } from "./version.js";
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
import { Layer, PaintDoc, computeClipBaseFor } from "./doc.js";
// 加密（ADR-0012）：encode/decode 在这层**透明**处理三层容器 —— 所有调用方
// （save / push / pull / checkpoint / revert / import / local-adapter）自动获得加密能力。
// doc._encGuid != null 即「这是加密作品」（decode 时从容器读出 / 加密动作时生成）。
// encode 永不弹窗（密码不在内存 → 明确 throw）；decode 才交互（unpackContainerInteractive）。
import { looksEncryptedContainer, packContainer } from "./crypto-container.js";
import { getPassword, unpackContainerInteractive } from "./crypto-state.js";

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
  // OffscreenCanvas 用 convertToBlob，HTMLCanvasElement 用 toBlob —— 分支
  let blob;
  if (typeof canvas.convertToBlob === "function") {
    blob = await canvas.convertToBlob({ type: "image/png" });
  } else if (typeof canvas.toBlob === "function") {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } else {
    throw new Error("canvas 无 toBlob / convertToBlob");
  }
  if (!blob) throw new Error("canvas → blob 失败");
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
  // v134 (user：「即使 merged 也保留 alpha；ora 里 merged 同处理」)
  //   不再涂 doc.backgroundColor 作 base —— ora 的 mergedimage.png 也保 alpha
  //   user 想要白底自己加图层
  // Clipping mask：详细算法见 doc.js computeClipBaseFor + board.js _renderLayer*
  const baseFor = computeClipBaseFor(doc.layers);
  for (let i = 0; i < doc.layers.length; i++) {
    const L = doc.layers[i];
    if (!L.visible) continue;
    if (L.bboxW <= 0 || L.bboxH <= 0) continue;
    const baseIdx = baseFor[i];
    const prevA = ctx.globalAlpha;
    const prevC = ctx.globalCompositeOperation;
    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = L.mode || "source-over";
    if (baseIdx < 0) {
      ctx.drawImage(L.canvas, L.bboxX, L.bboxY);
    } else {
      const base = doc.layers[baseIdx];
      const tmp = makeBitmap(L.bboxW, L.bboxH);
      const tctx = tmp.getContext("2d");
      tctx.drawImage(L.canvas, 0, 0);
      tctx.globalCompositeOperation = "destination-in";
      tctx.drawImage(base.canvas, base.bboxX - L.bboxX, base.bboxY - L.bboxY);
      ctx.drawImage(tmp, L.bboxX, L.bboxY);
    }
    ctx.globalAlpha = prevA;
    ctx.globalCompositeOperation = prevC;
  }
  return c;
}

/** 缩略图自适应：先按 256 编码，超 70KB 降 192，再超降 128，最后档不论大小都收。
 *  cloud-thumbs.js suffix budget = 80KB；留 ~10KB 给 zip 尾巴（CD + EOCD + 扫描余量）→ thumb ≤ 70KB
 *  返 { canvas, png: Uint8Array }
 */
async function renderThumbnailAdaptive(merged, maxBytes = 71680) {
  const sizes = [256, 192, 128];
  let lastPng = null, lastCanvas = null;
  for (let i = 0; i < sizes.length; i++) {
    const c = renderThumbnail(merged, sizes[i]);
    const png = await canvasToPngBytes(c);
    lastPng = png; lastCanvas = c;
    if (png.byteLength <= maxBytes) return { canvas: c, png };
  }
  // 都超：用最小尺寸的结果
  return { canvas: lastCanvas, png: lastPng };
}

/** 缩略图：最长边 = maxSide 的小图。
 *
 * Step-down 多 pass 1/2 缩：浏览器 drawImage("high") 单次 4x+ 缩有狗牙；
 * 每次缩 1/2 + 高质量 bilinear ≈ box filter 多次叠加，等效抗锯齿。
 * 最后一步缩到精确目标。
 */
function renderThumbnail(merged, maxSide = 256) {
  const srcW = merged.width, srcH = merged.height;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const tw = Math.max(1, Math.round(srcW * scale));
  const th = Math.max(1, Math.round(srcH * scale));
  // 比例 ≤ 2x → 直接一次缩
  if (Math.max(srcW, srcH) <= maxSide * 2) {
    return _drawScaled(merged, tw, th);
  }
  // step-down：每次缩半直到下一步会过头
  let cur = merged;
  let curW = srcW, curH = srcH;
  while (curW > tw * 2 && curH > th * 2) {
    const nw = Math.max(1, Math.floor(curW / 2));
    const nh = Math.max(1, Math.floor(curH / 2));
    cur = _drawScaled(cur, nw, nh);
    curW = nw; curH = nh;
  }
  // 最后一步精确到 tw × th
  return _drawScaled(cur, tw, th);
}

function _drawScaled(src, w, h) {
  const c = makeBitmap(w, h);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
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
      // 私有属性：clipping mask + reference layer 标记
      ...(L.clippingMask ? [`webpaint:clipping="true"`] : []),
      ...(doc.referenceLayerId === L.id ? [`webpaint:reference="true"`] : []),
    ];
    layers.push(`    <layer ${attrs.join(" ")} />`);
  }
  // wrote-with：记录写入这份 .ora 时的 WebPaint 版本号。
  // 用途：读取端若发现比自己版本高 → 警告（避免旧版客户端静默吃掉新版图层属性）
  // 论证见 conversation v71→v72。
  const wroteWith = WEBPAINT_VERSION;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.3" w="${doc.width}" h="${doc.height}" xres="72" yres="72" xmlns:webpaint="https://github.com/fangzhangmnm/webpaint/ns" webpaint:wrote-with="${escapeXml(wroteWith)}">
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

/** doc → Blob (.ora)
 *
 * WebPaint 私有扩展（都在 webpaint/ 命名空间下，第三方 reader 会忽略或剥离）：
 *   webpaint/state.json   — 杂七杂八的应用状态（ref 小窗 open 标志、viewport 等）
 *   webpaint/reference.png — ref 小窗当前显示的图（原 Blob bytes）
 *
 * opts.referenceImage: optional Blob
 * opts.webpaintState:  optional object（直接 JSON.stringify）
 * opts.fileName:       optional string —— 加密容器 meta.bin 记真名（无 app 恢复时改回真名用）
 *
 * doc._encGuid 非空 → 产出加密容器（外层明文 zip + WinZip-AES payload + 尾部加密 thumb）
 * 而非裸 .ora。密码取统一图库密码（内存）；不在 → throw，**不**静默存明文。
 */
export async function encodeDocToOra(doc, opts = {}) {
  const merged = renderMerged(doc);
  const mergedPng = await canvasToPngBytes(merged);
  // thumb：自适应尺寸 256→192→128，目标 ≤ 80KB（让云端 48KB suffix 大概率命中）
  const { png: thumbPng } = await renderThumbnailAdaptive(merged);

  // entry 顺序很重要：
  //   1. spec 强制 mimetype 第一
  //   2. Thumbnails/thumbnail.png 故意放最后 → 云端 byte-range thumbnail（v137）
  //      只拉 last 128KB 就能一次性拿到 EOCD + CD + thumbnail data，省 2 次请求
  //   3. mergedimage / layer 是大块，放中间
  const entries = [
    { path: "mimetype", data: "image/openraster" },
    { path: "stack.xml", data: buildStackXml(doc) },
    { path: "mergedimage.png", data: mergedPng },
  ];

  for (const L of doc.layers) {
    let png;
    if (L.bboxW > 0 && L.bboxH > 0) {
      png = await canvasToPngBytes(L.canvas);
    } else {
      // 空层 → 1×1 透明 png。**必须先取一次 2d context**：OffscreenCanvas 从未 getContext 就
      // convertToBlob，Chromium 抛「offscreen canvas has no rendering content」→ 空层/空画布存不了。
      // （renderMerged 那条路径 makeBitmap 后立刻 getContext，所以不踩；只有这个占位分支漏了。）
      const c = makeBitmap(1, 1);
      c.getContext("2d");
      png = await canvasToPngBytes(c);
    }
    entries.push({ path: `data/layer${L.id}.png`, data: png });
  }

  // thumbnail 末尾（云端 byte-range 优化）
  entries.push({ path: "Thumbnails/thumbnail.png", data: thumbPng });

  // WebPaint 私有扩展：reference 小窗的图 + 杂项 state JSON。
  if (opts.referenceImage instanceof Blob) {
    const refBytes = new Uint8Array(await opts.referenceImage.arrayBuffer());
    entries.push({ path: "webpaint/reference.png", data: refBytes });
  }
  if (opts.webpaintState && typeof opts.webpaintState === "object") {
    const jsonText = JSON.stringify(opts.webpaintState);
    entries.push({ path: "webpaint/state.json", data: jsonText });
  }

  const plain = await zipPack(entries);
  if (!doc._encGuid) return plain;

  // 加密作品：裸 ora 进 data.bin，thumb（同一张自适应 PNG）加密后挂外层尾部。
  // 密码必须已在内存（doc 是解密打开的 / 刚设的）——不在就 throw，绝不静默降级成明文。
  const pw = getPassword();
  if (!pw) throw new Error("图库已锁定，无法加密保存（先解锁加密作品再存）");
  const oraBytes = new Uint8Array(await plain.arrayBuffer());
  return await packContainer({
    oraBytes,
    fileName: opts.fileName || null,
    guid: doc._encGuid,
    thumbPng,
    password: pw,
  });
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
    clippingMask: n.getAttribute("webpaint:clipping") === "true",
    isReference: n.getAttribute("webpaint:reference") === "true",
  }));
  const wroteWith = image.getAttribute("webpaint:wrote-with") || null;
  return { w, h, layers, wroteWith };
}

/** Blob (.ora | 加密容器) → PaintDoc。
 *  加密容器：先交互解包（内存密码直用；没有/不对 → in-app 弹窗循环，取消 throw），
 *  解出的 doc 带 _encGuid —— 之后 encode 自动保持加密。 */
export async function decodeOraToDoc(blob) {
  if (await looksEncryptedContainer(blob)) {
    const { oraBlob, guid } = await unpackContainerInteractive(blob);
    const doc = await _decodePlainOra(oraBlob);
    doc._encGuid = guid;
    return doc;
  }
  return await _decodePlainOra(blob);
}

async function _decodePlainOra(blob) {
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
    layer.clippingMask = !!L.clippingMask;
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
    if (L.isReference) doc.referenceLayerId = layer.id;
  }
  if (doc.layers.length === 0) {
    // 防御：完全空 .ora → 给个默认层
    doc.layers.push(new Layer({ width: meta.w, height: meta.h, name: "图层 1" }));
  }
  doc.activeIndex = Math.max(0, doc.layers.length - 1);
  // WebPaint 扩展：reference 小窗的图 + state JSON（可有可无）
  if (files["webpaint/reference.png"]) {
    doc._referenceBlob = new Blob([files["webpaint/reference.png"]], { type: "image/png" });
  }
  if (files["webpaint/state.json"]) {
    try {
      doc._webpaintState = JSON.parse(bytesToString(files["webpaint/state.json"]));
    } catch (e) {
      console.warn("[ora] webpaint/state.json parse failed:", e);
    }
  }
  doc._wroteWith = meta.wroteWith || null;
  return doc;
}

// 把版本号字符串（"v71-2026-05-28" 或 "v71"）解析成可比较的整数。
// 失败 → null（caller 跳过比较；零信息时不警告）
export function parseAppVersion(s) {
  if (!s) return null;
  const m = String(s).match(/^v(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
