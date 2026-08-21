// Timelapse × ora 集成验收：两个新 entry 的进出 + entry 顺序契约（thumbnail 必须最后）+
// TimelapseDocState 经 ora 的整链 round-trip。spec=ai-docs/20260819-timelapse-spec.md §5。
import { describe, it, assert, eq } from "./runner.mjs";
import { ensureZipLoaded } from "./zip-node.mjs";
import { installDomParserShim } from "./xml-shim.mjs";

ensureZipLoaded();
installDomParserShim();

const { encodeDocToOra, decodeOraToPainting } = await import("../src/backend/ora.ts");
const { TimelapseDocState } = await import("../src/backend/timelapse/timelapse-state.ts");

const jeq = (a, b, msg) => eq(JSON.stringify(a), JSON.stringify(b), msg);

// 最小 EncodeDoc 鸭形：一张空叶（1×1 透明占位路径，零像素依赖）。
const mkDoc = () => ({
  width: 64, height: 64, activeId: 1, referenceLayerId: null,
  layers: [{
    isGroup: false, id: 1, name: "L", visible: true, opacity: 1, mode: "source-over",
    clippingMask: false, lockAlpha: false, bboxX: 0, bboxY: 0, bboxW: 0, bboxH: 0,
    getImageData: () => { throw new Error("empty leaf must not be sampled"); },
  }],
});

const FAKE_AVCC = new Uint8Array([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x00]);
const nalu = (tag) => new Uint8Array([0, 0, 0, 4, 101, tag, tag, tag]);

async function blobBytes(blob) { return new Uint8Array(await blob.arrayBuffer()); }
// zip local file header 按写入序排布 → 首次出现的 entry 名字节位置 = 写入顺序（CD 在更后面不干扰大小比较）。
function nameOffset(bytes, name) {
  const pat = new TextEncoder().encode(name);
  outer: for (let i = 0; i + pat.length <= bytes.length; i++) {
    for (let j = 0; j < pat.length; j++) if (bytes[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}

describe("timelapse · ora 集成", () => {
  it("mp4+json 进出 round-trip；thumbnail 仍是最后 entry（byte-range 尾窗契约）", async () => {
    const st = new TimelapseDocState();
    st.startRecording({ aspectW: 1, aspectH: 1, longEdge: 512 });
    st.pushMotionSample({ bytes: nalu(1), key: true }, FAKE_AVCC);
    const saved = st.serializeForSave({ bytes: nalu(9), key: true }, 512, 512);

    const blob = await encodeDocToOra(mkDoc(), { wroteWith: "v-test", timelapse: saved });
    const bytes = await blobBytes(blob);

    const offMp4 = nameOffset(bytes, "timelapse.mp4");
    const offJson = nameOffset(bytes, ".weebpaint/timelapse.json");
    const offThumb = nameOffset(bytes, "Thumbnails/thumbnail.png");
    assert(offMp4 > 0 && offJson > 0 && offThumb > 0, "三个 entry 都得在");
    assert(offMp4 < offThumb, "timelapse.mp4 必须排在 thumbnail 之前");
    assert(offJson < offThumb, "timelapse.json 必须排在 thumbnail 之前");

    const dec = await decodeOraToPainting(blob);
    eq(dec._timelapseJson, saved.json);
    jeq(Array.from(dec._timelapseMp4), Array.from(saved.mp4));

    const back = TimelapseDocState.restore(dec._timelapseJson ?? null, dec._timelapseMp4 ?? null);
    eq(back.restoreIssue, null);
    eq(back.on, true);
    eq(back.motion.length, 1);
    jeq(back.settings, { aspectW: 1, aspectH: 1, longEdge: 512 });
  });

  it("空 mp4（开录未落帧）→ 只写 json 不写 mp4 entry；回读合法空录像", async () => {
    const st = new TimelapseDocState();
    st.startRecording({ aspectW: 4, aspectH: 3, longEdge: 256 });
    const saved = st.serializeForSave(null, 256, 192);   // 无 tail 无 avcC → 只 json
    const blob = await encodeDocToOra(mkDoc(), { wroteWith: "v-test", timelapse: saved });
    const bytes = await blobBytes(blob);
    eq(nameOffset(bytes, "timelapse.mp4"), -1);
    assert(nameOffset(bytes, ".weebpaint/timelapse.json") > 0, "json 应在");
    const dec = await decodeOraToPainting(blob);
    const back = TimelapseDocState.restore(dec._timelapseJson ?? null, dec._timelapseMp4 ?? null);
    eq(back.restoreIssue, null);
    jeq(back.settings, { aspectW: 4, aspectH: 3, longEdge: 256 });
    eq(back.motion.length, 0);
  });

  // 无地本地文件模式（spec 20260819 §7；user 2026-08-21「timelapse 跟着 ora 走，无地当然全量」）：
  // 录制态的持久化只经 ora 字节进出，**零 store 身份依赖**——本用例整链只有字节：
  // 开录→存（=Ctrl+S 写回本地文件的 encode 等价物）→回读（=openLocalFile 的 adopt 等价物）→续录→再存→再回读。
  it("无 store 身份（无地轨）：字节 round-trip 后续录再存，录制态/样本全保真", async () => {
    const st = new TimelapseDocState();
    st.startRecording({ aspectW: 1, aspectH: 1, longEdge: 512 });
    st.pushMotionSample({ bytes: nalu(1), key: true }, FAKE_AVCC);
    const saved1 = st.serializeForSave({ bytes: nalu(9), key: true }, 512, 512);
    const blob1 = await encodeDocToOra(mkDoc(), { wroteWith: "v-test", timelapse: saved1 });
    const dec1 = await decodeOraToPainting(blob1);
    const back = TimelapseDocState.restore(dec1._timelapseJson ?? null, dec1._timelapseMp4 ?? null);
    eq(back.restoreIssue, null);
    eq(back.on, true, "开关 sticky：重开本地文件仍在录");
    back.pushMotionSample({ bytes: nalu(2), key: false });   // 续录两帧
    back.pushMotionSample({ bytes: nalu(3), key: false });
    const saved2 = back.serializeForSave({ bytes: nalu(9), key: true }, 512, 512);
    const blob2 = await encodeDocToOra(mkDoc(), { wroteWith: "v-test", timelapse: saved2 });
    const dec2 = await decodeOraToPainting(blob2);
    const back2 = TimelapseDocState.restore(dec2._timelapseJson ?? null, dec2._timelapseMp4 ?? null);
    eq(back2.restoreIssue, null);
    eq(back2.motion.length, 3, "1 旧 + 2 续录（尾帧照常截掉）");
    jeq(back2.settings, { aspectW: 1, aspectH: 1, longEdge: 512 });
  });

  it("无录像文档：一个 timelapse entry 都不写（存量画作字节形状零变化）", async () => {
    const blob = await encodeDocToOra(mkDoc(), { wroteWith: "v-test", timelapse: null });
    const bytes = await blobBytes(blob);
    eq(nameOffset(bytes, "timelapse"), -1);
    const dec = await decodeOraToPainting(blob);
    eq(dec._timelapseJson, undefined);
    eq(TimelapseDocState.restore(dec._timelapseJson ?? null, dec._timelapseMp4 ?? null).restoreIssue, null);
  });
});
