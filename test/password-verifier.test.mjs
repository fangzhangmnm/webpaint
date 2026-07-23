// 图库密码验证器 sentinel（v0.4.11，真机 2.3）：密码学核心纯函数（node WebCrypto 真跑）。
import { describe, it, assert, eq } from "./runner.mjs";
const { createVerifierRecord, verifyRecord } = await import("../src/password-verifier.ts");

describe("password-verifier · sentinel 核心", () => {
  it("往返：对的密码 ok / 错的密码拒绝（GCM tag 验证）", async () => {
    const rec = await createVerifierRecord("正确密码123");
    eq(rec.v, 1);
    assert(await verifyRecord(rec, "正确密码123"), "对的密码通过");
    assert(!(await verifyRecord(rec, "错的密码")), "错的密码拒绝");
    assert(!(await verifyRecord(rec, "")), "空密码拒绝");
  });
  it("记录不含明文/密码派生可逆物（只有 salt/iv/密文）", async () => {
    const rec = await createVerifierRecord("s3cret");
    eq(Object.keys(rec).sort().join(","), "ct,iv,salt,v");
    assert(!JSON.stringify(rec).includes("s3cret"), "序列化不含密码");
  });
  it("两次创建 salt/iv 不同（随机化）", async () => {
    const a = await createVerifierRecord("x"), b = await createVerifierRecord("x");
    assert(a.salt !== b.salt && a.iv !== b.iv);
    assert(await verifyRecord(a, "x") && await verifyRecord(b, "x"));
  });
  it("篡改密文 → 拒绝", async () => {
    const rec = await createVerifierRecord("pw");
    const bad = { ...rec, ct: rec.ct.slice(0, -4) + (rec.ct.endsWith("AAAA") ? "BBBB" : "AAAA") };
    assert(!(await verifyRecord(bad, "pw")));
  });
});
