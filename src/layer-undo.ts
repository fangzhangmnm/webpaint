// 职责（单一）：图层 undo handler 注册（addLayer/removeLayer/mergeDown/moveLayer/renameLayer/
//   setLayerProp/setReferenceLayer/docTransform/selectionToLayer 的 undo/redo handler）
//   + layer-property undo 标签（_LP_LABEL）+ doc 变更后刷新（_afterDocChange）。
// handler 一次性在 boot 注册（纪律 #1：集中在 boot 段）→ 包进 initLayerUndo(ctx)。
// layerSpecFrom / _afterDocChange 被其它模块（lasso / layers-panel / selection-ops）经 ctx 消费 → 必须 export。

import { els } from "./els.ts";
import { renderLayersPanel } from "./layers-panel.ts";
import { applyPixelSnap } from "./pixel-edit.js";

let doc: any, board: any, history: any, setStatus: any;

// ---- 图层面板 ----
export function _afterDocChange() {
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
}

// 从 Layer 拿一份 spec（含 pixel snapshot）—— add/remove handler 都用
// 「层 → spec」的形状归模型层（doc.layerSpec）；这里只是旧名兜底。
export function layerSpecFrom(L) { return doc.layerSpec(L); }

export function initLayerUndo(ctx) {
  ({ doc, board, history, setStatus } = ctx);

  // ---- 5 个 layer handler 注册（**纪律 #1**：集中在 boot 段）----
  // addLayer：undo 删层，redo 在 index 处插入空层（spec 通常 empty）
  // v125 (user：「undo redo 创建图层时不跳过去会误导用户，要 toast + 跳」)
  //   addLayer.redo（重做创建）：setActive 到恢复的图层并 toast
  //   addLayer.undo（撤销创建）：remove 后 active 落回兜底层，toast 提示
  history.registerHandler("addLayer", {
    undo: (e) => {
      doc.removeLayer(e.layerSpec.id);
      if (e.prevActiveId != null) doc.setActiveById(e.prevActiveId);   // 回到创建前的活动层（不误导）
      _afterDocChange();
      setStatus(`已撤销创建图层「${e.layerSpec.name || ""}」`);
    },
    redo: (e) => {
      doc.insertLayerAt(e.index, e.layerSpec);
      doc.setActiveById(e.layerSpec.id);
      _afterDocChange();
      setStatus(`已恢复图层「${e.layerSpec.name || ""}」`);
    },
    refsLayer: (e, id) => e.layerSpec.id === id,
  });
  // removeLayer：undo 在 index 处恢复层（含 pixel）；redo 再删
  // v125: 一律 setActive 到恢复的图层 + toast
  history.registerHandler("removeLayer", {
    undo: async (e) => {
      const spec = e.layerSpec;
      if (spec.imageData || (!spec.blob && (spec.bboxW <= 0 || spec.bboxH <= 0))) {
        doc.insertLayerAt(e.index, spec);
      } else if (spec.blob) {
        const bitmap = await createImageBitmap(spec.blob);
        doc.insertLayerAt(e.index, { ...spec, bitmap });
        bitmap.close?.();
      } else {
        doc.insertLayerAt(e.index, spec);
      }
      doc.setActiveById(spec.id);
      _afterDocChange();
      setStatus(`已恢复图层「${spec.name || ""}」`);
    },
    redo: (e) => {
      doc.removeLayer(e.layerSpec.id);
      _afterDocChange();
      setStatus(`已删除图层「${e.layerSpec.name || ""}」`);
    },
    refsLayer: (e, id) => e.layerSpec.id === id,
  });
  // v124b mergeDown：undo 还原 under 像素 + opacity/mode，再 insert active 回 activeIndex；redo 应用 underAfter + 删 active
  history.registerHandler("mergeDown", {
    undo: async (e) => {
      const under = doc.findLayer(e.underId);
      if (under) {
        applyPixelSnap(doc, e.underId, e.underBefore, e.underBefore.blob, board);
        under.opacity = e.underBeforeOpacity;
        under.mode = e.underBeforeMode;
      }
      // 把 active 插回原 index
      const spec = e.activeSpec;
      if (spec.imageData || spec.bboxW <= 0 || spec.bboxH <= 0) {
        doc.insertLayerAt(e.activeIndex, spec);
      } else if (spec.blob) {
        const bitmap = await createImageBitmap(spec.blob);
        doc.insertLayerAt(e.activeIndex, { ...spec, bitmap });
      } else {
        doc.insertLayerAt(e.activeIndex, spec);
      }
      doc.setActiveById(spec.id);
      _afterDocChange();
      setStatus(`已撤销合并 · 恢复「${spec.name || ""}」`);
    },
    redo: (e) => {
      const under = doc.findLayer(e.underId);
      if (under) {
        applyPixelSnap(doc, e.underId, e.underAfter, e.underAfter.blob, board);
        under.opacity = 1;
        under.mode = "source-over";
      }
      doc.removeLayer(e.activeSpec.id);
      doc.setActiveById(e.underId);
      _afterDocChange();
      setStatus("已向下合并");
    },
    refsLayer: (e, id) => e.underId === id || e.activeSpec.id === id,
  });
  // moveLayer：undo 从 toIdx 移回 fromIdx；redo 从 fromIdx 移到 toIdx
  history.registerHandler("moveLayer", {
    undo: (e) => {
      const cur = doc.layers.findIndex((l) => l.id === e.layerId);
      if (cur < 0) return;
      doc.moveLayer(e.layerId, e.fromIdx - cur);
      _afterDocChange();
      const L = doc.findLayer(e.layerId);
      setStatus(`图层「${L?.name || ""}」移回原位`);
    },
    redo: (e) => {
      const cur = doc.layers.findIndex((l) => l.id === e.layerId);
      if (cur < 0) return;
      doc.moveLayer(e.layerId, e.toIdx - cur);
      _afterDocChange();
      const L = doc.findLayer(e.layerId);
      setStatus(`图层「${L?.name || ""}」已移动`);
    },
    refsLayer: (e, id) => e.layerId === id,
  });
  // renameLayer：oldName / newName
  history.registerHandler("renameLayer", {
    undo: (e) => {
      const L = doc.findLayer(e.layerId);
      if (L) { L.name = e.oldName; renderLayersPanel(); setStatus(`图层名还原「${e.oldName}」`); }
    },
    redo: (e) => {
      const L = doc.findLayer(e.layerId);
      if (L) { L.name = e.newName; renderLayersPanel(); setStatus(`图层重命名「${e.newName}」`); }
    },
    refsLayer: (e, id) => e.layerId === id,
  });
  // setLayerProp：visibility / opacity / mode
  const _LP_LABEL = { visible: "可见", opacity: "不透明度", mode: "混合", clippingMask: "剪裁", lockAlpha: "锁定不透明度" };
  history.registerHandler("setLayerProp", {
    undo: (e) => {
      const L = doc.findLayer(e.layerId);
      if (L) { L[e.prop] = e.oldVal; _afterDocChange(); setStatus(`「${L.name}」${_LP_LABEL[e.prop] || e.prop} 已还原`); }
    },
    redo: (e) => {
      const L = doc.findLayer(e.layerId);
      if (L) { L[e.prop] = e.newVal; _afterDocChange(); setStatus(`「${L.name}」${_LP_LABEL[e.prop] || e.prop} 已更新`); }
    },
    refsLayer: (e, id) => e.layerId === id,
  });
  // setReferenceLayer：unique doc-level state
  history.registerHandler("setReferenceLayer", {
    undo: (e) => { doc.referenceLayerId = e.oldVal; renderLayersPanel(); },
    redo: (e) => { doc.referenceLayerId = e.newVal; renderLayersPanel(); },
    refsLayer: (e, id) => e.oldVal === id || e.newVal === id,
  });
  // v110/114: docTransform —— crop / resample 一次 op 影响所有 layer + doc 尺寸 + viewport
  // entry shape: { before: {doc, viewport}, after: {doc, viewport} }
  history.registerHandler("docTransform", {
    undo: (e) => {
      doc.restoreSnapshotAll(e.before.doc);
      if (e.before.viewport) Object.assign(board.viewport, e.before.viewport);
      _afterDocChange();
      if (els.canvasSizeLabel) els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
      board.invalidateAll();
      renderLayersPanel();
    },
    redo: (e) => {
      doc.restoreSnapshotAll(e.after.doc);
      if (e.after.viewport) Object.assign(board.viewport, e.after.viewport);
      _afterDocChange();
      if (els.canvasSizeLabel) els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
      board.invalidateAll();
      renderLayersPanel();
    },
    refsLayer: () => true,        // 所有层都受影响
  });

  // selectionToLayer：复合 entry。undo / redo 同步处理 newLayer + active 改变
  history.registerHandler("selectionToLayer", {
    undo: async (e) => {
      // 1. 删 new layer
      doc.removeLayer(e.newLayerSpec.id);
      // 2. 还原 active layer（仅 move 模式）
      if (e.isMove && e.beforeActive) {
        const L = doc.findLayer(e.activeLayerId);
        if (L) await applyPixelSnap(doc, L.id, e.beforeActive, e.beforeActive.blob, board);
      }
      // 3. active 切回原来
      doc.setActiveById(e.activeLayerId);
      _afterDocChange();
    },
    redo: async (e) => {
      const spec = e.newLayerSpec;
      if (spec.blob && !spec.imageData) {
        const bitmap = await createImageBitmap(spec.blob);
        doc.insertLayerAt(e.insertIndex, { ...spec, bitmap });
        bitmap.close?.();
      } else {
        doc.insertLayerAt(e.insertIndex, spec);
      }
      if (e.isMove && e.afterActive) {
        const L = doc.findLayer(e.activeLayerId);
        if (L) await applyPixelSnap(doc, L.id, e.afterActive, e.afterActive.blob, board);
      }
      doc.setActiveById(spec.id);
      _afterDocChange();
    },
    refsLayer: (e, id) => e.newLayerSpec.id === id || e.activeLayerId === id,
  });
}
