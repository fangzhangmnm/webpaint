// 规范图层合成器（deep module A）。「图层树 → 像素」的**唯一**实现。
//
// 历史上合成逻辑重复 5 处（board 实时 / ORA merged / PNG-JPG 导出 / PSD merged / 吸管），
// 各抄一份 clip+mode+opacity，已出现漂移 bug（PSD 无视 clip、吸管无视 mode/clip）。
// 本模块收口成一个递归树折叠：board / 导出 / 缩略图 / 吸管 全部走它。
//
// 约定（与被替换的 board._renderLayers 逐行对齐）：
//   - ctx 已被调用方 setTransform 到**目标坐标系**（通常 doc 坐标：doc(0,0)=ctx 原点）。
//     本模块 drawImage 的 dest 直接用 node.bboxX/Y/W/H（doc 坐标）。
//   - nodes 是**某一层级**的兄弟数组，index 0 = 底，末尾 = 顶。节点 = Layer(叶) | LayerGroup(组)。
//   - 背景（doc 底色 / 棋盘 / void）不在这里——调用方负责在调本函数前画好。
//
// clip（剪裁蒙版）语义（Procreate 兼容，按**同一 parent 级**解析，不跨组）：
//   - clip 节点往下找同级最近的「非clip、可见、有内容」节点当基底；连续 clip 链共基底。
//   - 基底必须可见；无可见基底 → clip 节点**不渲染**（= 用户语义「蒙版无效 / clip 跟基底隐显」）。
//
// 组隔离：组满足 mode≠source-over || opacity<1 || clippingMask || isolate → 先把子树合到独立 buffer
//   再按 group.opacity/mode（+clip）整体混；否则 pass-through（子层直接落 ctx，能与组下方层混）。

import { makeBitmap } from "./bitmap.js";

// 某一层级的剪裁基底解析。返回与 nodes 等长的数组：每项 = 基底**节点**（非 index）或 null。
// 叶：有内容 = bboxW>0&&bboxH>0；组：有内容 = 可见（无法廉价知道空组，按非空处理，安全上界）。
export function computeClipBaseForNodes(nodes) {
  const out = new Array(nodes.length).fill(null);
  let currentBase = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.clippingMask && currentBase) {
      out[i] = currentBase;
    } else {
      out[i] = null;
      const hasContent = n.isGroup ? n.visible : (n.visible && n.bboxW > 0 && n.bboxH > 0);
      if (!n.clippingMask && hasContent) currentBase = n;
    }
  }
  return out;
}

// 组是否需要隔离（先合 buffer 再整体混）。**pass-through 是唯一非隔离态**（PS 的两挡：
//   Pass Through = 纯收纳，子层直接和组下方背景混；Normal/任意模式/opacity<1/clip = 隔离=拍平再混）。
//   v278 起 group.mode==="pass-through" 是显式默认；其余一切（含 source-over/"正常"）都隔离。
function groupNeedsIsolation(group) {
  return group.mode !== "pass-through"
    || group.opacity < 1
    || group.clippingMask;
}

// 节点（叶或组）在 doc 坐标的内容包围盒，给隔离 buffer 定尺寸。组 = 子树并集。
function nodeContentBbox(node) {
  if (!node.isGroup) {
    if (node.bboxW <= 0 || node.bboxH <= 0) return null;
    return { x0: node.bboxX, y0: node.bboxY, x1: node.bboxX + node.bboxW, y1: node.bboxY + node.bboxH };
  }
  let b = null;
  for (const c of node.children) {
    if (!c.visible) continue;
    const cb = nodeContentBbox(c);
    if (!cb) continue;
    if (!b) b = { ...cb };
    else { b.x0 = Math.min(b.x0, cb.x0); b.y0 = Math.min(b.y0, cb.y0); b.x1 = Math.max(b.x1, cb.x1); b.y1 = Math.max(b.y1, cb.y1); }
  }
  return b;
}

