// reconcile 深模块测试：cloud-gone 安全收敛。纯分类器穷举 + 编排守卫（离线/partial/空/抛错→no-op）。
// 红线（升级后 2026-07-17）：clean 孤儿走**去抖**——第一次权威见 gone 只标 candidate（不删）；连续第二次+且跨 GRACE
//   → 本地 send trash（可恢复）+ 清两轨 etag；重现/被编辑 → 自愈清 candidate；dirty/从没synced/在云端/非权威 一律不动。
import { test, eq, assert } from "./runner.mjs";
import { classifyCloudGone, createReconcile } from "../src/store/reconcile.ts";
import { createPendingGone } from "../src/store/pending-gone.ts";

function memKv() {
  const m = new Map<string, string>();
  return { get: (k: string) => (m.has(k) ? m.get(k)! : null), set: (k: string, v: string) => { m.set(k, String(v)); }, remove: (k: string) => { m.delete(k); } };
}

// ── 纯分类器（穷举）──
test("[reconcile] not authoritative → 空", () => {
  const r = classifyCloudGone(["a"], new Set(), { seenBase: () => "e", isDirty: () => false, authoritative: false });
  eq(r.demote.length, 0, "不权威不动");
});
test("[reconcile] 云端还在 → skip", () => {
  const r = classifyCloudGone(["a"], new Set(["a"]), { seenBase: () => "e", isDirty: () => false, authoritative: true });
  eq(r.demote.length, 0, "在云端不是孤儿");
});
test("[reconcile] 从没 synced（seenBase=null）→ skip（真本地文件，永不碰）", () => {
  const r = classifyCloudGone(["a"], new Set(), { seenBase: () => null, isDirty: () => false, authoritative: true });
  eq(r.demote.length, 0, "无 etag 永不碰");
});
test("[reconcile] dirty 孤儿 → skip（留着，绝不动未推字节）", () => {
  const r = classifyCloudGone(["a"], new Set(), { seenBase: () => "e", isDirty: () => true, authoritative: true });
  eq(r.demote.length, 0, "dirty 留");
});
test("[reconcile] clean 孤儿 → demote", () => {
  const r = classifyCloudGone(["a", "b"], new Set(["b"]), { seenBase: () => "e", isDirty: () => false, authoritative: true });
  eq(r.demote.join(","), "a", "a 是 clean 孤儿");
});
test("[reconcile] K1 skip（当前打开的 doc）→ 不降级", () => {
  const r = classifyCloudGone(["a"], new Set(), { seenBase: () => "e", isDirty: () => false, authoritative: true, skip: (n) => n === "a" });
  eq(r.demote.length, 0, "active doc 跳过");
});

// ── 编排（守卫 + 去抖 trash 动作）──
function rig(opts: { online?: boolean; graceMs?: number } = {}) {
  const local = { appKeys: async () => ["orphan.pdf", "live.pdf", "localfile.pdf", "dirty.pdf"], trash: async (n: string) => { trashed.push(n); return `trash/${n}`; } };
  const seen = new Map<string, string>([["orphan.pdf", "e"], ["live.pdf", "e"], ["dirty.pdf", "e"]]);  // localfile.pdf 从没 synced
  const dirty = new Set(["dirty.pdf"]);
  const cleared: string[] = [], forgotten: string[] = [], trashed: string[] = [];
  const head = { seenBase: (n: string) => (seen.has(n) ? seen.get(n)! : null), isDirty: (n: string) => dirty.has(n), forget: (n: string) => forgotten.push(n) };
  let listResult: { files: { path: string }[]; folders: string[]; complete: boolean } | "throw" = { files: [{ path: "live.pdf" }], folders: [], complete: true };
  const cloud = { listAll: async () => { if (listResult === "throw") throw new Error("x"); return listResult; }, clearState: (n: string) => { cleared.push(n); } };
  let clock = 100000;
  const pending = createPendingGone(memKv(), opts.graceMs ?? 1000);
  const { reconcile } = createReconcile({ cloud: cloud as any, local: local as any, head: head as any, pending, now: () => clock, isOnline: () => opts.online !== false });
  return { reconcile, cleared, forgotten, trashed, pending, tick: (ms: number) => { clock += ms; }, setDirty: (n: string) => dirty.add(n), setList: (l: typeof listResult) => { listResult = l; } };
}

