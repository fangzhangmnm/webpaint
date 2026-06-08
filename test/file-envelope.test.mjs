// 家族文件信封 codec 验收（meta comment ⇄ 对象）。zip 实际读写需浏览器（zip.js），这里只测纯 comment codec。
import { describe, it, eq } from "./runner.mjs";
import { buildMetaComment, parseMetaComment, ENVELOPE_MAGIC, ENVELOPE_VERSION } from "../src/file-envelope.js";

const dec = (u) => new TextDecoder().decode(u);
const enc = (s) => new TextEncoder().encode(s);

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
