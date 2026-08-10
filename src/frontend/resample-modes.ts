// 重采样方法 SSoT + `<select>` 投影（C3 从 resample.ts 迁出——算法核在 backend/algorithms/
// resample-bytes.ts，本文件只有模式表和 UI 填充，零像素数学）。
// 所有 dropdown（变换采样 / 调整尺寸 / 液化 / 导入 sheet）从这拉，加新方法（以后 AI）只改这。
// contexts：transform = 自由变换的逐像素采样（GPU warp shader 支持 nearest/bilinear/bicubic）；
//   scale = 轴对齐缩放（resample-bytes）；liquify = 液化重建核。
// 排序 = 推荐度（user 2026-07-29 真机裁决：加反振铃限幅后 spline 多次插值比双三次无显著提高、
// 还有一点点卡 → 双三次回默认第一、像素完美第二，spline 降为吃灰档保留）。
export const RESAMPLE_MODES = [
  { id: "bicubic",   label: "双三次（高质量）",     contexts: ["transform", "scale", "liquify"] },   // v0.6.61 液化补第四核并设默认（对齐 07-29 裁决）
  { id: "rotsprite", label: "像素完美（像素画）",   contexts: ["transform"] },              // RotSprite（backend/algorithms/rotsprite.ts）：EPX 放大+nearest，零糊；摆正态=逐字节置换
  { id: "spline",    label: "样条（多次变换）",     contexts: ["transform", "liquify"] },   // 预滤波三次 B 样条（backend/algorithms/bspline.ts）；真机裁决无显著优势，保留自选
  { id: "sharper",   label: "缩小优化（清晰）",     contexts: ["scale"] },         // 面积平均（area kernel，适合缩小）；放大退回 bicubic
  { id: "bilinear",  label: "双线性（软）",         contexts: ["transform", "scale", "liquify"] },
  { id: "nearest",   label: "最近邻（像素画）",     contexts: ["transform", "scale", "liquify"] },
  // 以后：{ id: "ai", label: "AI 放大", contexts: ["scale"] }
];

// 用 RESAMPLE_MODES 填一个 <select>（按 context 过滤），选中 selected。
export function fillResampleSelect(sel: HTMLSelectElement | null, context: string | null, selected: string) {
  if (!sel) return;
  sel.innerHTML = "";
  for (const m of RESAMPLE_MODES) {
    if (context && m.contexts && !m.contexts.includes(context)) continue;
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === selected) opt.selected = true;
    sel.appendChild(opt);
  }
}
