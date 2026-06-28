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

import { zipPack, zipUnpack } from "./zip.ts";
import { Layer, LayerGroup, PaintDoc, flattenLeaves, findNodeById, reseedLayerIdCounter } from "./doc.ts";
import { compositeLayers } from "./layer-composite.ts";
import { smartResample } from "./resample.ts";
import { makeBitmap } from "./bitmap.ts";
// 纯树↔stack.xml 序列化（嵌套组 + id + active）抽到独立深模块（无 canvas 依赖，可纯 node 测）。
import { buildStackXml, parseStackXml } from "./ora-stack-xml.ts";
import type { ParsedNode } from "./ora-stack-xml.ts";

// 2D 上下文：OffscreenCanvas / <canvas> 两种 ctx 共有 API（与 doc.ts 的 Ctx 同形）。
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
// renderMerged / encode 只读 doc 的 width/height/layers，与 PaintDoc 形状兼容。
type EncodeDoc = { width: number; height: number; layers: PaintDoc["layers"] };
// encode opts：两个可选 WebPaint 私有扩展。
interface EncodeOpts {
  referenceImage?: Blob;
  webpaintState?: object;
}
// decode 末尾写入 PaintDoc 上未声明的私有字段（store seam 读取），就地扩展形状。
type DecodedDoc = PaintDoc & {
  _referenceBlob?: Blob;
  _webpaintState?: unknown;
  _wroteWith: string | null;
};
// 加密对本 codec **不可见**（v235 起）：encode 永远出明文 ora、decode 永远收明文 ora。
// 包壳/解壳全在 store 深模块（flow.save/load/push/pull 自动处理；密码经 crypt seam）。
// 拿到加密容器字节请先走 store.unseal / flow.load，别直接喂这里（会报「缺 stack.xml」）。

// ---- 工具 ----

