// 职责（单一）：图层 undo handler 注册（addLayer/removeLayer/mergeDown/moveLayer/renameLayer/
//   setLayerProp/setReferenceLayer/docTransform/selectionToLayer 的 undo/redo handler）
//   + layer-property undo 标签（_LP_LABEL）+ doc 变更后刷新（_afterDocChange）。
// handler 一次性在 boot 注册（纪律 #1：集中在 boot 段）→ 包进 initLayerUndo(ctx)。
// layerSpecFrom / _afterDocChange 被其它模块（lasso / layers-panel / selection-ops）经 ctx 消费 → 必须 export。

import { els } from "./els.ts";
import { renderLayersPanel } from "./layers-panel.ts";
import { applyPixelSnap } from "./pixel-edit.ts";
import type { AppContext } from "./app-context.ts";
import type { Layer } from "./doc.ts";

let doc: AppContext["doc"], board: AppContext["board"], history: AppContext["history"], setStatus: AppContext["setStatus"];

// undo 派发记录 = 异构动态 payload（各 entry 形状不同、由 push 方决定；history.js 是未类型化 owner）。
// candidate 3 给 history.js 真类型时收紧成判别联合。
type UndoEntry = Record<string, any>;

// ---- 图层面板 ----
export function _afterDocChange() {
  renderLayersPanel();
  board.invalidateAll();
  board.requestRender();
}

// 从 Layer 拿一份 spec（含 pixel snapshot）—— add/remove handler 都用
// 「层 → spec」的形状归模型层（doc.layerSpec）；这里只是旧名兜底。
export function layerSpecFrom(L: unknown) { return doc.layerSpec(L as Layer); }

