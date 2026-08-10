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

// C7：backend 不 import error-badge（DOM funnel 是壳知识）——良性告警走注入槽，
// 壳 boot 接 error-badge funnel（app.ts；同 tiles/ setTilePoolLeakReporter 模式）。headless 默认静默。
let _oraLog: (msg: string) => void = () => {};
export function setOraLogReporter(fn: (msg: string) => void): void { _oraLog = fn; }
const reportError = (err: unknown, _level?: string) => _oraLog(String(err instanceof Error ? err.message : err));
import { zipPack, zipUnpack } from "./zip.ts";
import { areaResampleBytes } from "./algorithms/resample-bytes.ts";
import { encodePngFromBytes, decodePngToBytes } from "./png-codec.ts";
// 纯树↔stack.xml 序列化（嵌套组 + id + active）抽到独立深模块（无 canvas 依赖，可纯 node 测）。
import { buildStackXml, parseStackXml } from "./ora-stack-xml.ts";
import type { ParsedNode } from "./ora-stack-xml.ts";
import type { PaintingData, PaintingDataNode, PaintingDataLeaf } from "./workpiece/painting-workpiece.ts";

// encode 消费面（T3b-2 起纯结构 duck-type）：叶必须带 getImageData（v0.6.44 真机教训——unsafe cast
// 曾把缺方法漏过 tsc）。activeId/referenceLayerId 必填（v0.7.8 FrozenDoc 漏抄 referenceLayerId 教训）。
// 三种来源同形直入：PaintingView 活 view 节点（导出路径）/ exportData 冻结快照经
// paintingDataToEncodeDoc（保存路径）/ 测试手搭。
export interface EncodeLeaf {
  isGroup: false; id: number; name: string; visible: boolean; opacity: number; mode: string;
  clippingMask: boolean; lockAlpha: boolean;
  bboxX: number; bboxY: number; bboxW: number; bboxH: number;
  getImageData(x: number, y: number, w: number, h: number): ImageData;
}
export interface EncodeGroup {
  isGroup: true; id: number; name: string; visible: boolean; opacity: number; mode: string;
  clippingMask: boolean; children: EncodeNode[];
}
export type EncodeNode = EncodeLeaf | EncodeGroup;
type EncodeDoc = {
  width: number; height: number; layers: readonly EncodeNode[];
  activeId: number | null; referenceLayerId: number | null;
};

function flattenEncodeLeaves(nodes: readonly EncodeNode[]): EncodeLeaf[] {
  const out: EncodeLeaf[] = [];
  const walk = (ns: readonly EncodeNode[]) => { for (const n of ns) { if (n.isGroup) walk(n.children); else out.push(n); } };
  walk(nodes);
  return out;
}

/** exportData 冻结快照 → encode 消费面（保存路径的 freezeDocForEncode 后继；bytes 已当场拷出，
 *  getImageData = 纯切片，无 canvas、无追写风险）。 */
export function paintingDataToEncodeDoc(data: PaintingData): EncodeDoc {
  const leafView = (n: PaintingDataLeaf): EncodeLeaf => {
    const px = n.pixels;
    return {
      isGroup: false, id: n.id!, name: n.name, visible: n.visible, opacity: n.opacity, mode: n.mode,
      clippingMask: n.clippingMask, lockAlpha: n.lockAlpha,
      bboxX: px?.rect.x ?? 0, bboxY: px?.rect.y ?? 0, bboxW: px?.rect.w ?? 0, bboxH: px?.rect.h ?? 0,
      getImageData(x: number, y: number, w: number, h: number): ImageData {
        const out = new Uint8ClampedArray(w * h * 4);
        if (px) {
          const { rect, bytes } = px;
          for (let row = 0; row < h; row++) {
            const sy = y + row - rect.y;
            if (sy < 0 || sy >= rect.h) continue;
            const cx0 = Math.max(x, rect.x), cx1 = Math.min(x + w, rect.x + rect.w);
            if (cx1 <= cx0) continue;
            const srcOff = (sy * rect.w + (cx0 - rect.x)) * 4;
            out.set(bytes.subarray(srcOff, srcOff + (cx1 - cx0) * 4), (row * w + (cx0 - x)) * 4);
          }
        }
        return new ImageData(out, w, h);
      },
    };
  };
  const walk = (ns: readonly PaintingDataNode[]): EncodeNode[] => ns.map((n): EncodeNode =>
    "children" in n
      ? { isGroup: true, id: n.id!, name: n.name, visible: n.visible, opacity: n.opacity, mode: n.mode, clippingMask: n.clippingMask, children: walk(n.children) }
      : leafView(n));
  return {
    width: data.width, height: data.height, layers: walk(data.nodes),
    activeId: data.activeId ?? null, referenceLayerId: data.referenceLayerId ?? null,
  };
}
// encode opts：wroteWith 必填（C7：版本戳是壳知识，backend 不 import version.ts）+ 两个可选 WebPaint 私有扩展。
interface EncodeOpts {
  wroteWith: string;   // stack.xml webpaint:wrote-with 版本戳（壳传 WEBPAINT_VERSION；backend 装配传注入的 appVersion）
  mergedBytes?: { data: Uint8ClampedArray; w: number; h: number } | null;   // S9/C3：调用方渲好的合成字节（GL renderNodesToBytes）；缺省=透明占位
  referenceImage?: Blob;
  desk?: object;   // desk.Serialize() → .webpaint/editor-state.json（desk per-doc；不向后兼容 webpaint/state.json）
}
// decode 产物（T3b-2）：plain data（wp2.load 灌入）+ WebPaint 私有 sidecar 随行。
// 字段名沿旧 DecodedDoc 下划线惯例——session-state 消费面零改名。
export interface DecodedPainting {
  data: PaintingData;
  _referenceBlob?: Blob;
  _webpaintState?: unknown;
  _editorState?: unknown;   // .webpaint/editor-state.json → desk.Unserialize()
  _wroteWith: string | null;
}
// 加密对本 codec **不可见**（v235 起）：encode 永远出明文 ora、decode 永远收明文 ora。
// 包壳/解壳全在 store 深模块（flow.save/load/push/pull 自动处理；密码经 crypt seam）。
// 拿到加密容器字节请先走 store.unseal / flow.load，别直接喂这里（会报「缺 stack.xml」）。

