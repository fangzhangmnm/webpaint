// 职责（单一）：笔架的**持久化后端** —— 把笔架搬进 store.collection（云端 .webpaint/brush-rack.json，
//   逐 brush 一 item，per-item uat-LWW 零冲突）。取代旧的「IDB meta 整包 blob + folder-store 快照/onResult」。
//
// 深模块边界：brush-rack.ts 只认本模块暴露的 RackCollection 面（init/list/reconcile/syncCloud/status…），
//   对 collection 的 upsert/delete/seed/一次性 IDB 迁移/默认笔种子全在这里内化。合并语义**不手搓**——
//   逐 item LWW 由 store.collection 提供（红线：碰 store 合并绝不重导，见 memory feedback_store_no_rederive）。
//
// 三件事本模块负责：
//   1. **一次性迁移**：老用户的笔架在 IDB meta["brush-rack"]。首次上 collection（collection 空 ∧ 无 meta）时，
//      读老 rack、逐笔 migrateBrush + 按数组序赋 order，upsert 进 collection。旧 IDB **不删**（保底），只打 meta 戳防重迁。
//   2. **默认笔种子**：全新用户（无 IDB、collection 空）种当前 default-brushes。default-brushes.json 是 async fetch，
//      boot 时可能还没回 → init 先种手上有的，boot 的 defaultsPromise 回来后再调 seedDefaults() 补齐。
//   3. **删除 = tombstone**：collection.deleteItem 内部记 tombstone → 删过的笔（含默认笔）不跨设备复活。
//      ⚠ collection 不对外暴露 tombstone → app 侧「补缺失默认笔」只在 seedGen 升级时做（否则删掉的默认笔会复活）。
//      seedGen 存在同步的 __rackmeta__ item 里 → 跨设备一致。
//
// 详见 docs/20260713-brush-rack-collection.md。

import type { Collection } from "./store/index.ts";
import type { Brush } from "./brush-types.ts";
import { makeDefaultRack, migrateBrush, nextBrushOrder } from "./brushes.ts";
import { getMeta } from "./storage.ts";

// collection 里的保留 item id：笔架元数据（种子代号）。list() 滤掉，绝不当笔用。
const RACK_META_ID = "__rackmeta__";
// 老 IDB 整包 rack 的 key（一次性迁移源）。
const IDB_RACK_KEY = "brush-rack";
// 种子代号：全新种入的默认笔集版本。**升号 = 主动把新一批默认笔推给老用户**（代价：会复活用户删过的旧默认笔，
//   见头注释 tombstone 不可见的取舍）。不升 = 老用户的笔架只按自己的增删走，默认笔不自动增补。
export const RACK_SEED_GEN = 1;

interface RackMeta { seedGen: number }

// canonical JSON（键排序，递归）——reconcile 里判「笔有没有变」用，避免键序差异造成假变更→无谓 uat clobber。
function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
}
// 内容指纹：忽略 uat（collection 用它当保留 envelope 键、读回已 strip；内存侧编辑会带上）。
//   → 只按真实笔内容判「变没变」，同内容不因 uat 差异 re-upsert（防无谓 clobber）。
function brushFingerprint(b: unknown): string {
  const { uat: _uat, ...rest } = (b || {}) as Record<string, unknown>;
  return canon(rest);
}

// collection item ↔ Brush：collection 的 payload 就是 Brush（含自己的 id）。
type BrushItem = Brush;

export interface RackCollection {
  // 首次拉云 + 本地 hydrate + 一次性 IDB 迁移 / 全新种子。返回当前全部笔（按 order 升序）。
  init(): Promise<Brush[]>;
  // default-brushes.json async 回来后调：seedGen 落后才补缺失默认笔（by id）。返回新全量笔或 null(no-op)。
  seedDefaults(defaults: Brush[]): Brush[] | null;
  // 持久化：把内存笔架对账进 collection（新增/变更 upsert、消失的 delete）。app 每次改架后调。
  reconcile(brushes: Brush[]): void;
  // 云同步：flush（写本地 + 若脏推云）后返回刷新后的全部笔（按 order）。
  syncCloud(): Promise<Brush[]>;
  flushLocal(): Promise<void>;
  isDirty(): boolean;
  // 云图标态机（复用旧 folder-store 优先级：busy > no-auth > offline > dirty > synced）。
  status(ctx: { signedIn: boolean; online: boolean }): string;
}

// 读 collection 全部笔（滤掉 __rackmeta__，按 order 升序；无 order 的沉底稳定）。
function readBrushes(coll: Collection<BrushItem>): Brush[] {
  const items = coll.items().filter((it) => it.id !== RACK_META_ID) as Brush[];
  return items.slice().sort((a, b) => {
    const oa = typeof a.order === "number" ? a.order : Number.MAX_SAFE_INTEGER;
    const ob = typeof b.order === "number" ? b.order : Number.MAX_SAFE_INTEGER;
    return oa - ob;
  });
}

function getMetaItem(coll: Collection<BrushItem>): RackMeta | null {
  const it = coll.getItem(RACK_META_ID) as (BrushItem & Partial<RackMeta>) | undefined;
  return it && typeof it.seedGen === "number" ? { seedGen: it.seedGen } : null;
}
function setMetaItem(coll: Collection<BrushItem>, meta: RackMeta): void {
  // __rackmeta__ 借用 BrushItem 通道存 { id, seedGen }（payload 不透明，collection 不看形状）。
  coll.upsertItem({ id: RACK_META_ID, seedGen: meta.seedGen } as unknown as BrushItem);
}

