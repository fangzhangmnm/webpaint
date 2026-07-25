// EditorState struct：默认 / 门面只有四方法 / Serialize 往返 / Unserialize 容错 / reset。
import { test, eq, assert } from "./runner.mjs";
import { editorState } from "../src/workbench-state.ts";

const J = (v) => JSON.stringify(v);

test("[editor-state] 默认值 = freshGroups SSoT", () => {
  editorState.reset();
  eq(editorState.export.format, "png", "export.format 默认 png");
  eq(editorState.export.layerMode, "merged", "export.layerMode 默认 merged");
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

// v409 回归锁：desk **没有** dirty 标记（撤销 v407 的 workspaceDirty 设计）。
//   desk 改动不标脏、不驱动落盘 —— 只在内容脏/显式 save 顺路 encode 时被 _buildOraMeta 捞走。
//   若有人再把 dirty 加回来，这条会红。别加，除非先推翻「退出只有 contentDirty 才推」或「按 save 无条件推」。
test("[editor-state] 门面只有四方法：无 dirty 机制（v409 撤销 workspaceDirty）", () => {
  editorState.reset();
  for (const gone of ["isWorkspaceDirty", "clearWorkspaceDirty", "_setOnDirty"]) {
    eq(typeof editorState[gone], "undefined", `${gone} 应已删（desk 无 dirty 标记）`);
  }
  for (const kept of ["Serialize", "Unserialize", "reset", "syncRuntimeForSave"]) {
    eq(typeof editorState[kept], "function", `${kept} 应保留`);
  }
  // setter 仍正常写值（只是不标脏）
  editorState.colorPanel.position = { left: 10, top: 20 };
  eq(J(editorState.colorPanel.position), J({ left: 10, top: 20 }), "position 往返");
  editorState.checkboard = true;
  eq(editorState.checkboard, true, "顶层 leaf checkboard 往返");
  editorState.reset();
  eq(editorState.checkboard, false, "reset 回默认");
});

// syncRuntimeForSave：存盘时把运行时 SSoT（board 视口 / checkboard）单向镜像进 desk。
test("[editor-state] syncRuntimeForSave 存时捞运行时 SSoT", () => {
  editorState.reset();
  editorState.syncRuntimeForSave({ tx: 9, ty: 8, scale: 1.5, rot: 45 }, true);
  eq(J(editorState.viewport), J({ tx: 9, ty: 8, scale: 1.5, rot: 45 }), "viewport 被捞进");
  eq(editorState.checkboard, true, "checkboard 被捞进");
  eq(J(editorState.Serialize().viewport), J({ tx: 9, ty: 8, scale: 1.5, rot: 45 }), "捞进的值进 Serialize 输出");
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

test("[editor-state] Unserialize 容错（缺字段留 default、多字段忽略）", () => {
  editorState.reset();
  editorState.Unserialize({ colorPanel: { enabled: true }, brushTool: { size: 7 }, bogusKey: 123 });
  eq(editorState.colorPanel.enabled, true, "present 键覆盖");
  eq(editorState.colorPanel.position, null, "缺字段留 default");
  eq(editorState.brushTool.size, 7, "brushTool.size 覆盖");
  eq(editorState.brushTool.color, "#1b1b1b", "brushTool.color 留 default");
  eq(editorState.export.format, "png", "整组缺 → 全 default");
  // 坏输入不崩
  editorState.Unserialize(null); editorState.Unserialize("x"); editorState.Unserialize(42);
  eq(editorState.brushTool.size, 12, "坏输入 → 回 default（freshGroups）");
});

test("[editor-state] v0.5.11 迁移：stale bucket 键忽略、magicWand.threshold 默认+覆盖", () => {
  editorState.reset();
  eq(editorState.magicWand.threshold, 20, "threshold 默认 20（原 bucket 配置退役归魔棒）");
  // 旧 doc 的 editor-state.json 带已退役的 bucket 组 → mergeInto 按 dst 键迭代，静默忽略不崩
  editorState.Unserialize({ bucket: { threshold: 55, expand: true, expandPx: 3 }, magicWand: { threshold: 40, expand: true } });
  eq(editorState.magicWand.threshold, 40, "magicWand.threshold 覆盖");
  eq(editorState.magicWand.expand, true, "magicWand.expand 覆盖");
  eq(editorState.magicWand.expandPx, 1, "缺字段留 default");
  eq("bucket" in editorState, false, "bucket facade 已删");
});

test("[editor-state] 形状笔（ADR-0005）：默认 / 往返 / 老 doc 缺组补默认", () => {
  editorState.reset();
  eq(editorState.shapeBrush.sub, "line", "sub 默认 line");
  eq(editorState.shapeBrush.constrain, false, "constrain 默认 false");
  editorState.shapeBrush.sub = "circle";
  editorState.shapeBrush.constrain = true;
  const ser = editorState.Serialize();
  editorState.reset();
  editorState.Unserialize(ser);
  eq(editorState.shapeBrush.sub, "circle", "Serialize 往返 sub");
  eq(editorState.shapeBrush.constrain, true, "Serialize 往返 constrain");
  // 老 doc 的 editor-state.json 没有 shapeBrush 组 → 留默认不崩
  editorState.reset();
  editorState.Unserialize({ magicWand: { threshold: 30 } });
  eq(editorState.shapeBrush.sub, "line", "缺组 → 默认");
});