// 合成一个层级的兄弟节点到 ctx（ctx 在 doc 坐标）。opts:
//   source(layer)    -> 用于该叶的源 canvas（board: surrogate 替换；默认 layer.canvas）
//   overlayFor(layer)-> 该叶的 live overlay（board 实时笔；已做过 selection/lockAlpha 裁剪）或 null
//   floatFor(node)   -> 该节点的自由变换浮层 render（{canvas,dstX,dstY}）或 null。画在**该节点之上、同级 z 位**
//                       （= 浮层骑在源层 z，不再盖所有层；note #2）。source-over/alpha1（同旧浮层外观，
//                       忽略源层 opacity/mode；commit 后才入层取层的 opacity/mode）。Slice 3 起可对多节点返回。
//   clipTmp(w,h)     -> 复用的剪裁离屏（board 有池；默认新建）
//   eraseTmp(w,h)    -> 复用的 erase/混合离屏（默认新建）
export function compositeLayers(ctx, nodes, opts = {}) {
  // ignoreClip：把每个节点当非 clip 画（scope==="active" 单层导出：导出该层 raw 像素，无视 clip 标志）。
  const baseFor = opts.ignoreClip ? new Array(nodes.length).fill(null) : computeClipBaseForNodes(nodes);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node.visible) continue;
    const base = baseFor[i];
    // clip 节点但同级无可见基底 → 不渲染（蒙版无效，跟基底隐显）。
    if (node.clippingMask && !base && !opts.ignoreClip) continue;

    if (node.isGroup) {
      _compositeGroup(ctx, node, base, opts);
      continue;
    }

    // 叶
    const overlay = opts.overlayFor ? opts.overlayFor(node) : null;
    const float = opts.floatFor ? opts.floatFor(node) : null;
    // 空层（bbox=0）且无 overlay/浮层 → 没东西画（overlay/float 是 doc 坐标，不依赖 layer bbox；
    //   浮层把源层挖空成空层时仍要画浮层）。
    if ((node.bboxW <= 0 || node.bboxH <= 0) && !overlay && !float) continue;

    const prevA = ctx.globalAlpha;
    const prevC = ctx.globalCompositeOperation;
    ctx.globalAlpha = node.opacity;
    ctx.globalCompositeOperation = node.mode || "source-over";
    if (base) _drawLeafClipped(ctx, node, base, overlay, opts);
    else _drawLayerWithOverlay(ctx, node, overlay, opts);
    ctx.globalAlpha = prevA;
    ctx.globalCompositeOperation = prevC;
    // 浮层（自由变换瞬态）：在源层 z 位、prevA/prevC 还原后画（source-over/源层外的 base 合成）。
    //   → 骑在源层之上、被更上方的层正常覆盖（note #2 修「浮层盖在所有层之上」）。
    if (float && float.canvas) {
      ctx.drawImage(float.canvas, float.dstX, float.dstY);
    }
  }
}

// 组：pass-through 直接落 ctx；隔离则先合 buffer 再按 group.opacity/mode(+clip) 整体混。
function _compositeGroup(ctx, group, base, opts) {
  if (!groupNeedsIsolation(group)) {
    // pass-through：子层直接落 ctx（能与组下方层混）。group 不影响 globalAlpha/comp。
    compositeLayers(ctx, group.children, opts);
    return;
  }
  const bb = nodeContentBbox(group);
  if (!bb) return;   // 空组
  const w = Math.max(1, Math.ceil(bb.x1) - Math.floor(bb.x0));
  const h = Math.max(1, Math.ceil(bb.y1) - Math.floor(bb.y0));
  const ox = Math.floor(bb.x0), oy = Math.floor(bb.y0);
  const buf = makeBitmap(w, h);
  const bctx = buf.getContext("2d");
  // buffer 在 doc 坐标：平移使 doc(ox,oy) → buffer(0,0)
  bctx.setTransform(1, 0, 0, 1, -ox, -oy);
  compositeLayers(bctx, group.children, opts);
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  // clip：组作为 clip 节点时，buffer dst-in 基底 alpha（基底可能是叶或组）
  if (group.clippingMask && base) {
    bctx.globalCompositeOperation = "destination-in";
    _drawNodeAlpha(bctx, base, ox, oy, opts);
    bctx.globalCompositeOperation = "source-over";
  }
  const prevA = ctx.globalAlpha;
  const prevC = ctx.globalCompositeOperation;
  ctx.globalAlpha = group.opacity;
  // pass-through 组被 opacity<1/clip 逼到隔离时，整体混仍按 Normal（穿透≠某种混合模式）。
  ctx.globalCompositeOperation = (group.mode === "pass-through") ? "source-over" : (group.mode || "source-over");
  ctx.drawImage(buf, 0, 0, w, h, ox, oy, w, h);
  ctx.globalAlpha = prevA;
  ctx.globalCompositeOperation = prevC;
}

