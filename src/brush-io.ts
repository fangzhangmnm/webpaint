// 职责：把笔刷预设序列化/分享成文件（单笔导出 / 文件夹导出 / 笔架→默认代码 / 通用 share-or-download）。
// 无 app 状态、无 DOM 副作用之外的耦合：入参拿 rack/brush，出参给文件 + 返回计数/字符串，状态提示留 app。

import { brushToJSON, brushesByTool, DEFAULT_FOLDER } from "./brushes.ts";
import type { Brush, BrushRackData } from "./brush-types.ts";

// navigator.canShare/share 的 files 形参在部分 lib.dom 里未覆盖 → 窄化扩展（不引入 any）。
type FileShareNavigator = Navigator & {
  canShare?: (data?: { files?: File[] }) => boolean;
  share?: (data?: { files?: File[]; title?: string }) => Promise<void>;
};

// navigator.share 优先（iPad 原生分享），否则 <a download> 兜底。
export async function shareOrDownloadJSON(blob: Blob, filename: string, title?: string): Promise<void> {
  const nav = navigator as FileShareNavigator;
  if (nav.canShare && nav.share) {
    const file = new File([blob], filename, { type: blob.type || "application/json" });
    if (nav.canShare({ files: [file] })) {
      try { await nav.share({ files: [file], title }); return; }
      catch { /* 用户取消 / 不支持 → 兜底下载 */ }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

// 单笔导出。
export async function exportBrush(brush: Brush): Promise<void> {
  const blob = new Blob([brushToJSON(brush)], { type: "application/json" });
  await shareOrDownloadJSON(blob, `${brush.name || "brush"}-${brush.tool}.json`, brush.name);
}

// 当前文件夹下所有笔导出成一个 pack。返回导出笔数（0 = 空文件夹，app 决定提示）。
export async function exportRackFolder(rack: BrushRackData, tool: string, folder: string): Promise<number> {
  const brushes = (brushesByTool(rack, tool) as Brush[]).filter((b) => (b.folder || DEFAULT_FOLDER) === folder);
  if (brushes.length === 0) return 0;
  const pack = { version: 1, folder, tool, brushes };
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
  await shareOrDownloadJSON(blob, `${folder || "folder"}-${tool}.json`, folder);
  return brushes.length;
}

// dev：把当前笔架拼成 src/brushes.js 的 DEFAULTS_SPEC 源码（纯函数，返回代码字符串）。
export function buildRackCode(rack: BrushRackData): string {
  const lines: string[] = [];
  lines.push("// Auto-dumped from brush rack. 替换 src/brushes.js DEFAULTS_SPEC array 内容。");
  lines.push("export const DEFAULTS_SPEC = [");
  for (const b of rack.brushes) {
    const args: Record<string, unknown> = {};
    args.size = b.size?.base ?? 12;
    args.sizeBaseMax = b.size?.max ?? 200;
    args.hardness = b.shape?.hardness ?? 1.0;
    if (b.shape?.kind && b.shape.kind !== "round") args.shapeKind = b.shape.kind;
    if (b.shape?.aspect != null && b.shape.aspect !== 1) args.aspect = b.shape.aspect;
    if (b.shape?.rotation) args.rotation = b.shape.rotation;
    args.sizeCoeff = b.sizeCoeff ?? 0.6;
    args.opaCoeff = b.opaCoeff ?? 0.6;
    args.flowCoeff = b.flowCoeff ?? 0;
    if (b.pressureGamma != null && b.pressureGamma !== 1.0) args.pressureGamma = b.pressureGamma;
    if (b.defaultOpa != null && b.defaultOpa !== 1.0) args.defaultOpa = b.defaultOpa;
    args.compositeMode = b.compositeMode || "wash";
    if (b.blendMode && b.blendMode !== "source-over") args.blendMode = b.blendMode;
    args.spacingValue = (typeof b.spacing === "number") ? b.spacing : (b.spacing?.value ?? 0.06);
    if (b.pixelMode) args.pixelMode = true;
    if (b.taper?.in) args.taperIn = b.taper.in;
    if (b.taper?.out) args.taperOut = b.taper.out;
    const sm = b.smooth || {};
    if (sm.streamline != null && sm.streamline !== 0.15) args.streamline = sm.streamline;
    if (sm.stabilization != null && sm.stabilization !== 0) args.stabilization = sm.stabilization;
    const argsStr = JSON.stringify(args).replace(/"([a-zA-Z_]\w*)":/g, "$1:");
    lines.push(`  { id: ${JSON.stringify(b.id)}, name: ${JSON.stringify(b.name)}, tool: ${JSON.stringify(b.tool)},`);
    lines.push(`    args: ${argsStr} },`);
  }
  lines.push("];");
  return lines.join("\n");
}