export function initLayerUndo(ctx: AppContext) {
  ({ doc, board, history, setStatus } = ctx);

  // ---- 5 个 layer handler 注册（**纪律 #1**：集中在 boot 段）----
  // addLayer：undo 删层，redo 在 index 处插入空层（spec 通常 empty）
  // v125 (user：「undo redo 创建图层时不跳过去会误导用户，要 toast + 跳」)
  //   addLayer.redo（重做创建）：setActive 到恢复的图层并 toast
  //   addLayer.undo（撤销创建）：remove 后 active 落回兜底层，toast 提示
  history.registerHandler("addLayer", {
    undo: (e: UndoEntry) => {
      doc.removeLayer(e.layerSpec.id);
      if (e.prevActiveId != null) doc.setActiveById(e.prevActiveId);   // 回到创建前的活动层（不误导）
      _afterDocChange();
      setStatus(`已撤销创建图层「${e.layerSpec.name || ""}」`);
    },
    redo: (e: UndoEntry) => {
      doc.insertLayerAt(e.index, e.layerSpec, e.parentId ?? null);
      doc.setActiveById(e.layerSpec.id);
      _afterDocChange();
      setStatus(`已恢复图层「${e.layerSpec.name || ""}」`);
    },
    refsLayer: (e: UndoEntry, id: number) => e.layerSpec.id === id,
  });
  // removeLayer：undo 在 (parentId, index) 处恢复层（含 pixel）；redo 再删
  // v125: 一律 setActive 到恢复的图层 + toast
  history.registerHandler("removeLayer", {
    undo: async (e: UndoEntry) => {
      const spec = e.layerSpec;
      const pid = e.parentId ?? null;
      if (spec.imageData || (!spec.blob && (spec.bboxW <= 0 || spec.bboxH <= 0))) {
        doc.insertLayerAt(e.index, spec, pid);
      } else if (spec.blob) {
        const bitmap = await createImageBitmap(spec.blob);
        doc.insertLayerAt(e.index, { ...spec, bitmap }, pid);
        bitmap.close?.();
      } else {
        doc.insertLayerAt(e.index, spec, pid);
      }
      doc.setActiveById(spec.id);
      _afterDocChange();
      setStatus(`已恢复图层「${spec.name || ""}」`);
    },
    redo: (e: UndoEntry) => {
      doc.removeLayer(e.layerSpec.id);
      _afterDocChange();
      setStatus(`已删除图层「${e.layerSpec.name || ""}」`);
    },
    refsLayer: (e: UndoEntry, id: number) => e.layerSpec.id === id,
  });
  // v124b mergeDown：undo 还原 under 像素 + opacity/mode（+ v258 clippingMask），再 insert active 回 activeIndex；redo 应用 underAfter + 删 active
  history.registerHandler("mergeDown", {
    undo: async (e: UndoEntry) => {
      const under = doc.findLayer(e.underId);
      if (under) {
        applyPixelSnap(doc, e.underId, e.underBefore, e.underBefore.blob, board);
        under.opacity = e.underBeforeOpacity;
        under.mode = e.underBeforeMode;
        if (typeof e.underBeforeClipping === "boolean") under.clippingMask = e.underBeforeClipping;
      }
      // 把 active 插回原**同级**位置（组内合并也精确复位）
      const spec = e.activeSpec;
      const al = e.activeLoc || { parentId: null, index: e.activeIndex ?? 0 };
      if (spec.imageData || spec.bboxW <= 0 || spec.bboxH <= 0) {
        doc.insertLayerAt(al.index, spec, al.parentId);
      } else if (spec.blob) {
        const bitmap = await createImageBitmap(spec.blob);
        doc.insertLayerAt(al.index, { ...spec, bitmap }, al.parentId);
      } else {
        doc.insertLayerAt(al.index, spec, al.parentId);
      }
      doc.setActiveById(spec.id);
      _afterDocChange();
      setStatus(`已撤销合并 · 恢复「${spec.name || ""}」`);
    },
    redo: (e: UndoEntry) => {
      const under = doc.findLayer(e.underId);
      if (under) {
        applyPixelSnap(doc, e.underId, e.underAfter, e.underAfter.blob, board);
        under.opacity = 1;
        under.mode = "source-over";
        under.clippingMask = !!e.resultClipping;   // 链内合并结果仍剪裁；基底合并结果转普通层
      }
      doc.removeLayer(e.activeSpec.id);
      doc.setActiveById(e.underId);
      _afterDocChange();
      setStatus("已向下合并");
    },
    refsLayer: (e: UndoEntry, id: number) => e.underId === id || e.activeSpec.id === id,
  });
  // moveLayer：同级 ±delta 移动。undo = 反向 delta；redo = 原 delta（树安全：moveLayer 自身按同级解析）。
  history.registerHandler("moveLayer", {
    undo: (e: UndoEntry) => {
      doc.moveLayer(e.layerId, -e.delta);
      _afterDocChange();
      const L = doc.findLayer(e.layerId);
      setStatus(`图层「${L?.name || ""}」移回原位`);
    },
    redo: (e: UndoEntry) => {
      doc.moveLayer(e.layerId, e.delta);
      _afterDocChange();
      const L = doc.findLayer(e.layerId);
      setStatus(`图层「${L?.name || ""}」已移动`);
    },
    refsLayer: (e: UndoEntry, id: number) => e.layerId === id,
  });
  // treeStructure：组结构变（编组/解组/移入移出/删组）的撤销底座 —— snapshotTree（保叶活引用、零像素拷贝）
  //   前后两张结构快照，undo/redo 直接 restoreTree。像素历史不受影响（叶对象 id 不变）。
  history.registerHandler("treeStructure", {
    undo: (e: UndoEntry) => { doc.restoreTree(e.before); _afterDocChange(); if (e.undoStatus) setStatus(e.undoStatus); },
    redo: (e: UndoEntry) => { doc.restoreTree(e.after); _afterDocChange(); if (e.redoStatus) setStatus(e.redoStatus); },
    // 结构快照里可能含任意 id（叶或组）→ 保守返 true（撤销/重做都全量重挂）。
    refsLayer: () => true,
  });
  // renameLayer：oldName / newName
  history.registerHandler("renameLayer", {
    undo: (e: UndoEntry) => {
      const L = doc.findLayer(e.layerId);
      if (L) { L.name = e.oldName; renderLayersPanel(); setStatus(`图层名还原「${e.oldName}」`); }
    },
    redo: (e: UndoEntry) => {
      const L = doc.findLayer(e.layerId);
      if (L) { L.name = e.newName; renderLayersPanel(); setStatus(`图层重命名「${e.newName}」`); }
    },
    refsLayer: (e: UndoEntry, id: number) => e.layerId === id,
  });
  // setLayerProp：visibility / opacity / mode
  const _LP_LABEL: Record<string, string> = { visible: "可见", opacity: "不透明度", mode: "混合", clippingMask: "剪裁", lockAlpha: "锁定不透明度" };
  history.registerHandler("setLayerProp", {
    undo: (e: UndoEntry) => {
      const L = doc.findLayer(e.layerId);
      if (L) { (L as unknown as Record<string, unknown>)[e.prop as string] = e.oldVal; _afterDocChange(); setStatus(`「${L.name}」${_LP_LABEL[e.prop] || e.prop} 已还原`); }
    },
    redo: (e: UndoEntry) => {
      const L = doc.findLayer(e.layerId);
      if (L) { (L as unknown as Record<string, unknown>)[e.prop as string] = e.newVal; _afterDocChange(); setStatus(`「${L.name}」${_LP_LABEL[e.prop] || e.prop} 已更新`); }
    },
    refsLayer: (e: UndoEntry, id: number) => e.layerId === id,
  });
  // setReferenceLayer：unique doc-level state
  history.registerHandler("setReferenceLayer", {
    undo: (e: UndoEntry) => { doc.referenceLayerId = e.oldVal; renderLayersPanel(); },
    redo: (e: UndoEntry) => { doc.referenceLayerId = e.newVal; renderLayersPanel(); },
    refsLayer: (e: UndoEntry, id: number) => e.oldVal === id || e.newVal === id,
  });
  // v110/114: docTransform —— crop / resample 一次 op 影响所有 layer + doc 尺寸 + viewport
  // entry shape: { before: {doc, viewport}, after: {doc, viewport} }
  history.registerHandler("docTransform", {
    undo: (e: UndoEntry) => {
      doc.restoreSnapshotAll(e.before.doc);
      if (e.before.viewport) Object.assign(board.viewport, e.before.viewport);
      _afterDocChange();
      if (els.canvasSizeLabel) els.canvasSizeLabel.textContent = `${doc.width}×${doc.height}`;
      board.invalidateAll();
      renderLayersPanel();
    },
    redo: (e: UndoEntry) => {
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
    undo: async (e: UndoEntry) => {
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
    redo: async (e: UndoEntry) => {
      const spec = e.newLayerSpec;
      const pid = e.parentId ?? null;
      if (spec.blob && !spec.imageData) {
        const bitmap = await createImageBitmap(spec.blob);
        doc.insertLayerAt(e.insertIndex, { ...spec, bitmap }, pid);
        bitmap.close?.();
      } else {
        doc.insertLayerAt(e.insertIndex, spec, pid);
      }
      if (e.isMove && e.afterActive) {
        const L = doc.findLayer(e.activeLayerId);
        if (L) await applyPixelSnap(doc, L.id, e.afterActive, e.afterActive.blob, board);
      }
      doc.setActiveById(spec.id);
      _afterDocChange();
    },
    refsLayer: (e: UndoEntry, id: number) => e.newLayerSpec.id === id || e.activeLayerId === id,
  });
}