// 把某节点的 alpha（叶=其 canvas；组=其合成结果）画到 dst-in 目标。给 clip 用。
function _drawNodeAlpha(tctx, node, originX, originY, opts) {
  if (!node.isGroup) {
    const src = (opts.source ? opts.source(node) : node.canvas);
    const overlay = opts.overlayFor ? opts.overlayFor(node) : null;
    if (!overlay) {
      tctx.drawImage(src, node.bboxX - originX, node.bboxY - originY);
      return;
    }
    // 基底正被实时编辑（描边/erase）→ 用 base⊕overlay 的 **live alpha** 当上方 clip 层的蒙版，
    //   让 clip 层描边中实时跟着重蒙（不是抬笔 commit 才更新）。tctx 已是 dst-in 模式，
    //   故先在独立 temp 烤好 (base⊕overlay) 再整块画进 tctx。
    let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
    const hasBasePx = node.bboxW > 0 && node.bboxH > 0;
    if (hasBasePx) { rx0 = node.bboxX; ry0 = node.bboxY; rx1 = node.bboxX + node.bboxW; ry1 = node.bboxY + node.bboxH; }
    rx0 = Math.min(rx0, overlay.bboxX); ry0 = Math.min(ry0, overlay.bboxY);
    rx1 = Math.max(rx1, overlay.bboxX + overlay.bboxW); ry1 = Math.max(ry1, overlay.bboxY + overlay.bboxH);
    const rw = rx1 - rx0, rh = ry1 - ry0;
    if (rw <= 0 || rh <= 0) return;
    const ec = (opts.eraseTmp ? opts.eraseTmp(rw, rh) : makeBitmap(rw, rh));
    const ectx = ec.getContext("2d");
    ectx.setTransform(1, 0, 0, 1, 0, 0);
    ectx.clearRect(0, 0, rw, rh);
    ectx.globalCompositeOperation = "source-over";
    if (hasBasePx) ectx.drawImage(src, node.bboxX - rx0, node.bboxY - ry0);
    ectx.globalAlpha = overlay.opacity;
    ectx.globalCompositeOperation = overlay.mode === "erase" ? "destination-out" : (overlay.blendMode || "source-over");
    ectx.drawImage(overlay.canvas, overlay.bboxX - rx0, overlay.bboxY - ry0);
    ectx.globalAlpha = 1;
    ectx.globalCompositeOperation = "source-over";
    tctx.drawImage(ec, 0, 0, rw, rh, rx0 - originX, ry0 - originY, rw, rh);
    return;
  }
  // 组基底：合到临时 buffer 取其 alpha（不带组自身 opacity/mode——只要形状）
  const bb = nodeContentBbox(node);
  if (!bb) return;
  const w = Math.max(1, Math.ceil(bb.x1) - Math.floor(bb.x0));
  const h = Math.max(1, Math.ceil(bb.y1) - Math.floor(bb.y0));
  const gx = Math.floor(bb.x0), gy = Math.floor(bb.y0);
  const gb = makeBitmap(w, h);
  const gctx = gb.getContext("2d");
  gctx.setTransform(1, 0, 0, 1, -gx, -gy);
  compositeLayers(gctx, node.children, opts);
  gctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.drawImage(gb, gx - originX, gy - originY);
}

