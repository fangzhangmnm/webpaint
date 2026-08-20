// 0.10.0 改名（WebPaint→WeebPaint）双读验收：旧名 .ora（webpaint:* 属性 + webpaint// .webpaint/ sidecar 路径）
// 必须完整保读；新写端只写 weebpaint 新名。user 拍板「新写旧读」（2026-08-20）——存量云端画作
// 打开保存即自动升级，clipping/lockAlpha/reference 图/desk/timelapse sidecar 一个不丢。
import { describe, it, assert, eq } from "./runner.mjs";
import { ensureZipLoaded } from "./zip-node.mjs";
import { installDomParserShim } from "./xml-shim.mjs";

ensureZipLoaded();
installDomParserShim();

const { encodeDocToOra, decodeOraToPainting } = await import("../src/backend/ora.ts");
const { zipPack, zipUnpack } = await import("../src/backend/zip.ts");

const mkDoc = () => ({
  width: 64, height: 64, activeId: 1, referenceLayerId: 1,
  layers: [{
    isGroup: false, id: 1, name: "L", visible: true, opacity: 1, mode: "source-over",
    clippingMask: true, lockAlpha: true, bboxX: 0, bboxY: 0, bboxW: 0, bboxH: 0,
    getImageData: () => { throw new Error("empty leaf must not be sampled"); },
  }],
});

const enc = new TextEncoder(), dec = new TextDecoder();

// 新名 .ora → 旧名 .ora（模拟 ≤v0.9.x 写出的文件）：entry 路径 + stack.xml 前缀/xmlns 全退回旧名，
// 并剥掉 weebpaint:format（旧文件没有 format 戳）。
async function downgradeToOldNames(blob) {
  const files = await zipUnpack(blob);
  const entries = [];
  for (const [path, data] of Object.entries(files)) {
    let p = path.replace(/^(\.?)weebpaint\//, "$1webpaint/");
    let d = data;
    if (path === "stack.xml") {
      let xml = dec.decode(data)
        .replace(/ weebpaint:format="[^"]*"/, "")
        .replaceAll("weebpaint:", "webpaint:")
        .replaceAll("xmlns:webpaint=\"https://github.com/fangzhangmnm/weebpaint/ns\"",
                    "xmlns:webpaint=\"https://github.com/fangzhangmnm/webpaint/ns\"");
      d = enc.encode(xml);
    }
    entries.push({ path: p, data: d });
  }
  return await zipPack(entries);
}

describe("ora · 改名双读（新写旧读）", () => {
  it("旧名 .ora 整链保读：属性 + reference + desk + timelapse sidecar", async () => {
    const desk = { toolDials: { pen: 1 }, marker: "dual-read" };
    const refBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);   // 伪 PNG 字节（decode 只包 Blob 不解码）
    const blob = await encodeDocToOra(mkDoc(), {
      wroteWith: "v0.9.35-2026-08-20",
      desk,
      referenceImage: new Blob([refBytes], { type: "image/png" }),
      timelapse: { json: JSON.stringify({ enabled: true }), mp4: new Uint8Array(0) },
    });
    const oldBlob = await downgradeToOldNames(blob);
    // 自检：fixture 真的是全旧名
    const oldFiles = await zipUnpack(oldBlob);
    assert(oldFiles["webpaint/reference.png"] && oldFiles[".webpaint/editor-state.json"]
      && oldFiles[".webpaint/timelapse.json"], "fixture 路径已退回旧名");
    assert(dec.decode(oldFiles["stack.xml"]).includes("webpaint:id")
      && !dec.decode(oldFiles["stack.xml"]).includes("weebpaint:"), "fixture 属性已退回旧前缀");

    const out = await decodeOraToPainting(oldBlob);
    eq(out._wroteWith, "v0.9.35-2026-08-20", "旧 wrote-with 保读");
    eq(out._formatVersion, 0, "旧文件 format=0");
    const L = out.data.nodes[0];
    eq(L.id, 1, "旧 webpaint:id 保读");
    eq(L.clippingMask, true, "clipping 保读");
    eq(L.lockAlpha, true, "lockAlpha 保读");
    eq(out.data.referenceLayerId, 1, "reference 层标记保读");
    eq(out.data.activeId, 1, "active 保读");
    assert(out._referenceBlob instanceof Blob, "旧 webpaint/reference.png 保读");
    eq(new Uint8Array(await out._referenceBlob.arrayBuffer())[0], 137, "reference 字节原样");
    eq(JSON.parse(JSON.stringify(out._editorState)).marker, "dual-read", "旧 .webpaint/editor-state.json 保读");
    eq(JSON.parse(out._timelapseJson).enabled, true, "旧 .webpaint/timelapse.json 保读");
  });

  it("新写端产物零旧名 + format 戳在场（拼写一致性红线）", async () => {
    const blob = await encodeDocToOra(mkDoc(), { wroteWith: "v0.10.0-test", desk: { a: 1 } });
    const files = await zipUnpack(blob);
    for (const path of Object.keys(files)) {
      assert(!/(^|\.)webpaint\//.test(path), `entry 路径无旧名：${path}`);
    }
    const xml = dec.decode(files["stack.xml"]);
    assert(!xml.includes("webpaint:"), "stack.xml 无旧前缀");
    assert(/weebpaint:format="\d+"/.test(xml), "format 戳在场");
    const out = await decodeOraToPainting(blob);
    assert(out._formatVersion >= 1, "新文件 format ≥ 1");
  });
});
