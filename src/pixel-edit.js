// 像素编辑事务（PixelEdit）。把"一次按-拖-抬产生的 layer 像素改动"收成一个 undo 事务。
//
// 设计见 docs/undo-architecture.md / CONTEXT.md（领域词 PixelEdit）。给下个 AI：
//
// - 之前 stroke / liquify / filterBrush / shapes 各自抄一遍 "拍 before → 改 → 拍 after →
//   build entry → push → 异步压缩 before/after" + 一对 _<tool>LayerId/_<tool>PreSnap 字段。
//   塌缩成事务：begin(layer,type) 拍 before，commit(finalize) 拍 after+入栈+压缩，abort() 还原。
// - 纯 in-process（内存 canvas，无 I/O）。可拿 fake Layer + 真 UndoStack 独立测，不碰 Board/pointer。
// - 只管纯像素两类（stroke / liquify；filterBrush 复用 "stroke" type）。
//   lasso 的复合 entry（像素 + 选区，一步 undo）与 selectionChange 不归这里——它们用下面的原语。
// - render 策略留在 caller（各工具 partial / full 不同），commit/abort 不替 caller 决定刷新粒度。

import { findNodeById } from "./doc.js";   // 递归按 id 找叶（图层树：层可能在组内）

// ---- 低层原语（export；lasso 复合 handler + app.js 图层 handler 都复用这套）----

// 取 Layer.snapshot() 出来的 { bboxX/Y/W/H, imageData } 异步压成 PNG Blob。
// 成功时回调拿到 Blob 且 snap.imageData 被置 null 释放 raw。失败保留 imageData（仍可走 imageData 路径）。
export function compressPixelSnap(snap, onBlob) {
  if (!snap || !snap.imageData) { onBlob(null); return; }
  if (snap.bboxW <= 0 || snap.bboxH <= 0) { snap.imageData = null; onBlob(null); return; }
  const c = document.createElement("canvas");
  c.width = snap.bboxW;
  c.height = snap.bboxH;
  c.getContext("2d").putImageData(snap.imageData, 0, 0);
  c.toBlob((blob) => {
    if (!blob) { onBlob(null); return; }
    snap.imageData = null;     // 释放 raw
    onBlob(blob);
  }, "image/png");
}

// 把 { snap, blob } 应用到指定 layer。imageData 优先（同步），否则解 blob（异步）。
// invalidateAll 在像素到位后才调，避免渲染 stale 帧 flash。
export function applyPixelSnap(doc, layerId, snap, blob, board) {
  const layer = findNodeById(doc.layers, layerId);
  if (!layer) return Promise.resolve();
  if (snap && snap.imageData) {
    layer.restoreFromSnapshot(snap);
    board?.invalidateAll();
    return Promise.resolve();
  }
  if (!blob) {
    if (snap) layer.restoreFromSnapshot({ ...snap, imageData: null });
    board?.invalidateAll();
    return Promise.resolve();
  }
  return createImageBitmap(blob).then((bitmap) => {
    layer.restoreFromSnapshot({ ...snap, bitmap });
    bitmap.close?.();
    board?.invalidateAll();
  });
}

// ---- 一次像素编辑事务 ----
// commit(finalize?) 里 finalize(layer, preSnap) 在拍 after 之前跑——选区 mask 的插槽
// （#2 选区模块将来把 selection.applyMaskPostStroke 插这里）。preSnap 保持私有。
class PixelEditTx {
  constructor(owner, layer, type) {
    this._owner = owner;
    this._type = type;
    this._layerId = layer.id;
    this._pre = layer.snapshot();
  }
  // 入栈成功返回 true；layer 中途没了（删层）→ 不入栈返回 false。
  commit(finalize) {
    const layer = findNodeById(this._owner.doc.layers, this._layerId);
    if (!layer) return false;
    if (finalize) finalize(layer, this._pre);
    const entry = {
      type: this._type,
      layerId: this._layerId,
      before: this._pre,
      after: layer.snapshot(),
      beforeBlob: null,
      afterBlob: null,
    };
    this._owner.history.push(entry);
    compressPixelSnap(entry.before, (blob) => { entry.beforeBlob = blob; });
    compressPixelSnap(entry.after,  (blob) => { entry.afterBlob  = blob; });
    return true;
  }
  // 还原到 preSnap，不入栈。always invalidateAll（像素回退要全刷）。
  abort() {
    const layer = findNodeById(this._owner.doc.layers, this._layerId);
    if (layer) {
      layer.restoreFromSnapshot(this._pre);
      this._owner.board?.invalidateAll();
    }
  }
}

export class PixelEdit {
  // 纯 in-process。board 可选（测试时省略，commit/abort 不依赖渲染）。
  constructor({ doc, history, board }) {
    this.doc = doc;
    this.history = history;
    this.board = board || null;
    // 自己注册纯像素 entry 的 undo/redo handler（input.js 不再注册 stroke/liquify）。
    // filterBrush 复用 "stroke"；都是 before/after 像素 snap，handler 一致。
    for (const type of ["stroke", "liquify"]) {
      history.registerHandler(type, {
        undo: (e) => applyPixelSnap(this.doc, e.layerId, e.before, e.beforeBlob, this.board),
        redo: (e) => applyPixelSnap(this.doc, e.layerId, e.after,  e.afterBlob,  this.board),
        refsLayer: (e, id) => e.layerId === id,
      });
    }
  }

  // 起一笔：立刻拍 before-snapshot。caller 随后让 engine 改 layer，结束时 commit / abort。
  begin(layer, type) {
    return new PixelEditTx(this, layer, type);
  }
}