// clip 叶：region = layer∪overlay bbox；在离屏画 (layer⊕overlay) → dst-in 基底 alpha → 整块 blit。
// 与 board._renderLayerClipped 逐行对齐（layer.opacity/mode 由调用方在 ctx 上已设，blit tmp 时生效）。
function _drawLeafClipped(ctx, layer, base, overlay, opts) {
  let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
  if (layer.bboxW > 0 && layer.bboxH > 0) {
    rx0 = layer.bboxX; ry0 = layer.bboxY; rx1 = layer.bboxX + layer.bboxW; ry1 = layer.bboxY + layer.bboxH;
  }
  if (overlay) {
    rx0 = Math.min(rx0, overlay.bboxX); ry0 = Math.min(ry0, overlay.bboxY);
    rx1 = Math.max(rx1, overlay.bboxX + overlay.bboxW); ry1 = Math.max(ry1, overlay.bboxY + overlay.bboxH);
  }
  const rw = rx1 - rx0, rh = ry1 - ry0;
  if (rw <= 0 || rh <= 0) return;
  const tmp = (opts.clipTmp ? opts.clipTmp(rw, rh) : makeBitmap(rw, rh));
  const tctx = tmp.getContext("2d");
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, rw, rh);
  tctx.setTransform(1, 0, 0, 1, -rx0, -ry0);   // doc 绝对坐标 → tmp
  _drawLayerWithOverlay(tctx, layer, overlay, opts);
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.globalCompositeOperation = "destination-in";
  _drawNodeAlpha(tctx, base, rx0, ry0, opts);
  tctx.globalCompositeOperation = "source-over";
  ctx.drawImage(tmp, 0, 0, rw, rh, rx0, ry0, rw, rh);
}

// 叶 + 可选 overlay 合成到 ctx（ctx 在 doc 坐标）。与 board._drawLayerWithOverlay 逐行对齐。
function _drawLayerWithOverlay(ctx, layer, overlay, opts) {
  const sourceCanvas = (opts.source ? opts.source(layer) : layer.canvas);
  const hasLayerPixels = layer.bboxW > 0 && layer.bboxH > 0;
  const overlayOp = !overlay ? "source-over"
    : overlay.mode === "erase" ? "destination-out"
    : (overlay.blendMode || "source-over");
  // 快通路：无 overlay 或普通叠加 → 直接落 ctx
  if (overlayOp === "source-over") {
    if (hasLayerPixels) {
      ctx.drawImage(sourceCanvas, 0, 0, layer.bboxW, layer.bboxH, layer.bboxX, layer.bboxY, layer.bboxW, layer.bboxH);
    }
    if (overlay) {
      const prevA = ctx.globalAlpha;
      ctx.globalAlpha = ctx.globalAlpha * overlay.opacity;
      ctx.drawImage(overlay.canvas, 0, 0, overlay.bboxW, overlay.bboxH, overlay.bboxX, overlay.bboxY, overlay.bboxW, overlay.bboxH);
      ctx.globalAlpha = prevA;
    }
    return;
  }
  // 复合通路（erase / 混合模式）：overlay 只对**本层像素**合成，在临时画布上 (layer ⊕ overlay) 烤好再整体 blit。
  if (!hasLayerPixels && overlay.mode === "erase") return;
  let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
  if (hasLayerPixels) {
    rx0 = layer.bboxX; ry0 = layer.bboxY; rx1 = layer.bboxX + layer.bboxW; ry1 = layer.bboxY + layer.bboxH;
  }
  rx0 = Math.min(rx0, overlay.bboxX); ry0 = Math.min(ry0, overlay.bboxY);
  rx1 = Math.max(rx1, overlay.bboxX + overlay.bboxW); ry1 = Math.max(ry1, overlay.bboxY + overlay.bboxH);
  const rw = rx1 - rx0, rh = ry1 - ry0;
  if (rw <= 0 || rh <= 0) return;
  const ec = (opts.eraseTmp ? opts.eraseTmp(rw, rh) : makeBitmap(rw, rh));
  const ectx = ec.getContext("2d");
  ectx.setTransform(1, 0, 0, 1, 0, 0);
  ectx.clearRect(0, 0, rw, rh);
  ectx.globalCompositeOperation = "source-over";
  if (hasLayerPixels) ectx.drawImage(sourceCanvas, layer.bboxX - rx0, layer.bboxY - ry0);
  ectx.globalAlpha = overlay.opacity;
  ectx.globalCompositeOperation = overlayOp;
  ectx.drawImage(overlay.canvas, overlay.bboxX - rx0, overlay.bboxY - ry0);
  ectx.globalAlpha = 1;
  ectx.globalCompositeOperation = "source-over";
  ctx.drawImage(ec, 0, 0, rw, rh, rx0, ry0, rw, rh);
}
