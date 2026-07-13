// store `zip-peek` 深模块纯逻辑（2026-07-13 从 app cloud-thumbs.ts 下沉）。
//   硬扫末尾 PNG（isPng / scanPngFromEnd）+ 尾内 CD fallback（zipEntryPngFromTail，真 STORE zip）。
import { describe, it, assert, eq } from "./runner.mjs";
import { isPng, scanPngFromEnd, zipEntryPngFromTail } from "../src/store/zip-peek.ts";

// 最小 PNG：SIG + IHDR_HEAD + 填充 + IEND_TAIL。scanPngFromEnd 只需 sig→IHDR→IEND 结构。
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const concat = (...arrs) => { const n = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(n); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
const bytesEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

describe("zip-peek › isPng", () => {
  it("真 PNG sig → true", () => { assert(isPng(PNG)); });
  it("非 PNG → false", () => { assert(!isPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))); });
  it("过短 → false", () => { assert(!isPng(new Uint8Array([0x89, 0x50]))); });
});

describe("zip-peek › scanPngFromEnd", () => {
  it("末尾 PNG → 精确切出", () => {
    const buf = concat(new TextEncoder().encode("garbage prefix"), PNG).buffer;
    const out = scanPngFromEnd(buf);
    assert(!!out && bytesEq(out, PNG), "切出的应正好是那段 PNG");
  });
  it("PNG 后还有尾字节 → 仍从末尾找到（IEND 终止）", () => {
    const buf = concat(new Uint8Array([9, 9]), PNG, new Uint8Array([7, 7, 7])).buffer;
    const out = scanPngFromEnd(buf);
    assert(!!out && bytesEq(out, PNG), "IEND 终止，不吞后续尾字节");
  });
  it("无 PNG → null", () => { eq(scanPngFromEnd(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).buffer), null); });
  it("有 sig+IHDR 但缺 IEND → null（不完整，让 fallback 接手）", () => {
    const buf = concat(PNG.slice(0, 20)).buffer;   // sig+IHDR+部分，无 IEND
    eq(scanPngFromEnd(buf), null);
  });
});

// ── 手搓 STORE zip（method=0）：[local header + name + data]* + [CD]* + EOCD ──
function buildStoreZip(entries) {
  const enc = new TextEncoder();
  const locals = [];
  const cds = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const lh = new Uint8Array(30 + name.length + e.data.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);                                   // method=0 STORE
    lv.setUint32(18, e.data.length, true); lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    lh.set(name, 30); lh.set(e.data, 30 + name.length);
    locals.push(lh);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);                                  // method=0
    cv.setUint32(20, e.data.length, true); cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);                            // localOff
    cd.set(name, 46);
    cds.push(cd);
    offset += lh.length;
  }
  const cdBytes = concat(...cds);
  const cdOffset = offset;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdBytes.length, true); ev.setUint32(16, cdOffset, true);
  return concat(...locals, cdBytes, eocd);
}

// thumbnail 在前 + 若干 dummy entry 在后：解析器给 local header 留 256 字节余量（end=start+256+compSize），
//   真 ora 靠尾部大 CD 提供余量；小 zip 得用 dummy 撑够，否则合法 entry 也被余量守卫误判越界。
const DUMMY = (i) => ({ name: `layers/dummy${i}.png`, data: new Uint8Array(32).fill(i) });
const zipWith = (thumbData) => buildStoreZip([{ name: "Thumbnails/thumbnail.png", data: thumbData }, DUMMY(1), DUMMY(2), DUMMY(3), DUMMY(4)]);

describe("zip-peek › zipEntryPngFromTail（尾内 CD fallback，真 STORE zip）", () => {
  it("按名抓到目标 entry 的 PNG", async () => {
    const zip = zipWith(PNG);
    const out = await zipEntryPngFromTail(zip.buffer, zip.length, "Thumbnails/thumbnail.png");
    assert(!!out && bytesEq(out, PNG), "CD 解析按名抓到 thumbnail PNG");
  });
  it("entry 名不存在 → null", async () => {
    const zip = zipWith(PNG);
    eq(await zipEntryPngFromTail(zip.buffer, zip.length, "no/such.png"), null);
  });
  it("目标 entry 是非 PNG → null（magic 校验）", async () => {
    const zip = zipWith(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    eq(await zipEntryPngFromTail(zip.buffer, zip.length, "Thumbnails/thumbnail.png"), null);
  });
  it("尾片越界：把 buf 截半 → CD 不在尾片 → null（放弃任意偏移二次拉）", async () => {
    const zip = zipWith(PNG);
    const half = zip.slice(Math.floor(zip.length / 2));
    eq(await zipEntryPngFromTail(half.buffer, zip.length, "Thumbnails/thumbnail.png"), null, "CD 不在尾片 → 退占位");
  });
});
