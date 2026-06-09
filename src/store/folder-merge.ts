// ┌──────────────────────────────────────────────────────────────────────────┐
// │ GENERIC — Folder shape merge engine.  app-agnostic 深模块。                  │
// │ 知识面只有 entry = { id, uat, name? }，其余字段一律 opaque payload 原样搬运。  │
// │ 不认识 brush / filter / 任何 app 概念。app 专属（笔架 dial、brush ref 用法）    │
// │ 留在 app 层，**别塞进这里**。                                                  │
// │ 这是要 merge-up 到 MyPWAPatterns/sync-store/ 的那块（现在在地改 + 桌面单测）。  │
// │ 模型见 MyPWAPatterns ADR-0011 §Refinement 2026-06-06/-06b、ADR-0004。        │
// │ 性质：mergeFolders 是 commutative + idempotent（CRDT-lite：per-id LWW 寄存器 │
// │ + trash 集合(edit-wins) + max-wins resetAt watermark）→ 乐观并发反复          │
// │ pull-merge-push 必收敛。                                                      │
// └──────────────────────────────────────────────────────────────────────────┘

// ---- Folder shape 类型（本文件 SSoT，folder-store / folder-flow 从这里 import）----
// 知识面只有 id / uat / name?；其余字段 opaque payload，原样搬运（[k: string]: unknown）。
export interface FolderItem {
  id: string | number;
  uat?: number;
  name?: string;
  [k: string]: unknown;
}
export interface TrashRecord {
  id: string | number;
  uat?: number;
  [k: string]: unknown;
}
export interface FolderEnvelope {
  version: number;
  items: FolderItem[];
  trash: TrashRecord[];
  resetAt: number;
}
// 同 id 解析回调：胜出 entry（字段级 override 用）。
export type ResolveFn = (x: FolderItem, y: FolderItem) => FolderItem;
// {id, name} 引用（Work-file / Cue 持引用，Folder 不持指针）。
export interface FolderRef {
  id?: string | number | null;
  name?: string | null;
}

export const FOLDER_ENVELOPE_VERSION = 1;

export function emptyFolder(): FolderEnvelope {
  return { version: FOLDER_ENVELOPE_VERSION, items: [], trash: [], resetAt: 0 };
}

// 默认同 id 解析 = last-user-action-time wins（整 entry）。
// uat 相等的病态情形：用确定性、与顺序无关的 JSON tiebreak，保 commutativity。
function defaultResolve(x: FolderItem, y: FolderItem): FolderItem {
  const ux = x.uat || 0, uy = y.uat || 0;
  if (uy > ux) return y;
  if (uy < ux) return x;
  return JSON.stringify(y) > JSON.stringify(x) ? y : x;
}

// 合并两份 folder envelope。
//   opts.resolve(x, y) → 胜出 entry：字段级 override 用（罕见，如书签集并集）。不传 = 整 entry LWW。
export function mergeFolders(
  a: FolderEnvelope | null | undefined,
  b: FolderEnvelope | null | undefined,
  { resolve }: { resolve?: ResolveFn } = {},
): FolderEnvelope {
  const A = a || emptyFolder(), B = b || emptyFolder();
  const resetAt = Math.max(A.resetAt || 0, B.resetAt || 0);
  const pick = resolve || defaultResolve;

  // 1. items 按 id union；≤ resetAt 的丢（恢复出厂水位线）；同 id 撞 → pick
  const items = new Map<FolderItem["id"], FolderItem>();
  for (const e of [...(A.items || []), ...(B.items || [])]) {
    if (!e || e.id == null || (e.uat || 0) <= resetAt) continue;
    const cur = items.get(e.id);
    items.set(e.id, cur ? pick(cur, e) : e);
  }
  // 2. trash 按 id union（uat 大的胜）；≤ resetAt 的丢
  const trash = new Map<TrashRecord["id"], TrashRecord>();
  for (const t of [...(A.trash || []), ...(B.trash || [])]) {
    if (!t || t.id == null || (t.uat || 0) <= resetAt) continue;
    const cur = trash.get(t.id);
    if (!cur || (t.uat || 0) > (cur.uat || 0)) trash.set(t.id, t);
  }
  // 3. 删 vs 编辑 = edit-wins：item.uat > deletedAt → 复活、trash 记录作废；否则真删、留 trash 记录
  for (const [id, t] of trash) {
    const e = items.get(id);
    if (e && (e.uat || 0) > (t.uat || 0)) trash.delete(id);
    else items.delete(id);
  }
  return {
    version: FOLDER_ENVELOPE_VERSION,
    items: [...items.values()],
    trash: [...trash.values()],
    resetAt,
  };
}

// envelope 结构是否合法（伪在线 / 截断防线的 envelope 级判定）。
export function isValidFolderEnvelope(o: unknown): o is FolderEnvelope {
  const f = o as Partial<FolderEnvelope> | null;
  return !!f && typeof f === "object"
    && Number.isFinite(f.version)
    && Array.isArray(f.items) && f.items.every((e) => e && e.id != null && Number.isFinite(e.uat))
    && Array.isArray(f.trash) && f.trash.every((t) => t && t.id != null && Number.isFinite(t.uat))
    && Number.isFinite(f.resetAt);
}

// 解析不可信 text/bytes（captive-portal 的 HTML 登录页 / 慢网截断）→ 合法 envelope 或 null。
// 绝不让脏字节进 merge：调用端只在非 null 时才 merge。
export function parseFolderBlob(textOrBytes: string | Uint8Array): FolderEnvelope | null {
  let o: unknown;
  try {
    const s = typeof textOrBytes === "string" ? textOrBytes : new TextDecoder().decode(textOrBytes);
    o = JSON.parse(s);
  } catch { return null; }
  return isValidFolderEnvelope(o) ? o : null;
}

// 稳定规范化（id 排序）→ 字符串，用于「两份 folder 是否等价」判定（顺序无关）。
export function normalizeFolder(f: FolderEnvelope): string {
  const byId = (a: { id: FolderItem["id"] }, b: { id: FolderItem["id"] }) => String(a.id).localeCompare(String(b.id));
  return JSON.stringify({
    version: f.version,
    resetAt: f.resetAt || 0,
    items: [...(f.items || [])].sort(byId),
    trash: [...(f.trash || [])].sort(byId),
  });
}

// 把 {id, name} 引用解析到 items：先 id 命中，再 name 兜底，都不中 → null。
// （引用方—— Work-file / Cue ——持引用；Folder 不持指针。ADR-0011 §Refinement。）
export function resolveRef(items: FolderItem[], ref: FolderRef | null | undefined): FolderItem | null {
  if (!ref || !Array.isArray(items)) return null;
  if (ref.id != null) {
    const byId = items.find((e) => e.id === ref.id);
    if (byId) return byId;
  }
  if (ref.name != null) {
    const byName = items.find((e) => e.name === ref.name);
    if (byName) return byName;
  }
  return null;
}