// 老 IDB 整包 rack 读取器（一次性迁移源）。默认走 storage.getMeta("brush-rack")；测试可注入。
export type LegacyRackReader = () => Promise<{ brushes?: Brush[] } | null>;
const defaultLegacyReader: LegacyRackReader = async () => {
  try { return (await getMeta(IDB_RACK_KEY)) as { brushes?: Brush[] } | null; } catch { return null; }
};

export function createRackStore(coll: Collection<BrushItem>, readLegacyRack: LegacyRackReader = defaultLegacyReader): RackCollection {
  let busy = false;

  // 把一批笔 upsert 进 collection（覆盖/新增；collection 内部盖 envelope uat）。
  function upsertAll(brushes: Brush[]): void {
    for (const b of brushes) coll.upsertItem({ ...b, id: b.id });
  }

  // 一次性 IDB → collection 迁移。返回是否发生了迁移。
  async function migrateFromIdb(): Promise<boolean> {
    let rack: { brushes?: Brush[] } | null = null;
    try { rack = await readLegacyRack(); } catch { rack = null; }
    if (!rack || !Array.isArray(rack.brushes) || rack.brushes.length === 0) return false;
    // 逐笔 migrateBrush（v82~v99 老字段修正）+ 按数组序赋 order（保持老排列）。
    const brushes = rack.brushes.map((b, i) => {
      const mb = { ...b } as Brush;
      migrateBrush(mb as never);
      if (typeof mb.order !== "number") mb.order = i;
      return mb;
    });
    upsertAll(brushes);
    return true;
  }

  async function init(): Promise<Brush[]> {
    await coll.init();
    const meta = getMetaItem(coll);
    const hasBrushes = readBrushes(coll).length > 0;
    if (!meta && !hasBrushes) {
      // collection 全新（没别的设备迁移过来）→ 试一次性 IDB 迁移；没老数据就种当前默认笔。
      const migrated = await migrateFromIdb();
      if (migrated) {
        // 迁移过来的架已含用户的默认笔增删 → 记 seedGen=当前，之后不自动补默认（尊重用户删除）。
        setMetaItem(coll, { seedGen: RACK_SEED_GEN });
      } else {
        const defaults = makeDefaultRack().brushes;
        upsertAll(defaults);
        // default-brushes.json 没 fetch 回时 makeDefaultRack 只有 emergency 笔 → seedGen 留 -1，等 seedDefaults 补齐真默认。
        const seeded = defaults.length > 1 || (defaults[0]?.id !== "emergency-brush");
        setMetaItem(coll, { seedGen: seeded ? RACK_SEED_GEN : -1 });
      }
      await coll.flushLocal();
    }
    return readBrushes(coll);
  }

  function seedDefaults(defaults: Brush[]): Brush[] | null {
    if (!defaults || defaults.length === 0) return null;
    const meta = getMetaItem(coll);
    const gen = meta ? meta.seedGen : -1;
    if (gen >= RACK_SEED_GEN) return null;   // 已是当前代 → 不动（尊重用户删除，不复活）
    const present = new Set(coll.keys());
    let ord = nextBrushOrder(readBrushes(coll));
    const missing = defaults.filter((d) => !present.has(d.id));
    for (const d of missing) coll.upsertItem({ ...d, id: d.id, order: typeof d.order === "number" ? d.order : ord++ });
    // init 在 default-brushes.json 未 fetch 回时会先种 emergency 笔占位；真默认笔到位后清掉它（除非它本就是默认笔）。
    if (missing.length > 0 && present.has("emergency-brush") && !defaults.some((d) => d.id === "emergency-brush")) {
      coll.deleteItem("emergency-brush");
    }
    setMetaItem(coll, { seedGen: RACK_SEED_GEN });
    void coll.flushLocal();
    if (missing.length === 0) return null;    // 只升 gen、无新笔 → caller 不必刷
    return readBrushes(coll);
  }

  function reconcile(brushes: Brush[]): void {
    const desired = new Map(brushes.map((b) => [b.id, b]));
    // 删：collection 里有、内存里没了的（__rackmeta__ 除外）→ tombstone。
    for (const id of coll.keys()) {
      if (id === RACK_META_ID) continue;
      if (!desired.has(id)) coll.deleteItem(id);
    }
    // 增/改：新 id 或内容变了才 upsert（未变的不动 → 保 envelope uat 不被无谓 clobber）。
    for (const b of brushes) {
      const cur = coll.getItem(b.id);
      if (!cur || brushFingerprint(cur) !== brushFingerprint({ ...b, id: b.id })) coll.upsertItem({ ...b, id: b.id });
    }
    void coll.flushLocal();
  }

  async function syncCloud(): Promise<Brush[]> {
    busy = true;
    try { await coll.flush(); } finally { busy = false; }
    return readBrushes(coll);
  }

  return {
    init,
    seedDefaults,
    reconcile,
    syncCloud,
    flushLocal: () => coll.flushLocal(),
    isDirty: () => coll.isDirty(),
    status({ signedIn, online }) {
      if (busy) return "busy";
      if (!signedIn) return "no-auth";
      if (!online) return "offline";
      if (coll.isDirty()) return "dirty";
      return "synced";
    },
  };
}
