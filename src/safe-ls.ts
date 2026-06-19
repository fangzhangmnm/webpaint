// 职责（单一）：localStorage 安全读写（隐私窗口 / 配额满会 throw，全包住）。
export function safeLS(key: string, fallback: string | null = null): string | null {
  try { return localStorage.getItem(key); } catch { return fallback; }
}
export function safeLSSet(key: string, val: string): void {
  try { localStorage.setItem(key, val); } catch {}
}
