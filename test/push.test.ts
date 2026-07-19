import { test, eq, assert } from "./runner.mjs";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createLocalHead, BypassError } from "../src/store/local-head.ts";
import { createSafeResolve } from "../src/store/safe-resolve.ts";
import { createSubstrate } from "../src/store/substrate.ts";
import { createPush } from "../src/store/push.ts";
import { createOffload } from "../src/store/offload.ts";

const enc = (s: string) => new TextEncoder().encode(s);
async function asStr(x: unknown): Promise<string | null> {
  if (x == null) return null;
  if (x instanceof Uint8Array) return new TextDecoder().decode(x);
  if (x instanceof Blob) return await x.text();
  return new TextDecoder().decode(new Uint8Array(x as ArrayBuffer));
}
const sealPass = { sealForWrite: async (_n: string, b: Uint8Array) => b, isContainer: async () => false };

function rig() {
  const provider = createMockProvider();
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  const local = createMockLocal();
  const headKv = memKv();
  const head = createLocalHead({ kv: headKv, getCloudEtag: (n: string) => cloud.getETag(n) });
  const safeResolve = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  const sub = createSubstrate();
  let ver = 0;
  const { push } = createPush({ cloud, head, seal: sealPass, safeResolve, serialize: sub.serialize, editVersion: () => ver });
  return { cloud, local, head, headKv, push, bump: () => ++ver };
}

test("happy push 新文件 → cloud 收字节 + 推后干净", async () => {
  const { cloud, head, push } = rig();
  head.recordEdit("f");
  const r = await push("f", { encode: () => enc("NEW") });
  eq(r.status, "pushed", "pushed");
  assert(!head.isDirty("f"), "推后干净");
  eq(await asStr((await cloud.pull("f"))?.blob), "NEW", "云端有 NEW");
});

test("bypass → push 抛 BypassError（dirty 绕过 recordEdit + base 已知）", async () => {
  const { head, headKv, push } = rig();
  head.markSeen("f", "v1");
  headKv.set("head.dirty:f", "1");                 // ★绕过 recordEdit 标脏
  let threw = false;
  try { await push("f", { encode: () => enc("X") }); } catch (e) { threw = e instanceof BypassError; }
  assert(threw, "bypass → 拒推");
});

test("真分叉 + onConflict=cancel → cancelled + 仍 dirty", async () => {
  const { cloud, head, push } = rig();
  await cloud.push("f", enc("V1"));                // 云端 V1@E1
  head.markSeen("f", "STALE"); head.recordEdit("f");   // parent=STALE（陈旧）
  const r = await push("f", { encode: () => enc("MINE"), onConflict: () => "cancel" });
  eq(r.status, "cancelled", "cancel 派发");
  assert(head.isDirty("f"), "cancel 后留 dirty");
  eq(await asStr((await cloud.pull("f"))?.blob), "V1", "云端没被覆盖");
});

test("lost-response 自愈 → healed + 干净（云端==本地推的）", async () => {
  const { cloud, head, push } = rig();
  await cloud.push("f", enc("SAME"));              // 云端已有 SAME（视作丢响应的那次写）
  head.markSeen("f", "STALE"); head.recordEdit("f");
  const r = await push("f", { encode: () => enc("SAME") });   // If-Match=STALE → 412 → heal
  eq(r.status, "healed", "自愈");
  assert(!head.isDirty("f"), "自愈后干净");
});

// ── F0 红线：cloud.push 返 {item:null}（有 baseEtag，落地**未确认**）────────────────────────
//   旧行为：onPushed(null,false) 清 dirty + 报 "pushed" → 未推字节被 offload 合法驱逐（MASTER §A 失守）+ UI 谎报「已同步」。
//   现行为：不调 onPushed、报 "deferred"、dirty 保住、offload 拒绝驱逐。
function rigNullItem() {
  const local = createMockLocal();
  const headKv = memKv();
  const head = createLocalHead({ kv: headKv, getCloudEtag: () => null });
  const sub = createSubstrate();
  // provider 违约：resolve 了但不带 item（分块响应 / 代理吞 body）
  const cloud = { push: async () => ({ item: null }) };
  const safeResolve = { tryHeal: async () => false, resolveConflict: async () => ({ status: "cancelled" as const }) };
  const { push } = createPush({ cloud: cloud as never, head, seal: sealPass, safeResolve: safeResolve as never, serialize: sub.serialize, editVersion: () => 0 });
  return { local, head, push };
}

