// 导出格式平台（架构深化 candidate 2，见 docs/reports/20260608-ui-deepening-and-plugin-survey.html）。
//
// 把「能导出成什么格式」从 app.js 的硬 switch 收成注册表插件——和 filters.js 同一道接缝
// （共享 registry.js）。加一个格式 = registerExporter(...) 一处，导出菜单 data-driven 自动出现。
// 下载插件（future）：window.WebPaint.registerExporter(spec)，同 registerFilter。
//
// ============= Exporter 契约 =============
// 一个 Exporter = 一个普通对象：
//   id      : 唯一 string（sticky config / 菜单用）
//   label   : 中文显示名（radio 文案）
//   ext     : 文件扩展名（不含点）
//   mime?   : image 类用；project 类可省
//   kind    : "project"（整工程：.ora/.psd，多图层）| "image"（合成图：png/jpg）
//   encode(doc, opts) → Promise<Blob>
//             project: opts 忽略。image: opts.scope = "merged" | "active"。
//   busyHint?: encode 期间的状态行文案（如 PSD 编码慢）
//
// 去向（文件下载 / 分享 / 剪贴板）是**正交的 sink**，不进 exporter——见 session.js
// shareOrDownloadBlob / triggerDownload。exporter 只管「doc → 该格式的字节」。

import { makeRegistry } from "./registry.ts";
import { encodeDocToOra } from "./ora.ts";
import { renderDocToImageBlob } from "./session.ts";
import { store as _store } from "./app-store.js";
import { session } from "./session-state.ts";

const _reg = makeRegistry({ name: "exporter" });

export function registerExporter(spec) {
  if (!spec || !spec.id) throw new Error("Exporter 必须有 id");
  if (typeof spec.encode !== "function") throw new Error(`Exporter ${spec.id} 缺 encode()`);
  if (spec.kind !== "project" && spec.kind !== "image") {
    throw new Error(`Exporter ${spec.id} 的 kind 必须是 "project" | "image"`);
  }
  _reg.register(spec);
}
export function getExporter(id) { return _reg.get(id); }
export function listExporters() { return _reg.list(); }
export function listExportersByKind(kind) { return _reg.list().filter((e) => e.kind === kind); }
export function onExporterRegistered(fn) { return _reg.onRegistered(fn); }

// ============= 第一方内建导出器 =============
registerExporter({
  id: "ora", label: ".ora（推荐 / 开源）", ext: "ora", kind: "project",
  // 加密作品导出 = 密文容器（store.seal 按当前文件加密态包壳；明文作品原样）——
  // 防「导出」变成无声的明文泄漏口。要明文导出：先在图库解除加密。
  // 下载扩展名由 export-import-menu 按字节判（容器 → .zip）。
  encode: async (doc) => {
    const plain = await encodeDocToOra(doc);
    if (!session.name) return plain;
    const sealed = await _store.seal(session.name, new Uint8Array(await plain.arrayBuffer()));
    return new Blob([sealed], { type: "application/zip" });
  },
});
registerExporter({
  id: "psd", label: ".psd（Photoshop）", ext: "psd", kind: "project", busyHint: "PSD 编码中…",
  encode: async (doc) => {
    const { encodeDocToPsd } = await import("./psd.js");   // 懒加载：psd 编码器只在用时拉
    return encodeDocToPsd(doc);
  },
});
registerExporter({
  id: "png", label: "PNG", ext: "png", mime: "image/png", kind: "image",
  encode: (doc, { scope = "merged" } = {}) => renderDocToImageBlob(doc, "image/png", undefined, scope),
});
registerExporter({
  id: "jpg", label: "JPG", ext: "jpg", mime: "image/jpeg", kind: "image",
  encode: (doc, { scope = "merged" } = {}) => renderDocToImageBlob(doc, "image/jpeg", 0.92, scope),
});