test("[reconcile] 去抖：第一次权威见 gone → 只标 candidate，不删（demoted 空、pendingGone、blob 不动）", async () => {
  const r = rig();
  const out = await r.reconcile();
  eq(out.demoted.length, 0, "首次不删");
  assert(r.pending.isPending("orphan.pdf"), "orphan 标为 candidate-gone");
  eq(r.trashed.length, 0, "没 trash"); eq(r.forgotten.length, 0, "没清谱系");
  assert(!r.pending.isPending("live.pdf") && !r.pending.isPending("localfile.pdf") && !r.pending.isPending("dirty.pdf"), "live/从没synced/dirty 都不标");
});
test("[reconcile] 去抖：连续第二次 + 跨 GRACE → 本地 send trash + 清两轨 etag + 清 candidate", async () => {
  const r = rig({ graceMs: 1000 });
  await r.reconcile();          // 第一次：标记
  r.tick(1500);                 // 跨过 grace
  const out = await r.reconcile();
  eq(out.demoted.join(","), "orphan.pdf", "跨 grace 第二次 → 动手");
  eq(r.trashed.join(","), "orphan.pdf", "本地 send trash（可恢复）");
  eq(r.cleared.join(","), "orphan.pdf", "cloud.clearState");
  eq(r.forgotten.join(","), "orphan.pdf", "head.forget");
  assert(!r.pending.isPending("orphan.pdf"), "candidate 清掉");
});
test("[reconcile] 去抖：grace 内第二次 → 仍不删（防单次网抖误删）", async () => {
  const r = rig({ graceMs: 1000 });
  await r.reconcile();
  r.tick(500);                  // 没到 grace
  const out = await r.reconcile();
  eq(out.demoted.length, 0, "grace 内不动手");
  eq(r.trashed.length, 0, "没 trash");
  assert(r.pending.isPending("orphan.pdf"), "candidate 还在");
});
test("[reconcile] 重现即自愈：candidate 后云端又出现 → 清 candidate、绝不删", async () => {
  const r = rig({ graceMs: 1000 });
  await r.reconcile();          // 标记 orphan
  assert(r.pending.isPending("orphan.pdf"), "先标了");
  r.setList({ files: [{ path: "live.pdf" }, { path: "orphan.pdf" }], folders: [], complete: true });  // orphan 重现
  r.tick(2000);                 // 就算跨了 grace
  const out = await r.reconcile();
  eq(out.demoted.length, 0, "重现 → 不删");
  assert(!r.pending.isPending("orphan.pdf"), "candidate 自愈清掉");
  eq(r.trashed.length, 0, "没 trash");
});
test("[reconcile] 编辑取消：candidate 后变 dirty → 清 candidate、当 ghost 处理（不删）", async () => {
  const r = rig({ graceMs: 1000 });
  await r.reconcile();          // 标记 orphan
  r.setDirty("orphan.pdf");     // grace 内被编辑
  r.tick(2000);
  const out = await r.reconcile();
  eq(out.demoted.length, 0, "dirty → 不删");
  assert(!r.pending.isPending("orphan.pdf"), "candidate 取消");
  eq(r.trashed.length, 0, "未推字节绝不动");
});
test("[reconcile] 离线 → 整个 no-op（不推进防抖）", async () => {
  const r = rig({ online: false });
  const out = await r.reconcile();
  eq(out.demoted.length, 0, "离线不收敛"); assert(!r.pending.isPending("orphan.pdf"), "离线不标 candidate");
});
test("[reconcile] partial 列表（complete=false）→ no-op（失败-fetch 守卫）", async () => {
  const r = rig(); r.setList({ files: [{ path: "live.pdf" }], folders: [], complete: false });
  const out = await r.reconcile();
  eq(out.demoted.length, 0, "partial 不收敛"); assert(!r.pending.isPending("orphan.pdf"), "partial 不标 candidate");
});
test("[reconcile] 空列表 → no-op（多半未登录/网抖）", async () => {
  const r = rig(); r.setList({ files: [], folders: [], complete: true });
  const out = await r.reconcile();
  eq(out.demoted.length, 0, "空列表不收敛");
});
test("[reconcile] listAll 抛错 → no-op", async () => {
  const r = rig(); r.setList("throw");
  const out = await r.reconcile();
  eq(out.demoted.length, 0, "list 失败不收敛");
});

test("[reconcile] activeFileName skip：打开的 clean cloud-gone doc 绝不被去抖 trash（K1，连自动 reconcile 也跳）", async () => {
  // 直接建带 activeFileName 的 reconcile：orphan.pdf 是活动 doc → 就算跨 grace 也不 trash。
  const trashed: string[] = [];
  const local = { appKeys: async () => ["orphan.pdf", "live.pdf"], trash: async (n: string) => { trashed.push(n); return `trash/${n}`; } };
  const head = { seenBase: (n: string) => (n === "orphan.pdf" ? "e" : "e"), isDirty: () => false, forget: () => {} };
  const cloud = { listAll: async () => ({ files: [{ path: "live.pdf" }], folders: [], complete: true }), clearState: () => {} };
  let clock = 0;
  const pending = createPendingGone(memKv(), 0);
  const { reconcile } = createReconcile({ cloud: cloud as any, local: local as any, head: head as any, pending, now: () => clock, isOnline: () => true, activeFileName: () => "orphan.pdf" });
  await reconcile();                 // 第一次
  clock += 10;
  const out = await reconcile();     // 第二次跨 grace
  eq(out.demoted.length, 0, "活动 doc 绝不 demote/trash");
  eq(trashed.length, 0, "没 trash 开着的 doc 本地缓存");
  assert(!pending.isPending("orphan.pdf"), "活动 doc 连 candidate 都不标（skip）");
});
