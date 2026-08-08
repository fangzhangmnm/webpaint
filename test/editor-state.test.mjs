// EditorState struct：默认 / 门面只有四方法 / Serialize 往返 / Unserialize 容错 / reset。
import { test, eq, assert } from "./runner.mjs";
import { desk } from "../src/workbench-state.ts";

const J = (v) => JSON.stringify(v);

test("[editor-state] 默认值 = freshGroups SSoT", () => {
  desk.reset();
  eq(desk.export.format, "png", "export.format 默认 png");
  eq(desk.export.layerMode, "merged", "export.layerMode 默认 merged");
  eq(desk.colorPanel.enabled, false, "colorPanel.enabled 默认 false");
  eq(desk.colorPanel.position, null, "colorPanel.position 默认 null");
  eq(J(desk.refPanel.viewport), J({ tx: 0, ty: 0, scale: 1, rot: 0 }), "refPanel.viewport 默认");
  eq(desk.blenderPanel.show, false, "blenderPanel.show 默认 false");
  eq(desk.brushTool.size, 12, "brushTool.size 默认 12");
  eq(desk.brushTool.color, "#1b1b1b", "brushTool.color 默认");
  eq(desk.colorPicker.layerMode, "composite", "colorPicker.layerMode 默认 composite");
  eq(desk.viewport, null, "viewport 默认 null");
  eq(desk.checkboard, false, "checkboard 默认 false");
});

// v409 回归锁：desk **没有** dirty 标记（撤销 v407 的 workspaceDirty 设计）。
//   desk 改动不标脏、不驱动落盘 —— 只在内容脏/显式 save 顺路 encode 时被 _buildOraMeta 捞走。
//   若有人再把 dirty 加回来，这条会红。别加，除非先推翻「退出只有 contentDirty 才推」或「按 save 无条件推」。
test("[editor-state] 门面只有四方法：无 dirty 机制（v409 撤销 workspaceDirty）", () => {
  desk.reset();
  for (const gone of ["isWorkspaceDirty", "clearWorkspaceDirty", "_setOnDirty"]) {
    eq(typeof desk[gone], "undefined", `${gone} 应已删（desk 无 dirty 标记）`);
  }
  for (const kept of ["Serialize", "Unserialize", "reset", "syncRuntimeForSave"]) {
    eq(typeof desk[kept], "function", `${kept} 应保留`);
  }
  // setter 仍正常写值（只是不标脏）
  desk.colorPanel.position = { left: 10, top: 20 };
  eq(J(desk.colorPanel.position), J({ left: 10, top: 20 }), "position 往返");
  desk.checkboard = true;
  eq(desk.checkboard, true, "顶层 leaf checkboard 往返");
  desk.reset();
  eq(desk.checkboard, false, "reset 回默认");
});

// syncRuntimeForSave：存盘时把运行时 SSoT（board 视口 / checkboard）单向镜像进 desk。
test("[editor-state] syncRuntimeForSave 存时捞运行时 SSoT", () => {
  desk.reset();
  desk.syncRuntimeForSave({ tx: 9, ty: 8, scale: 1.5, rot: 45 }, true);
  eq(J(desk.viewport), J({ tx: 9, ty: 8, scale: 1.5, rot: 45 }), "viewport 被捞进");
  eq(desk.checkboard, true, "checkboard 被捞进");
  eq(J(desk.Serialize().viewport), J({ tx: 9, ty: 8, scale: 1.5, rot: 45 }), "捞进的值进 Serialize 输出");
});

test("[editor-state] Serialize 往返 + 深拷贝解耦", () => {
  desk.reset();
  desk.brushTool.size = 42;
  desk.brushTool.color = "#abcdef";
  desk.export.format = "jpg";
  desk.refPanel.viewport = { tx: 5, ty: 6, scale: 2, rot: 90 };
  desk.viewport = { tx: 1, ty: 2, scale: 3, rot: 0 };
  desk.checkboard = true;
  desk.pressureDisabled = true;   // v0.6.15 禁用笔压 = per-doc desk（跟 ora 走）
  const snap = desk.Serialize();
  // 深拷贝解耦：改 snap 不影响 live
  const decoupleProbe = desk.Serialize();
  decoupleProbe.brushTool.size = 999;
  eq(desk.brushTool.size, 42, "Serialize 返深拷贝，改副本不动 live");
  // 往返（用未被篡改的 snap）
  desk.reset();
  eq(desk.brushTool.size, 12, "reset 回默认");
  eq(desk.pressureDisabled, false, "reset 回默认：笔压恢复启用");
  desk.Unserialize(snap);
  eq(desk.brushTool.size, 42, "Unserialize 复原 size");
  eq(desk.brushTool.color, "#abcdef", "复原 color");
  eq(desk.export.format, "jpg", "复原 export.format");
  eq(J(desk.refPanel.viewport), J({ tx: 5, ty: 6, scale: 2, rot: 90 }), "复原 refPanel.viewport");
  eq(J(desk.viewport), J({ tx: 1, ty: 2, scale: 3, rot: 0 }), "复原 viewport");
  eq(desk.checkboard, true, "复原 checkboard");
  eq(desk.pressureDisabled, true, "复原 pressureDisabled（禁用笔压跟 ora 走）");
});

test("[editor-state] Unserialize 容错（缺字段留 default、多字段忽略）", () => {
  desk.reset();
  desk.Unserialize({ colorPanel: { enabled: true }, brushTool: { size: 7 }, bogusKey: 123 });
  eq(desk.colorPanel.enabled, true, "present 键覆盖");
  eq(desk.colorPanel.position, null, "缺字段留 default");
  eq(desk.brushTool.size, 7, "brushTool.size 覆盖");
  eq(desk.brushTool.color, "#1b1b1b", "brushTool.color 留 default");
  eq(desk.export.format, "png", "整组缺 → 全 default");
  // 坏输入不崩
  desk.Unserialize(null); desk.Unserialize("x"); desk.Unserialize(42);
  eq(desk.brushTool.size, 12, "坏输入 → 回 default（freshGroups）");
});