async function canvasToPngBytes(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Uint8Array> {
  // OffscreenCanvas 用 convertToBlob，HTMLCanvasElement 用 toBlob —— 运行时 feature-detect 分支
  let blob: Blob | null | undefined;
  const oc = canvas as OffscreenCanvas, hc = canvas as HTMLCanvasElement;
  if (typeof oc.convertToBlob === "function") {
    blob = await oc.convertToBlob({ type: "image/png" });
  } else if (typeof hc.toBlob === "function") {
    blob = await new Promise<Blob | null>((resolve) => hc.toBlob(resolve, "image/png"));
  } else {
    throw new Error("canvas 无 toBlob / convertToBlob");
  }
  if (!blob) throw new Error("canvas → blob 失败");
  return new Uint8Array(await blob.arrayBuffer());
}

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

// ---- encode：PaintDoc → .ora Blob ----

/**
 * 渲染整图合成预览。doc-size canvas + 逐 layer drawImage（带 bbox 偏移 + opacity + mode）。
 */
function renderMerged(doc: EncodeDoc) {
  const c = makeBitmap(doc.width, doc.height);
  const ctx = c.getContext("2d")!;
  // v134 (user：「即使 merged 也保留 alpha；ora 里 merged 同处理」)
  //   不涂 doc.backgroundColor 作 base —— ora 的 mergedimage.png 保 alpha，user 想要白底自己加层。
  // 合成走规范合成器（deep module A，含 clip + 组隔离）。ctx 已在 doc 坐标 1:1。无 live overlay。
  compositeLayers(ctx, doc.layers);
  return c;
}

/** 缩略图自适应：先按 256 编码，超 70KB 降 192，再超降 128，最后档不论大小都收。
 *  cloud-thumbs.js suffix budget = 80KB；留 ~10KB 给 zip 尾巴（CD + EOCD + 扫描余量）→ thumb ≤ 70KB
 *  返 { canvas, png: Uint8Array }
 */
async function renderThumbnailAdaptive(merged: OffscreenCanvas | HTMLCanvasElement, maxBytes = 71680) {
  const sizes = [256, 192, 128];
  let lastPng: Uint8Array | null = null, lastCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
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
 * step-halving 抗锯齿（细线稿单次大比例 drawImage 会出狗牙）统一收在 resample.js
 * 的 smartResample——之前这里抄了一份且循环条件写成 && 导致细长画布退化成单次缩，
 * 现删除重复实现直接复用 SSoT。
 */
function renderThumbnail(merged: OffscreenCanvas | HTMLCanvasElement, maxSide = 256) {
  const srcW = merged.width, srcH = merged.height;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const tw = Math.max(1, Math.round(srcW * scale));
  const th = Math.max(1, Math.round(srcH * scale));
  return smartResample(merged, tw, th);
}

/** doc → Blob (.ora)
 *
 * WebPaint 私有扩展（都在 webpaint/ 命名空间下，第三方 reader 会忽略或剥离）：
 *   webpaint/state.json   — 杂七杂八的应用状态（ref 小窗 open 标志、viewport 等）
 *   webpaint/reference.png — ref 小窗当前显示的图（原 Blob bytes）
 *
 * opts.referenceImage: optional Blob
 * opts.webpaintState:  optional object（直接 JSON.stringify）
 */
export async function encodeDocToOra(doc: EncodeDoc, opts: EncodeOpts = {}) {
  const merged = renderMerged(doc);
  const mergedPng = await canvasToPngBytes(merged);
  // thumb：自适应尺寸 256→192→128，目标 ≤ 80KB（让云端 48KB suffix 大概率命中）
  const { png: thumbPng } = await renderThumbnailAdaptive(merged);

  // entry 顺序很重要：
  //   1. spec 强制 mimetype 第一
  //   2. Thumbnails/thumbnail.png 故意放最后 → 云端 byte-range thumbnail（v137）
  //      只拉 last 128KB 就能一次性拿到 EOCD + CD + thumbnail data，省 2 次请求
  //   3. mergedimage / layer 是大块，放中间
  const entries: { path: string; data: string | Uint8Array }[] = [
    { path: "mimetype", data: "image/openraster" },
    { path: "stack.xml", data: buildStackXml(doc) },
    { path: "mergedimage.png", data: mergedPng },
  ];

  // 只有叶（Layer）有像素 canvas；组（LayerGroup）无 PNG，结构全在 stack.xml。
  for (const L of flattenLeaves(doc.layers)) {
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
  entries.push({ path: "Thumbnails/thumbnail.png", data: thumbPng as Uint8Array });

  // WebPaint 私有扩展：reference 小窗的图 + 杂项 state JSON。
  if (opts.referenceImage instanceof Blob) {
    const refBytes = new Uint8Array(await opts.referenceImage.arrayBuffer());
    entries.push({ path: "webpaint/reference.png", data: refBytes });
  }
  if (opts.webpaintState && typeof opts.webpaintState === "object") {
    const jsonText = JSON.stringify(opts.webpaintState);
    entries.push({ path: "webpaint/state.json", data: jsonText });
  }

  return await zipPack(entries);
}

// ---- decode：.ora Blob → PaintDoc ----

/** Blob (.ora 明文) → PaintDoc */
export async function decodeOraToDoc(blob: Blob) {
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

  const doc = new PaintDoc({ width: meta.w, height: meta.h }) as DecodedDoc;
  doc.layers = [];                                // 清掉 ctor 默认的 1 层
  let activeId: number | null = null;

  // spec 树 → 真节点（递归）。叶按 src 载 PNG；组递归建 children。
  //   持久化 id 直接覆盖（旧 .ora 无 id → spec.id=null → 留 ctor 发的新 id）。
  const buildNode = async (spec: ParsedNode): Promise<Layer | LayerGroup> => {
    if (spec.isGroup) {
      const g = new LayerGroup({ name: spec.name });
      if (spec.id != null) g.id = spec.id;
      g.visible = spec.visible;
      g.opacity = spec.opacity;
      g.mode = spec.mode;
      g.clippingMask = !!spec.clippingMask;
      g.children = [];
      for (const c of spec.children) g.children.push(await buildNode(c));
      if (spec.isActive) activeId = g.id;
      return g;
    }
    const png = files[spec.src];
    if (!png) throw new Error(`.ora 缺图层 PNG：${spec.src}`);
    const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
    const layer = new Layer({
      width: meta.w,
      height: meta.h,
      name: spec.name,
      empty: true,            // 起空，下面手填 bbox + canvas
    });
    if (spec.id != null) layer.id = spec.id;
    layer.visible = spec.visible;
    layer.opacity = spec.opacity;
    layer.mode = spec.mode;
    layer.clippingMask = !!spec.clippingMask;
    layer.lockAlpha = !!spec.lockAlpha;
    layer.replaceFromCanvas(bitmap, spec.x, spec.y, bitmap.width, bitmap.height);
    bitmap.close?.();
    if (spec.isActive) activeId = layer.id;
    if (spec.isReference) doc.referenceLayerId = layer.id;
    return layer;
  };

  for (const spec of meta.nodes) doc.layers.push(await buildNode(spec));

  if (doc.layers.length === 0) {
    // 防御：完全空 .ora → 给个默认层
    doc.layers.push(new Layer({ width: meta.w, height: meta.h, name: "图层 1" }));
  }
  // 持久化 id 可能高于运行时计数器 → 抬过最大值，防新建层撞号。
  reseedLayerIdCounter(doc.layers);
  // active 还原：优先 webpaint:active 标记节点；无标记（旧 .ora）→ 末叶（栈顶）。
  if (activeId != null && findNodeById(doc.layers, activeId)) {
    doc.activeId = activeId;
  } else {
    const leaves = flattenLeaves(doc.layers);
    doc.activeId = leaves.length ? leaves[leaves.length - 1].id : null;
  }
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
export function parseAppVersion(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = String(s).match(/^v(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