test("[F0] push 收到 {item:null} → deferred + 保 dirty（绝不报 pushed）", async () => {
  const { head, push } = rigNullItem();
  head.markSeen("f", "e1");     // 曾 synced（有 baseEtag）
  head.recordEdit("f");
  const r = await push("f", { encode: () => enc("EDIT") });
  eq(r.status, "deferred", "落地未确认 → deferred，不得是 pushed");
  eq(r.dirtyAfter, true, "dirtyAfter=true（仍算未推）");
  assert(head.isDirty("f"), "★dirty 必须保住——清了就会被 offload 吃掉");
});

test("[F0] 承接：deferred 之后 offload 拒绝驱逐（reason=dirty）", async () => {
  const { local, head, push } = rigNullItem();
  await local.save("f", enc("EDIT"));
  head.markSeen("f", "e1"); head.recordEdit("f");
  await push("f", { encode: () => enc("EDIT") });          // → deferred，dirty 留着
  const off = createOffload({
    cloud: { fetchMeta: async () => ({ etag: "e1", lastModified: 0, size: 10, item: {} as never }) },
    local: { exists: (n: string) => local.exists(n), hardDelete: async (n: string) => { await local.hardDelete(n); } },
    head: { isDirty: (n: string) => head.isDirty(n), seenBase: (n: string) => head.seenBase(n), forget: (n: string) => head.forget(n) },
    isOnline: () => true,
  });
  let reason = "";
  try { await off.offload("f"); } catch (e) { reason = (e as { reason?: string }).reason ?? ""; }
  eq(reason, "dirty", "未确认落地的字节绝不驱逐");
  assert(await local.exists("f"), "★字节还在（F0 的真实损失就是这里丢字节）");
});

test("[F0] 护栏：onPushed(null etag, dirtyAfter=false) 必须 throw", () => {
  const head = createLocalHead({ kv: memKv(), getCloudEtag: () => null });
  let threw = false;
  try { head.onPushed("f", null, false); } catch { threw = true; }
  assert(threw, "不可表示的状态要响亮拦住，不能自愈成错误结果");
});

// ── 谱系断裂撞名的两条相反去向（v432）──────────────────────────────────────────────────────
//   同一个 CloudNameCollisionError，真·新建该抛（§A：两设备各建同名不同物，both kept），
//   编辑既有文件该 surface（本地云端都有、只是本机不知道派生自哪版；抛错=假原因+死路+自我延续）。
test("谱系断裂撞名 · 默认（真·新建）→ 仍抛 collision，云端不被覆盖", async () => {
  const { cloud, head, push } = rig();
  await cloud.push("f", enc("SOMEONE-ELSE"));
  cloud.setETag("f", null);                       // 无 base
  head.recordEdit("f");
  let name = null;
  try { await push("f", { encode: () => enc("MINE") }); } catch (e) { name = (e as { name?: string }).name; }
  eq(name, "CloudNameCollisionError", "默认行为不变（首存护栏是对的，别一起改掉）");
  eq(await asStr((await cloud.pull("f"))?.blob), "SOMEONE-ELSE", "云端没被覆盖");
});

test("★ 谱系断裂撞名 · surfaceCollision → 走冲突面；选覆盖则云端 loser 进 .backup（never-lose）", async () => {
  const { cloud, head, push } = rig();
  await cloud.push("f", enc("CLOUD-VER"));
  cloud.setETag("f", null);
  head.recordEdit("f");
  let asked = 0;
  const r = await push("f", { encode: () => enc("MINE"), surfaceCollision: true, onConflict: () => { asked++; return "keepMine"; } });
  eq(asked, 1, "弹冲突面（而不是抛一个假原因的 collision 把用户堵死）");
  eq(r.resolution, "keepMine", "用户选了以我的为准");
  eq(await asStr((await cloud.pull("f"))?.blob), "MINE", "本地版上去了 → 打破「永远推不上去」的自我延续");
  assert(r.backedUp, "云端旧版进了 .backup（§A：永不 hard-override）");
});

test("谱系断裂撞名 · surfaceCollision + 用户取消 → 云端不动、本地仍 dirty（工作没丢）", async () => {
  const { cloud, head, push } = rig();
  await cloud.push("f", enc("CLOUD-VER"));
  cloud.setETag("f", null);
  head.recordEdit("f");
  const r = await push("f", { encode: () => enc("MINE"), surfaceCollision: true, onConflict: () => "cancel" });
  eq(r.status, "cancelled", "取消");
  eq(await asStr((await cloud.pull("f"))?.blob), "CLOUD-VER", "云端原样");
  assert(head.isDirty("f"), "本地保持 dirty（字节没丢，下次还能再推）");
});
