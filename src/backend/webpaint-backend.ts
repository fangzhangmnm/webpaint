// WebPaintBackend —— backend 装配根（C7；契约 = ./webpaint-backend-interface.ts，提案 §3）。
// 与 app.ts 组合根的关系：app.ts 目前仍自装配同一套件（history+wp2+view+layers）跑浏览器壳；
// 本类是 headless/MCP/embedding 面的**第二个组合根**（装配的是同一批组件，非复刻逻辑）。
// 壳迁移到「app.ts 消费 WebPaintBackend」= C7 后棒（app-context 39 键瘦版的落点）。
//
// born-loaded：工厂返回时 doc 已在（blank 脚手架或 open 解码灌入）；无空态、无 load 方法。
// 换画 = 弃旧建新（dispose 旧 + 工厂新）。
//
// 注入清单（node 拿不到的才注入；node 里近乎无参）：
//   appVersion   —— .ora wrote-with 戳（壳传 WEBPAINT_VERSION；缺省 ""）
//   jpgEncoder   —— exportImage("jpg") 的编码器（壳 = canvas toBlob 域；headless 缺席响亮失败）
//   imageDecoder —— open() png 之外的位图解码（jpg/webp…；headless 缺席响亮失败）
// 合成面（mergedimage/exportImage/mergeDown）走 doc-render 全局接缝（setDocCompositorBytes）——
// per-tenant 合成注入 + GPU tile arena 归 Port 记账排 C7 后棒（handoff §1 C7 行）。

import { History } from "./workpiece/history.ts";
import { PaintingWorkpiece, type PaintingData, type PaintingDataNode } from "./workpiece/painting-workpiece.ts";
import { PaintingView } from "./workpiece/painting-view.ts";
import { LayersFace } from "./layers-face.ts";
import { renderNodesToBytes } from "./doc-render.ts";
import { encodeDocToOra, decodeOraToPainting, paintingDataToEncodeDoc, type DecodedPainting } from "./ora.ts";
import { encodePngFromBytes, decodePngToBytes, type RgbaPlane } from "./png-codec.ts";
import { isGroupNode, type TreeNode } from "./workpiece/layer-tree.ts";
import type {
  WebPaintBackendInterface, BackendLayerNode, BackendDocInfo, BackendChangeEvent,
  BackendOpResult, BackendAddResult, ResolvedBrushSnapshot, StrokeId, FilterSessionId,
} from "./webpaint-backend-interface.ts";

const UNDO_QUOTA_BYTES = 128 * 1024 * 1024;   // app.ts 同款配额

export interface BackendInject {
  appVersion?: string;
  jpgEncoder?: (plane: RgbaPlane) => Promise<Uint8Array>;
  imageDecoder?: (bytes: Uint8Array) => Promise<RgbaPlane>;
}

export interface BackendOpenResult {
  backend: WebPaintBackend;
  /** open 解出的壳 sidecar（backend 不解释，原样交壳）。 */
  sidecar: { editorState?: unknown; legacyState?: unknown; referencePng?: Uint8Array; wroteWith: string | null };
}

