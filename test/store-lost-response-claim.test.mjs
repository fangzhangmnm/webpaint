// N6（审计 2026-06-09，risky·全场唯一静默丢失路径）回归：
//   lost-response / 409 兜底「认领云端 item 为我方成功 push」**只按 size 相等**判定 →
//   同名、同字节数、异内容的文件会被静默认作我方 push（etag 落位、dirty 清零）→ 本地字节永不 push = 静默丢失。
//   修法（Option B，tail-bytes compare）：size 相等后再比**尾部字节**（zip/ora 尾 = central dir + CRC + EOCD，
//        近似内容指纹）。只在罕见 lost-response/409 窗口对单个在推文件拉一次小 byte-range（非图库遍历）。
//        三态：match→认；differ→不认（无 base 抛 CloudNameCollisionError）；unknown（拉尾失败）→保持 dirty 重试。
import { describe, it, assert, eq } from "./runner.mjs";
import { createCloudSync } from "../src/store/cloud-sync.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { memKv } from "../src/store/cloud-sync.ts";

const bytes = (s) => new TextEncoder().encode(s);
const u8txt = (u) => new TextDecoder().decode(new Uint8Array(u));
// download 回 Blob/ArrayBuffer/Uint8Array 都吃（同 store-flow.test 的 txt）。
const rdtxt = async (b) => new TextDecoder().decode(new Uint8Array(b.arrayBuffer ? await b.arrayBuffer() : b));

function mk() {
  const provider = createMockProvider();
  let t = 1000;
  const cloud = createCloudSync({
    provider, kv: memKv(), fileName: (n) => n + ".ora",
    contentType: "application/zip", appKey: "wp", now: () => ++t,
  });
  return { provider, cloud };
}

describe("cloud-sync.push — N6 认领尾部校验（防同名同大小异内容静默丢失）", () => {
  it("同名·同字节数·异内容 → 尾部不符 → 不认作我方 push（抛 collision，本地保持 dirty 不丢）", async () => {
    const env = mk();
    // 另一设备 / 旧版：云端已有同名、**同字节数、异内容**文件（尾部不同）。程序化构造保证等长。
    const OTHER = "PK" + "A".repeat(64);
    const MINE = "PK" + "B".repeat(64);
    assert(bytes(OTHER).length === bytes(MINE).length, "前提：构造同字节数");
    assert(OTHER !== MINE, "前提：内容不同（尾部不同）");
    await env.provider.upload("猫.ora", bytes(OTHER), { conflictBehavior: "replace" });

    // 我方 push（无 baseEtag → conflictBehavior:"fail" → 409 → 走认领核验路径）
    let threw = null;
    try { await env.cloud.push("猫", bytes(MINE)); } catch (e) { threw = e; }

    assert(threw && threw.name === "CloudNameCollisionError",
      "同名同大小异内容 → CloudNameCollisionError，绝不静默把别人的文件认作我方 push");
    const cloudNow = await rdtxt(await env.provider.download((await env.provider.getItemByPath("猫.ora")).id));
    eq(cloudNow, OTHER, "云端没被覆盖（path-身份红线）");
    eq(env.cloud.isDirty("猫"), true, "我方字节保持 dirty（下次改名/重推，不静默丢失）");
  });

  it("同名·同字节数·同内容 → 尾部相符 → 认作我方成功 push（lost-response 幂等正确恢复）", async () => {
    const env = mk();
    const MINE = "PK" + "C".repeat(40);
    // 模拟「我方上次 push 已落盘但回执丢」：云端现存 = 我方完全相同字节
    await env.provider.upload("猫.ora", bytes(MINE), { conflictBehavior: "replace" });
    const res = await env.cloud.push("猫", bytes(MINE));   // 无 base → 409 → 认领核验 → 尾相符 → 认
    assert(res.item && res.item.eTag, "尾相符 → 认作我方 push（采纳云端 etag）");
    eq(env.cloud.isDirty("猫"), false, "已确认我方版本 → 干净（lost-response 不留假 dirty）");
  });
});
