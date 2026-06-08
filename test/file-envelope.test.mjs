// 家族文件信封 codec 验收（meta comment ⇄ 对象）。zip 实际读写需浏览器（zip.js），这里只测纯 comment codec。
import { describe, it, eq } from "./runner.mjs";
import { buildMetaComment, parseMetaComment, readTailMeta, ENVELOPE_MAGIC, ENVELOPE_VERSION } from "../src/file-envelope.js";

const dec = (u) => new TextDecoder().decode(u);
const enc = (s) => new TextEncoder().encode(s);

// 造一个尾部缓冲：junk + EOCD(22B,含 commentLen) + comment。
function fakeTail(commentBytes, trailingJunk = 0) {
  const eocd = new Uint8Array(22 + commentBytes.length + trailingJunk);
  eocd[0] = 0x50; eocd[1] = 0x4b; eocd[2] = 0x05; eocd[3] = 0x06;          // PK\x05\x06
  eocd[20] = commentBytes.length & 0xff; eocd[21] = (commentBytes.length >> 8) & 0xff;
  eocd.set(commentBytes, 22);
  const junk = enc(".....fake zip body.....");
  const out = new Uint8Array(junk.length + eocd.length);
  out.set(junk, 0); out.set(eocd, junk.length);
  return out;
}

describe("file-envelope · meta comment 往返", () => {
  it("build → parse 还原 {g,v,e}", () => {
    const out = parseMetaComment(buildMetaComment({ g: "abc-123", v: ENVELOPE_VERSION, e: "v195" }));
    eq(out.g, "abc-123"); eq(out.v, ENVELOPE_VERSION); eq(out.e, "v195");
  });
  it("MAGIC 前缀", () => { eq(dec(buildMetaComment({ g: "x", v: 1, e: "v1" })).slice(0, 4), ENVELOPE_MAGIC); });
});

describe("file-envelope · parse robust（降级走 name，绝不抛）", () => {
  it("null / 空 → null", () => { eq(parseMetaComment(null), null); eq(parseMetaComment(new Uint8Array(0)), null); });
  it("无 MAGIC（老文件随便的 comment）→ null", () => eq(parseMetaComment(enc("just a zip comment")), null));
  it("MAGIC 对但 JSON 坏 → null", () => eq(parseMetaComment(enc(ENVELOPE_MAGIC + "{not json")), null));
  it("MAGIC + JSON 但无 g → null", () => eq(parseMetaComment(enc(ENVELOPE_MAGIC + JSON.stringify({ v: 1 }))), null));
});

describe("file-envelope · readTailMeta（尾部 byte-range 读身份，云端 reconcile）", () => {
  it("尾部缓冲含 EOCD comment → 还原 guid", () => {
    const out = readTailMeta(fakeTail(buildMetaComment({ g: "G9", v: ENVELOPE_VERSION, e: "v197" })));
    eq(out.g, "G9");
  });
  it("EOCD 但 comment 非本格式（老文件）→ null", () => eq(readTailMeta(fakeTail(enc("just a comment"))), null));
  it("无 EOCD 签名 → null", () => eq(readTailMeta(enc("not a zip at all, no eocd")), null));
  it("窗口没装全 comment（commentLen 超出缓冲）→ null，不抛", () => {
    const c = buildMetaComment({ g: "G", v: 1, e: "v1" });
    const t = fakeTail(c);
    eq(readTailMeta(t.subarray(0, t.length - 5)), null);   // 砍掉尾部 → comment 不完整
  });
  it("null / 空 → null", () => { eq(readTailMeta(null), null); eq(readTailMeta(new Uint8Array(0)), null); });
});
