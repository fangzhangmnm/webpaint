// EditorState struct：默认 / setter→setDirtyFlag(workspaceDirty) / Serialize 往返 / Unserialize 容错 / reset。
import { test, eq, assert } from "./runner.mjs";
import { editorState } from "../src/editor-state.ts";

const J = (v) => JSON.stringify(v);

test("[editor-state] 默认值 = freshGroups SSoT", () => {
  editorState.reset();
  eq(editorState.import.source, "file", "import.source 默认 file");
  eq(editorState.export.format, "png", "export.format 默认 png");
  eq(editorState.export.layerMode, "merged", "export.layerMode 默认 merged");
  eq(editorState.exportProject.format, "ora", "exportProject.format 默认 ora");
  eq(editorState.colorPanel.enabled, false, "colorPanel.enabled 默认 false");
  eq(editorState.colorPanel.position, null, "colorPanel.position 默认 null");
  eq(J(editorState.refPanel.viewport), J({ tx: 0, ty: 0, scale: 1, rot: 0 }), "refPanel.viewport 默认");
  eq(editorState.blenderPanel.show, false, "blenderPanel.show 默认 false");
  eq(editorState.brushTool.size, 12, "brushTool.size 默认 12");
  eq(editorState.brushTool.color, "#1b1b1b", "brushTool.color 默认");
  eq(editorState.colorPicker.layerMode, "composite", "colorPicker.layerMode 默认 composite");
  eq(editorState.viewport, null, "viewport 默认 null");
  eq(editorState.checkboard, false, "checkboard 默认 false");
});

test("[editor-state] setter → setDirtyFlag（workspaceDirty）+ clear", () => {
  editorState.reset();
  eq(editorState.isWorkspaceDirty(), false, "reset 后 workspaceDirty=false");
  editorState.colorPanel.position = { left: 10, top: 20 };
  eq(editorState.isWorkspaceDirty(), true, "改 colorPanel.position → workspaceDirty=true");
  eq(J(editorState.colorPanel.position), J({ left: 10, top: 20 }), "position 往返");
  editorState.clearWorkspaceDirty();
  eq(editorState.isWorkspaceDirty(), false, "clear 后 false");
  editorState.checkboard = true;
  eq(editorState.isWorkspaceDirty(), true, "改顶层 leaf checkboard → workspaceDirty");
  editorState.reset();
  eq(editorState.isWorkspaceDirty(), false, "reset 清 workspaceDirty");
});

test("[editor-state] Serialize 往返 + 深拷贝解耦", () => {
  editorState.reset();
  editorState.brushTool.size = 42;
  editorState.brushTool.color = "#abcdef";
  editorState.export.format = "jpg";
  editorState.refPanel.viewport = { tx: 5, ty: 6, scale: 2, rot: 90 };
  editorState.viewport = { tx: 1, ty: 2, scale: 3, rot: 0 };
  editorState.checkboard = true;
  const snap = editorState.Serialize();
  // 深拷贝解耦：改 snap 不影响 live
  const decoupleProbe = editorState.Serialize();
  decoupleProbe.brushTool.size = 999;
  eq(editorState.brushTool.size, 42, "Serialize 返深拷贝，改副本不动 live");
  // 往返（用未被篡改的 snap）
  editorState.reset();
  eq(editorState.brushTool.size, 12, "reset 回默认");
  editorState.Unserialize(snap);
  eq(editorState.brushTool.size, 42, "Unserialize 复原 size");
  eq(editorState.brushTool.color, "#abcdef", "复原 color");
  eq(editorState.export.format, "jpg", "复原 export.format");
  eq(J(editorState.refPanel.viewport), J({ tx: 5, ty: 6, scale: 2, rot: 90 }), "复原 refPanel.viewport");
  eq(J(editorState.viewport), J({ tx: 1, ty: 2, scale: 3, rot: 0 }), "复原 viewport");
  eq(editorState.checkboard, true, "复原 checkboard");
});

test("[editor-state] Unserialize 容错（缺字段留 default、多字段忽略、不 mark dirty）", () => {
  editorState.reset();
  editorState.Unserialize({ colorPanel: { enabled: true }, brushTool: { size: 7 }, bogusKey: 123 });
  eq(editorState.colorPanel.enabled, true, "present 键覆盖");
  eq(editorState.colorPanel.position, null, "缺字段留 default");
  eq(editorState.brushTool.size, 7, "brushTool.size 覆盖");
  eq(editorState.brushTool.color, "#1b1b1b", "brushTool.color 留 default");
  eq(editorState.export.format, "png", "整组缺 → 全 default");
  eq(editorState.isWorkspaceDirty(), false, "Unserialize（载入非编辑）不 mark dirty");
  // 坏输入不崩
  editorState.Unserialize(null); editorState.Unserialize("x"); editorState.Unserialize(42);
  eq(editorState.brushTool.size, 12, "坏输入 → 回 default（freshGroups）");
});
