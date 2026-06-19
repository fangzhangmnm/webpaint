// 「能否在当前 active 写像素」单谓词的 UI 包装（CONTEXT「requireEditableLeaf」）。
// 拿可写叶或弹标准状态行后返回 null。所有写/读单叶像素的命令（填充/清除/调整/滤镜/拷贝/…）穿它，
// 取代散在各处的 ad-hoc isGroup/!visible 检查。纯谓词在 doc.activeEditableLeaf；本层只加标准文案。
// 例外（不穿此谓词）：变换 / Ctrl+D（组合法）、doc 级命令（裁剪/合并）。
const REASON_MSG = {
  none: "没有活动图层",
  group: "当前选中的是图层组，请选择一个图层",
  hidden: "当前图层已隐藏",
};

// 返回可写叶；不可写 → 弹标准状态行（setStatus(msg, true)）并返回 null。
export function requireEditableLeaf(doc, setStatus, opts = {}) {
  const { leaf, reason } = doc.activeEditableLeaf(opts);
  if (!leaf) {
    if (setStatus && reason) setStatus(REASON_MSG[reason], true);
    return null;
  }
  return leaf;
}