// ---- 工具 ----

// （canvasToPngBytes 已收进 src/png-codec.ts 止血 facade——PNG 编解码唯一接缝，库外禁越狱 canvas。）

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

// ---- encode：PaintDoc → .ora Blob ----

/** 缩略图自适应：先按 256 编码，超 70KB 降 192，再超降 128，最后档不论大小都收。
 *  cloud-thumbs.js suffix budget = 80KB；留 ~10KB 给 zip 尾巴（CD + EOCD + 扫描余量）→ thumb ≤ 70KB
 *  返 png: Uint8Array。
 *  C3：全字节管线——缩小走 areaResampleBytes（面积平均 = 抗锯齿正解，α 加权；旧 canvas
 *  step-halving 是它的近似，细线稿狗牙教训同样成立）。
 */
async function renderThumbnailAdaptive(merged: { data: Uint8ClampedArray; w: number; h: number }, maxBytes = 71680) {
  const sizes = [256, 192, 128];
  let lastPng: Uint8Array | null = null;
  for (let i = 0; i < sizes.length; i++) {
    const scale = Math.min(1, sizes[i] / Math.max(merged.w, merged.h));
    const tw = Math.max(1, Math.round(merged.w * scale));
    const th = Math.max(1, Math.round(merged.h * scale));
    const px = scale < 1 ? areaResampleBytes(merged.data, merged.w, merged.h, tw, th) : merged.data;
    const png = await encodePngFromBytes(px, tw, th);
    lastPng = png;
    if (png.byteLength <= maxBytes) return png;
  }
  // 都超：用最小尺寸的结果
  return lastPng!;
}

/** doc → Blob (.ora)
 *
 * WebPaint 私有扩展（都在 webpaint/ 命名空间下，第三方 reader 会忽略或剥离）：
 *   webpaint/reference.png     — ref 小窗当前显示的图（原 Blob bytes）
 *   .webpaint/editor-state.json — desk struct（desk per-doc；含 toolDials/palette/blender 三组）
 *   （旧轨 webpaint/state.json **v0.8.21 起停写**——ADR-0008 §9；decode 读兼容保留存量，拔除另议）
 *
 * opts.referenceImage: optional Blob
 */
