// 剪贴板 / 图片导入的**纯策略**（spec：ai-docs/20260819-clipboard-and-local-file-spec.md）。
// 纯模块：无 DOM / 无剪贴板 API —— node 可测（clipboard IO 那层进真机批）。
//
// 双击 Ctrl+C（human 拍板 2026-08-19）：短窗内第二次 Ctrl+C = 升级为合并复制（合成图覆写剪贴板）。
//   第一下照常复制活层——升级只是覆写，不存在"第一下白按"的丢失。
// 大图导入护栏（同日拍板）：护栏本职 = undo 内存护栏（重采样必须发生在 lift 之前才真省内存），
//   **不是构图意见**——photobash 常态是素材比画布大、摆位后裁溢出，所以下限托到画布长边，
//   保证"素材 ≥ 画布"永远可能（fit-to-canvas 方案已作废：进门先缩到画布 = 后续放大 = 糊）。
//   不超护栏：静默原尺寸进；超护栏：跳"大图片导入"窗口。

/** 双击判定窗口（ms）。PS 肌肉记忆的连按节奏 <1s；再长会把两次独立复制误判成升级。 */
export const DOUBLE_COPY_WINDOW_MS = 900;

/** 上一次 Ctrl+C 距今在窗口内 → 本次升级为合并复制。lastAt=0（从未按过）永不判双。 */
export function isDoubleCopy(lastAt: number, now: number): boolean {
  return lastAt > 0 && now - lastAt <= DOUBLE_COPY_WINDOW_MS;
}

/** 导入护栏边长 = max(2048, 画布长边)。画布本身 >2k 时按 2k 卡会重蹈"进门先糊"，下限托到画布长边。 */
export function importGuardLimit(docW: number, docH: number): number {
  return Math.max(2048, docW, docH);
}

/** 图片任一边超护栏 → 需要弹"大图片导入"窗口；否则静默原尺寸进。 */
export function needsBigImportSheet(ow: number, oh: number, docW: number, docH: number): boolean {
  const limit = importGuardLimit(docW, docH);
  return ow > limit || oh > limit;
}
