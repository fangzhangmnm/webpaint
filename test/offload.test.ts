// offload 深模块对抗测试：合法(clean∧在线∧曾synced(seenBase!=null)∧云端有完整(size>0))→hardDelete；
// 非法(dirty/离线/local-only/cloud-gone/0B incomplete)→抛 OffloadIllegalError，绝不静默丢字节。cloudMoved+clean 仍合法。
import { test, eq, assert } from "./runner.mjs";
import { createOffload, OffloadIllegalError } from "../src/store/offload.ts";

function setup(opts: { online?: boolean } = {}) {
  const localSet = new Set<string>();
  const cloudMeta = new Map<string, { etag: string; size: number }>();   // name → 云端 meta（缺 = cloud-gone）
  const dirtySet = new Set<string>();
  const baseEtag = new Map<string, string>();                            // seenBase（缺 = 从没 synced = local-only）
  const forgotten: string[] = [];
  const off = createOffload({
    cloud: { fetchMeta: async (n: string) => { const m = cloudMeta.get(n); return m ? ({ etag: m.etag, lastModified: 0, size: m.size, item: {} as any }) : null; } },
    local: { exists: async (n: string) => localSet.has(n), hardDelete: async (n: string) => { localSet.delete(n); } },
    head: { isDirty: (n: string) => dirtySet.has(n), isDirtyAnywhere: (n: string) => dirtySet.has(n), seenBase: (n: string) => baseEtag.has(n) ? baseEtag.get(n)! : null, forget: (n: string) => { forgotten.push(n); } },
    isOnline: () => opts.online !== false,
  });
  return { off, localSet, cloudMeta, dirtySet, baseEtag, forgotten };
}

// 一个「已 synced 的本地 shadow」（合法 offload 目标）
function synced(s: ReturnType<typeof setup>, name: string, etag = "e", size = 10) {
  s.localSet.add(name); s.baseEtag.set(name, etag); s.cloudMeta.set(name, { etag, size });
}

async function rejects(fn: () => Promise<unknown>, reason: string, msg: string) {
  try { await fn(); assert(false, msg + "（应抛错却没抛）"); }
  catch (e) { assert(e instanceof OffloadIllegalError, msg + "（OffloadIllegalError 类型）"); eq((e as OffloadIllegalError).reason, reason, msg); }
}

test("[offload] 合法 shadow（clean∧在线∧曾synced∧云端有完整）→ hardDelete", async () => {
  const s = setup(); synced(s, "a.pdf");
  await s.off.offload("a.pdf");
  assert(!s.localSet.has("a.pdf"), "本地已删"); eq(s.forgotten[0], "a.pdf", "谱系已清");
});

test("[offload] cloudMoved（云端 etag≠seenBase 但有完整版）仍合法", async () => {
  const s = setup(); synced(s, "a.pdf", "e1"); s.cloudMeta.set("a.pdf", { etag: "e2", size: 20 });  // 云端被别人推新版
  await s.off.offload("a.pdf");
  assert(!s.localSet.has("a.pdf"), "cloudMoved+clean → 仍移除（重取拿更新版）");
});

test("[offload] dirty → 抛（未推唯一字节）", async () => {
  const s = setup(); synced(s, "a.pdf"); s.dirtySet.add("a.pdf");
  await rejects(() => s.off.offload("a.pdf"), "dirty", "dirty 拒");
  assert(s.localSet.has("a.pdf"), "本地还在");
});

test("[offload] 离线 → 抛（不可重取）", async () => {
  const s = setup({ online: false }); synced(s, "a.pdf");
  await rejects(() => s.off.offload("a.pdf"), "offline", "离线 拒");
  assert(s.localSet.has("a.pdf"), "本地还在");
});

test("[offload] local-only（从没 synced，无 seenBase）→ 抛（世界唯一，防误删同名云端 sibling 下的本地）", async () => {
  const s = setup(); s.localSet.add("a.pdf"); s.cloudMeta.set("a.pdf", { etag: "x", size: 9 });  // 有同名云端 sibling 但本地从没 synced
  await rejects(() => s.off.offload("a.pdf"), "local-only", "local-only 拒");
  assert(s.localSet.has("a.pdf"), "本地还在");
});

test("[offload] cloud-gone（曾synced 但云端没了）→ 抛（唯一好副本）", async () => {
  const s = setup(); s.localSet.add("a.pdf"); s.baseEtag.set("a.pdf", "e");  // 曾synced，但 cloudMeta 不加
  await rejects(() => s.off.offload("a.pdf"), "cloud-gone", "cloud-gone 拒");
  assert(s.localSet.has("a.pdf"), "本地还在");
});

test("[offload] 云端 0B incomplete → 抛（不可信，绝不据此丢本地）", async () => {
  const s = setup(); synced(s, "a.pdf", "e", 0);  // 云端 size=0 幻象
  await rejects(() => s.off.offload("a.pdf"), "incomplete", "0B 拒");
  assert(s.localSet.has("a.pdf"), "本地还在");
});

test("[offload] TOCTOU：fetchMeta 网络期内并发 save 标脏 → re-check 拒，绝不 hardDelete 未推字节（C2 红线，对齐 freshness.ts:87）", async () => {
  const localSet = new Set<string>(["a.pdf"]);
  const dirtySet = new Set<string>();
  const off = createOffload({
    // fetchMeta 在 await 中把文件标脏 = 模拟并发 file.save 的 recordEdit 落在 offload 的网络窗口内。
    cloud: { fetchMeta: async (_n: string) => { dirtySet.add("a.pdf"); return { etag: "e", lastModified: 0, size: 10, item: {} as any }; } },
    local: { exists: async (n: string) => localSet.has(n), hardDelete: async (n: string) => { localSet.delete(n); } },
    head: { isDirty: (n: string) => dirtySet.has(n), isDirtyAnywhere: (n: string) => dirtySet.has(n), seenBase: () => "e", forget: () => {} },
    isOnline: () => true,
  });
  await rejects(() => off.offload("a.pdf"), "dirty", "fetchMeta 后 re-check 抓到并发标脏");
  assert(localSet.has("a.pdf"), "未推字节还在（re-check 拒在 hardDelete 之前，绝没丢）");
});

test("[offload] 未缓存 → no-op（无事可做，不抛）", async () => {
  const s = setup();
  await s.off.offload("a.pdf");  // 不抛
  assert(true, "no-op 不抛");
});
