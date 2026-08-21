// 图库自然排序（user 2026-08-21：「图库排序是自然排序吧（10 在 2 后面）」）。
// 唯一共享 collator（模块级，别每次比较 new 一个）：numeric = 数字段按数值比（a2 < a10）、
// sensitivity "base" = 大小写/重音不敏感；locale 留 undefined 跟设备（中文名照常按本地 locale 序）。
// 零 DOM / 零 store 纯模块——app-store 列举适配与 gallery UI 共用。
const _collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function naturalCompare(a: string, b: string): number {
  return _collator.compare(a, b);
}