export async function encodeDocToOra(doc: EncodeDoc, opts: EncodeOpts) {
  // S9：merged 由调用方渲入（opts.mergedBytes，GL 合成字节、与 display 同源；v134 约定保 alpha 不涂底）。
  //   缺省（node 测试 / GL lost 的 autosave 兜底）= 透明占位——层数据完整，mergedimage 只是预览件。
  const merged = opts.mergedBytes
    ?? { data: new Uint8ClampedArray(doc.width * doc.height * 4), w: doc.width, h: doc.height };
  const mergedPng = await encodePngFromBytes(merged.data, merged.w, merged.h);
  // thumb：自适应尺寸 256→192→128，目标 ≤ 80KB（让云端 48KB suffix 大概率命中）
  const thumbPng = await renderThumbnailAdaptive(merged);

  // entry 顺序很重要：
  //   1. spec 强制 mimetype 第一
  //   2. Thumbnails/thumbnail.png 故意放最后 → 云端 byte-range thumbnail（v137）
  //      只拉 last 128KB 就能一次性拿到 EOCD + CD + thumbnail data，省 2 次请求
  //   3. mergedimage / layer 是大块，放中间
  const entries: { path: string; data: string | Uint8Array }[] = [
    { path: "mimetype", data: "image/openraster" },
    { path: "stack.xml", data: buildStackXml(doc, opts.wroteWith) },
    { path: "mergedimage.png", data: mergedPng },
  ];

  // 只有叶有像素；组无 PNG，结构全在 stack.xml。
  for (const L of flattenEncodeLeaves(doc.layers)) {
    let png;
    if (L.bboxW > 0 && L.bboxH > 0) {
      // v0.6.42：tiles 字节直读进 codec facade（不再经 L.canvas 物化）
      png = await encodePngFromBytes(L.getImageData(L.bboxX, L.bboxY, L.bboxW, L.bboxH).data, L.bboxW, L.bboxH);
    } else {
      // 空层 → 1×1 透明 png（C3：直接字节编码；旧 makeBitmap+getContext 的 Chromium 空 canvas 坑随之蒸发）。
      png = await encodePngFromBytes(new Uint8ClampedArray(4), 1, 1);
    }
    entries.push({ path: `data/layer${L.id}.png`, data: png });
  }

  // WebPaint 私有扩展：reference 小窗的图 + desk sidecar。
  // Thumbnails/thumbnail.png 放**最后一个 entry**：缩略图 byte-range 提取先拉尾片 80KB，thumbnail 在尾
  //   → 一发命中、零额外请求。故 reference.png / editor-state.json 都排在它之前。
  //   历史：v398 前 reference.png 被 push 在 thumbnail 之后，那时库靠「尾部硬扫最后一个 PNG」找缩略图，
  //   会先扫到 reference.png → 缩略图错显成参考图。v399 起库改**按文件名**解 CD 取 entry，位置不再决定对错
  //   （错图 bug 根治），但 thumbnail 放最后仍是最省 byte-range 的约定。
  if (opts.referenceImage instanceof Blob) {
    const refBytes = new Uint8Array(await opts.referenceImage.arrayBuffer());
    entries.push({ path: "webpaint/reference.png", data: refBytes });
  }
  // desk struct（desk per-doc）→ .webpaint/editor-state.json（旧轨 webpaint/state.json v0.8.21 停写）。
  if (opts.desk && typeof opts.desk === "object") {
    entries.push({ path: ".webpaint/editor-state.json", data: JSON.stringify(opts.desk) });
  }

  // thumbnail 末尾（云端 byte-range 优化）——必须是最后一个 entry，见上方 reference.png 注释。
  entries.push({ path: "Thumbnails/thumbnail.png", data: thumbPng as Uint8Array });

  // C7 决定论 encode：entry 时间戳钉死 zip epoch（1980-01-01）——同内容 → 同字节
  // （backend round-trip 锚；云 diff 友好）。zip entry 日期无消费者（同步/peek 全按文件级元数据）。
  return await zipPack(entries, { lastModDate: new Date(Date.UTC(1980, 0, 1, 0, 0, 0)) });
}

// ---- decode：.ora Blob → PaintingData（T3b-2：plain data，wp2.load 灌入）----