test("[editor-state] v0.5.11 迁移：stale bucket 键忽略、magicWand.threshold 默认+覆盖", () => {
  desk.reset();
  eq(desk.magicWand.threshold, 20, "threshold 默认 20（原 bucket 配置退役归魔棒）");
  // 旧 doc 的 editor-state.json 带已退役的 bucket 组 → mergeInto 按 dst 键迭代，静默忽略不崩
  desk.Unserialize({ bucket: { threshold: 55, expand: true, expandPx: 3 }, magicWand: { threshold: 40, expand: true } });
  eq(desk.magicWand.threshold, 40, "magicWand.threshold 覆盖");
  eq(desk.magicWand.expand, true, "magicWand.expand 覆盖");
  eq(desk.magicWand.expandPx, 1, "缺字段留 default");
  eq("bucket" in desk, false, "bucket facade 已删");
});

test("[editor-state] 形状笔（ADR-0005）：默认 / 往返 / 老 doc 缺组补默认", () => {
  desk.reset();
  eq(desk.shapeBrush.sub, "line", "sub 默认 line");
  eq(desk.shapeBrush.constrainLine, false, "per-图形约束默认全不锁");
  eq(desk.shapeBrush.constrainRect, false);
  eq(desk.shapeBrush.constrainCircle, false);
  desk.shapeBrush.sub = "circle";
  desk.shapeBrush.constrainCircle = true;
  const ser = desk.Serialize();
  desk.reset();
  desk.Unserialize(ser);
  eq(desk.shapeBrush.sub, "circle", "Serialize 往返 sub");
  eq(desk.shapeBrush.constrainCircle, true, "Serialize 往返 per-图形约束");
  eq(desk.shapeBrush.constrainRect, false, "别的图形不受影响");
  // 老 doc 的 editor-state.json 没有 shapeBrush 组 → 留默认不崩
  desk.reset();
  desk.Unserialize({ magicWand: { threshold: 30 } });
  eq(desk.shapeBrush.sub, "line", "缺组 → 默认");
});

test("[editor-state] 透视 frame（ADR-0006）：默认 / 往返 / 老 doc 缺组补默认", () => {
  desk.reset();
  eq(desk.persp.p1.vp1, null, "p1 槽位默认 null");
  eq(desk.persp.lockHorizon, true, "锁地平线默认开");
  eq(desk.persp.mode, "off", "透视模式默认关（UI v2：关在 mode 不在 plane）");
  eq(desk.persp.plane, "ground", "平面默认地板");
  eq(desk.shapeBrush.gridNu, 2, "grid 默认 2×6（头身比）");
  eq(desk.shapeBrush.gridNv, 6);
  eq(desk.shapeBrush.gridBorder, false, "外框默认关");
  desk.persp.p3.vp1 = { x: 100.5, y: 50.5 };
  desk.persp.p3.box = { A: { x: 10.5, y: 20.5 }, t: [0.3, 0.25, 0.2] };
  desk.persp.p3.vp3 = { x: 30.5, y: 900.5 };
  desk.persp.mode = "p3";
  desk.persp.plane = "wallL";
  desk.shapeBrush.gridNv = 8;
  const ser = desk.Serialize();
  desk.reset();
  desk.Unserialize(ser);
  eq(JSON.stringify(desk.persp.p3.vp1), JSON.stringify({ x: 100.5, y: 50.5 }), "p3.vp1 往返");
  eq(JSON.stringify(desk.persp.p3.vp3), JSON.stringify({ x: 30.5, y: 900.5 }), "p3.vp3 往返");
  eq(desk.persp.mode, "p3", "mode 往返");
  eq(JSON.stringify(desk.persp.p3.box), JSON.stringify({ A: { x: 10.5, y: 20.5 }, t: [0.3, 0.25, 0.2] }), "参考 box 随槽位往返（user：和消失点一起持久化）");
  eq(desk.persp.plane, "wallL", "plane 往返");
  eq(desk.shapeBrush.gridNv, 8, "gridNv 往返");
  desk.reset();
  desk.Unserialize({ magicWand: { threshold: 30 } });   // 老 doc 无 persp 组
  eq(desk.persp.p1.vp1, null, "缺组 → 默认");
  eq(desk.persp.mode, "off");
});

test("[editor-state] v0.7.40 蚂蚁线 per-tool：双默认开、stale fill 组忽略、老偏好回默认", () => {
  desk.reset();
  eq(desk.lassoTool.showAnts, true, "selection 侧默认开（user journal 2026-07-30:177）");
  eq(desk.fillTool.showAnts, true, "fill 侧默认开（撤回 v0.7.17 默认关）");
  // 旧 doc 存过 fill:{showAnts:false}（v0.6.19-v0.7.39 时代）→ 组已退役，mergeInto 静默忽略
  desk.Unserialize({ fill: { showAnts: false }, fillTool: { sub: "magic" } });
  eq(desk.fillTool.showAnts, true, "老 fill.showAnts 偏好丢弃 → 回默认开（user 知情 2026-08-01）");
  eq("fill" in desk, false, "fill facade 已删");
  // 新字段往返
  desk.lassoTool.showAnts = false;
  const s = desk.Serialize();
  desk.reset();
  desk.Unserialize(s);
  eq(desk.lassoTool.showAnts, false, "lassoTool.showAnts 往返");
  eq(desk.fillTool.showAnts, true, "fillTool.showAnts 不受影响");
  desk.reset();
});
