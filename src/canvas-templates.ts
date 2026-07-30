// 画布模板 SSoT（v0.6.48 裁剪·模板模式，设计定稿 docs/20260729-crop-template-mode.md）。
// 消费者：裁剪模板模式；将来：新建文档尺寸选择器 / 导出对话框——加模板只改这里。
//
// DPI 本体论（user 拍板）：像素是画作唯一真相，DPI 只是输出解释——DPI 活在**模板**与导出
// 文件的 pHYs 里，永不写进 ora（防不懂的用户改乱 xres/yres 调不回）。

export interface CanvasTemplate {
  id: string;
  label: string;                       // 中文 UI 直读（模板名不走 i18n——尺寸是国际语）
  kind: "print" | "screen" | "pixel";
  w: number; h: number;                // unit 下的数值
  unit: "px" | "mm" | "in";
  dpi?: number;                        // print 类必填；导出 pHYs 用
}

export const CANVAS_TEMPLATES: CanvasTemplate[] = [
  // print（物理×DPI→px；打印精确性的来源=比例与像素由模板锁死）。照片横竖各一（user 2026-07-29）。
  { id: "print-4x6-300",   label: "4×6 in 竖 · 300dpi", kind: "print", w: 4, h: 6, unit: "in", dpi: 300 },
  { id: "print-6x4-300",   label: "6×4 in 横 · 300dpi", kind: "print", w: 6, h: 4, unit: "in", dpi: 300 },
  { id: "print-5x7-300",   label: "5×7 in 竖 · 300dpi", kind: "print", w: 5, h: 7, unit: "in", dpi: 300 },
  { id: "print-7x5-300",   label: "7×5 in 横 · 300dpi", kind: "print", w: 7, h: 5, unit: "in", dpi: 300 },
  { id: "print-a5-300",    label: "A5 竖 · 300dpi",     kind: "print", w: 148, h: 210, unit: "mm", dpi: 300 },
  { id: "print-a5l-300",   label: "A5 横 · 300dpi",     kind: "print", w: 210, h: 148, unit: "mm", dpi: 300 },
  { id: "print-a4-300",    label: "A4 竖 · 300dpi",     kind: "print", w: 210, h: 297, unit: "mm", dpi: 300 },
  { id: "print-a4l-300",   label: "A4 横 · 300dpi",     kind: "print", w: 297, h: 210, unit: "mm", dpi: 300 },
  // screen / 方形工作画布
  { id: "screen-1080x1920", label: "1080×1920（竖屏）", kind: "screen", w: 1080, h: 1920, unit: "px" },
  { id: "screen-1920x1080", label: "1920×1080（横屏）", kind: "screen", w: 1920, h: 1080, unit: "px" },
  { id: "screen-4096sq",    label: "4096×4096（方）",   kind: "screen", w: 4096, h: 4096, unit: "px" },
  { id: "screen-2048sq",    label: "2048×2048（方）",   kind: "screen", w: 2048, h: 2048, unit: "px" },
  { id: "screen-1024sq",    label: "1024×1024（方）",   kind: "screen", w: 1024, h: 1024, unit: "px" },
  { id: "screen-512sq",     label: "512×512（方）",     kind: "screen", w: 512, h: 512, unit: "px" },
  // pixel（「1024 草稿缩回像素」工作流；面积平均整数比=严格 box）
  { id: "pixel-256", label: "256×256（像素画）", kind: "pixel", w: 256, h: 256, unit: "px" },
  { id: "pixel-128", label: "128×128（像素画）", kind: "pixel", w: 128, h: 128, unit: "px" },
  { id: "pixel-64",  label: "64×64（像素画）",   kind: "pixel", w: 64,  h: 64,  unit: "px" },
  { id: "pixel-32",  label: "32×32（像素画）",   kind: "pixel", w: 32,  h: 32,  unit: "px" },
];

const MM_PER_IN = 25.4;

/** 模板 → 目标像素尺寸（print 类按 DPI 换算，round 到整像素）。 */
export function templatePx(t: CanvasTemplate): { w: number; h: number } {
  if (t.unit === "px") return { w: Math.round(t.w), h: Math.round(t.h) };
  const dpi = t.dpi ?? 300;
  const inW = t.unit === "mm" ? t.w / MM_PER_IN : t.w;
  const inH = t.unit === "mm" ? t.h / MM_PER_IN : t.h;
  return { w: Math.max(1, Math.round(inW * dpi)), h: Math.max(1, Math.round(inH * dpi)) };
}

export function templateById(id: string): CanvasTemplate | null {
  return CANVAS_TEMPLATES.find((t) => t.id === id) ?? null;
}