/** Blob (.ora 明文) → DecodedPainting（json 形 + 内联 tile 字节 + sidecar）。 */
export async function decodeOraToPainting(blob: Blob): Promise<DecodedPainting> {
  const files = await zipUnpack(blob);
  if (!files["stack.xml"]) throw new Error(".ora 缺 stack.xml");
  // mimetype 检验（友好，不强制）
  if (files["mimetype"]) {
    const m = bytesToString(files["mimetype"]).trim();
    if (m !== "image/openraster") {
      reportError(`[ora] mimetype 不是 image/openraster：${m}`, "log");
    }
  }
  const xml = bytesToString(files["stack.xml"]);
  const meta = parseStackXml(xml);

  // id 分配：持久化 id 直接沿用；旧 .ora 无 id → 本地自增补号（避开已用号；
  //   active/reference 标记要能指到节点，所以补号在 decode 侧做、不留给 load 的 auto）。
  const usedIds = new Set<number>();
  const collectIds = (specs: ParsedNode[]) => {
    for (const sp of specs) { if (sp.id != null) usedIds.add(sp.id); if (sp.isGroup) collectIds(sp.children); }
  };
  collectIds(meta.nodes);
  let auto = 1;
  const nextAuto = () => { while (usedIds.has(auto)) auto++; usedIds.add(auto); return auto; };

  let activeId: number | null = null;
  let referenceLayerId: number | null = null;

  // spec 树 → plain data（递归）。叶按 src 载 PNG 字节；组递归建 children。
  const buildNode = async (spec: ParsedNode): Promise<PaintingDataNode> => {
    const id = spec.id ?? nextAuto();
    if (spec.isGroup) {
      const children: PaintingDataNode[] = [];
      for (const c of spec.children) children.push(await buildNode(c));
      if (spec.isActive) activeId = id;
      return {
        id, name: spec.name, visible: spec.visible, opacity: spec.opacity, mode: spec.mode,
        clippingMask: !!spec.clippingMask, children,
      };
    }
    const png = files[spec.src];
    if (!png) throw new Error(`.ora 缺图层 PNG：${spec.src}`);
    const px = await decodePngToBytes(png);   // v0.6.42：走 codec facade（换 UPNG/自研只改 png-codec.ts）
    if (spec.isActive) activeId = id;
    if (spec.isReference) referenceLayerId = id;
    // 1×1 全透明占位（空层的编码形）→ pixels:null（空叶）；其余整块内联。
    const isBlank = px.w * px.h === 1 && px.data[3] === 0;
    return {
      id, name: spec.name, visible: spec.visible, opacity: spec.opacity, mode: spec.mode,
      clippingMask: !!spec.clippingMask, lockAlpha: !!spec.lockAlpha,
      pixels: isBlank ? null : { rect: { x: spec.x, y: spec.y, w: px.w, h: px.h }, bytes: px.data },
    };
  };

  const nodes: PaintingDataNode[] = [];
  for (const spec of meta.nodes) nodes.push(await buildNode(spec));
  if (nodes.length === 0) {
    // 防御：完全空 .ora → 给个默认层
    nodes.push({ id: nextAuto(), name: "图层 1", visible: true, opacity: 1, mode: "source-over", clippingMask: false, lockAlpha: false, pixels: null });
  }
  // active 还原：优先 webpaint:active 标记节点；无标记（旧 .ora）→ 末叶（栈顶）= load 的 firstLeaf
  //   兜底不同——这里显式取末叶，语义沿旧 decodeOraToDoc。
  if (activeId == null) {
    const leaves: number[] = [];
    const walkLeaves = (ns: PaintingDataNode[]) => { for (const n of ns) { if ("children" in n) walkLeaves(n.children); else leaves.push(n.id!); } };
    walkLeaves(nodes);
    activeId = leaves.length ? leaves[leaves.length - 1] : null;
  }

  const out: DecodedPainting = {
    data: { width: meta.w, height: meta.h, activeId, referenceLayerId, nodes },
    _wroteWith: meta.wroteWith || null,
  };
  // WebPaint 扩展：reference 小窗的图 + state JSON（可有可无）
  if (files["webpaint/reference.png"]) {
    out._referenceBlob = new Blob([files["webpaint/reference.png"]], { type: "image/png" });
  }
  if (files["webpaint/state.json"]) {
    try {
      out._webpaintState = JSON.parse(bytesToString(files["webpaint/state.json"]));
    } catch (e) {
      reportError(new Error("[ora] webpaint/state.json parse failed: " + String(e)), "log");
    }
  }
  // desk struct（desk per-doc）；缺失（老画作/不向后兼容）→ 留 undefined，adopt 时 reset 到默认。
  if (files[".webpaint/editor-state.json"]) {
    try {
      out._editorState = JSON.parse(bytesToString(files[".webpaint/editor-state.json"]));
    } catch (e) {
      reportError(new Error("[ora] .webpaint/editor-state.json parse failed: " + String(e)), "log");
    }
  }
  return out;
}

// 把版本号字符串解析成可比较的整数，横跨新旧两种命名制（0.4 纪元换制）：
//   新制 "v0.4.0-2026-07-22" / "v0.4.0" → (major*100+minor)*1e6+patch
//   旧制 "v438-2026-07-18" / "v438"     → 统一归入 0.3 纪元（= v0.3.438），与新制全序可比
// （旧制 patch 是单调单序列，所以 v438 < v0.4.0 < v0.4.10 < v0.5.0 成立。）
// 失败 → null（caller 跳过比较；零信息时不警告）
export function parseAppVersion(s: string | null | undefined): number | null {
  if (!s) return null;
  const str = String(s);
  const dotted = str.match(/^v(\d+)\.(\d+)\.(\d+)/);
  if (dotted) {
    return (parseInt(dotted[1], 10) * 100 + parseInt(dotted[2], 10)) * 1_000_000 + parseInt(dotted[3], 10);
  }
  const legacy = str.match(/^v(\d+)/);
  return legacy ? 3 * 1_000_000 + parseInt(legacy[1], 10) : null;
}
