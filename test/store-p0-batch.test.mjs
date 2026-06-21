// cloud-sync P0 批次（审计 2026-06-09 后续）：N5 / N7 / N8 回归。
import { describe, it, assert, eq } from "./runner.mjs";
import { createStore } from "../src/store/store.ts";
import { createCloudSync } from "../src/store/cloud-sync.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { memKv } from "../src/store/cloud-sync.ts";

const bytes = (s) => new TextEncoder().encode(s);

function mk() {
  const provider = createMockProvider();
  let t = 1000;
  const cloud = createCloudSync({
    provider, kv: memKv(), fileName: (n) => n + ".ora",
    contentType: "application/zip", appKey: "wp", now: () => ++t,
  });
  const local = createMockLocal();
  const store = createStore({ cloud, local, kv: memKv(), backoffMs: 1 });
  return { provider, cloud, local, store };
}
async function seedSynced(env, name, body) {
  await env.local.save(name, bytes(body));
  const { item } = await env.cloud.push(name, bytes(body));
  env.store.adoptBase(name, item.eTag);
  return item;
}

describe("cloud-sync P0 · N5 删 dirty 文件 → 本地降级 local-only（不丢未推字节）", () => {
  it("两端都有但本地 dirty → 云端进 .trash、本地留在目录、解绑云端态", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    env.cloud.setDirty("猫", true);                                  // 本地有未推改动
    const res = await env.store.flow.delete("猫", { isOnline: () => true });
    eq(await env.provider.getItemByPath("猫.ora"), null, "云端原位删了（进 .trash）");
    eq(await env.local.exists("猫"), true, "本地未推字节留在目录里（不 hardDelete、不藏 backup）");
    eq(env.cloud.getETag("猫"), null, "已解绑云端 etag → local-only");
    eq(res.status, "demoted-local-only", "回报降级 local-only");
  });
  it("对照：两端都有且 clean → 仍连本地一起删（不留双份）", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");                              // clean
    const res = await env.store.flow.delete("猫", { isOnline: () => true });
    eq(await env.local.exists("猫"), false, "clean → 本地也删（云端 .trash 已救着）");
    eq(res.status, "trashed");
  });
});

describe("cloud-sync P0 · N8 restore 采纳云 etag（不对自己文件弹假 collision）", () => {
  it("从云回收站恢复 → 采纳恢复 item 的 etag", async () => {
    const env = mk();
    await env.cloud.push("猫", bytes("v1"));
    const trashed = await env.cloud.trash("猫");                    // 进 .trash，拿 item id
    env.cloud.clearState("猫");                                     // 删后清态：getETag → null
    eq(env.cloud.getETag("猫"), null, "删后无 etag");
    const res = await env.store.flow.restore({ fromCloud: true, cloudItemId: trashed.id, targetName: "猫" });
    eq(res.status, "restored");
    assert(env.cloud.getETag("猫"), "N8：restore 采纳云 item 的 etag → 之后 push 有 base，不弹假 NameCollision");
  });
});

describe("cloud-sync P0 · N7 dirty-rename 旧云 .trash 失败不静默吞", () => {
  it("旧名 .trash 失败 → 回报 oldCloudOrphan（不静默成孤儿）", async () => {
    const env = mk();
    await seedSynced(env, "猫", "v1");
    env.cloud.setDirty("猫", true);                                 // dirty → push 新名 + trash 旧名
    env.provider.injectFault({ op: "move", kind: "error", status: 500, times: 1 });   // trash(旧名) 的 move 失败
    const res = await env.store.flow.rename("猫", "狗", { encode: () => bytes("v2") });
    eq(res.oldCloudOrphan, true, "旧云 .trash 失败被回报（不静默吞 → A9 不复发）");
  });
});
