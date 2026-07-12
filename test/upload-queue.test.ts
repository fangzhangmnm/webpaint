// upload-queue 深模块测试（ADR-0018）：离线新上传回线补推。policy(auto/ask/manual) + supersede + collision + offline + transient。
// 红线：只补推 never-synced；per-name serialize + 锁内 supersede 复检；没确认成功绝不出队（中途关 app 重试）。
import { test, eq } from "./runner.mjs";
import { createUploadReplay, type UploadReplayPolicy } from "../src/store/upload-queue.ts";

function memkv() { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); }, remove: (k: string) => { m.delete(k); } }; }

interface Opts {
  policy: UploadReplayPolicy;
  local?: string[]; dirty?: string[]; seen?: [string, string][];
  online?: boolean; collision?: string[]; fail?: string[];
  confirm?: (n: number) => Promise<boolean>;
}
function rig(o: Opts) {
  const kv = memkv();
  const localSet = new Set(o.local ?? []);
  const dirty = new Set(o.dirty ?? []);
  const seen = new Map<string, string>(o.seen ?? []);
  const pushed: string[] = [];
  const status: { phase: string; name?: string }[] = [];
  const pushLocal = async (name: string): Promise<{ status: string }> => {
    if (o.collision?.includes(name)) { const e = new Error("collision") as Error & { name: string }; e.name = "CloudNameCollisionError"; throw e; }
    if (o.fail?.includes(name)) throw new Error("net");
    pushed.push(name); dirty.delete(name); seen.set(name, "e");   // 模拟成功：清 dirty + 落 seen
    return { status: "pushed" };
  };
  const r = createUploadReplay({
    kv,
    local: { exists: async (n: string) => localSet.has(n) },
    head: { isDirty: (n: string) => dirty.has(n), seenBase: (n: string) => seen.get(n) ?? null },
    isOnline: () => o.online !== false,
    serialize: (_n: string, fn: () => Promise<unknown>) => fn() as Promise<any>,
    pushLocal,
    policy: o.policy, confirm: o.confirm, onStatus: (e) => status.push(e),
  });
  return { r, pushed, status };
}

test("[upload-queue] manual：enqueue no-op + drain 不做", async () => {
  const t = rig({ policy: "manual", local: ["a.pdf"], dirty: ["a.pdf"] });
  t.r.enqueue("a.pdf");
  eq(t.r.pending().length, 0, "manual 不入队");
  const d = await t.r.drain();
  eq(d.status, "manual", ""); eq(t.pushed.length, 0, "不推");
});

test("[upload-queue] auto happy：never-synced 入队 → drain 补推 → 出队", async () => {
  const t = rig({ policy: "auto", local: ["a.pdf"], dirty: ["a.pdf"] });
  t.r.enqueue("a.pdf");
  eq(t.r.pending().join(","), "a.pdf", "入队");
  const d = await t.r.drain();
  eq(t.pushed.join(","), "a.pdf", "推了 a"); eq(d.pushed, 1, "");
  eq(t.r.pending().length, 0, "推成功出队");
});

test("[upload-queue] ask 拒绝 → 不推、留队；同意 → 推", async () => {
  const no = rig({ policy: "ask", local: ["a.pdf"], dirty: ["a.pdf"], confirm: async () => false });
  no.r.enqueue("a.pdf");
  const d1 = await no.r.drain();
  eq(d1.status, "declined", ""); eq(no.pushed.length, 0, "拒绝不推"); eq(no.r.pending().length, 1, "留队");
  const yes = rig({ policy: "ask", local: ["a.pdf"], dirty: ["a.pdf"], confirm: async () => true });
  yes.r.enqueue("a.pdf");
  await yes.r.drain();
  eq(yes.pushed.join(","), "a.pdf", "同意推");
});

test("[upload-queue] supersede：文件已删（local 无）→ 出队不推", async () => {
  const t = rig({ policy: "auto", local: [], dirty: ["a.pdf"] });   // 队列有 a 但本地已无
  t.r.enqueue("a.pdf");
  await t.r.drain();
  eq(t.pushed.length, 0, "已删不推"); eq(t.r.pending().length, 0, "出队");
});

test("[upload-queue] supersede：已同步（seenBase≠null）→ 出队不推", async () => {
  const t = rig({ policy: "auto", local: ["a.pdf"], dirty: [], seen: [["a.pdf", "e1"]] });
  t.r.enqueue("a.pdf");
  await t.r.drain();
  eq(t.pushed.length, 0, "已同步不重推"); eq(t.r.pending().length, 0, "出队");
});

test("[upload-queue] collision：同名异文件 → surface + 出队（重试无用）", async () => {
  const t = rig({ policy: "auto", local: ["a.pdf"], dirty: ["a.pdf"], collision: ["a.pdf"] });
  t.r.enqueue("a.pdf");
  const d = await t.r.drain();
  eq(d.pushed, 0, "没推成"); eq(t.r.pending().length, 0, "collision 出队");
  eq(t.status.some((s) => s.phase === "collision" && s.name === "a.pdf"), true, "surface collision");
});

test("[upload-queue] transient 失败 → 留队重试；离线 → 不动", async () => {
  const t = rig({ policy: "auto", local: ["a.pdf", "b.pdf"], dirty: ["a.pdf", "b.pdf"], fail: ["a.pdf"] });
  t.r.enqueue("a.pdf"); t.r.enqueue("b.pdf");
  const d = await t.r.drain();
  eq(t.pushed.join(","), "b.pdf", "b 推成"); eq(d.pushed, 1, "");
  eq(t.r.pending().join(","), "a.pdf", "a transient 留队");
  const off = rig({ policy: "auto", local: ["a.pdf"], dirty: ["a.pdf"], online: false });
  off.r.enqueue("a.pdf");
  const d2 = await off.r.drain();
  eq(d2.status, "offline", ""); eq(off.pushed.length, 0, "离线不推"); eq(off.r.pending().length, 1, "留队");
});

test("[upload-queue] remove：删入队项", async () => {
  const t = rig({ policy: "auto", local: ["a.pdf"], dirty: ["a.pdf"] });
  t.r.enqueue("a.pdf"); t.r.remove("a.pdf");
  eq(t.r.pending().length, 0, "removed");
});