// ---- 魔数嗅探（open 路由归 backend）----
function sniffFormat(u8: Uint8Array): "ora-zip" | "psd" | "png" | "image" {
  if (u8.length >= 2 && u8[0] === 0x50 && u8[1] === 0x4b) return "ora-zip";                  // "PK"
  if (u8.length >= 4 && u8[0] === 0x38 && u8[1] === 0x42 && u8[2] === 0x50 && u8[3] === 0x53) return "psd";   // "8BPS"
  if (u8.length >= 4 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return "png";
  return "image";   // jpg/webp/… → 注入解码器
}

function blankData(meta: { width: number; height: number; backgroundColor?: string }): PaintingData {
  return {
    width: meta.width, height: meta.height,
    backgroundColor: meta.backgroundColor ?? "#ffffff",
    activeId: 1, referenceLayerId: null,
    nodes: [{ id: 1, name: "Layer 1", visible: true, opacity: 1, mode: "source-over", clippingMask: false, lockAlpha: false, pixels: null }],
  };
}

function singleImageData(plane: RgbaPlane): PaintingData {
  return {
    width: plane.w, height: plane.h, backgroundColor: "#ffffff",
    activeId: 1, referenceLayerId: null,
    nodes: [{
      id: 1, name: "Layer 1", visible: true, opacity: 1, mode: "source-over", clippingMask: false, lockAlpha: false,
      pixels: { rect: { x: 0, y: 0, w: plane.w, h: plane.h }, bytes: plane.data },
    }],
  };
}

export class WebPaintBackend implements WebPaintBackendInterface {
  private _history: History;
  private _wp2: PaintingWorkpiece;
  private _view: PaintingView;
  private _layers: LayersFace;
  private _inject: BackendInject;
  private _disposed = false;
  private _listeners = new Set<(ev: BackendChangeEvent) => void>();

  /** 进程内协作面（壳迁移期/测试直取引擎；embedding/MCP 只走接口方法——序列化墙那侧不存在这些）。 */
  get wp2(): PaintingWorkpiece { return this._wp2; }
  get view(): PaintingView { return this._view; }
  get layersFace(): LayersFace { return this._layers; }
  get history(): History { return this._history; }

  private constructor(data: PaintingData, inject: BackendInject) {
    this._inject = inject;
    this._history = new History({
      maxQuotaBytes: UNDO_QUOTA_BYTES,
      // headless 无 banner/重绘——不可恢复协议：栈已重置这一事实经 onChange 广播，壳自己渲。
      onUnrecoverable: () => { this._emit(); },
      onChange: () => this._emit(),
      onApplied: () => { /* 屏显刷新是壳的事（board 订 onChange） */ },
    });
    // born 出生形：1×1 脚手架树——仅存在于本构造函数内（load 立即换根），外界不可观测。
    this._wp2 = new PaintingWorkpiece({
      undo: this._history.stack,
      tree: { width: 1, height: 1, maxLeaves: (): number => this._view.maxLayers },
    });
    this._view = new PaintingView(this._wp2);
    this._history.attach(this._wp2);
    this._layers = new LayersFace({ history: this._history, tree: this._wp2.layerTree!, tiles: this._wp2.layerTiles, port: this._view });
    this._wp2.load(data);   // 令牌灌入 + 清栈 + markSaved（born-loaded 达成）
    this._wp2.onChange(() => this._emit());
  }

  // ── 静态工厂（路由归 backend）──

  static blank(meta: { width: number; height: number; backgroundColor?: string }, inject: BackendInject = {}): WebPaintBackend {
    return new WebPaintBackend(blankData(meta), inject);
  }

  /** 魔数嗅探：zip→ora、8BPS→psd（后棒）、png→UPNG 单图成层、其余→注入解码器单图成层。 */
  static async open(bytes: Uint8Array, inject: BackendInject = {}): Promise<BackendOpenResult> {
    const fmt = sniffFormat(bytes);
    if (fmt === "ora-zip") {
      const dec: DecodedPainting = await decodeOraToPainting(new Blob([bytes as unknown as BlobPart]));
      const backend = new WebPaintBackend(dec.data, inject);
      return {
        backend,
        sidecar: {
          editorState: dec._editorState, legacyState: dec._webpaintState,
          referencePng: dec._referenceBlob ? new Uint8Array(await dec._referenceBlob.arrayBuffer()) : undefined,
          wroteWith: dec._wroteWith,
        },
      };
    }
    if (fmt === "psd") {
      // psd 解码路由排 C7 后棒（psd.ts 尚在壳侧；先响亮失败，不静默）。
      throw new Error("WebPaintBackend.open: psd 路由未接（C7 后棒）——请先在壳侧解码");
    }
    const plane = fmt === "png"
      ? await decodePngToBytes(bytes)
      : await (inject.imageDecoder ?? (() => { throw new Error("WebPaintBackend.open: 非 png 位图需要注入 imageDecoder"); }))(bytes);
    const backend = new WebPaintBackend(singleImageData(plane), inject);
    return { backend, sidecar: { wroteWith: null } };
  }

  // ── 生命周期 ──

  get disposed(): boolean { return this._disposed; }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    // interrupt=cancel 家规：open transaction → 先取消（档口未接进程内实现前恒无；防御性断言留门）。
    // 换 1×1 空根释放当前 doc 全部 tileset → 清栈释放 undo 持有 → 观察者退租。
    this._wp2.load(blankData({ width: 1, height: 1 }));
    this._history.clear();
    this._wp2.layerTiles.dispose();
    this._listeners.clear();
  }

  private _guard(): void {
    if (this._disposed) throw new Error("WebPaintBackend: disposed（换画 = 弃旧建新）");
  }

  // ── 字节面 ──

  async encodeOra(opts: { editorSidecar?: object; referencePng?: Uint8Array } = {}): Promise<Uint8Array> {
    this._guard();
    // merged 合成（mergedimage/缩略图）：合成接缝可用则渲，GL 缺席 → null → 透明占位（层数据完整，
    // mergedimage 只是预览件——与 autosave GL-lost 兜底同语义）。
    const merged = renderNodesToBytes(this._view.layers, this._view.width, this._view.height);
    const frozen = paintingDataToEncodeDoc(this._wp2.exportData());
    const blob = await encodeDocToOra(frozen, {
      wroteWith: this._inject.appVersion ?? "",
      mergedBytes: merged,
      desk: opts.editorSidecar,
      referenceImage: opts.referencePng ? new Blob([opts.referencePng as unknown as BlobPart], { type: "image/png" }) : undefined,
    }) as Blob;
    return new Uint8Array(await blob.arrayBuffer());
  }

  async exportImage(fmt: "png" | "jpg"): Promise<Uint8Array> {
    this._guard();
    const merged = renderNodesToBytes(this._view.layers, this._view.width, this._view.height);
    if (!merged) throw new Error("exportImage: 合成不可用（无 GL/软合成注入）——响亮失败，不出占位图");
    if (fmt === "png") return encodePngFromBytes(merged.data, merged.w, merged.h);
    const enc = this._inject.jpgEncoder;
    if (!enc) throw new Error("exportImage: jpg 需要注入 jpgEncoder（壳 canvas 域）");
    return enc(merged);
  }

  // ── 读面 ──

  docInfo(): BackendDocInfo {
    this._guard();
    let leaves = 0;
    this._wp2.layerTree!.eachLeaf(() => leaves++);
    return {
      width: this._view.width, height: this._view.height, backgroundColor: this._view.backgroundColor,
      activeId: this._view.activeId, referenceLayerId: this._view.referenceLayerId,
      layerCount: leaves,
    };
  }

  layerTree(): BackendLayerNode[] {
    this._guard();
    const walk = (ns: readonly TreeNode[]): BackendLayerNode[] => ns.map((n) => isGroupNode(n)
      ? { id: n.id, name: n.name, visible: n.visible, opacity: n.opacity, mode: n.mode, clippingMask: n.clippingMask, children: walk(n.children) }
      : { id: n.id, name: n.name, visible: n.visible, opacity: n.opacity, mode: n.mode, clippingMask: n.clippingMask, lockAlpha: n.lockAlpha });
    return walk(this._wp2.layerTree!.view().nodes);
  }

  isDirty(): boolean { this._guard(); return this._wp2.isDirty(); }
  markSaved(): void { this._guard(); this._wp2.markSaved(); }

  // ── 层结构 verbs（LayersFace 穿接口衣：ViewLeaf → id 投影，其余原样）──

  layerAdd(name?: string): BackendAddResult {
    this._guard();
    const r = this._layers.addLayer(name);
    return r.ok ? { ok: true, id: r.layer.id } : { ok: false, msg: r.msg };
  }
  layerDuplicate(id: number): BackendAddResult {
    this._guard();
    const r = this._layers.duplicateLayer(id);
    return r.ok ? { ok: true, id: r.layer.id } : { ok: false, msg: r.msg };
  }
  layerRemove(id: number): BackendOpResult { this._guard(); return this._layers.removeLayer(id, ""); }
  layerMove(id: number, delta: number): BackendOpResult { this._guard(); return this._layers.moveLayer(id, delta); }
  layerMergeDown(id: number): BackendOpResult { this._guard(); return this._layers.mergeDown(id); }
  layerSetProp(id: number, prop: "name" | "visible" | "opacity" | "mode" | "clippingMask" | "lockAlpha", value: string | number | boolean): BackendOpResult {
    this._guard();
    return this._layers.setLayerProp(id, prop, value);
  }
  layerSetActive(id: number): boolean { this._guard(); return this._layers.setActive(id); }
  layerClear(id: number): BackendOpResult { this._guard(); return this._layers.clearLayer(id); }
  setReferenceLayer(id: number | null): BackendOpResult { this._guard(); return this._layers.setReferenceLayer(id); }

  // ── undo ──

  undo(): boolean { this._guard(); return this._history.undo(); }
  redo(): boolean { this._guard(); return this._history.redo(); }
  canUndo(): boolean { this._guard(); return this._history.canUndo(); }
  canRedo(): boolean { this._guard(); return this._history.canRedo(); }

  // ── 多步事务档口（契约 pin；进程内实现随 C8 SoftGl2Port 收编栅格域后落地）──

  strokeBegin(_leafId: number, _brush: ResolvedBrushSnapshot): StrokeId {
    throw new Error("strokeBegin: 进程内档口未接（C8——栅格域需 Gl2Port/SoftGl2Port）；浏览器壳期请走 input.ts→StrokeSession");
  }
  strokeAppend(_id: StrokeId, _points: Float32Array): void { throw new Error("strokeAppend: 档口未接（C8）"); }
  strokeEnd(_id: StrokeId): boolean { throw new Error("strokeEnd: 档口未接（C8）"); }
  strokeCancel(_id: StrokeId): void { throw new Error("strokeCancel: 档口未接（C8）"); }
  filterBegin(_leafId: number, _filterId: string): FilterSessionId {
    throw new Error("filterBegin: 进程内档口未接（C8）；浏览器壳期请走 filters-adjust surrogate 流");
  }
  filterSetParams(_id: FilterSessionId, _params: Record<string, unknown>): void { throw new Error("filterSetParams: 档口未接（C8）"); }
  filterCommit(_id: FilterSessionId): boolean { throw new Error("filterCommit: 档口未接（C8）"); }
  filterCancel(_id: FilterSessionId): void { throw new Error("filterCancel: 档口未接（C8）"); }

  // ── 事件 ──

  onChange(cb: (ev: BackendChangeEvent) => void): () => void {
    this._listeners.add(cb);
    return () => { this._listeners.delete(cb); };
  }

  private _emit(): void {
    if (this._disposed || this._listeners.size === 0) return;
    const ev: BackendChangeEvent = { canUndo: this._history.canUndo(), canRedo: this._history.canRedo(), isDirty: this._wp2.isDirty() };
    for (const cb of this._listeners) cb(ev);
  }
}

export type { PaintingData, PaintingDataNode };
