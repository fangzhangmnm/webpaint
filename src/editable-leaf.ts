// 「能否在当前 active 写像素」单谓词的 UI 包装（CONTEXT「requireEditableLeaf」）。
// 拿可写叶或弹标准状态行后返回 null。所有写/读单叶像素的命令（填充/清除/调整/滤镜/拷贝/…）穿它，
// 取代散在各处的 ad-hoc isGroup/!visible 检查。纯谓词在 doc.activeEditableLeaf；本层只加标准文案。
// 例外（不穿此谓词）：变换 / Ctrl+D（组合法）、doc 级命令（裁剪/合并）。
import { t } from "./i18n/index.ts";
const REASON_KEY = { none: "el.none", group: "el.group", hidden: "el.hidden" } as const;
const reasonMsg = (reason: string): string => t(REASON_KEY[reason as keyof typeof REASON_KEY] ?? ("el.none" as never));

// doc.activeEditableLeaf 的最小结构契约（doc 本体仍是未类型化 .js；这里只读返回形状）。
interface EditableLeafResult { leaf: unknown | null; reason: string | null; }
interface DocWithEditableLeaf {
  activeEditableLeaf(opts?: Record<string, unknown>): EditableLeafResult;
}
type SetStatus = (msg: string, isError?: boolean) => void;

// 返回可写叶；不可写 → 弹标准状态行（setStatus(msg, true)）并返回 null。
export function requireEditableLeaf(doc: DocWithEditableLeaf, setStatus: SetStatus | null | undefined, opts: Record<string, unknown> = {}): unknown | null {
  const { leaf, reason } = doc.activeEditableLeaf(opts);
  if (!leaf) {
    if (setStatus && reason) setStatus(reasonMsg(reason), true);
    return null;
  }
  return leaf;
}
