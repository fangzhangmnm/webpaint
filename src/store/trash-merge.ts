// ⚠ 使用前必读 README.md + CONTEXT.md。store 内部深模块——app 经 createStore（store.listTrash/listBackup 返聚合结果）。
//
// trash-merge（深模块，纯函数，零 IO）—— 回收站/备份箱**本地↔云两端聚合**成单一视图。
//   离线删 → 进本地 trash；在线删 synced → 进云端 trash；在线删 dirty → 两端都进（世界唯一字节留本地可恢复）。
//   故同一逻辑删除可能在**一端或两端**留痕。本模块按**原名**归并两端，标 side:"local"|"cloud"|"both"。
//
// **只处理元数据**（trashKey / cloudItemId / 原名 / 时间戳 / 加密标志），**绝不碰 blob**（回收站 invariant：拿不到字节）。
//
// conflictLive（附录那条）：离线删排队 → 回线 replay 时云端已被别处改过 → edit-wins 取消云删 → 本地 trash 有、
//   云端**还活着**（数据两存）。据传入的**权威** live 列表检出，标 conflictLive:true 供 UI surface（别丢）。

import type { CloudItem, TrashEntry } from "./types.ts";

export interface TrashItem {
  name: string;               // 展示/恢复原名（local 行 = 全路径身份；cloud-only 行 = basename，folder context 在云端 trash 已丢）
  ts: string | null;          // yyyymmddhhmmss（展示/排序；解析不出 → null）
  side: "local" | "cloud" | "both";
  encrypted: boolean;         // 云端字节是加密容器（从 stamped `.zip` 尾推断）→ restore 落 encFileName
  conflictLive: boolean;      // local 行原名仍活在权威云端列表（离线删被 edit-wins 撤销）→ 两存，别丢
  localKey: string | null;    // 本地 trashKey（本地腿 restore/purge）
  cloudItemId: string | null; // 云端 item id（云端腿 restore/purge）
}

// stamped 名 = `<base> [<deleteEventId>]`（明文）或同名尾接 `.zip`（加密容器，encFileName 追加）。
//   deleteEventId = `<yyyymmddhhmmss>-<guid>`，见 move-aside.asideStamp / cloud-sync.stampedName。
const STAMP_RE = /^(.*) \[((\d{14})-[0-9a-fA-F-]+)\](\.zip)?$/;
const baseNameOf = (n: string): string => (n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n);

// 云端 trash 文件名 → { 原 basename, deleteEventId, 时间戳, 是否加密 }。无戳（异常/手工放入）→ 原名 + 裸 .zip 尾推断。
function parseCloudTrashName(cloudName: string): { base: string; id: string | null; ts: string | null; encrypted: boolean } {
  const m = cloudName.match(STAMP_RE);
  if (m) return { base: m[1], id: m[2], ts: m[3], encrypted: !!m[4] };
  const encrypted = cloudName.endsWith(".zip");
  return { base: encrypted ? cloudName.slice(0, -4) : cloudName, id: null, ts: null, encrypted };
}

// 本地 trashKey → deleteEventId（`trash/<yyyymmddhhmmss-guid>:<name>`）。无戳（异常/手工放入）→ null。
function parseLocalStamp(trashKey: string): { id: string | null; ts: string | null } {
  const slash = trashKey.indexOf("/");
  const inner = slash < 0 ? trashKey : trashKey.slice(slash + 1);
  const m = inner.match(/^((\d{14})-[0-9a-fA-F-]+):/);
  return m ? { id: m[1], ts: m[2] } : { id: null, ts: null };
}

const byTs = (a: { ts: string | null }, b: { ts: string | null }): number => (a.ts || "").localeCompare(b.ts || "");

/**
 * 两端聚合。
 * @param localEntries  local.listTrash()/listBackup() 结果（name = 全路径原名）。
 * @param cloudEntries  cloud.listTrash()/listBackup() 结果（name = stamped 云端文件名）。
 * @param liveCloudNames 权威 live 云端身份集合（listAll.complete 时才传真值；离线/partial 传空 set → conflictLive 恒 false，绝不误报）。
 */
export function mergeTrash(
  localEntries: TrashEntry[],
  cloudEntries: CloudItem[],
  liveCloudNames: Set<string> = new Set(),
): TrashItem[] {
  const localByBase = new Map<string, Array<{ entry: TrashEntry; id: string | null; ts: string | null }>>();
  for (const e of localEntries) {
    const base = baseNameOf(e.name);
    const bucket = localByBase.get(base) ?? [];
    const st = parseLocalStamp(e.trashKey);
    bucket.push({ entry: e, id: st.id, ts: st.ts });
    localByBase.set(base, bucket);
  }
  const cloudByBase = new Map<string, Array<{ item: CloudItem; id: string | null; ts: string | null; encrypted: boolean }>>();
  for (const it of cloudEntries) {
    const p = parseCloudTrashName(it.name);
    const bucket = cloudByBase.get(p.base) ?? [];
    bucket.push({ item: it, id: p.id, ts: p.ts, encrypted: p.encrypted });
    cloudByBase.set(p.base, bucket);
  }

  const out: TrashItem[] = [];
  const bases = new Set([...localByBase.keys(), ...cloudByBase.keys()]);
  for (const base of bases) {
    const locals = (localByBase.get(base) ?? []).slice().sort(byTs);
    const clouds = (cloudByBase.get(base) ?? []).slice().sort(byTs);
    // ── 按 deleteEventId **精确**配对 ────────────────────────────────────────────────────────
    //   一次删除 = 一个 id，两条腿共用（delete.ts 生成并传给两端）。id 相同 ⟺ 同一次删除。
    //   ⚠ 以前是「按时间戳排序后按下标配对」，那在**单腿删除交叉**时会出人命：
    //     离线删 A（只落本地腿）→ 之后在线删重建的 A（只落云腿）→ 下标配对把这两次无关的删除
    //     配成一行 both → 用户点「彻底删除」时 purge 同时送 trashKey + cloudItemId，
    //     一次删掉两个不相干的文件，UI 还只说删了一件。restore 同理会张冠李戴。
    //   配不上 = 就是两次独立的删除，各出各的行。**不做下标兜底**（那等于把 bug 留一条后门）。
    const usedCloud = new Set<number>();
    const byId = new Map<string, number>();
    clouds.forEach((c, i) => { if (c.id) byId.set(c.id, i); });
    const lonelyLocals: typeof locals = [];
    for (const l of locals) {
      const ci = l.id != null ? byId.get(l.id) : undefined;
      if (ci == null || usedCloud.has(ci)) { lonelyLocals.push(l); continue; }
      usedCloud.add(ci);
      const c = clouds[ci];
      out.push({ name: l.entry.name, ts: l.ts ?? c.ts, side: "both", encrypted: c.encrypted, conflictLive: false, localKey: l.entry.trashKey, cloudItemId: c.item.id });
    }
    for (const l of lonelyLocals) {
      // 纯本地行才可能 conflictLive：本地 trash 有、原名却仍活在权威云端 = 离线删被 edit-wins 撤销 → 两存。
      out.push({ name: l.entry.name, ts: l.ts, side: "local", encrypted: false, conflictLive: liveCloudNames.has(l.entry.name), localKey: l.entry.trashKey, cloudItemId: null });
    }
    clouds.forEach((c, i) => {
      if (usedCloud.has(i)) return;
      out.push({ name: base, ts: c.ts, side: "cloud", encrypted: c.encrypted, conflictLive: false, localKey: null, cloudItemId: c.item.id });
    });
  }
  return out;
}
