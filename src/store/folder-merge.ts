// ┌──────────────────────────────────────────────────────────────────────────┐
// │ GENERIC — Folder shape merge engine.  app-agnostic 深模块。                  │
// │ 知识面只有 entry = { id, uat, name? }，其余字段一律 opaque payload 原样搬运。  │
// │ 不认识 brush / filter / 任何 app 概念。app 专属（笔架 dial、brush ref 用法）    │
// │ 留在 app 层，**别塞进这里**。                                                  │
// │ 这是要 merge-up 到 MyPWAPatterns/sync-store/ 的那块（现在在地改 + 桌面单测）。  │
// │ 模型见 MyPWAPatterns ADR-0011 §Refinement 2026-06-06/-06b、ADR-0004。        │
// │ 性质：mergeFolders 是 commutative + idempotent（CRDT-lite：per-id uat-LWW    │
// │ 寄存器）→ 乐观并发反复 pull-merge-push 必收敛。                                 │
// │ **删除 = value:null 墓碑**（明确删除指令，非「未知」）：与普通值一样按 uat-LWW    │
// │ 搬运——merge 层不特殊处理，collection 层读时过滤 value===null。故无独立 trash    │
// │ 集合、无 resetAt 水位线（2026-07 tombstone 化）。                              │
// └──────────────────────────────────────────────────────────────────────────┘

import { reportStoreError } from "./error-handling.ts";   // 全接但分级：静默 swallow 也 funnel（不改控制流）

// ---- Folder shape 类型（本文件 SSoT，collection / folder-flow 从这里 import）----
// 知识面只有 id / uat / name?；其余字段 opaque payload，原样搬运（[k: string]: unknown）。
// value === null = **墓碑**（删除指令）：merge 照 LWW 搬运，collection 层读时过滤。
export interface FolderItem {
  id: string | number;
  uat?: number;
  name?: string;
  [k: string]: unknown;
}
export interface FolderEnvelope {
  version: number;
  items: FolderItem[];
}
// 同 id 解析回调：胜出 entry（字段级 override 用）。
export type ResolveFn = (x: FolderItem, y: FolderItem) => FolderItem;

// ── 冲突策略（N11，显式化）──────────────────────────────────────────────
// **数据类区别（钉死）**：珍贵作品类（.ora 画作）走 If-Match、**绝不 LWW**——分歧一律 surface
//   （冲突 sheet / .backup），见 cloud-sync。Folder 形状（笔架等**配置类**数据）则是
//   **有意采用 last-win**：同一支笔在两端并发改，时间戳（uat）新的胜、旧的丢——冲突概率近零、
//   配置丢一次微调远轻于丢一幅画，这是经权衡的取舍（非红线违反）。
//   删除同理：value:null 墓碑带 uat，与编辑竞争 last-win（删得晚→删掉，编辑得晚→留编辑）。
// 这里把它从「藏在 defaultResolve 里」升成**显式命名的策略枚举**，自文档化、未来可扩
//   （如某数据类要 "duplicate-on-clash" 再加值）。目前**只实现 "last-win"**。
export type FolderConflictPolicy = "last-win";
export const lastWinResolve: ResolveFn = (x, y) => defaultResolve(x, y);
function resolverForPolicy(policy: FolderConflictPolicy): ResolveFn {
  switch (policy) {
    case "last-win": return lastWinResolve;
    default: return lastWinResolve;   // 目前只此一种；扩枚举时在此加 case
  }
}
// {id, name} 引用（Work-file / Cue 持引用，Folder 不持指针）。
export interface FolderRef {
  id?: string | number | null;
  name?: string | null;
}

export const FOLDER_ENVELOPE_VERSION = 2;   // v2：删除改 value:null 墓碑（去掉 trash[]/resetAt）

export function emptyFolder(): FolderEnvelope {
  return { version: FOLDER_ENVELOPE_VERSION, items: [] };
}

// 默认同 id 解析 = last-user-action-time wins（整 entry）。
// uat 相等的病态情形：用确定性、与顺序无关的 JSON tiebreak，保 commutativity。
function defaultResolve(x: FolderItem, y: FolderItem): FolderItem {
  const ux = x.uat || 0, uy = y.uat || 0;
  if (uy > ux) return y;
  if (uy < ux) return x;
  return JSON.stringify(y) > JSON.stringify(x) ? y : x;
}

// 合并两份 folder envelope。纯 per-id uat-LWW 寄存器（删除 = value:null 墓碑，照 LWW 搬运，不特殊处理）。
//   opts.resolve(x, y) → 胜出 entry：字段级 override 用（罕见，如书签集并集）。不传 = 整 entry LWW。
export function mergeFolders(
  a: FolderEnvelope | null | undefined,
  b: FolderEnvelope | null | undefined,
  { resolve, conflictPolicy = "last-win" }: { resolve?: ResolveFn; conflictPolicy?: FolderConflictPolicy } = {},
): FolderEnvelope {
  const A = a || emptyFolder(), B = b || emptyFolder();
  const pick = resolve || resolverForPolicy(conflictPolicy);   // N11：显式策略（默认 last-win）；resolve override 仍优先

  // items 按 id union；同 id 撞 → pick（uat-LWW）。value:null 墓碑就是一个普通 entry，照 LWW 搬运。
  const items = new Map<FolderItem["id"], FolderItem>();
  for (const e of [...(A.items || []), ...(B.items || [])]) {
    if (!e || e.id == null) continue;
    const cur = items.get(e.id);
    items.set(e.id, cur ? pick(cur, e) : e);
  }
  return { version: FOLDER_ENVELOPE_VERSION, items: [...items.values()] };
}

// envelope 结构是否合法（伪在线 / 截断防线的 envelope 级判定）。
export function isValidFolderEnvelope(o: unknown): o is FolderEnvelope {
  const f = o as Partial<FolderEnvelope> | null;
  return !!f && typeof f === "object"
    && Number.isFinite(f.version)
    && Array.isArray(f.items) && f.items.every((e) => e && e.id != null && Number.isFinite(e.uat));
}

// 解析不可信 text/bytes（captive-portal 的 HTML 登录页 / 慢网截断）→ 合法 envelope 或 null。
// 绝不让脏字节进 merge：调用端只在非 null 时才 merge。
export function parseFolderBlob(textOrBytes: string | Uint8Array): FolderEnvelope | null {
  let o: unknown;
  try {
    const s = typeof textOrBytes === "string" ? textOrBytes : new TextDecoder().decode(textOrBytes);
    o = JSON.parse(s);
  } catch (e) { reportStoreError(e, "log"); return null; }
  return isValidFolderEnvelope(o) ? o : null;
}

// 稳定规范化（id 排序）→ 字符串，用于「两份 folder 是否等价」判定（顺序无关）。
export function normalizeFolder(f: FolderEnvelope): string {
  const byId = (a: { id: FolderItem["id"] }, b: { id: FolderItem["id"] }) => String(a.id).localeCompare(String(b.id));
  return JSON.stringify({
    version: f.version,
    items: [...(f.items || [])].sort(byId),
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
