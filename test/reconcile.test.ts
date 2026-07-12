// reconcile 深模块测试：cloud-gone 安全收敛。纯分类器穷举 + 编排守卫（离线/partial/空/抛错→no-op）。
// 红线：只降 clean 孤儿（清两轨 etag、blob 不动）；dirty/从没synced/在云端/非权威 一律不动；绝不删/trash。
import { test, eq } from "./runner.mjs";
import { classifyCloudGone, createReconcile } from "../src/store/reconcile.ts";

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

// ── 编排（守卫 + demote 动作）──
function rig(opts: { online?: boolean } = {}) {
  const local = { appKeys: async () => ["orphan.pdf", "live.pdf", "localfile.pdf", "dirty.pdf"] };
  const seen = new Map<string, string>([["orphan.pdf", "e"], ["live.pdf", "e"], ["dirty.pdf", "e"]]);  // localfile.pdf 从没 synced
  const dirty = new Set(["dirty.pdf"]);
  const cleared: string[] = [], forgotten: string[] = [];
  const head = { seenBase: (n: string) => (seen.has(n) ? seen.get(n)! : null), isDirty: (n: string) => dirty.has(n), forget: (n: string) => forgotten.push(n) };
  let listResult: { files: { path: string }[]; folders: string[]; complete: boolean } | "throw" = { files: [{ path: "live.pdf" }], folders: [], complete: true };
  const cloud = { listAll: async () => { if (listResult === "throw") throw new Error("x"); return listResult; }, clearState: (n: string) => { cleared.push(n); } };
  const { reconcile } = createReconcile({ cloud: cloud as any, local: local as any, head: head as any, isOnline: () => opts.online !== false });
  return { reconcile, cleared, forgotten, setList: (l: typeof listResult) => { listResult = l; } };
}

test("[reconcile] happy：clean 孤儿 demote（清两轨 etag、blob 不动）", async () => {
  const r = rig();
  const out = await r.reconcile();
  eq(out.demoted.join(","), "orphan.pdf", "只降 orphan（live 在云端 / localfile 无 seenBase / dirty 留）");
  eq(r.cleared.join(","), "orphan.pdf", "cloud.clearState 调过");
  eq(r.forgotten.join(","), "orphan.pdf", "head.forget 调过");
});
test("[reconcile] 离线 → 整个 no-op", async () => {
  const r = rig({ online: false });
  const out = await r.reconcile();
  eq(out.demoted.length, 0, "离线不收敛"); eq(r.forgotten.length, 0, "没动谱系");
});
test("[reconcile] partial 列表（complete=false）→ no-op（失败-fetch 守卫）", async () => {
  const r = rig(); r.setList({ files: [{ path: "live.pdf" }], folders: [], complete: false });
  const out = await r.reconcile();
  eq(out.demoted.length, 0, "partial 不收敛（缺失≠云端真没了）");
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
