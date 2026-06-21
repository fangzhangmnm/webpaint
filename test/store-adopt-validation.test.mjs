// N2（审计 2026-06-09，risky·贴红线 MASTER 第5行）回归：
//   clean fast-forward 用拉下来的云字节覆盖本地**必须先校验是真容器**。
//   坏云副本 / captive-portal 的 200-HTML body 绝不能覆盖唯一一份好本地副本（clean ⇒ 无 backup）。
//   修法：createStore 注入 validateAdopt(blob) hook（store 格式盲，校验逻辑由 app 提供——zip/enc 容器），
//        _safePull 采纳前调用；返回 false → 不覆盖本地、open 报 reason="invalid-cloud-bytes"。
// 真 store.ts + 真 cloud-sync.ts 跑在 MockCloudProvider + MockLocal 上。
import { describe, it, assert, eq } from "./runner.mjs";
import { createStore } from "../src/store/store.ts";
import { createCloudSync } from "../src/store/cloud-sync.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { memKv } from "../src/store/cloud-sync.ts";

const bytes = (s) => new TextEncoder().encode(s);
const u8txt = (u) => new TextDecoder().decode(u);
// app 侧真实会用的容器校验：ora=zip(PK\x03\x04) 或加密容器（这里测 hook 机制，用 zip magic 足够）。
const zipMagic = async (blob) => {
  const h = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return h[0] === 0x50 && h[1] === 0x4B && h[2] === 0x03 && h[3] === 0x04;   // "PK\x03\x04"
};

function mk({ validateAdopt } = {}) {
  const provider = createMockProvider();
  let t = 1000;
  const cloud = createCloudSync({
    provider, kv: memKv(), fileName: (n) => n + ".ora",
    contentType: "application/zip", appKey: "wp", now: () => ++t,
  });
  const local = createMockLocal();
  const store = createStore({ cloud, local, kv: memKv(), backoffMs: 1, validateAdopt });
  return { provider, cloud, local, store };
}
async function seedSynced(env, name, body) {
  await env.local.save(name, bytes(body));
  const { item } = await env.cloud.push(name, bytes(body));
  env.store.adoptBase(name, item.eTag);
  return item;
}

describe("Store.flow.open — N2 采纳字节有效性校验", () => {
  it("clean FF 拒绝非容器云字节（captive-portal 200-HTML 不覆盖好本地）", async () => {
    const env = mk({ validateAdopt: zipMagic });
    const GOOD = "PKora-good-local";              // 合法 zip-ish（PK magic）
    await seedSynced(env, "猫", GOOD);
    // 另一设备 / captive-portal 把云端同名内容换成 HTML（etag 变新 → 看着像「云端有新版」）
    await env.provider.upload("猫.ora", bytes("<html>captive portal login</html>"), { conflictBehavior: "replace" });

    const res = await env.store.flow.open("猫", { localDirty: () => false });

    eq(res.source, "local", "拒绝采纳坏字节 → 不 fast-forward，停在本地");
    eq(res.reason, "invalid-cloud-bytes", "open 报无效云字节原因");
    eq(u8txt(await env.local.get("猫")), GOOD, "好本地字节没被 HTML 覆盖（N2 数据丢失防护）");
    eq(env.cloud.isDirty("猫"), false, "未误标 dirty（没采纳就不动 dirty/etag）");
  });

  it("clean FF 仍正常采纳合法容器云字节（hook 不误伤真文件）", async () => {
    const env = mk({ validateAdopt: zipMagic });
    await seedSynced(env, "猫", "PKora-v1");
    // 云端被合法更新（仍是 zip）
    await env.provider.upload("猫.ora", bytes("PKora-v2-newer"), { conflictBehavior: "replace" });
    const res = await env.store.flow.open("猫", { localDirty: () => false });
    eq(res.source, "fast-forwarded", "合法容器 → 正常快进");
    eq(u8txt(await env.local.get("猫")), "PKora-v2-newer", "本地采纳了云端新版");
  });

  it("无 validateAdopt（canonical / 非 WebPaint）→ 行为不变（不校验，照常快进）", async () => {
    const env = mk();   // 不注入 hook
    await seedSynced(env, "猫", "v1");
    await env.provider.upload("猫.ora", bytes("v2-newer"), { conflictBehavior: "replace" });
    const res = await env.store.flow.open("猫", { localDirty: () => false });
    eq(res.source, "fast-forwarded", "无 hook → 不校验，照旧快进（store 仍格式盲）");
    eq(u8txt(await env.local.get("猫")), "v2-newer");
  });
});
